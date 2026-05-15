# Handoff notes — service architecture + honest search

Snapshot of where this branch sits at 2026-05-15, so the next session
(human or LLM) can pick up cold.

## What just happened

Two refactor passes on top of the prior worker-pool work:

### Pass 1 — honest blob-text search

The old filter advertised "also searches strings inside blobs" but
actually scanned the LZ4-compressed bytes for printable-ASCII runs;
most matches were random byte coincidences in the compressed payload.

- New `lib/unreal/strings.mjs::collectStrings(decoded)` walks the
  decoded property tree (FName values, StrProperty contents, ObjectRef
  paths + classPaths, SoftObjectRef asset paths, JSON strings) and
  emits `[{path, value}]`. Path syntax: `PropName.SubField[i].key`,
  with `.class` / `.sub` suffixes for the ObjectRef / SoftObjectRef
  secondary fields.
- The decode worker turns that into a flat lowercased haystack and
  ships it as `manifest.text`. The main thread keeps one entry per
  serial keyed by `actor_serial` and substring-matches the search box
  query against it.
- Worker pool gained an `onBatchComplete` callback (`pool.decodeAll`)
  so consumers can stream per-batch progress instead of waiting on the
  full pass.

### Pass 2 — service architecture + orchestrator

Replaced the monolithic load flow in `app.js` (which interleaved
sqlite init, blob decoding, indexing, and UI updates) with four
loosely-coupled pieces:

- **`SqliteService`** (`js/sqlite-service.mjs`) — factory. Lazy-boots
  the sqlite3 WASM on first `open(bytes)` call; returns a
  `DatabaseHandle`. Each new `open()` invalidates the prior handle so
  any code still holding a reference throws on use (`"DatabaseHandle:
  this handle has been invalidated"`) rather than silently writing to
  the wrong DB.
- **`WorkerService`** (`js/worker-service.mjs`) — owns a `DecodePool`
  lazily. `decode(items, { tag })` returns a promise of full results
  AND emits per-batch `batch`/`done`/`error` events. `tag` is opaque
  to the service and passed through on every event, so multiple
  callers can each filter to their own batches.
- **`SearchService`** (`js/search-service.mjs`) — owns the per-serial
  haystack `Map<serial, lowercased text>`. The orchestrator feeds it
  via `absorbBatch(items, {epoch})` as worker batches land. Also
  exposes synchronous `refreshRow(serial, bytes)` / `dropRow(serial)`
  for single-row mutations (edit and delete callsites avoid the
  worker round-trip for one row). Epoch logic ignores stale batches
  from an abandoned load.
- **`Orchestrator`** (`js/orchestrator.mjs`) — composes the three.
  `loadFile(bytes, label)`:
  1. `sqlite.open(bytes)` → handle.
  2. Validates `actor_table` exists, otherwise emits `'load-error'`.
  3. Queries rows + runs classify on each.
  4. Emits `'rows-ready'` BEFORE any blob decoding starts — the UI
     renders immediately on SQL columns.
  5. `search.clear()`, then `worker.decode(items, { tag: myLoadId })`.
  6. A persistent listener routes `worker.batch` events to
     `search.absorbBatch(items, { epoch })`, filtered by `tag` so any
     batches from a superseded load are dropped.
  7. Emits `'file-loaded'` when the decode pass resolves.

  Also: `reindexRow(serial)` for single-row mutations (edit/delete
  callsites).

The decode-worker module gained a small but critical fix: it emits a
`worker-ready` handshake after `self.addEventListener('message', …)`
is wired, and the pool waits on per-worker readiness before sending
the first batch. At least one browser dropped pre-eval `postMessage`
calls instead of queuing them per spec.

End-to-end verified on `world.db` (12,027 rows): Node test reports 0
mismatches, ~113M chars of haystack across all rows, ~2.2× parallel
speedup. Browser cold-start with a synthetic 2-row DB: 640ms total,
non-blocking the whole time, `matches()` returns true for indexed
values after `'file-loaded'`.

## Architecture map

```
js/
  bootstrap.mjs        Module-load wiring. Imports everything (Unreal
                       primitives, codec registry, services), constructs
                       sqliteService / workerService / search singletons,
                       and publishes both classes and singletons on
                       window.SMDB.* so legacy IIFE scripts keep working.
                       Does NOT construct the Orchestrator — see below.

  sqlite-service.mjs   SqliteService factory + DatabaseHandle. Lazy
                       WASM boot on first open(). Invalidate-on-supersede
                       semantics for stale handles.

  worker-service.mjs   WorkerService wrapping DecodePool. Events:
                       batch / done / error, each carrying {callId, tag}.

  search-service.mjs   SearchService. absorbBatch / markDone for the
                       orchestrator path; refreshRow / dropRow / clear /
                       matches / hasIndex for everyone else. Own events:
                       batch / done / reset.

  orchestrator.mjs     Orchestrator. loadFile(bytes, label) + reindexRow.
                       Emits rows-ready / file-loaded / load-error.

  app.js               UI: file picker, table render, kind filter, search
                       box, detail panel, edit handlers, stash dialog,
                       scripts dialog, verify-codec dialog, download. Owns
                       `allRows` (canonical row list for the table) —
                       slated to move into the data-table component in
                       the UI refactor.

  classify.js          IIFE — exposes SMDB.classify. classify(row) →
                       {kind, label, summary}; parseTransform, etc. Will
                       be modularized in a follow-up.

  steam.js, stash.js, partials.js, i18n.js, locale/*.js
                       IIFEs. Same modularization debt.

  codecs.mjs           Codec registry. JSON wrapper first, unreal-
                       properties second. createRegistry() for tests.

  codec-json.mjs       Length-prefixed JSON wrapper codec.

lib/unreal/
  io.mjs               Cursor + Writer — no Unreal semantics.
  primitives.mjs       FName + FGuid.
  structs.mjs          STRUCT_HANDLERS + StructValue.
  values.mjs           ObjectRef + SoftObjectRef + OpaqueValue.
  properties.mjs       PropertyTag + Property + Array/Set/Map values +
                       readValue/writeValue + property-stream r/w.
  blob.mjs             UnrealBlob (top-level actor_data wrapper) + the
                       lz4-wasm dispatcher.
  strings.mjs          collectStrings(decoded) → [{path, value}] walker.

lib/workers/
  pool.mjs             DecodePool. Greedy pull queue, transferable
                       buffers, onBatchComplete callback, worker-ready
                       handshake before first dispatch.
  decode-worker.mjs    Worker entry. Decodes a batch, builds the flat
                       lowercased haystack, returns the manifest.

lib/lz4-wasm/
  lz4-browser.mjs      Browser-side LZ4 adapter (loads lz4_wasm_bg.wasm
                       via fetch + WebAssembly.instantiateStreaming).
  lz4_wasm_bg.wasm     Copied in by .eleventy.js passthrough.

lib/sqlite3/           sqlite3 WASM build (loaded by index.html as a
                       classic script tag, exposes globalThis.sqlite3-
                       InitModule which SqliteService picks up).

test.mjs               Node smoke + perf test. --parallel runs the
                       worker pipeline alongside serial decode and
                       reports haystack stats + a sample row.
```

## Per-row worker manifest

Defined in [lib/workers/decode-worker.mjs](lib/workers/decode-worker.mjs).

```js
{ kind: 'unreal-properties' | 'json-wrapped' | 'unknown' | 'empty' | 'error',
  decodeOk: bool,
  error: string | null,
  references: [],   // ← STILL A STUB. See "Next steps" below.
  text: string,     // flat lowercased haystack, newline-joined paths+values
  // unreal-properties only:
  terminated?: bool,
  bodyTrailingLen?: int,
  topLevelPropertyNames?: string[],
  // json-wrapped only:
  parseError?: string | null }
```

## Why Orchestrator is constructed in app.js (not bootstrap.mjs)

The Orchestrator depends on `SMDB.classify` for the per-row classify
call inside `loadFile`. `classify.js` is still a legacy IIFE, and the
IIFE scripts run AFTER bootstrap.mjs per index.html's defer ordering.
So bootstrap.mjs publishes the *class* (`SMDB.Orchestrator`) and the
service singletons; `app.js` constructs the orchestrator instance
itself.

When classify.js becomes a module (planned, see below), this gets
folded back into bootstrap.

## Next steps

1. **`references` is still a STUB.** This is the original
   cross-row reference extractor the worker pool was built for. The
   plan from the prior handoff is unchanged:
   - Pick 3 representative rows from `world.db` and look at their
     decoded property trees (a player, the player's BindBGCompActor,
     a chest at adjacent serial−1 of an inventory storage row).
   - Find the cross-row references — likely candidates:
     `SoftObjectProperty` / `SoftClassProperty` payloads
     (`SoftObjectRef.assetPath` strings), `ObjectProperty` payloads
     (`ObjectRef.path` strings, instance suffixes like
     `BP_FooActor_C_2147481234`), `FName` values that look like
     asset paths, Steam IDs embedded in player blobs.
   - Define `references[i]` as `{ kind, target }` and resolve
     `target` to another `actor_serial` when possible (raw path
     string fallback).
   - The extractor lives in `lib/workers/decode-worker.mjs::extractManifest`.
     Walk recursively into `StructValue.value`, `ArrayValue.elements`,
     `MapValue.entries`, `ObjectRef.embedded`.

   The decoupled architecture means a second consumer (a
   ReferencesService or similar) can subscribe to `WorkerService`'s
   `batch` events the same way `SearchService` does today —
   `Orchestrator._installWorkerForwarding()` is the template.

2. **UI / data-table component refactor.** The next planned
   refactor, per project direction. `app.js` is currently the home of
   table rendering, filters, the detail panel, the stash dialog, etc.
   That UI code wants to be a set of small components. Notable
   touchpoints:
   - `allRows` ownership should move to whichever component owns the
     table (likely a `RowTable` component).
   - The component subscribes to `SMDB.orchestrator` for `rows-ready`
     / `file-loaded`, and `SMDB.search` for `batch` (to re-apply the
     filter incrementally).
   - Detail panel + edit handlers split out similarly.

3. **Modularize the legacy IIFEs.** `classify.js`, `steam.js`,
   `stash.js`, `partials.js`, `i18n.js`, and `locale/*.js` are still
   `(function(){…})()` files that mutate `window.SMDB.*`. Converting
   them to ES modules is mostly mechanical, but each consumer also
   needs updating. Doing classify.js first lets bootstrap.mjs own
   Orchestrator construction.

4. **Mutation / serialize round-trip.** `UnrealBlob.serialize()`
   still throws when `_dirty` is set. The decoder is solid; the
   encoder is wired but untested for round-trip after edits. The
   ergonomic step is exposing edit helpers on `UnrealBlob` and
   proving serialize → write to sqlite → reload → decode survives a
   real edit.

5. **Worker pool tuning.** Defaults are `size: workerCount-1,
   batchSize: 200`. ~2.2× speedup on the test box with 15 workers;
   postmessage overhead and main-thread buffer-copy time are likely
   capping the ratio. Possible levers: batch more rows (fewer
   postmessages), do the blob → fresh ArrayBuffer copy in chunks
   instead of per-row, or look at SharedArrayBuffer (only if cross-
   origin isolation is acceptable).

## Known issues / footguns

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
- **Transferring detaches.** WorkerService.decode transfers each
  item's `buffer`. Callers must hand in INDEPENDENT ArrayBuffers (one
  per row) — Orchestrator does the per-row copy when building items
  from sqlite blobs. If you ever want to keep the bytes around in
  the main thread, copy first or re-query sqlite (sqlite is the
  source of truth).
- **Worker-module startup race.** Without the worker-ready
  handshake, the FIRST batch sent to a brand-new Worker can be
  silently dropped (observed in at least one browser). If you write a
  new worker, send the ready message AFTER wiring `addEventListener`
  in the worker, and gate first dispatch on it in the pool.
- **Top-level await in `blob.mjs`.** Importers must be ESM (or use
  dynamic `import()`). All current consumers are.

## Run things

```sh
npm install                              # only if a fresh checkout
npm test                                 # serial decode, all 12k rows
node test.mjs --parallel                 # serial + parallel + speedup
node test.mjs --parallel=4               # override pool size
node test.mjs /path/to/other.db          # other database file
npm start                                # build + wrangler dev (browser)
```
