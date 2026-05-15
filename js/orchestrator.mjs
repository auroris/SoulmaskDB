/**
 * Orchestrator — composes SqliteService, WorkerService, SearchService
 * and owns the file-load lifecycle.
 *
 * Today's flow:
 *   1. User picks a file → app.js hands the bytes to `orchestrator.loadFile`.
 *   2. Orchestrator opens the DB via SqliteService (any prior handle goes
 *      stale and throws on use).
 *   3. Orchestrator validates `actor_table` exists. Bails with a
 *      'load-error' event otherwise.
 *   4. Orchestrator queries all rows, runs classify, builds the per-row
 *      summary list, and emits 'rows-ready' so the UI can render
 *      immediately (without blob-text matches).
 *   5. Orchestrator clears the search index, then kicks
 *      WorkerService.decode(blobItems) — fire-and-let-it-stream.
 *   6. A persistent subscription (set up in the constructor) forwards
 *      worker `batch` events to SearchService.absorbBatch as they land,
 *      filtered by per-load callId so a second loadFile-while-A-still-
 *      decoding correctly abandons A's leftover batches.
 *   7. When the worker's decode promise resolves, orchestrator emits
 *      'file-loaded' and the UI flips out of its loading state.
 *
 * Events (addListener):
 *   'rows-ready'  { rows, handle, serverId, label }
 *       Fired after SQL+classify, BEFORE blob decoding starts. The UI
 *       should render the table on this event; blob-text matches will
 *       fill in as indexing progresses (SearchService emits its own
 *       'batch' event for that re-render).
 *   'file-loaded' { label, rowCount }
 *       Fired after the decode pass completes (or was abandoned for a
 *       newer load).
 *   'load-error'  { error, label }
 *       Fired if anything bailed during the load.
 *
 * Stale-call safety:
 *   Two orthogonal guards. (1) Each loadFile() captures a `_loadId`
 *   counter and bails after any await if a newer call has started.
 *   (2) The worker-to-search subscription tracks a per-load callId so
 *   leftover batches from an abandoned load never touch the new
 *   SearchService state. Plus SearchService's own epoch on absorbBatch
 *   as a third belt-and-braces layer.
 */

export class Orchestrator {
  constructor({ sqliteService, workerService, searchService, classify }) {
    if (!sqliteService)  throw new Error('Orchestrator: sqliteService is required');
    if (!workerService)  throw new Error('Orchestrator: workerService is required');
    if (!searchService)  throw new Error('Orchestrator: searchService is required');
    if (!classify)       throw new Error('Orchestrator: classify is required');
    this._sqlite    = sqliteService;
    this._worker    = workerService;
    this._search    = searchService;
    this._classify  = classify;

    this._listeners = new Set();
    this._loadId    = 0;
    this._currentFileLabel = null;

    // Per-load state used by the worker→search forwarding listener
    // installed below. `_activeTag` matches the tag attached to events
    // from the current load's worker.decode() call; absorbBatch is
    // short-circuited on tag mismatch so leftover batches from an
    // abandoned load can't pollute the new search index.
    this._activeTag    = null;
    this._activeEpoch  = 0;
    this._installWorkerForwarding();
  }

  addListener(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(event, data) {
    for (const fn of this._listeners) {
      try { fn(event, data); }
      catch (e) { console.error('Orchestrator listener threw:', e); }
    }
  }

  /** Direct access to the current DatabaseHandle, or null. */
  db() { return this._sqlite.current(); }

  /**
   * Wire WorkerService events into SearchService. Installed once at
   * construction. Each loadFile() updates `_activeTag` so this listener
   * forwards only batches from the active decode pass.
   */
  _installWorkerForwarding() {
    this._worker.addListener((event, data) => {
      if (!data) return;
      if (this._activeTag == null || data.tag !== this._activeTag) return;
      if (event === 'batch') {
        this._search.absorbBatch(data.items, { epoch: this._activeEpoch });
      } else if (event === 'done') {
        this._search.markDone({ epoch: this._activeEpoch });
      } else if (event === 'error') {
        // Search 'done' wouldn't fire in this case — surface the error
        // so the UI can recover. The decode promise's catch in loadFile
        // also runs, but emitting here keeps the event-driven path
        // self-contained.
        this._emit('load-error', { error: data.error, label: this._currentFileLabel });
      }
    });
  }

  /**
   * Open a database file. Bytes is a Uint8Array of the .db file's
   * contents (same shape file.arrayBuffer() returns). `label` is the
   * display string for status messages.
   *
   * Resolves when the SQL query + classify + decode pass have all
   * completed (or the load was abandoned by a newer call). Errors are
   * also emitted as 'load-error' events.
   */
  async loadFile(bytes, label) {
    const myLoadId = ++this._loadId;
    this._currentFileLabel = label;
    try {
      const handle = await this._sqlite.open(bytes);
      if (myLoadId !== this._loadId) return;   // superseded

      const hasTable = handle.selectValue(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='actor_table'");
      if (!hasTable) {
        const error = new Error('not a Soulmask DB (missing actor_table)');
        this._emit('load-error', { error, label });
        return;
      }

      // SQL + classify on the main thread. This is what the UI renders
      // first; blob-text indexing streams in after.
      const rows = [];
      handle.exec({
        sql: `SELECT actor_serial, server_id, data_version, actor_name,
                     actor_script, actor_owner, actor_transf, actor_time,
                     actor_data, length(actor_data) AS blob_size
              FROM actor_table ORDER BY actor_serial`,
        rowMode: 'object',
        resultRows: rows,
      });
      if (myLoadId !== this._loadId) return;

      const indexItems = [];
      for (const r of rows) {
        const c = this._classify.classify(r);
        r._kind = c.kind; r._label = c.label; r._summary = c.summary;
        if (r.actor_data && r.actor_data.length > 0) {
          const ab = new ArrayBuffer(r.actor_data.byteLength);
          new Uint8Array(ab).set(r.actor_data);
          indexItems.push({ serial: r.actor_serial, buffer: ab });
        }
        r.actor_data = null;  // ownership handed off (or dropped for empty rows)
      }

      const serverId = this._detectServerId(handle);

      // Reset the search index for the new file BEFORE we emit rows-ready,
      // so consumers that read SearchService state on that event see a
      // clean slate.
      this._search.clear();
      const epoch = this._search.currentEpoch();

      // Announce the metadata. UI renders immediately on this event.
      this._emit('rows-ready', { rows, handle, serverId, label });

      // Tag this load's worker.decode call with `myLoadId` and update
      // the forwarding subscription's filter. The subscription was
      // installed once at construction time and matches on `data.tag`,
      // so anything currently in flight from an older load (different
      // tag) is automatically dropped.
      this._activeEpoch = epoch;
      this._activeTag   = myLoadId;

      try {
        await this._worker.decode(indexItems, { tag: myLoadId });
      } catch {
        // 'load-error' already emitted by the worker-forwarding listener.
        return;
      }
      if (myLoadId !== this._loadId) return;

      // Decode complete. Final 'file-loaded' notification.
      this._emit('file-loaded', { label, rowCount: rows.length });
    } catch (error) {
      if (myLoadId === this._loadId) {
        this._emit('load-error', { error, label });
      }
    } finally {
      if (myLoadId === this._loadId) {
        this._activeTag = null;
      }
    }
  }

  /**
   * Re-read a single row from the DB, re-classify it, and refresh its
   * search index entry. Used by the edit/delete callsites — single-row
   * mutations don't go through the worker pool.
   *
   * If `serial` no longer exists in the DB, returns null (caller can
   * treat it as a delete) and the search entry is dropped.
   *
   * Returns the re-loaded row object (with `_kind`, `_label`, `_summary`
   * stamped on it, and `actor_data` dropped after refreshing the
   * search index). Caller is responsible for keeping their own canonical
   * row list in sync — the orchestrator does not own `allRows` in this
   * refactor; that ownership moves with the UI component refactor.
   */
  reindexRow(serial) {
    const handle = this._sqlite.current();
    if (!handle) return null;
    const rows = [];
    handle.exec({
      sql: 'SELECT * FROM actor_table WHERE actor_serial = ?',
      bind: [serial],
      rowMode: 'object',
      resultRows: rows,
    });
    const row = rows[0];
    if (!row) {
      this._search.dropRow(serial);
      return null;
    }
    row.blob_size = row.actor_data ? row.actor_data.length : 0;
    const c = this._classify.classify(row);
    row._kind = c.kind; row._label = c.label; row._summary = c.summary;
    this._search.refreshRow(serial, row.actor_data);
    row.actor_data = null;
    return row;
  }

  /**
   * Re-classify ONLY (no blob re-decode). Slightly cheaper than
   * reindexRow for cases where we know the blob bytes haven't changed,
   * but currently unused — the edit callsites can't always tell whether
   * the blob changed, so they default to the safer reindexRow path.
   */

  _detectServerId(handle) {
    // world.db: server_id comes from GAME_SETTINGS. accounts.db has no
    // such row, so fall back to the first row's server_id.
    const fromSettings = handle.selectValue(
      "SELECT server_id FROM actor_table WHERE actor_name = ?", ['GAME_SETTINGS']);
    if (fromSettings != null) return fromSettings;
    return handle.selectValue(
      "SELECT server_id FROM actor_table ORDER BY actor_serial LIMIT 1");
  }
}
