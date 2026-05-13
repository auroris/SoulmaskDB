'use strict';
/**
 * Main UI for the Soulmask world.db browser.
 *
 * Loads on top of: sqlite3.js, codec-json, codec-unreal-blob, codecs,
 * steam, stash. All cross-module state lives on `SMDB.*`.
 */

// ============================================================
// CLASSIFICATION
// ============================================================

// Approximate gloss for romanized-Mandarin Soulmask blueprint identifiers.
// Best-effort and partial — many terms overlap or have multiple meanings.
const GLOSS = {
  JianZhu: 'building', PianQu: 'region', JingJiChang: 'farmland',
  DongWu: 'animal', YeZhu: 'wild boar', XieZi: 'scorpion', Yu: 'fish', Niao: 'bird',
  ZhiBei: 'vegetation', ZhiWu: 'plant', YouMiao: 'seedling', ShengZhang: 'growth',
  ZhongZhi: 'farm plot', GengDi: 'tilled ground',
  Crop: 'crop', Plant: 'plant', Tree: 'tree',
  BindBG: 'inventory', BaoGuo: 'inventory', BaoXiang: 'chest',
  DaoJu: 'item', RongQi: 'container', GuanLiQi: 'manager',
  CaiLiao: 'material', WuQi: 'weapon', Wuqi: 'weapon',
  FangJu: 'armor', ZhuangBei: 'equipment', JiNeng: 'skill',
  Tribe: 'tribe', Savage: 'savage', Egypt: 'egypt-DLC',
  YuanXing: 'prototype', QiTa: 'misc', Comp: 'component', Component: 'component',
  Actor: 'actor', LBis: 'ibis', NPC: 'NPC', Monster: 'monster',
  GongZuoTai: 'workbench', JiaJu: 'furniture', FengChe: 'windmill',
  ChuanSongMen: 'portal', Lighting: 'lighting', Conveyor: 'conveyor',
};

function shortClassName(scriptPath) {
  if (!scriptPath) return '';
  const m = scriptPath.match(/[./]([^./]+)_C$/);
  if (m) return m[1];
  const parts = scriptPath.split(/[./]/);
  return parts[parts.length - 1] || scriptPath;
}

function translateIdent(ident) {
  if (!ident) return '';
  const cleaned = ident.replace(/^BP_/, '').replace(/_C$/, '');
  const parts = cleaned.split(/[_.]/).filter(Boolean);
  return parts.map(p => GLOSS[p] || p).join(' ');
}

// Order-sensitive: more specific patterns must come BEFORE generic ones.
function classify(row) {
  const name = row.actor_name || '';
  const script = row.actor_script || '';

  if (name === 'GAME_SETTINGS') return { kind: 'system', label: 'GAME_SETTINGS', summary: 'Server: applied MODs (JSON blob)' };
  if (name === 'GAMEMODE')      return { kind: 'system', label: 'GAMEMODE',      summary: 'Server: global item-cap registry' };
  if (SMDB.steam.isSteamId64(name)) return { kind: 'system', label: name, summary: 'Per-player save data (Steam64 ID)' };

  const lower = script.toLowerCase();
  let kind = 'other';

  if      (lower.includes('hplayerstate'))         kind = 'player';
  else if (lower.includes('bindbgcompactor'))      kind = 'inventory';
  else if (lower.includes('jianzhupianqu'))        kind = 'region';
  else if (lower.includes('jianzhu/rongqi')
       ||  lower.includes('jianzhu/baoguoactor')
       ||  lower.includes('hbaoxiang'))            kind = 'container';
  else if (lower.includes('jianzhu/gongzuotai')
       ||  lower.includes('jianzhu/fengche')
       ||  lower.includes('jianzhu/lighting')
       ||  lower.includes('jianzhu/chuansongmen')
       ||  lower.includes('conveyor'))             kind = 'station';
  else if (lower.includes('jianzhu/zhongzhi'))     kind = 'vegetation';
  else if (lower.includes('jianzhu/jiaju'))        kind = 'furniture';
  else if (lower.includes('animalhouse'))          kind = 'building';
  else if (lower.includes('jianzhu'))              kind = 'building';
  else if (lower.includes('/npc/')
       ||  lower.includes('tribe')
       ||  lower.includes('savage')
       ||  lower.includes('sandbandits')
       ||  lower.includes('desertwolf')
       ||  lower.includes('exiles'))               kind = 'npc';
  else if (lower.includes('monster')
       ||  lower.includes('dongwu'))               kind = 'animal';
  else if (lower.includes('plant') || lower.includes('crop') || lower.includes('zhibei'))
                                                   kind = 'vegetation';
  else if (lower.includes('/ship/')
       ||  lower.includes('bp_ship')
       ||  lower.includes('bp_boat')
       ||  lower.includes('bp_deck')
       ||  lower.includes('gangway'))              kind = 'vehicle';

  const cls = shortClassName(script);
  const tx = parseTransform(row.actor_transf);
  const pos = tx ? ` @ ${tx.pos.map(n => Math.round(n)).join(',')}` : '';
  return { kind, label: cls, summary: translateIdent(cls) + pos };
}

function parseTransform(t) {
  if (!t) return null;
  const parts = t.split('|');
  if (parts.length !== 3) return null;
  const triples = parts.map(p => p.split(',').map(Number));
  if (triples.some(tr => tr.length !== 3 || tr.some(n => !isFinite(n)))) return null;
  return { pos: triples[0], rot: triples[1], scale: triples[2] };
}

// ============================================================
// SHARED RENDER HELPERS
// ============================================================

const $ = id => document.getElementById(id);

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

const setStatus = msg => { $('status').textContent = msg || ''; };

async function bootSqlite() {
  if (sqlite3) return sqlite3;
  setStatus('initializing sqlite…');
  sqlite3 = await globalThis.sqlite3InitModule({
    print: (...a) => console.log('[sqlite3]', ...a),
    printErr: (...a) => console.warn('[sqlite3]', ...a),
  });
  setStatus('sqlite ' + sqlite3.capi.sqlite3_libversion());
  return sqlite3;
}

async function loadFile(file) {
  await bootSqlite();
  setStatus(`loading ${file.name} (${fmtBytes(file.size)})…`);
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
    alert(`${label}: not a Soulmask world.db (no actor_table)`);
    return;
  }

  currentFileLabel = label;
  loadRows();
  dirty = false;
  selectedSerial = null;
  $('detail').classList.add('hidden');
  $('main').classList.remove('with-detail');
  updateChrome();
  applyFilters();
  setStatus(`loaded ${label} — ${allRows.length.toLocaleString()} rows`);
}

function loadRows() {
  // Load all rows including blob data so we can build a per-row text index.
  // We drop the actor_data reference after extracting strings to keep
  // memory bounded.
  const rows = [];
  setStatus('loading rows…');
  db.exec({
    sql: `SELECT actor_serial, server_id, data_version, actor_name, actor_script,
                 actor_owner, actor_transf, actor_time, actor_data,
                 length(actor_data) AS blob_size
          FROM actor_table ORDER BY actor_serial`,
    rowMode: 'object',
    resultRows: rows,
  });
  setStatus(`indexing blob strings (${rows.length.toLocaleString()} rows)…`);
  for (const r of rows) {
    const c = classify(r);
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
  $('controls').hidden = !db;
  $('empty').hidden = !!db;
  $('changedBadge').textContent = dirty ? '● unsaved changes' : '';
  $('stashBtn').textContent = `stash (${SMDB.stash.count()})`;
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
      <th>#</th><th>kind</th><th>class</th><th>summary</th>
      <th>owner</th><th>blob</th><th>time</th>
    </tr>`;

  if (slice.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding: 16px;">no rows match</td></tr>`;
  } else {
    tbody.innerHTML = slice.map(r => {
      const nameLabel = SMDB.steam.isSteamId64(r.actor_name) ? steamShortLabel(r.actor_name) : '';
      const labelHtml = nameLabel
        ? `${escapeText(r._label)} <span class="muted">— ${escapeText(nameLabel)}</span>`
        : escapeText(r._label);
      return `
      <tr data-serial="${r.actor_serial}" class="${r.actor_serial === selectedSerial ? 'selected' : ''}">
        <td>${r.actor_serial}</td>
        <td><span class="pill ${r._kind}">${r._kind}</span></td>
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

  $('filterCount').textContent =
    `${filtered.length.toLocaleString()} / ${allRows.length.toLocaleString()} rows`;

  renderPagination();
}

function renderPagination() {
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total === 0) { $('pagination').hidden = true; return; }
  $('pagination').hidden = false;
  $('pagination').innerHTML = `
    <button id="firstPage" ${currentPage === 0 ? 'disabled' : ''}>« first</button>
    <button id="prevPage"  ${currentPage === 0 ? 'disabled' : ''}>‹ prev</button>
    <span class="muted">page ${currentPage + 1} of ${pages}</span>
    <button id="nextPage"  ${currentPage >= pages - 1 ? 'disabled' : ''}>next ›</button>
    <button id="lastPage"  ${currentPage >= pages - 1 ? 'disabled' : ''}>last »</button>
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
    <div class="stat"><span class="muted">total</span><b>${allRows.length.toLocaleString()}</b></div>
    ${order.filter(k => counts[k]).map(k => `
      <div class="stat"><span class="pill ${k}">${k}</span><b>${counts[k].toLocaleString()}</b></div>
    `).join('')}
  `;
  $('summary').hidden = false;
}

function steamShortLabel(steamid64) {
  const stored = SMDB.steam.getLabel(steamid64);
  return stored || '';
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
  const tx = parseTransform(row.actor_transf);
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
      <h3>Transform (parsed)</h3>
      <div class="field"><label>position</label><span class="span">${tx.pos.map(n => n.toFixed(2)).join(', ')}</span></div>
      <div class="field"><label>rotation</label><span class="span">${tx.rot.map(n => n.toFixed(2)).join(', ')}</span></div>
      <div class="field"><label>scale</label><span class="span">${tx.scale.map(n => n.toFixed(3)).join(', ')}</span></div>
    </div>` : '';

  // ---- steam panel for player saves ----
  const steamHtml = SMDB.steam.isSteamId64(row.actor_name) ? renderSteamSection(row.actor_name) : '';

  // ---- blob panel via codecs ----
  const blobHtml = blobLen === 0 ? '<div class="muted">no blob</div>' : renderBlobByCodec(decoded, row.actor_serial, blob);

  $('detail').innerHTML = `
    <div class="detail-section">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0;">Row #${row.actor_serial} <span class="pill ${summary._kind}">${summary._kind}</span></h3>
        <button id="closeDetail">close</button>
      </div>
      <div class="muted" style="margin-top:6px;">${escapeText(summary._label)}</div>
      <div class="muted">${escapeText(summary._summary)}</div>
    </div>

    ${steamHtml}

    <div class="detail-section">
      <h3>Numeric (read-only)</h3>
      <div class="field"><label>actor_serial</label><span class="span">${row.actor_serial}</span></div>
      <div class="field"><label>data_version</label><span class="span">${row.data_version}</span></div>
    </div>

    <div class="detail-section">
      <h3>Editable text fields</h3>
      ${fieldsHtml}
      <div class="toolbar">
        <button id="saveRow" class="primary" disabled>save changes</button>
        <button id="revertRow" disabled>revert</button>
        <button id="stashRow">⎘ stash</button>
        <span class="spacer" style="flex:1;"></span>
        <button id="deleteRow" class="danger">delete row</button>
      </div>
    </div>

    ${txHtml}

    <div class="detail-section">
      <h3>Blob (${fmtBytes(blobLen)}, codec: ${decoded ? decoded.kind : '—'})</h3>
      ${blobHtml}
    </div>`;

  wireDetailEditing(row, summary, decoded);
}

function renderSteamSection(steamid64) {
  const s = SMDB.steam.decompose(steamid64);
  if (!s) return '';
  const stored = SMDB.steam.getLabel(steamid64) || '';
  return `
    <div class="detail-section">
      <h3>Steam Account</h3>
      <div class="field"><label>persona name</label>
        <input id="steamLabel" value="${escapeAttr(stored)}" placeholder="(open profile, paste name here)">
      </div>
      <div class="field"><label>SteamID64</label><span class="span">${escapeText(s.steamid64)}</span></div>
      <div class="field"><label>SteamID3</label><span class="span">${escapeText(s.steamid3)}</span></div>
      <div class="field"><label>SteamID v1</label><span class="span">${escapeText(s.steamidV1)}</span></div>
      <div class="field"><label>account ID</label><span class="span">${escapeText(s.accountId)}</span></div>
      <div class="toolbar">
        <a href="${s.profileUrl}" target="_blank" rel="noopener noreferrer">
          <button type="button">↗ open Steam profile</button>
        </a>
        <button id="saveSteamLabel" class="primary" disabled>save persona name</button>
      </div>
    </div>`;
}

function renderBlobByCodec(decoded, serial, rawBlob) {
  if (!decoded) return '<div class="muted">no blob</div>';
  if (decoded.kind === 'json-wrapped')      return renderJsonBlob(decoded, serial);
  if (decoded.kind === 'unreal-properties') return renderUnrealProperties(decoded, rawBlob);
  // unknown / empty
  if (decoded._raw) {
    return `
      <div class="muted">unknown format (header: ${Array.from(decoded._raw.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')})</div>
      <details open><summary>Hex (first 4 KB of ${decoded.totalSize.toLocaleString()} B)</summary>
        <pre class="hex">${escapeText(hexDump(decoded._raw, 0, 4096))}</pre></details>`;
  }
  return '<div class="muted">empty</div>';
}

function renderJsonBlob(decoded, serial) {
  const parseErr = decoded.parseError ? `<div class="danger" style="margin-bottom:6px;">parse error: ${escapeText(decoded.parseError)}</div>` : '';
  const pretty = decoded.parsed != null ? JSON.stringify(decoded.parsed, null, 2) : decoded.text;
  return `
    ${parseErr}
    <div class="field" style="grid-template-columns: 110px 1fr; align-items: stretch;">
      <label>JSON</label>
      <textarea id="jsonEditor" rows="8" data-serial="${serial}">${escapeText(pretty)}</textarea>
    </div>
    <div class="toolbar">
      <button id="saveJsonBlob" class="primary" disabled>save JSON</button>
      <button id="revertJsonBlob" disabled>revert</button>
      <span class="muted" id="jsonStatus"></span>
    </div>
    <details><summary>Header / metadata</summary>
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

  const namesText = decoded.names.length === 0 ? '(none)' :
    decoded.names.map(n => `@0x${n.offset.toString(16).padStart(6, '0')}  len=${String(n.length).padStart(3)}  ${n.text}`).join('\n');

  return `
    <div class="muted" style="margin-bottom:8px;">
      The body of this format uses a Soulmask-specific tagged-property layout that hasn't been
      fully reverse-engineered. This view shows the parsed 14-byte header and the
      length-prefixed FNames the format embeds literally. Writes are pass-through only.
    </div>
    <details open><summary>Header (${SMDB.codecUnrealProperties.HEADER_SIZE} bytes)</summary>
      <pre class="hex">${escapeText(headerLines)}</pre></details>
    <details open><summary>Length-prefixed FNames (${decoded.names.length})</summary>
      <pre class="hex">${escapeText(namesText)}</pre></details>
    <details><summary>Hex dump (first 4 KB of ${decoded.totalSize.toLocaleString()} B)</summary>
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
    ? ` <span class="danger" title="reader and tag.Size disagree">⚠</span>`
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
  const t = tag.type.value;
  if (value && value._opaque) {
    return `<span class="muted">&lt;opaque ${value._opaque.length} B: ${escapeText(value._opaqueReason || '?')}&gt;</span>`;
  }
  switch (t) {
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
      return `<span class="muted">&lt;FText, ${value && value._opaque ? value._opaque.length : 0} B&gt;</span>`;
    default:
      return `<span class="muted">&lt;${escapeText(t)} value&gt;</span>`;
  }
}

function renderStructValue(sv, depth) {
  if (!sv) return '<span class="muted">(empty struct)</span>';
  const name = sv._structName;
  // Known-binary struct: render compactly.
  if (SMDB.codecUnrealProperties.STRUCT_HANDLERS[name]) {
    return `= <code>${escapeText(JSON.stringify(sv.value))}</code>`;
  }
  // Unknown struct: nested properties
  if (sv._structDecodeError) {
    return `<span class="danger">struct decode error: ${escapeText(sv._structDecodeError)}</span>`;
  }
  if (!Array.isArray(sv.value) || sv.value.length === 0) {
    return `<span class="muted">(empty)</span>`;
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
  return `<span class="muted">[${value.elements.length} items]</span><div class="prop-children">${items}</div>`;
}

function renderSetValue(tag, value, depth) {
  const items = (value.elements || []).map((e, i) =>
    `<div class="prop-row" style="padding-left:${(depth+1)*14}px;">
      <span class="prop-name">{${i}}</span>
      <span class="prop-val">= <code>${escapeText(stringifyForInline(e))}</code></span></div>`).join('');
  return `<span class="muted">{${(value.elements||[]).length} items}</span><div class="prop-children">${items}</div>`;
}

function renderMapValue(tag, value, depth) {
  const items = (value.entries || []).map((e, i) =>
    `<div class="prop-row" style="padding-left:${(depth+1)*14}px;">
      <span class="prop-name"><code>${escapeText(stringifyForInline(e.key))}</code></span>
      <span class="prop-val"> → <code>${escapeText(stringifyForInline(e.value))}</code></span></div>`).join('');
  return `<span class="muted">{${(value.entries||[]).length} entries}</span><div class="prop-children">${items}</div>`;
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
          alert(`${f} must be an integer (got ${JSON.stringify(inp.value)})`);
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
    } catch (e) { alert(`update failed: ${e.message}`); return; }
    markDirty(); loadRows(); applyFilters(); selectRow(row.actor_serial);
  });

  // delete --------
  $('deleteRow').addEventListener('click', () => {
    if (!confirm(`Delete actor_serial=${row.actor_serial}? This will be lost on download. Cancel and Download first if you want a backup.`)) return;
    try { db.exec({ sql: 'DELETE FROM actor_table WHERE actor_serial = ?', bind: [row.actor_serial] }); }
    catch (e) { alert(`delete failed: ${e.message}`); return; }
    markDirty();
    selectedSerial = null;
    $('detail').classList.add('hidden');
    $('main').classList.remove('with-detail');
    loadRows(); applyFilters();
  });

  // stash --------
  $('stashRow').addEventListener('click', () => {
    const defaultLabel = SMDB.steam.isSteamId64(row.actor_name)
      ? `Player ${row.actor_name}${SMDB.steam.getLabel(row.actor_name) ? ' (' + SMDB.steam.getLabel(row.actor_name) + ')' : ''}`
      : `#${row.actor_serial} ${summary._label}`;
    const label = prompt(`Label for this stashed row:`, defaultLabel);
    if (label === null) return;
    const entry = SMDB.stash.rowToStashEntry(row, { sourceFile: currentFileLabel, label });
    SMDB.stash.add(entry);
    updateChrome();
    setStatus(`stashed row #${row.actor_serial} as "${entry.label}"`);
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
      setStatus(`saved persona name for ${row.actor_name}`);
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
      try { JSON.parse($('jsonEditor').value); $('jsonStatus').textContent = changed ? 'JSON OK' : ''; }
      catch (e) { $('jsonStatus').textContent = 'parse error: ' + e.message; }
    };
    $('jsonEditor').addEventListener('input', updateJsonChanged);
    $('revertJsonBlob').addEventListener('click', () => {
      $('jsonEditor').value = origText;
      updateJsonChanged();
    });
    $('saveJsonBlob').addEventListener('click', () => {
      let parsed;
      try { parsed = JSON.parse($('jsonEditor').value); }
      catch (e) { alert(`won't save: invalid JSON (${e.message})`); return; }
      const newDecoded = { ...decoded, parsed, text: JSON.stringify(parsed) };
      const newBytes = SMDB.codecs.encode(newDecoded);
      try {
        db.exec({ sql: 'UPDATE actor_table SET actor_data = ? WHERE actor_serial = ?', bind: [newBytes, row.actor_serial] });
      } catch (e) { alert(`update failed: ${e.message}`); return; }
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
    body.innerHTML = `<div class="muted" style="padding:20px; text-align:center;">No rows stashed yet. Open a row, click "stash".</div>`;
    return;
  }
  body.innerHTML = entries.map(e => {
    const r = e.row;
    const blobInfo = r.actor_data_b64 ? fmtBytes(Math.floor(r.actor_data_b64.length * 0.75)) : 'no blob';
    const isPlayer = SMDB.steam.isSteamId64(r.actor_name);
    const personaSuffix = isPlayer && SMDB.steam.getLabel(r.actor_name)
      ? ` (${SMDB.steam.getLabel(r.actor_name)})` : '';
    return `
      <div class="stash-entry" data-id="${e.id}">
        <div class="stash-header">
          <div>
            <div class="stash-label">${escapeText(e.label)}${escapeText(personaSuffix)}</div>
            <div class="muted" style="font-size:11px;">
              ${escapeText(r.actor_script || '(no script)')}
            </div>
            <div class="muted" style="font-size:11px;">
              from ${escapeText(e.sourceFile || 'unknown')} · ${escapeText(e.savedAt.replace('T', ' ').slice(0, 19))} · ${blobInfo} · orig serial #${r._origSerial ?? '?'}
            </div>
            ${e.note ? `<div class="muted" style="font-size:11px; margin-top:2px;">note: ${escapeText(e.note)}</div>` : ''}
          </div>
          <div class="row-actions">
            <button class="stash-paste" ${db ? '' : 'disabled title="load a world.db first"'}>paste here</button>
            <button class="stash-edit">edit</button>
            <button class="stash-del danger">delete</button>
          </div>
        </div>
      </div>`;
  }).join('');

  body.querySelectorAll('.stash-entry').forEach(el => {
    const id = el.dataset.id;
    el.querySelector('.stash-paste').addEventListener('click', () => pasteFromStash(id));
    el.querySelector('.stash-del').addEventListener('click', () => {
      if (confirm('Remove this stashed row?')) { SMDB.stash.remove(id); renderStashList(); updateChrome(); }
    });
    el.querySelector('.stash-edit').addEventListener('click', () => editStashEntry(id));
  });
}

function editStashEntry(id) {
  const entry = SMDB.stash.get(id);
  if (!entry) return;
  const newLabel = prompt('Label:', entry.label);
  if (newLabel === null) return;
  const newNote = prompt('Note (optional):', entry.note || '');
  if (newNote === null) return;
  SMDB.stash.update(id, { label: newLabel, note: newNote });
  renderStashList();
}

function pasteFromStash(id) {
  if (!db) { alert('Load a world.db first.'); return; }
  const entry = SMDB.stash.get(id);
  if (!entry) return;
  const bindings = SMDB.stash.stashEntryToBindings(entry);

  // Conflict on actor_name (the unique index).
  let existingSerial = null;
  if (bindings.actor_name) {
    existingSerial = db.selectValue('SELECT actor_serial FROM actor_table WHERE actor_name = ?', [bindings.actor_name]);
  }

  if (existingSerial) {
    const ok = confirm(
      `A row with actor_name='${bindings.actor_name}' already exists in this DB ` +
      `(actor_serial=${existingSerial}).\n\n` +
      `Click OK to REPLACE that row's contents with the stashed data.\n` +
      `Click Cancel to abort the paste.`);
    if (!ok) return;
    const cols = SMDB.stash.ROW_COLUMNS.concat(['actor_data']);
    try {
      db.exec({
        sql: `UPDATE actor_table SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE actor_serial = ?`,
        bind: [...cols.map(c => bindings[c]), existingSerial],
      });
    } catch (e) { alert(`replace failed: ${e.message}`); return; }
    markDirty(); loadRows(); applyFilters();
    setStatus(`replaced row #${existingSerial} from stash "${entry.label}"`);
    selectRow(existingSerial);
  } else {
    const cols = SMDB.stash.ROW_COLUMNS.concat(['actor_data']);
    try {
      db.exec({
        sql: `INSERT INTO actor_table (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        bind: cols.map(c => bindings[c]),
      });
    } catch (e) { alert(`insert failed: ${e.message}`); return; }
    const newSerial = db.selectValue('SELECT last_insert_rowid()');
    markDirty(); loadRows(); applyFilters();
    setStatus(`pasted stash "${entry.label}" as new row #${newSerial}`);
    selectRow(newSerial);
  }
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
      setStatus(`imported ${result.imported} entries (stash now has ${result.total})`);
      renderStashList(); updateChrome();
    } catch (e) { alert(`import failed: ${e.message}`); }
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
  $('verifySummary').textContent = 'Loading blobs…';
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
      $('verifySummary').innerHTML = `Tested ${i.toLocaleString()} / ${rows.length.toLocaleString()}  —  <span style="color:var(--ok);">${ok} OK</span>, <span class="danger">${fail} fail</span>, ${skipped} skipped`;
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const passRate = rows.length > 0 ? ((ok / (ok + fail || 1)) * 100).toFixed(2) : '0';
  $('verifySummary').innerHTML = `
    <div style="margin-bottom:6px;"><strong>Done.</strong> ${rows.length.toLocaleString()} blobs tested.</div>
    <div><span style="color:var(--ok);">✓ ${ok.toLocaleString()} round-trip OK</span>
         &nbsp;·&nbsp; <span class="danger">✗ ${fail.toLocaleString()} fail</span>
         &nbsp;·&nbsp; ${skipped.toLocaleString()} skipped (non-unreal-properties)
         &nbsp;·&nbsp; ${passRate}% pass</div>`;

  // Show first 200 failures grouped by root-cause-ish prefix.
  const shown = failures.slice(0, 200);
  $('verifyFailures').innerHTML = shown.map(f => `
    <div class="verify-fail">
      <span class="ser">#${f.serial}</span>
      <span class="muted">${escapeText((f.script || '').replace(/.*[./]/, '').replace(/_C$/, ''))}</span>
      <div class="reason">${escapeText(f.reason)}</div>
    </div>`).join('') + (failures.length > shown.length ? `<div class="muted" style="padding:8px 14px;">… ${failures.length - shown.length} more failures not shown</div>` : '');
}

// ============================================================
// DOWNLOAD
// ============================================================

function downloadDB() {
  if (!db) return;
  setStatus('serializing…');
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
  setStatus(`exported ${fmtBytes(out.byteLength)}`);
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

$('stashBtn').addEventListener('click', openStash);
$('stashClose').addEventListener('click', () => $('stashDialog').close());
$('stashExport').addEventListener('click', exportStashFile);
$('stashImportInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) importStashFile(f);
  e.target.value = '';
});
$('stashClear').addEventListener('click', () => {
  if (SMDB.stash.count() === 0) return;
  if (confirm(`Delete all ${SMDB.stash.count()} stashed rows? This can't be undone (export first if you want a backup).`)) {
    SMDB.stash.clear(); renderStashList(); updateChrome();
  }
});

window.addEventListener('beforeunload', e => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

bootSqlite().catch(e => setStatus('sqlite init failed: ' + e.message));
updateChrome();
