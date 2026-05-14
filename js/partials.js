'use strict';
/**
 * Partials — composable field/section editors for the detail panel.
 *
 * The detail panel is built up from a registry of "partials". Each partial
 * declares (a) what row shapes it applies to, (b) what slice of the row it
 * renders + edits, and (c) the HTML and wiring for that slice. The generic
 * editable-field grid and section layout in app.js delegate to the registry;
 * anything no partial claims falls back to today's default rendering.
 *
 * Two partial types:
 *
 *   type: 'field'    Replaces the <input>/<textarea> for one or more
 *                    actor_table columns inside the editable-fields grid.
 *                    The element returned by `renderField` MUST have
 *                    id `f_<field>` and a `.value` getter/setter that
 *                    round-trips a string; the dirty/save/revert loop in
 *                    app.js then handles it generically.
 *
 *   type: 'section'  Renders a whole <div class="detail-section"> block.
 *                    Placed in one of two slots: 'preFields' (between the
 *                    header section and the editable-field grid) or
 *                    'postFields' (between the field grid and the blob
 *                    viewer).
 *
 * Shared partial fields:
 *   name           Identifier, for debugging.
 *   appliesTo      (row, decoded) => boolean. Activation test.
 *
 * Type-specific:
 *   fields         ['actor_level', ...]                  — field type only.
 *   renderField    (ctx, field) => HTML string           — field type only.
 *
 *   slot           'preFields' | 'postFields'            — section type only.
 *   render         (ctx) => HTML string                  — section type only.
 *   wire           (ctx) => void                         — section type only.
 *                  Called after innerHTML to attach listeners.
 *
 * The render/wire ctx exposes:
 *   row, summary, decoded      Current row's data.
 *   t                          i18n alias (SMDB.i18n.t).
 *   fieldId(name)              DOM id for a field by name ('f_<name>').
 *   escapeText, escapeAttr     HTML escapers.
 *   spatial.isAnchored         Is the current row the spatial anchor?
 *   spatial.setRowAsAnchor()   Anchor the spatial query at this row.
 *   steam.saveLabel(value)     Persist a Steam persona label for this row.
 *
 * To add a new partial: write { type, name, appliesTo, ... } and call
 * SMDB.partials.register(it) from this file (or load order-after, before
 * app.js). The dispatcher picks it up on the next renderDetail().
 *
 * Depends on SMDB.classify and SMDB.steam being loaded first.
 */
window.SMDB = window.SMDB || {};

SMDB.partials = (() => {
  const FIELD_PARTIALS   = [];
  const SECTION_PARTIALS = [];

  function register(p) {
    if (p.type === 'field')        FIELD_PARTIALS.push(p);
    else if (p.type === 'section') SECTION_PARTIALS.push(p);
    else throw new Error('partial.type must be "field" or "section": ' + p.name);
  }

  // First applicable field partial that claims `field`, or null. In practice
  // each field should have at most one claimant; registration order is the
  // tie-breaker if not.
  function fieldFor(row, decoded, field) {
    for (const p of FIELD_PARTIALS) {
      if (!p.fields || !p.fields.includes(field)) continue;
      if (!p.appliesTo(row, decoded)) continue;
      return p;
    }
    return null;
  }

  // All applicable section partials in `slot`, in registration order.
  function sectionsFor(row, decoded, slot) {
    return SECTION_PARTIALS.filter(p => p.slot === slot && p.appliesTo(row, decoded));
  }

  // ======================================================================
  // BUILT-IN PARTIALS
  // ======================================================================

  // ---- SteamProfile (section) --------------------------------------------
  // Steam-account panel for player rows whose actor_name is a SteamID64.
  // Migrated from app.js renderSteamSection.
  register({
    type: 'section',
    name: 'SteamProfile',
    slot: 'preFields',
    appliesTo: (row) => !!row && SMDB.steam.isSteamId64(row.actor_name),
    render(ctx) {
      const { t, escapeText, escapeAttr } = ctx;
      const steamid64 = ctx.row.actor_name;
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
    },
    wire(ctx) {
      const labelEl = document.getElementById('steamLabel');
      const saveEl  = document.getElementById('saveSteamLabel');
      if (!labelEl || !saveEl) return;
      const orig = SMDB.steam.getLabel(ctx.row.actor_name) || '';
      labelEl.addEventListener('input', () => { saveEl.disabled = labelEl.value === orig; });
      saveEl.addEventListener('click', () => ctx.steam.saveLabel(labelEl.value));
    },
  });

  // ---- Transform (section) -----------------------------------------------
  // Parsed pos / rot / scale view + spatial-anchor button. Applies to any
  // row whose actor_transf parses. The raw textarea editor for actor_transf
  // stays in the editable-fields grid; this section is a read-only-ish view
  // alongside it.
  register({
    type: 'section',
    name: 'Transform',
    slot: 'postFields',
    appliesTo: (row) => !!row && SMDB.classify.parseTransform(row.actor_transf) != null,
    render(ctx) {
      const { t, escapeText } = ctx;
      const tx = SMDB.classify.parseTransform(ctx.row.actor_transf);
      if (!tx) return '';
      const bearing = SMDB.classify.bearingFromTransform(tx);
      const facingHtml = bearing
        ? ` <span class="muted">(${escapeText(t('ui.detail.facing'))} ${escapeText(t('ui.compass.' + bearing, { default: bearing }))})</span>`
        : '';
      const isAnchored = ctx.spatial.isAnchored;
      return `
        <div class="detail-section">
          <h3>${escapeText(t('ui.detail.transformHeading'))}</h3>
          <div class="field"><label>${escapeText(t('ui.detail.position'))}</label><span class="span">${tx.pos.map(n => n.toFixed(2)).join(', ')}</span></div>
          <div class="field"><label>${escapeText(t('ui.detail.rotation'))}</label><span class="span">${tx.rot.map(n => n.toFixed(2)).join(', ')}${facingHtml}</span></div>
          <div class="field"><label>${escapeText(t('ui.detail.scale'))}</label><span class="span">${tx.scale.map(n => n.toFixed(3)).join(', ')}</span></div>
          <div class="toolbar">
            <button id="anchorRow"${isAnchored ? ' disabled' : ''}>${escapeText(t(isAnchored ? 'ui.detail.anchorRowActive' : 'ui.detail.anchorRow'))}</button>
          </div>
        </div>`;
    },
    wire(ctx) {
      const btn = document.getElementById('anchorRow');
      if (!btn) return;
      btn.addEventListener('click', () => ctx.spatial.setRowAsAnchor());
    },
  });

  // ---- PlayerLevel (field) -----------------------------------------------
  // actor_level on player rows is a closed enum: one of two map paths
  // (main map or DLC map). Replace the freeform input with a select. If
  // the existing value is outside the known set, surface it as an
  // "unknown" option so we never silently change it on the next save.
  const PLAYER_LEVEL_OPTIONS = [
    { value: '/Game/Maps/Level01/Level01_Main.Level01_Main:PersistentLevel',
      key:   'ui.partial.playerLevel.main' },
    { value: '/Game/AdditionMap01/Maps/DLC_Level01/DLC_Level01_Main.DLC_Level01_Main:PersistentLevel',
      key:   'ui.partial.playerLevel.dlc' },
  ];
  register({
    type: 'field',
    name: 'PlayerLevel',
    fields: ['actor_level'],
    appliesTo: (row) => SMDB.classify.isPlayerRow(row),
    renderField(ctx, field) {
      const { t, escapeText, escapeAttr } = ctx;
      const current = ctx.row[field] == null ? '' : String(ctx.row[field]);
      const known = PLAYER_LEVEL_OPTIONS.some(o => o.value === current);
      const opts = PLAYER_LEVEL_OPTIONS.map(o =>
        `<option value="${escapeAttr(o.value)}" title="${escapeAttr(o.value)}"${o.value === current ? ' selected' : ''}>${escapeText(t(o.key))}</option>`
      ).join('');
      const fallback = known ? '' :
        `<option value="${escapeAttr(current)}" title="${escapeAttr(current)}" selected>${escapeText(t('ui.partial.playerLevel.unknown', { value: current || '(empty)' }))}</option>`;
      return `<select id="${ctx.fieldId(field)}">${opts}${fallback}</select>`;
    },
  });

  // ---- RelatedRows (section) --------------------------------------------
  // Parent/child navigation for rows that participate in the inventory-
  // owner / inventory-storage split. Surfaces "open parent" buttons on
  // BG-actor rows and "open inventory" buttons on chest/player rows.
  register({
    type: 'section',
    name: 'RelatedRows',
    slot: 'postFields',
    appliesTo: (row) => {
      if (!row) return false;
      return SMDB.classify.isInventoryStorageRow(row) || SMDB.classify.isInventoryOwnerRow(row);
    },
    render(ctx) {
      const { t, escapeText, escapeAttr } = ctx;
      const rel = SMDB.classify.findRelations(ctx.row, ctx.lookupRow, ctx.allRowsIter);
      if (!rel.parent && rel.children.length === 0) return '';
      const lines = [];
      if (rel.parent) {
        const lbl = rel.parent._label || ('#' + rel.parent.actor_serial);
        lines.push(`
          <div class="field">
            <label>${escapeText(t('ui.related.parent'))}</label>
            <span class="span">
              <button class="relatedJump" data-serial="${rel.parent.actor_serial}" title="${escapeAttr('#' + rel.parent.actor_serial)}">
                ${escapeText(t('ui.related.openParent', { serial: rel.parent.actor_serial }))}
              </button>
              <span class="muted" style="margin-left:8px;">${escapeText(lbl)}</span>
            </span>
          </div>`);
      }
      for (const c of rel.children) {
        const lbl = c._label || ('#' + c.actor_serial);
        lines.push(`
          <div class="field">
            <label>${escapeText(t('ui.related.child'))}</label>
            <span class="span">
              <button class="relatedJump" data-serial="${c.actor_serial}" title="${escapeAttr('#' + c.actor_serial)}">
                ${escapeText(t('ui.related.openChild', { serial: c.actor_serial }))}
              </button>
              <span class="muted" style="margin-left:8px;">${escapeText(lbl)}</span>
            </span>
          </div>`);
      }
      return `
        <div class="detail-section">
          <h3>${escapeText(t('ui.related.heading'))}</h3>
          ${lines.join('')}
        </div>`;
    },
    wire(ctx) {
      document.querySelectorAll('.relatedJump').forEach(btn => {
        btn.addEventListener('click', () => {
          const s = parseInt(btn.dataset.serial, 10);
          if (Number.isFinite(s)) ctx.navigate(s);
        });
      });
    },
  });

  // Inventory partial removed — the byte-pattern matcher it depended on
  // (SMDB.codecInventory) was discarded once we discovered the blob body is
  // LZ4-compressed standard UE FArchive. The inventory data is now visible
  // in the main property tree rendered in app.js renderUnrealProperties.

  return { register, fieldFor, sectionsFor };
})();
