'use strict';
/**
 * Row stash — localStorage-backed clipboard for whole actor_table rows.
 *
 * Use cases:
 *   - Lift per-player save rows (the Steam-ID HPlayerState entries) out of
 *     one world.db and paste them into another (parallel to the official
 *     CLI that copies player data between accounts.db and world.db).
 *   - Snapshot rows before destructive edits.
 *   - Carry rows between sessions / machines via Export to JSON file.
 *
 * Storage: localStorage. Each entry is JSON-serializable with the blob
 * base64-encoded. Limit is ~5MB per origin; a handful of player saves at
 * ~50KB each fit comfortably. For larger bundles, use export-to-file.
 *
 * Entries:
 *   {
 *     id:          uuid,
 *     savedAt:     ISO timestamp,
 *     sourceFile:  file name the row came from,
 *     label:       user-editable short label (shown in UI),
 *     note:        user-editable freeform note,
 *     row: {
 *       server_id, data_version, actor_name, actor_level, actor_script,
 *       actor_owner, actor_transf, actor_time,
 *       actor_data_b64,           // base64 of actor_data, or null
 *       _origSerial               // serial in source DB (informational)
 *     }
 *   }
 *
 * `actor_serial` is intentionally NOT preserved on the row — pasting always
 * lets the destination DB assign a fresh serial via AUTOINCREMENT.
 */
window.SMDB = window.SMDB || {};

SMDB.stash = (() => {
  const KEY = 'soulmaskdb.stash.v1';
  const FILE_FORMAT = 'soulmaskdb-stash';
  const FILE_VERSION = 1;

  const ROW_COLUMNS = [
    'server_id', 'data_version', 'actor_name', 'actor_level',
    'actor_script', 'actor_owner', 'actor_transf', 'actor_time',
  ];

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch { return []; }
  }

  function save(entries) {
    localStorage.setItem(KEY, JSON.stringify(entries));
  }

  function count() { return load().length; }
  function list()  { return load(); }
  function get(id) { return load().find(e => e.id === id) || null; }
  function remove(id) { save(load().filter(e => e.id !== id)); }
  function clear() { save([]); }

  function update(id, patch) {
    const all = load();
    const i = all.findIndex(e => e.id === id);
    if (i < 0) return false;
    all[i] = { ...all[i], ...patch };
    save(all);
    return true;
  }

  // ---- (de)serialization helpers -----------------------------------------

  function rowToStashEntry(dbRow, { sourceFile, label, note } = {}) {
    const row = {};
    for (const c of ROW_COLUMNS) row[c] = dbRow[c] == null ? null : dbRow[c];
    row._origSerial = dbRow.actor_serial;
    row.actor_data_b64 = null;
    if (dbRow.actor_data instanceof Uint8Array && dbRow.actor_data.length > 0) {
      let bin = '';
      const u8 = dbRow.actor_data;
      // Chunked btoa to avoid blowing call-stack on large blobs.
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
      }
      row.actor_data_b64 = btoa(bin);
    }
    return {
      id: uuid(),
      savedAt: new Date().toISOString(),
      sourceFile: sourceFile || null,
      label: label || defaultLabel(dbRow),
      note: note || '',
      row,
    };
  }

  function stashEntryToBindings(entry) {
    const r = entry.row;
    const blob = r.actor_data_b64 ? base64ToUint8(r.actor_data_b64) : null;
    return {
      server_id:    r.server_id,
      data_version: r.data_version,
      actor_name:   r.actor_name,
      actor_level:  r.actor_level,
      actor_script: r.actor_script,
      actor_owner:  r.actor_owner,
      actor_transf: r.actor_transf,
      actor_data:   blob,
      actor_time:   r.actor_time,
    };
  }

  function base64ToUint8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function defaultLabel(dbRow) {
    if (dbRow.actor_name === 'GAME_SETTINGS' || dbRow.actor_name === 'GAMEMODE') {
      return dbRow.actor_name;
    }
    if (typeof dbRow.actor_name === 'string' && /^7656119\d{10}$/.test(dbRow.actor_name)) {
      return `Player ${dbRow.actor_name}`;
    }
    const script = dbRow.actor_script || '';
    const m = script.match(/[./]([^./]+)_C$/);
    return `#${dbRow.actor_serial} ${m ? m[1] : (script || 'row')}`;
  }

  function add(entry) {
    const all = load();
    all.unshift(entry);
    save(all);
    return entry;
  }

  // ---- file import / export ----------------------------------------------

  function exportToBlob() {
    const data = JSON.stringify({
      format: FILE_FORMAT,
      version: FILE_VERSION,
      exportedAt: new Date().toISOString(),
      entries: load(),
    }, null, 2);
    return new Blob([data], { type: 'application/json' });
  }

  function importFromJson(text, { mode = 'merge' } = {}) {
    const parsed = JSON.parse(text);
    if (parsed.format !== FILE_FORMAT) {
      throw new Error(`Not a ${FILE_FORMAT} file (got format='${parsed.format}')`);
    }
    if (!Array.isArray(parsed.entries)) throw new Error('Stash file missing `entries` array');
    const incoming = parsed.entries;
    let next;
    if (mode === 'replace') {
      next = incoming;
    } else {
      const existing = load();
      const knownIds = new Set(existing.map(e => e.id));
      next = existing.concat(incoming.filter(e => !knownIds.has(e.id)));
    }
    save(next);
    return { imported: incoming.length, total: next.length };
  }

  return {
    list, get, add, remove, update, clear, count,
    rowToStashEntry, stashEntryToBindings,
    exportToBlob, importFromJson,
    ROW_COLUMNS,
  };
})();
