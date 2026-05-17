/**
 * RowTable — DataTables-backed view over `actor_table` rows.
 *
 * Owns the table DOM (`#rowsTable`), its surrounding controls (`#search`,
 * `#kindFilter`, `#filterCount`, `#anchorAtBtn`, `#anchorChip`), and the
 * canonical `allRows` list that the rest of the UI used to read off
 * app.mjs. Also owns selection state and the spatial-anchor filter so
 * those stay coherent with the visible rows.
 *
 * Subscribes directly to:
 *   - orchestrator 'rows-ready'  → take ownership of the row list
 *   - data service  'unloaded'   → clear the table
 *   - search service 'batch' / 'done' / 'reset' → redraw so newly-indexed
 *     rows pick up blob-haystack matches
 *
 * Emits:
 *   'row-selected'   { serial }     row clicked or programmatically selected
 *   'row-deselected' { }            selection cleared
 *   'rows-replaced'  { rows, label, serverId }  rebroadcast of rows-ready,
 *                                   so the host can update summary / Steam /
 *                                   chrome from the same source of truth
 *
 * Public surface (used by app.mjs and the partials ctx):
 *   rows()                  → the underlying array (do not mutate directly)
 *   count()                 → rows().length
 *   findRow(serial)         → row or null
 *   selectedSerial()        → number | null
 *   isAnchoredOn(serial)    → bool
 *   hasAnchor()             → bool
 *   anchor()                → current anchor descriptor or null
 *   setSelection(serial)    → highlight + emit row-selected
 *   clearSelection()        → emit row-deselected
 *   setRowAsAnchor(row)     → derives pos from row.actor_transf
 *   setCustomAnchor()       → null-serial anchor at origin, focuses pos input
 *   clearAnchor()           → drops anchor + redraws
 *   upsertRow(row)          → insert-or-replace by actor_serial, redraws
 *   removeRow(serial)       → drop by serial, clears selection if it matched
 *   redraw()                → DT draw(false) — keeps page/sort
 *   refresh()               → DT draw() — resets to page 1
 */

import $ from 'jquery';
import DataTable from 'datatables.net-dt';
// Side-effect imports: register the ColumnControl + ColReorder features
// on the DataTable already imported above. The -dt variants pull in the
// core extension and apply the matching default-theme styles (CSS links
// in index.html). ColumnControl drives the per-column header menu (sort,
// per-column search, etc.) and ColReorder lets the picker dialog move
// columns left/right via dt.colReorder.move().
import 'datatables.net-columncontrol-dt';
import 'datatables.net-colreorder-dt';
import { escapeText, escapeAttr, debounce, fmtBytes } from './util.mjs';
import { deriveName } from '../lib/unreal/facts.mjs';

// Register a plain-text search content type with ColumnControl. The
// stock `searchText` always renders an operator <select> ("Contains",
// "Equals", "Starts", "Ends", "Empty", "Not empty", …). For columns
// whose values are short identifiers (e.g. actor_serial), the operators
// don't carry their weight — a single textbox that filters
// case-insensitively by substring is what the user wants. Behaviour
// matches FixedSearch: writes to `column.search.fixed('dtcc', term)`
// so it composes with the built-in extension search slot the other
// content types use.
if (DataTable.ColumnControl && !DataTable.ColumnControl.content.searchPlain) {
  DataTable.ColumnControl.content.searchPlain = {
    defaults: {
      placeholder: '',
      className: 'dtcc-content dtcc-searchPlain',
    },
    init(config) {
      const dt = this.dt();
      const colIdx = this.idx();
      const wrapper = document.createElement('div');
      wrapper.className = config.className;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'dtcc-input';
      if (config.placeholder) input.placeholder = config.placeholder;
      wrapper.appendChild(input);
      const apply = () => {
        const v = input.value || '';
        dt.column(colIdx).search.fixed('dtcc', v.length ? v.toLowerCase() : '');
        dt.draw();
      };
      input.addEventListener('input', apply);
      return wrapper;
    },
  };
}

const PAGE_SIZE = 200;

export class RowTable {
  constructor({ tableId = 'rowsTable' } = {}) {
    this._tableId  = tableId;

    this._orch     = null;
    this._search   = null;
    this._classify = null;
    this._steam    = null;
    this._i18n     = null;
    this._data     = null;

    this._allRows = [];
    this._currentFileLabel = null;
    this._currentServerId  = null;

    this._selectedSerial = null;
    this._anchor         = null;   // { serial, label, pos: [x,y,z], rangeMeters }

    // Relationship filter — set by app.mjs in response to a "show owned NPCs",
    // "show built by", etc. detail-panel button. When non-null, the custom
    // search predicate hides every row whose serial isn't in `serials`.
    // `originSerial` is the row whose relationships this filter expresses;
    // we use it to clear the filter automatically if that row's selection
    // moves off, and to render a useful chip label.
    this._relationshipFilter = null;   // { label, kind, originSerial, serials: Set<number> }

    // Kind filter — driven by the summary pills above the filter input
    // (app.mjs makes them clickable). We track the selected set here so
    // pill rendering can show an "active" state, and we sync the kind
    // column's ColumnControl `searchList` to match — the column dropdown
    // and the pill row stay in step.
    this._selectedKinds = new Set();

    this._listeners = new Set();
    this._dtApi     = null;
    this._initialized = false;

    // Re-apply filters after a burst of blob-indexing batches lands.
    this._refreshOnIndex = debounce(() => this._dtApi?.draw(false), 150);
    // Re-render after name facts stream in from workers.
    this._refreshOnFacts = debounce(() => this._dtApi?.draw(false), 200);
  }

  // ---- lifecycle ---------------------------------------------------------

  /**
   * Receive dependencies and wire up the table DOM / controls / event
   * subscriptions. Idempotent. Called by Orchestrator.init().
   *
   * @param {object} deps
   * @param {Orchestrator}  deps.orchestrator subscribed for 'rows-ready'
   * @param {SearchService} deps.search       drives the haystack matches
   * @param {DataService}   deps.dataService  subscribed for 'unloaded'
   * @param {object}        deps.classify     classify + parseTransform helpers
   * @param {object}        deps.steam        isSteamId64 / displayName
   * @param {object}        deps.i18n         { t(key, opts?) }
   */
  async init({ orchestrator, search, dataService, classify, steam, i18n } = {}) {
    if (this._initialized) return;
    if (!orchestrator) throw new Error('RowTable.init: orchestrator is required');
    if (!search)       throw new Error('RowTable.init: search is required');
    if (!classify)     throw new Error('RowTable.init: classify is required');
    if (!steam)        throw new Error('RowTable.init: steam is required');
    if (!i18n)         throw new Error('RowTable.init: i18n is required');
    if (!dataService)  throw new Error('RowTable.init: dataService is required');

    this._orch     = orchestrator;
    this._search   = search;
    this._classify = classify;
    this._steam    = steam;
    this._i18n     = i18n;
    this._data     = dataService;
    this._initialized = true;

    const tableEl = document.getElementById(this._tableId);
    if (!tableEl) throw new Error(`RowTable: #${this._tableId} not found`);

    this._registerCustomSearch();
    this._buildTable(tableEl);
    this._wireControls();
    this._subscribe();
  }

  addListener(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(event, data) {
    for (const fn of this._listeners) {
      try { fn(event, data); }
      catch (e) { console.error('RowTable listener threw:', e); }
    }
  }

  // ---- public accessors --------------------------------------------------

  rows()          { return this._allRows; }
  count()         { return this._allRows.length; }
  findRow(serial) { return this._allRows.find(r => r.actor_serial === serial) || null; }
  selectedSerial(){ return this._selectedSerial; }
  hasAnchor()     { return !!this._anchor; }
  isAnchoredOn(serial) { return !!this._anchor && this._anchor.serial === serial; }
  anchor()        { return this._anchor; }
  relationshipFilter() { return this._relationshipFilter; }
  currentFileLabel() { return this._currentFileLabel; }
  currentServerId()  { return this._currentServerId; }
  selectedKinds() { return new Set(this._selectedKinds); }

  /**
   * Toggle a single kind in the kind-column filter. Updates our internal
   * state, syncs the kind column's ColumnControl `searchList` so its
   * dropdown checkboxes mirror the pill row, and re-draws the table.
   * Emits `kind-filter-changed` with the new set so app.mjs can update
   * the pill row's active states.
   *
   * Kept in row-table because the column-index ↔ ColumnControl wiring
   * lives here. app.mjs's pill row is the only caller today.
   */
  toggleKindFilter(kind) {
    if (this._selectedKinds.has(kind)) this._selectedKinds.delete(kind);
    else                                this._selectedKinds.add(kind);
    this._applyKindFilterToColumn();
    this._emit('kind-filter-changed', { kinds: new Set(this._selectedKinds) });
  }

  clearKindFilter() {
    if (this._selectedKinds.size === 0) return;
    this._selectedKinds.clear();
    this._applyKindFilterToColumn();
    this._emit('kind-filter-changed', { kinds: new Set() });
  }

  /**
   * Push `this._selectedKinds` into the kind column's ColumnControl
   * searchList. Strategy:
   *   1. `column.columnControl.searchClear()` deselects every checkbox
   *      (via the `cc-search-clear` event the CheckList listens to) and
   *      drops the `dtcc-list` fixed search.
   *   2. If we have anything to select, fire a synthetic `stateLoaded.DT`
   *      event with `{ columnControl: { 2: { searchList: [...] } } }`.
   *      The searchList init wires a `stateLoaded` listener that calls
   *      `checkList.values(values)` + `applySearch(values)` — exactly the
   *      sync we'd otherwise have to reach into private state to do. The
   *      idx-2 key is the original column index (kind), which is stable
   *      under colReorder because `getState()` uses `idxOriginal()`.
   */
  _applyKindFilterToColumn() {
    const dt = this._dtApi;
    if (!dt) return;
    const kindCol = dt.column('kind:name');
    kindCol.columnControl.searchClear();
    if (this._selectedKinds.size > 0) {
      // `getState` inside the searchList listener reads the state by
      // `idxOriginal()`. ColReorder reorders `aoColumns` in place,
      // stamping `_crOriginalIdx` on each column to preserve the
      // original position — that's the index we need here. (`column().index()`
      // returns the *current* display index, which would be wrong after
      // a reorder.) `colReorder.transpose(displayIdx, 'toOriginal')`
      // is the supported way to convert.
      const kindDisplay = kindCol.index();
      const kindOriginal = dt.colReorder
        ? dt.colReorder.transpose(kindDisplay, 'toOriginal')
        : kindDisplay;
      const state = {
        columnControl: { [kindOriginal]: { searchList: Array.from(this._selectedKinds) } },
      };
      // dt.on('stateLoaded', …) auto-adds the `.dt` jQuery namespace
      // (see datatables.net's _api_register for 'on()'), and it binds
      // the listener to `this.tables().nodes()`. Trigger on the same
      // jQuery set, namespace-less, so the searchList listener fires.
      $(dt.tables().nodes()).trigger('stateLoaded', [dt.settings()[0], state]);
    }
    dt.draw();
  }

  // ---- mutators ----------------------------------------------------------

  /**
   * Apply name facts from a worker decode batch. Each item is `{serial, manifest}`.
   * Updates `row._name` for rows that have player-set names and schedules a
   * debounced redraw so the Name column picks them up as they stream in.
   */
  absorbFacts(items) {
    if (!Array.isArray(items)) return;
    let changed = false;
    for (const { serial, manifest } of items) {
      if (!manifest?.facts) continue;
      const name = deriveName(manifest.facts);
      if (!name) continue;
      const row = this.findRow(serial);
      if (!row || row._name === name) continue;
      row._name = name;
      changed = true;
    }
    if (changed) this._refreshOnFacts();
  }

  upsertRow(row) {
    const serial = row.actor_serial;
    const idx = this._allRows.findIndex(r => r.actor_serial === serial);
    if (idx >= 0) {
      this._allRows[idx] = row;
    } else {
      // Keep serial-sorted insertion for stable default ordering.
      let insertAt = this._allRows.length;
      for (let i = 0; i < this._allRows.length; i++) {
        if (this._allRows[i].actor_serial > serial) { insertAt = i; break; }
      }
      this._allRows.splice(insertAt, 0, row);
    }
    this._stampDistance(row);
    this._reloadDtData({ preservePaging: true });
  }

  removeRow(serial) {
    const idx = this._allRows.findIndex(r => r.actor_serial === serial);
    if (idx < 0) return;
    this._allRows.splice(idx, 1);
    if (this._selectedSerial === serial) this.clearSelection();
    this._reloadDtData({ preservePaging: true });
  }

  setSelection(serial) {
    if (this._selectedSerial === serial) {
      // Re-emit so app.mjs can re-render the detail panel on edits.
      this._emit('row-selected', { serial });
      return;
    }
    this._selectedSerial = serial;
    this._dtApi?.draw(false);
    this._emit('row-selected', { serial });
  }

  clearSelection() {
    if (this._selectedSerial == null) return;
    this._selectedSerial = null;
    this._dtApi?.draw(false);
    this._emit('row-deselected', {});
  }

  /**
   * Constrain the visible row set to the given `serials`. Caller usually
   * builds the set from a ReferencesService query (e.g. referrersOf the
   * selected row's SelfUid, optionally filtered by property path). The
   * filter is independent of the text search + kind filter — they
   * intersect.
   *
   * @param {object} opts
   * @param {string} opts.label        chip label shown in the controls bar
   * @param {string} [opts.kind]       informational tag (e.g. 'owned',
   *                                   'built', 'guild', 'all') — surfaced
   *                                   to listeners that want to label
   *                                   active-button state.
   * @param {number} [opts.originSerial] the row this filter was derived
   *                                   from. Lets a future "follow
   *                                   selection" mode auto-clear when the
   *                                   user navigates elsewhere.
   * @param {Iterable<number>} opts.serials
   */
  setRelationshipFilter({ label, kind = null, originSerial = null, serials } = {}) {
    const set = serials instanceof Set ? serials : new Set(serials || []);
    this._relationshipFilter = { label, kind, originSerial, serials: set };
    this._renderRelationshipChip();
    this._dtApi?.draw();
    this._emit('relationship-filter-changed', { active: true, label, kind, originSerial, count: set.size });
  }

  clearRelationshipFilter() {
    if (!this._relationshipFilter) return;
    this._relationshipFilter = null;
    this._renderRelationshipChip();
    this._dtApi?.draw();
    this._emit('relationship-filter-changed', { active: false });
  }

  setRowAsAnchor(row) {
    const tx = this._classify.parseTransform(row.actor_transf);
    if (!tx) return false;
    this._anchor = {
      serial: row.actor_serial,
      label:  row._label || ('#' + row.actor_serial),
      pos:    tx.pos,
      rangeMeters: this._anchor ? this._anchor.rangeMeters : 100,
    };
    this._applyAnchorChange();
    return true;
  }

  setCustomAnchor() {
    if (!this._anchor) {
      this._anchor = {
        serial: null,
        label:  this._t('ui.anchor.customLabel'),
        pos:    [0, 0, 0],
        rangeMeters: 100,
      };
      this._applyAnchorChange();
    }
    // Defer focus to after the chip is in the DOM.
    setTimeout(() => {
      const el = document.getElementById('anchorPosX');
      if (el) { el.focus(); el.select(); }
    }, 0);
  }

  clearAnchor() {
    if (!this._anchor) return;
    const wasSerial = this._anchor.serial;
    this._anchor = null;
    this._applyAnchorChange();
    // If the previously-anchored row is currently selected, re-emit the
    // selection so the detail panel's anchor button label flips back.
    if (wasSerial != null && this._selectedSerial === wasSerial) {
      this._emit('row-selected', { serial: wasSerial });
    }
  }

  redraw()  { this._dtApi?.draw(false); }
  refresh() { this._dtApi?.draw(); }

  // ---- internal: DataTables wiring --------------------------------------

  _buildTable(tableEl) {
    const lang = this._t.bind(this);

    this._dtApi = new DataTable(tableEl, {
      data: this._allRows,
      paging: true,
      pageLength: PAGE_SIZE,
      lengthChange: false,
      searching: true,          // we drive the search via custom ext.search
      info: false,
      ordering: true,
      autoWidth: false,
      // Only render pagination; the search input lives in the page chrome.
      layout: {
        topStart: null, topEnd: null,
        bottomStart: null, bottomEnd: 'paging',
      },
      language: {
        emptyTable:   lang('ui.tableEmpty'),
        zeroRecords:  lang('ui.tableEmpty'),
        paginate: {
          first:    lang('ui.pagination.first'),
          previous: lang('ui.pagination.prev'),
          next:     lang('ui.pagination.next'),
          last:     lang('ui.pagination.last'),
        },
      },
      order: [[0, 'asc']],
      // Per-column controls (DataTables ColumnControl): a sort toggle
      // icon plus a search-dropdown that filters by substring on the
      // column's displayed value. Column visibility is handled separately
      // via the "columns…" picker (`_wireColumnsPicker`) so `colVis` is
      // deliberately not in this list. The search content auto-detects
      // the column type — for the time column we force `searchText`
      // semantics below via `type: 'string'` so the user can type a
      // partial UTC string ("2026-05-13", "08:03") and have it match
      // by substring instead of the heavier datetime picker.
      columnControl: ['order', 'searchDropdown'],
      // Enables column reordering. We don't surface drag-to-reorder in
      // the headers — the picker dialog calls `dt.colReorder.move()`.
      // `enable: false` so the drag UI is dormant; the API still works.
      colReorder: { enable: false },
      columns: this._buildColumns(),
      createdRow: (tr, rowData) => {
        tr.dataset.serial = rowData.actor_serial;
      },
      rowCallback: (tr, rowData) => {
        tr.classList.toggle('selected', rowData.actor_serial === this._selectedSerial);
      },
      drawCallback: () => this._renderFilterCount(),
    });

    // Distance column starts hidden; anchor toggles it on.
    this._dtApi.column(1).visible(false, false);

    // Row click → selection. Delegate so it survives every redraw.
    $(tableEl).on('click.rowtable', 'tbody tr[data-serial]', (evt) => {
      const serial = parseInt(evt.currentTarget.dataset.serial, 10);
      if (Number.isFinite(serial)) this.setSelection(serial);
    });
  }

  /**
   * Column definitions. Distance (index 1) is hidden until an anchor is
   * set; we keep its slot in place so other column indices don't shift
   * when toggling. `orderable: false` on the visual-only columns avoids
   * surprising sort behavior on header click.
   */
  _buildColumns() {
    const t = this._t.bind(this);
    return [
      {
        // 0: serial — sortable, default sort. Uses the plain-textbox
        // search content (no operator <select>); operators like "Greater
        // than" / "Equals" don't carry their weight for a short integer
        // identifier — users just want to type a number / digits and
        // have rows that contain them surface.
        title: t('ui.tableHeader.serial'),
        data:  'actor_serial',
        type:  'num',
        columnControl: [
          'order',
          {
            extend: 'dropdown', icon: 'search',
            content: [{ extend: 'searchPlain', placeholder: 'serial #' }],
          },
        ],
        render: (data) => escapeText(data),
      },
      {
        // 1: distance (anchored mode only)
        title: t('ui.tableHeader.distance'),
        data:  null,
        type:  'num',
        orderable: true,
        className: 'muted',
        render: (data, type, row) => {
          if (row._spatialDist == null) return '';
          if (type === 'sort' || type === 'type') return row._spatialDist;
          return row._spatialDist.toFixed(1) + ' m';
        },
      },
      {
        // 2: kind pill. Search here is a check-list of the distinct
        // `_kind` values present in the table (replaces the old
        // free-standing "all kinds / system / player / …" dropdown that
        // used to live in the controls bar). The dropdown auto-populates
        // from row data via `settings.fastData(row, idx, 'display')` —
        // which is the rendered pill HTML — so each checkbox label
        // renders as its pill. `name: 'kind'` lets the summary-pill
        // wiring (`_applyKindFilterToColumn`) and the searchList refresh
        // address this column by name, surviving column reorders without
        // chasing a moving display index.
        name:  'kind',
        title: t('ui.tableHeader.kind'),
        data:  '_kind',
        orderable: false,
        columnControl: [
          'order',
          {
            extend: 'dropdown', icon: 'search',
            content: [{ extend: 'searchList' }],
          },
        ],
        render: (data) => {
          const label = t('ui.kind.' + data, { default: data });
          return `<span class="pill ${escapeAttr(data)}">${escapeText(label)}</span>`;
        },
      },
      {
        // 3: player-set name (JianZhuDisplayName, CurGaoShiString, NPC notes).
        // Populated asynchronously as decode workers stream in manifests.
        name:  'name',
        title: t('ui.tableHeader.name'),
        data:  '_name',
        orderable: false,
        columnControl: [
          {
            extend: 'dropdown', icon: 'search',
            content: [{ extend: 'searchPlain', placeholder: 'name' }],
          },
        ],
        render: (data, type) => {
          if (type !== 'display') return data || '';
          return data ? escapeText(data) : '';
        },
      },
      {
        // 4: class (label + optional Steam display name)
        title: t('ui.tableHeader.class'),
        data:  '_label',
        orderable: false,
        render: (data, type, row) => {
          if (type !== 'display') return data || '';
          const nameLabel = this._steam.isSteamId64(row.actor_name)
            ? (this._steam.displayName(row.actor_name) || '')
            : '';
          const titleAttr = escapeAttr(row.actor_script || '');
          const base = escapeText(data || '');
          const suffix = nameLabel ? ` <span class="muted">— ${escapeText(nameLabel)}</span>` : '';
          return `<span title="${titleAttr}">${base}${suffix}</span>`;
        },
      },
      {
        // 4: summary
        title: t('ui.tableHeader.summary'),
        data:  '_summary',
        orderable: false,
        render: (data, type) => {
          if (type !== 'display') return data || '';
          return `<span title="${escapeAttr(data || '')}">${escapeText(data || '')}</span>`;
        },
      },
      {
        // 5: owner — hidden by default; users can toggle it back on via
        // the per-column dropdown menu's "Column visibility" sub-list.
        title: t('ui.tableHeader.owner'),
        data:  'actor_owner',
        orderable: false,
        visible:   false,
        className: 'muted',
        render: (data, type) => {
          if (type !== 'display') return data || '';
          return `<span title="${escapeAttr(data || '')}">${escapeText(data || '')}</span>`;
        },
      },
      {
        // 6: blob size
        title: t('ui.tableHeader.blob'),
        data:  'blob_size',
        type:  'num',
        orderable: false,
        className: 'muted',
        render: (data, type) => {
          if (type === 'sort' || type === 'type') return data || 0;
          return fmtBytes(data || 0);
        },
      },
      {
        // 7: time — UTC. We force `type: 'string'` so the ColumnControl
        // `searchDropdown` falls through to a plain text input (matches
        // by substring on the rendered "2026-05-13 04:56:15" form)
        // rather than the heavier datetime picker that the auto-detector
        // would otherwise pick. Per-column override sets a placeholder
        // that calls out the UTC interpretation so users know what they
        // are typing against.
        title: t('ui.tableHeader.time'),
        data:  'actor_time',
        type:  'string',
        orderable: false,
        className: 'muted',
        columnControl: [
          'order',
          {
            extend: 'searchDropdown',
            placeholder: 'YYYY-MM-DD HH:MM (UTC)',
          },
        ],
        render: (data) => escapeText(data || ''),
      },
    ];
  }

  /**
   * Single custom search filter covering: kind filter, free-text query
   * (across the same columns the old applyFilters did, plus the blob
   * haystack via SearchService.matches), and spatial-anchor range.
   *
   * Registered once globally and discriminated by tableId so multiple
   * RowTable instances on a page would coexist (currently just one).
   */
  _registerCustomSearch() {
    const ext = $.fn.dataTable.ext.search;
    const tableId = this._tableId;
    // Idempotent: skip if we've already registered ours.
    if (ext.some(fn => fn._rowTableTag === tableId)) return;

    const filter = (settings, _renderedData, _index, rowData) => {
      if (!settings.nTable || settings.nTable.id !== tableId) return true;
      // Relationship filter is an explicit allow-list, so it short-circuits
      // first — hides every row whose serial isn't in the set, regardless
      // of text search / kind / anchor. The other filters still apply on
      // top of it (intersection semantics) so a user can text-search
      // inside the relationship subset.
      if (this._relationshipFilter && !this._relationshipFilter.serials.has(rowData.actor_serial)) {
        return false;
      }
      const q = (this._queryStr || '').toLowerCase();
      if (this._anchor) {
        if (rowData._spatialDist == null) return false;
        if (rowData._spatialDist > this._anchor.rangeMeters) return false;
      }
      if (!q) return true;
      if (String(rowData.actor_serial) === q) return true;
      if ((rowData.actor_script || '').toLowerCase().includes(q)) return true;
      if ((rowData.actor_name   || '').toLowerCase().includes(q)) return true;
      if ((rowData.actor_owner  || '').toLowerCase().includes(q)) return true;
      if ((rowData._summary     || '').toLowerCase().includes(q)) return true;
      return this._search.matches(rowData.actor_serial, q);
    };
    filter._rowTableTag = tableId;
    ext.push(filter);
  }

  _reloadDtData({ preservePaging = false } = {}) {
    if (!this._dtApi) return;
    this._dtApi.clear();
    this._dtApi.rows.add(this._allRows);
    this._dtApi.draw(preservePaging);
    // The ColumnControl `searchList` on the kind column derives its
    // check-list options from row data. It refreshes itself on `xhr`
    // events (AJAX-driven tables); ours isn't AJAX, so when the row
    // set changes we have to nudge it manually. Wrapped in try/catch
    // because the method is only defined once the column header /
    // content has been rendered — early enough by the first draw, but
    // safer to be defensive.
    try { this._dtApi.column('kind:name').columnControl.searchList('refresh'); } catch { /* noop */ }
  }

  _renderFilterCount() {
    const el = document.getElementById('filterCount');
    if (!el) return;
    const info = this._dtApi?.page.info();
    const shown = info ? info.recordsDisplay : this._allRows.length;
    el.textContent = this._t('ui.filterCount', {
      shown: shown.toLocaleString(),
      total: this._allRows.length.toLocaleString(),
    });
  }

  // ---- internal: control bar wiring -------------------------------------

  _wireControls() {
    const searchEl = document.getElementById('search');
    const anchorBtn = document.getElementById('anchorAtBtn');

    this._queryStr = '';

    if (searchEl) {
      this._queryStr = searchEl.value.trim();
      searchEl.addEventListener('input', debounce(() => {
        this._queryStr = searchEl.value.toLowerCase().trim();
        this._dtApi?.draw();
      }, 200));
    }
    if (anchorBtn) {
      anchorBtn.addEventListener('click', () => this.setCustomAnchor());
    }

    this._wireColumnsPicker();
  }

  /**
   * Oracle APEX-style "Select columns" picker. Two stacked lists (hidden
   * and displayed), left/right arrows toggle visibility, up/down arrows
   * reorder within the displayed list via `dt.colReorder.move()`.
   *
   * The picker's lists are rebuilt every time the dialog opens. Selection
   * is tracked locally on the list elements as a `.selected` class.
   *
   * `dist` (column 1) is excluded — its visibility is anchor-controlled
   * (see `_applyAnchorChange`) and a user toggle would fight that logic.
   */
  _wireColumnsPicker() {
    const btn        = document.getElementById('columnsBtn');
    const dlg        = document.getElementById('columnsDialog');
    const closeBtn   = document.getElementById('columnsDialogClose');
    const resetBtn   = document.getElementById('columnsDialogReset');
    const hiddenList    = document.getElementById('cpHiddenList');
    const displayedList = document.getElementById('cpDisplayedList');
    const moveRight = document.getElementById('cpMoveRight');
    const moveLeft  = document.getElementById('cpMoveLeft');
    const moveUp    = document.getElementById('cpMoveUp');
    const moveDown  = document.getElementById('cpMoveDown');
    if (!btn || !dlg) return;

    const EXCLUDE_ORIGINAL_IDX = new Set([1]);   // dist — anchor-managed

    // Original-index → title map, captured once from the column config so
    // the list labels stay stable even if a future caller mutates titles.
    const titleByOriginalIdx = new Map();
    this._dtApi.columns({ order: 'original' }).every(function () {
      titleByOriginalIdx.set(this.index(), this.title());
    });

    // Build the two lists from current DT state. We walk
    // `colReorder.order()` which is [originalIdx-at-display-0, ...] so
    // display order is preserved for the right pane. Hidden columns end
    // up in whatever display position they last held — which is fine
    // because they'll only ever reappear at that slot.
    const rebuild = () => {
      hiddenList.innerHTML = '';
      displayedList.innerHTML = '';
      const order = this._dtApi.colReorder.order();   // displayPos → originalIdx
      for (const originalIdx of order) {
        if (EXCLUDE_ORIGINAL_IDX.has(originalIdx)) continue;
        const visible = this._dtApi.column(originalIdx, { order: 'original' }).visible();
        const li = document.createElement('li');
        li.className = 'cp-item';
        li.dataset.originalIdx = String(originalIdx);
        li.textContent = titleByOriginalIdx.get(originalIdx) || '?';
        (visible ? displayedList : hiddenList).appendChild(li);
      }
      updateButtons();
    };

    const selectedItem = (listEl) => listEl.querySelector('.cp-item.selected');
    const updateButtons = () => {
      const sH = selectedItem(hiddenList);
      const sD = selectedItem(displayedList);
      moveRight.disabled = !sH;
      moveLeft.disabled  = !sD || displayedList.children.length <= 1;
      moveUp.disabled    = !sD || sD === displayedList.firstElementChild;
      moveDown.disabled  = !sD || sD === displayedList.lastElementChild;
    };

    const clearSelection = (listEl) => {
      const cur = selectedItem(listEl);
      if (cur) cur.classList.remove('selected');
    };

    // Delegated click → single-select within a list. Selecting in one
    // list clears selection in the other so the move buttons reflect a
    // single active item across both panes.
    const wireListSelection = (listEl, otherListEl) => {
      listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.cp-item');
        if (!item) return;
        clearSelection(listEl);
        clearSelection(otherListEl);
        item.classList.add('selected');
        updateButtons();
      });
    };
    wireListSelection(hiddenList, displayedList);
    wireListSelection(displayedList, hiddenList);

    const dt = this._dtApi;

    // Current display-position of a column given its original index.
    const displayPosOf = (originalIdx) => {
      const order = dt.colReorder.order();
      return order.indexOf(originalIdx);
    };

    moveRight.addEventListener('click', () => {
      const sel = selectedItem(hiddenList);
      if (!sel) return;
      const origIdx = Number(sel.dataset.originalIdx);
      dt.column(origIdx, { order: 'original' }).visible(true);
      rebuild();
      const newSel = displayedList.querySelector(`[data-original-idx="${origIdx}"]`);
      if (newSel) { newSel.classList.add('selected'); updateButtons(); }
    });

    moveLeft.addEventListener('click', () => {
      const sel = selectedItem(displayedList);
      if (!sel) return;
      const origIdx = Number(sel.dataset.originalIdx);
      dt.column(origIdx, { order: 'original' }).visible(false);
      rebuild();
      const newSel = hiddenList.querySelector(`[data-original-idx="${origIdx}"]`);
      if (newSel) { newSel.classList.add('selected'); updateButtons(); }
    });

    // Move up/down operate on the displayed list. Skip over any
    // currently-hidden column between the selected and its neighbour so
    // the user-visible order matches the picker's order.
    const moveBy = (dir /* -1 = up, +1 = down */) => {
      const sel = selectedItem(displayedList);
      if (!sel) return;
      const origIdx = Number(sel.dataset.originalIdx);
      const curPos  = displayPosOf(origIdx);
      const order   = dt.colReorder.order();
      // Walk away from curPos in `dir` direction until we find a visible
      // (and not-excluded) column. That's the target display position.
      let target = curPos + dir;
      while (target >= 0 && target < order.length) {
        const neighbourOrig = order[target];
        if (!EXCLUDE_ORIGINAL_IDX.has(neighbourOrig)
            && dt.column(neighbourOrig, { order: 'original' }).visible()) {
          break;
        }
        target += dir;
      }
      if (target < 0 || target >= order.length) return;
      dt.colReorder.move(curPos, target);
      rebuild();
      const newSel = displayedList.querySelector(`[data-original-idx="${origIdx}"]`);
      if (newSel) { newSel.classList.add('selected'); updateButtons(); }
    };
    moveUp.addEventListener('click',   () => moveBy(-1));
    moveDown.addEventListener('click', () => moveBy(+1));

    resetBtn.addEventListener('click', () => {
      // Restore original order, then re-apply the built-in default
      // visibility (owner hidden; dist anchor-controlled, untouched here).
      dt.colReorder.reset();
      const cfg = this._buildColumns();
      cfg.forEach((c, i) => {
        if (i === 1) return;   // dist — leave anchor logic alone
        const want = c.visible !== false;
        if (dt.column(i, { order: 'original' }).visible() !== want) {
          dt.column(i, { order: 'original' }).visible(want);
        }
      });
      rebuild();
    });

    btn.addEventListener('click', () => {
      rebuild();
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    });
    closeBtn.addEventListener('click', () => dlg.close());
  }

  /**
   * Recompute distances against the current anchor, toggle the distance
   * column, re-sort by distance when anchored / by serial when not, then
   * redraw. Also renders the anchor chip's editable inputs.
   *
   * `rows().invalidate()` is REQUIRED here: DataTables caches each cell's
   * rendered HTML, so cells in the distance column that were rendered
   * (or skipped) while the column was hidden never re-run their render
   * function on a plain redraw. Invalidating drops the cache.
   */
  _applyAnchorChange() {
    this._stampAllDistances();
    if (this._dtApi) {
      this._dtApi.column(1).visible(!!this._anchor, false);
      this._dtApi.order([this._anchor ? 1 : 0, 'asc']);
      this._dtApi.rows().invalidate();
      this._dtApi.draw();
    }
    this._renderAnchorChip();
  }

  _stampDistance(row) {
    if (!this._anchor) { row._spatialDist = undefined; return; }
    const tx = this._classify.parseTransform(row.actor_transf);
    if (!tx) { row._spatialDist = undefined; return; }
    const d = this._classify.distanceMeters(tx, this._anchor.pos);
    row._spatialDist = (d == null) ? undefined : d;
  }

  _stampAllDistances() {
    for (const r of this._allRows) this._stampDistance(r);
  }

  _renderRelationshipChip() {
    const chip = document.getElementById('relationshipChip');
    if (!chip) return;
    const f = this._relationshipFilter;
    if (!f) {
      chip.classList.add('hidden');
      chip.innerHTML = '';
      return;
    }
    const t = this._t.bind(this);
    chip.classList.remove('hidden');
    const summary = t('ui.relationship.chipLabel', {
      label: f.label,
      count: f.serials.size.toLocaleString(),
      default: '{label} ({count})',
    });
    chip.innerHTML = `
      <span class="rel-label">${escapeText(summary)}</span>
      <button id="relationshipClear" title="${escapeAttr(t('ui.relationship.clear', { default: 'clear relationship filter' }))}">×</button>
    `;
    document.getElementById('relationshipClear')
      .addEventListener('click', () => this.clearRelationshipFilter());
  }

  _renderAnchorChip() {
    const chip = document.getElementById('anchorChip');
    if (!chip) return;
    if (!this._anchor) {
      chip.classList.add('hidden');
      chip.innerHTML = '';
      return;
    }
    const a = this._anchor;
    const t = this._t.bind(this);
    chip.classList.remove('hidden');
    const labelText = a.serial != null
      ? t('ui.anchor.label', { serial: a.serial, label: a.label })
      : t('ui.anchor.customLabel');
    chip.innerHTML = `
      <span class="anchor-label">${escapeText(labelText)}</span>
      <label>x <input id="anchorPosX" type="number" step="any" value="${a.pos[0]}" style="width:80px;"></label>
      <label>y <input id="anchorPosY" type="number" step="any" value="${a.pos[1]}" style="width:80px;"></label>
      <label>z <input id="anchorPosZ" type="number" step="any" value="${a.pos[2]}" style="width:80px;"></label>
      <label>${escapeText(t('ui.anchor.range'))}
        <input id="anchorRange" type="number" min="0" step="10" value="${a.rangeMeters}" style="width:70px;"> m
      </label>
      <button id="anchorClear" title="${escapeAttr(t('ui.anchor.clear'))}">×</button>
    `;
    const onPosInput = debounce(() => {
      const x = Number(document.getElementById('anchorPosX').value);
      const y = Number(document.getElementById('anchorPosY').value);
      const z = Number(document.getElementById('anchorPosZ').value);
      if (![x, y, z].every(Number.isFinite)) return;
      a.pos = [x, y, z];
      // Editing pos decouples the anchor from its source row.
      if (a.serial != null) {
        const wasSerial = a.serial;
        a.serial = null;
        a.label  = t('ui.anchor.customLabel');
        const lbl = chip.querySelector('.anchor-label');
        if (lbl) lbl.textContent = a.label;
        if (this._selectedSerial === wasSerial) {
          this._emit('row-selected', { serial: wasSerial });
        }
      }
      this._stampAllDistances();
      this._dtApi?.draw();
    }, 250);
    document.getElementById('anchorPosX').addEventListener('input', onPosInput);
    document.getElementById('anchorPosY').addEventListener('input', onPosInput);
    document.getElementById('anchorPosZ').addEventListener('input', onPosInput);
    document.getElementById('anchorRange').addEventListener('input', debounce(() => {
      const v = Number(document.getElementById('anchorRange').value);
      if (Number.isFinite(v) && v >= 0) {
        a.rangeMeters = v;
        this._dtApi?.draw();
      }
    }, 150));
    document.getElementById('anchorClear').addEventListener('click', () => this.clearAnchor());
  }

  // ---- internal: event subscriptions ------------------------------------

  _subscribe() {
    this._orch.addListener((event, data) => {
      if (event === 'rows-ready') {
        this._allRows = data.rows;
        this._currentFileLabel = data.label;
        this._currentServerId  = data.serverId;
        this._selectedSerial   = null;
        this._anchor           = null;
        this._relationshipFilter = null;
        this._selectedKinds.clear();
        this._stampAllDistances();
        this._renderAnchorChip();
        this._renderRelationshipChip();
        if (this._dtApi) {
          this._dtApi.column(1).visible(false, false);
          this._dtApi.order([0, 'asc']);
        }
        this._reloadDtData({ preservePaging: false });
        this._emit('rows-replaced', {
          rows: this._allRows,
          label: this._currentFileLabel,
          serverId: this._currentServerId,
        });
      }
    });

    this._data.addListener((event /*, data */) => {
      if (event !== 'unloaded') return;
      this._allRows = [];
      this._currentFileLabel = null;
      this._currentServerId  = null;
      this._selectedSerial   = null;
      this._anchor           = null;
      this._relationshipFilter = null;
      this._selectedKinds.clear();
      this._renderAnchorChip();
      this._renderRelationshipChip();
      this._reloadDtData({ preservePaging: false });
      this._emit('rows-replaced', { rows: [], label: null, serverId: null });
    });

    // Newly-indexed blob batches → re-run the filter so haystack matches
    // pick up the freshly-indexed rows. Debounced so a burst of batches
    // during initial indexing doesn't thrash the render.
    this._search.addListener((event /*, data */) => {
      if (event === 'batch' || event === 'done' || event === 'reset') {
        this._refreshOnIndex();
      }
    });
  }

  // ---- i18n helper -------------------------------------------------------

  _t(key, opts) {
    return this._i18n.t(key, opts);
  }
}
