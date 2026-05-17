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
import { STRUCT_HANDLERS } from '../lib/unreal/structs.mjs';

const t = (k, opts) => i18n.t(k, opts);

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
  // renderPropertyTree calls.
  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('.show-more-link');
    if (!link) return;
    e.preventDefault();
    const row = link.closest('.prop-show-more');
    if (!row) return;
    const id = row.dataset.stash;
    const renderFn = _lazyStash.get(id);
    if (!renderFn) { row.remove(); return; }
    _lazyStash.delete(id);
    // outerHTML replacement: lets the new rows (which may themselves
    // contain show-more links for further-truncated nested collections)
    // splice into the same depth/padding position the placeholder held.
    row.outerHTML = renderFn();
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

function propertyTypeLabel(tag) {
  const ty = tag.type.value;
  if (ty === 'StructProperty') return `StructProperty (${tag.structName.value})`;
  if (ty === 'ArrayProperty')  return `ArrayProperty&lt;${tag.innerType.value}&gt;`;
  if (ty === 'SetProperty')    return `SetProperty&lt;${tag.innerType.value}&gt;`;
  if (ty === 'MapProperty')    return `MapProperty&lt;${tag.innerType.value}, ${tag.valueType.value}&gt;`;
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
      return leaf(`<span class="muted">${escapeText(t('ui.tree.text', { bytes: value && value._opaque ? value._opaque.length : 0 }))}</span>`);
    default:
      return leaf(`<span class="muted">${escapeText(t('ui.tree.value', { type: propType }))}</span>`);
  }
}

function renderStructValue(sv, depth) {
  if (!sv) return leaf(`<span class="muted">${escapeText(t('ui.tree.emptyStruct'))}</span>`);
  const name = sv._structName;
  // Known-binary struct: render compactly.
  if (STRUCT_HANDLERS[name]) {
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
  const childDepth = depth + 1;
  const renderItem = (e, i) => {
    if (innerType === 'StructProperty') {
      const { inline, children } = renderStructValue(e, childDepth);
      return renderSyntheticRow(`[${i}]`, inline, children, childDepth);
    }
    return renderSyntheticRow(`[${i}]`, `= <code>${escapeText(stringifyForInline(e))}</code>`, '', childDepth);
  };
  return {
    inline: `<span class="muted">${escapeText(t('ui.tree.items', { count: value.elements.length }))}</span>`,
    children: renderCappedItems(value.elements, renderItem, childDepth),
  };
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
    const keyHtml = `<code>${escapeText(stringifyForInline(e.key))}</code>`;
    const valInline = ` → <code>${escapeText(stringifyForInline(e.value))}</code>`;
    return renderSyntheticRow(keyHtml, valInline, '', childDepth);
  };
  return {
    inline: `<span class="muted">${escapeText(t('ui.tree.entries', { count: entries.length }))}</span>`,
    children: renderCappedItems(entries, renderItem, childDepth),
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
