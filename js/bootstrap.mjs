/**
 * Page bootstrap — the single `<script type="module">` index.html loads.
 *
 * Responsibilities:
 *   1. Import every ESM piece of the codebase (Unreal codec primitives,
 *      codec registry, services, i18n + locale catalogs, classify, steam,
 *      stash, partials).
 *   2. Construct the service singletons with no async work in their
 *      constructors. (Lz4Service, SqliteService, FactExtractor,
 *      SearchService, DataService, RowTable.)
 *   3. Construct the Orchestrator with references to all of the above.
 *   4. Re-publish everything on `window.SMDB.*` for callsites that still
 *      reach for it through the global. New code should import from the
 *      .mjs source directly; the SMDB.* surface is a transitional shim.
 *   5. `await orchestrator.init()` — this is the only async boot step:
 *      it runs Promise.all on the lz4 + sqlite3 wasm boots, binds lz4
 *      into blob.mjs, then inits DataService and RowTable with the
 *      resources each one needs.
 *   6. Dynamically import the UI module (`./app.mjs`). It expects every
 *      SMDB.* slot populated and every sub-module initialized, which is
 *      guaranteed by this point.
 *   7. Auto-open the data dialog if nothing is loaded.
 *
 * Why dynamic import for app.mjs:
 *   This file does top-level `await` (on orchestrator.init). A static
 *   `import './app.mjs'` would hoist app.mjs's evaluation to BEFORE
 *   this body runs, and app.mjs would see an un-inited SMDB.*. The
 *   dynamic import fires after the await chain completes.
 */

import { Cursor, Writer }                     from '../lib/unreal/io.mjs';
import { FName, FGuid }                       from '../lib/unreal/primitives.mjs';
import { STRUCT_HANDLERS, StructValue }       from '../lib/unreal/structs.mjs';
import { ObjectRef, SoftObjectRef, OpaqueValue } from '../lib/unreal/values.mjs';
import {
  PropertyTag, Property,
  ArrayValue, SetValue, MapValue,
  readPropertyStream, writePropertyStream, writeNestedPropertyStream,
  readValue, writeValue,
} from '../lib/unreal/properties.mjs';
import {
  UnrealBlob, codec as unrealCodec,
  lz4Decompress, lz4Compress, OUTER_VERSION_TAG,
} from '../lib/unreal/blob.mjs';
import { collectStrings } from '../lib/unreal/strings.mjs';
import { collectGuids }   from '../lib/unreal/refs.mjs';
import { codecJson }      from './codec-json.mjs';
import { codecs as defaultCodecs, createRegistry } from './codecs.mjs';
import { DecodePool }     from '../lib/workers/pool.mjs';
import { Lz4Service }                    from '../lib/lz4-wasm/lz4-service.mjs';
import { FactExtractor }                 from '../lib/workers/fact-extractor.mjs';
import { SqliteService, DatabaseHandle } from './sqlite-service.mjs';
import { SearchService }                 from './search-service.mjs';
import { ReferencesService }             from './references-service.mjs';
import { Orchestrator }                  from './orchestrator.mjs';
import { DataService }                   from './data-service.mjs';
import { RowTable }                      from './row-table.mjs';
import { i18n }     from './i18n.mjs';
import { en }       from './locale/en.mjs';
import { zh }       from './locale/zh.mjs';
import { classify } from './classify.mjs';
import { steam }    from './steam.mjs';
import { stash }    from './stash.mjs';
import { partials } from './partials.mjs';

const root = (typeof window !== 'undefined') ? window : globalThis;
root.SMDB = root.SMDB || {};
root.SMDB.unreal = root.SMDB.unreal || {};

// ── Unreal primitives + codec registry ─────────────────────────────────────
Object.assign(root.SMDB.unreal, {
  Cursor, Writer,
  FName, FGuid,
  STRUCT_HANDLERS, StructValue,
  ObjectRef, SoftObjectRef, OpaqueValue,
  PropertyTag, Property,
  ArrayValue, SetValue, MapValue,
  readPropertyStream, writePropertyStream,
  _writeNestedStream: writeNestedPropertyStream,
  readValue, writeValue,
  UnrealBlob,
  lz4Decompress, lz4Compress,
  OUTER_VERSION_TAG,
  codec: unrealCodec,
  collectStrings,
  collectGuids,
});

root.SMDB.codecJson             = codecJson;
root.SMDB.codecUnrealProperties = unrealCodec;
root.SMDB.codecs                = defaultCodecs;
root.SMDB.createCodecRegistry   = createRegistry;
root.SMDB.DecodePool            = DecodePool;

// ── Service classes (for direct instantiation if needed) ───────────────────
root.SMDB.Lz4Service        = Lz4Service;
root.SMDB.SqliteService     = SqliteService;
root.SMDB.DatabaseHandle    = DatabaseHandle;
root.SMDB.FactExtractor     = FactExtractor;
root.SMDB.SearchService     = SearchService;
root.SMDB.ReferencesService = ReferencesService;
root.SMDB.Orchestrator      = Orchestrator;
root.SMDB.DataService       = DataService;
root.SMDB.RowTable          = RowTable;

// ── i18n / classify / steam / stash / partials ─────────────────────────────
// Shimmed onto SMDB.* so existing call sites (app.mjs, partials' render
// helpers, etc.) keep working without rewriting every reference. New code
// should import these directly from their .mjs source.
root.SMDB.i18n     = i18n;
root.SMDB.classify = classify;
root.SMDB.steam    = steam;
root.SMDB.stash    = stash;
root.SMDB.partials = partials;
// app.mjs's language switcher still reads window.SMDB_LOCALES[code]._displayName.
// Mirror the catalogs onto that global until the language switcher migrates
// to i18n.availableLocales() + a future i18n.displayName helper.
root.SMDB_LOCALES  = { en, zh };

// ── Construct service singletons (no async work in constructors) ───────────
// Constructors only set up internal state. The wasm boots and DOM wiring
// happen inside orchestrator.init() below.
const lz4Service        = new Lz4Service();
const sqliteService     = new SqliteService();
const factExtractor     = new FactExtractor();
const searchService     = new SearchService({
  codecs: defaultCodecs,
  collectStrings,
});
const referencesService = new ReferencesService({
  codecs: defaultCodecs,
  collectGuids,
});
const dataService       = new DataService();
const rowTable          = new RowTable();
const orchestrator      = new Orchestrator({
  lz4:           lz4Service,
  sqlite:        sqliteService,
  factExtractor,
  search:        searchService,
  references:    referencesService,
  data:          dataService,
  rowTable,
  classify,
  steam,
  i18n,
});

// Publish singletons. Keep the SMDB.workerService alias so any external
// consumer pinned to that name still resolves; new code should reach for
// SMDB.factExtractor.
root.SMDB.lz4Service    = lz4Service;
root.SMDB.sqliteService = sqliteService;
root.SMDB.factExtractor = factExtractor;
root.SMDB.workerService = factExtractor;
root.SMDB.search        = searchService;
root.SMDB.references    = referencesService;
root.SMDB.data          = dataService;
root.SMDB.rowTable      = rowTable;
root.SMDB.orchestrator  = orchestrator;

// ── The only async step: boot wasm + init sub-modules ──────────────────────
await orchestrator.init();

// Hand off to the UI module. Static `import './app.mjs'` would hoist its
// evaluation ahead of orchestrator.init(); the dynamic import fires only
// after the await above completes.
await import('./app.mjs');

// ── Dev-only loader (loopback hostname only) ──────────────────────────────
// Pairs with scripts/dev-fileserver.mjs (started by `npm run start-dev`)
// and exposes SMDB.dev.load(path) for loading arbitrary .db files off the
// dev machine without dragging-and-dropping each time. In a deployed
// Cloudflare build location.hostname is the public domain, this branch
// short-circuits, and js/dev/loader.mjs is never imported.
if (typeof location !== 'undefined' &&
    ['localhost', '127.0.0.1', '::1'].includes(location.hostname)) {
  try { await import('./dev/loader.mjs'); }
  catch (e) { console.warn('[SMDB.dev] loader unavailable:', e.message); }
}

// After app.mjs has applied i18n to the static DOM, auto-open the data
// dialog if nothing is loaded yet — gives the user a place to land.
dataService.maybeAutoOpen();
