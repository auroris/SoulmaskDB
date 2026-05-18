/**
 * HistoryService — wires browser back/forward to RowTable selection.
 *
 * Behaviour:
 *   - When a row is selected programmatically OR by click, the URL is
 *     updated to `?row=<serial>` and a new history entry is pushed.
 *   - When the selection is cleared, the `row` param is removed and a
 *     history entry without it is pushed.
 *   - When the user navigates back/forward, `popstate` fires; we read
 *     `event.state.serial` (or fall back to the URL) and drive
 *     RowTable.setSelection / clearSelection accordingly.
 *   - The first row-selected of the page does a `replaceState` instead
 *     of a `pushState` so the user's initial back button still goes to
 *     wherever they came from rather than the no-row form of the page.
 *
 * Deep-link policy: we intentionally do NOT read `?row=N` on initial
 * load. Per the design choice on 2026-05-18, the URL is informational
 * within a session but not a shareable deep link — the back/forward
 * stack is the only thing that drives selection from popstate.
 *
 * Loop guard: when popstate triggers setSelection, the rowTable
 * 'row-selected' listener would normally push another entry. We set a
 * `_suppress` flag for the duration of the popstate handler so the
 * triggered selection event is a no-op from history's perspective.
 */

export class HistoryService {
  constructor() {
    this._rowTable    = null;
    this._suppress    = false;
    this._initialized = false;
    // True once we've pushed at least once this session — used to pick
    // replaceState (first time) vs pushState (subsequent).
    this._havePushed  = false;
  }

  /**
   * @param {object} deps
   * @param {RowTable} deps.rowTable — selection events come from here.
   */
  init({ rowTable } = {}) {
    if (this._initialized) return;
    if (!rowTable) throw new Error('HistoryService.init: rowTable is required');
    this._rowTable = rowTable;
    this._initialized = true;

    window.addEventListener('popstate', (e) => this._onPopstate(e));

    rowTable.addListener((event, data) => {
      if (this._suppress) return;
      if (event === 'row-selected')        this._writeUrl(data.serial);
      else if (event === 'row-deselected') this._writeUrl(null);
      else if (event === 'rows-replaced')  {
        // New file loaded — drop any selection-related URL state and start
        // a fresh history entry without `row`.
        this._havePushed = false;
        this._writeUrl(null, { replace: true });
      }
    });
  }

  _writeUrl(serial, { replace = false } = {}) {
    const url = new URL(window.location.href);
    if (serial == null) url.searchParams.delete('row');
    else                url.searchParams.set('row', String(serial));

    // Don't churn the history stack if neither the URL nor the state
    // serial actually changed (e.g. re-selecting the same row to refresh
    // the detail panel).
    const currentSerial = history.state && history.state.serial != null
      ? history.state.serial : null;
    if (currentSerial === serial && url.href === window.location.href) return;

    const state = { serial: serial == null ? null : Number(serial), smdb: true };
    if (replace || !this._havePushed) {
      history.replaceState(state, '', url);
      this._havePushed = true;
    } else {
      history.pushState(state, '', url);
    }
  }

  _onPopstate(event) {
    const state = event.state;
    // If `state.smdb` isn't ours, we may have landed back on a pre-SMDB
    // entry — treat that as "clear selection" so the UI stays coherent.
    const serial = state && state.smdb && state.serial != null
      ? Number(state.serial) : null;

    this._suppress = true;
    try {
      if (serial == null) {
        this._rowTable.clearSelection();
      } else if (this._rowTable.findRow(serial)) {
        this._rowTable.setSelection(serial);
      } else {
        // Target row not in the current loaded set — clear instead of
        // selecting something that doesn't exist.
        this._rowTable.clearSelection();
      }
    } finally {
      this._suppress = false;
    }
  }
}
