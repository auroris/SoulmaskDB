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
// UI STATE + ORCHESTRATOR
// ============================================================

// The orchestrator owns the file-load lifecycle (sqlite init, blob
// indexing, server-id detection). app.js keeps the UI-side canonical row
// list and per-page render state — those move with the UI component
// refactor, not this one.
let allRows = [];
let filtered = [];
let currentPage = 0;
const PAGE_SIZE = 200;
let selectedSerial = null;
let dirty = false;
let currentFileLabel = null;
// server_id detected from the loaded DB. Used when pasting from stash so
// inserted rows belong to this server, not whichever server the stash was
// captured from. Set on the orchestrator's 'rows-ready' event.
let currentServerId = null;
// Spatial anchor — when set, applyFilters keeps only rows whose transform
// is within rangeMeters of pos and sorts ascending by distance. Rows
// without a parseable transform drop out while anchored. Cleared on DB
// (re)load because positions are world-specific.
let spatialAnchor = null;  // { serial, label, pos, rangeMeters }

const setStatus = msg => { $('status').textContent = msg || ''; };

// Construct the orchestrator and the data service at module-load.
// bootstrap.mjs has finished its TLA chain by now AND all classic defer
// scripts (classify, i18n, steam, stash, partials, locale/*) have
// completed, so SMDB.classify is populated. Constructing here (rather
// than earlier in bootstrap.mjs) avoids a cache-warm race where the lz4
// wasm TLA resolves before the defer queue advances.
SMDB.orchestrator = new SMDB.Orchestrator({
  sqliteService: SMDB.sqliteService,
  workerService: SMDB.workerService,
  searchService: SMDB.search,
  classify:      SMDB.classify,
});
SMDB.data = new SMDB.DataService({
  sqliteService: SMDB.sqliteService,
  orchestrator:  SMDB.orchestrator,
});
SMDB.data.init();

// Shorthand for the rest of this file. Always returns the *current*
// handle (or null), so callers automatically see the new DB after a
// fresh load and stale handles never linger.
const getDb = () => SMDB.orchestrator.db();

// Wire the orchestrator's file-load events to the UI. 'rows-ready'
// happens BEFORE blob decoding finishes — that's the point of the
// non-blocking design — so the table renders immediately on SQL columns
// and the SearchService listener (set up in the wire-up section
// below) re-applies the filter as decode batches stream in.
SMDB.orchestrator.addListener((event, data) => {
  if (event === 'rows-ready') {
    allRows         = data.rows;
    currentServerId = data.serverId;
    currentFileLabel = data.label;
    dirty           = false;
    selectedSerial  = null;
    spatialAnchor   = null;
    renderAnchorChip();
    $('detail').classList.add('hidden');
    $('main').classList.remove('with-detail');
    updateChrome();
    applyFilters();
    setStatus(t('ui.status.loaded',
      { file: data.label, count: data.rows.length.toLocaleString() }));
    resolvePlayerNames();
  } else if (event === 'load-error') {
    setStatus('');
    alert(t('ui.alert.notSoulmaskDB', { file: data.label }));
  }
});

// SMDB.data (DataService) owns the file-upload lifecycle: drag-drop,
// validation, the file list dialog, and the trigger that calls into
// orchestrator.loadFile when the user clicks Switch To. This module just
// subscribes to the orchestrator's 'rows-ready' / 'load-error' events
// (set up above) and the data service's 'unloaded' event (set up below).

// When the active DB is removed via the data dialog, clear UI state and
// reopen the dialog so the user can pick another file.
SMDB.data.addListener((event /*, data */) => {
  if (event !== 'unloaded') return;
  allRows = [];
  filtered = [];
  currentServerId = null;
  currentFileLabel = null;
  dirty = false;
  selectedSerial = null;
  spatialAnchor = null;
  renderAnchorChip();
  $('detail').classList.add('hidden');
  $('main').classList.remove('with-detail');
  updateChrome();
  applyFilters();
  setStatus('');
  SMDB.data.maybeAutoOpen();
});

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

/**
 * Re-index a single row after a SQL/blob edit (or remove it after a
 * delete) AND keep `allRows` in sync with what the orchestrator/search
 * service see. The orchestrator handles the DB read + search-index
 * update; app.js owns `allRows` until the UI refactor moves that.
 */
function reindexRow(serial) {
  const newRow = SMDB.orchestrator.reindexRow(serial);
  if (!newRow) {
    // Deleted at the DB layer — drop from local state too.
    allRows = allRows.filter(r => r.actor_serial !== serial);
    return;
  }
  const idx = allRows.findIndex(r => r.actor_serial === serial);
  if (idx >= 0) {
    allRows[idx] = newRow;
  } else {
    // New row (stash paste) — insert at the right serial-sorted position.
    let insertAt = allRows.length;
    for (let i = 0; i < allRows.length; i++) {
      if (allRows[i].actor_serial > serial) { insertAt = i; break; }
    }
    allRows.splice(insertAt, 0, newRow);
  }
}

function getRowDetail(serial) {
  const db = getDb();
  if (!db) return undefined;
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
  const db = getDb();
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
    // SQL-column matches are always available. The blob-text match goes
    // through SMDB.search, which returns false for rows that haven't
    // been indexed yet — those rows simply won't blob-match until their
    // batch lands. SearchService fires a re-render via its listener.
    return (r.actor_script || '').toLowerCase().includes(q)
        || (r.actor_name   || '').toLowerCase().includes(q)
        || (r.actor_owner  || '').toLowerCase().includes(q)
        || (r._summary     || '').toLowerCase().includes(q)
        || SMDB.search.matches(r.actor_serial, q);
  });
  applySpatialAnchor();
  currentPage = 0;
  renderTable();
}

// When an anchor is set, mutate `filtered` to keep only rows with a
// parseable transform within rangeMeters of the anchor, sorted ascending
// by distance. Stamps `_spatialDist` (meters) on surviving rows so the
// table render can show a distance column without recomputing. Clears
// stale `_spatialDist` from any row that survived the previous anchor
// but no longer applies.
function applySpatialAnchor() {
  if (!spatialAnchor) {
    for (const r of allRows) r._spatialDist = undefined;
    return;
  }
  const range = spatialAnchor.rangeMeters;
  const withinRange = [];
  for (const r of allRows) r._spatialDist = undefined;
  for (const r of filtered) {
    const tx = SMDB.classify.parseTransform(r.actor_transf);
    if (!tx) continue;
    const d = SMDB.classify.distanceMeters(tx, spatialAnchor.pos);
    if (d == null || d > range) continue;
    r._spatialDist = d;
    withinRange.push(r);
  }
  withinRange.sort((a, b) => a._spatialDist - b._spatialDist);
  filtered = withinRange;
}

function renderTable() {
  const start = currentPage * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  const thead = $('rowsTable').querySelector('thead');
  const tbody = $('rowsTable').querySelector('tbody');

  const anchored = !!spatialAnchor;
  const distHeader = anchored ? `<th>${escapeText(t('ui.tableHeader.distance'))}</th>` : '';

  thead.innerHTML = `
    <tr>
      <th>${escapeText(t('ui.tableHeader.serial'))}</th>
      ${distHeader}
      <th>${escapeText(t('ui.tableHeader.kind'))}</th>
      <th>${escapeText(t('ui.tableHeader.class'))}</th>
      <th>${escapeText(t('ui.tableHeader.summary'))}</th>
      <th>${escapeText(t('ui.tableHeader.owner'))}</th>
      <th>${escapeText(t('ui.tableHeader.blob'))}</th>
      <th>${escapeText(t('ui.tableHeader.time'))}</th>
    </tr>`;

  if (slice.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${anchored ? 8 : 7}" class="muted" style="padding: 16px;">${escapeText(t('ui.tableEmpty'))}</td></tr>`;
  } else {
    tbody.innerHTML = slice.map(r => {
      const nameLabel = SMDB.steam.isSteamId64(r.actor_name) ? steamShortLabel(r.actor_name) : '';
      const labelHtml = nameLabel
        ? `${escapeText(r._label)} <span class="muted">— ${escapeText(nameLabel)}</span>`
        : escapeText(r._label);
      const distCell = anchored
        ? `<td class="muted">${r._spatialDist != null ? r._spatialDist.toFixed(1) + ' m' : ''}</td>`
        : '';
      return `
      <tr data-serial="${r.actor_serial}" class="${r.actor_serial === selectedSerial ? 'selected' : ''}">
        <td>${r.actor_serial}</td>
        ${distCell}
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

// Toggle the anchor chip in #controls. When `spatialAnchor` is non-null,
// shows a label + editable x/y/z position inputs + range (meters) + clear.
// Editing position decouples the anchor from its source row (clears
// .serial) so the row's "⚓ anchored" indicator reverts. Position/range
// edits debounce into applyFilters.
function renderAnchorChip() {
  const chip = $('anchorChip');
  if (!chip) return;
  if (!spatialAnchor) {
    chip.classList.add('hidden');
    chip.innerHTML = '';
    return;
  }
  chip.classList.remove('hidden');
  const labelText = spatialAnchor.serial != null
    ? t('ui.anchor.label', { serial: spatialAnchor.serial, label: spatialAnchor.label })
    : t('ui.anchor.customLabel');
  chip.innerHTML = `
    <span class="anchor-label">${escapeText(labelText)}</span>
    <label>x <input id="anchorPosX" type="number" step="any" value="${spatialAnchor.pos[0]}" style="width:80px;"></label>
    <label>y <input id="anchorPosY" type="number" step="any" value="${spatialAnchor.pos[1]}" style="width:80px;"></label>
    <label>z <input id="anchorPosZ" type="number" step="any" value="${spatialAnchor.pos[2]}" style="width:80px;"></label>
    <label>${escapeText(t('ui.anchor.range'))}
      <input id="anchorRange" type="number" min="0" step="10" value="${spatialAnchor.rangeMeters}" style="width:70px;"> m
    </label>
    <button id="anchorClear" title="${escapeAttr(t('ui.anchor.clear'))}">×</button>
  `;
  const onPosInput = debounce(() => {
    const x = Number($('anchorPosX').value);
    const y = Number($('anchorPosY').value);
    const z = Number($('anchorPosZ').value);
    if (![x, y, z].every(Number.isFinite)) return;
    spatialAnchor.pos = [x, y, z];
    // Editing pos decouples from the source row.
    if (spatialAnchor.serial != null) {
      spatialAnchor.serial = null;
      spatialAnchor.label = t('ui.anchor.customLabel');
      const lbl = $('anchorChip').querySelector('.anchor-label');
      if (lbl) lbl.textContent = spatialAnchor.label;
      if (selectedSerial != null) selectRow(selectedSerial);
    }
    applyFilters();
  }, 250);
  $('anchorPosX').addEventListener('input', onPosInput);
  $('anchorPosY').addEventListener('input', onPosInput);
  $('anchorPosZ').addEventListener('input', onPosInput);
  $('anchorRange').addEventListener('input', debounce(() => {
    const v = Number($('anchorRange').value);
    if (Number.isFinite(v) && v >= 0) {
      spatialAnchor.rangeMeters = v;
      applyFilters();
    }
  }, 150));
  $('anchorClear').addEventListener('click', () => {
    const wasSerial = spatialAnchor.serial;
    spatialAnchor = null;
    renderAnchorChip();
    applyFilters();
    // If the previously-anchored row is currently open in the detail
    // panel, re-render it so the anchor button label flips back.
    if (selectedSerial === wasSerial) selectRow(selectedSerial);
  });
}

// Create a custom (no-source-row) anchor at the origin so the user can
// type coords into the chip. If an anchor already exists, leave its pos
// alone and just focus the X input — letting the user re-target the
// existing anchor's location is the more common case.
function openCustomAnchor() {
  if (!spatialAnchor) {
    spatialAnchor = {
      serial: null,
      label: t('ui.anchor.customLabel'),
      pos: [0, 0, 0],
      rangeMeters: 100,
    };
    renderAnchorChip();
    applyFilters();
  }
  setTimeout(() => {
    const el = $('anchorPosX');
    if (el) { el.focus(); el.select(); }
  }, 0);
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
  const blob = row.actor_data;
  const blobLen = blob ? blob.length : 0;
  const decoded = blob ? SMDB.codecs.decode(blob) : null;
  const ctx = buildPartialCtx(row, summary, decoded);

  // ---- editable fields ----
  // Each field consults the partials registry: if a field partial claims
  // it, the partial supplies the input element (e.g. a <select> for
  // PlayerLevel actor_level). Otherwise we fall back to the default
  // input/textarea. The element MUST have id `f_<field>` so the generic
  // dirty/save/revert loop in wireDetailEditing picks it up uniformly.
  const fieldsHtml = EDITABLE.map(f => {
    const fp = SMDB.partials.fieldFor(row, decoded, f);
    const inputHtml = fp ? fp.renderField(ctx, f) : defaultFieldInput(row, f);
    const hint = FIELD_HINTS[f] ? ` <span class="muted" style="font-size:11px;">(${FIELD_HINTS[f]})</span>` : '';
    return `<div class="field" data-field="${f}"><label>${f}${hint}</label>${inputHtml}</div>`;
  }).join('');

  // ---- section partials -----------------------------------------------
  // preFields slot (between header and editable fields): Steam, …
  // postFields slot (between editable fields and blob): Transform, …
  const preFieldsHtml  = SMDB.partials.sectionsFor(row, decoded, 'preFields') .map(p => p.render(ctx)).join('');
  const postFieldsHtml = SMDB.partials.sectionsFor(row, decoded, 'postFields').map(p => p.render(ctx)).join('');

  // ---- blob panel via codecs ----
  const blobHtml = blobLen === 0 ? `<div class="muted">${escapeText(t('ui.detail.noBlob'))}</div>` : renderBlobByCodec(decoded, row.actor_serial);

  $('detail').innerHTML = `
    <div class="detail-section">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0;">${escapeText(t('ui.detail.rowHeading', { serial: row.actor_serial }))} <span class="pill ${summary._kind}">${escapeText(t('ui.kind.' + summary._kind, {default: summary._kind}))}</span></h3>
        <button id="closeDetail">${escapeText(t('ui.detail.close'))}</button>
      </div>
      <div class="muted" style="margin-top:6px;">${escapeText(summary._label)}</div>
      <div class="muted">${escapeText(summary._summary)}</div>
    </div>

    ${preFieldsHtml}

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

    ${postFieldsHtml}

    <div class="detail-section">
      <h3>${escapeText(t('ui.detail.blobHeading', { size: fmtBytes(blobLen), codec: decoded ? decoded.kind : t('ui.detail.blobNone') }))}</h3>
      ${blobHtml}
    </div>`;

  // Wire section partials (their internal listeners) after innerHTML lands.
  // Field partials don't need explicit wiring — the dirty/save/revert loop
  // in wireDetailEditing handles them via the `f_<field>` id convention.
  SMDB.partials.sectionsFor(row, decoded, 'preFields') .forEach(p => p.wire && p.wire(ctx));
  SMDB.partials.sectionsFor(row, decoded, 'postFields').forEach(p => p.wire && p.wire(ctx));

  wireDetailEditing(row, summary, decoded);
}

// Default input element for an editable column when no field partial claims
// it. Mirrors today's flat input/textarea rules and is what the partials
// system falls back to.
function defaultFieldInput(row, f) {
  const v = row[f] == null ? '' : String(row[f]);
  const tag = (f === 'actor_name' || f === 'actor_script' || f === 'actor_transf') ? 'textarea' : 'input';
  return tag === 'textarea'
    ? `<textarea id="f_${f}" rows="2">${escapeText(v)}</textarea>`
    : `<input id="f_${f}" value="${escapeAttr(v)}"${NUMERIC_FIELDS.has(f) ? ' inputmode="numeric"' : ''}>`;
}

// Build the context object passed to every partial's render/wire phase.
// Closes over the current row, summary, decoded blob, and the module-local
// state partials might need to read or mutate (spatialAnchor, Steam labels).
// Exposed-on-ctx helpers keep partial files independent of app.js internals.
function buildPartialCtx(row, summary, decoded) {
  return {
    row, summary, decoded,
    t,
    escapeText, escapeAttr,
    fieldId: name => `f_${name}`,
    // Look up another row by serial (returns the lightweight `allRows`
    // entry — no blob — or null). Partials that need the raw blob should
    // call ctx.lookupRowDetail(serial) instead.
    lookupRow(serial) {
      return allRows.find(r => r.actor_serial === serial) || null;
    },
    lookupRowDetail: getRowDetail,
    allRowsIter() { return allRows; },
    navigate(serial) {
      const target = allRows.find(r => r.actor_serial === serial);
      if (target) selectRow(serial);
    },
    spatial: {
      get isAnchored() { return !!spatialAnchor && spatialAnchor.serial === row.actor_serial; },
      setRowAsAnchor() {
        const tx2 = SMDB.classify.parseTransform(row.actor_transf);
        if (!tx2) { alert(t('ui.alert.anchorNoTransform')); return; }
        spatialAnchor = {
          serial: row.actor_serial,
          label:  summary._label || ('#' + row.actor_serial),
          pos:    tx2.pos,
          rangeMeters: spatialAnchor ? spatialAnchor.rangeMeters : 100,
        };
        renderAnchorChip();
        applyFilters();
        selectRow(row.actor_serial);
      },
    },
    steam: {
      saveLabel(value) {
        SMDB.steam.setLabel(row.actor_name, value);
        setStatus(t('ui.status.savedPersona', { id: row.actor_name }));
        reindexRow(row.actor_serial); applyFilters(); selectRow(row.actor_serial);
      },
    },
  };
}

function renderBlobByCodec(decoded, serial) {
  if (!decoded) return `<div class="muted">${escapeText(t('ui.detail.noBlob'))}</div>`;
  if (decoded.kind === 'json-wrapped')      return renderJsonBlob(decoded, serial);
  if (decoded.kind === 'unreal-properties') return renderUnrealProperties(decoded);
  // Unknown / empty: show the first bytes inline since there's no
  // structured view to render in their place.
  if (decoded._raw) {
    const header = Array.from(decoded._raw.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    return `
      <div class="muted">${escapeText(t('ui.blob.unknownFormat', { header }))}</div>
      <pre class="hex">${escapeText(hexDump(decoded._raw, 0, 4096))}</pre>`;
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
    </div>`;
}

function renderUnrealProperties(decoded) {
  const errorBanner = decoded.error
    ? `<div class="danger" style="margin-bottom:8px;">${escapeText(t('ui.blob.parseError', { message: decoded.error }))}</div>`
    : '';

  const trailing = decoded.bodyTrailing && decoded.bodyTrailing.length > 0
    ? `<div class="muted" style="margin-bottom:8px;">${decoded.bodyTrailing.length} bytes trailing after None terminator</div>`
    : '';

  const props = decoded.properties || [];
  const propsHeading = `<div class="prop-tree-heading muted">${escapeText(t('ui.blob.properties', { count: props.length }))}</div>`;
  const treeHtml = props.length === 0
    ? `<div class="muted">${escapeText(t('ui.tree.empty'))}</div>`
    : `<div class="prop-tree">${props.map((p, i) => renderPropertyEntry(p, i, 0)).join('')}</div>`;

  return `
    ${errorBanner}
    ${trailing}
    ${propsHeading}
    ${treeHtml}
  `;
}

// ---- structured-tree rendering -----------------------------------------
//
// Value renderers all return `{ inline, children }`:
//   inline   HTML fragment shown after the property name on the same row
//   children HTML fragment (one row per child) shown indented below, or
//            '' for leaf values.
//
// renderPropertyEntry decides on markup: leaf rows are plain <div>s,
// rows with children become <details><summary>row</summary>…</details>.
// The native <details> toggle gives expand/collapse for free; CSS in
// index.html turns the default marker into a chevron and hides it for
// leaves so the name column aligns across both shapes.

function renderPropertyEntry(prop, idx, depth) {
  // Local var name MUST NOT be `t` — that's the file-scope i18n alias and
  // the size-mismatch branch below needs it. (renderValue() solves the
  // same shadowing problem by using `propType`.)
  const tag = prop.tag;
  const typeStr = propertyTypeLabel(tag);
  const nameStr = formatFName(tag.name) + (tag.arrayIndex ? `[${tag.arrayIndex}]` : '');
  const { inline, children } = renderValue(tag, prop.value, depth);
  const sizeWarn = prop._sizeMismatch
    ? ` <span class="danger" title="${escapeAttr(t('ui.tree.sizeMismatchTitle'))}">⚠</span>`
    : '';
  const guidLine = tag.hasPropertyGuid ? ` <span class="muted">{${tag.propertyGuid}}</span>` : '';
  const head = `<span class="prop-chevron"></span><span class="prop-name">${escapeText(nameStr)}</span><span class="prop-type muted">: ${escapeText(typeStr)}${guidLine}${sizeWarn}</span><span class="prop-val">${inline}</span>`;
  const pad = `padding-left:${depth * 14}px;`;
  if (children) {
    return `<details class="prop-node" open><summary class="prop-row" style="${pad}">${head}</summary><div class="prop-children">${children}</div></details>`;
  }
  return `<div class="prop-row" style="${pad}">${head}</div>`;
}

// Synthetic row for array indices, set members, and map keys: same markup
// as renderPropertyEntry but no type/guid/size columns. Takes a fully
// pre-rendered name string and the same {inline, children} pair.
function renderSyntheticRow(nameHtml, inline, children, depth) {
  const head = `<span class="prop-chevron"></span><span class="prop-name">${nameHtml}</span><span class="prop-val">${inline}</span>`;
  const pad = `padding-left:${depth * 14}px;`;
  if (children) {
    return `<details class="prop-node" open><summary class="prop-row" style="${pad}">${head}</summary><div class="prop-children">${children}</div></details>`;
  }
  return `<div class="prop-row" style="${pad}">${head}</div>`;
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

// Helper for leaf returns to keep the call sites short.
const leaf = inline => ({ inline, children: '' });

function renderValue(tag, value, depth) {
  const propType = tag.type.value;  // local var (shadows file-scope `t` i18n alias)
  if (value && value._opaque) {
    return leaf(`<span class="muted">${escapeText(SMDB.i18n.t('ui.tree.opaque', { bytes: value._opaque.length, reason: value._opaqueReason || '?' }))}</span>`);
  }
  switch (propType) {
    case 'IntProperty': case 'Int8Property': case 'Int16Property':
    case 'UInt16Property': case 'UInt32Property':
      return leaf(`= <code>${value}</code>`);
    case 'Int64Property': case 'UInt64Property':
      return leaf(`= <code>${escapeText(String(value))}</code>`);
    case 'FloatProperty': case 'DoubleProperty':
      return leaf(`= <code>${Number(value).toPrecision(7)}</code>`);
    case 'BoolProperty':
      return leaf(`= <code>${value}</code>`);
    case 'StrProperty':
      return leaf(`= <code>${escapeText(JSON.stringify(value))}</code>`);
    case 'NameProperty':
      return leaf(`= <code>${escapeText(formatFName(value))}</code>`);
    case 'ObjectProperty': case 'ClassProperty':
    case 'WeakObjectProperty': case 'LazyObjectProperty':
    case 'WSObjectProperty': {
      // Plain string = just a path; object = path + embedded property stream
      // (Soulmask serializes the referenced object's data inline).
      if (typeof value === 'string') return leaf(`→ <code>${escapeText(value)}</code>`);
      const pathHtml = `→ <code>${escapeText(value.path)}</code>`;
      if (!value.embedded || value.embedded.length === 0) return leaf(pathHtml);
      const inner = value.embedded.map((p, i) => renderPropertyEntry(p, i, depth + 1)).join('');
      return { inline: pathHtml, children: inner };
    }
    case 'SoftObjectProperty': case 'SoftClassProperty':
      return leaf(`→ <code>${escapeText(value.assetPath)}${value.subPath ? ':' + escapeText(value.subPath) : ''}</code>`);
    case 'ByteProperty':
      return leaf(tag.enumName.value === 'None'
        ? `= <code>${value}</code>`
        : `= <code>${escapeText(formatFName(value))}</code>`);
    case 'EnumProperty':
      return leaf(`= <code>${escapeText(formatFName(value))}</code>`);
    case 'StructProperty':
      return renderStructValue(value, depth);
    case 'ArrayProperty':
      return renderArrayValue(tag, value, depth);
    case 'SetProperty':
      return renderSetValue(tag, value, depth);
    case 'MapProperty':
      return renderMapValue(tag, value, depth);
    case 'TextProperty':
      return leaf(`<span class="muted">${escapeText(SMDB.i18n.t('ui.tree.text', { bytes: value && value._opaque ? value._opaque.length : 0 }))}</span>`);
    default:
      return leaf(`<span class="muted">${escapeText(SMDB.i18n.t('ui.tree.value', { type: propType }))}</span>`);
  }
}

function renderStructValue(sv, depth) {
  if (!sv) return leaf(`<span class="muted">${escapeText(t('ui.tree.emptyStruct'))}</span>`);
  const name = sv._structName;
  // Known-binary struct: render compactly.
  if (SMDB.unreal.STRUCT_HANDLERS[name]) {
    return leaf(`= <code>${escapeText(JSON.stringify(sv.value))}</code>`);
  }
  if (sv._structDecodeError) {
    return leaf(`<span class="danger">${escapeText(t('ui.tree.structDecodeError', { message: sv._structDecodeError }))}</span>`);
  }
  if (!Array.isArray(sv.value) || sv.value.length === 0) {
    return leaf(`<span class="muted">${escapeText(t('ui.tree.empty'))}</span>`);
  }
  const inner = sv.value.map((p, i) => renderPropertyEntry(p, i, depth + 1)).join('');
  return { inline: '', children: inner };
}

function renderArrayValue(tag, value, depth) {
  if (!value || !value.elements || value.elements.length === 0) {
    return leaf(`<span class="muted">[]</span>`);
  }
  const innerType = tag.innerType.value;
  // Show inline if elements are tiny primitives and the array is small.
  const isShortPrim = value.elements.length <= 8 && ['IntProperty','FloatProperty','BoolProperty','NameProperty','StrProperty'].includes(innerType);
  if (isShortPrim) {
    return leaf(`= <code>${escapeText(JSON.stringify(value.elements.map(stringifyForInline)))}</code>`);
  }
  const items = value.elements.map((e, i) => {
    if (innerType === 'StructProperty') {
      const { inline, children } = renderStructValue(e, depth + 1);
      return renderSyntheticRow(`[${i}]`, inline, children, depth + 1);
    }
    return renderSyntheticRow(`[${i}]`, `= <code>${escapeText(stringifyForInline(e))}</code>`, '', depth + 1);
  }).join('');
  return {
    inline: `<span class="muted">${escapeText(t('ui.tree.items', { count: value.elements.length }))}</span>`,
    children: items,
  };
}

function renderSetValue(tag, value, depth) {
  const elements = value.elements || [];
  const items = elements.map((e, i) =>
    renderSyntheticRow(`{${i}}`, `= <code>${escapeText(stringifyForInline(e))}</code>`, '', depth + 1)
  ).join('');
  return {
    inline: `<span class="muted">${escapeText(t('ui.tree.setItems', { count: elements.length }))}</span>`,
    children: items,
  };
}

function renderMapValue(tag, value, depth) {
  const entries = value.entries || [];
  const items = entries.map((e, i) => {
    const keyHtml = `<code>${escapeText(stringifyForInline(e.key))}</code>`;
    const valInline = ` → <code>${escapeText(stringifyForInline(e.value))}</code>`;
    return renderSyntheticRow(keyHtml, valInline, '', depth + 1);
  }).join('');
  return {
    inline: `<span class="muted">${escapeText(t('ui.tree.entries', { count: entries.length }))}</span>`,
    children: items,
  };
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
  // Bind both 'input' and 'change' so <select> elements supplied by field
  // partials (e.g. PlayerLevel) participate in dirty tracking on every
  // browser. <input>/<textarea> only fire 'input'; <select> reliably fires
  // 'change' and modern browsers also fire 'input' — both is harmless.
  inputs.forEach(inp => {
    inp.addEventListener('input',  checkChanged);
    inp.addEventListener('change', checkChanged);
  });

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
      getDb().exec({
        sql: `UPDATE actor_table SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE actor_serial = ?`,
        bind: [...cols.map(c => updates[c]), row.actor_serial],
      });
    } catch (e) { alert(t('ui.alert.updateFailed', { message: e.message })); return; }
    markDirty(); reindexRow(row.actor_serial); applyFilters(); selectRow(row.actor_serial);
  });

  // delete --------
  $('deleteRow').addEventListener('click', () => {
    if (!confirm(t('ui.alert.confirmDeleteRow', { serial: row.actor_serial }))) return;
    const serialToRemove = row.actor_serial;
    try { getDb().exec({ sql: 'DELETE FROM actor_table WHERE actor_serial = ?', bind: [serialToRemove] }); }
    catch (e) { alert(t('ui.alert.deleteFailed', { message: e.message })); return; }
    markDirty();
    selectedSerial = null;
    $('detail').classList.add('hidden');
    $('main').classList.remove('with-detail');
    reindexRow(serialToRemove); applyFilters();
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

  // The Transform anchor button and Steam persona-label inputs are wired
  // by their owning section partials in js/partials.js — see Transform.wire
  // and SteamProfile.wire there.

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
        getDb().exec({ sql: 'UPDATE actor_table SET actor_data = ? WHERE actor_serial = ?', bind: [newBytes, row.actor_serial] });
      } catch (e) { alert(t('ui.alert.updateFailed', { message: e.message })); return; }
      markDirty(); reindexRow(row.actor_serial); applyFilters(); selectRow(row.actor_serial);
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
  const db = getDb();
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
  const db = getDb();
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
      markDirty(); reindexRow(existingSerial); applyFilters();
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
  markDirty(); reindexRow(newSerial); applyFilters();
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
  const db = getDb();
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
  if (!getDb()) return;
  setStatus(t('ui.status.serializing'));
  const size = SMDB.data.downloadActive();
  dirty = false;
  updateChrome();
  setStatus(t('ui.status.exported', { size: fmtBytes(size) }));
}

// ============================================================
// WIRE-UP
// ============================================================

// File picking, drag-drop, validation, and Switch-To live in SMDB.data
// (js/data-service.mjs). The header "files" button is wired by the data
// service itself; here we only wire features that own UI outside the
// data dialog.
$('search').addEventListener('input', debounce(applyFilters, 200));
$('kindFilter').addEventListener('change', applyFilters);
$('downloadBtn').addEventListener('click', downloadDB);

// As the SearchService finishes batches, re-apply the filter so newly-
// indexed rows pick up blob-text matches. Debounced so a burst of batch
// completions during initial indexing doesn't thrash the table render.
// The status bar shows progress so the user knows the index is filling.
const _refilterOnIndex = debounce(() => { if (getDb()) applyFilters(); }, 150);
SMDB.search.addListener((event, data) => {
  if (event === 'batch') {
    _refilterOnIndex();
    if (data && data.total > 0) {
      setStatus(t('ui.status.indexingBlobs',
        { count: `${data.indexed.toLocaleString()} / ${data.total.toLocaleString()}` }));
    }
  } else if (event === 'done') {
    _refilterOnIndex();
    if (currentFileLabel) {
      setStatus(t('ui.status.loaded',
        { file: currentFileLabel, count: allRows.length.toLocaleString() }));
    }
  } else if (event === 'reset') {
    _refilterOnIndex();
  }
});

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
    if (getDb()) renderTable();
  }
});

$('anchorAtBtn').addEventListener('click', openCustomAnchor);

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

// ---- detail panel resizer ----------------------------------------------
// Drag the 4 px column between #tableWrap and #detail to rebalance the
// split. The width lives in a CSS custom property (--detail-width) on
// <main>, which the grid layout in index.html consumes. Persisted in
// localStorage so the user's choice survives reloads.
(() => {
  const main = $('main');
  const resizer = $('detailResizer');
  if (!main || !resizer) return;

  const saved = localStorage.getItem('smdb.detailWidth');
  if (saved) main.style.setProperty('--detail-width', saved);

  let dragging = false;
  resizer.addEventListener('mousedown', e => {
    dragging = true;
    e.preventDefault();
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    // Clamp to keep both panes usable: at least 200 px on each side.
    const w = Math.max(200, Math.min(rect.width - 200, rect.right - e.clientX));
    main.style.setProperty('--detail-width', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const w = main.style.getPropertyValue('--detail-width');
    if (w) localStorage.setItem('smdb.detailWidth', w.trim());
  });
})();

// SqliteService boots its WASM module lazily on the first sqlite.open()
// call (inside Orchestrator.loadFile), so there's no init-on-page-load
// step here. The chrome is still updated once so the "Choose a file"
// empty-state renders correctly.
updateChrome();
