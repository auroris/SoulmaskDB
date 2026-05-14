'use strict';
/**
 * Test: load world.db and decode every actor_data blob through the codec pipeline.
 * Reports per-row errors and a final summary.
 *
 * Usage:
 *   npm run test                  (looks for world.db in the project root)
 *   node test.js /path/to/world.db
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── Browser global shim (codec files write to window.SMDB) ──────────────────
global.window = global;
// vm.runInThisContext doesn't inherit module-local `require`; expose it explicitly.
global.require = require;

// Load codec files into this context in dependency order.
for (const rel of ['js/codec-json.js', 'js/codec-unreal-properties.js', 'js/codecs.js']) {
  const code = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  vm.runInThisContext(code, { filename: rel });
}

// ── Database path ────────────────────────────────────────────────────────────
const dbPath = process.argv[2] || path.join(__dirname, 'world.db');

if (!fs.existsSync(dbPath)) {
  console.error(`ERROR: database file not found: ${dbPath}`);
  console.error('Pass the path as an argument: node test.js /path/to/world.db');
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
function collectStructErrors(properties, path, out) {
  if (!Array.isArray(properties)) return;
  for (const entry of properties) {
    const propPath = path ? `${path}.${entry.tag?.name ?? '?'}` : (entry.tag?.name ?? '?');
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

for (const row of rows) {
  stats.total++;

  if (!row.actor_data || row.blob_len === 0) {
    stats.empty++;
    continue;
  }

  // better-sqlite3 returns blobs as Buffer; wrap as Uint8Array for the codec
  const u8 = new Uint8Array(row.actor_data.buffer, row.actor_data.byteOffset, row.actor_data.byteLength);

  let decoded;
  try {
    decoded = SMDB.codecs.decode(u8);
  } catch (e) {
    stats.error++;
    errors.push({ serial: row.actor_serial, name: row.actor_name, kind: 'throw', msg: e.message });
    continue;
  }

  if (decoded.error) {
    stats.error++;
    errors.push({ serial: row.actor_serial, name: row.actor_name, kind: decoded.kind, msg: decoded.error });
    continue;
  }

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

process.exit(problemCount > 0 ? 1 : 0);
