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
import { escapeText, escapeAttr, debounce, fmtBytes } from './util.mjs';

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

    this._listeners = new Set();
    this._dtApi     = null;
    this._initialized = false;

    // Re-apply filters after a burst of blob-indexing batches lands.
    this._refreshOnIndex = debounce(() => this._dtApi?.draw(false), 150);
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

  // ---- mutators ----------------------------------------------------------

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
        // 0: serial — sortable, default sort
        title: t('ui.tableHeader.serial'),
        data:  'actor_serial',
        type:  'num',
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
        // 2: kind pill
        title: t('ui.tableHeader.kind'),
        data:  '_kind',
        orderable: false,
        render: (data) => {
          const label = t('ui.kind.' + data, { default: data });
          return `<span class="pill ${escapeAttr(data)}">${escapeText(label)}</span>`;
        },
      },
      {
        // 3: class (label + optional Steam display name)
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
        // 5: owner
        title: t('ui.tableHeader.owner'),
        data:  'actor_owner',
        orderable: false,
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
        // 7: time
        title: t('ui.tableHeader.time'),
        data:  'actor_time',
        orderable: false,
        className: 'muted',
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
      const k = this._kindStr || '';
      if (k && rowData._kind !== k) return false;
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
    const kindEl   = document.getElementById('kindFilter');
    const anchorBtn = document.getElementById('anchorAtBtn');

    this._queryStr = '';
    this._kindStr  = '';

    if (searchEl) {
      this._queryStr = searchEl.value.trim();
      searchEl.addEventListener('input', debounce(() => {
        this._queryStr = searchEl.value.toLowerCase().trim();
        this._dtApi?.draw();
      }, 200));
    }
    if (kindEl) {
      this._kindStr = kindEl.value;
      kindEl.addEventListener('change', () => {
        this._kindStr = kindEl.value;
        this._dtApi?.draw();
      });
    }
    if (anchorBtn) {
      anchorBtn.addEventListener('click', () => this.setCustomAnchor());
    }
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
