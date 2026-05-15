/**
 * Page bootstrap — the single `<script type="module">` index.html loads.
 *
 * Responsibilities:
 *   1. Import the ES-module side of the codebase (Unreal codec primitives,
 *      codec registry, services).
 *   2. Construct the app-level service singletons (SqliteService,
 *      WorkerService, SearchService) and publish their classes.
 *   3. Re-publish everything on `window.SMDB.*` so the legacy non-module
 *      scripts (app.js, classify.js, partials.js, stash.js, steam.js,
 *      i18n.js, locale/*.js) keep working unchanged. They opt into `defer`
 *      in index.html so this module executes first.
 *
 * Why the Orchestrator is NOT constructed here:
 *   Orchestrator needs the classify function, which lives in `js/classify.js`
 *   (a legacy IIFE). The IIFE scripts run AFTER this module due to
 *   index.html load ordering, so `SMDB.classify` doesn't exist yet at this
 *   point. App.js constructs the Orchestrator at its own initialization,
 *   when classify has landed. Bootstrap publishes the *class* via
 *   `SMDB.Orchestrator` so app.js can instantiate it without an import.
 *
 *   When classify.js becomes a module (part of a future modularization
 *   pass), bootstrap can take ownership of the Orchestrator instance too.
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

// ── Service singletons (page-scoped, lifetime = page) ──────────────────────
// SqliteService boots the sqlite3 WASM lazily on first open(). WorkerService
// spins up Workers lazily on first decode(). SearchService is cheap to build.
root.SMDB.sqliteService = new SqliteService();
root.SMDB.workerService = new WorkerService();
root.SMDB.search        = new SearchService({
  codecs: defaultCodecs,
  collectStrings,
});

// Orchestrator construction happens in app.js — it needs SMDB.classify
// (a legacy IIFE) which is loaded AFTER this module per index.html order.
// app.js publishes the instance at SMDB.orchestrator.
