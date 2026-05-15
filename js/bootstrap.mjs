/**
 * Page bootstrap — the single `<script type="module">` index.html loads.
 *
 * Responsibilities:
 *   1. Import the ES-module side of the codebase (Unreal codec primitives,
 *      codec registry, services).
 *   2. Construct the app-level service singletons (SqliteService,
 *      WorkerService, SearchService) and publish their classes.
 *   3. Re-publish everything on `window.SMDB.*` so the legacy non-module
 *      scripts (classify.js, partials.js, stash.js, steam.js, i18n.js,
 *      locale/*.js) can read it. They use `defer` in index.html.
 *   4. Dynamically import the UI module (`./app.mjs`) at the end, after
 *      everything it depends on is in place.
 *
 * Why bootstrap owns app.mjs loading:
 *   `blob.mjs` uses top-level `await` to initialize the lz4 wasm backend.
 *   That makes this entire module a top-level-await module. Browsers do
 *   NOT block subsequent classic `defer` scripts on a TLA module's
 *   promise — they keep running the defer queue while we're paused on
 *   the wasm fetch. If app.js were a classic defer script, it would run
 *   BEFORE this module reaches the `SMDB.Orchestrator = …` line, hitting
 *   "SMDB.Orchestrator is not a constructor".
 *
 *   The fix is to make app a module too and import it dynamically here,
 *   AFTER bootstrap's TLA settles and SMDB.* is fully populated. The
 *   classic defer scripts (i18n, classify, …) populate their own
 *   SMDB.{i18n,classify,…} slots independently and have all finished
 *   running by the time we get to the dynamic import.
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
import { codecJson }      from './codec-json.mjs';
import { codecs as defaultCodecs, createRegistry } from './codecs.mjs';
import { DecodePool }     from '../lib/workers/pool.mjs';
import { SqliteService, DatabaseHandle } from './sqlite-service.mjs';
import { WorkerService }                 from './worker-service.mjs';
import { SearchService }                 from './search-service.mjs';
import { Orchestrator }                  from './orchestrator.mjs';
import { DataService }                   from './data-service.mjs';

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
});

root.SMDB.codecJson             = codecJson;
root.SMDB.codecUnrealProperties = unrealCodec;
root.SMDB.codecs                = defaultCodecs;
root.SMDB.createCodecRegistry   = createRegistry;
root.SMDB.DecodePool            = DecodePool;

// ── Service classes (for direct instantiation if needed) ───────────────────
root.SMDB.SqliteService  = SqliteService;
root.SMDB.DatabaseHandle = DatabaseHandle;
root.SMDB.WorkerService  = WorkerService;
root.SMDB.SearchService  = SearchService;
root.SMDB.Orchestrator   = Orchestrator;
root.SMDB.DataService    = DataService;

// ── Service singletons (page-scoped, lifetime = page) ──────────────────────
// SqliteService boots the sqlite3 WASM lazily on first open(). WorkerService
// spins up Workers lazily on first decode(). SearchService is cheap to build.
root.SMDB.sqliteService = new SqliteService();
root.SMDB.workerService = new WorkerService();
root.SMDB.search        = new SearchService({
  codecs: defaultCodecs,
  collectStrings,
});

// Hand off to the UI module. Awaiting here is fine: we're already a TLA
// module, and by the time we reach this line the classic defer scripts
// (i18n, classify, steam, stash, partials) have all run, so app.mjs
// sees a fully-populated SMDB.*. app.mjs constructs the Orchestrator
// and DataService at its top level — both need defer-script state
// (classify) that is not guaranteed to be ready earlier in bootstrap
// when blob.mjs's TLA resolves from cache.
await import('./app.mjs');

// After app.mjs has applied i18n to the static DOM, auto-open the data
// dialog if nothing is loaded yet — gives the user a place to land.
root.SMDB.data.maybeAutoOpen();
