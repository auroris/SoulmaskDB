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

import { escapeText, escapeAttr, fmtBytes } from './util.mjs';
import { renderPropertyTree, configurePropertyTree } from './property-tree.mjs';

// ============================================================
// SHARED RENDER HELPERS
// ============================================================

const $ = id => document.getElementById(id);
const t = SMDB.i18n.t;  // file-scope alias for terse call sites

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
// UI STATE + ORCHESTRATOR + ROW TABLE
// ============================================================

// DB-level state that doesn't belong to RowTable:
//   - dirty            tracks unsaved edits to the SQLite handle
//   - currentFileLabel / currentServerId  used by the paste-from-stash
//     flow so inserted rows belong to *this* DB. RowTable also tracks
//     these but the locals avoid threading the dependency everywhere.
let dirty = false;
let currentFileLabel = null;
let currentServerId  = null;

const setStatus = msg => { $('status').textContent = msg || ''; };

// bootstrap.mjs constructed every service, awaited orchestrator.init()
// (which booted the lz4 + sqlite3 wasm in parallel, then inited DataService
// and RowTable with their dependencies), and dynamically imported this
// module. So by the time we run, SMDB.orchestrator / SMDB.data /
// SMDB.rowTable are fully wired and we only need to attach UI listeners.
const rowTable   = SMDB.rowTable;
const references = SMDB.references;

// Wire GUID jump links inside the property tree to row-table navigation.
// Configured once at boot; the tree consults `references.rowBySelfUid`
// at render time to decide which leaves are jumpable, and the delegated
// click handler inside property-tree.mjs invokes onGuidClick on hit.
// Clear any active relationship filter on jump so the target row is
// guaranteed to render after the navigation.
configurePropertyTree({
  references,
  onGuidClick: (serial) => {
    rowTable.clearRelationshipFilter();
    rowTable.setSelection(serial);
  },
});

// Shorthand for the rest of this file. Always returns the *current*
// handle (or null), so callers automatically see the new DB after a
// fresh load and stale handles never linger.
const getDb = () => SMDB.orchestrator.db();

// Surface load errors as alerts. RowTable handles the rows-ready /
// unloaded paths (it owns the table); we only react to errors here.
// Also toggle the decode spinner — it spins from `rows-ready` (decode
// about to start streaming) through `file-loaded` (decode pass done).
const setDecodeSpinner = (active) => {
  const el = $('decodeSpinner');
  if (el) el.classList.toggle('hidden', !active);
};
SMDB.orchestrator.addListener((event, data) => {
  if (event === 'rows-ready')        setDecodeSpinner(true);
  else if (event === 'file-loaded')  setDecodeSpinner(false);
  else if (event === 'load-error') {
    setDecodeSpinner(false);
    setStatus('');
    alert(t('ui.alert.notSoulmaskDB', { file: data.label }));
  }
});
SMDB.data.addListener((event /*, data */) => {
  // File removed / replaced — kill any in-flight spinner so the empty
  // state isn't left spinning forever.
  if (event === 'unloaded') setDecodeSpinner(false);
});

// When the active DB is removed, hand the dialog back to the user.
SMDB.data.addListener((event /*, data */) => {
  if (event !== 'unloaded') return;
  setStatus('');
  SMDB.data.maybeAutoOpen();
});

// RowTable funnels every load + every per-row mutation through
// 'rows-replaced', so this is the single place we refresh chrome /
// status / detail panel.
rowTable.addListener((event, data) => {
  if (event === 'rows-replaced') {
    currentFileLabel = data.label;
    currentServerId  = data.serverId;
    dirty = false;
    $('detail').classList.add('hidden');
    $('main').classList.remove('with-detail');
    updateChrome();
    if (data.label) {
      // The decode-progress spinner in the header (see #decodeSpinner)
      // replaces the prior "loaded {file} — {count} rows" status line —
      // it was redundant once the page also surfaces the row count in
      // the summary bar.
      resolvePlayerNames(data.rows);
    }
  } else if (event === 'row-selected') {
    renderDetailFor(data.serial);
  } else if (event === 'row-deselected') {
    $('detail').classList.add('hidden');
    $('main').classList.remove('with-detail');
  } else if (event === 'kind-filter-changed') {
    // The active-pill state lives in the summary's `.active` class —
    // refresh that so the pill row reflects the selection driven by
    // either the click handler below or a programmatic call.
    if (getDb()) renderSummary();
  }
});

// Delegated click on the summary pills. The pill carries a
// `data-kind` attribute so we don't have to thread per-pill listeners
// through renderSummary; one listener attached once on page boot
// survives every re-render.
$('summary').addEventListener('click', (e) => {
  const pill = e.target.closest('.kind-pill[data-kind]');
  if (!pill) return;
  rowTable.toggleKindFilter(pill.dataset.kind);
});
$('summary').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const pill = e.target.closest('.kind-pill[data-kind]');
  if (!pill) return;
  e.preventDefault();
  rowTable.toggleKindFilter(pill.dataset.kind);
});

// Fire-and-forget Steam-name resolution after a save loads. On success,
// re-renders the table so resolved names appear in the row list. Errors
// (404, CORS, offline, etc.) are silently swallowed by SMDB.steam.resolveNames.
function resolvePlayerNames(rows) {
  const ids = [];
  for (const r of rows) {
    if (SMDB.steam.isSteamId64(r.actor_name)) ids.push(r.actor_name);
  }
  if (ids.length === 0) return;
  SMDB.steam.resolveNames(ids).then(updated => {
    if (updated > 0) { rowTable.redraw(); updateChrome(); }
  });
}

/**
 * Re-index a single row after a SQL/blob edit (or remove it after a
 * delete). Orchestrator updates the DB read + search-index; RowTable
 * keeps the visible table in sync via upsert/remove.
 */
function reindexRow(serial) {
  const newRow = SMDB.orchestrator.reindexRow(serial);
  if (!newRow) rowTable.removeRow(serial);
  else rowTable.upsertRow(newRow);
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
  $('controls').hidden = !db;
  $('empty').hidden = !!db;
  $('changedBadge').textContent = dirty ? t('ui.header.changedBadge') : '';
  $('stashBtn').textContent = t('ui.header.stash', { count: SMDB.stash.count() });
  if (db) renderSummary();
}

// ============================================================
// SUMMARY (RowTable owns the table itself)
// ============================================================

// Preferred render order for kinds that classify.mjs produces today.
// Any kind seen in the data but not listed here still appears — sorted
// alphabetically after the preferred ones — so adding a new classify
// rule doesn't require a separate edit here.
const KIND_PREFERRED_ORDER = ['system', 'player', 'inventory', 'npc', 'animal', 'container', 'station', 'building', 'furniture', 'vegetation', 'region', 'vehicle', 'other'];

function renderSummary() {
  const rows = rowTable.rows();
  const counts = {};
  for (const r of rows) counts[r._kind] = (counts[r._kind] || 0) + 1;
  const kinds = Object.keys(counts).sort((a, b) => {
    const ai = KIND_PREFERRED_ORDER.indexOf(a);
    const bi = KIND_PREFERRED_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });
  const selected = rowTable.selectedKinds();
  $('summary').innerHTML = `
    <div class="stat"><span class="muted">${escapeText(t('ui.summary.total'))}</span><b>${rows.length.toLocaleString()}</b></div>
    ${kinds.map(k => `
      <div class="stat"><span class="pill ${escapeAttr(k)} kind-pill${selected.has(k) ? ' active' : ''}" data-kind="${escapeAttr(k)}" role="button" tabindex="0">${escapeText(t('ui.kind.' + k, {default: k}))}</span><b>${counts[k].toLocaleString()}</b></div>
    `).join('')}
  `;
  $('summary').hidden = false;
}

// ============================================================
// DETAIL PANEL
// ============================================================

const EDITABLE = ['actor_name', 'actor_level', 'actor_script', 'actor_owner', 'actor_transf', 'actor_time', 'server_id'];
const NUMERIC_FIELDS = new Set(['server_id', 'data_version']);
const FIELD_HINTS = { actor_time: 'UTC' };

function selectRow(serial) {
  // Thin wrapper. RowTable.setSelection emits 'row-selected', and the
  // listener installed at module load calls renderDetailFor(serial).
  rowTable.setSelection(serial);
}

function renderDetailFor(serial) {
  const row = getRowDetail(serial);
  if (!row) return;
  const summary = rowTable.findRow(serial);
  if (!summary) return;
  renderDetail(row, summary);
  $('main').classList.add('with-detail');
  $('detail').classList.remove('hidden');
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

    ${renderRelationshipsSection(row.actor_serial)}

    <div class="detail-section">
      <h3>${escapeText(t('ui.detail.blobHeading', { size: fmtBytes(blobLen), codec: decoded ? decoded.kind : t('ui.detail.blobNone') }))}</h3>
      ${blobHtml}
    </div>`;

  // Wire section partials (their internal listeners) after innerHTML lands.
  // Field partials don't need explicit wiring — the dirty/save/revert loop
  // in wireDetailEditing handles them via the `f_<field>` id convention.
  SMDB.partials.sectionsFor(row, decoded, 'preFields') .forEach(p => p.wire && p.wire(ctx));
  SMDB.partials.sectionsFor(row, decoded, 'postFields').forEach(p => p.wire && p.wire(ctx));

  wireRelationships(row.actor_serial);
  wireDetailEditing(row, summary, decoded);
}

// Property paths that surface as the four named relationship filters.
// `built` is a multi-path category — Soulmask uses different builder fields
// for buildings (JianZhuBuilderUid) and ships/rafts (RaftSpaceBuilderUid).
// Add new path names here when we learn about more relationship types.
const REL_PATHS = {
  owned: ['ZhuRenGuid'],
  built: ['JianZhuBuilderUid', 'RaftSpaceBuilderUid'],
  guild: ['GongHuiGuid'],
};

function classifyReferrers(referrers) {
  const buckets = { all: referrers, owned: [], built: [], guild: [] };
  const builtSet = new Set(REL_PATHS.built);
  for (const r of referrers) {
    if (REL_PATHS.owned.includes(r.path)) buckets.owned.push(r);
    else if (builtSet.has(r.path))        buckets.built.push(r);
    else if (REL_PATHS.guild.includes(r.path)) buckets.guild.push(r);
  }
  return buckets;
}

/**
 * Build the Relationships detail section for the given row.
 *
 *   Points to     — outbound GUID refs, each rendered as a jump link
 *                   (or muted if the target isn't in the loaded set).
 *   Pointed to by — filter buttons that constrain the table to inbound
 *                   refs, broken down by relationship type.
 *
 * Returns the empty string when the row has no SelfUid AND no outbound
 * refs — nothing useful to show.
 */
function renderRelationshipsSection(serial) {
  const outbound  = references.outboundFrom(serial);
  const selfUid   = references.selfUidOf(serial);
  const referrers = selfUid ? references.referrersOf(selfUid) : [];

  if (outbound.length === 0 && referrers.length === 0 && !selfUid) return '';

  const parentRows = outbound.map(o => {
    const targetRow = o.targetSerial != null ? rowTable.findRow(o.targetSerial) : null;
    const targetHtml = o.targetSerial != null
      ? `<a href="#" class="prop-guid resolved" data-serial="${o.targetSerial}">`
        + `<code>#${o.targetSerial}</code>`
        + (targetRow ? ` <span class="muted">${escapeText(targetRow._label || '')}</span>` : '')
        + `</a>`
      : `<code class="prop-guid unresolved">${escapeText(o.guid)}</code>`
        + ` <span class="muted">${escapeText(t('ui.relationship.targetMissing'))}</span>`;
    return `<div class="rel-row">`
      + `<span class="rel-path">${escapeText(o.path)}</span>`
      + `<span class="rel-target">${targetHtml}</span>`
      + `</div>`;
  }).join('');

  const buckets = classifyReferrers(referrers);
  const activeFilter = rowTable.relationshipFilter();
  const activeOrigin = activeFilter && activeFilter.originSerial === serial ? activeFilter.kind : null;
  // Buttons show the unique row count rather than the entry count — that
  // matches what the user will see after the filter applies (a referrer
  // may show up twice on the same row, e.g. a player whose ControlledPawn
  // AND ChuShiKeLongData.ManRenUId both reference the same NPC). The
  // filter is keyed by serial, so unique rows is the honest number.
  const uniq = (entries) => {
    const s = new Set();
    for (const e of entries) s.add(e.serial);
    return s.size;
  };
  const btn = (kind, count) => {
    if (count === 0) return '';
    const label = t('ui.relationship.btn.' + kind, { count: count.toLocaleString() });
    const cls   = activeOrigin === kind ? ' class="active"' : '';
    return `<button data-rel="${kind}"${cls}>${escapeText(label)}</button>`;
  };
  const buttonsHtml = referrers.length === 0
    ? `<div class="muted">${escapeText(t('ui.relationship.noSelfUid'))}</div>`
    : `<div class="rel-filters">`
      + btn('all',   uniq(buckets.all))
      + btn('owned', uniq(buckets.owned))
      + btn('built', uniq(buckets.built))
      + btn('guild', uniq(buckets.guild))
      + `</div>`;

  const parentsHtml = outbound.length === 0
    ? `<div class="muted">${escapeText(t('ui.relationship.noOutbound'))}</div>`
    : parentRows;

  return `
    <div class="detail-section" id="relationshipsSection" data-serial="${serial}">
      <h3>${escapeText(t('ui.relationship.heading'))}</h3>
      <div class="muted" style="font-size:11px;">${escapeText(t('ui.relationship.parents'))}</div>
      ${parentsHtml}
      <div class="muted" style="font-size:11px; margin-top:8px;">${escapeText(t('ui.relationship.children'))}</div>
      ${buttonsHtml}
    </div>`;
}

/**
 * Click-wire the Relationships section's buttons and outbound jump links.
 * Buttons set a row-table relationship filter built from the referrer
 * bucket they represent; outbound parent links navigate directly.
 *
 * Defensive: section may not be rendered for this row (no SelfUid + no
 * outbound), in which case we no-op.
 */
function wireRelationships(serial) {
  const section = $('relationshipsSection');
  if (!section) return;

  // Outbound jump links — anchors in the parent rows. Use a section-scoped
  // listener so we don't fight property-tree.mjs's document-level delegate.
  section.querySelectorAll('a.prop-guid.resolved').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = parseInt(a.dataset.serial, 10);
      if (!Number.isFinite(target)) return;
      rowTable.clearRelationshipFilter();
      rowTable.setSelection(target);
    });
  });

  // Relationship filter buttons.
  section.querySelectorAll('button[data-rel]').forEach(b => {
    b.addEventListener('click', () => applyRelationshipFilter(serial, b.dataset.rel));
  });
}

function applyRelationshipFilter(serial, kind) {
  const selfUid = references.selfUidOf(serial);
  if (!selfUid) return;
  const all = references.referrersOf(selfUid);
  const buckets = classifyReferrers(all);
  const refs = buckets[kind] || [];
  if (refs.length === 0) return;
  const labelKey = 'ui.relationship.filter' + kind.charAt(0).toUpperCase() + kind.slice(1);
  const label = t(labelKey, { serial });
  rowTable.setRelationshipFilter({
    label,
    kind,
    originSerial: serial,
    serials: refs.map(r => r.serial),
  });
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
// Closes over the current row, summary, decoded blob, and the rowTable
// state partials need to read or mutate (spatial anchor, Steam labels).
// Exposed-on-ctx helpers keep partial files independent of app.mjs and
// of RowTable internals.
function buildPartialCtx(row, summary, decoded) {
  return {
    row, summary, decoded,
    t,
    escapeText, escapeAttr,
    fieldId: name => `f_${name}`,
    // Look up another row by serial (returns the lightweight row entry
    // — no blob — or null). Partials that need the raw blob should call
    // ctx.lookupRowDetail(serial) instead.
    lookupRow(serial) { return rowTable.findRow(serial); },
    lookupRowDetail: getRowDetail,
    allRowsIter() { return rowTable.rows(); },
    navigate(serial) {
      if (rowTable.findRow(serial)) selectRow(serial);
    },
    spatial: {
      get isAnchored() { return rowTable.isAnchoredOn(row.actor_serial); },
      setRowAsAnchor() {
        if (!rowTable.setRowAsAnchor(row)) {
          alert(t('ui.alert.anchorNoTransform'));
          return;
        }
        selectRow(row.actor_serial);
      },
    },
    steam: {
      saveLabel(value) {
        SMDB.steam.setLabel(row.actor_name, value);
        setStatus(t('ui.status.savedPersona', { id: row.actor_name }));
        reindexRow(row.actor_serial);
        selectRow(row.actor_serial);
      },
    },
  };
}

function renderBlobByCodec(decoded, serial) {
  if (!decoded) return `<div class="muted">${escapeText(t('ui.detail.noBlob'))}</div>`;
  if (decoded.kind === 'json-wrapped')      return renderJsonBlob(decoded, serial);
  if (decoded.kind === 'unreal-properties') return renderPropertyTree(decoded);
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
    markDirty(); reindexRow(row.actor_serial); selectRow(row.actor_serial);
  });

  // delete --------
  $('deleteRow').addEventListener('click', () => {
    if (!confirm(t('ui.alert.confirmDeleteRow', { serial: row.actor_serial }))) return;
    const serialToRemove = row.actor_serial;
    try { getDb().exec({ sql: 'DELETE FROM actor_table WHERE actor_serial = ?', bind: [serialToRemove] }); }
    catch (e) { alert(t('ui.alert.deleteFailed', { message: e.message })); return; }
    markDirty();
    // reindexRow → rowTable.removeRow → clearSelection → emits 'row-deselected'
    // → listener hides the detail panel. Nothing else to do here.
    reindexRow(serialToRemove);
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
    rowTable.clearSelection();
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
      markDirty(); reindexRow(row.actor_serial); selectRow(row.actor_serial);
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
      markDirty(); reindexRow(existingSerial);
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
  markDirty(); reindexRow(newSerial);
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
// WIRE-UP
// ============================================================

// File picking, drag-drop, validation, Switch-To, and Download all live
// in SMDB.data (js/data-service.mjs). The header "files" button is wired
// by the data service itself; downloads happen through that dialog. Here
// we only wire features that own UI outside the data dialog and the
// table.
//
// Search box, kind filter, anchor button, and the per-batch re-filter
// are owned by RowTable (js/row-table.mjs). We only consume search
// progress events for the status bar.

SMDB.search.addListener((event, data) => {
  if (event === 'batch') {
    if (data && data.total > 0) {
      setStatus(t('ui.status.indexingBlobs',
        { count: `${data.indexed.toLocaleString()} / ${data.total.toLocaleString()}` }));
    }
  } else if (event === 'done') {
    // Clear the indexing-progress status; the spinner in the header
    // is the canonical "still working" signal, and the loaded-summary
    // line has been retired (the summary bar already shows row count).
    setStatus('');
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

// Orchestrator.init() already booted the sqlite3 + lz4 wasm in parallel
// before this module loaded, so there's no init-on-page-load step here.
// The chrome is still updated once so the "Choose a file" empty-state
// renders correctly.
updateChrome();
