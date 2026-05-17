/**
 * Test: load world.db and decode every actor_data blob through the codec pipeline.
 * Reports per-row errors and a final summary.
 *
 * Usage:
 *   npm run test                  (looks for world.db in the project root)
 *   node test.mjs /path/to/world.db
 *   node test.mjs --parallel      (also run the worker-pool path and compare)
 *   node test.mjs --parallel=8    (override pool size; default = cpu count − 1)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { codecs } from './js/codecs.mjs';
import { DecodePool } from './lib/workers/pool.mjs';
import { Lz4Service } from './lib/lz4-wasm/lz4-service.mjs';
import { bindLz4 } from './lib/unreal/blob.mjs';

// blob.mjs no longer auto-boots an lz4 backend on import — bind one for
// the main-thread serial pass below. (The DecodePool's workers each boot
// their own lz4 instance inside decode-worker.mjs.)
const _lz4 = new Lz4Service();
await _lz4.init();
bindLz4(_lz4);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const parallelArg = argv.find(a => a === '--parallel' || a.startsWith('--parallel='));
const parallelEnabled = !!parallelArg;
const poolSize = (() => {
  if (!parallelArg) return 0;
  if (parallelArg === '--parallel') return Math.max(1, (os.cpus()?.length ?? 4) - 1);
  return Math.max(1, parseInt(parallelArg.slice('--parallel='.length), 10) || 1);
})();
const positional = argv.filter(a => !a.startsWith('--'));

// ── Database path ────────────────────────────────────────────────────────────
const dbPath = positional[0] || path.join(__dirname, 'world.db');

if (!fs.existsSync(dbPath)) {
  console.error(`ERROR: database file not found: ${dbPath}`);
  console.error('Pass the path as an argument: node test.mjs /path/to/world.db');
  process.exit(1);
}

// ── Open database ────────────────────────────────────────────────────────────
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  console.error('ERROR: could not open database:', e.message);
  console.error('Make sure better-sqlite3 is installed: npm install');
  process.exit(1);
}

// ── Walk a decoded property tree looking for embedded struct decode errors ───
function collectStructErrors(properties, prefix, out) {
  if (!Array.isArray(properties)) return;
  for (const entry of properties) {
    const propPath = prefix ? `${prefix}.${entry.tag?.name ?? '?'}` : (entry.tag?.name ?? '?');
    if (entry._structDecodeError) {
      out.push(`${propPath}: struct error: ${entry._structDecodeError}`);
    }
    if (entry.value?._structDecodeError) {
      out.push(`${propPath}.value: struct error: ${entry.value._structDecodeError}`);
    }
    // Recurse into nested structures
    const v = entry.value;
    if (v?.value && Array.isArray(v.value)) {
      collectStructErrors(v.value.map(x => ({ tag: {}, value: x })), propPath, out);
    }
    if (v?.embedded) {
      collectStructErrors(v.embedded.map(x => ({ tag: {}, value: x })), propPath + '.embedded', out);
    }
    if (Array.isArray(v)) {
      collectStructErrors(v.map(x => ({ tag: {}, value: x })), propPath, out);
    }
    if (entry.value && Array.isArray(entry.value)) {
      collectStructErrors(entry.value, propPath, out);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
let rows;
try {
  rows = db.prepare(
    'SELECT actor_serial, actor_name, actor_script, length(actor_data) AS blob_len, actor_data FROM actor_table'
  ).all();
} catch (e) {
  console.error('ERROR: could not query actor_table:', e.message);
  process.exit(1);
}

console.log(`Database: ${dbPath}`);
console.log(`Rows: ${rows.length}`);
console.log('');

const stats = { total: 0, empty: 0, ok: 0, unterminated: 0, trailing: 0, error: 0, structError: 0 };
const errors = [];
// Per-row outcome captured during the serial pass so the parallel pass
// can compare manifests against ground truth.
const serialOutcomes = new Map();   // serial → { kind, decodeOk }

const startMs = Date.now();

for (const row of rows) {
  stats.total++;

  if (!row.actor_data || row.blob_len === 0) {
    stats.empty++;
    serialOutcomes.set(row.actor_serial, { kind: 'empty', decodeOk: true });
    continue;
  }

  // better-sqlite3 returns blobs as Buffer; wrap as Uint8Array for the codec
  const u8 = new Uint8Array(row.actor_data.buffer, row.actor_data.byteOffset, row.actor_data.byteLength);

  let decoded;
  try {
    decoded = codecs.decode(u8);
  } catch (e) {
    stats.error++;
    serialOutcomes.set(row.actor_serial, { kind: 'error', decodeOk: false });
    errors.push({ serial: row.actor_serial, name: row.actor_name, kind: 'throw', msg: e.message });
    continue;
  }

  if (decoded.error) {
    stats.error++;
    serialOutcomes.set(row.actor_serial, { kind: decoded.kind, decodeOk: false });
    errors.push({ serial: row.actor_serial, name: row.actor_name, kind: decoded.kind, msg: decoded.error });
    continue;
  }
  serialOutcomes.set(row.actor_serial, { kind: decoded.kind, decodeOk: true });

  if (decoded.kind === 'unreal-properties') {
    if (!decoded.terminated) {
      stats.unterminated++;
      errors.push({ serial: row.actor_serial, name: row.actor_name, kind: 'unreal-properties', msg: 'property stream not terminated by None' });
    } else if (decoded.bodyTrailing && decoded.bodyTrailing.length > 0) {
      stats.trailing++;
      errors.push({ serial: row.actor_serial, name: row.actor_name, kind: 'unreal-properties', msg: `${decoded.bodyTrailing.length} trailing bytes after properties` });
    } else {
      const structErrs = [];
      collectStructErrors(decoded.properties, '', structErrs);
      if (structErrs.length > 0) {
        stats.structError++;
        errors.push({ serial: row.actor_serial, name: row.actor_name, kind: 'unreal-properties', msg: `struct errors: ${structErrs.join('; ')}` });
      } else {
        stats.ok++;
      }
    }
  } else if (decoded.kind === 'json-wrapped') {
    if (decoded.parseError) {
      stats.error++;
      errors.push({ serial: row.actor_serial, name: row.actor_name, kind: 'json-wrapped', msg: `JSON parse error: ${decoded.parseError}` });
    } else {
      stats.ok++;
    }
  } else {
    // 'unknown' or 'empty'
    stats.ok++;
  }
}

const elapsedMs = Date.now() - startMs;

// ── Report ───────────────────────────────────────────────────────────────────
const problemCount = errors.length;

if (problemCount > 0) {
  // Group by message (after stripping serial-specific suffixes).
  const groups = new Map();
  for (const e of errors) {
    const key = e.msg.replace(/\b\d{6,}\b/g, '<id>');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`=== Problems grouped by message (${problemCount} total) ===`);
  for (const [msg, list] of sortedGroups) {
    console.log(`  [${list.length}x] ${msg}`);
    // Show 1-2 example rows
    for (const e of list.slice(0, 2)) {
      console.log(`         e.g. [${e.serial}] ${e.name || '(unnamed)'}`);
    }
  }
  console.log('');
}

console.log('=== Summary ===');
console.log(`  Total rows:      ${stats.total}`);
console.log(`  Empty blobs:     ${stats.empty}`);
console.log(`  Decoded OK:      ${stats.ok}`);
console.log(`  Decode errors:   ${stats.error}`);
console.log(`  Unterminated:    ${stats.unterminated}`);
console.log(`  Trailing bytes:  ${stats.trailing}`);
console.log(`  Struct errors:   ${stats.structError}`);
console.log(`  Wall clock:      ${elapsedMs} ms (${(elapsedMs / Math.max(1, stats.total - stats.empty)).toFixed(2)} ms/row)`);

// ── Optional: parallel decode via worker pool ────────────────────────────────
let parallelExitCode = 0;
if (parallelEnabled) {
  console.log('');
  console.log(`=== Parallel decode (${poolSize} workers) ===`);

  // Build pool inputs. Copy each blob into its OWN ArrayBuffer so transfer
  // detaches a per-row buffer rather than the shared sqlite Buffer pool.
  // Empty rows are skipped — they produce a trivial 'empty' manifest the
  // serial loop already covers, and there's no point round-tripping them
  // through a worker.
  const items = [];
  for (const row of rows) {
    if (!row.actor_data || row.blob_len === 0) continue;
    const ab = new ArrayBuffer(row.actor_data.byteLength);
    new Uint8Array(ab).set(row.actor_data);
    items.push({ serial: row.actor_serial, buffer: ab });
  }

  const pool = new DecodePool({ size: poolSize });
  let parallelMs;
  let manifests;
  try {
    const t0 = Date.now();
    manifests = await pool.decodeAll(items);
    parallelMs = Date.now() - t0;
  } finally {
    await pool.terminate();
  }

  // Compare each manifest against the serial outcome for the same serial.
  let mismatches = 0;
  for (const m of manifests) {
    const s = serialOutcomes.get(m.serial);
    if (!s) { mismatches++; continue; }
    // The 'error' kind path in the worker maps to whatever decoded.kind was
    // in the serial path when codecs.decode threw. Treat both as failures
    // and only compare decodeOk in that case.
    if (m.manifest.decodeOk !== s.decodeOk) mismatches++;
    else if (m.manifest.decodeOk && m.manifest.kind !== s.kind) mismatches++;
  }

  // Haystack-index sanity: every successfully-decoded non-empty blob
  // should produce a non-empty `text` field. Report aggregate stats and
  // a single sample so the output makes it obvious whether the index is
  // meaningful or trivially empty.
  let totalChars = 0, maxChars = 0, rowsWithEmptyText = 0;
  let sampleRow = null;
  for (const m of manifests) {
    const len = m.manifest.text?.length ?? 0;
    totalChars += len;
    if (len > maxChars) maxChars = len;
    if (m.manifest.decodeOk && len === 0) rowsWithEmptyText++;
    if (!sampleRow && m.manifest.decodeOk && len >= 80) sampleRow = m;
  }

  console.log(`  Items decoded:   ${manifests.length}`);
  console.log(`  Mismatches:      ${mismatches}`);
  console.log(`  Haystack chars:  ${totalChars.toLocaleString()} ` +
              `(avg ${(totalChars / Math.max(1, manifests.length)).toFixed(0)}/row, max ${maxChars})`);
  console.log(`  Rows w/ '' text: ${rowsWithEmptyText} (decoded OK but empty haystack)`);
  console.log(`  Wall clock:      ${parallelMs} ms (${(parallelMs / Math.max(1, manifests.length)).toFixed(2)} ms/row)`);
  console.log(`  Speedup vs ser.: ${(elapsedMs / Math.max(1, parallelMs)).toFixed(2)}x`);

  if (sampleRow) {
    const txt = sampleRow.manifest.text;
    const snippet = txt.length > 220 ? txt.slice(0, 217) + '...' : txt;
    console.log(`  Sample row ${sampleRow.serial} haystack (${txt.length} chars, newline-joined):`);
    for (const line of snippet.split('\n').slice(0, 6)) console.log(`    ${line}`);
  }

  if (mismatches > 0) parallelExitCode = 1;
}

process.exit(problemCount > 0 || parallelExitCode > 0 ? 1 : 0);
