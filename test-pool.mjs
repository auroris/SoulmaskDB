/**
 * Worker pool tests — mechanics, data integrity across configurations,
 * and an optional performance sweep.
 *
 * Integrity tests run every non-empty blob through several pool
 * configurations and verify each manifest is bit-identical to a reference
 * run. This catches ordering bugs, transfer corruption, and batchSize
 * edge-cases without requiring knowledge of the decoded data format.
 *
 * Usage:
 *   node test-pool.mjs              # mechanics + integrity (uses world.db)
 *   node test-pool.mjs --sweep      # + performance sweep matrix
 *   node test-pool.mjs /path/to.db  # alternate database
 */

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire }  from 'node:module';

import { DecodePool }  from './lib/workers/pool.mjs';
import { Lz4Service }  from './lib/lz4-wasm/lz4-service.mjs';
import { bindLz4 }     from './lib/unreal/blob.mjs';

const _lz4 = new Lz4Service();
await _lz4.init();
bindLz4(_lz4);

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv       = process.argv.slice(2);
const sweep      = argv.includes('--sweep');
const positional = argv.filter(a => !a.startsWith('--'));
const dbPath     = positional[0] || path.join(__dirname, 'world.db');

if (!fs.existsSync(dbPath)) {
  console.error(`ERROR: database not found: ${dbPath}`);
  process.exit(1);
}

// ── Load DB rows ──────────────────────────────────────────────────────────────

const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true });
const rawRows = db.prepare(
  'SELECT actor_serial, length(actor_data) AS blob_len, actor_data FROM actor_table'
).all();
const nonEmptyRows = rawRows.filter(r => r.blob_len > 0);

const cpus = os.cpus()?.length ?? 4;
console.log(`Database: ${dbPath}`);
console.log(`Rows:     ${rawRows.length} total, ${nonEmptyRows.length} non-empty blobs, ${cpus} CPUs\n`);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build a fresh ArrayBuffer per row. Needed before every pool run because
// decodeAll() transfers (detaches) each buffer — they can't be reused.
function buildItems(rows) {
  const items = [];
  for (const row of rows) {
    if (!row.blob_len) continue;
    const ab = new ArrayBuffer(row.actor_data.byteLength);
    new Uint8Array(ab).set(row.actor_data);
    items.push({ serial: row.actor_serial, buffer: ab });
  }
  return items;
}

// Run one pool configuration and return results + wall-clock time.
// Starts the timer at decodeAll() so worker startup (first ready-wait)
// is included — that cost is real and paid once per pool lifetime.
async function runPool(items, { size, batchSize }) {
  const pool = new DecodePool({ size, batchSize });
  const t0   = Date.now();
  const results = await pool.decodeAll(items);
  const ms = Date.now() - t0;
  await pool.terminate();
  return { results, ms };
}

// Stable manifest fingerprint for cross-config comparison. Sorts
// references so ordering differences across runs don't produce false
// mismatches; concatenates into a single string for O(1) equality check.
function fingerprint(manifest) {
  if (!manifest) return '\x00null';
  const refs = [...(manifest.references ?? [])]
    .sort((a, b) => ((a.guid + a.path) < (b.guid + b.path) ? -1 : 1))
    .map(r => `${r.guid}:${r.path}`)
    .join('|');
  return `${manifest.kind}|${manifest.decodeOk}|${manifest.text ?? ''}|${refs}`;
}

// ── Pass/fail tracking ────────────────────────────────────────────────────────

let passed = 0, failed = 0, exitCode = 0;

function ok(label)   { console.log(`  OK   ${label}`); passed++; }
function fail(label, detail = '') {
  console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  failed++;
  exitCode = 1;
}

// ── Section 1: Pool mechanics ─────────────────────────────────────────────────
// These tests verify pool behaviour independent of decode correctness.

console.log('=== Pool mechanics ===');

// Empty input must return [] without hanging.
{
  const pool = new DecodePool({ size: 2, batchSize: 10 });
  const result = await pool.decodeAll([]);
  await pool.terminate();
  Array.isArray(result) && result.length === 0
    ? ok('empty input → []')
    : fail('empty input → []', `got ${JSON.stringify(result)}`);
}

// Single-item round-trip: serial preserved, manifest present.
{
  const row = nonEmptyRows[0];
  const ab  = new ArrayBuffer(row.actor_data.byteLength);
  new Uint8Array(ab).set(row.actor_data);
  const pool = new DecodePool({ size: 1, batchSize: 1 });
  const [res] = await pool.decodeAll([{ serial: row.actor_serial, buffer: ab }]);
  await pool.terminate();
  res?.serial === row.actor_serial && res?.manifest
    ? ok('single item — serial preserved, manifest present')
    : fail('single item', JSON.stringify(res));
}

// Source buffers must be detached (byteLength === 0) after transfer.
{
  const row = nonEmptyRows[0];
  const ab  = new ArrayBuffer(row.actor_data.byteLength);
  new Uint8Array(ab).set(row.actor_data);
  const pool = new DecodePool({ size: 1, batchSize: 1 });
  await pool.decodeAll([{ serial: row.actor_serial, buffer: ab }]);
  await pool.terminate();
  ab.byteLength === 0
    ? ok('source buffer is detached after transfer')
    : fail('source buffer detachment', `byteLength = ${ab.byteLength}`);
}

// onBatchComplete must be called once per batch, covering every item
// exactly once (no duplicates, no gaps).
{
  const sample  = buildItems(rawRows.slice(0, 60));
  const seen    = new Set();
  let totalSeen = 0;
  const pool = new DecodePool({ size: 2, batchSize: 10 });
  await pool.decodeAll(sample, {
    onBatchComplete: (batch) => { for (const it of batch) { seen.add(it.serial); totalSeen++; } },
  });
  await pool.terminate();
  totalSeen === sample.length && seen.size === sample.length
    ? ok(`onBatchComplete: all ${sample.length} items reported, no duplicates`)
    : fail('onBatchComplete', `totalSeen=${totalSeen} uniqueSerials=${seen.size} expected=${sample.length}`);
}

// Output array must be in the same order as the input array, even when
// workers finish batches out of order.
{
  const sample   = buildItems(rawRows.slice(0, 80));
  const inOrder  = sample.map(it => it.serial);   // capture before transfer detaches
  const pool     = new DecodePool({ size: 4, batchSize: 7 });   // 7 doesn't divide 80
  const results  = await pool.decodeAll(sample);
  await pool.terminate();
  const outOrder = results.map(r => r.serial);
  const orderOk  = outOrder.every((s, i) => s === inOrder[i]);
  const firstBad = orderOk ? -1 : outOrder.findIndex((s, i) => s !== inOrder[i]);
  orderOk
    ? ok('output order matches input order (4 workers, batchSize=7)')
    : fail('output order', `first mismatch at index ${firstBad}: got ${outOrder[firstBad]} want ${inOrder[firstBad]}`);
}

// ── Section 2: Integrity across configurations ────────────────────────────────
// Run all rows through a reference configuration, then verify every other
// configuration produces bit-identical manifests.

console.log('\n=== Integrity (all rows, vs reference batchSize=200 workers=4) ===');

const REF = { size: Math.min(4, cpus), batchSize: 200 };
const { results: refResults, ms: refMs } = await runPool(buildItems(nonEmptyRows), REF);
const refMap = new Map(refResults.map(r => [r.serial, fingerprint(r.manifest)]));
console.log(`  Reference:   workers=${REF.size} batchSize=${REF.batchSize}  →  ${refMs} ms\n`);

async function integrityCheck(label, cfg) {
  const { results, ms } = await runPool(buildItems(nonEmptyRows), cfg);
  let mismatches = 0;
  const examples = [];
  if (results.length !== refResults.length) {
    fail(label, `result count ${results.length} ≠ reference ${refResults.length}`);
    return;
  }
  for (const { serial, manifest } of results) {
    const ref = refMap.get(serial);
    if (ref === undefined) { mismatches++; continue; }
    if (fingerprint(manifest) !== ref) {
      mismatches++;
      if (examples.length < 2) examples.push(serial);
    }
  }
  const timing = `${ms} ms`;
  mismatches === 0
    ? ok(`${label}  (${timing})`)
    : fail(`${label}  (${timing})`, `${mismatches} mismatches${examples.length ? `, e.g. serials ${examples.join(', ')}` : ''}`);
}

// Vary batchSize at fixed worker count.
await integrityCheck('batchSize=1    workers=4', { size: Math.min(4, cpus), batchSize: 1    });
await integrityCheck('batchSize=50   workers=4', { size: Math.min(4, cpus), batchSize: 50   });
await integrityCheck('batchSize=500  workers=4', { size: Math.min(4, cpus), batchSize: 500  });
await integrityCheck('batchSize=9999 workers=4', { size: Math.min(4, cpus), batchSize: 9999 });

// Vary worker count at fixed batchSize.
await integrityCheck('batchSize=200  workers=1', { size: 1,           batchSize: 200 });
await integrityCheck('batchSize=200  workers=2', { size: 2,           batchSize: 200 });
await integrityCheck(`batchSize=200  workers=${cpus}`, { size: cpus,  batchSize: 200 });

// ── Section 3: Performance sweep ─────────────────────────────────────────────
// Optional (--sweep). Runs all rows through every combination in the matrix
// and prints a formatted table. Worker startup is included in the timing —
// it's a one-time cost per pool lifetime and is relevant to the real
// browser load experience.

if (sweep) {
  console.log('\n=== Performance sweep (all rows) ===');
  console.log('  Includes worker startup on first decodeAll per pool.\n');

  const BATCH_SIZES    = [25, 50, 100, 200, 500, 1000];
  const WORKER_COUNTS  = [...new Set([1, 2, 4, 8, Math.max(1, cpus - 1), cpus])]
    .sort((a, b) => a - b);

  // Build header row.
  const C = 8;   // column width
  const pad   = (s, w = C) => String(s).padStart(w);
  const lpad  = (s, w)     => String(s).padEnd(w);
  const bsLabels = BATCH_SIZES.map(b => pad('bs=' + b));
  console.log('  ' + lpad('workers', 9) + bsLabels.join('  '));
  console.log('  ' + '-'.repeat(9 + bsLabels.length * (C + 2)));

  for (const workers of WORKER_COUNTS) {
    const cells = [];
    for (const batchSize of BATCH_SIZES) {
      const { ms } = await runPool(buildItems(nonEmptyRows), { size: workers, batchSize });
      cells.push(pad(ms + 'ms'));
    }
    console.log('  ' + lpad(workers, 9) + cells.join('  '));
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(exitCode);
