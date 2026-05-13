'use strict';
/**
 * Main UI for the Soulmask world.db browser.
 *
 * Loads on top of: sqlite3.js, codec-json, codec-unreal-properties, codecs,
 * locale catalogs (js/locale/*.js), i18n, steam, stash. All cross-module
 * state lives on `SMDB.*`. User-visible strings go through `t(key, opts?)`
 * (a file-scope alias for SMDB.i18n.t); the catalogs in js/locale/ are the
 * single source of truth for what to render in each language.
 */

// ============================================================
// SHARED RENDER HELPERS
// ============================================================

const $ = id => document.getElementById(id);
const t = SMDB.i18n.t;  // file-scope alias for terse call sites

function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const escapeAttr = escapeText;

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function hexDump(blob, start = 0, maxBytes = 4096) {
  const end = Math.min(blob.length, start + maxBytes);
  const lines = [];
  for (let off = start; off < end; off += 16) {
    const chunk = blob.subarray(off, Math.min(off + 16, end));
    let hex = '';
    for (let i = 0; i < chunk.length; i++) {
      hex += chunk[i].toString(16).padStart(2, '0') + (i === 7 ? '  ' : ' ');
    }
    hex = hex.padEnd(50, ' ');
    let ascii = '';
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      ascii += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
    }
    lines.push(off.toString(16).padStart(8, '0') + '  ' + hex + ' ' + ascii);
  }
  return lines.join('\n');
}

// ============================================================
// SQLITE STATE
// ============================================================

let sqlite3 = null;
let db = null;
const VFS_NAME = 'soulmask.db';
let allRows = [];
let filtered = [];
let currentPage = 0;
const PAGE_SIZE = 200;
let selectedSerial = null;
let dirty = false;
let currentFileLabel = null;
// server_id detected from the loaded DB. Used when pasting from stash so
// inserted rows belong to this server, not whichever server the stash was
// captured from. See detectServerId() for the lookup strategy.
let currentServerId = null;

const setStatus = msg => { $('status').textContent = msg || ''; };

async function bootSqlite() {
  if (sqlite3) return sqlite3;
  setStatus(t('ui.status.initSqlite'));
  sqlite3 = await globalThis.sqlite3InitModule({
    print: (...a) => console.log('[sqlite3]', ...a),
    printErr: (...a) => console.warn('[sqlite3]', ...a),
  });
  setStatus(t('ui.status.sqliteReady', { version: sqlite3.capi.sqlite3_libversion() }));
  return sqlite3;
}

async function loadFile(file) {
  await bootSqlite();
  setStatus(t('ui.status.loadingFile', { file: file.name, size: fmtBytes(file.size) }));
  const bytes = new Uint8Array(await file.arrayBuffer());
  loadBytes(bytes, file.name);
}

function loadBytes(bytes, label) {
  if (db) { try { db.close(); } catch {} }
  try { sqlite3.util.sqlite3__wasm_vfs_unlink(0, VFS_NAME); } catch {}
  sqlite3.capi.sqlite3_js_posix_create_file(VFS_NAME, bytes);
  db = new sqlite3.oo1.DB(VFS_NAME, 'w');

  const hasTable = db.selectValue("SELECT 1 FROM sqlite_master WHERE type='table' AND name='actor_table'");
  if (!hasTable) {
    db.close(); db = null;
    setStatus('');
    alert(t('ui.alert.notSoulmaskDB', { file: label }));
    return;
  }

  currentFileLabel = label;
  loadRows();
  currentServerId = detectServerId();
  dirty = false;
  selectedSerial = null;
  $('detail').classList.add('hidden');
  $('main').classList.remove('with-detail');
  updateChrome();
  applyFilters();
  setStatus(t('ui.status.loaded', { file: label, count: allRows.length.toLocaleString() }));
  resolvePlayerNames();
}

// Fire-and-forget Steam-name resolution after a save loads. On success,
// re-renders the table so resolved names appear in the row list. Errors
// (404, CORS, offline, etc.) are silently swallowed by SMDB.steam.resolveNames
// — the existing manual-label flow remains the fallback.
function resolvePlayerNames() {
  const ids = [];
  for (const r of allRows) {
    if (SMDB.steam.isSteamId64(r.actor_name)) ids.push(r.actor_name);
  }
  if (ids.length === 0) return;
  SMDB.steam.resolveNames(ids).then(updated => {
    if (updated > 0) { renderTable(); updateChrome(); }
  });
}

function loadRows() {
  // Load all rows including blob data so we can build a per-row text index.
  // We drop the actor_data reference after extracting strings to keep
  // memory bounded.
  const rows = [];
  setStatus(t('ui.status.loadingRows'));
  db.exec({
    sql: `SELECT actor_serial, server_id, data_version, actor_name, actor_script,
                 actor_owner, actor_transf, actor_time, actor_data,
                 length(actor_data) AS blob_size
          FROM actor_table ORDER BY actor_serial`,
    rowMode: 'object',
    resultRows: rows,
  });
  setStatus(t('ui.status.indexingBlobs', { count: rows.length.toLocaleString() }));
  for (const r of rows) {
    const c = SMDB.classify.classify(r);
    r._kind = c.kind; r._label = c.label; r._summary = c.summary;
    r._blobText = r.actor_data ? extractBlobText(r.actor_data) : '';
    r.actor_data = null;  // release the blob — kept only the searchable text
  }
  allRows = rows;
}

/**
 * Lowercased newline-joined string of all printable-ASCII runs in the blob
 * (>= 4 chars). Used for substring search in the filter.
 */
function extractBlobText(blob) {
  // Build a parallel buffer with non-ASCII bytes replaced by 0, then split
  // on \0 and keep runs that meet the minimum length. Using
  // String.fromCharCode.apply on chunks is roughly an order of magnitude
  // faster than a per-byte concat loop on a 50KB blob.
  const remap = new Uint8Array(blob.length);
  for (let i = 0; i < blob.length; i++) {
    const b = blob[i];
    remap[i] = (b >= 32 && b < 127) ? b : 0;
  }
  let raw = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < remap.length; i += CHUNK) {
    raw += String.fromCharCode.apply(null, remap.subarray(i, Math.min(i + CHUNK, remap.length)));
  }
  // Keep runs of length >= 4 (skips most random byte sequences that happen
  // to fall in the printable range).
  const parts = raw.split('\0');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length >= 4) {
      out += (out ? '\n' : '') + parts[i];
    }
  }
  return out.toLowerCase();
}

// world.db: server_id comes from the GAME_SETTINGS row. accounts.db has no
// such row, so fall back to the first row's server_id — the user will likely
// need to fix it manually via the editable field, but that's better than
// inserting NULL.
function detectServerId() {
  const fromSettings = db.selectValue(
    "SELECT server_id FROM actor_table WHERE actor_name = ?", ['GAME_SETTINGS']);
  if (fromSettings != null) return fromSettings;
  return db.selectValue(
    "SELECT server_id FROM actor_table ORDER BY actor_serial LIMIT 1");
}

function getRowDetail(serial) {
  const rows = [];
  db.exec({
    sql: 'SELECT * FROM actor_table WHERE actor_serial = ?',
    bind: [serial],
    rowMode: 'object',
    resultRows: rows,
  });
  return rows[0];
}

function markDirty() { dirty = true; updateChrome(); }

function updateChrome() {
  $('downloadBtn').disabled = !db;
  $('verifyAllBtn').disabled = !db;
  $('scriptsBtn').disabled = !db;
  $('controls').hidden = !db;
  $('empty').hidden = !!db;
  $('changedBadge').textContent = dirty ? t('ui.header.changedBadge') : '';
  $('stashBtn').textContent = t('ui.header.stash', { count: SMDB.stash.count() });
  const cacheN = SMDB.steam.cacheCount();
  $('steamCacheBtn').textContent = t('ui.header.steamCache', { count: cacheN });
  $('steamCacheBtn').disabled = cacheN === 0;
  if (db) renderSummary();
}

// ============================================================
// TABLE / FILTERS / SUMMARY
// ============================================================

function applyFilters() {
  const q = $('search').value.toLowerCase().trim();
  const k = $('kindFilter').value;
  filtered = allRows.filter(r => {
    if (k && r._kind !== k) return false;
    if (!q) return true;
    if (String(r.actor_serial) === q) return true;
    return (r.actor_script || '').toLowerCase().includes(q)
        || (r.actor_name   || '').toLowerCase().includes(q)
        || (r.actor_owner  || '').toLowerCase().includes(q)
        || (r._summary     || '').toLowerCase().includes(q)
        || (r._blobText    || '').includes(q);  // _blobText is pre-lowercased
  });
  currentPage = 0;
  renderTable();
}

function renderTable() {
  const start = currentPage * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  const thead = $('rowsTable').querySelector('thead');
  const tbody = $('rowsTable').querySelector('tbody');

  thead.innerHTML = `
    <tr>
      <th>${escapeText(t('ui.tableHeader.serial'))}</th>
      <th>${escapeText(t('ui.tableHeader.kind'))}</th>
      <th>${escapeText(t('ui.tableHeader.class'))}</th>
      <th>${escapeText(t('ui.tableHeader.summary'))}</th>
      <th>${escapeText(t('ui.tableHeader.owner'))}</th>
      <th>${escapeText(t('ui.tableHeader.blob'))}</th>
      <th>${escapeText(t('ui.tableHeader.time'))}</th>
    </tr>`;

  if (slice.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding: 16px;">${escapeText(t('ui.tableEmpty'))}</td></tr>`;
  } else {
    tbody.innerHTML = slice.map(r => {
      const nameLabel = SMDB.steam.isSteamId64(r.actor_name) ? steamShortLabel(r.actor_name) : '';
      const labelHtml = nameLabel
        ? `${escapeText(r._label)} <span class="muted">— ${escapeText(nameLabel)}</span>`
        : escapeText(r._label);
      return `
      <tr data-serial="${r.actor_serial}" class="${r.actor_serial === selectedSerial ? 'selected' : ''}">
        <td>${r.actor_serial}</td>
        <td><span class="pill ${r._kind}">${escapeText(t('ui.kind.' + r._kind, {default: r._kind}))}</span></td>
        <td title="${escapeAttr(r.actor_script || '')}">${labelHtml}</td>
        <td title="${escapeAttr(r._summary || '')}">${escapeText(r._summary)}</td>
        <td class="muted" title="${escapeAttr(r.actor_owner || '')}">${escapeText(r.actor_owner || '')}</td>
        <td class="muted">${fmtBytes(r.blob_size || 0)}</td>
        <td class="muted">${escapeText(r.actor_time || '')}</td>
      </tr>`;
    }).join('');
  }

  tbody.querySelectorAll('tr[data-serial]').forEach(tr => {
    tr.addEventListener('click', () => selectRow(parseInt(tr.dataset.serial, 10)));
  });

  $('filterCount').textContent = t('ui.filterCount', {
    shown: filtered.length.toLocaleString(),
    total: allRows.length.toLocaleString(),
  });

  renderPagination();
}

function renderPagination() {
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total === 0) { $('pagination').hidden = true; return; }
  $('pagination').hidden = false;
  $('pagination').innerHTML = `
    <button id="firstPage" ${currentPage === 0 ? 'disabled' : ''}>${escapeText(t('ui.pagination.first'))}</button>
    <button id="prevPage"  ${currentPage === 0 ? 'disabled' : ''}>${escapeText(t('ui.pagination.prev'))}</button>
    <span class="muted">${escapeText(t('ui.pagination.pageOf', { page: currentPage + 1, pages }))}</span>
    <button id="nextPage"  ${currentPage >= pages - 1 ? 'disabled' : ''}>${escapeText(t('ui.pagination.next'))}</button>
    <button id="lastPage"  ${currentPage >= pages - 1 ? 'disabled' : ''}>${escapeText(t('ui.pagination.last'))}</button>
  `;
  $('firstPage')?.addEventListener('click', () => { currentPage = 0; renderTable(); });
  $('prevPage') ?.addEventListener('click', () => { currentPage--;   renderTable(); });
  $('nextPage') ?.addEventListener('click', () => { currentPage++;   renderTable(); });
  $('lastPage') ?.addEventListener('click', () => { currentPage = pages - 1; renderTable(); });
}

function renderSummary() {
  const counts = {};
  for (const r of allRows) counts[r._kind] = (counts[r._kind] || 0) + 1;
  const order = ['system', 'player', 'inventory', 'npc', 'animal', 'container', 'station', 'building', 'furniture', 'vegetation', 'region', 'vehicle', 'other'];
  $('summary').innerHTML = `
    <div class="stat"><span class="muted">${escapeText(t('ui.summary.total'))}</span><b>${allRows.length.toLocaleString()}</b></div>
    ${order.filter(k => counts[k]).map(k => `
      <div class="stat"><span class="pill ${k}">${escapeText(t('ui.kind.' + k, {default: k}))}</span><b>${counts[k].toLocaleString()}</b></div>
    `).join('')}
  `;
  $('summary').hidden = false;
}

function steamShortLabel(steamid64) {
  return SMDB.steam.displayName(steamid64) || '';
}

// ============================================================
// DETAIL PANEL
// ============================================================

const EDITABLE = ['actor_name', 'actor_level', 'actor_script', 'actor_owner', 'actor_transf', 'actor_time', 'server_id'];
const NUMERIC_FIELDS = new Set(['server_id', 'data_version']);
const FIELD_HINTS = { actor_time: 'UTC' };

function selectRow(serial) {
  selectedSerial = serial;
  const row = getRowDetail(serial);
  const summary = allRows.find(r => r.actor_serial === serial);
  renderDetail(row, summary);
  $('main').classList.add('with-detail');
  $('detail').classList.remove('hidden');
  renderTable();
}

function renderDetail(row, summary) {
  const tx = SMDB.classify.parseTransform(row.actor_transf);
  const blob = row.actor_data;
  const blobLen = blob ? blob.length : 0;
  const decoded = blob ? SMDB.codecs.decode(blob) : null;

  // ---- editable fields ----
  const fieldsHtml = EDITABLE.map(f => {
    const v = row[f] == null ? '' : String(row[f]);
    const tag = (f === 'actor_name' || f === 'actor_script' || f === 'actor_transf') ? 'textarea' : 'input';
    const open = tag === 'textarea'
      ? `<textarea id="f_${f}" rows="2">`
      : `<input id="f_${f}" value="${escapeAttr(v)}"${NUMERIC_FIELDS.has(f) ? ' inputmode="numeric"' : ''}>`;
    const close = tag === 'textarea' ? `${escapeText(v)}</textarea>` : '';
    const hint = FIELD_HINTS[f] ? ` <span class="muted" style="font-size:11px;">(${FIELD_HINTS[f]})</span>` : '';
    return `<div class="field" data-field="${f}"><label>${f}${hint}</label>${open}${close}</div>`;
  }).join('');

  // ---- transform ----
  const txHtml = tx ? `
    <div class="detail-section">
      <h3>${escapeText(t('ui.detail.transformHeading'))}</h3>
      <div class="field"><label>${escapeText(t('ui.detail.position'))}</label><span class="span">${tx.pos.map(n => n.toFixed(2)).join(', ')}</span></div>
      <div class="field"><label>${escapeText(t('ui.detail.rotation'))}</label><span class="span">${tx.rot.map(n => n.toFixed(2)).join(', ')}</span></div>
      <div class="field"><label>${escapeText(t('ui.detail.scale'))}</label><span class="span">${tx.scale.map(n => n.toFixed(3)).join(', ')}</span></div>
    </div>` : '';

  // ---- steam panel for player saves ----
  const steamHtml = SMDB.steam.isSteamId64(row.actor_name) ? renderSteamSection(row.actor_name) : '';

  // ---- blob panel via codecs ----
  const blobHtml = blobLen === 0 ? `<div class="muted">${escapeText(t('ui.detail.noBlob'))}</div>` : renderBlobByCodec(decoded, row.actor_serial, blob);

  $('detail').innerHTML = `
    <div class="detail-section">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0;">${escapeText(t('ui.detail.rowHeading', { serial: row.actor_serial }))} <span class="pill ${summary._kind}">${escapeText(t('ui.kind.' + summary._kind, {default: summary._kind}))}</span></h3>
        <button id="closeDetail">${escapeText(t('ui.detail.close'))}</button>
      </div>
      <div class="muted" style="margin-top:6px;">${escapeText(summary._label)}</div>
      <div class="muted">${escapeText(summary._summary)}</div>
    </div>

    ${steamHtml}

    <div class="detail-section">
      <h3>${escapeText(t('ui.detail.numeric'))}</h3>
      <div class="field"><label>actor_serial</label><span class="span">${row.actor_serial}</span></div>
      <div class="field"><label>data_version</label><span class="span">${row.data_version}</span></div>
    </div>

    <div class="detail-section">
      <h3>${escapeText(t('ui.detail.editable'))}</h3>
      ${fieldsHtml}
      <div class="toolbar">
        <button id="saveRow" class="primary" disabled>${escapeText(t('ui.detail.saveChanges'))}</button>
        <button id="revertRow" disabled>${escapeText(t('ui.detail.revert'))}</button>
        <button id="stashRow">${escapeText(t('ui.detail.stashRow'))}</button>
        <span class="spacer" style="flex:1;"></span>
        <button id="deleteRow" class="danger">${escapeText(t('ui.detail.deleteRow'))}</button>
      </div>
    </div>

    ${txHtml}

    <div class="detail-section">
      <h3>${escapeText(t('ui.detail.blobHeading', { size: fmtBytes(blobLen), codec: decoded ? decoded.kind : t('ui.detail.blobNone') }))}</h3>
      ${blobHtml}
    </div>`;

  wireDetailEditing(row, summary, decoded);
}

function renderSteamSection(steamid64) {
  const s = SMDB.steam.decompose(steamid64);
  if (!s) return '';
  const stored = SMDB.steam.getLabel(steamid64) || '';
  const info = SMDB.steam.getInfo(steamid64);
  const placeholder = info && info.personaName
    ? t('ui.steam.placeholder.auto', { name: info.personaName })
    : t('ui.steam.placeholder.manual');
  const avatarHtml = info && info.avatar
    ? `<div class="field"><label>${escapeText(t('ui.steam.avatar'))}</label><img src="${escapeAttr(info.avatar)}" alt="" referrerpolicy="no-referrer" style="width:48px; height:48px; border:1px solid var(--border); border-radius:2px;"></div>`
    : '';
  return `
    <div class="detail-section">
      <h3>${escapeText(t('ui.steam.heading'))}</h3>
      ${avatarHtml}
      <div class="field"><label>${escapeText(t('ui.steam.personaName'))}</label>
        <input id="steamLabel" value="${escapeAttr(stored)}" placeholder="${escapeAttr(placeholder)}">
      </div>
      <div class="field"><label>${escapeText(t('ui.steam.steamid64'))}</label><span class="span">${escapeText(s.steamid64)}</span></div>
      <div class="toolbar">
        <a href="${s.profileUrl}" target="_blank" rel="noopener noreferrer">
          <button type="button">${escapeText(t('ui.steam.openProfile'))}</button>
        </a>
        <button id="saveSteamLabel" class="primary" disabled>${escapeText(t('ui.steam.savePersona'))}</button>
      </div>
    </div>`;
}

function renderBlobByCodec(decoded, serial, rawBlob) {
  if (!decoded) return `<div class="muted">${escapeText(t('ui.detail.noBlob'))}</div>`;
  if (decoded.kind === 'json-wrapped')      return renderJsonBlob(decoded, serial);
  if (decoded.kind === 'unreal-properties') return renderUnrealProperties(decoded, rawBlob);
  // unknown / empty
  if (decoded._raw) {
    const header = Array.from(decoded._raw.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    return `
      <div class="muted">${escapeText(t('ui.blob.unknownFormat', { header }))}</div>
      <details open><summary>${escapeText(t('ui.blob.hexHead', { size: decoded.totalSize.toLocaleString() }))}</summary>
        <pre class="hex">${escapeText(hexDump(decoded._raw, 0, 4096))}</pre></details>`;
  }
  return `<div class="muted">${escapeText(t('ui.detail.empty'))}</div>`;
}

function renderJsonBlob(decoded, serial) {
  const parseErr = decoded.parseError
    ? `<div class="danger" style="margin-bottom:6px;">${escapeText(t('ui.blob.parseError', { message: decoded.parseError }))}</div>`
    : '';
  const pretty = decoded.parsed != null ? JSON.stringify(decoded.parsed, null, 2) : decoded.text;
  return `
    ${parseErr}
    <div class="field" style="grid-template-columns: 110px 1fr; align-items: stretch;">
      <label>${escapeText(t('ui.blob.json'))}</label>
      <textarea id="jsonEditor" rows="8" data-serial="${serial}">${escapeText(pretty)}</textarea>
    </div>
    <div class="toolbar">
      <button id="saveJsonBlob" class="primary" disabled>${escapeText(t('ui.blob.saveJson'))}</button>
      <button id="revertJsonBlob" disabled>${escapeText(t('ui.blob.revertJson'))}</button>
      <span class="muted" id="jsonStatus"></span>
    </div>
    <details><summary>${escapeText(t('ui.blob.headerMeta'))}</summary>
      <pre class="hex">${escapeText(JSON.stringify(decoded.header, null, 2))}</pre>
    </details>`;
}

function renderUnrealProperties(decoded, rawBlob) {
  const h = decoded.header;
  const headerLines = [
    `versionTag    0x${h.versionTag.toString(16).padStart(8, '0')}  (${h.versionTag})`,
    `headerWord1   0x${h.headerWord1.toString(16).padStart(8, '0')}  (${h.headerWord1})`,
    `headerWord2   0x${h.headerWord2.toString(16).padStart(8, '0')}  (${h.headerWord2})`,
    `headerExtra   0x${h.headerExtra.toString(16).padStart(4, '0')}      (${h.headerExtra})`,
    `body bytes    ${decoded.bodySize}`,
  ].join('\n');

  const namesText = decoded.names.length === 0 ? t('ui.blob.namesNone') :
    decoded.names.map(n => `@0x${n.offset.toString(16).padStart(6, '0')}  len=${String(n.length).padStart(3)}  ${n.text}`).join('\n');

  return `
    <div class="muted" style="margin-bottom:8px;">${escapeText(t('ui.blob.unrealNote'))}</div>
    <details open><summary>${escapeText(t('ui.blob.unrealHeader', { size: SMDB.codecUnrealProperties.HEADER_SIZE }))}</summary>
      <pre class="hex">${escapeText(headerLines)}</pre></details>
    <details open><summary>${escapeText(t('ui.blob.unrealNames', { count: decoded.names.length }))}</summary>
      <pre class="hex">${escapeText(namesText)}</pre></details>
    <details><summary>${escapeText(t('ui.blob.hexFull', { size: decoded.totalSize.toLocaleString() }))}</summary>
      <pre class="hex">${escapeText(hexDump(rawBlob, 0, 4096))}</pre></details>
  `;
}

// ---- structured-tree rendering -----------------------------------------

function renderPropertyEntry(prop, idx, depth) {
  const t = prop.tag;
  const typeStr = propertyTypeLabel(t);
  const nameStr = formatFName(t.name) + (t.arrayIndex ? `[${t.arrayIndex}]` : '');
  const valueHtml = renderValue(t, prop.value, depth);
  const sizeWarn = prop._sizeMismatch
    ? ` <span class="danger" title="${escapeAttr(t('ui.tree.sizeMismatchTitle'))}">⚠</span>`
    : '';
  const guidLine = t.hasPropertyGuid ? ` <span class="muted">{${t.propertyGuid}}</span>` : '';
  return `
    <div class="prop-row" style="padding-left:${depth * 14}px;">
      <span class="prop-name">${escapeText(nameStr)}</span>
      <span class="prop-type muted">: ${escapeText(typeStr)}${guidLine}${sizeWarn}</span>
      <span class="prop-val">${valueHtml}</span>
    </div>`;
}

function propertyTypeLabel(tag) {
  let t = tag.type.value;
  if (t === 'StructProperty') return `StructProperty (${tag.structName.value})`;
  if (t === 'ArrayProperty')  return `ArrayProperty&lt;${tag.innerType.value}&gt;`;
  if (t === 'SetProperty')    return `SetProperty&lt;${tag.innerType.value}&gt;`;
  if (t === 'MapProperty')    return `MapProperty&lt;${tag.innerType.value}, ${tag.valueType.value}&gt;`;
  if (t === 'ByteProperty' && tag.enumName?.value && tag.enumName.value !== 'None') return `ByteProperty (${tag.enumName.value})`;
  if (t === 'EnumProperty')   return `EnumProperty (${tag.enumName.value})`;
  return t;
}

function formatFName(n) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  return n.number ? `${n.value}_${n.number - 1}` : n.value;
}

function renderValue(tag, value, depth) {
  const propType = tag.type.value;  // local var (shadows file-scope `t` i18n alias)
  if (value && value._opaque) {
    return `<span class="muted">${escapeText(SMDB.i18n.t('ui.tree.opaque', { bytes: value._opaque.length, reason: value._opaqueReason || '?' }))}</span>`;
  }
  switch (propType) {
    case 'IntProperty': case 'Int8Property': case 'Int16Property':
    case 'UInt16Property': case 'UInt32Property':
      return `= <code>${value}</code>`;
    case 'Int64Property': case 'UInt64Property':
      return `= <code>${escapeText(String(value))}</code>`;
    case 'FloatProperty': case 'DoubleProperty':
      return `= <code>${Number(value).toPrecision(7)}</code>`;
    case 'BoolProperty':
      return `= <code>${value}</code>`;
    case 'StrProperty':
      return `= <code>${escapeText(JSON.stringify(value))}</code>`;
    case 'NameProperty':
      return `= <code>${escapeText(formatFName(value))}</code>`;
    case 'ObjectProperty': case 'ClassProperty':
    case 'WeakObjectProperty': case 'LazyObjectProperty':
      return `→ <code>${escapeText(value)}</code>`;
    case 'SoftObjectProperty': case 'SoftClassProperty':
      return `→ <code>${escapeText(value.assetPath)}${value.subPath ? ':' + escapeText(value.subPath) : ''}</code>`;
    case 'ByteProperty':
      return tag.enumName.value === 'None'
        ? `= <code>${value}</code>`
        : `= <code>${escapeText(formatFName(value))}</code>`;
    case 'EnumProperty':
      return `= <code>${escapeText(formatFName(value))}</code>`;
    case 'StructProperty':
      return renderStructValue(value, depth);
    case 'ArrayProperty':
      return renderArrayValue(tag, value, depth);
    case 'SetProperty':
      return renderSetValue(tag, value, depth);
    case 'MapProperty':
      return renderMapValue(tag, value, depth);
    case 'TextProperty':
      return `<span class="muted">${escapeText(SMDB.i18n.t('ui.tree.text', { bytes: value && value._opaque ? value._opaque.length : 0 }))}</span>`;
    default:
      return `<span class="muted">${escapeText(SMDB.i18n.t('ui.tree.value', { type: propType }))}</span>`;
  }
}

function renderStructValue(sv, depth) {
  if (!sv) return `<span class="muted">${escapeText(t('ui.tree.emptyStruct'))}</span>`;
  const name = sv._structName;
  // Known-binary struct: render compactly.
  if (SMDB.codecUnrealProperties.STRUCT_HANDLERS[name]) {
    return `= <code>${escapeText(JSON.stringify(sv.value))}</code>`;
  }
  // Unknown struct: nested properties
  if (sv._structDecodeError) {
    return `<span class="danger">${escapeText(t('ui.tree.structDecodeError', { message: sv._structDecodeError }))}</span>`;
  }
  if (!Array.isArray(sv.value) || sv.value.length === 0) {
    return `<span class="muted">${escapeText(t('ui.tree.empty'))}</span>`;
  }
  const inner = sv.value.map((p, i) => renderPropertyEntry(p, i, depth + 1)).join('');
  return `<div class="prop-children">${inner}</div>`;
}

function renderArrayValue(tag, value, depth) {
  if (!value || !value.elements || value.elements.length === 0) {
    return `<span class="muted">[]</span>`;
  }
  const innerType = tag.innerType.value;
  // Show inline if elements are tiny primitives and the array is small.
  const isShortPrim = value.elements.length <= 8 && ['IntProperty','FloatProperty','BoolProperty','NameProperty','StrProperty'].includes(innerType);
  if (isShortPrim) {
    return `= <code>${escapeText(JSON.stringify(value.elements.map(stringifyForInline)))}</code>`;
  }
  const items = value.elements.map((e, i) => {
    if (innerType === 'StructProperty') {
      const sv = e;
      const inner = renderStructValue(sv, depth + 1);
      return `<div class="prop-row" style="padding-left:${(depth+1)*14}px;">
        <span class="prop-name">[${i}]</span>
        <span class="prop-val">${inner}</span></div>`;
    }
    return `<div class="prop-row" style="padding-left:${(depth+1)*14}px;">
      <span class="prop-name">[${i}]</span>
      <span class="prop-val">= <code>${escapeText(stringifyForInline(e))}</code></span></div>`;
  }).join('');
  return `<span class="muted">${escapeText(t('ui.tree.items', { count: value.elements.length }))}</span><div class="prop-children">${items}</div>`;
}

function renderSetValue(tag, value, depth) {
  const items = (value.elements || []).map((e, i) =>
    `<div class="prop-row" style="padding-left:${(depth+1)*14}px;">
      <span class="prop-name">{${i}}</span>
      <span class="prop-val">= <code>${escapeText(stringifyForInline(e))}</code></span></div>`).join('');
  return `<span class="muted">${escapeText(t('ui.tree.setItems', { count: (value.elements||[]).length }))}</span><div class="prop-children">${items}</div>`;
}

function renderMapValue(tag, value, depth) {
  const items = (value.entries || []).map((e, i) =>
    `<div class="prop-row" style="padding-left:${(depth+1)*14}px;">
      <span class="prop-name"><code>${escapeText(stringifyForInline(e.key))}</code></span>
      <span class="prop-val"> → <code>${escapeText(stringifyForInline(e.value))}</code></span></div>`).join('');
  return `<span class="muted">${escapeText(t('ui.tree.entries', { count: (value.entries||[]).length }))}</span><div class="prop-children">${items}</div>`;
}

function stringifyForInline(v) {
  if (v == null) return 'null';
  if (typeof v === 'object') {
    if (v._structName) return `${v._structName}(${JSON.stringify(v.value)})`;
    if (v.value !== undefined && v.number !== undefined) return formatFName(v);
    return JSON.stringify(v);
  }
  return String(v);
}

function wireDetailEditing(row, summary, decoded) {
  // text fields ----------
  const original = {};
  EDITABLE.forEach(f => original[f] = row[f] == null ? '' : String(row[f]));
  const inputs = $('detail').querySelectorAll('[id^="f_"]');
  const saveBtn = $('saveRow'); const revertBtn = $('revertRow');

  const checkChanged = () => {
    let any = false;
    inputs.forEach(inp => {
      const f = inp.id.slice(2);
      const div = inp.closest('.field');
      if (inp.value !== original[f]) { div.classList.add('changed'); any = true; }
      else div.classList.remove('changed');
    });
    saveBtn.disabled = !any;
    revertBtn.disabled = !any;
  };
  inputs.forEach(inp => inp.addEventListener('input', checkChanged));

  revertBtn.addEventListener('click', () => {
    inputs.forEach(inp => { inp.value = original[inp.id.slice(2)]; });
    checkChanged();
  });

  saveBtn.addEventListener('click', () => {
    const updates = {};
    for (const inp of inputs) {
      const f = inp.id.slice(2);
      if (inp.value === original[f]) continue;
      if (NUMERIC_FIELDS.has(f)) {
        const trimmed = inp.value.trim();
        const num = Number(trimmed);
        if (trimmed === '' || !Number.isFinite(num) || !Number.isInteger(num)) {
          alert(t('ui.alert.integerRequired', { field: f, value: JSON.stringify(inp.value) }));
          return;
        }
        updates[f] = num;
      } else {
        updates[f] = inp.value === '' ? null : inp.value;
      }
    }
    if (!Object.keys(updates).length) return;
    const cols = Object.keys(updates);
    try {
      db.exec({
        sql: `UPDATE actor_table SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE actor_serial = ?`,
        bind: [...cols.map(c => updates[c]), row.actor_serial],
      });
    } catch (e) { alert(t('ui.alert.updateFailed', { message: e.message })); return; }
    markDirty(); loadRows(); applyFilters(); selectRow(row.actor_serial);
  });

  // delete --------
  $('deleteRow').addEventListener('click', () => {
    if (!confirm(t('ui.alert.confirmDeleteRow', { serial: row.actor_serial }))) return;
    try { db.exec({ sql: 'DELETE FROM actor_table WHERE actor_serial = ?', bind: [row.actor_serial] }); }
    catch (e) { alert(t('ui.alert.deleteFailed', { message: e.message })); return; }
    markDirty();
    selectedSerial = null;
    $('detail').classList.add('hidden');
    $('main').classList.remove('with-detail');
    loadRows(); applyFilters();
  });

  // stash --------
  $('stashRow').addEventListener('click', () => {
    const personaName = SMDB.steam.displayName(row.actor_name);
    const defaultLabel = SMDB.steam.isSteamId64(row.actor_name)
      ? t('ui.stash.defaultPlayerLabel', { id: row.actor_name, suffix: personaName ? ' (' + personaName + ')' : '' })
      : t('ui.stash.defaultRowLabel', { serial: row.actor_serial, label: summary._label });
    const label = prompt(t('ui.stash.promptLabel'), defaultLabel);
    if (label === null) return;
    const entry = SMDB.stash.rowToStashEntry(row, { sourceFile: currentFileLabel, label });
    SMDB.stash.add(entry);
    updateChrome();
    setStatus(t('ui.status.stashed', { serial: row.actor_serial, label: entry.label }));
  });

  $('closeDetail').addEventListener('click', () => {
    selectedSerial = null;
    $('detail').classList.add('hidden');
    $('main').classList.remove('with-detail');
    renderTable();
  });

  // steam label --------
  if ($('steamLabel')) {
    const orig = SMDB.steam.getLabel(row.actor_name) || '';
    $('steamLabel').addEventListener('input', () => {
      $('saveSteamLabel').disabled = $('steamLabel').value === orig;
    });
    $('saveSteamLabel').addEventListener('click', () => {
      SMDB.steam.setLabel(row.actor_name, $('steamLabel').value);
      setStatus(t('ui.status.savedPersona', { id: row.actor_name }));
      // refresh table to show new label
      loadRows(); applyFilters();
      selectRow(row.actor_serial);
    });
  }

  // json blob editor --------
  if ($('jsonEditor') && decoded && decoded.kind === 'json-wrapped') {
    const origText = $('jsonEditor').value;
    const updateJsonChanged = () => {
      const changed = $('jsonEditor').value !== origText;
      $('saveJsonBlob').disabled = !changed;
      $('revertJsonBlob').disabled = !changed;
      // live parse check
      try { JSON.parse($('jsonEditor').value); $('jsonStatus').textContent = changed ? t('ui.blob.jsonOk') : ''; }
      catch (e) { $('jsonStatus').textContent = t('ui.blob.jsonParseError', { message: e.message }); }
    };
    $('jsonEditor').addEventListener('input', updateJsonChanged);
    $('revertJsonBlob').addEventListener('click', () => {
      $('jsonEditor').value = origText;
      updateJsonChanged();
    });
    $('saveJsonBlob').addEventListener('click', () => {
      let parsed;
      try { parsed = JSON.parse($('jsonEditor').value); }
      catch (e) { alert(t('ui.alert.jsonInvalid', { message: e.message })); return; }
      const newDecoded = { ...decoded, parsed, text: JSON.stringify(parsed) };
      const newBytes = SMDB.codecs.encode(newDecoded);
      try {
        db.exec({ sql: 'UPDATE actor_table SET actor_data = ? WHERE actor_serial = ?', bind: [newBytes, row.actor_serial] });
      } catch (e) { alert(t('ui.alert.updateFailed', { message: e.message })); return; }
      markDirty(); loadRows(); applyFilters(); selectRow(row.actor_serial);
    });
  }
}

// ============================================================
// STASH PANEL
// ============================================================

function openStash() {
  renderStashList();
  $('stashDialog').showModal();
}

function renderStashList() {
  const entries = SMDB.stash.list();
  const body = $('stashList');
  if (entries.length === 0) {
    body.innerHTML = `<div class="muted" style="padding:20px; text-align:center;">${escapeText(t('ui.stash.empty'))}</div>`;
    return;
  }
  body.innerHTML = entries.map(e => {
    const r = e.row;
    const blobInfo = r.actor_data_b64 ? fmtBytes(Math.floor(r.actor_data_b64.length * 0.75)) : t('ui.stash.noBlob');
    const isPlayer = SMDB.steam.isSteamId64(r.actor_name);
    const personaShown = isPlayer ? SMDB.steam.displayName(r.actor_name) : null;
    const personaSuffix = personaShown ? ` (${personaShown})` : '';
    const metaLine = t('ui.stash.metaLine', {
      source:  e.sourceFile || t('ui.stash.sourceUnknown'),
      savedAt: e.savedAt.replace('T', ' ').slice(0, 19),
      blob:    blobInfo,
      serial:  r._origSerial ?? '?',
    });
    return `
      <div class="stash-entry" data-id="${e.id}">
        <div class="stash-header">
          <div>
            <div class="stash-label">${escapeText(e.label)}${escapeText(personaSuffix)}</div>
            <div class="muted" style="font-size:11px;">
              ${escapeText(r.actor_script || t('ui.stash.noScript'))}
            </div>
            <div class="muted" style="font-size:11px;">${escapeText(metaLine)}</div>
            ${e.note ? `<div class="muted" style="font-size:11px; margin-top:2px;">${escapeText(t('ui.stash.noteLine', { note: e.note }))}</div>` : ''}
          </div>
          <div class="row-actions">
            <button class="stash-paste" ${db ? '' : `disabled title="${escapeAttr(t('ui.stash.pasteDisabled'))}"`}>${escapeText(t('ui.stash.paste'))}</button>
            <button class="stash-edit">${escapeText(t('ui.stash.edit'))}</button>
            <button class="stash-del danger">${escapeText(t('ui.stash.delete'))}</button>
          </div>
        </div>
      </div>`;
  }).join('');

  body.querySelectorAll('.stash-entry').forEach(el => {
    const id = el.dataset.id;
    el.querySelector('.stash-paste').addEventListener('click', () => pasteFromStash(id));
    el.querySelector('.stash-del').addEventListener('click', () => {
      if (confirm(t('ui.stash.confirmRemoveOne'))) { SMDB.stash.remove(id); renderStashList(); updateChrome(); }
    });
    el.querySelector('.stash-edit').addEventListener('click', () => editStashEntry(id));
  });
}

function editStashEntry(id) {
  const entry = SMDB.stash.get(id);
  if (!entry) return;
  const newLabel = prompt(t('ui.stash.editLabel'), entry.label);
  if (newLabel === null) return;
  const newNote = prompt(t('ui.stash.editNote'), entry.note || '');
  if (newNote === null) return;
  SMDB.stash.update(id, { label: newLabel, note: newNote });
  renderStashList();
}

// Actor names for spawned objects look like:
//   /Game/.../BP_DongWu_Yu_C_2146718976
// The trailing _<number> is the Unreal instance ID; renumbering means
// incrementing it until the resulting actor_name is free in the destination.
// System rows (GAME_SETTINGS, GAMEMODE) and player saves (Steam64 IDs) don't
// match this pattern, so renumber is unavailable for them.
function canRenumberActorName(name) {
  return /_\d+$/.test(name || '');
}

// Walk forward from the existing trailing number until we find an actor_name
// that doesn't collide in the destination DB. Exported so a future multi-row
// (base-copy) paste can reuse the same scheme.
function renumberActorName(name) {
  const m = (name || '').match(/^(.*_)(\d+)$/);
  if (!m) throw new Error(t('ui.alert.renumberNoSuffix'));
  const prefix = m[1];
  let num = parseInt(m[2], 10);
  for (let i = 0; i < 1_000_000; i++) {
    num++;
    const candidate = prefix + num;
    if (!db.selectValue('SELECT 1 FROM actor_table WHERE actor_name = ?', [candidate])) {
      return candidate;
    }
  }
  throw new Error(t('ui.alert.renumberExhausted'));
}

// Resolves to 'cancel' | 'replace' | 'renumber'. Escape / backdrop dismiss
// resolves to 'cancel'.
function showCollisionDialog({ name, existingSerial, isPlayerData, allowRenumber }) {
  return new Promise(resolve => {
    const dlg = $('collisionDialog');
    $('collisionMessage').textContent = t('ui.collision.message', { name, serial: existingSerial });
    let noteKey;
    if (isPlayerData)         noteKey = 'ui.collision.notePlayer';
    else if (allowRenumber)   noteKey = 'ui.collision.noteRenumberable';
    else                      noteKey = 'ui.collision.noteNoRenumber';
    $('collisionNote').textContent = t(noteKey);
    $('collisionRenumber').hidden = !allowRenumber;

    let result = 'cancel';
    const onCancel   = () => { result = 'cancel';   dlg.close(); };
    const onReplace  = () => { result = 'replace';  dlg.close(); };
    const onRenumber = () => { result = 'renumber'; dlg.close(); };
    const onClose    = () => {
      $('collisionCancel')  .removeEventListener('click', onCancel);
      $('collisionReplace') .removeEventListener('click', onReplace);
      $('collisionRenumber').removeEventListener('click', onRenumber);
      dlg.removeEventListener('close', onClose);
      resolve(result);
    };
    $('collisionCancel')  .addEventListener('click', onCancel);
    $('collisionReplace') .addEventListener('click', onReplace);
    $('collisionRenumber').addEventListener('click', onRenumber);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

async function pasteFromStash(id) {
  if (!db) { alert(t('ui.alert.loadDbFirst')); return; }
  const entry = SMDB.stash.get(id);
  if (!entry) return;

  // Destination DB owns server_id — stash never carries it across.
  const bindings = SMDB.stash.stashEntryToBindings(entry);
  bindings.server_id = currentServerId;

  const cols = [...SMDB.stash.ROW_COLUMNS, 'actor_data', 'server_id'];

  let existingSerial = null;
  if (bindings.actor_name) {
    existingSerial = db.selectValue(
      'SELECT actor_serial FROM actor_table WHERE actor_name = ?', [bindings.actor_name]);
  }

  if (existingSerial) {
    const isPlayerData = SMDB.classify.isPlayerRow(entry.row);
    const allowRenumber = !isPlayerData && canRenumberActorName(bindings.actor_name);
    const action = await showCollisionDialog({
      name: bindings.actor_name,
      existingSerial,
      isPlayerData,
      allowRenumber,
    });

    if (action === 'cancel') return;

    if (action === 'replace') {
      try {
        db.exec({
          sql: `UPDATE actor_table SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE actor_serial = ?`,
          bind: [...cols.map(c => bindings[c]), existingSerial],
        });
      } catch (e) { alert(t('ui.alert.replaceFailed', { message: e.message })); return; }
      markDirty(); loadRows(); applyFilters();
      setStatus(t('ui.status.replacedFromStash', { serial: existingSerial, label: entry.label }));
      selectRow(existingSerial);
      $('stashDialog').close();
      return;
    }

    // action === 'renumber' — fall through to INSERT with a fresh actor_name.
    try {
      bindings.actor_name = renumberActorName(bindings.actor_name);
    } catch (e) { alert(t('ui.alert.renumberFailed', { message: e.message })); return; }
  }

  try {
    db.exec({
      sql: `INSERT INTO actor_table (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      bind: cols.map(c => bindings[c]),
    });
  } catch (e) { alert(t('ui.alert.insertFailed', { message: e.message })); return; }
  const newSerial = db.selectValue('SELECT last_insert_rowid()');
  markDirty(); loadRows(); applyFilters();
  const statusKey = existingSerial ? 'ui.status.pastedRenumbered' : 'ui.status.pastedAsNew';
  setStatus(t(statusKey, { label: entry.label, serial: newSerial, name: bindings.actor_name }));
  selectRow(newSerial);
  $('stashDialog').close();
}

function exportStashFile() {
  const blob = SMDB.stash.exportToBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url; a.download = `soulmaskdb-stash.${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function importStashFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const result = SMDB.stash.importFromJson(reader.result, { mode: 'merge' });
      setStatus(t('ui.status.imported', { count: result.imported, total: result.total }));
      renderStashList(); updateChrome();
    } catch (e) { alert(t('ui.alert.importFailed', { message: e.message })); }
  };
  reader.readAsText(file);
}

// ============================================================
// CODEC ROUND-TRIP SELF-TEST
// ============================================================

/**
 * Iterate every actor_data blob, run the unreal-properties codec through
 * decode+encode, and compare to the original. Reports counts and lists
 * failures with serial + tail of the path that broke.
 *
 * Yields control to the browser every batch so the page stays responsive
 * on 12K-row DBs.
 */
async function runVerifyAll() {
  if (!db) return;
  $('verifyDialog').showModal();
  $('verifySummary').textContent = t('ui.verify.loadingBlobs');
  $('verifyFailures').innerHTML = '';

  const rows = [];
  db.exec({
    sql: `SELECT actor_serial, actor_script, actor_data
          FROM actor_table
          WHERE actor_data IS NOT NULL AND length(actor_data) > 0
          ORDER BY actor_serial`,
    rowMode: 'object',
    resultRows: rows,
  });

  let ok = 0, fail = 0, skipped = 0;
  const failures = [];
  const BATCH = 200;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const codec = SMDB.codecs.detect(r.actor_data);
    if (!codec || codec.name !== 'unreal-properties') { skipped++; continue; }
    const res = SMDB.codecUnrealProperties.verifyRoundTrip(r.actor_data);
    if (res.ok) ok++;
    else {
      fail++;
      failures.push({ serial: r.actor_serial, script: r.actor_script, reason: res.reason });
    }
    if (i % BATCH === 0) {
      $('verifySummary').innerHTML = t('ui.verify.progress', {
        done:    i.toLocaleString(),
        total:   rows.length.toLocaleString(),
        ok:      `<span style="color:var(--ok);">${ok}</span>`,
        fail:    `<span class="danger">${fail}</span>`,
        skipped,
      });
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const passRate = rows.length > 0 ? ((ok / (ok + fail || 1)) * 100).toFixed(2) : '0';
  const summaryHtml = t('ui.verify.doneSummary', {
    ok:      `<span style="color:var(--ok);">✓ ${ok.toLocaleString()}</span>`,
    fail:    `<span class="danger">✗ ${fail.toLocaleString()}</span>`,
    skipped: skipped.toLocaleString(),
    pass:    passRate,
  });
  $('verifySummary').innerHTML = `
    <div style="margin-bottom:6px;"><strong>${escapeText(t('ui.verify.doneHeading', { total: rows.length.toLocaleString() }))}</strong></div>
    <div>${summaryHtml}</div>`;

  // Show first 200 failures grouped by root-cause-ish prefix.
  const shown = failures.slice(0, 200);
  const moreCount = failures.length - shown.length;
  $('verifyFailures').innerHTML = shown.map(f => `
    <div class="verify-fail">
      <span class="ser">#${f.serial}</span>
      <span class="muted">${escapeText((f.script || '').replace(/.*[./]/, '').replace(/_C$/, ''))}</span>
      <div class="reason">${escapeText(f.reason)}</div>
    </div>`).join('') + (moreCount > 0 ? `<div class="muted" style="padding:8px 14px;">${escapeText(t('ui.verify.moreFailures', { count: moreCount }))}</div>` : '');
}

// ============================================================
// SCRIPTS DIAGNOSTIC
// ============================================================
//
// Browse distinct actor_script values in the loaded DB, see which kind
// each maps to, and copy the ones still landing in 'other' back as input
// for new rules in SMDB.classify.RULES.

let scriptsUnmappedOnly = false;

function openScriptsDialog() {
  if (!db) return;
  scriptsUnmappedOnly = $('scriptsFilterUnmapped').checked;
  renderScriptsList();
  $('scriptsDialog').showModal();
}

function renderScriptsList() {
  const all = SMDB.classify.aggregateScripts(allRows);
  const unmappedCount = all.filter(s => s.kind === 'other').length;
  const shown = (scriptsUnmappedOnly ? all.filter(s => s.kind === 'other') : all)
    .slice()
    .sort((a, b) => {
      // 'other' first within the current view, then count desc.
      if ((a.kind === 'other') !== (b.kind === 'other')) return a.kind === 'other' ? -1 : 1;
      return b.count - a.count;
    });

  $('scriptsSummary').textContent = t('ui.scripts.summary', {
    distinct: all.length.toLocaleString(),
    unmapped: unmappedCount.toLocaleString(),
  });
  $('scriptsCopyUnmapped').disabled = unmappedCount === 0;

  const body = $('scriptsList');
  if (shown.length === 0) {
    body.innerHTML = `<div class="muted" style="padding:20px; text-align:center;">${escapeText(t('ui.scripts.empty'))}</div>`;
    return;
  }
  body.innerHTML = `
    <table>
      <thead><tr>
        <th style="text-align:right;">${escapeText(t('ui.scripts.headerCount'))}</th>
        <th>${escapeText(t('ui.scripts.headerKind'))}</th>
        <th>${escapeText(t('ui.scripts.headerScript'))}</th>
      </tr></thead>
      <tbody>${shown.map(s => `
        <tr>
          <td class="count">${s.count.toLocaleString()}</td>
          <td class="kind"><span class="pill ${s.kind}">${escapeText(t('ui.kind.' + s.kind, { default: s.kind }))}</span></td>
          <td>${escapeText(s.script || t('ui.scripts.noScript'))}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

async function copyUnmappedScripts() {
  const all = SMDB.classify.aggregateScripts(allRows);
  const unmapped = all.filter(s => s.kind === 'other').sort((a, b) => b.count - a.count);
  if (unmapped.length === 0) return;
  // Plain text, "<count>\t<script>" per line — readable and machine-parseable.
  const text = unmapped.map(s => `${s.count}\t${s.script}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('scriptsCopyStatus').textContent = t('ui.scripts.copiedCount', { count: unmapped.length });
  } catch (e) {
    $('scriptsCopyStatus').textContent = t('ui.scripts.copyFailed', { message: e.message });
  }
  setTimeout(() => { $('scriptsCopyStatus').textContent = ''; }, 4000);
}

// ============================================================
// DOWNLOAD
// ============================================================

function downloadDB() {
  if (!db) return;
  setStatus(t('ui.status.serializing'));
  const out = sqlite3.capi.sqlite3_js_db_export(db.pointer);
  const blob = new Blob([out], { type: 'application/x-sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `world.modified.${stamp}.db`;
  document.body.appendChild(a);
  a.click(); a.remove();
  URL.revokeObjectURL(url);
  dirty = false;
  updateChrome();
  setStatus(t('ui.status.exported', { size: fmtBytes(out.byteLength) }));
}

// ============================================================
// WIRE-UP
// ============================================================

$('fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) loadFile(f).catch(err => { console.error(err); alert(err.message); });
});

$('search').addEventListener('input', debounce(applyFilters, 200));
$('kindFilter').addEventListener('change', applyFilters);
$('downloadBtn').addEventListener('click', downloadDB);

$('verifyAllBtn').addEventListener('click', runVerifyAll);
$('verifyClose').addEventListener('click', () => $('verifyDialog').close());

$('scriptsBtn').addEventListener('click', openScriptsDialog);
$('scriptsClose').addEventListener('click', () => $('scriptsDialog').close());
$('scriptsFilterUnmapped').addEventListener('change', () => {
  scriptsUnmappedOnly = $('scriptsFilterUnmapped').checked;
  renderScriptsList();
});
$('scriptsCopyUnmapped').addEventListener('click', copyUnmappedScripts);

$('steamCacheBtn').addEventListener('click', () => {
  const n = SMDB.steam.cacheCount();
  if (n === 0) return;
  if (confirm(t('ui.alert.confirmClearSteam', { count: n }))) {
    SMDB.steam.clearCache();
    updateChrome();
    if (db) renderTable();
  }
});

$('stashBtn').addEventListener('click', openStash);
$('stashClose').addEventListener('click', () => $('stashDialog').close());
$('stashExport').addEventListener('click', exportStashFile);
$('stashImportInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) importStashFile(f);
  e.target.value = '';
});
$('stashClear').addEventListener('click', () => {
  const n = SMDB.stash.count();
  if (n === 0) return;
  if (confirm(t('ui.stash.confirmClear', { count: n }))) {
    SMDB.stash.clear(); renderStashList(); updateChrome();
  }
});

window.addEventListener('beforeunload', e => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---- i18n boot ---------------------------------------------------------
// Apply translations to the static DOM, then populate the language switcher.
SMDB.i18n.applyToDom();
(() => {
  const sel = $('langSelect');
  const cur = SMDB.i18n.currentLocale;
  for (const code of SMDB.i18n.availableLocales()) {
    const name = (window.SMDB_LOCALES[code] && window.SMDB_LOCALES[code]._displayName) || code;
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    if (code === cur) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => SMDB.i18n.setLocale(sel.value));
  document.documentElement.lang = cur;
})();

bootSqlite().catch(e => setStatus(t('ui.status.sqliteInitFailed', { message: e.message })));
updateChrome();
