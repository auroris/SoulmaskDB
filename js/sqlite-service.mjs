/**
 * SqliteService — factory for DatabaseHandle objects sharing one sqlite3
 * WASM module + one open database.
 *
 * Why a service (not a module global):
 *   - Multiple consumers (the data-table component, the stash, the
 *     editor) want CRUD access to the same DB without each importing a
 *     bare `db` global from app.js.
 *   - Loading a new file should invalidate any stale handles loud-and-
 *     early — easier to centralize when the lifecycle lives in one
 *     place. Stale handles throw on use rather than silently writing to
 *     a closed DB.
 *
 * Lifecycle:
 *   const sqlite = new SqliteService();
 *   const db = await sqlite.open(bytes);     // sqlite3 WASM boots lazily here
 *   db.exec(...) / db.selectValue(...) / db.export() / …
 *   const db2 = await sqlite.open(otherBytes);   // closes `db`; `db.exec` now throws
 *
 * Events (addListener):
 *   'opened' (handle)   - fired after a successful open()
 *   'closed' (handle)   - fired when a handle becomes inert (superseded
 *                         or terminated)
 */

const VFS_NAME      = 'soulmask.db';
const PEEK_VFS_NAME = 'soulmask-peek.db';

export class SqliteService {
  /**
   * @param {object} [options]
   * @param {Function} [options.sqlite3InitModule] - the sqlite3 WASM
   *   loader. Defaults to `globalThis.sqlite3InitModule` (which is what
   *   lib/sqlite3/sqlite3.js exposes when the classic script tag loads).
   * @param {string}   [options.vfsName] - virtual-filesystem name to
   *   stash the bytes under. Defaults to 'soulmask.db'.
   * @param {string}   [options.peekVfsName] - separate VFS slot used by
   *   peek() so validating a candidate file never disturbs the active
   *   database. Defaults to 'soulmask-peek.db'.
   */
  constructor({ sqlite3InitModule, vfsName = VFS_NAME, peekVfsName = PEEK_VFS_NAME } = {}) {
    this._init = sqlite3InitModule
      ?? (typeof globalThis !== 'undefined' ? globalThis.sqlite3InitModule : null);
    this._vfsName     = vfsName;
    this._peekVfsName = peekVfsName;
    this._sqlite3 = null;          // memoized WASM instance
    this._initPromise = null;      // de-dupes concurrent boot calls
    this._currentHandle = null;
    this._peekChain = null;        // FIFO queue for concurrent peek() calls
    this._listeners = new Set();
  }

  /** Register a listener `(event, data) => void`. Returns an unsubscribe fn. */
  addListener(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(event, data) {
    for (const fn of this._listeners) {
      try { fn(event, data); }
      catch (e) { console.error('SqliteService listener threw:', e); }
    }
  }

  /**
   * Lazy WASM boot. Repeated callers share the same promise so we only
   * pay the init cost once per page.
   */
  async _ensureBooted() {
    if (this._sqlite3) return this._sqlite3;
    if (this._initPromise) return this._initPromise;
    if (typeof this._init !== 'function') {
      throw new Error('SqliteService: sqlite3InitModule is not available — load lib/sqlite3/sqlite3.js first');
    }
    this._initPromise = this._init({
      print:    (...a) => console.log('[sqlite3]', ...a),
      printErr: (...a) => console.warn('[sqlite3]', ...a),
    }).then(s => { this._sqlite3 = s; return s; });
    return this._initPromise;
  }

  /**
   * Open a new database from raw bytes. Invalidates any prior handle
   * (its methods will throw afterward) and emits 'closed' for it,
   * followed by 'opened' for the new one.
   */
  async open(bytes) {
    const sqlite3 = await this._ensureBooted();

    if (this._currentHandle) {
      const prior = this._currentHandle;
      prior._invalidate();
      this._currentHandle = null;
      this._emit('closed', prior);
    }

    try { sqlite3.util.sqlite3__wasm_vfs_unlink(0, this._vfsName); } catch {}
    sqlite3.capi.sqlite3_js_posix_create_file(this._vfsName, bytes);
    const db = new sqlite3.oo1.DB(this._vfsName, 'w');

    const handle = new DatabaseHandle(db, sqlite3, this);
    this._currentHandle = handle;
    this._emit('opened', handle);
    return handle;
  }

  /**
   * Close the current handle (if any) WITHOUT opening a replacement.
   * Used when the active file is removed from the data service — any
   * lingering DatabaseHandle reference held by other code will throw on
   * use, surfacing the bug rather than silently writing to a different
   * file's bytes the next time something is loaded.
   */
  close() {
    if (!this._currentHandle) return;
    const prior = this._currentHandle;
    prior._invalidate();
    this._currentHandle = null;
    this._emit('closed', prior);
  }

  /**
   * Open `bytes` in a SEPARATE VFS slot, hand the raw oo1 DB to `fn`,
   * then unconditionally close it and unlink the slot. Used to validate
   * a candidate file (does it parse? does it have actor_table? is it a
   * world save or accounts DB?) without evicting whatever the user is
   * currently browsing through open().
   *
   * Only one peek runs at a time (the peek VFS slot is single-occupancy).
   * Concurrent callers chain in FIFO order via `_peekChain`.
   */
  async peek(bytes, fn) {
    const sqlite3 = await this._ensureBooted();
    const prev = this._peekChain;
    let release;
    this._peekChain = new Promise(r => { release = r; });
    if (prev) { try { await prev; } catch {} }

    let db = null;
    try {
      try { sqlite3.util.sqlite3__wasm_vfs_unlink(0, this._peekVfsName); } catch {}
      sqlite3.capi.sqlite3_js_posix_create_file(this._peekVfsName, bytes);
      db = new sqlite3.oo1.DB(this._peekVfsName, 'w');
      return await fn(db);
    } finally {
      if (db) { try { db.close(); } catch {} }
      try { sqlite3.util.sqlite3__wasm_vfs_unlink(0, this._peekVfsName); } catch {}
      release();
    }
  }

  /** Currently-open handle, or null. */
  current() { return this._currentHandle; }

  /** Has the sqlite3 WASM module finished initializing? */
  isBooted() { return !!this._sqlite3; }

  /** Returns the libsqlite version once booted, or null. */
  version() {
    return this._sqlite3 ? this._sqlite3.capi.sqlite3_libversion() : null;
  }
}

/**
 * Thin facade over `sqlite3.oo1.DB`. Holds the underlying DB plus enough
 * of the sqlite3 API to expose the operations the app needs (CRUD via
 * exec/selectValue, blob export, close). Becomes inert once invalidated
 * — any further use throws so a bug shows up immediately instead of
 * corrupting the next file's DB.
 */
export class DatabaseHandle {
  constructor(db, sqlite3, service) {
    this._db = db;
    this._sqlite3 = sqlite3;
    this._service = service;
    this._alive = true;
  }

  _checkAlive() {
    if (!this._alive) {
      throw new Error('DatabaseHandle: this handle has been invalidated (a newer file was opened)');
    }
  }

  /** Forwarding to sqlite3.oo1.DB.exec — same shape callers already use. */
  exec(opts) {
    this._checkAlive();
    return this._db.exec(opts);
  }

  selectValue(sql, bind) {
    this._checkAlive();
    return this._db.selectValue(sql, bind);
  }

  /** Export the in-memory DB as a Uint8Array for download. */
  export() {
    this._checkAlive();
    return this._sqlite3.capi.sqlite3_js_db_export(this._db);
  }

  /** True iff this handle is still the service's current handle. */
  isAlive() { return this._alive; }

  /**
   * Internal — called by SqliteService when a newer open() supersedes
   * this handle. Closes the underlying DB and flips the alive flag so
   * subsequent use throws.
   */
  _invalidate() {
    if (!this._alive) return;
    this._alive = false;
    try { this._db.close(); } catch {}
  }
}
