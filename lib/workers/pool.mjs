/**
 * DecodePool — fixed-size worker pool that runs the codec pipeline in
 * parallel, returning small per-row manifests (see decode-worker.mjs).
 *
 * Design:
 *   - Inputs (raw bytes) are transferred zero-copy via the postMessage
 *     transfer list. Caller is responsible for handing in INDEPENDENT
 *     ArrayBuffers (one per row); transferring detaches the buffer in the
 *     main thread, so if you intend to keep the bytes around, copy first.
 *   - Outputs are small POJO manifests (no transferables; structured-clone
 *     cost is dominated by object count, which the manifest keeps low).
 *   - Greedy pull queue: each worker pulls the next batch from a shared
 *     index until all batches are dispatched. This load-balances better
 *     than splitting items into N equal slices up front when batch sizes
 *     are uneven (e.g. one batch happens to contain a few large blobs).
 *
 * Usage (Node or browser):
 *
 *   const pool = new DecodePool({ size: 4, batchSize: 200 });
 *   const items = rows.map(r => ({
 *     serial: r.actor_serial,
 *     buffer: copyToFreshBuffer(r.actor_data),  // see note above
 *   }));
 *   const results = await pool.decodeAll(items);
 *   // results[i] === { serial, manifest } in the same order as items[i].
 *   await pool.terminate();
 */

// Worker resolution is environment-aware. In a browser `globalThis.Worker`
// is the native class — we use it directly so this file doesn't ship a
// bare-specifier import (the `'web-worker'` package isn't resolvable by
// native-ESM browser loaders without an import map). In Node we fall
// through to the `web-worker` polyfill which wraps `worker_threads` with
// the same `self.postMessage`/`addEventListener('message', …)` surface the
// decode-worker uses.
const Worker = (typeof globalThis.Worker === 'function')
  ? globalThis.Worker
  : (await import('web-worker')).default;

export class DecodePool {
  constructor({ size = 4, batchSize = 200 } = {}) {
    if (size < 1) throw new Error('DecodePool: size must be >= 1');
    if (batchSize < 1) throw new Error('DecodePool: batchSize must be >= 1');
    this.size = size;
    this.batchSize = batchSize;
    const workerUrl = new URL('./decode-worker.mjs', import.meta.url);
    this.workers = [];
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerUrl, { type: 'module', name: `smdb-decode-${i}` });
      // Per-worker readiness promise. We attach the listener synchronously
      // here so we can't miss the worker-ready handshake. decodeAll() awaits
      // this before sending any batch to that worker — see the comment in
      // decode-worker.mjs for why we don't trust browser message queueing
      // before module-eval finishes.
      worker._readyPromise = makeReadyPromise(worker);
      this.workers.push(worker);
    }
  }

  /**
   * Decode every item. Returns an array of `{ serial, manifest }` in the
   * same order as `items`. Each item's `buffer` IS TRANSFERRED — it is no
   * longer usable in the main thread after this call.
   *
   * `onBatchComplete(items)` fires after each batch returns, before the
   * overall promise resolves. Use it for incremental progress reporting
   * (e.g. a search-index that wants to register rows as they're decoded
   * instead of waiting for the whole call to finish). `items` is the
   * same `{serial, manifest}` shape used in the final return value.
   */
  async decodeAll(items, { onBatchComplete = null } = {}) {
    if (items.length === 0) return [];

    const batches = sliceBatches(items, this.batchSize);
    const collected = new Map();

    // Greedy pull: each worker pulls the next batch until the queue is empty.
    let nextBatchIdx = 0;
    await Promise.all(this.workers.map(async (worker) => {
      // Wait for the worker-ready handshake before the first dispatch.
      // Resolves immediately on subsequent decodeAll() calls (the promise
      // is already settled). Only the very first batch ever sent to this
      // worker actually waits on a wall clock.
      await worker._readyPromise;
      while (true) {
        const i = nextBatchIdx++;
        if (i >= batches.length) return;
        const result = await sendBatch(worker, batches[i]);
        for (const item of result.items) collected.set(item.serial, item);
        if (onBatchComplete) {
          try { onBatchComplete(result.items); }
          catch (e) { console.error('DecodePool onBatchComplete threw:', e); }
        }
      }
    }));

    // Re-order to match input.
    return items.map(it => collected.get(it.serial));
  }

  async terminate() {
    for (const w of this.workers) {
      try { w.terminate(); } catch { /* ignore */ }
    }
    this.workers = [];
  }
}

function sliceBatches(items, batchSize) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

/**
 * Resolve once the worker has sent its `worker-ready` handshake message
 * (emitted from decode-worker.mjs after the top-level module-eval finishes
 * and the message listener is wired). This avoids a startup race we
 * observed in at least one browser, where `worker.postMessage(...)` calls
 * issued before module-eval completed were silently dropped instead of
 * queued.
 *
 * The listener is attached synchronously alongside Worker construction so
 * the ready event can't fire before we're watching. Decode-batch reply
 * traffic comes in later and goes to sendBatch's listener — this handler
 * filters by msg.type so the two don't interfere.
 */
function makeReadyPromise(worker) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      if (ev.data && ev.data.type === 'worker-ready') {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        resolve();
      }
    };
    const onErr = (err) => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      reject(err);
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
  });
}

/**
 * One round-trip: post a batch with transferables, await the matching
 * response. Each worker is request/response (one batch in flight at a
 * time), so we don't need an id — the next message IS the reply.
 */
function sendBatch(worker, batch) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      resolve(ev.data);
    };
    const onErr = (err) => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      reject(err);
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);

    // Dedupe transfer list: postMessage throws if the same buffer is
    // listed twice. (Shouldn't happen in normal use, but defend against it.)
    const seen = new Set();
    const transferList = [];
    const items = batch.map((it) => {
      if (it.buffer instanceof ArrayBuffer && !seen.has(it.buffer)) {
        seen.add(it.buffer);
        transferList.push(it.buffer);
      }
      return {
        serial: it.serial,
        buffer: it.buffer,
        byteOffset: it.byteOffset ?? 0,
        byteLength: it.byteLength ?? null,
      };
    });

    worker.postMessage({ type: 'decode-batch', items }, transferList);
  });
}
