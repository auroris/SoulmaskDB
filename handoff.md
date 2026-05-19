# SoulmaskDB — handoff notes

Project memory that travels with the repo. Read this before answering any
question about the codebase; it covers things you cannot derive from
reading the source (project quirks, intended architecture, footguns).
Keep it up to date when behaviors change.

Per-machine Claude memory (`~/.claude/projects/.../memory/`) is intentionally
empty except for a pointer here, so this file is the single source of
truth across machines.

---

## Quick project facts

These are non-obvious from the schema or code alone — both were
confirmed by the user on 2026-05-13.

- **`actor_table.actor_time` is UTC.** The column is `TEXT` with no
  timezone metadata. When you display it, label it as UTC. When you
  generate timestamps for stashed rows, generate UTC. No timezone
  normalization is needed when diffing snapshots.
- **`actor_table.server_id` is user-editable.** It's `INTEGER NOT NULL`.
  Usually irrelevant in single-server setups, but it matters when moving
  rows between servers or reassigning content. Include it in any
  "editable fields" list; validate as integer on save. Observed values
  in the sample DB were `[0, 2]`. `data_version` is also `INTEGER NOT
  NULL` but the user has NOT asked for it to be editable — leave it
  read-only.

---

## Service architecture

Loosely-coupled pieces that replaced the original monolithic load flow.
The constructors are cheap and sync; async work (wasm boots, DOM wiring,
event subscriptions) happens inside `init()` so the orchestrator can
order it deliberately.

- **`Lz4Service`** (`lib/lz4-wasm/lz4-service.mjs`). Constructor is a
  no-op. `init()` loads `lz4-wasm-nodejs` (Node) or the local
  `./lz4-browser.mjs` adapter (Browser, fetches `lz4_wasm_bg.wasm` via
  `WebAssembly.instantiateStreaming`). `compress` / `decompress`
  delegate to the loaded backend and throw if `init()` wasn't awaited.
  Each JS context (main thread, worker, node test) constructs its own
  service — wasm instances aren't shareable across contexts.

- **`SqliteService`** (`js/sqlite-service.mjs`). Factory for
  `DatabaseHandle` objects sharing one sqlite3 WASM module + one open
  database. Explicit `init()` boots the wasm; `open()` / `peek()` still
  call it as a safety net if a caller bypasses the orchestrator (e.g.
  node tests). Each new `open()` invalidates the prior handle so any
  code still holding a reference throws on use (`"DatabaseHandle: this
  handle has been invalidated"`) rather than silently writing to the
  wrong DB. Also exposes:
  - `peek(bytes, fn)` — opens against a separate VFS slot
    (`soulmask-peek.db`), passes the raw `oo1.DB` to `fn`, closes and
    unlinks unconditionally. Used by DataService to validate candidate
    files without disturbing the active DB. Concurrent peeks chain FIFO
    via `_peekChain`.
  - `close()` — invalidates the active handle without opening a
    replacement. Used when DataService removes the active file so
    dangling `DatabaseHandle` references throw on next use.

- **`FactExtractor`** (`lib/workers/fact-extractor.mjs`, was
  `WorkerService`). Owns the `DecodePool` of Workers that fast-decode
  every row's `actor_data` and reduce the decoded tree to a small
  per-row "manifest" of facts (search haystack today; a planned
  cross-row reference extractor will subscribe to the same event
  stream). `decode(items, { tag })` returns a promise of the full
  results AND emits per-batch `batch`/`done`/`error` events. `tag` is
  opaque — passed through unchanged on every event so multiple
  consumers can filter to their own batches. Lazy pool: constructed on
  first `decode()` call (spinning up ~15 workers each booting lz4 costs
  hundreds of ms; we defer until there's actual work).

- **`SearchService`** (`js/search-service.mjs`). FlexSearch `Index`
  keyed by `actor_serial`, fed each row's flat lowercased haystack
  string. The orchestrator feeds it via `absorbBatch(items, {epoch})`
  as worker batches land. Also exposes synchronous
  `refreshRow(serial, bytes)` / `dropRow(serial)` for single-row
  mutations — the edit and delete callsites avoid the worker
  round-trip for one row. Epoch logic ignores stale batches from an
  abandoned load (a second `loadFile` while the first is still
  indexing). FlexSearch is loaded as ESM via the import map
  (`flexsearch` → `/lib/flexsearch/flexsearch.module.mjs`, the bundle
  module the eleventy passthrough copies out of node_modules).

  Tokenizer is `'forward'` — prefix matches on each Unicode word token
  (dots, brackets, slashes etc. are token boundaries). This is a slight
  shift from the prior raw `String.includes` substring scan: queries
  that crossed a token boundary inside a camelCase compound (e.g.
  `GCompA` inside `BindBGCompActor`) no longer hit. Substring-anywhere
  matching would require `tokenize: 'full'`, which roughly squares
  index size — unaffordable on the ~113MB haystack `world.db` produces.

  `matches(serial, query)` caches the last query's `Index.search()`
  result set so the 12k per-draw calls DataTables makes amortize to
  O(1) Set lookups after the first. Cache is invalidated on any
  mutation (`absorbBatch` / `refreshRow` / `dropRow` / `clear`).
  `clear()` swaps in a fresh `Index` (FlexSearch has no bulk reset)
  and bumps the epoch. A `_indexedSerials` Set mirrors index membership
  so `hasIndex()` is O(1) and refresh paths can do `remove` before
  `add` (FlexSearch's `add` would double-index an existing id).

- **`ReferencesService`** (`js/references-service.mjs`). Cross-row
  reverse index over BOTH `Guid` struct values AND actor-instance
  `ObjectRef` paths, fed by the same FactExtractor `batch` events
  SearchService consumes. The walkers
  (`lib/unreal/refs.mjs::collectGuids` and `::collectObjRefs`) live
  upstream — the service itself is pure book-keeping. ObjectRef
  resolution uses an `actorNameLookup` (wired by the orchestrator to
  `RowTable.findRowByActorName`) because an ObjectRef's `path` field
  equals the target row's `actor_name` verbatim. State:
  - `_guidIndex: Map<guid, [{serial, path, isIdentity}]>` — every
    property occurrence of a guid across all rows. Each entry is
    stamped with `isIdentity` at absorb time (true iff the path is
    the row's identity-property for its kind — see below); the query
    layer filters on that flag.
  - `_outboundByRow: Map<serial, [{guid, path}]>` — per-row outbound
    refs (identity entries excluded — they're "I AM this guid", not
    a reference TO it).
  - `_selfUidByRow: Map<serial, guid>` and `_rowBySelfUid: Map<guid,
    serial>` — bidirectional lookup so an outbound ref resolves to a
    target row in O(1).

  Identity-by-kind: the path that carries a row's own guid identity
  depends on its classify kind. Conventions observed in `world.db`:
  - **`player`** (HPlayerState) → `ZhuRenGuid`. Same property name is
    a reference on NPC rows (master/owner pointer). Without this
    distinction, all 5 player GUIDs would render unresolved and the
    "Owned NPCs / Built objects / All referrers" buttons on a player
    detail panel would surface nothing.
  - **everyone else** → `SelfUid` (the default).
  The mapping lives in `IDENTITY_PATH_BY_KIND` at the top of the
  service file. The service doesn't classify rows itself — the
  orchestrator wires a `kindLookup(serial) → kind` via
  `setKindLookup()` after RowTable has loaded its rows. In tests
  without a row table, the lookup is null and every row falls back
  to `SelfUid` (which is fine for the NPC-only spot checks).

  Nested identity: some rows own a list of inline sub-entities whose
  GUIDs aren't references to other top-level rows but are sub-IDs
  living inside the parent's blob. The canonical case is a ship /
  raft / built structure whose `MapHoldJianZhuList[*].value.JianZhuIndicator.JianZhuUid`
  entries are the IDs of attached deck pieces, walls, slopes etc.
  A populated ship can hold 500+ of these. Treated as ordinary
  outbound refs they'd flood the row's "Points to" panel with that
  many unresolved entries.

  `NESTED_IDENTITY_PATTERNS` (regex array next to `IDENTITY_PATH_BY_KIND`)
  registers those paths. At absorb time, matching entries get
  stamped `isNestedIdentity: true` on their `_guidIndex` bucket
  entry, are tracked per-row in `_nestedIdentitiesByRow`, and are
  routed into `_rowBySelfUid` (so any OTHER row that references one
  of these sub-IDs still resolves back to this parent ship). They
  are NOT added to `_outboundByRow` (so the "Points to" panel
  ignores them) and NOT added to `_selfUidByRow` (a row still has
  exactly one primary identity). `referrersOf` filters both
  `isIdentity` and `isNestedIdentity` so a referrer query never
  surfaces a row's own sub-IDs as inbound pointers. `_rowBySelfUid`
  writes for nested identities defer to any existing primary
  identity entry; nested writes use a "don't clobber" guard.
  Add new patterns here when more inline-sub-entity conventions
  surface.

  Query API: `referrersOf(guid)`, `referrersOfRow(serial)`,
  `selfUidOf(serial)`, `rowBySelfUid(guid)`, `outboundFrom(serial)`
  (returns `[{guid, path, targetSerial}]` with the target resolved).
  Idempotent `absorbBatch` + the same `clear()`/epoch protection as
  SearchService. Single-row mutation via `refreshRow(serial, bytes)` /
  `dropRow(serial)` mirrors SearchService's bypass-the-pool path.
  Build cost on world.db: ~30 ms for 12,027 rows / 35,817 refs after
  the worker pool has produced the manifests (`node test.mjs
  --parallel` reports this alongside haystack stats).

- **`DataService`** (`js/data-service.mjs`). **Public entry point for
  DB-file work.** Owns the file-list lifecycle in the page: drag/drop
  bound on `window`, the `<dialog id="dataDialog">` UI, the per-file
  validation pass, the Switch-To trigger (the SOLE caller of
  `orchestrator.loadFile`), and the download path. Validates each added
  file via `SqliteService.peek`:
  - sqlite open throws → `invalid` (error captured for display)
  - missing `actor_table` → `invalid`
  - row with `actor_name IN ('GAME_SETTINGS','GAMEMODE')` → `world`
  - otherwise → `accounts`

  Emits `switched` / `unloaded` / `file-added` / `file-validated` /
  `file-removed`. Auto-opens the dialog on page boot when no file is
  active, and again whenever the active file is removed.

- **`RowTable`** (`js/row-table.mjs`). DataTables-backed view over
  `actor_table` rows. Owns the `<table>` DOM, the surrounding controls
  (`#search`, `#kindFilter`, `#filterCount`, `#anchorAtBtn`,
  `#anchorChip`, `#relationshipChip`), the canonical `allRows` list
  (formerly on app.mjs), the selection state, the spatial-anchor
  filter, and a relationship filter (an allow-list of serials sourced
  from `ReferencesService` queries — see "Cross-row GUID references"
  below). Subscribes to orchestrator `rows-ready`, data `unloaded`,
  and search `batch`/`done`/`reset` directly. Emits `row-selected`,
  `row-deselected`, `rows-replaced`, `relationship-filter-changed`
  so app.mjs can react without touching the table itself.

  Also exposes `absorbFacts(items)` — called by the orchestrator for
  each FactExtractor batch. Stamps `row._name` from `deriveName(facts)`
  for rows whose manifest carries a `facts` object, then debounce-redraws
  the table. This populates the **Name** column asynchronously after
  the table first renders. `findRow(serial)` exposes the row object for
  external lookups (used by `ReferencesService.setKindLookup`).

  Pairs with `absorbParents(items)` — also called per FactExtractor
  batch, AFTER `references.absorbBatch` so the references service is
  current for the items in question. Stamps `row._parent` via
  `_deriveParent(serial)`, which consults `references.outboundFrom` and
  picks the first resolvable target from the priority list
  `ZhuRenGuid` → `JianZhuBuilderUid` / `RaftSpaceBuilderUid` →
  `GongHuiGuid`. This populates the **Parent** column asynchronously
  (same pattern as Name) and feeds focus mode's children-of-X lookup.

  **Focus mode.** Engaged on every `setSelection(serial)`. Filters the
  visible table to {selected ∪ rows with `_parent === selected`} via the
  custom search predicate, pins the selected row at the top via a
  hidden `_focusOrder` column (0 for selected, 1 for children) ordered
  ascending, and groups the children under a "Children of #N" header
  via DataTables RowGroup keyed on a synthetic `_focusGroup` string
  field. `clearSelection()` disengages — RowGroup disabled, order
  restored, `_focusGroup` cleared. A controls-bar chip `#focusChip`
  shows the active focus and × to clear. Parents may stream in AFTER
  the user has engaged focus, so `absorbParents` extends the focus set
  on the fly when a freshly-stamped row's `_parent` matches the active
  focus serial.

  **Parent column click.** Each Parent cell renders as
  `<a class="parent-link">` carrying `data-serial`. A delegated click
  handler on tbody navigates to the parent serial (which itself
  re-engages focus mode on that parent — selection IS focus). The
  click handler `stopPropagation`s so the row's own click doesn't also
  fire.

  **Parent derivation has two layers** (see `_deriveParent` in
  row-table.mjs):
    1. *Outbound GUID priority* — `ZhuRenGuid` > `JianZhuBuilderUid`
       / `RaftSpaceBuilderUid` > `GongHuiGuid`. Covers NPCs (owner =
       player), buildings/stations/vehicles (owner = builder), guild
       members.
    2. *Inbound ObjectRef at a parent-pointing path* — currently
       `HBindBGCompActor` (NPC pawn → its inventory) and
       `BindBaoGuoActor` (workbench / chest / container → its
       inventory). Inventory storage rows carry no upward GUID ref of
       their own; the OWNER points downward at them via an
       ObjectProperty, so we resolve them by looking at INBOUND
       ObjectRefs in `ReferencesService._objRefReferrersByName`.
  Without layer 2 every BindBGCompActor / BGActor_* row would be
  parentless. Add new path names to `PARENT_OBJREF_PATHS` as more
  parent → child wiring is found.

  **`findRowByActorName(name)`** — O(1) actor_name → row lookup backed
  by a lazy Map (`_actorNameIndex`). Invalidated on every mutation
  (rows-ready, unloaded, upsertRow, removeRow). Wired into
  `ReferencesService.setActorNameLookup` by the orchestrator so the
  service can resolve ObjectRef target paths to serials in O(1).

- **`HistoryService`** (`js/history-service.mjs`). Single-purpose bridge
  between RowTable selection and the browser history stack. Subscribes
  to `row-selected` / `row-deselected` / `rows-replaced` on RowTable and
  writes `?row=<serial>` into the URL (via `history.pushState` on every
  selection, `replaceState` on the first push of a session, and a clean
  no-row URL when the file changes). Listens for `popstate` and drives
  `rowTable.setSelection(serial)` / `clearSelection()` accordingly, with
  a `_suppress` flag so the resulting selection event doesn't re-push
  into history. Deep-linking is intentionally off — the URL is updated
  during the session for back/forward use only, and `?row=N` on first
  load is ignored (no row exists yet at boot anyway). Wired by
  `bootstrap.mjs` after `orchestrator.init()` finishes.

- **`Orchestrator`** (`js/orchestrator.mjs`). Composition root AND
  file-load lifecycle.
  - `init()` (one-shot):
    1. `Promise.all([lz4.init(), sqlite.init()])` — both wasm boots in
       parallel; the rest of init waits on both.
    2. `bindLz4(this._lz4)` — wires the main thread's lz4Decompress /
       lz4Compress in `blob.mjs`. Each worker does the same inside its
       own context.
    3. `await data.init({ sqlite, orchestrator: this })`
    4. `await rowTable.init({ orchestrator: this, search, dataService,
       classify, steam, i18n })`
    5. Install the FactExtractor → {SearchService, ReferencesService,
       RowTable} forwarding listener (filtered by per-load tag so an
       abandoned load's leftover batches don't pollute the new indices).
       Each consumer carries its own captured epoch so they can be
       cleared independently without coordinating across services.
  - `loadFile(bytes, label)` (per-call, only called by
    `DataService.switchTo`):
    1. `sqlite.open(bytes)` → handle.
    2. Validate `actor_table` exists, otherwise emit `'load-error'`.
    3. Query rows + run classify on each.
    4. Emit `'rows-ready'` BEFORE any blob decoding — UI renders
       immediately on SQL columns.
    5. `search.clear()` + `references.clear()`, then
       `factExtractor.decode(items, { tag: myLoadId })`. Both consumer
       epochs are captured here.
    6. Forwarding listener (installed in init) routes each `batch`
       event into `search.absorbBatch`, `references.absorbBatch`, AND
       `rowTable.absorbFacts`, filtered by `tag`.
    7. Emit `'file-loaded'` when the decode pass resolves.
  - `reindexRow(serial)` for single-row mutations (edit/delete
    callsites). Updates BOTH the search index and the references
    index in lockstep.

Per-worker startup: `lib/workers/decode-worker.mjs` constructs its own
`Lz4Service`, awaits `init()`, calls `bindLz4(svc)`, THEN sends the
`worker-ready` handshake. The pool waits on per-worker readiness before
sending the first batch — at least one browser dropped pre-eval
`postMessage` calls instead of queuing them per spec.

Honest blob-text search: `lib/unreal/strings.mjs::collectStrings(decoded)`
walks the decoded property tree (FName values, StrProperty contents,
ObjectRef paths + classPaths, SoftObjectRef asset paths, JSON strings,
plus string-valued binary structs — Guid / DateTime / Timespan) and
emits `[{path, value}]`. Path syntax: `PropName.SubField[i].key`,
with `.class` / `.sub` suffixes for the ObjectRef / SoftObjectRef
secondary fields. The decode worker turns that into a flat lowercased
haystack as `manifest.text`. The main thread keeps one entry per
serial keyed by `actor_serial` and substring-matches the search box
query against it.

GUIDs in the haystack: every `Guid` struct (ZhuRenGuid / GongHuiGuid /
SelfUid / JianZhuBuilderUid / …) gets emitted at its property path with
its canonical uppercase 8-4-4-4-12 hex string as value. FlexSearch
splits the GUID on `-` into five tokens, so a query like
`C843A973-AA2D-4A30-A5CF-D529A4CDB028` hits every row containing all
five (i.e. any row that holds that GUID anywhere). Searching for a
single segment also works (e.g. `D529A4CDB028`), but a substring that
straddles a `-` boundary won't — FlexSearch is in `forward` (prefix)
mode and the dash is a token break, not part of a token. See "Cross-row
GUID references" below for the offline analyzer that gives you the full
{serial, path} list per GUID without going through FlexSearch.

End-to-end verified on `world.db` (12,027 rows): `node test.mjs`
reports 0 decode errors; `node test-pool.mjs` reports 12 passed, 0
failed; `node test-roundtrip.mjs` reports 11,667 / 11,667 rows pass
byte-identical at 174.6 MB of verified bytes (zero `_sizeMismatch`
remaining); ~113M chars of haystack across all rows; ~2.2× parallel
speedup. TextProperty (FText) decodes correctly for all 41,761
occurrences. Key named objects verified: serial 17073 "Alfheimr"
(portal), 33810 "Alfheimr" (ship engine), 8213 NPC "Craftsman
[Aleena]".

## Architecture map

```
js/
  bootstrap.mjs         The single <script type="module"> entry. Imports
                        everything, constructs every service singleton,
                        builds the Orchestrator, publishes the SMDB.*
                        transitional shim, awaits orchestrator.init(),
                        then dynamic-imports app.mjs. See "Boot model".

  app.mjs               UI wiring only. The orchestrator already
                        constructed and inited DataService + RowTable
                        before app.mjs loads, so app.mjs reads them off
                        SMDB.* and attaches UI listeners. Owns the
                        detail panel, edit handlers, stash dialog,
                        scripts dialog, verify-codec dialog, download.

  util.mjs              escapeText / escapeAttr / debounce / fmtBytes
                        used across the page-rendering modules.

  property-tree.mjs     renderPropertyTree(decoded) → htmlString for
                        unreal-properties blobs. Includes perf
                        affordances; see "Property tree" below.

  sqlite-service.mjs    SqliteService + DatabaseHandle. Explicit init();
                        invalidate-on-supersede semantics.

  search-service.mjs    SearchService. absorbBatch / markDone for the
                        orchestrator path; refreshRow / dropRow / clear
                        / matches / hasIndex for everyone else.

  references-service.mjs ReferencesService. Same absorbBatch / markDone
                        / refreshRow / dropRow / clear contract as
                        SearchService. Query API:
                        referrersOf / referrersOfRow / selfUidOf /
                        rowBySelfUid / outboundFrom / stats.

  orchestrator.mjs      Orchestrator. Composition root + file-load
                        lifecycle. init() runs the wasm Promise.all,
                        binds lz4, and inits sub-modules.

  data-service.mjs      DataService. Public entry point for DB-file
                        work. Constructor is parameterless;
                        init({sqlite, orchestrator}) wires deps.

  row-table.mjs         RowTable. Constructor is parameterless;
                        init({orchestrator, search, references,
                        dataService, classify, steam, i18n}) wires
                        deps. Owns the parent column (`_parent` field),
                        focus mode (filter + RowGroup keyed on a
                        synthetic `_focusGroup` field, ordered by a
                        hidden `_focusOrder` numeric column), and the
                        `#focusChip` controls-bar chip.

  history-service.mjs   HistoryService. Bridges RowTable selection
                        events ↔ window.history. pushState on row
                        selection (?row=N), popstate → setSelection /
                        clearSelection. Suppression flag prevents the
                        popstate-triggered selection from re-pushing.

  classify.mjs          classify(row) → {kind, label, summary};
                        parseTransform, distanceMeters, etc.

  steam.mjs / stash.mjs / partials.mjs / i18n.mjs / locale/*.mjs
                        ES modules. (All previously IIFEs on SMDB.*.)

  codecs.mjs            Codec registry. JSON wrapper first, unreal-
                        properties second. createRegistry() for tests.

  codec-json.mjs        Length-prefixed JSON wrapper codec.

lib/unreal/
  io.mjs                Cursor + Writer — no Unreal semantics.
  primitives.mjs        FName + FGuid.
  structs.mjs           STRUCT_HANDLERS + StructValue.
  values.mjs            ObjectRef + SoftObjectRef + OpaqueValue +
                        FTextValue. FTextValue wraps decoded FText for
                        the four historyTypes seen on the wire:
                          -1 CultureInvariant — displayString
                           0 Base/Localized   — namespace + key + sourceString
                           2 OrderedFormat    — sourceFmt + [args]
                           4 AsNumber         — sourceValue + formatOptions
                                                + culture
                        Its `.text` getter returns the best displayable
                        string for each (the format string for 2, the
                        raw numeric value for 4). HistoryType 4 quirk:
                        ALL four embedded booleans (bHasFormatOptions,
                        AlwaysSign, UseGrouping, bHasCulture) serialize
                        as uint32 — legacy UE3 bool format, not the
                        UE4.27 default uint8.
  properties.mjs        PropertyTag + Property + Array/Set/Map values +
                        readValue / writeValue + property-stream r/w.
                        Encoder is byte-identical round-trip across all
                        of world.db; see "Encoder round-trip notes"
                        below for the six wire-form invariants that
                        have to be preserved. TextProperty is fully
                        decoded via readFText() (no longer an
                        OpaqueValue stub). ObjectProperty values
                        respect their size budget at top level
                        (readObjectValue) and inside arrays
                        (readArrayElement now takes a sizeHint),
                        matching the variable wire shape (kind-only,
                        +path, +path+classPath, or +embedded stream)
                        without overshooting. ArrayProperty<ObjectProperty>
                        values may carry a packed trailing binary
                        section after the elements — readObjectArrayTrailing
                        decodes the self-describing [stride, count, data]*
                        format and stores the parsed result on
                        `ArrayValue._trailing` (see
                        "ArrayProperty<ObjectProperty> trailing binary"
                        below).
  blob.mjs              UnrealBlob (top-level actor_data wrapper) +
                        lz4Decompress / lz4Compress. Backend is bound
                        at boot via bindLz4(service). NO top-level
                        await any more — importing blob.mjs has no
                        side effects.
  strings.mjs           collectStrings(decoded) → [{path, value}].
                        Handles FTextValue: emits the `.text` string
                        at the property path so FText content is
                        indexed in the search haystack.
  facts.mjs             collectFacts(decoded) → {displayName?,
                        customNote?, ownerPlayerName?}. Extracts
                        player-visible names from the property tree:
                        JianZhuDisplayName (FText), CurGaoShiString
                        (StrProperty), CustomBeiZhu, OwnerPlayerName.
                        deriveName(facts) → best single display string:
                        displayName → "note [owner]" → note → owner.
  refs.mjs              collectGuids(decoded) → [{path, guid}]. Filters
                        zero-GUID. Used by the decode worker to
                        populate manifest.references and by
                        scripts/find-guid-refs.mjs.

lib/workers/
  pool.mjs              DecodePool. Greedy pull queue, transferable
                        buffers, onBatchComplete callback, worker-ready
                        handshake before first dispatch.
  decode-worker.mjs     Worker entry. Constructs its own Lz4Service,
                        awaits init(), bindLz4, then announces ready.
                        Decodes a batch, builds the manifest (including
                        the `facts` field via collectFacts), returns.
  fact-extractor.mjs    FactExtractor (was WorkerService). Wraps
                        DecodePool. Events: batch / done / error, each
                        carrying {callId, tag, …}.

lib/lz4-wasm/
  lz4-service.mjs       Lz4Service class. init() loads the backend.
  lz4-browser.mjs       Browser-side LZ4 adapter (loads
                        lz4_wasm_bg.wasm via fetch +
                        WebAssembly.instantiateStreaming).
  lz4_wasm_bg.wasm      Copied in by eleventy.config.js passthrough.

lib/sqlite3/            sqlite3 WASM build (loaded by index.html as a
                        classic script tag, exposes
                        globalThis.sqlite3InitModule which SqliteService
                        picks up).

test.mjs                Node smoke + perf test. Constructs its own
                        Lz4Service for the main-thread serial pass
                        (workers each boot their own). --parallel runs
                        the worker pipeline alongside serial decode and
                        reports haystack stats + a sample row.

test-pool.mjs           Worker pool integrity + mechanics tests (12
                        tests, worker-ready handshake, batch delivery,
                        facts extraction for key serials). Run with
                        `node test-pool.mjs`.
test-roundtrip.mjs      Decode → re-encode → byte-compare for every
                        row in world.db. Skips lz4 (not byte-stable);
                        otherwise verifies the property-stream encoder
                        byte-for-byte. Current baseline: 11,667 / 11,667
                        rows pass at 174.6 MB of verified bytes — zero
                        skipped, zero failures. Exits 1 on any
                        unexpected failure.
test-transfer.mjs       Transfer cost analysis: measures postMessage
                        overhead for transferable vs non-transferable
                        payloads at various batch sizes.

scripts/find-guid-refs.mjs
                        Offline cross-reference analyzer. Decodes every
                        row, walks each property tree picking out Guid
                        structs, and prints a {serial, path}-grouped
                        list of which GUIDs appear in which rows. See
                        "Cross-row GUID references" below.
```

## Boot model

`bootstrap.mjs` is a top-level-await module: `await orchestrator.init()`
suspends it until both wasm backends are loaded and every sub-module is
inited. Then it `await import('./app.mjs')` (dynamic, not static —
because a static import would hoist app.mjs's evaluation BEFORE the
TLA on init resolved, and app.mjs needs the wired SMDB.*).

The classic defer script `<script src="lib/sqlite3/sqlite3.js" defer>`
runs before bootstrap's body (defer scripts execute in document order
ahead of module scripts), setting `globalThis.sqlite3InitModule`. The
orchestrator's init reads that global lazily from inside
`SqliteService.init()`, so document order is the only constraint.

There used to be a TLA chain through `blob.mjs` (it did its own
`await import('lz4-wasm-nodejs')` at module load), which made every
transitive importer a TLA module and forced a careful dynamic-import
dance to avoid a cache-warm race with classic-defer-script globals.
That's all gone now: `blob.mjs` imports without side effects, the
orchestrator does the wasm boots explicitly, and every legacy IIFE has
been converted to ESM. The only TLA boundary left is bootstrap's
`await orchestrator.init()` → dynamic `import('./app.mjs')`.

**Rule of thumb:** if you add a `<script type="module">` that uses
top-level await, do NOT mix it with classic `defer` scripts that depend
on its globals. We currently have exactly one classic defer script
(sqlite3.js), and it has no dependency on us — keep it that way.

## Per-row worker manifest

Defined in `lib/workers/decode-worker.mjs`.

```js
{ kind: 'unreal-properties' | 'json-wrapped' | 'unknown' | 'empty' | 'error',
  decodeOk: bool,
  error: string | null,
  references: [{kind:'guid', guid, path}],
                    // every Guid struct in the property tree, paired
                    // with the property path it was found at. Zero-GUID
                    // (00000000-...) is filtered. Built by
                    // `collectGuids` from lib/unreal/refs.mjs — shared
                    // with scripts/find-guid-refs.mjs.
                    // Future kinds (not yet populated): 'objectref'
                    // instance suffixes, 'softobj' asset paths,
                    // 'steam-id'.
  text: string,     // flat lowercased haystack, newline-joined paths+values
  // unreal-properties only:
  terminated?: bool,
  bodyTrailingLen?: int,
  topLevelPropertyNames?: string[],
  facts?: { displayName?: string,   // JianZhuDisplayName (FText) or
            customNote?: string,    // CurGaoShiString (StrProperty)
            ownerPlayerName?: string } | null,
                    // Player-visible names extracted by collectFacts()
                    // from lib/unreal/facts.mjs. null when no facts
                    // found. deriveName(facts) collapses these into
                    // a single display string for the Name column.
                    // Only present on unreal-properties blobs.
  // json-wrapped only:
  parseError?: string | null }
```

Stats from `node test.mjs --parallel` on world.db (12,027 rows):
35,817 GUID refs total, avg 3.0/row, max 132/row, 11,791 rows
(~98%) carry at least one ref. The wins on top of plain text search:
the `(serial, path)` pair is preserved so a reverse index can answer
"who points at this row?" with the originating property name intact —
something the flat haystack throws away.

## Property tree renderer

`js/property-tree.mjs` exports a single `renderPropertyTree(decoded) →
htmlString`. The tree is type-dispatch over Unreal property kinds with
two perf affordances baked in:

- **Auto-collapse past `AUTO_OPEN_DEPTH = 2`.** Top-level rows and
  their immediate children open by default; deeper subtrees stay closed
  so the browser doesn't lay out their content until the user drills in.
  This was the highest-impact fix on big blobs — open `<details>`
  content participates in layout; closed `<details>` content does not.
- **Collection cap (`COLLECTION_DISPLAY_CAP = 50`).** Arrays / sets /
  maps over the cap render the first 50 items + a "show K more" row
  whose remainder lives in a module-scoped one-shot stash. A delegated
  click handler (installed lazily on first render, on `document`) reads
  `data-stash` off the row, consumes the stash entry, and splices the
  remaining HTML in. The stash thunks call `renderCappedItems`
  recursively — so 1000-element arrays chunk into nested show-more
  links and each click reveals the next 50. Revisit if that ever feels
  worse than one big expansion.

**StrProperty JSON detection.** Soulmask sometimes stores Unreal-side
payloads as JSON-encoded strings inside ordinary `StrProperty` values
— observed cases include `RelativeTransform` and
`HuodongZhongxinLocation`. `renderStrValue` cheaply pre-checks the
first byte for `{` (0x7B) / `[` (0x5B) and tries `JSON.parse`; on
success it expands the parsed object/array as a collapsible sub-tree
via `renderJsonValue` + `renderJsonChild`. Failed parses fall back to
the original `JSON.stringify(value)` view (escaped quotes, raw chars
visible). The decision is name-agnostic — any StrProperty whose value
parses gets the structured view. Round-trip is unaffected; the encoder
writes the row's original string verbatim.

The next planned addition is per-leaf editing (textbox / dropdown /
combo per Unreal type). This needs a `propertyEditors` registry
mirroring the existing `partials.fieldFor` pattern, plus a dirty
tracker across the whole subtree and an encoder hookup
(`writePropertyStream` → lz4Compress → write `actor_data`). The
encoder already exists in `lib/unreal/properties.mjs`; the wiring is
new. **Don't reach for a tree library (jstree etc.) here** — the
complexity is in type-dispatch + editor widgets, not tree mechanics,
and a tree library's selection/focus model fights form controls inside
nodes.

## Soulmask custom `Map<Struct,Struct>` framing

Soulmask uses several conventions inside `MapProperty<StructProperty,
StructProperty>` that diverge from stock UE 4.27. Standard UE serializes
struct keys and values as raw fields driven by reflection metadata —
Soulmask doesn't have that metadata at deserialize time, so it inlines a
mix of patterns that we sniff at decode. Discovered while decoding the
five maps under `GAMEMODE.HGongHuiGuanLiQi.*` (the guild manager).

- **Keys are raw 16-byte FGuids.** No inline struct shape; we assume
  `Guid` for every `StructProperty` key. Every populated map we've seen
  uses guild / player / entity guids as keys, so this holds.
- **Values are *either* a nested property stream OR a raw FGuid**, with
  no inline tag distinguishing the two:
  - `GongHuiMap`, `PlayerGongHuiDataMap`, `GeRenJianZhuYingHuoList`,
    `GeRenMapRiZhi` → values are tag-based property streams terminated
    by `None`. Different from stock UE (where map struct values are raw
    struct fields). Inside the property stream live the actual entity
    data: guild names, member arrays, permission lists, etc.
  - `PlayerGongHuiMap` → values are raw 16-byte FGuids (a
    player-guid → guild-guid lookup).
  We pick which shape by peeking the bytes after the key:
  `peekLooksLikePropertyTag` in `lib/unreal/properties.mjs` looks for a
  small positive int32 length prefix followed by NUL-terminated
  identifier ASCII (`A-Z` / `a-z` / `0-9` / `_`). A random GUID's first
  uint32 essentially never satisfies that; a property tag's name FString
  always does. False-positive probability is below 1 in millions.
- **`tag.size` is unreliable.** For the populated `GongHuiMap` the tag
  reports `size = 632,838` bytes, but the actual data section is
  `636,422` bytes (a 3,584-byte under-count). The decoder advances by
  pair count + per-pair shape, not by `tag.size`, so the cursor lands
  cleanly at the next property regardless. Round-trip writes the
  original tag.size verbatim, so byte-identical re-emit still works
  (verified: GAMEMODE round-trips on `UnrealBlob.verifyRoundTrip`, full
  scan still 0 errors).

End-to-end on world.db: the five guild-manager maps now decode (vs.
falling back to OpaqueValue), `manifest.references` grows from 35,817
to 38,227 entries / 32,592 → 34,079 distinct GUIDs / 11,791 → 11,800
rows with refs. The property tree renders the guild row inline (Aleena
appears as `HuiZhangUid → #18699`, `HuiZhangName: "Aleena"`,
`ChuangJianZheName: "Alexander"`, member arrays, permission entries,
3,088-item action log). `scripts/find-guid-refs.mjs --guid=<guildGuid>`
now lists `[11] GAMEMODE — HGongHuiGuanLiQi.GongHuiMap[0].value.Uid`
alongside the 1,043 referrers.

The property tree renderer (`js/property-tree.mjs::renderMapValue`)
expands `StructValue` map values as nested children rather than
JSON-stringifying them inline (which was the prior behavior — and it
visibly dumped a multi-KB blob into the row's summary). Guid-shaped
keys and values render as jump links via the same `renderGuidValue`
path the StructProperty(Guid) leaves use.

## Cross-row GUID references

`scripts/find-guid-refs.mjs` walks every row of a DB, decodes the blob,
visits every `Guid` struct in the property tree, and builds a reverse
index `GUID → [{ serial, name, path }]`. The walker is shared with
the decode worker — both call `lib/unreal/refs.mjs::collectGuids`, so
the script's offline output and the live manifest's `references` field
are guaranteed to agree on what counts as a reference and where the
property path is.

The zero-GUID `00000000-0000-0000-0000-000000000000` is filtered at the
walker level — it's the "unset" sentinel and would otherwise dominate
the cross-ref table with thousands of meaningless matches.

```sh
node scripts/find-guid-refs.mjs                                  # cross-refs in ./world.db
node scripts/find-guid-refs.mjs /path/to/other.db                # other DB
node scripts/find-guid-refs.mjs --guid=C843A973-AA2D-4A30-A5CF-D529A4CDB028
node scripts/find-guid-refs.mjs --all                            # every GUID, including unique
node scripts/find-guid-refs.mjs --json                           # JSON; pipes well into jq
```

Observed relationship patterns (world.db, 12,027 rows / 32,592 distinct
GUIDs / 509 cross-row GUIDs):
- An NPC's `ZhuRenGuid` (master/owner) usually equals a player row's
  `SelfUid` AND that player's `ChuShiKeLongData.ManRenUId` AND their
  `ControlledPawn` — the player↔NPC ownership/control chain.
- An NPC's `GongHuiGuid` (guild) equals the guild row's `SelfUid`. NPCs
  also share their owner-player's `GongHuiGuid` with other NPCs in the
  same guild.
- `JianZhuBuilderUid` / `RaftSpaceBuilderUid` link buildings + rafts
  back to the player who built them.
- `PeiFangMakingEntry.RequesterID` on workbenches points at the player
  who queued the recipe.

These patterns are how the planned `references` manifest field (see
Next Steps #1 below) will eventually populate without needing the full
property tree on the main thread — the worker just emits the GUID and
path pairs, and a `ReferencesService` keeps a live reverse-index that
updates as rows are absorbed.

## Next steps

1. **GUID cross-references are live in the UI; non-GUID ref kinds are
   next.** The worker manifest carries
   `references: [{kind:'guid', guid, path}]` for every Guid struct
   (zero-GUID filtered). `ReferencesService` consumes these via the
   same FactExtractor forwarding path as SearchService and answers
   `referrersOf` / `referrersOfRow` / `selfUidOf` / `rowBySelfUid` /
   `outboundFrom` in O(1) or O(bucket) time. The UI exposes the index
   in two places:
   - **`js/property-tree.mjs`** renders every Guid struct leaf as a
     jump link (resolved) or muted hex (unresolved — no loaded row
     claims that SelfUid). `configurePropertyTree({references,
     onGuidClick})` is called once at app boot; the delegated click
     handler inside property-tree.mjs invokes `onGuidClick(serial)`,
     which `app.mjs` wires to `rowTable.setSelection`. The lookup is
     done at render time so a row indexed AFTER the detail panel
     opened still renders the older link as unresolved (re-select the
     row to refresh). Most rows on `world.db` have ~38 resolved + ~48
     unresolved guid leaves — common for the unresolved bucket to
     include refs that live in `accounts.db` instead.
   - **Detail panel "Relationships" section** (rendered by
     `renderRelationshipsSection` in `app.mjs`). Two subsections:
       - *Points to* — each outbound guid ref shown as a row of
         `<path> → #<serial> <row_label>` (or the muted hex when
         unresolved). Click navigates.
       - *Pointed to by* — filter buttons keyed by relationship
         category. Each button calls
         `rowTable.setRelationshipFilter({label, kind, originSerial,
         serials})`; the row-table custom search short-circuits on the
         allow-list before the text/kind/anchor predicates so the
         filters intersect. A chip appears in the controls bar
         (`#relationshipChip`) with a × to clear. The chip is
         auto-cleared on file change / unload / Guid link click.
   - **Naming convention for the filter buttons** (observed paths in
     world.db, defined in `REL_PATHS` in `app.mjs`):
       - *Owned* → `ZhuRenGuid`
       - *Built* → `JianZhuBuilderUid` or `RaftSpaceBuilderUid`
       - *Guild* → `GongHuiGuid`
       - *All*   → every referrer.
     A button is only rendered when its bucket is non-empty, so a row
     with no `ZhuRenGuid` referrers won't surface an "Owned NPCs"
     button.
   - **Open: virtual rows for nested entities.** Player identities
     are now handled (HPlayerState's `ZhuRenGuid` is the player's own
     guid). Guild data is also now decoded — see "Soulmask custom
     `Map<Struct,Struct>` framing" below — but the entries live
     INSIDE `GAMEMODE.HGongHuiGuanLiQi.GongHuiMap[*]`, not as standalone
     `actor_table` rows. Today `referrersOf(guildGuid)` only resolves
     to top-level row identities (via `IDENTITY_PATH_BY_KIND` keyed on
     a row's `_kind`). For map-entry-as-entity resolution we'd want
     to either:
       - Synthesize virtual rows from map entries (one row per
         `GongHuiMap` entry, etc.), with a path-prefix identity so
         RowTable can render and select them. Most invasive but
         cleanest model.
       - Or extend `IDENTITY_PATH_BY_KIND` with a "nested identity"
         entry: e.g. on `system` rows, paths matching
         `HGongHuiGuanLiQi.GongHuiMap[*].value.Uid` are identity. The
         service would need to walk the manifest's references list
         and recognize those paths; `rowBySelfUid(guildGuid)` would
         then return the GAMEMODE serial + the sub-path. RowTable
         doesn't model sub-row navigation, so the UI would land you
         on GAMEMODE with the guild's sub-tree expanded — needs
         that affordance to be useful.
     Until either lands, GongHuiGuid refs render unresolved in the
     property tree (muted hex) and the "Guild members" filter button
     stays empty for player rows.
   - **Additional reference kinds** (next slice). `ObjectProperty`
     instance suffixes (`BP_FooActor_C_2147481234`), `SoftObjectRef`
     asset paths, Steam IDs embedded in player blobs. Add new
     `kind:` tags at the walker layer (extend `lib/unreal/refs.mjs`)
     and parallel indices inside `ReferencesService` — both consumers
     subscribe to the same FactExtractor batches.

2. **Property tree renderer: FTextValue support.** `js/property-tree.mjs`
   currently has no case for `FTextValue` — it falls through to whatever
   default renders, which likely dumps the raw object. Add a
   `FTextValue` branch that displays the `.text` string (and optionally
   the namespace/key for historyType 0 as a muted subtitle).

3. **Per-leaf editing in the property tree.** See "Property tree
   renderer" above. The plan is: `propertyEditors` registry → render
   inputs for leaves of editable types → walk the detail panel for
   dirty inputs → re-build the property tree → `writePropertyStream` →
   `lz4Compress` → `UPDATE actor_table SET actor_data = ?`. Start with
   one or two simple types (`IntProperty`, `BoolProperty`) to prove
   the dirty + save loop end-to-end before tackling collections and
   enums (which also need enum-value metadata for dropdowns).

4. **Mutation / serialize round-trip.** `UnrealBlob.serialize()` still
   throws when `_dirty` is set, but the underlying encoder is now
   verified byte-identical for EVERY row in `world.db`
   (`node test-roundtrip.mjs` — 11,667 / 11,667 pass at 174.6 MB of
   verified bytes, zero skipped, zero failures). The ergonomic step
   now is exposing edit helpers on `UnrealBlob` and flipping the
   `_dirty` gate to actually re-encode through `writePropertyStream` +
   `lz4Compress` — the serialize pipeline below it is sound.

5. **Worker pool tuning.** Defaults are `size: workerCount-1,
   batchSize: 200`. ~2.2× speedup on the test box with 15 workers;
   postmessage overhead and main-thread buffer-copy time are likely
   capping the ratio. Possible levers: batch more rows (fewer
   postmessages), do the blob → fresh ArrayBuffer copy in chunks
   instead of per-row, or look at SharedArrayBuffer (only if
   cross-origin isolation is acceptable).

6. **Empty-state controls bar.** `#controls { display: flex }` in
   index.html beats the `hidden` attribute that `updateChrome` sets
   when no DB is loaded — so the search / kindFilter / anchor row
   stays visible on the empty page. Pre-existing; a one-line
   `#controls[hidden] { display: none }` fixes it. Flagged 2026-05-15
   while testing DataService.

## Encoder round-trip notes

`writePropertyStream` is the canonical serializer. `test-roundtrip.mjs`
verifies byte-identical decode → encode for every row in `world.db`
(11,667 / 11,667 pass, 174.6 MB of bytes verified). Six sharp edges
have to be respected for that round-trip to hold — each surfaced as a
multi-thousand-row regression in the round-trip test before being fixed:

1. **`OpaqueValue` fallback can land in any property slot.** Decode may
   fall back to `OpaqueValue` for Array/Set/Map/Struct/Text/Object values
   whose structured decode threw. `writeValue` checks for `OpaqueValue`
   up-front and emits the captured bytes verbatim — every per-type writer
   assumes its specific value shape and would crash dereferencing fields
   like `value.elements.length`.

2. **`ObjectRef.path` and `.classPath` are wire-absent vs wire-empty.**
   A kind-only ObjectProperty value (`tag.size === 1`) has NO FString on
   the wire at all — distinct from an FString with `SaveNum=0` (null
   form, 4 B) or `SaveNum=1` (empty-with-terminator, 5 B). `ObjectRef`
   uses `null` to mean "not on wire" and tracks `_pathIsNull` /
   `_classPathIsNull` to preserve the SaveNum=0 vs SaveNum=1 distinction
   for empty fields that WERE on the wire. The writer skips the FString
   entirely when the field is `null`. Without this, every kind-only
   reference inflated by 4 B per encode.

3. **Embedded ObjectProperty's 4-byte FName.Number trailer must be
   replayed.** Some Soulmask nested ObjectProperty streams (e.g.
   `JianZhuInstGLQComponent`) carry the outermost-stream None-trailer
   convention: 4 bytes of `FName.Number = 0` after the embedded stream's
   None FString. `readObjectValue` detects this when exactly 4 bytes
   remain in the tag's size budget and sets
   `ObjectRef.hasTerminatorTrailer = true`; `ObjectRef.write` passes the
   flag through to `writeNestedPropertyStream` so the trailer is emitted.

4. **`FTextValue` empty-FString sub-fields preserve the wire's
   null-vs-empty-with-terminator form.** Same SaveNum=0 vs SaveNum=1
   distinction as ObjectRef, applied to `namespace` / `key` /
   `sourceString` (historyType=0) and `displayString` (historyType=-1).
   Per-field `_*IsNull` flags are captured on read and forwarded to
   `writeFString` on write.

5. **ArrayProperty<ObjectProperty> elements use content-based field
   detection, not equal-split budgets.** Inner ObjectProperty elements
   have variable shapes (kind-only, +path, +path+classPath, +full
   embedded stream) with no per-element delimiter. The original equal-
   split heuristic (`floor(remainingBudget / numElementsLeft)`) breaks
   on `JianZhuInstYuanXings`-style arrays where one element legitimately
   needs more bytes than the average (e.g. an embedded `MapProperty`
   value of 30 KB while siblings are 1-byte null references) — the big
   element's stream gets truncated mid-property, then the cursor crashes
   into the next element's bytes as garbage. The current scheme gives
   each element the FULL remaining array budget as a generous upper
   bound and lets four content-based peeks decide field boundaries:
   - **kind=0 early-out** — null-reference elements are JUST the kind
     byte; observed in trailing slots of `JianZhuInstYuanXings`,
     `ZhuangBeiLanDaoJuJiYiList`, `KuaiJieLanDaoJuJiYiList`.
   - **classPath '/' guard** — Soulmask classPaths are always
     `/Script/...` or `/Game/...`, so the first content byte must be
     `0x2F`. Catches the case where bytes after `path` are actually
     the next element's `kind` + `kindOnePrefix` (e.g. `01 01 00 00`
     reads as a "saveNum=257" that the magnitude check misses).
   - **Embedded-stream identifier-start guard** — embedded streams
     start with a `PropertyTag` whose first FString is the property
     name; property names start with a letter or underscore. If the
     byte at `cursor.pos()+4` isn't `[A-Za-z_]`, no embedded stream
     follows.
   - **4-byte trailer detection** — after the embedded stream's None
     terminator, peek the next 4 bytes. If they're all zero (typical
     `FName.Number = 0` trailer pattern), consume them and set
     `hasTerminatorTrailer=true`; the same condition works for both
     mid-array elements (next element's `kind=1`/`3` follows, non-zero)
     and the last element before the trailing binary section (origin's
     12 zero bytes follow, distinctively zero-padded).

   `writeArrayElement` does not force `requireClassPath: true` — the
   writer respects whatever the reader captured.

6. **Known-binary structs can appear as TAGGED property streams.**
   Inside Map struct values, Soulmask sometimes serializes
   `Transform` / `Box` / `Sphere` / etc. as a tagged stream of named
   sub-properties (e.g. `Rotation:Quat`, `Translation:Vector`,
   `Scale3D:Vector`) rather than as the raw 40-byte (or N-byte) record
   the binary handler expects. `StructValue.read` accepts an optional
   `peekFn` callback (the same `peekLooksLikePropertyTag` heuristic used
   for Map struct-value discrimination); when the wire looks tagged,
   the read switches to the property-stream path even when a handler
   exists. The decision is recorded implicitly: `value` is an object
   for handler-path reads, an array of `Property` for stream-path
   reads. `StructValue.write` dispatches on `Array.isArray(value)`, so
   the same struct can round-trip either way without explicit metadata.

For all six, `null` vs `''` semantics and value-shape matter — don't
normalize them away in helper layers (i18n, search index, etc.) or
you'll re-introduce the byte drift.

7. **Soulmask `kind=0x01` ObjectProperty actor-reference variant.**
   Hard actor references (e.g. an NPC pawn's `HBindBGCompActor` →
   its inventory actor) serialize with an extra 4-byte field between
   the kind byte and the path FString: `u8 kind=0x01 | u32 prefix |
   FString path | FString classPath`. The prefix value is always 1 in
   the samples we've seen — semantic meaning unknown (a flag, an
   FName.Number, or a count) — but the writer has to replay whatever
   the reader captured, so `ObjectRef` stores it as `_kindOnePrefix`
   and `readObjectValue` / `readArrayElement` consume it only when
   `kind === 0x01`. Without this branch the reader treated the prefix
   as the path FString's SaveNum, overshot the budget, and silently
   downgraded the property to `OpaqueValue` — which is why every
   pawn→inventory link was invisible to `ReferencesService` until
   2026-05-18. Verified: 11,667 / 11,667 still round-trip
   byte-identical after the change.

## ArrayProperty<ObjectProperty> per-element trailing (JianZhuInstYuanXings)

A Soulmask-specific custom binary layout that lives inside the tag size
budget of `JianZhuInstYuanXings` (building instance prototype lists on
the `BP_JianZhuPianQu` building-zone actors that hold all of a player's
structures — foundations, walls, doors, etc., plus the equivalent on
boats and rafts).

`numElements` does NOT equal placed-piece count. It counts how many
**distinct prototype shapes** the zone uses (1 if the player only built
foundations; 4 if they used foundation + wall + door frame + thatch
foundation — verified by an in-game test bonfire experiment 2026-05-18
where each new prototype incremented numElements by 1).

Layout (after the `int32 numElements` field):

```
for each prototype i in 0..numElements-1:
  ObjectRef                    kind=3 yuan-xing definition. Standard
                               wire form: kind byte | path FString |
                               classPath FString "/Script/WS.HJianZhuInstComponent" |
                               embedded property stream | "None" terminator |
                               4-byte FName.Number trailer. The embedded
                               stream carries MapInstJianZhuDataList (per-
                               piece HP map), JianZhuYuanXingName, and
                               JianZhuYuanXingClass.
  [8 bytes zero header]        Always observed as zeros. Treated as
                               opaque; replayed verbatim.
  [u32 stride=64] [u32 count]  [count × 64 bytes]
                               World 4×4 row-major FMatrix44 transforms
                               for placed pieces of prototype i.
                               Translation at floats[12..14].
                               count = number of placed pieces of this prototype.
  [u32 stride= 4] [u32 count]  [count × 4 bytes]
                               Per-piece u32 piece-ids (matches the
                               JianZhuUid keys in MapInstJianZhuDataList).
                               Same count as section 0.
  [u32 stride=64] [u32 count]  [count × 64 bytes]
                               Auxiliary per-piece struct (bounding box
                               + scale-ish floats based on inspection;
                               not yet decoded semantically). count is
                               typically equal to or 1 greater than
                               section 0's count.
```

Decoder: `lib/unreal/properties.mjs::tryReadObjectArrayPerElementTrailing`.
Called once per element from `readArrayValue`'s loop, returns null when
the bytes don't match the format (so non-JianZhuInstYuanXings object
arrays are unaffected). On success the parsed `{ header, sections }`
is stored on `ArrayValue._perElementTrailings[i]`, parallel to
`elements[i]`. Round-trip: `writeArrayValue` emits each element's
trailing immediately after the element, before moving to the next.

A legacy `ArrayValue._trailing` field remains for the
"single trailing block after all elements" case — currently unused on
any `world.db` row but kept for backward compatibility in case other
arrays use that older layout.

Earlier hypotheses that turned out wrong, kept here so they don't get
re-derived:
- **"3-float origin"**. The first 8 bytes of a per-element trailing
  block are zeros, but they aren't a 3-float `FVector` — they're 8B,
  not 12B. A 12-byte read would consume bytes 8..11 (the stride=64) as
  `origin.z`, then mis-read section 0's count as a stride and the first
  4 transform bytes as a count ("implausible count 3204775516"). The
  one-stone-foundation in-game test settled this empirically.
- **"`numElements` = placed-piece count"**. Adding a second stone
  foundation while keeping the prototype the same did NOT change
  `numElements` (still 1); it increased section 0/1 counts to 2 and
  section 2 to 3. `numElements` only ticks up when you place a piece
  whose prototype isn't already in the zone.
- **"`kind=0` placeholder slots"**. Earlier the reader saw `0x00` bytes
  after elem[0] (the 8-byte header for the next prototype) and treated
  them as `kind=0` null-reference elements one byte each. For
  numElements > 9 the placeholders overran the 8-byte zero header into
  the section data; the fix is now the per-element trailing read AFTER
  each element, so subsequent elements start at the correct kind=3
  yuan-xing byte.

Renderer (`js/property-tree.mjs::renderArrayValue`) walks each element
and appends its per-element trailing as a child node, so the tree
visually mirrors the prototype-by-prototype structure.

## Known issues / footguns

- **No remaining `_sizeMismatch` cases** in `world.db` after the
  ChengHaoList / RelativeTransform / JianZhuInstYuanXings work. Every
  row round-trips byte-identically through the encoder. If new save
  files surface new mismatches, `test-roundtrip.mjs` will flag them
  immediately (it exits non-zero on any unexpected failure).

- **OpaqueValue audit** (`world.db`, 11,667 rows, 2026-05-18).
  After all the structured-decode work, the decoder produces
  **ZERO `OpaqueValue` leaves** — down from 7,455 before. Every property
  in every row now decodes structurally; round-trip is byte-identical.
  Categories decoded:
    - **FTextHistory_AsNumber** (historyType=4): 4,298 → 0
    - **TextProperty inside ArrayProperty**: 7,253 → 0
    - **SetProperty<StructProperty>**: 2 → 0
    - **ArrayProperty<ObjectProperty> budget errors**: ~150 → 0
    - **`JianZhuInstYuanXings` multi-prototype zones**: 15 → 0 (see below)

- **`JianZhuInstYuanXings` per-element trailing format** (2026-05-18,
  verified by in-game experiment with 1 stone foundation → 2 → +wall →
  +door frame → +disconnected thatch foundation). The decode previously
  assumed a single "trailing binary section" after all array elements,
  which only worked for single-prototype zones (numElements=1). The
  actual wire layout interleaves placement-binary **per element**:

  ```
  int32 numElements              (= count of UNIQUE prototypes in the zone)
  for each prototype i:
    kind=3 ObjectRef             (yuan-xing definition: path + classPath +
                                  embedded {MapInstJianZhuDataList,
                                  JianZhuYuanXingName, JianZhuYuanXingClass}
                                  + None + 4-byte FName.Number trailer)
    8 bytes zero header
    [u32 64] [u32 count_i_pieces] [count×64 bytes]  ← world 4×4 transforms
    [u32  4] [u32 count_i_pieces] [count× 4 bytes]  ← per-piece u32 ids
    [u32 64] [u32 count_i_aux  ]  [count×64 bytes]  ← per-piece aux (bbox+scale-ish)
  ```

  Decoded into `ArrayValue._perElementTrailings[i] = { header, sections }`
  parallel to `elements[i]`. The reader detects per-element trailing by
  peeking 8 zero bytes + stride=64 immediately after each element; the
  legacy `_trailing` field is still populated when bytes remain at the
  array's tail (for backward compat — currently unused on world.db).

  numElements **does not equal placed-piece count**. It counts how many
  distinct prototype shapes the zone uses (e.g. 1 stone foundation alone
  = numElements=1 even with 28 pieces placed; foundation + wall = 2).
  Section 0/1 counts are the placed-piece count for that prototype.
  Doors are attachments to door frames, not separate prototypes.

- **TLA + classic defer ordering.** If you add a `<script
  type="module">` that uses top-level await, do not mix it with
  classic `defer` scripts that depend on its globals. We currently
  have one TLA module (`bootstrap.mjs`) and one classic defer script
  (`sqlite3.js`); the defer script has no dependency on us, which is
  why this works. Don't break that.
- **`sqlite3InitModule` is one-shot per page.** `lib/sqlite3/sqlite3.js`
  sets `globalThis.sqlite3InitModuleState` (carrying `urlParams`,
  `wasmFilename`, etc.) in an IIFE at script load, then DELETES it on
  the first call to `sqlite3InitModule`. Subsequent direct calls fall
  back to a stub object lacking `urlParams` and throw `"Cannot read
  properties of undefined (reading 'has')"` inside `locateFile`.
  `SqliteService.init()` memoizes the result, so going through the
  service is safe. Debug / test code that needs the sqlite3 module
  instance should use `SMDB.sqliteService._sqlite3` (or
  `await SMDB.sqliteService.init()`) — never call
  `globalThis.sqlite3InitModule` directly a second time.
- **`npm install` on a no-MSVC Windows machine**: `better-sqlite3`
  ships prebuilt binaries via `prebuild-install`, so it works. No
  other native deps.
- **Bare-specifier imports**: `lib/workers/pool.mjs` deliberately
  picks `globalThis.Worker` first and only falls back to
  `await import('web-worker')` in Node. Native-ESM browsers can't
  resolve bare specifiers without an import map.
- **`web-worker` workers consume `self`-style API.** If you write a
  new worker file and use `parentPort.postMessage(...)` from
  `worker_threads`, it'll break the browser path. Stick to
  `self.postMessage(...)` + `self.addEventListener('message', ...)`.
- **Transferring detaches.** `FactExtractor.decode` transfers each
  item's `buffer`. Callers must hand in INDEPENDENT ArrayBuffers (one
  per row) — Orchestrator does the per-row copy when building items
  from sqlite blobs. If you ever want to keep the bytes around on the
  main thread, copy first or re-query sqlite (sqlite is the source of
  truth).
- **Worker-module startup race.** Without the worker-ready handshake,
  the FIRST batch sent to a brand-new Worker can be silently dropped
  (observed in at least one browser). If you write a new worker, send
  the ready message AFTER both wiring `addEventListener` AND any wasm
  init the worker depends on, and gate first dispatch on it in the
  pool.
- **lz4 backend must be bound before use.** `lib/unreal/blob.mjs` no
  longer auto-boots lz4 on import. The orchestrator binds it on the
  main thread during `init()`; each worker binds its own inside
  `decode-worker.mjs`; `test.mjs` binds one for the main-thread
  serial pass. Any new context that imports `blob.mjs` and calls
  `lz4Decompress` / `lz4Compress` must call `bindLz4(svc)` first or
  it'll throw `"lz4: no backend bound"`.

## Dev-only on-disk DB loader

Lets you (or Claude) load an arbitrary `.db` off the dev machine without
dragging-and-dropping each iteration. Two pieces, both gated to dev so
they never affect the Cloudflare deployment.

- **`scripts/dev-fileserver.mjs`** — tiny Node HTTP server bound to
  `127.0.0.1:7777` only. Single endpoint:
  `GET /load?path=<absolute path>`. Refuses anything whose extension
  isn't `.db` (case-insensitive). No path-allowlist beyond the
  extension: loopback IS the trust boundary, since plenty of other `.db`
  files on the box must NOT be exfiltratable. Lives in `scripts/` which
  is outside every eleventy passthrough — it can never deploy.
- **`js/dev/loader.mjs`** — registers `SMDB.dev.load(path)` /
  `SMDB.dev.endpoint`. Fetches from the loopback server, wraps the
  bytes in a `File`, calls `DataService.addFile` + `switchTo`. Rides
  along inside the existing `addPassthroughCopy('js')` (≈2 KB inert in
  prod). `bootstrap.mjs` only dynamic-imports it when
  `location.hostname` is `localhost` / `127.0.0.1` / `::1`, so on the
  deployed origin the module is never executed.

Usage:
```sh
npm run start-dev     # concurrently: fileserver + wrangler dev
```
Then in the browser console (or via Claude Preview's `preview_eval`):
```js
await SMDB.dev.load('C:\\Users\\you\\saves\\world.db');
```

If you ever need a non-default port, set `SMDB_DEV_PORT=NNNN` on the
fileserver side and `SMDB.dev.endpoint = 'http://127.0.0.1:NNNN/load'`
in the page. `npm start` (without `-dev`) still works exactly as before
— `SMDB.dev` registers but `load()` throws a clear "Is the dev
fileserver running?" error.

## Run things

```sh
npm install                              # only if a fresh checkout
npm test                                 # serial decode, all 12k rows
node test.mjs --parallel                 # serial + parallel + speedup
node test.mjs --parallel=4               # override pool size
node test.mjs /path/to/other.db          # other database file
node test-pool.mjs                       # worker pool integrity tests (12 tests)
node test-roundtrip.mjs                  # decode → encode → byte-compare every row
node test-transfer.mjs                   # transfer cost analysis
node scripts/find-guid-refs.mjs          # cross-row GUID references in world.db
node scripts/find-guid-refs.mjs --guid=…  # all rows holding a specific GUID
npm start                                # build + wrangler dev (browser)
npm run start-dev                        # start + dev-fileserver on :7777
```
