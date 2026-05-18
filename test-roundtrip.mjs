/**
 * Test: byte-identical round-trip for every actor_data property stream.
 *
 * For every row in world.db:
 *   1. LZ4-decompress + decode the property stream (UnrealBlob.decode).
 *   2. Re-encode the inner version tag + property stream into a fresh buffer.
 *   3. Compare the re-encoded bytes to the original decompressed bytes.
 *
 * The LZ4 layer is intentionally skipped — LZ4 has many valid encodings for
 * the same payload, so the outer compressed bytes aren't byte-stable. The
 * decompressed property stream IS the canonical form, so that's what we
 * compare against.
 *
 * Rows are categorized into:
 *
 *   notProperties        Empty blobs / json-wrapped / non-unreal headers.
 *                        Nothing to round-trip.
 *   decodeError          Decode threw or recorded an error.
 *   unterminated         Decode OK but property stream didn't end on None.
 *                        Encoder always emits None, so round-trip can't be
 *                        byte-identical for these — skip.
 *   bodyTrailing         Decode OK, terminated, but extra bytes after None
 *                        that the encoder won't reproduce — skip.
 *   skippedMismatch      Some property in the tree carries _sizeMismatch.
 *                        writePropertyStream refuses to re-emit those —
 *                        skip and tally by property name.
 *   roundTripOK          Re-encoded bytes match the original decompressed
 *                        bytes exactly.
 *   roundTripFail        Anything else — the regression tripwire. The exit
 *                        code is non-zero iff this count is non-zero.
 *
 * Usage:
 *   node test-roundtrip.mjs                  (looks for world.db at the repo root)
 *   node test-roundtrip.mjs /path/to/other.db
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { Writer } from './lib/unreal/io.mjs';
import { writePropertyStream } from './lib/unreal/properties.mjs';
import { UnrealBlob, bindLz4 } from './lib/unreal/blob.mjs';
import { Lz4Service } from './lib/lz4-wasm/lz4-service.mjs';

const _lz4 = new Lz4Service();
await _lz4.init();
bindLz4(_lz4);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = process.argv[2] || path.join(__dirname, 'world.db');
if (!fs.existsSync(dbPath)) {
  console.error(`ERROR: database file not found: ${dbPath}`);
  console.error('Pass the path as an argument: node test-roundtrip.mjs /path/to/world.db');
  process.exit(1);
}

const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true });

let rows;
try {
  rows = db.prepare('SELECT actor_serial, actor_data FROM actor_table').all();
} catch (e) {
  console.error('ERROR: could not query actor_table:', e.message);
  process.exit(1);
}

console.log(`Database: ${dbPath}`);
console.log(`Rows: ${rows.length}`);
console.log('');

// Recursively visit every Property in a decoded tree (top-level properties,
// embedded ObjectRef streams, StructProperty streams, ArrayProperty<Struct>
// elements, MapProperty struct-value streams). Used to enumerate every
// _sizeMismatch in a row so skipsByProperty captures the FULL distribution,
// not just the first-encountered property name from the encoder throw.
function visitProperties(properties, visit) {
  if (!Array.isArray(properties)) return;
  for (const p of properties) {
    visit(p);
    const v = p.value;
    if (v == null) continue;
    // ObjectRef with embedded property stream.
    if (v.embedded) visitProperties(v.embedded, visit);
    // StructValue: value is either a property array (unknown struct) or a
    // plain binary record (known struct via STRUCT_HANDLERS) — skip the
    // latter, recurse the former.
    if (v._structName && Array.isArray(v.value)) visitProperties(v.value, visit);
    // ArrayProperty / SetProperty elements: when innerType is StructProperty
    // the elements are StructValues whose .value is a nested stream.
    if (Array.isArray(v.elements)) {
      for (const e of v.elements) {
        if (e && e._structName && Array.isArray(e.value)) visitProperties(e.value, visit);
        // ObjectRef inside an array element (innerType=ObjectProperty)
        if (e && e.embedded) visitProperties(e.embedded, visit);
      }
    }
    // MapProperty struct-value streams.
    if (Array.isArray(v.entries)) {
      for (const ent of v.entries) {
        const ev = ent.value;
        if (ev && ev._structName && Array.isArray(ev.value)) visitProperties(ev.value, visit);
      }
    }
  }
}

const stats = {
  total: 0,
  notProperties: 0,
  decodeError: 0,
  unterminated: 0,
  bodyTrailing: 0,
  skippedMismatch: 0,
  roundTripOK: 0,
  roundTripFail: 0,
};
const skipsByProperty = new Map();   // property name → row-occurrence count (per-row, not per-mismatch)
const failures = [];

const startMs = Date.now();
let totalBytes = 0;

for (const row of rows) {
  stats.total++;

  if (!row.actor_data || row.actor_data.byteLength === 0) {
    stats.notProperties++;
    continue;
  }
  const u8 = new Uint8Array(row.actor_data.buffer, row.actor_data.byteOffset, row.actor_data.byteLength);
  if (!UnrealBlob.detect(u8)) {
    stats.notProperties++;
    continue;
  }

  let blob;
  try {
    blob = UnrealBlob.decode(u8);
  } catch (e) {
    stats.decodeError++;
    failures.push({ serial: row.actor_serial, phase: 'decode-throw', msg: e.message });
    continue;
  }
  if (blob.error) {
    stats.decodeError++;
    failures.push({ serial: row.actor_serial, phase: 'decode-error', msg: blob.error });
    continue;
  }
  if (!blob.terminated) {
    stats.unterminated++;
    continue;
  }
  if (blob.bodyTrailing && blob.bodyTrailing.length > 0) {
    stats.bodyTrailing++;
    continue;
  }

  // Tally any _sizeMismatch found anywhere in this row. One row contributes
  // at most once to each property name (Set), so the counts are comparable
  // across runs (changing tree shape doesn't double-count).
  const mismatchedNames = new Set();
  visitProperties(blob.properties, (p) => {
    if (p._sizeMismatch && p.name) mismatchedNames.add(p.name);
  });
  if (mismatchedNames.size > 0) {
    stats.skippedMismatch++;
    for (const n of mismatchedNames) skipsByProperty.set(n, (skipsByProperty.get(n) || 0) + 1);
    continue;
  }

  // Round-trip: encode the inner version tag + property stream into a
  // fresh writer, compare to the original decompressed bytes.
  const orig = blob._decompressed;
  let re;
  try {
    const w = new Writer(orig.length || 256);
    w.writeUint32(blob.innerVersionTag);
    writePropertyStream(w, blob.properties, /*emitTerminatorTrailer=*/true);
    re = w.finalize();
  } catch (e) {
    stats.roundTripFail++;
    failures.push({ serial: row.actor_serial, phase: 'encode-throw', msg: e.message });
    continue;
  }
  totalBytes += orig.length;

  if (re.length !== orig.length) {
    stats.roundTripFail++;
    failures.push({
      serial: row.actor_serial,
      phase: 'length-mismatch',
      msg: `re=${re.length} orig=${orig.length}`,
    });
    continue;
  }
  let firstDiff = -1;
  for (let i = 0; i < re.length; i++) {
    if (re[i] !== orig[i]) { firstDiff = i; break; }
  }
  if (firstDiff >= 0) {
    stats.roundTripFail++;
    // Context dump — 16 bytes either side of the first divergence so a
    // failing run gives us something to bisect with.
    const ctxStart = Math.max(0, firstDiff - 16);
    const ctxEnd   = Math.min(re.length, firstDiff + 16);
    const fmt = (arr) => Array.from(arr.subarray(ctxStart, ctxEnd))
      .map(b => b.toString(16).padStart(2, '0')).join(' ');
    failures.push({
      serial: row.actor_serial,
      phase: 'byte-mismatch',
      msg: `@0x${firstDiff.toString(16)}: orig=0x${orig[firstDiff].toString(16).padStart(2,'0')} re=0x${re[firstDiff].toString(16).padStart(2,'0')}`,
      context: { orig: fmt(orig), re: fmt(re), ctxStart },
    });
    continue;
  }
  stats.roundTripOK++;
}

const elapsedMs = Date.now() - startMs;

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.log(`=== Failures (${failures.length}) ===`);
  // Group by phase so a sea of "byte-mismatch" doesn't drown out a single
  // "encode-throw" — both are real regressions, but they suggest different
  // root causes.
  const byPhase = new Map();
  for (const f of failures) {
    if (!byPhase.has(f.phase)) byPhase.set(f.phase, []);
    byPhase.get(f.phase).push(f);
  }
  for (const [phase, list] of byPhase) {
    console.log(`  [${list.length}x] ${phase}`);
    for (const f of list.slice(0, 3)) {
      console.log(`    serial=${f.serial}: ${f.msg}`);
      if (f.context) {
        console.log(`      orig @${f.context.ctxStart}: ${f.context.orig}`);
        console.log(`      re   @${f.context.ctxStart}: ${f.context.re}`);
      }
    }
    if (list.length > 3) console.log(`    ... and ${list.length - 3} more`);
  }
  console.log('');
}

if (skipsByProperty.size > 0) {
  console.log('=== Skipped due to _sizeMismatch (encoder refuses to re-emit) ===');
  console.log('(Per-row counts: each row contributes at most once per property name.)');
  const sorted = [...skipsByProperty.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log(`  [${String(count).padStart(4)}x] ${name}`);
  }
  console.log('');
}

const verified = stats.roundTripOK;
const verifiableTotal = verified + stats.roundTripFail;
const pct = verifiableTotal > 0 ? (verified / verifiableTotal * 100).toFixed(2) : '0';

console.log('=== Summary ===');
console.log(`  Total rows:               ${stats.total}`);
console.log(`  Not unreal-properties:    ${stats.notProperties}`);
console.log(`  Decode errors:            ${stats.decodeError}`);
console.log(`  Unterminated:             ${stats.unterminated}`);
console.log(`  Body-trailing bytes:      ${stats.bodyTrailing}`);
console.log(`  Skipped (_sizeMismatch):  ${stats.skippedMismatch}`);
console.log(`  Round-tripped OK:         ${stats.roundTripOK}  (${pct}% of attempted)`);
console.log(`  Round-trip FAILURES:      ${stats.roundTripFail}`);
console.log(`  Bytes verified:           ${totalBytes.toLocaleString()}`);
console.log(`  Wall clock:               ${elapsedMs} ms`);

process.exit(stats.roundTripFail > 0 ? 1 : 0);
