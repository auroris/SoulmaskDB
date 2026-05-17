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

- **`ReferencesService`** (`js/references-service.mjs`). Cross-row GUID
  reverse index, fed by the same FactExtractor `batch` events
  SearchService consumes. The walker that produced this data
  (`lib/unreal/refs.mjs::collectGuids`) lives upstream — the service
  itself is pure book-keeping. State:
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
    5. Install the FactExtractor → {SearchService, ReferencesService}
       forwarding listener (filtered by per-load tag so an abandoned
       load's leftover batches don't pollute the new indices). Each
       consumer carries its own captured epoch so they can be cleared
       independently without coordinating across services.
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
       event into both `search.absorbBatch` and
       `references.absorbBatch`, filtered by `tag`.
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

End-to-end verified on `world.db` (12,027 rows): node test reports 0
mismatches, ~113M chars of haystack across all rows, ~2.2× parallel
speedup. Browser cold-start with a synthetic blob: lz4 round-trips
through both main-thread codec and worker pool cleanly.

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
                        init({orchestrator, search, dataService,
                        classify, steam, i18n}) wires deps.

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
  values.mjs            ObjectRef + SoftObjectRef + OpaqueValue.
  properties.mjs        PropertyTag + Property + Array/Set/Map values +
                        readValue / writeValue + property-stream r/w.
  blob.mjs              UnrealBlob (top-level actor_data wrapper) +
                        lz4Decompress / lz4Compress. Backend is bound
                        at boot via bindLz4(service). NO top-level
                        await any more — importing blob.mjs has no
                        side effects.
  strings.mjs           collectStrings(decoded) → [{path, value}].
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
                        Decodes a batch, builds the manifest, returns.
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

2. **Per-leaf editing in the property tree.** See "Property tree
   renderer" above. The plan is: `propertyEditors` registry → render
   inputs for leaves of editable types → walk the detail panel for
   dirty inputs → re-build the property tree → `writePropertyStream` →
   `lz4Compress` → `UPDATE actor_table SET actor_data = ?`. Start with
   one or two simple types (`IntProperty`, `BoolProperty`) to prove
   the dirty + save loop end-to-end before tackling collections and
   enums (which also need enum-value metadata for dropdowns).

3. **Mutation / serialize round-trip.** `UnrealBlob.serialize()` still
   throws when `_dirty` is set. The decoder is solid; the encoder is
   wired but untested for round-trip after edits. The ergonomic step
   is exposing edit helpers on `UnrealBlob` and proving serialize →
   write to sqlite → reload → decode survives a real edit. Prerequisite
   for #2 above.

4. **Worker pool tuning.** Defaults are `size: workerCount-1,
   batchSize: 200`. ~2.2× speedup on the test box with 15 workers;
   postmessage overhead and main-thread buffer-copy time are likely
   capping the ratio. Possible levers: batch more rows (fewer
   postmessages), do the blob → fresh ArrayBuffer copy in chunks
   instead of per-row, or look at SharedArrayBuffer (only if
   cross-origin isolation is acceptable).

5. **Empty-state controls bar.** `#controls { display: flex }` in
   index.html beats the `hidden` attribute that `updateChrome` sets
   when no DB is loaded — so the search / kindFilter / anchor row
   stays visible on the empty page. Pre-existing; a one-line
   `#controls[hidden] { display: none }` fixes it. Flagged 2026-05-15
   while testing DataService.

## Known issues / footguns

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
node scripts/find-guid-refs.mjs          # cross-row GUID references in world.db
node scripts/find-guid-refs.mjs --guid=…  # all rows holding a specific GUID
npm start                                # build + wrangler dev (browser)
npm run start-dev                        # start + dev-fileserver on :7777
```
