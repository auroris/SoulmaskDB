/**
 * ReferencesService — cross-row GUID reverse index, fed from the
 * per-row manifest's `references` field that the decode worker
 * populates via `lib/unreal/refs.mjs::collectGuids`.
 *
 * Wire-up parallels SearchService:
 *   - Subscribed to FactExtractor `batch` events through the
 *     orchestrator's `_installFactForwarding`. Each load runs
 *     `clear()` to drop prior state and bump an internal epoch;
 *     `absorbBatch` ignores batches whose epoch doesn't match,
 *     so stale results from an abandoned load can't pollute the
 *     new state.
 *   - Single-row mutations bypass the worker pool via
 *     `refreshRow(serial, bytes)` / `dropRow(serial)`, matching
 *     the edit / delete callsites that already exist for
 *     SearchService.
 *
 * State (built incrementally as batches land):
 *   _guidIndex              Map<guid, [{serial, path, isIdentity, isNestedIdentity}]>
 *                   every property occurrence of `guid` across all
 *                   rows. Includes the row's own primary-identity
 *                   entry and any nested-identity entries (see
 *                   NESTED_IDENTITY_PATTERNS below) — both are
 *                   filtered out at the query layer so callers don't
 *                   have to.
 *   _outboundByRow          Map<serial, [{guid, path}]>
 *                   per-row outbound refs. Primary identity and
 *                   nested identities are excluded — they're "I am
 *                   this guid" / "I contain this guid inline", not
 *                   references TO it.
 *   _selfUidByRow           Map<serial, guid>
 *                   each row's PRIMARY identity guid (per
 *                   IDENTITY_PATH_BY_KIND). One per row.
 *   _rowBySelfUid           Map<guid, serial>
 *                   reverse lookup: which row claims this guid as
 *                   either its primary identity OR a nested identity.
 *                   Primary identities win on collision; nested-
 *                   identity writes don't clobber an existing entry.
 *   _nestedIdentitiesByRow  Map<serial, [{guid, path}]>
 *                   per-row sub-entity identity entries — GUIDs the
 *                   row owns inline (deck pieces of a ship, etc.)
 *                   rather than referencing externally. Tracked so
 *                   `_removeRow` can clean them up from `_guidIndex`
 *                   and `_rowBySelfUid` without scanning every bucket.
 *
 * Query API:
 *   referrersOf(guid)      → [{serial, path}]
 *     every row that mentions `guid` at a non-SelfUid property —
 *     "who points AT this guid?".
 *   referrersOfRow(serial) → [{serial, path}]
 *     convenience: referrersOf(selfUidOf(serial)). `[]` if the row
 *     has no SelfUid.
 *   selfUidOf(serial)      → guid | null
 *   rowBySelfUid(guid)     → serial | null
 *     reverse lookup; resolves an outbound ref's target row.
 *   outboundFrom(serial)   → [{guid, path, targetSerial}]
 *     every GUID this row references (SelfUid excluded). `targetSerial`
 *     is the row whose SelfUid matches, or `null` if not in the loaded
 *     set (forward reference, stale, or external).
 *   stats()                → { rows, rowsWithSelfUid, distinctGuids, totalRefs }
 *
 * Events (addListener):
 *   'batch' stats — fired after each absorbBatch.
 *   'done'  stats — fired by the orchestrator after the decode pass.
 *   'reset' null  — fired by clear().
 *
 * Design notes:
 *   - All queries are direct Map lookups (O(1) for selfUidOf /
 *     rowBySelfUid; O(bucket) for referrersOf where bucket is the
 *     count of property occurrences for that guid — typically <1000
 *     even for the busiest GUIDs on world.db). No FlexSearch-style
 *     result cache needed.
 *   - `absorbBatch` is idempotent per serial — if the same serial is
 *     absorbed twice (e.g. a hypothetical worker retry), the prior
 *     entries are removed first. This is the same contract
 *     `refreshRow` needs, so they share the same internal path.
 *   - Bucket removal during `_dropFromBucket` is O(n) splice. Cheap
 *     in practice (buckets are short; deletion is rare — edit + delete
 *     only). If this becomes a profile hot-spot, swap buckets for
 *     Sets keyed by `${serial}\0${path}`.
 */

/**
 * Identity-property convention by classified row kind. The default is
 * 'SelfUid' — most NPCs / inventories / buildings put their identity
 * guid at that path. Some row kinds use a different property:
 *
 *   player  → 'ZhuRenGuid'
 *     On HPlayerState rows, `ZhuRenGuid` carries the PLAYER's own
 *     identity, not a reference to an external master. The same
 *     property name is a reference on NPC rows — same byte layout,
 *     different semantics depending on which row holds it. Confirmed
 *     across all 5 players in the sample world.db (each one's
 *     ZhuRenGuid is unique and is what NPCs/buildings reference as
 *     "owner").
 *
 * Adding new entries here is the way to teach the service about
 * additional self-identity conventions if we discover them (guild
 * rows, system rows, etc.).
 */
const IDENTITY_PATH_BY_KIND = {
  player: 'ZhuRenGuid',
};
const DEFAULT_IDENTITY_PATH = 'SelfUid';

/**
 * Nested-identity path patterns. These are paths whose `Guid` value is the
 * identity of a sub-entity that lives inline inside a parent row's blob
 * (no standalone `actor_table` row of its own). For row 12583 (a ship) the
 * 561 `MapHoldJianZhuList[N].value.JianZhuIndicator.JianZhuUid` GUIDs are
 * the identities of deck pieces / walls / slopes built into the ship.
 *
 * Without this list those GUIDs would flow into `_outboundByRow` as
 * outbound references — every one of them rendering as "(target not in
 * loaded set)" in the Relationships panel — and would also pollute
 * `referrersOf` results when other rows happen to mention the same guid.
 *
 * Matching path entries are:
 *   - excluded from the row's `_outboundByRow` list (they aren't
 *     references TO something else; they ARE this row's sub-identities)
 *   - registered in `_rowBySelfUid` so any OTHER row that references one
 *     of these sub-entity GUIDs resolves back to this parent row
 *   - excluded from `referrersOf` (a sub-identity isn't a referrer either)
 *   - NOT placed in `_selfUidByRow` (that map holds the row's PRIMARY
 *     identity; a row can only have one of those)
 *
 * Add patterns here when more nested-identity conventions are discovered.
 * The regex must match against the full property path string emitted by
 * `lib/unreal/refs.mjs::collectGuids` (e.g.
 * `JianZhuInstGLQComponent.MapHoldJianZhuList[419].value.JianZhuIndicator.JianZhuUid`).
 */
const NESTED_IDENTITY_PATTERNS = [
  /(?:^|\.)MapHoldJianZhuList\[\d+\]\.value\.JianZhuIndicator\.JianZhuUid$/,
];

function isNestedIdentityPath(path) {
  for (const re of NESTED_IDENTITY_PATTERNS) {
    if (re.test(path)) return true;
  }
  return false;
}

export class ReferencesService {
  /**
   * @param {object} options
   * @param {object} options.codecs - codec registry (provides decode(u8))
   * @param {Function} options.collectGuids - the {path,guid} walker
   *   from lib/unreal/refs.mjs
   * @param {Function} [options.kindLookup] - optional `(serial) → string|null`
   *   used to decide which property path is identity for a given row.
   *   Wired post-construction by the orchestrator to a row-table lookup;
   *   absent (e.g. in tests) the service falls back to DEFAULT_IDENTITY_PATH
   *   for every row.
   */
  constructor({ codecs, collectGuids, kindLookup = null } = {}) {
    if (!codecs)       throw new Error('ReferencesService: codecs is required');
    if (!collectGuids) throw new Error('ReferencesService: collectGuids is required');
    this._codecs       = codecs;
    this._collectGuids = collectGuids;
    this._kindLookup   = kindLookup;

    this._guidIndex             = new Map();
    this._outboundByRow         = new Map();
    this._selfUidByRow          = new Map();
    this._rowBySelfUid          = new Map();
    // Per-row list of nested-identity entries (sub-entity GUIDs the row
    // owns inline — see NESTED_IDENTITY_PATTERNS). Tracked separately
    // from _outboundByRow because they are NOT references; the per-row
    // bookkeeping is what lets `_removeRow` clean them up without
    // scanning every `_guidIndex` bucket.
    this._nestedIdentitiesByRow = new Map();

    this._totalRefs = 0;
    this._listeners = new Set();
    this._epoch     = 0;
  }

  /**
   * Provide / replace the row-kind lookup used to resolve identity
   * paths. Called by the orchestrator once RowTable's rows are loaded
   * so the service can ask "what kind is this serial?" without owning
   * its own row list.
   */
  setKindLookup(fn) { this._kindLookup = fn || null; }

  currentEpoch() { return this._epoch; }

  addListener(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(event, data) {
    for (const fn of this._listeners) {
      try { fn(event, data); }
      catch (e) { console.error('ReferencesService listener threw:', e); }
    }
  }

  /**
   * Consume a worker batch — `items` is the `{serial, manifest}[]`
   * shape FactExtractor emits in its 'batch' event. If `epoch` is
   * provided and doesn't match the current internal epoch, the batch
   * is dropped silently (stale results from a prior file's decode).
   */
  absorbBatch(items, { epoch } = {}) {
    if (!items || items.length === 0) return;
    if (epoch != null && epoch !== this._epoch) return;
    for (const item of items) {
      this._absorbOne(item.serial, item.manifest?.references);
    }
    this._emit('batch', this._statsPayload());
  }

  /**
   * Signal that the current decode pass is complete. Called by the
   * orchestrator after FactExtractor emits 'done'.
   */
  markDone({ epoch } = {}) {
    if (epoch != null && epoch !== this._epoch) return;
    this._emit('done', this._statsPayload());
  }

  /**
   * Re-index a single row after a SQL/blob edit. Synchronous main-thread
   * decode (same trade-off as SearchService.refreshRow — single-row
   * round-trip through the worker pool costs more than the decode).
   * `bytes` may be null / empty (clears the row's entries) or a
   * Uint8Array of actor_data.
   */
  refreshRow(serial, bytes) {
    this._removeRow(serial);
    if (!bytes || bytes.length === 0) return;
    let refs;
    try {
      const decoded  = this._codecs.decode(bytes);
      const guidRefs = this._collectGuids(decoded);
      refs = new Array(guidRefs.length);
      for (let i = 0; i < guidRefs.length; i++) {
        refs[i] = { kind: 'guid', guid: guidRefs[i].guid, path: guidRefs[i].path };
      }
    } catch {
      return;
    }
    this._absorbOne(serial, refs);
  }

  /** Drop one row's entries. Used after DELETE. */
  dropRow(serial) {
    this._removeRow(serial);
  }

  /**
   * Reset all indexed state. Bumps the epoch so any in-flight batches
   * from a prior decode pass get dropped on arrival.
   */
  clear() {
    this._epoch++;
    this._guidIndex.clear();
    this._outboundByRow.clear();
    this._selfUidByRow.clear();
    this._rowBySelfUid.clear();
    this._nestedIdentitiesByRow.clear();
    this._totalRefs = 0;
    this._emit('reset', null);
  }

  // ── queries ──────────────────────────────────────────────────────────

  /**
   * Every row that mentions `guid` at a non-identity property (the
   * identity entry IS the row whose identity is that guid, not a
   * referrer to it). Identity is per-row-kind — for an HPlayerState
   * row whose ZhuRenGuid IS its identity, that entry is filtered
   * out; an NPC row's ZhuRenGuid pointing at the same guid is NOT
   * filtered (it's a real reference).
   */
  referrersOf(guid) {
    const bucket = this._guidIndex.get(guid);
    if (!bucket) return [];
    const out = [];
    for (const entry of bucket) {
      if (entry.isIdentity || entry.isNestedIdentity) continue;
      out.push({ serial: entry.serial, path: entry.path });
    }
    return out;
  }

  /**
   * Convenience: who points at the row whose SelfUid we look up by
   * `serial`. Returns `[]` if the row has no SelfUid (some metadata
   * rows don't).
   */
  referrersOfRow(serial) {
    const guid = this._selfUidByRow.get(serial);
    if (!guid) return [];
    return this.referrersOf(guid);
  }

  /** Row's identity guid (path === 'SelfUid'), or null. */
  selfUidOf(serial) {
    return this._selfUidByRow.get(serial) ?? null;
  }

  /** Reverse: which row claims this guid as its SelfUid, or null. */
  rowBySelfUid(guid) {
    return this._rowBySelfUid.get(guid) ?? null;
  }

  /**
   * Every guid this row references (SelfUid excluded), with the
   * resolved target serial when one is loaded. `targetSerial` is null
   * when no loaded row claims that guid — common for refs to deleted
   * rows, refs from accounts.db to world.db, or external IDs.
   */
  outboundFrom(serial) {
    const outbound = this._outboundByRow.get(serial);
    if (!outbound) return [];
    const out = new Array(outbound.length);
    for (let i = 0; i < outbound.length; i++) {
      const o = outbound[i];
      out[i] = {
        guid: o.guid,
        path: o.path,
        targetSerial: this._rowBySelfUid.get(o.guid) ?? null,
      };
    }
    return out;
  }

  stats() { return this._statsPayload(); }

  // ── internals ────────────────────────────────────────────────────────

  _statsPayload() {
    return {
      rows:            this._outboundByRow.size,
      rowsWithSelfUid: this._selfUidByRow.size,
      distinctGuids:   this._guidIndex.size,
      totalRefs:       this._totalRefs,
    };
  }

  _identityPathFor(serial) {
    const kind = this._kindLookup ? this._kindLookup(serial) : null;
    return (kind && IDENTITY_PATH_BY_KIND[kind]) || DEFAULT_IDENTITY_PATH;
  }

  _absorbOne(serial, references) {
    // Idempotent — strip any prior entries for this serial first.
    if (this._outboundByRow.has(serial)
        || this._selfUidByRow.has(serial)
        || this._nestedIdentitiesByRow.has(serial)) {
      this._removeRow(serial);
    }
    if (!Array.isArray(references) || references.length === 0) return;

    const identityPath = this._identityPathFor(serial);

    let outbound = null;
    let nested   = null;
    for (const ref of references) {
      if (ref.kind !== 'guid' || !ref.guid) continue;
      const isIdentity       = ref.path === identityPath;
      const isNestedIdentity = !isIdentity && isNestedIdentityPath(ref.path);

      let bucket = this._guidIndex.get(ref.guid);
      if (!bucket) { bucket = []; this._guidIndex.set(ref.guid, bucket); }
      // Stamp isIdentity / isNestedIdentity on the bucket entry so
      // `referrersOf` can filter without re-consulting `_kindLookup`
      // or `isNestedIdentityPath` per query — both are resolved once
      // at absorb time. (If a row's kind or the nested-identity
      // patterns change after a row's been absorbed, we'd need to
      // re-absorb it; for now both are immutable per load.)
      bucket.push({ serial, path: ref.path, isIdentity, isNestedIdentity });
      this._totalRefs++;

      if (isIdentity) {
        this._selfUidByRow.set(serial, ref.guid);
        // Last writer wins on collision. Identity guids are supposed to
        // be unique; if two rows claim the same one, the second to land
        // becomes the rowBySelfUid target. _guidIndex still has both
        // entries so referrersOf surfaces nothing surprising.
        this._rowBySelfUid.set(ref.guid, serial);
      } else if (isNestedIdentity) {
        // Sub-entity identity living inline in this row's blob. Register
        // it in _rowBySelfUid so refs from OTHER rows resolve back here,
        // but do NOT touch _selfUidByRow (a row has at most one primary
        // identity, and this isn't it) and do NOT add to outbound (it
        // isn't a reference, it's an inline identity).
        if (!nested) nested = [];
        nested.push({ guid: ref.guid, path: ref.path });
        // Don't overwrite an existing _rowBySelfUid mapping — if a row
        // somewhere already claims this guid as its PRIMARY identity,
        // that mapping wins. (Practically this hasn't been observed,
        // but it's the same conservative posture _absorbOne uses for
        // primary-identity collisions: prefer earlier writers when we
        // can tell them apart by intent.)
        if (!this._rowBySelfUid.has(ref.guid)) {
          this._rowBySelfUid.set(ref.guid, serial);
        }
      } else {
        if (!outbound) outbound = [];
        outbound.push({ guid: ref.guid, path: ref.path });
      }
    }
    if (outbound) this._outboundByRow.set(serial, outbound);
    if (nested)   this._nestedIdentitiesByRow.set(serial, nested);
  }

  _removeRow(serial) {
    const outbound = this._outboundByRow.get(serial);
    if (outbound) {
      for (const { guid } of outbound) this._dropFromBucket(guid, serial);
      this._outboundByRow.delete(serial);
    }
    const nested = this._nestedIdentitiesByRow.get(serial);
    if (nested) {
      for (const { guid } of nested) {
        this._dropFromBucket(guid, serial);
        // Only clear the reverse mapping if it still points at THIS
        // serial (another row's primary identity may have claimed it
        // since, or another nested-identity write may have skipped past
        // ours under the "don't overwrite" guard in _absorbOne).
        if (this._rowBySelfUid.get(guid) === serial) {
          this._rowBySelfUid.delete(guid);
        }
      }
      this._nestedIdentitiesByRow.delete(serial);
    }
    const selfUid = this._selfUidByRow.get(serial);
    if (selfUid != null) {
      this._dropFromBucket(selfUid, serial);
      this._selfUidByRow.delete(serial);
      // Only clear the reverse mapping if it still points at THIS serial
      // (another row may have over-written it on a SelfUid collision).
      if (this._rowBySelfUid.get(selfUid) === serial) {
        this._rowBySelfUid.delete(selfUid);
      }
    }
  }

  _dropFromBucket(guid, serial) {
    const bucket = this._guidIndex.get(guid);
    if (!bucket) return;
    let removed = 0;
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (bucket[i].serial === serial) {
        bucket.splice(i, 1);
        removed++;
      }
    }
    this._totalRefs -= removed;
    if (bucket.length === 0) this._guidIndex.delete(guid);
  }
}
