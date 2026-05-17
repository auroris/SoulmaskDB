/**
 * Transfer-cost analysis: how expensive is it to receive the full decoded
 * JS object from a worker vs the current minimal manifest?
 *
 * Decodes every row serially on the main thread, then measures the cost of
 * structuredClone() for both the minimal manifest (current approach) and
 * the raw decoded object (hypothetical). structuredClone() is what
 * postMessage uses across the worker boundary, so this directly answers
 * whether returning full objects would dominate the total time budget.
 *
 * Sizes are measured via JSON.stringify (with a TypedArray replacer so
 * binary fields don't balloon the estimate).
 *
 * Usage: node test-transfer.mjs [/path/to/world.db]
 */

import fs   from 'node:fs';
import path from 'node:path';
import { performance }   from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { codecs }          from './js/codecs.mjs';
import { collectStrings }  from './lib/unreal/strings.mjs';
import { collectGuids }    from './lib/unreal/refs.mjs';
import { Lz4Service }      from './lib/lz4-wasm/lz4-service.mjs';
import { bindLz4 }         from './lib/unreal/blob.mjs';

const _lz4 = new Lz4Service();
await _lz4.init();
bindLz4(_lz4);

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = process.argv[2] || path.join(__dirname, 'world.db');
if (!fs.existsSync(dbPath)) { console.error(`ERROR: not found: ${dbPath}`); process.exit(1); }

const db   = new (require('better-sqlite3'))(dbPath, { readonly: true });
const rows = db.prepare(
  'SELECT actor_serial, length(actor_data) AS blob_len, actor_data FROM actor_table'
).all().filter(r => r.blob_len > 0);

console.log(`Database: ${dbPath}`);
console.log(`Rows:     ${rows.length} non-empty blobs\n`);

// ── Replicate the manifest shape from decode-worker.mjs ───────────────────────

function buildManifest(decoded) {
  const guidRefs = collectGuids(decoded);
  const refs     = guidRefs.map(r => ({ kind: 'guid', guid: r.guid, path: r.path }));
  const strs     = collectStrings(decoded);
  const parts    = [];
  for (const s of strs) { if (s.path) parts.push(s.path); if (s.value) parts.push(s.value); }
  const base = {
    kind: decoded.kind, decodeOk: !decoded.error, error: decoded.error ?? null,
    references: refs, text: parts.join('\n').toLowerCase(),
  };
  if (decoded.kind === 'unreal-properties') {
    return { ...base, terminated: !!decoded.terminated, bodyTrailingLen: decoded.bodyTrailing?.length ?? 0 };
  }
  return base;
}

// Substitute TypedArrays with a size placeholder so JSON.stringify gives a
// realistic byte-count estimate without the binary-as-key-value explosion.
const replacer = (_, v) => (ArrayBuffer.isView(v) ? `<bytes:${v.byteLength}>` : v);

// ── Measure ───────────────────────────────────────────────────────────────────

let decodeMs = 0;
let mCloneMs = 0, mJsonBytes = 0;   // manifest
let fCloneMs = 0, fJsonBytes = 0;   // full decoded object
let fCloneErrors = 0;
let n = 0;

for (const row of rows) {
  const u8 = new Uint8Array(row.actor_data.buffer, row.actor_data.byteOffset, row.actor_data.byteLength);

  // Decode
  const d0 = performance.now();
  let decoded;
  try { decoded = codecs.decode(u8); } catch { continue; }
  decodeMs += performance.now() - d0;
  n++;

  // Minimal manifest ─ current approach
  const manifest = buildManifest(decoded);
  const m0 = performance.now();
  structuredClone(manifest);
  mCloneMs   += performance.now() - m0;
  mJsonBytes += JSON.stringify(manifest).length;

  // Full decoded object ─ hypothetical
  const f0 = performance.now();
  try { structuredClone(decoded); }
  catch { fCloneErrors++; }
  fCloneMs += performance.now() - f0;
  try { fJsonBytes += JSON.stringify(decoded, replacer).length; } catch { /* non-serialisable */ }
}

// ── Report ────────────────────────────────────────────────────────────────────

const mb   = b  => (b / 1024 / 1024).toFixed(1) + ' MB';
const kbr  = b  => (b / n / 1024).toFixed(1) + ' kB/row avg';
const t    = ms => ms.toFixed(0) + ' ms';
const pct  = (a, b) => (a / b * 100).toFixed(1) + '% of decode';

console.log('=== Decode (serial, main thread) ===');
console.log(`  Rows decoded:    ${n}`);
console.log(`  Total time:      ${t(decodeMs)}  (${(decodeMs / n).toFixed(2)} ms/row)`);

console.log('\n=== Minimal manifest — current approach ===');
console.log(`  JSON size:       ${mb(mJsonBytes)}  (${kbr(mJsonBytes)})`);
console.log(`  structuredClone: ${t(mCloneMs)}  (${pct(mCloneMs, decodeMs)})`);

console.log('\n=== Full decoded object — hypothetical ===');
if (fCloneErrors > 0)
  console.log(`  Clone errors:    ${fCloneErrors}/${n} rows threw (non-cloneable instances present)`);
console.log(`  JSON size:       ${mb(fJsonBytes)}  (${kbr(fJsonBytes)})`);
console.log(`  structuredClone: ${t(fCloneMs)}  (${pct(fCloneMs, decodeMs)})`);

const sizeX  = fJsonBytes  / Math.max(1, mJsonBytes);
const cloneX = fCloneMs    / Math.max(0.001, mCloneMs);

console.log('\n=== Summary ===');
console.log(`  Full object is  ${sizeX.toFixed(1)}× larger to transfer`);
console.log(`  Full object is  ${cloneX.toFixed(1)}× more expensive to clone`);
console.log(`  Clone overhead vs decode:`);
console.log(`    Manifest path:      ${t(mCloneMs)}  (${pct(mCloneMs, decodeMs)})`);
console.log(`    Full-object path:   ${t(fCloneMs)}  (${pct(fCloneMs, decodeMs)})`);
console.log(`    Extra cost:         ${t(fCloneMs - mCloneMs)}`);
console.log(`  At 4 workers the extra clone cost is split across workers;`);
console.log(`  estimated wall-clock penalty: ~${t((fCloneMs - mCloneMs) / 4)}`);
