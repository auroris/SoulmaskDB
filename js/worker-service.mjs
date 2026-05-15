/**
 * WorkerService — owns the decode worker pool and exposes a high-level
 * "decode this batch of bytes" API for app-level consumers.
 *
 * Why it's separate from SearchService:
 *   The workers extract a small per-row manifest from each actor_data
 *   blob. Today the only consumer that reads from the manifest is the
 *   search index (the `text` field). Tomorrow there's a planned
 *   cross-row reference extractor (see the STUB `references: []` field
 *   on the manifest, and the architecture notes in memory). Decoupling
 *   worker ownership from search ownership lets the second consumer
 *   subscribe to the same event stream without going through search.
 *
 * Lazy pool: the DecodePool is constructed on first `decode()` call.
 * Spinning up 15 module-Workers costs ~hundreds of ms (lz4-wasm init
 * per worker), so we defer it until there's actual work.
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
 * caller passed in `decode(items, { tag })` — it's opaque to the worker
 * service. The orchestrator uses its own load counter as the tag so the
 * forwarding subscription can filter out batches from abandoned loads
 * without reaching into WorkerService internals.
 */

import { DecodePool } from '../lib/workers/pool.mjs';

export class WorkerService {
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
      catch (e) { console.error('WorkerService listener threw:', e); }
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
