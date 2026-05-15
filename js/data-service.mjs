/**
 * DataService — single owner of database-file lifecycle in the page.
 *
 * Responsibilities:
 *   - Maintain an in-memory list of files the user has uploaded (via
 *     drag-drop or the dialog file picker). Each entry holds raw bytes
 *     plus a status: 'pending' | 'world' | 'accounts' | 'invalid'.
 *   - Validate each file via SqliteService.peek(): opens against a
 *     separate VFS slot so the active DB (whatever the user is currently
 *     browsing) is never disturbed. Validity rules:
 *       a) sqlite3 must be able to open the bytes;
 *       b) the DB must contain an `actor_table`;
 *       c) presence of an actor_name in ('GAME_SETTINGS','GAMEMODE')
 *          marks it a world save, otherwise it's an accounts DB.
 *   - Own the file-management dialog (drop zone, list with neutral/red
 *     borders, switch-to + remove buttons, upload form, download button).
 *   - Trigger the actual DB switch by calling Orchestrator.loadFile —
 *     the rest of the app continues to subscribe to orchestrator events
 *     ('rows-ready', 'file-loaded', 'load-error') for the heavy work.
 *   - When the active file is removed, call SqliteService.close() so any
 *     held DatabaseHandle throws on subsequent use.
 *
 * Events (addListener):
 *   'switched'       { id, filename, kind, handle }
 *       A new active DB is loaded and ready.
 *   'unloaded'       { }
 *       The active DB was removed; no DB is active.
 *   'file-added'     { id }
 *   'file-validated' { id, status }
 *   'file-removed'   { id }
 */

const DB_NAME_EXT = /\.(db|sqlite|db3)$/i;

export class DataService {
  constructor({ sqliteService, orchestrator }) {
    if (!sqliteService) throw new Error('DataService: sqliteService is required');
    if (!orchestrator)  throw new Error('DataService: orchestrator is required');
    this._sqlite = sqliteService;
    this._orch   = orchestrator;

    this._files     = [];
    this._activeId  = null;
    this._nextId    = 1;
    this._listeners = new Set();

    this._dialog       = null;
    this._listEl       = null;
    this._dropOverlay  = null;
    this._dragDepth    = 0;
    this._initialized  = false;
  }

  /** Bind drag/drop on window and wire up the dialog DOM. Idempotent. */
  init() {
    if (this._initialized) return;
    this._initialized = true;
    this._bindDragDrop();
    this._wireDialog();
  }

  // ---- public API --------------------------------------------------------

  addListener(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  files()  { return this._files.slice(); }
  active() { return this._files.find(f => f.id === this._activeId) || null; }
  activeHandle() { return this._orch.db(); }

  /**
   * Add a File. Reads bytes, validates via SqliteService.peek(),
   * classifies. Returns the entry after validation completes.
   */
  async addFile(file) {
    const id = this._nextId++;
    const entry = {
      id,
      filename: file.name,
      bytes:    null,
      size:     file.size,
      status:   'pending',
      kind:     null,
      error:    null,
      metadata: {},
      addedAt:  new Date(),
    };
    this._files.push(entry);
    this._renderList();
    this._emit('file-added', { id });

    try {
      entry.bytes = new Uint8Array(await file.arrayBuffer());
      const result = await this._validate(entry.bytes);
      entry.kind     = result.kind;
      entry.status   = result.kind;
      entry.metadata = result.metadata;
    } catch (e) {
      entry.status = 'invalid';
      entry.error  = (e && e.message) || String(e);
    }
    this._renderList();
    this._emit('file-validated', { id, status: entry.status });
    return entry;
  }

  removeFile(id) {
    const idx = this._files.findIndex(f => f.id === id);
    if (idx < 0) return;
    const wasActive = this._activeId === id;
    this._files.splice(idx, 1);
    if (wasActive) {
      this._activeId = null;
      this._sqlite.close();     // dangling DatabaseHandle references now throw
      this._emit('unloaded', {});
    }
    this._renderList();
    this._emit('file-removed', { id });
  }

  async switchTo(id) {
    const entry = this._files.find(f => f.id === id);
    if (!entry) return;
    if (entry.status !== 'world' && entry.status !== 'accounts') return;
    if (this._activeId === id) return;

    this._activeId = id;
    this._renderList();    // mark ACTIVE immediately, before the load completes
    this.closeDialog();    // get out of the way so the table is visible

    await this._orch.loadFile(entry.bytes, entry.filename);
    const handle = this._orch.db();
    if (!handle) {
      // Orchestrator already emitted 'load-error'. Drop the active marker.
      this._activeId = null;
      this._renderList();
      return;
    }
    this._renderList();
    this._emit('switched', { id, filename: entry.filename, kind: entry.kind, handle });
  }

  /**
   * Trigger a browser download for one file in the list. Defaults to
   * the active file.
   *   - If `id` is the active file (or null), the bytes come from the
   *     orchestrator's live handle, so any in-page edits are included.
   *     The filename gets a `.modified.<stamp>` suffix.
   *   - Otherwise the entry's stored bytes are served verbatim under
   *     the original filename.
   * Returns the byte count downloaded, or 0 if nothing happened.
   */
  download(id) {
    const targetId = (id == null) ? this._activeId : id;
    if (targetId == null) return 0;
    const entry = this._files.find(f => f.id === targetId);
    if (!entry || entry.status === 'invalid' || entry.status === 'pending') return 0;

    let bytes, name;
    if (targetId === this._activeId) {
      const handle = this._orch.db();
      if (!handle) return 0;
      bytes = handle.export();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const base  = entry.filename.replace(DB_NAME_EXT, '');
      name = `${base}.modified.${stamp}.db`;
    } else {
      bytes = entry.bytes;
      name  = entry.filename;
    }

    const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click(); a.remove();
    URL.revokeObjectURL(url);
    return bytes.byteLength ?? bytes.length ?? 0;
  }

  /** Legacy shorthand kept for the header "Download modified .db" button. */
  downloadActive() { return this.download(this._activeId); }

  openDialog() {
    this.init();
    this._renderList();
    if (this._dialog && !this._dialog.open) this._dialog.showModal();
  }

  closeDialog() {
    if (this._dialog?.open) this._dialog.close();
  }

  /** Open the dialog only if no file is active and the dialog isn't already up. */
  maybeAutoOpen() {
    if (!this._activeId && this._dialog && !this._dialog.open) this.openDialog();
  }

  // ---- internals ---------------------------------------------------------

  _emit(event, data) {
    for (const fn of this._listeners) {
      try { fn(event, data); }
      catch (e) { console.error('DataService listener threw:', e); }
    }
  }

  async _validate(bytes) {
    return await this._sqlite.peek(bytes, (db) => {
      const hasTable = db.selectValue(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='actor_table'");
      if (!hasTable) throw new Error('missing actor_table');
      const isWorld = db.selectValue(
        "SELECT 1 FROM actor_table WHERE actor_name IN ('GAME_SETTINGS','GAMEMODE') LIMIT 1");
      const rowCount = db.selectValue('SELECT COUNT(*) FROM actor_table');
      return {
        kind:     isWorld ? 'world' : 'accounts',
        metadata: { rowCount: rowCount ?? 0 },
      };
    });
  }

  _bindDragDrop() {
    // Track enter/leave depth so the drop overlay doesn't flicker when
    // the cursor crosses child element boundaries.
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this._dragDepth++;
      this._showOverlay(true);
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      this._dragDepth = Math.max(0, this._dragDepth - 1);
      if (this._dragDepth === 0) this._showOverlay(false);
    });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this._dragDepth = 0;
      this._showOverlay(false);
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length === 0) return;
      this.openDialog();
      for (const f of files) {
        try { await this.addFile(f); }
        catch (err) { console.error('DataService: addFile failed', err); }
      }
    });
  }

  _wireDialog() {
    this._dialog = document.getElementById('dataDialog');
    this._listEl = document.getElementById('dataList');
    this._dropOverlay = document.getElementById('dropOverlay');
    if (!this._dialog || !this._listEl) {
      console.warn('DataService: dialog markup not found in DOM (#dataDialog/#dataList)');
      return;
    }
    document.getElementById('dataDialogClose')
      ?.addEventListener('click', () => this.closeDialog());
    document.getElementById('manageFilesBtn')
      ?.addEventListener('click', () => this.openDialog());

    const input = document.getElementById('dataFileInput');
    if (input) {
      input.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        for (const f of files) {
          try { await this.addFile(f); }
          catch (err) { console.error('DataService: addFile failed', err); }
        }
        e.target.value = '';
      });
    }

  }

  _showOverlay(on) {
    if (!this._dropOverlay) return;
    this._dropOverlay.classList.toggle('visible', !!on);
  }

  _renderList() {
    if (!this._listEl) return;
    const t = (k, opts) => {
      if (typeof window !== 'undefined' && window.SMDB && window.SMDB.i18n) {
        return window.SMDB.i18n.t(k, opts);
      }
      return (opts && 'default' in opts) ? opts.default : k;
    };

    this._listEl.innerHTML = '';
    if (this._files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'data-empty muted';
      empty.textContent = t('ui.data.empty',
        { default: 'No files yet. Drop a .db here, or use the form below.' });
      this._listEl.appendChild(empty);
      return;
    }
    for (const f of this._files) {
      this._listEl.appendChild(this._renderEntry(f, t));
    }
  }

  _renderEntry(f, t) {
    const wrap = document.createElement('div');
    wrap.className = 'data-entry';
    if (f.status === 'invalid')    wrap.classList.add('invalid');
    if (this._activeId === f.id)   wrap.classList.add('active');

    const head = document.createElement('div');
    head.className = 'data-entry-head';

    const name = document.createElement('div');
    name.className = 'data-entry-name';
    name.textContent = f.filename;
    head.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'data-entry-badge ' + f.status;
    badge.textContent =
        f.status === 'pending'  ? t('ui.data.status.pending',  { default: '…' })
      : f.status === 'invalid'  ? t('ui.data.status.invalid',  { default: 'invalid' })
      : f.status === 'world'    ? t('ui.data.status.world',    { default: 'world save' })
      : f.status === 'accounts' ? t('ui.data.status.accounts', { default: 'accounts' })
                                : f.status;
    head.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'data-entry-meta muted';
    const parts = [fmtBytes(f.size)];
    if (f.metadata.rowCount != null) {
      parts.push(t('ui.data.rowCount',
        { count: Number(f.metadata.rowCount).toLocaleString(), default: '{count} rows' }));
    }
    if (f.error) parts.push(f.error);
    meta.textContent = parts.join(' · ');

    const actions = document.createElement('div');
    actions.className = 'data-entry-actions';
    const isValid = f.status === 'world' || f.status === 'accounts';
    if (isValid) {
      const sw = document.createElement('button');
      const active = this._activeId === f.id;
      sw.className = active ? '' : 'primary';
      sw.disabled = active;
      sw.textContent = active
        ? t('ui.data.active',   { default: 'active' })
        : t('ui.data.switchTo', { default: 'switch to' });
      sw.addEventListener('click', () => this.switchTo(f.id));
      actions.appendChild(sw);

      const dl = document.createElement('button');
      dl.textContent = t('ui.data.download', { default: '⤓ download' });
      dl.addEventListener('click', () => this.download(f.id));
      actions.appendChild(dl);
    }
    const rm = document.createElement('button');
    rm.className = 'danger';
    rm.textContent = t('ui.data.remove', { default: 'remove' });
    rm.addEventListener('click', () => this.removeFile(f.id));
    actions.appendChild(rm);

    wrap.appendChild(head);
    wrap.appendChild(meta);
    wrap.appendChild(actions);
    return wrap;
  }
}

function hasFiles(e) {
  const t = e.dataTransfer;
  if (!t) return false;
  if (t.types && Array.from(t.types).includes('Files')) return true;
  return !!(t.files && t.files.length);
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
