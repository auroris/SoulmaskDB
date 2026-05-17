/**
 * find-guid-refs.mjs — walk every row of a Soulmask DB and report Guid
 * struct values along with the property path they were found at. Used to
 * answer "which rows reference each other by GUID?" — e.g. an NPC's
 * `ZhuRenGuid` typically equals a player row's `SelfUid`, and a guild
 * name on an NPC (`GongHuiGuid`) matches a guild row's `SelfUid`.
 *
 * Usage:
 *   node scripts/find-guid-refs.mjs
 *     → defaults to ./world.db, prints every GUID that appears in >1
 *       row, grouped by GUID
 *   node scripts/find-guid-refs.mjs /path/to/other.db
 *   node scripts/find-guid-refs.mjs --guid=C843A973-AA2D-4A30-A5CF-D529A4CDB028
 *     → prints every row+path where the given GUID appears (any number
 *       of occurrences, including 1)
 *   node scripts/find-guid-refs.mjs --guid=C843A973...   /path/to/other.db
 *   node scripts/find-guid-refs.mjs --all
 *     → prints every GUID (including unique ones)
 *   node scripts/find-guid-refs.mjs --json
 *     → emit results as JSON (pairs well with jq)
 *
 * The walker lives in `lib/unreal/refs.mjs::collectGuids` so the worker
 * (lib/workers/decode-worker.mjs) and this script share one
 * implementation — same property paths, same zero-GUID filter. This
 * script lives in `scripts/` so it's outside every eleventy passthrough
 * and can't deploy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { codecs } from '../js/codecs.mjs';
import { Lz4Service } from '../lib/lz4-wasm/lz4-service.mjs';
import { bindLz4 } from '../lib/unreal/blob.mjs';
import { collectGuids } from '../lib/unreal/refs.mjs';

// Main-thread lz4 (blob.mjs is no longer self-booting — see handoff.md).
const _lz4 = new Lz4Service();
await _lz4.init();
bindLz4(_lz4);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let filterGuid = null;
let showAll    = false;
let asJson     = false;
const positional = [];
for (const arg of argv) {
  if (arg.startsWith('--guid=')) filterGuid = arg.slice('--guid='.length).toUpperCase();
  else if (arg === '--all')      showAll = true;
  else if (arg === '--json')     asJson = true;
  else if (arg.startsWith('--')) { console.error(`Unknown flag: ${arg}`); process.exit(2); }
  else positional.push(arg);
}
const dbPath = positional[0] || path.join(__dirname, '..', 'world.db');

if (!fs.existsSync(dbPath)) {
  console.error(`ERROR: database file not found: ${dbPath}`);
  process.exit(1);
}

// ── Open DB ──────────────────────────────────────────────────────────────────
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  console.error('ERROR: could not open database:', e.message);
  process.exit(1);
}

// ── Scan every row ───────────────────────────────────────────────────────────
const rows = db.prepare(
  'SELECT actor_serial, actor_name, actor_data FROM actor_table'
).all();

// GUID → [{ serial, name, path }]
const index = new Map();
let decodeFailures = 0;
const startMs = Date.now();

for (const row of rows) {
  if (!row.actor_data || row.actor_data.byteLength === 0) continue;
  const u8 = new Uint8Array(row.actor_data.buffer, row.actor_data.byteOffset, row.actor_data.byteLength);
  let decoded;
  try { decoded = codecs.decode(u8); }
  catch { decodeFailures++; continue; }
  if (decoded.error) { decodeFailures++; continue; }

  for (const { path: propPath, guid } of collectGuids(decoded)) {
    if (filterGuid && guid.toUpperCase() !== filterGuid) continue;
    const list = index.get(guid) || [];
    list.push({ serial: row.actor_serial, name: row.actor_name, path: propPath });
    if (list.length === 1) index.set(guid, list);
  }
}

const elapsedMs = Date.now() - startMs;

// ── Report ───────────────────────────────────────────────────────────────────
const entries = [...index.entries()]
  .filter(([, refs]) => filterGuid || showAll || refs.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

if (asJson) {
  console.log(JSON.stringify(
    entries.map(([guid, refs]) => ({ guid, refs })),
    null, 2,
  ));
  process.exit(0);
}

console.log(`Database: ${dbPath}`);
console.log(`Rows scanned: ${rows.length}, decode failures: ${decodeFailures}, scan time: ${elapsedMs} ms`);
console.log(`Distinct GUIDs found: ${index.size}`);
if (filterGuid) {
  console.log(`Filter: ${filterGuid}`);
} else {
  console.log(`Showing: ${showAll ? 'every GUID' : 'GUIDs that appear in >1 row'}`);
}
console.log('');

if (entries.length === 0) {
  console.log('(no matches)');
  process.exit(0);
}

for (const [guid, refs] of entries) {
  console.log(`${guid}  (${refs.length} ref${refs.length === 1 ? '' : 's'})`);
  for (const r of refs) {
    const nm = r.name ? ` "${r.name}"` : '';
    console.log(`  [${r.serial}]${nm} — ${r.path}`);
  }
  console.log('');
}
