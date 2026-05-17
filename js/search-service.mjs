/**
 * SearchService — per-row blob-text index for the filter, decoupled from
 * worker ownership.
 *
 * Backed by a FlexSearch `Index`. The workers (owned by FactExtractor)
 * decode every actor_data blob and produce a per-row manifest containing
 * a flat lowercased `text` field (every string the property tree
 * yielded, paths + values, joined). The orchestrator forwards those
 * manifests here via `absorbBatch()`. We feed `(serial, text)` into the
 * FlexSearch index keyed by actor_serial.
 *
 * FlexSearch tokenizes on Unicode letter/number boundaries by default,
 * so path strings like `BindBGCompActor.PropertyName[0].key` split into
 * four tokens. With `tokenize: 'forward'` we get prefix matches per
 * token — "prop" matches "propertyname", "0" matches "0", etc. This is
 * a slight UX shift from the prior raw-substring scan: matches that
 * crossed a token boundary (e.g. searching `GCompA` inside the camelCase
 * compound `BindBGCompActor`) no longer hit. Compound-word substring
 * matching would require `tokenize: 'full'`, which roughly squares
 * index size — unaffordable on the ~113MB haystack the 12k-row world.db
 * produces.
 *
 * Single-row mutations (edit + delete callsites in app.mjs) bypass the
 * workers entirely: `refreshRow(serial, bytes)` decodes one blob
 * synchronously on the main thread, and `dropRow(serial)` removes the
 * entry after a DELETE. Round-tripping one row through the worker pool
 * would cost more in postMessage / transfer than the decode itself.
 *
 * Generation/epoch: `clear()` constructs a fresh Index AND bumps an
 * internal epoch counter. Batches absorbed afterward only land in the
 * index if their batch's epoch still matches — protecting against
 * "load file A, then load file B before A's indexing finishes"
 * sequences where stale A batches would otherwise pollute B's index.
 *
 * Query cache: `matches(serial, query)` is called once per visible row
 * per DataTables draw, so a 12k-row table on a single query change runs
 * 12k FlexSearch lookups if we don't cache. Instead we run ONE
 * `index.search()` per unique query, store the result Set, and answer
 * subsequent same-query `matches()` calls with `set.has(serial)`. The
 * cache is invalidated whenever the index mutates (absorbBatch,
 * refreshRow, dropRow, clear).
 *
 * Events (addListener):
 *   'batch'  { indexed }  — fired after each absorbBatch() call
 *   'done'   { indexed }  — fired by the orchestrator after the full
 *                           decode pass via `markDone()`
 *   'reset'  null         — fired by clear()
 */

import { Index } from 'flexsearch';

// FlexSearch's default search limit is 100. We need every match because
// the result Set is then intersected with the full row list. There is
// no "unlimited" sentinel — pass a number larger than any plausible row
// count for this app.
const SEARCH_LIMIT = 1_000_000;

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
    this._index          = this._createIndex();
    // FlexSearch's Index exposes add/remove/search but no `contain`. We
    // mirror the set of indexed serials ourselves so hasIndex() answers
    // O(1), refreshRow can decide between add and remove+add, and dropRow
    // can short-circuit when the serial was never indexed.
    this._indexedSerials = new Set();
    this._listeners      = new Set();
    this._epoch          = 0;
    this._cachedQuery    = null;
    this._cachedResults  = null;
  }

  _createIndex() {
    return new Index({ tokenize: 'forward' });
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
   * shape FactExtractor emits in its 'batch' event. If `epoch` is
   * provided and doesn't match the current internal epoch, the batch
   * is dropped silently (stale results from a prior file's decode).
   */
  absorbBatch(items, { epoch } = {}) {
    if (!items || items.length === 0) return;
    if (epoch != null && epoch !== this._epoch) return;
    for (const it of items) {
      this._addOrReplace(it.serial, it.manifest?.text || '');
    }
    this._invalidateCache();
    this._emit('batch', { indexed: this._indexedSerials.size });
  }

  /**
   * Signal that the current decode pass is complete. Called by the
   * orchestrator after FactExtractor emits 'done'. Stale calls (epoch
   * mismatch) are ignored.
   */
  markDone({ epoch } = {}) {
    if (epoch != null && epoch !== this._epoch) return;
    this._emit('done', { indexed: this._indexedSerials.size });
  }

  /**
   * Re-index a single row after a SQL/blob edit. Synchronous main-thread
   * decode. `bytes` may be null / empty (clears the entry's text) or a
   * Uint8Array of actor_data.
   */
  refreshRow(serial, bytes) {
    let text = '';
    if (bytes && bytes.length > 0) {
      try {
        const decoded = this._codecs.decode(bytes);
        text = this._buildHaystack(this._collectStrings(decoded));
      } catch {
        text = '';
      }
    }
    this._addOrReplace(serial, text);
    this._invalidateCache();
  }

  /** Drop one row's entry. Used after DELETE. */
  dropRow(serial) {
    if (!this._indexedSerials.has(serial)) return;
    this._index.remove(serial);
    this._indexedSerials.delete(serial);
    this._invalidateCache();
  }

  /**
   * Reset all indexed state. Bumps the epoch so any in-flight batches
   * from a prior decode pass get dropped on arrival. FlexSearch's Index
   * has no bulk-clear method, so we replace it with a fresh instance.
   */
  clear() {
    this._epoch++;
    this._index = this._createIndex();
    this._indexedSerials.clear();
    this._invalidateCache();
    this._emit('reset', null);
  }

  /**
   * True iff this row matches the query. Empty / nullish query returns
   * false (the caller — RowTable's DataTables filter — already
   * short-circuits the empty-query path before reaching here, so this
   * is a safety belt). Returns false for rows that haven't been indexed
   * yet — callers should ALSO check any SQL-column fields so unindexed
   * rows still surface when they match there.
   *
   * The result set for the current query is cached so the per-row calls
   * a DataTables draw makes amortize to O(1) lookups after the first.
   */
  matches(serial, query) {
    if (!query) return false;
    if (this._cachedQuery !== query) {
      const hits = this._index.search(query, { limit: SEARCH_LIMIT });
      this._cachedResults = new Set(hits);
      this._cachedQuery   = query;
    }
    return this._cachedResults.has(serial);
  }

  /** True iff this row has been indexed (even with an empty haystack). */
  hasIndex(serial) {
    return this._indexedSerials.has(serial);
  }

  stats() {
    return { indexed: this._indexedSerials.size };
  }

  /**
   * Insert or replace a serial's entry. FlexSearch's `add()` won't
   * replace an existing id (it would double-index), so for any serial
   * we've already seen we remove first.
   *
   * Empty text still counts as "indexed" so hasIndex(serial) returns
   * true for rows whose blob produced no strings — that matches the
   * prior Map-based behavior, which set `'' ` on empty rows.
   */
  _addOrReplace(serial, text) {
    if (this._indexedSerials.has(serial)) {
      this._index.remove(serial);
    }
    if (text) this._index.add(serial, text);
    this._indexedSerials.add(serial);
  }

  _invalidateCache() {
    this._cachedQuery   = null;
    this._cachedResults = null;
  }

  _buildHaystack(strings) {
    if (!strings || strings.length === 0) return '';
    const parts = [];
    for (const s of strings) {
      if (s.path)  parts.push(s.path);
      if (s.value) parts.push(s.value);
    }
    return parts.join('\n');
  }
}
