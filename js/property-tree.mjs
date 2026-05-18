/**
 * Structured property-tree renderer for `unreal-properties` blobs.
 *
 * Returns the inner HTML for the blob panel; the caller (app.mjs's
 * renderBlobByCodec) wraps it in the surrounding detail-section chrome.
 *
 * Layout: leaves are `<div class="prop-row">`s; nodes with children
 * become `<details class="prop-node"><summary class="prop-row">…
 * </summary><div class="prop-children">…</div></details>`. Both row
 * shapes start with `<span class="prop-chevron"></span>` so the name
 * column aligns whether the row is expandable or not. CSS in index.html
 * turns the chevron into ▸ / ▾ for `<details>` rows and hides it for
 * leaves.
 *
 * Performance affordances for big blobs:
 *
 *   1. Auto-collapse past `AUTO_OPEN_DEPTH`. Without this, a deeply
 *      nested blob materializes every row in the layout tree up front
 *      and dwarfs frame time. Open `<details>` content participates in
 *      layout; closed `<details>` content does not. Deep subtrees stay
 *      collapsed so the user pays only when they drill in.
 *
 *   2. Collection cap (`COLLECTION_DISPLAY_CAP`). Arrays / sets / maps
 *      over the cap render the first N items plus a "show K more" row.
 *      Clicking that row swaps it in-place for HTML built from the
 *      stashed remainder. This is a real saving: the HTML for items
 *      past the cap is never built at first render. The stash is a
 *      module-scoped `Map` keyed by short string ID written into the
 *      row's `data-stash` attribute, with a single delegated click
 *      handler installed lazily on first render.
 *
 *  Module-load contract: importing this file does NOT touch the DOM.
 *  The delegated click handler is registered on first `renderPropertyTree`
 *  call so that node/test environments that import this for any reason
 *  don't crash on `document` being undefined.
 */

import { escapeText, escapeAttr } from './util.mjs';
import { i18n } from './i18n.mjs';
import { STRUCT_HANDLERS, StructValue } from '../lib/unreal/structs.mjs';

// Canonical UE FGuid hex string — used to spot guid-shaped values inside
// map keys / values so they render as jump links instead of opaque text.
const GUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

const t = (k, opts) => i18n.t(k, opts);

// Optional dependencies injected once at app boot via configurePropertyTree.
// `references` lets Guid struct leaves render as resolved jump links; without
// it, GUIDs render as plain monospace strings (the renderer stays usable in
// any context that doesn't have a loaded DB, e.g. tests). `onGuidClick(serial)`
// is called when the user clicks a resolved GUID — app.mjs wires it to
// rowTable.setSelection.
let _references  = null;
let _onGuidClick = null;
export function configurePropertyTree({ references = null, onGuidClick = null } = {}) {
  _references  = references;
  _onGuidClick = onGuidClick;
}

// `<details>` at a depth shallower than this open by default. Anything
// deeper renders closed; the user clicks to drill in. Picked empirically
// — most actor blobs surface their interesting fields at depth 0–1, and
// rare deeper drill-ins (a Transform's Location's components, an
// inventory's slot's contents) are one click away.
const AUTO_OPEN_DEPTH = 2;

// Cap for inline rendering of array / set / map entries. The leading N
// items render in the initial HTML; the rest live in a stash and only
// materialize when the user clicks "show K more". For most rows this
// changes nothing (typical actor lists are short); the win is on the
// occasional 1000-item inventory that used to balloon the initial DOM.
const COLLECTION_DISPLAY_CAP = 50;

// Stash of unrendered collection tails. Each entry is a thunk that
// returns the HTML for the remaining items at the correct depth. The
// stash key lives on the show-more row's data-stash attribute. Each
// thunk is one-shot — consumed when the row is clicked.
const _lazyStash = new Map();
let _stashCounter = 0;

let _delegateInstalled = false;

function stashRemaining(renderFn) {
  const id = 's' + (++_stashCounter);
  _lazyStash.set(id, renderFn);
  return id;
}

function installDelegate() {
  if (_delegateInstalled || typeof document === 'undefined') return;
  _delegateInstalled = true;
  // Delegate from document so we don't care which container the tree
  // lives in. Idempotent — installDelegate short-circuits on subsequent
  // renderPropertyTree calls. Handles two click targets:
  //   .show-more-link  → materialize stashed collection tail
  //   .prop-guid.resolved → jump to the row whose SelfUid is this guid
  document.addEventListener('click', (e) => {
    if (!e.target.closest) return;
    const showMore = e.target.closest('.show-more-link');
    if (showMore) {
      e.preventDefault();
      const row = showMore.closest('.prop-show-more');
      if (!row) return;
      const id = row.dataset.stash;
      const renderFn = _lazyStash.get(id);
      if (!renderFn) { row.remove(); return; }
      _lazyStash.delete(id);
      // outerHTML replacement: lets the new rows (which may themselves
      // contain show-more links for further-truncated nested collections)
      // splice into the same depth/padding position the placeholder held.
      row.outerHTML = renderFn();
      return;
    }
    const guidLink = e.target.closest('.prop-guid.resolved');
    if (guidLink) {
      e.preventDefault();
      const serial = parseInt(guidLink.dataset.serial, 10);
      if (Number.isFinite(serial) && _onGuidClick) _onGuidClick(serial);
    }
  });
}

/**
 * Render the structured-tree HTML for a decoded `unreal-properties`
 * blob. Returns a string the caller drops into innerHTML.
 */
export function renderPropertyTree(decoded) {
  installDelegate();
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
  return `${errorBanner}${trailing}${propsHeading}${treeHtml}`;
}

// ---- rendering primitives ----------------------------------------------

// Helper for leaf returns — keeps call sites compact.
const leaf = inline => ({ inline, children: '' });

function detailsOrLeaf(head, children, depth) {
  const pad = `padding-left:${depth * 14}px;`;
  if (!children) return `<div class="prop-row" style="${pad}">${head}</div>`;
  const openAttr = depth < AUTO_OPEN_DEPTH ? ' open' : '';
  return `<details class="prop-node"${openAttr}><summary class="prop-row" style="${pad}">${head}</summary><div class="prop-children">${children}</div></details>`;
}

function renderPropertyEntry(prop, _idx, depth) {
  const tag = prop.tag;
  const typeStr = propertyTypeLabel(tag);
  const nameStr = formatFName(tag.name) + (tag.arrayIndex ? `[${tag.arrayIndex}]` : '');
  const { inline, children } = renderValue(tag, prop.value, depth);
  const sizeWarn = prop._sizeMismatch
    ? ` <span class="danger" title="${escapeAttr(t('ui.tree.sizeMismatchTitle'))}">⚠</span>`
    : '';
  const guidLine = tag.hasPropertyGuid ? ` <span class="muted">{${tag.propertyGuid}}</span>` : '';
  const head = `<span class="prop-chevron"></span><span class="prop-name">${escapeText(nameStr)}</span><span class="prop-type muted">: ${escapeText(typeStr)}${guidLine}${sizeWarn}</span><span class="prop-val">${inline}</span>`;
  return detailsOrLeaf(head, children, depth);
}

// Synthetic row for array indices, set members, and map keys: same
// markup as renderPropertyEntry minus the type / guid / size columns.
// `nameHtml` is dropped in pre-escaped — call sites that pass user-y
// text are responsible for escaping it themselves.
function renderSyntheticRow(nameHtml, inline, children, depth) {
  const head = `<span class="prop-chevron"></span><span class="prop-name">${nameHtml}</span><span class="prop-val">${inline}</span>`;
  return detailsOrLeaf(head, children, depth);
}

function renderShowMoreRow(remainingCount, stashId, depth) {
  const pad = `padding-left:${depth * 14}px;`;
  const label = t('ui.tree.showMore', {
    count:   remainingCount.toLocaleString(),
    default: '… show {count} more',
  });
  return `<div class="prop-row prop-show-more" style="${pad}" data-stash="${stashId}"><a href="#" class="show-more-link">${escapeText(label)}</a></div>`;
}

/**
 * Render an iterable as cap-then-stash. `renderItem(item, idx)` produces
 * the HTML for one entry; we call it eagerly for the leading items and
 * stash the tail behind a show-more row.
 *
 * `placedDepth` is the depth at which the items (and the show-more row)
 * are placed — i.e. the parent's depth + 1.
 */
function renderCappedItems(items, renderItem, placedDepth) {
  const total = items.length;
  if (total <= COLLECTION_DISPLAY_CAP) {
    return items.map(renderItem).join('');
  }
  const visible = items.slice(0, COLLECTION_DISPLAY_CAP).map(renderItem).join('');
  const remaining = items.slice(COLLECTION_DISPLAY_CAP);
  const offset = COLLECTION_DISPLAY_CAP;
  const stashId = stashRemaining(() =>
    remaining.map((e, i) => renderItem(e, offset + i)).join(''),
  );
  return visible + renderShowMoreRow(total - COLLECTION_DISPLAY_CAP, stashId, placedDepth);
}

// Plain-text label — call sites pass the result through escapeText() before
// dropping it into HTML, so any `<` / `>` here gets encoded exactly once.
function propertyTypeLabel(tag) {
  const ty = tag.type.value;
  if (ty === 'StructProperty') return `StructProperty (${tag.structName.value})`;
  if (ty === 'ArrayProperty')  return `ArrayProperty<${tag.innerType.value}>`;
  if (ty === 'SetProperty')    return `SetProperty<${tag.innerType.value}>`;
  if (ty === 'MapProperty')    return `MapProperty<${tag.innerType.value}, ${tag.valueType.value}>`;
  if (ty === 'ByteProperty' && tag.enumName?.value && tag.enumName.value !== 'None') return `ByteProperty (${tag.enumName.value})`;
  if (ty === 'EnumProperty')   return `EnumProperty (${tag.enumName.value})`;
  return ty;
}

function formatFName(n) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  return n.number ? `${n.value}_${n.number - 1}` : n.value;
}

function renderValue(tag, value, depth) {
  const propType = tag.type.value;
  if (value && value._opaque) {
    return leaf(`<span class="muted">${escapeText(t('ui.tree.opaque', { bytes: value._opaque.length, reason: value._opaqueReason || '?' }))}</span>`);
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
      return renderStrValue(value, depth);
    case 'NameProperty':
      return leaf(`= <code>${escapeText(formatFName(value))}</code>`);
    case 'ObjectProperty': case 'ClassProperty':
    case 'WeakObjectProperty': case 'LazyObjectProperty':
    case 'WSObjectProperty':
      // Plain string = just a path; object = path + embedded property stream
      // (Soulmask serializes the referenced object's data inline).
      return renderObjectRefValue(value, depth);
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
      return leaf(`<span class="muted">${escapeText(t('ui.tree.text', { bytes: value && value._opaque ? value._opaque.length : 0 }))}</span>`);
    default:
      return leaf(`<span class="muted">${escapeText(t('ui.tree.value', { type: propType }))}</span>`);
  }
}

// ObjectProperty / ClassProperty / WeakObjectProperty / LazyObjectProperty / WSObjectProperty.
// Shared between the top-level renderValue case and renderArrayValue's per-element renderer
// (array-of-ObjectProperty inner types like JianZhuInstYuanXings).
function renderObjectRefValue(value, depth) {
  if (value && value._opaque) {
    return leaf(`<span class="muted">${escapeText(t('ui.tree.opaque', { bytes: value._opaque.length, reason: value._opaqueReason || '?' }))}</span>`);
  }
  if (typeof value === 'string') return leaf(`→ <code>${escapeText(value)}</code>`);
  const pathHtml = `→ <code>${escapeText(value.path || '')}</code>`;
  if (!value.embedded || value.embedded.length === 0) return leaf(pathHtml);
  const inner = value.embedded.map((p, i) => renderPropertyEntry(p, i, depth + 1)).join('');
  return { inline: pathHtml, children: inner };
}

/**
 * StrProperty renderer. Soulmask stores several Unreal-side payloads as
 * JSON-encoded strings inside ordinary StrProperty values — observed
 * cases include `RelativeTransform` and `HuodongZhongxinLocation`. If
 * the string parses as a JSON object or array, render it as a
 * collapsible sub-tree so the embedded structure is readable; otherwise
 * fall back to the original JSON.stringify display (which escapes
 * quotes and special chars so the raw string content is unambiguous).
 *
 * The decision is name-agnostic — any StrProperty whose value parses
 * gets the structured view. Round-trip is unaffected: the encoder
 * writes the row's original string verbatim.
 */
function renderStrValue(value, depth) {
  if (typeof value === 'string' && value.length > 0) {
    const first = value.charCodeAt(0);
    // Cheap pre-check: only try JSON.parse when the string actually
    // starts with `{` (0x7B) or `[` (0x5B). Avoids burning cycles on
    // every normal string value.
    if (first === 0x7B || first === 0x5B) {
      try {
        const parsed = JSON.parse(value);
        if (parsed !== null && typeof parsed === 'object') {
          const children = renderJsonValue(parsed, depth + 1);
          const tag = `<span class="muted">${escapeText(t('ui.tree.parsedJson'))}</span>`;
          return { inline: tag, children };
        }
      } catch { /* fall through to escaped-string view */ }
    }
  }
  return leaf(`= <code>${escapeText(JSON.stringify(value))}</code>`);
}

/**
 * Recursively render a parsed-JSON value (plain JS object / array /
 * primitive) as property-tree rows. Used by renderStrValue to expand
 * embedded JSON payloads inside StrProperty values.
 *
 * Returns the inner HTML — call sites wrap it in `<div class="prop-children">…</div>`
 * (which `detailsOrLeaf` does via the `children` field).
 */
function renderJsonValue(value, depth) {
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      renderJsonChild(`[${i}]`, v, depth),
    ).join('');
  }
  return Object.entries(value).map(([k, v]) =>
    renderJsonChild(escapeText(k), v, depth),
  ).join('');
}

function renderJsonChild(nameHtml, value, depth) {
  if (value === null) {
    return renderSyntheticRow(nameHtml, `= <code>null</code>`, '', depth);
  }
  const ty = typeof value;
  if (ty === 'number' || ty === 'boolean') {
    return renderSyntheticRow(nameHtml, `= <code>${value}</code>`, '', depth);
  }
  if (ty === 'string') {
    return renderSyntheticRow(nameHtml, `= <code>${escapeText(JSON.stringify(value))}</code>`, '', depth);
  }
  if (ty === 'object') {
    // Recurse via renderJsonValue. The synthetic row's inline shows the
    // shape (array length / object key count) so collapsed nodes still
    // hint at what's inside.
    const summary = Array.isArray(value)
      ? `<span class="muted">[${value.length}]</span>`
      : `<span class="muted">{${Object.keys(value).length}}</span>`;
    const children = renderJsonValue(value, depth + 1);
    return renderSyntheticRow(nameHtml, summary, children, depth);
  }
  // Fallback for unexpected types (function, bigint, undefined). Shouldn't
  // happen from JSON.parse output, but cheap to be defensive.
  return renderSyntheticRow(nameHtml, `= <code>${escapeText(String(value))}</code>`, '', depth);
}

/**
 * Render a Guid string as a clickable jump link when the configured
 * ReferencesService knows about a row whose `SelfUid` matches it;
 * otherwise render it as a plain monospace value (no link) and mark
 * the leaf as unresolved so styling can call it out as muted.
 *
 * The delegated click handler in `installDelegate` reads `data-serial`
 * off the resolved link and calls `_onGuidClick(serial)`.
 */
function renderGuidValue(guid) {
  const target = _references ? _references.rowBySelfUid(guid) : null;
  if (target != null) {
    const titleStr = t('ui.guid.jumpTo', {
      serial: target,
      default: 'Jump to row #{serial}',
    });
    return `<a href="#" class="prop-guid resolved" `
      + `data-guid="${escapeAttr(guid)}" data-serial="${target}" `
      + `title="${escapeAttr(titleStr)}">`
      + `<code>${escapeText(guid)}</code>`
      + ` <span class="muted">→ #${target}</span></a>`;
  }
  const unresolvedTitle = _references
    ? t('ui.guid.notLoaded', { default: 'No loaded row claims this SelfUid' })
    : '';
  const titleAttr = unresolvedTitle ? ` title="${escapeAttr(unresolvedTitle)}"` : '';
  return `<code class="prop-guid unresolved" data-guid="${escapeAttr(guid)}"${titleAttr}>`
    + `${escapeText(guid)}</code>`;
}

function renderStructValue(sv, depth) {
  if (!sv) return leaf(`<span class="muted">${escapeText(t('ui.tree.emptyStruct'))}</span>`);
  const name = sv._structName;
  // Known-binary struct: render compactly. Guid is special-cased into a
  // jump link when a ReferencesService is configured — every GUID is a
  // potential pointer to another row's `SelfUid`.
  if (STRUCT_HANDLERS[name]) {
    if (name === 'Guid' && typeof sv.value === 'string') {
      return leaf(`= ${renderGuidValue(sv.value)}`);
    }
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
  const hasElements = value && value.elements && value.elements.length > 0;
  const hasTrailing = value && value._trailing;
  if (!hasElements && !hasTrailing) {
    return leaf(`<span class="muted">[]</span>`);
  }
  const innerType = tag.innerType.value;
  // Show inline if elements are tiny primitives and the array is small.
  const isShortPrim = hasElements && !hasTrailing && value.elements.length <= 8
    && ['IntProperty','FloatProperty','BoolProperty','NameProperty','StrProperty'].includes(innerType);
  if (isShortPrim) {
    return leaf(`= <code>${escapeText(JSON.stringify(value.elements.map(stringifyForInline)))}</code>`);
  }
  const childDepth = depth + 1;
  const isObjType = innerType === 'ObjectProperty' || innerType === 'ClassProperty'
    || innerType === 'WeakObjectProperty' || innerType === 'LazyObjectProperty'
    || innerType === 'WSObjectProperty';
  const renderItem = (e, i) => {
    if (innerType === 'StructProperty') {
      const { inline, children } = renderStructValue(e, childDepth);
      return renderSyntheticRow(`[${i}]`, inline, children, childDepth);
    }
    if (isObjType) {
      const { inline, children } = renderObjectRefValue(e, childDepth);
      return renderSyntheticRow(`[${i}]`, inline, children, childDepth);
    }
    return renderSyntheticRow(`[${i}]`, `= <code>${escapeText(stringifyForInline(e))}</code>`, '', childDepth);
  };
  let children = hasElements ? renderCappedItems(value.elements, renderItem, childDepth) : '';
  let inlineExtra = '';
  if (hasTrailing) {
    children += renderArrayTrailing(value._trailing, childDepth);
    if (value._trailing._raw) {
      inlineExtra = ` <span class="muted">+ trailing ${value._trailing._raw.length} B raw</span>`;
    } else {
      const counts = value._trailing.sections.map(s => s.count).join('/');
      inlineExtra = ` <span class="muted">+ trailing (${counts})</span>`;
    }
  }
  const inline = hasElements
    ? `<span class="muted">${escapeText(t('ui.tree.items', { count: value.elements.length }))}</span>${inlineExtra}`
    : `<span class="muted">[]</span>${inlineExtra}`;
  return { inline, children };
}

// Render the Soulmask trailing binary for ArrayProperty<ObjectProperty>:
//   origin (Vector) + N self-describing sections (stride/count/data).
// See readObjectArrayTrailing in lib/unreal/properties.mjs for the format.
function renderArrayTrailing(trailing, depth) {
  if (trailing._raw) {
    const inline = `<span class="muted">${trailing._raw.length} B raw — parse failed: ${escapeText(trailing._parseError || '?')}</span>`;
    return renderSyntheticRow(`<span class="muted">trailing</span>`, inline, '', depth);
  }
  const parts = [];
  const { x, y, z } = trailing.origin;
  if (x !== 0 || y !== 0 || z !== 0) {
    parts.push(renderSyntheticRow('origin', `= <code>(${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)})</code>`, '', depth + 1));
  }
  for (let i = 0; i < trailing.sections.length; i++) {
    parts.push(renderTrailingSection(trailing.sections[i], i, depth + 1));
  }
  const counts = trailing.sections.map(s => s.count).join('/');
  const inline = `<span class="muted">${trailing.sections.length} sections (${counts})</span>`;
  return renderSyntheticRow(`<span class="muted">trailing</span>`, inline, parts.join(''), depth);
}

function renderTrailingSection(section, idx, depth) {
  const { stride, count, data } = section;
  const childDepth = depth + 1;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let renderItem, labelKind;
  if (stride === 64) {
    // 4×4 FMatrix (row-major). Translation lives at floats[12..14].
    labelKind = 'transforms';
    renderItem = (_, i) => {
      const o = i * 64;
      const tx = dv.getFloat32(o + 48, true).toFixed(2);
      const ty = dv.getFloat32(o + 52, true).toFixed(2);
      const tz = dv.getFloat32(o + 56, true).toFixed(2);
      const rows = [];
      for (let r = 0; r < 4; r++) {
        const cols = [];
        for (let c = 0; c < 4; c++) cols.push(dv.getFloat32(o + (r*4 + c)*4, true).toPrecision(6));
        rows.push(renderSyntheticRow(`m[${r}]`, `= <code>(${cols.join(', ')})</code>`, '', childDepth + 1));
      }
      const inline = `<span class="muted">trans</span> <code>(${tx}, ${ty}, ${tz})</code>`;
      return renderSyntheticRow(`[${i}]`, inline, rows.join(''), childDepth);
    };
  } else if (stride === 4) {
    labelKind = 'u32 ids';
    renderItem = (_, i) => {
      const v = dv.getUint32(i * 4, true);
      return renderSyntheticRow(`[${i}]`, `= <code>${v}</code>`, '', childDepth);
    };
  } else {
    labelKind = `stride=${stride}`;
    renderItem = (_, i) => {
      const o = i * stride;
      const sample = Array.from(data.slice(o, o + Math.min(stride, 16))).map(b => b.toString(16).padStart(2,'0')).join(' ');
      return renderSyntheticRow(`[${i}]`, `<code class="muted">${sample}${stride > 16 ? '…' : ''}</code>`, '', childDepth);
    };
  }
  const items = renderCappedItems(new Array(count).fill(null), renderItem, childDepth);
  const inline = `<span class="muted">${labelKind} (${count})</span>`;
  return renderSyntheticRow(`section[${idx}]`, inline, items, depth);
}

function renderSetValue(_tag, value, depth) {
  const elements = value.elements || [];
  if (elements.length === 0) {
    return leaf(`<span class="muted">${escapeText(t('ui.tree.setItems', { count: 0 }))}</span>`);
  }
  const childDepth = depth + 1;
  const renderItem = (e, i) =>
    renderSyntheticRow(`{${i}}`, `= <code>${escapeText(stringifyForInline(e))}</code>`, '', childDepth);
  return {
    inline: `<span class="muted">${escapeText(t('ui.tree.setItems', { count: elements.length }))}</span>`,
    children: renderCappedItems(elements, renderItem, childDepth),
  };
}

function renderMapValue(_tag, value, depth) {
  const entries = value.entries || [];
  if (entries.length === 0) {
    return leaf(`<span class="muted">${escapeText(t('ui.tree.entries', { count: 0 }))}</span>`);
  }
  const childDepth = depth + 1;
  const renderItem = (e /*, i */) => {
    const keyHtml = renderMapPartInline(e.key);
    const valShape = renderMapValueShape(e.value, childDepth);
    return renderSyntheticRow(keyHtml, valShape.inline, valShape.children, childDepth);
  };
  return {
    inline: `<span class="muted">${escapeText(t('ui.tree.entries', { count: entries.length }))}</span>`,
    children: renderCappedItems(entries, renderItem, childDepth),
  };
}

/**
 * Inline HTML for the key (or a simple value) of a map entry. Guid-shaped
 * strings render as jump links so a Map<Guid, _> entry's key becomes
 * clickable navigation to the target row. Everything else falls back to
 * the existing inline-stringify path.
 */
function renderMapPartInline(value) {
  if (typeof value === 'string' && GUID_RE.test(value)) return renderGuidValue(value);
  return `<code>${escapeText(stringifyForInline(value))}</code>`;
}

/**
 * Shape for a map entry's value column:
 *   StructValue (Soulmask "map value" = nested property stream)
 *      → render the nested properties as expandable children, mirroring
 *        the StructProperty render path. Without this, `value.value`
 *        (the whole property array) used to land inside JSON.stringify
 *        and dumped a multi-KB inline blob.
 *   Guid-shaped string
 *      → jump link.
 *   anything else
 *      → existing inline-stringify path.
 */
function renderMapValueShape(value, depth) {
  if (value instanceof StructValue && Array.isArray(value.value)) {
    const inner = value.value.map((p, i) => renderPropertyEntry(p, i, depth + 1)).join('');
    return {
      inline:   ` <span class="muted">${escapeText(t('ui.tree.items', { count: value.value.length }))}</span>`,
      children: inner,
    };
  }
  if (typeof value === 'string' && GUID_RE.test(value)) {
    return { inline: ` → ${renderGuidValue(value)}`, children: '' };
  }
  return { inline: ` → <code>${escapeText(stringifyForInline(value))}</code>`, children: '' };
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
