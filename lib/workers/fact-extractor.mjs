/**
 * FactExtractor — fast parallel decoder for actor_data blobs.
 *
 * Drives a pool of Workers (lib/workers/pool.mjs) that decode every row's
 * actor_data through the codec pipeline and reduce the decoded tree to a
 * small per-row "manifest" of facts (see lib/workers/decode-worker.mjs):
 *   - `text`            flat lowercased haystack of every string the tree
 *                       yielded (paths + values). The SearchService uses
 *                       this for substring matching across the table.
 *   - `kind`/`decodeOk` codec name + parse outcome.
 *   - `references`      STUB — cross-row reference patterns (planned).
 *   - `topLevelPropertyNames` first-level property names (Unreal blobs).
 *
 * Why a separate service from SearchService:
 *   Search is one consumer of the manifest stream — the next consumer
 *   (a cross-row reference extractor for finding which inventory holds a
 *   given item, which container shares coords with a building, etc.)
 *   will reuse the same event stream without going through search.
 *   Decoupling makes that addition a subscription, not a refactor.
 *
 * Lazy pool: the DecodePool is constructed on first `decode()` call.
 * Spinning up 15 module-Workers costs ~hundreds of ms (each worker boots
 * its own lz4 wasm), so we defer it until there's actual work.
 *
 * Public API:
 *   decode(items)              → Promise<{serial, manifest}[]>
 *                                Also emits per-batch progress events.
 *   addListener(fn)            → unsubscribe()
 *   isPoolStarted()            → bool
 *   terminate()                → tear down workers (test/shutdown path)
 *
 * Events (addListener):
 *   'batch'  { callId, tag, items, indexed, total }
 *       items is the {serial,manifest}[] for THIS batch; indexed/total
 *       are running counters for the current decode() call.
 *   'done'   { callId, tag, indexed, total }
 *   'error'  { callId, tag, error }
 *
 * `callId` is auto-incremented per decode() call. `tag` is whatever the
 * caller passed in `decode(items, { tag })` — it's opaque to us. The
 * orchestrator uses its own load counter as the tag so the forwarding
 * subscription can filter out batches from abandoned loads without
 * reaching into FactExtractor internals.
 */

import { DecodePool } from './pool.mjs';

export class FactExtractor {
  constructor({ workerSize, batchSize } = {}) {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    this._workerSize = workerSize ?? Math.max(1, cores - 1);
    this._batchSize  = batchSize  ?? 200;
    this._pool       = null;
    this._listeners  = new Set();
    this._callId     = 0;
  }

  addListener(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(event, data) {
    for (const fn of this._listeners) {
      try { fn(event, data); }
      catch (e) { console.error('FactExtractor listener threw:', e); }
    }
  }

  _getPool() {
    if (!this._pool) {
      this._pool = new DecodePool({ size: this._workerSize, batchSize: this._batchSize });
    }
    return this._pool;
  }

  isPoolStarted() { return !!this._pool; }

  /**
   * Decode a list of {serial, buffer} items via the worker pool.
   *
   * Each item's `buffer` is TRANSFERRED to the worker (zero-copy). The
   * main-thread copies become detached — callers must give us their own
   * ArrayBuffers, not shared slices.
   *
   * `tag` (optional) is passed through unchanged on every event for
   * this call. Subscribers can filter by it; we treat it as opaque.
   *
   * Returns the full result array (in input order) when done. Listeners
   * see per-batch `batch` events as the work streams in. The orchestrator
   * uses those events to feed the search index incrementally without
   * waiting for the whole decode to finish.
   */
  async decode(items, { tag = null } = {}) {
    const callId = ++this._callId;
    if (!items || items.length === 0) {
      this._emit('done', { callId, tag, indexed: 0, total: 0 });
      return [];
    }
    const total = items.length;
    let indexed = 0;
    const pool = this._getPool();
    let results;
    try {
      results = await pool.decodeAll(items, {
        onBatchComplete: (batchItems) => {
          indexed += batchItems.length;
          this._emit('batch', { callId, tag, items: batchItems, indexed, total });
        },
      });
    } catch (error) {
      this._emit('error', { callId, tag, error });
      throw error;
    }
    this._emit('done', { callId, tag, indexed, total });
    return results;
  }

  async terminate() {
    if (this._pool) {
      const p = this._pool;
      this._pool = null;
      await p.terminate();
    }
  }
}
