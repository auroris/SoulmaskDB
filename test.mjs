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

  // Haystack-index + references sanity: every successfully-decoded
  // non-empty blob should produce a non-empty `text` field. The new
  // `references` field carries Guid struct values + their property
  // paths so a ReferencesService can build a reverse index without
  // re-decoding blobs.
  let totalChars = 0, maxChars = 0, rowsWithEmptyText = 0;
  let totalRefs = 0, maxRefs = 0, rowsWithRefs = 0;
  let sampleRow = null;
  for (const m of manifests) {
    const len = m.manifest.text?.length ?? 0;
    totalChars += len;
    if (len > maxChars) maxChars = len;
    if (m.manifest.decodeOk && len === 0) rowsWithEmptyText++;
    if (!sampleRow && m.manifest.decodeOk && len >= 80) sampleRow = m;

    const refCount = m.manifest.references?.length ?? 0;
    totalRefs += refCount;
    if (refCount > maxRefs) maxRefs = refCount;
    if (refCount > 0) rowsWithRefs++;
  }

  console.log(`  Items decoded:   ${manifests.length}`);
  console.log(`  Mismatches:      ${mismatches}`);
  console.log(`  Haystack chars:  ${totalChars.toLocaleString()} ` +
              `(avg ${(totalChars / Math.max(1, manifests.length)).toFixed(0)}/row, max ${maxChars})`);
  console.log(`  Rows w/ '' text: ${rowsWithEmptyText} (decoded OK but empty haystack)`);
  console.log(`  GUID refs:       ${totalRefs.toLocaleString()} ` +
              `(avg ${(totalRefs / Math.max(1, manifests.length)).toFixed(1)}/row, max ${maxRefs}, ${rowsWithRefs} rows have any)`);
  console.log(`  Wall clock:      ${parallelMs} ms (${(parallelMs / Math.max(1, manifests.length)).toFixed(2)} ms/row)`);
  console.log(`  Speedup vs ser.: ${(elapsedMs / Math.max(1, parallelMs)).toFixed(2)}x`);

  if (sampleRow) {
    const txt = sampleRow.manifest.text;
    const snippet = txt.length > 220 ? txt.slice(0, 217) + '...' : txt;
    console.log(`  Sample row ${sampleRow.serial} haystack (${txt.length} chars, newline-joined):`);
    for (const line of snippet.split('\n').slice(0, 6)) console.log(`    ${line}`);
  }

  if (mismatches > 0) parallelExitCode = 1;

  // ── ReferencesService end-to-end ───────────────────────────────────
  // Build the same reverse index the browser builds at load time,
  // using the manifests the worker pool just produced. Verifies the
  // service's absorb path + query API against real data and lets the
  // node test surface regressions in either layer.
  console.log('');
  console.log('=== ReferencesService ===');
  const { ReferencesService } = await import('./js/references-service.mjs');
  const { collectGuids }      = await import('./lib/unreal/refs.mjs');

  // Kind lookup — players use ZhuRenGuid as identity, everyone else uses
  // SelfUid. We don't run the full classify.mjs pipeline here (it's main-
  // thread UI code); the actor_script regex is enough to pick out the 5
  // HPlayerState rows so the player-identity path of the service is
  // exercised.
  const kindBySerial = new Map();
  for (const row of rows) {
    if (/HPlayerState/.test(row.actor_script || '')) {
      kindBySerial.set(row.actor_serial, 'player');
    }
  }
  const refsSvc = new ReferencesService({
    codecs, collectGuids,
    kindLookup: (s) => kindBySerial.get(s) || null,
  });

  const tBuild0 = Date.now();
  refsSvc.absorbBatch(manifests);
  const buildMs = Date.now() - tBuild0;
  const refsStats = refsSvc.stats();
  console.log(`  Build time:      ${buildMs} ms`);
  console.log(`  Stats:           ${JSON.stringify(refsStats)}`);

  // Pick a high-fanout GUID from the index and confirm the queries
  // line up with what scripts/find-guid-refs.mjs would print.
  let topGuid = null, topBucket = 0;
  for (const [guid, bucket] of refsSvc._guidIndex) {
    if (bucket.length > topBucket) { topGuid = guid; topBucket = bucket.length; }
  }
  if (topGuid) {
    const referrers = refsSvc.referrersOf(topGuid);
    const target    = refsSvc.rowBySelfUid(topGuid);
    console.log(`  Top GUID:        ${topGuid}`);
    console.log(`    referrers:     ${referrers.length} (${topBucket} total occurrences, SelfUid filtered)`);
    console.log(`    rowBySelfUid:  ${target ?? '(not in loaded set)'}`);
    if (target != null) {
      const outbound = refsSvc.outboundFrom(target);
      const resolved = outbound.filter(o => o.targetSerial != null);
      console.log(`    outboundFrom target row: ${outbound.length} refs, ${resolved.length} resolve to a loaded row`);
    }
  }

  // Sanity: every row that had `kind:'guid'` references in its
  // manifest is reflected in the service. Both maps contribute —
  // rowsWithSelfUid covers SelfUid-only rows; _outboundByRow covers
  // outbound-only rows; their union covers rows with both. The
  // intersection on world.db is small because most NPCs with outbound
  // refs (ZhuRenGuid → owner) also carry a SelfUid, but only a few
  // hundred actually do — most building-style rows are outbound-only.
  const manifestsWithRefs = manifests.filter(m => (m.manifest.references?.length ?? 0) > 0).length;
  const serviceUnion = new Set([
    ...refsSvc._outboundByRow.keys(),
    ...refsSvc._selfUidByRow.keys(),
    // Nested-identity-only rows (e.g. ships whose 561 MapHoldJianZhuList
    // GUIDs are now classified as inline sub-identities) wouldn't appear
    // in the prior two maps. Include them so the coverage check still
    // matches `manifestsWithRefs`.
    ...refsSvc._nestedIdentitiesByRow.keys(),
  ]);
  const coverageMismatch = serviceUnion.size !== manifestsWithRefs;
  console.log(`  Coverage:        ${serviceUnion.size}/${manifestsWithRefs} ${coverageMismatch ? '— MISMATCH' : '(ok)'}`);
  if (coverageMismatch) parallelExitCode = 1;

  // Spot-check against the user-supplied NPC at serial 38139 and
  // Aleena's player row at 18699. Confirms:
  //   - NPC identity at SelfUid (default convention).
  //   - Player identity at ZhuRenGuid (HPlayerState convention).
  //   - The same NPC's referrers chain to Aleena's session.
  //   - Aleena's GUID resolves backwards to row 18699.
  //   - NPCs that reference Aleena via ZhuRenGuid show up as referrers
  //     of her identity guid (but row 18699's own ZhuRenGuid entry is
  //     correctly filtered out — it IS her identity, not a referrer).
  const NPC_SERIAL    = 38139;
  const NPC_SELF      = 'F1C92EF8-3DDA-4BDA-82F2-0E39DF5540D7';
  const PLAYER_SERIAL = 18699;
  const PLAYER_GUID   = 'C843A973-AA2D-4A30-A5CF-D529A4CDB028';
  const NPC_GUILD     = 'AE178FF3-FE45-46C5-BE15-3CD2FA66DF22';
  const hasNpc    = manifests.some(m => m.serial === NPC_SERIAL);
  const hasPlayer = manifests.some(m => m.serial === PLAYER_SERIAL);
  if (hasNpc && hasPlayer) {
    const checks = [];
    // NPC side
    checks.push(['selfUidOf(npc)',     refsSvc.selfUidOf(NPC_SERIAL),      NPC_SELF]);
    checks.push(['rowBySelfUid(npc)',  refsSvc.rowBySelfUid(NPC_SELF),     NPC_SERIAL]);
    const npcOut = new Map(refsSvc.outboundFrom(NPC_SERIAL).map(o => [o.path, o.guid]));
    checks.push(['npc.out.ZhuRenGuid',  npcOut.get('ZhuRenGuid'),  PLAYER_GUID]);
    checks.push(['npc.out.GongHuiGuid', npcOut.get('GongHuiGuid'), NPC_GUILD]);
    // Player side — NEW: identity at ZhuRenGuid (not SelfUid).
    checks.push(['selfUidOf(player)',     refsSvc.selfUidOf(PLAYER_SERIAL), PLAYER_GUID]);
    checks.push(['rowBySelfUid(player)',  refsSvc.rowBySelfUid(PLAYER_GUID), PLAYER_SERIAL]);
    // Player's outbound should include ControlledPawn → NPC_SELF, and
    // should NOT include their own ZhuRenGuid entry (that's identity).
    const playerOut = refsSvc.outboundFrom(PLAYER_SERIAL);
    const hasOwnGuid = playerOut.some(o => o.guid === PLAYER_GUID);
    checks.push(['player.out does not contain own guid', String(hasOwnGuid), 'false']);
    const playerOutByPath = new Map(playerOut.map(o => [o.path, o]));
    const controlledPawn = playerOutByPath.get('ControlledPawn');
    checks.push(['player.out.ControlledPawn.guid',   controlledPawn?.guid,         NPC_SELF]);
    checks.push(['player.out.ControlledPawn.target', controlledPawn?.targetSerial, NPC_SERIAL]);
    // Referrers of player's guid — NPCs/buildings pointing at Aleena
    // via ZhuRenGuid / JianZhuBuilderUid / etc. Row 18699 itself must
    // NOT appear (its ZhuRenGuid IS its identity, filtered).
    const playerReferrers = refsSvc.referrersOf(PLAYER_GUID);
    const playerOwnEntry  = playerReferrers.find(r => r.serial === PLAYER_SERIAL);
    checks.push(['referrersOf(player) excludes own row', String(!!playerOwnEntry), 'false']);
    // Should include NPC 38139 referencing player via ZhuRenGuid.
    const npcRefEntry = playerReferrers.find(r => r.serial === NPC_SERIAL && r.path === 'ZhuRenGuid');
    checks.push(['referrersOf(player) includes NPC ZhuRenGuid', String(!!npcRefEntry), 'true']);
    // Original NPC-referrer check still holds.
    const referrers = refsSvc.referrersOf(NPC_SELF);
    const fromPlayer = referrers.filter(r => r.serial === PLAYER_SERIAL).map(r => r.path).sort();
    checks.push([
      'referrersOf(npc) from player',
      JSON.stringify(fromPlayer),
      JSON.stringify(['ChuShiKeLongData.ManRenUId', 'ControlledPawn']),
    ]);
    let failed = 0;
    for (const [label, got, want] of checks) {
      const ok = got === want;
      console.log(`    ${ok ? 'OK ' : 'FAIL'} ${label}: got ${got}${ok ? '' : ` (want ${want})`}`);
      if (!ok) failed++;
    }
    if (failed > 0) parallelExitCode = 1;
  } else {
    console.log('    (NPC 38139 or player 18699 not in this DB — skipping spot-checks)');
  }
}

process.exit(problemCount > 0 || parallelExitCode > 0 ? 1 : 0);
