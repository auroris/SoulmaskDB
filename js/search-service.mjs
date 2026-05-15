/**
 * SearchService — per-row blob-text index for the filter, decoupled from
 * worker ownership.
 *
 * The workers (owned by WorkerService) decode every actor_data blob and
 * produce a per-row manifest containing a flat lowercased `text` field
 * (every string the property tree yielded, paths + values, joined). The
 * orchestrator forwards those manifests here via `absorbBatch()`. We
 * keep them in a Map keyed by actor_serial.
 *
 * Single-row mutations (edit + delete callsites in app.js) bypass the
 * workers entirely: `refreshRow(serial, bytes)` decodes one blob
 * synchronously on the main thread, and `dropRow(serial)` removes the
 * entry after a DELETE. Round-tripping one row through the worker pool
 * would cost more in postMessage / transfer than the decode itself.
 *
 * Generation/epoch: `clear()` bumps an internal epoch counter. Batches
 * absorbed afterward only land in the index if their batch's epoch
 * still matches — protecting against "load file A, then load file B
 * before A's indexing finishes" sequences where stale A batches would
 * otherwise pollute B's index.
 *
 * Events (addListener):
 *   'batch'  { indexed }  — fired after each absorbBatch() call
 *   'done'   { indexed }  — fired by the orchestrator after the full
 *                           decode pass via `markDone()`
 *   'reset'  null         — fired by clear()
 */

export class SearchService {
  /**
   * @param {object} options
   * @param {object} options.codecs - codec registry (provides decode(u8))
   * @param {Function} options.collectStrings - the {path,value} walker
   *   from lib/unreal/strings.mjs
   */
  constructor({ codecs, collectStrings } = {}) {
    if (!codecs)         throw new Error('SearchService: codecs is required');
    if (!collectStrings) throw new Error('SearchService: collectStrings is required');
    this._codecs         = codecs;
    this._collectStrings = collectStrings;
    this._index          = new Map();  // serial → lowercased haystack
    this._listeners      = new Set();
    this._epoch          = 0;
  }

  addListener(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(event, data) {
    for (const fn of this._listeners) {
      try { fn(event, data); }
      catch (e) { console.error('SearchService listener threw:', e); }
    }
  }

  /**
   * Snapshot the current epoch. The orchestrator passes this back to
   * absorbBatch() so we can ignore batches that belong to a superseded
   * decode pass (e.g. user loaded a new file before the previous file
   * finished indexing).
   */
  currentEpoch() { return this._epoch; }

  /**
   * Consume a worker batch — `items` is the `{serial, manifest}[]`
   * shape WorkerService emits in its 'batch' event. If `epoch` is
   * provided and doesn't match the current internal epoch, the batch
   * is dropped silently (stale results from a prior file's decode).
   */
  absorbBatch(items, { epoch } = {}) {
    if (!items || items.length === 0) return;
    if (epoch != null && epoch !== this._epoch) return;
    for (const it of items) {
      this._index.set(it.serial, it.manifest?.text || '');
    }
    this._emit('batch', { indexed: this._index.size });
  }

  /**
   * Signal that the current decode pass is complete. Called by the
   * orchestrator after WorkerService emits 'done'. Stale calls (epoch
   * mismatch) are ignored.
   */
  markDone({ epoch } = {}) {
    if (epoch != null && epoch !== this._epoch) return;
    this._emit('done', { indexed: this._index.size });
  }

  /**
   * Re-index a single row after a SQL/blob edit. Synchronous main-thread
   * decode. `bytes` may be null / empty (clears the entry) or a Uint8Array
   * of actor_data.
   */
  refreshRow(serial, bytes) {
    if (!bytes || bytes.length === 0) {
      this._index.set(serial, '');
      return;
    }
    let text = '';
    try {
      const decoded = this._codecs.decode(bytes);
      text = this._buildHaystack(this._collectStrings(decoded));
    } catch {
      text = '';
    }
    this._index.set(serial, text);
  }

  /** Drop one row's entry. Used after DELETE. */
  dropRow(serial) {
    this._index.delete(serial);
  }

  /**
   * Reset all indexed state. Bumps the epoch so any in-flight batches
   * from a prior decode pass get dropped on arrival.
   */
  clear() {
    this._epoch++;
    this._index.clear();
    this._emit('reset', null);
  }

  /**
   * True iff this row's haystack contains the (already-lowercased)
   * query. Returns false for rows that haven't been indexed yet —
   * callers should ALSO check any SQL-column fields so unindexed rows
   * still surface when they match there.
   */
  matches(serial, queryLower) {
    const hay = this._index.get(serial);
    if (hay == null || hay === '') return false;
    return hay.includes(queryLower);
  }

  /** True iff this row has been indexed (even with an empty haystack). */
  hasIndex(serial) {
    return this._index.has(serial);
  }

  stats() {
    return { indexed: this._index.size };
  }

  _buildHaystack(strings) {
    if (!strings || strings.length === 0) return '';
    const parts = [];
    for (const s of strings) {
      if (s.path) parts.push(s.path);
      if (s.value) parts.push(s.value);
    }
    return parts.join('\n').toLowerCase();
  }
}
