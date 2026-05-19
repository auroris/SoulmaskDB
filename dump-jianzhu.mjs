// Dump every JianZhuInstYuanXings array on every BP_JianZhuPianQu row.
// Usage:
//   node dump-jianzhu.mjs <path-to-world.db>                  → summaries only
//   node dump-jianzhu.mjs <path-to-world.db> <serial>         → full hex for that serial
//   node dump-jianzhu.mjs <path-to-world.db> --near X Y       → summaries near coords
//
// The first form lists every BP_JianZhuPianQu row with: serial, location,
// numElements, total array size, whether the array decoded structurally or
// fell back to OpaqueValue, and (if structural) the count of trailing-binary
// sections. Use this to find the row you care about, then re-run with that
// serial to get the full hex.

import Database from 'better-sqlite3';
import { UnrealBlob, bindLz4 } from './lib/unreal/blob.mjs';
import { Lz4Service } from './lib/lz4-wasm/lz4-service.mjs';

const args = process.argv.slice(2);
const dbPath = args[0];
if (!dbPath) {
  console.error('Usage: node dump-jianzhu.mjs <path-to-world.db> [<serial> | --near X Y]');
  process.exit(1);
}

let filterSerial = null;
let nearXY = null;
if (args[1] === '--near') {
  nearXY = { x: parseFloat(args[2]), y: parseFloat(args[3]) };
} else if (args[1]) {
  filterSerial = parseInt(args[1], 10);
}

const svc = new Lz4Service();
await svc.init();
bindLz4(svc);

const db = new Database(dbPath, { readonly: true });

function visit(props, fn) {
  for (const p of props) {
    if (!p.tag) continue;
    fn(p);
    const v = p.value;
    if (v?.embedded && Array.isArray(v.embedded)) visit(v.embedded, fn);
    if (v?.properties && Array.isArray(v.properties)) visit(v.properties, fn);
  }
}

// actor_transf is a TEXT column with format "x,y,z|pitch,yaw,roll|sx,sy,sz".
function readLocation(text) {
  if (typeof text !== 'string') return null;
  const head = text.split('|')[0];
  const parts = head.split(',').map(parseFloat);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

const rows = db.prepare('SELECT actor_serial, actor_name, actor_transf, actor_data FROM actor_table').all();

const matches = [];

for (const row of rows) {
  if (!row.actor_name || !row.actor_name.includes('JianZhuPianQu')) continue;
  if (filterSerial != null && row.actor_serial !== filterSerial) continue;

  let blob;
  try { blob = UnrealBlob.decode(row.actor_data); } catch (e) {
    matches.push({ row, error: e.message });
    continue;
  }

  const loc = readLocation(row.actor_transf);

  visit(blob.properties, (p) => {
    if (p.tag.name?.value !== 'JianZhuInstYuanXings') return;
    const v = p.value;
    const isOpaque = !!v?._opaque;
    let summary;
    if (isOpaque) {
      const b = v._opaque;
      const ne = new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(0, true);
      summary = { kind: 'opaque', size: b.length, numElements: ne, bytes: b };
    } else {
      const elements = v?.elements ?? [];
      const trailing = v?._trailing;
      summary = {
        kind: 'structural',
        elementsLen: elements.length,
        elements,
        trailing: trailing ? {
          header: trailing.header,
          sections: trailing.sections?.map(s => ({ stride: s.stride, count: s.count, dataBytes: s.data?.length ?? 0 })) ?? [],
          raw: trailing._raw ? `_raw ${trailing._raw.length}B (${trailing._parseError ?? 'parse error'})` : null,
        } : null,
        perElementTrailings: v?._perElementTrailings ?? null,
      };
    }
    matches.push({ row, loc, prop: p, summary });
  });
}

// If we have --near, sort by distance and only show closest 10.
if (nearXY) {
  for (const m of matches) {
    if (m.loc) m._dist = Math.hypot(m.loc.x - nearXY.x, m.loc.y - nearXY.y);
    else m._dist = Infinity;
  }
  matches.sort((a, b) => a._dist - b._dist);
}

console.log(`# total: ${matches.length} BP_JianZhuPianQu rows in ${rows.length} actors`);
if (nearXY) console.log(`# sorted by distance from (${nearXY.x}, ${nearXY.y}); showing closest 10`);
console.log('');

const limit = nearXY ? 10 : matches.length;
for (let i = 0; i < Math.min(matches.length, limit); i++) {
  const m = matches[i];
  if (m.error) {
    console.log(`serial=${m.row.actor_serial} DECODE FAILED: ${m.error}`);
    continue;
  }
  const locStr = m.loc ? `loc=(${m.loc.x.toFixed(1)}, ${m.loc.y.toFixed(1)}, ${m.loc.z.toFixed(1)})` : 'loc=?';
  const distStr = m._dist != null && isFinite(m._dist) ? `  dist=${m._dist.toFixed(1)}` : '';
  const s = m.summary;
  if (s.kind === 'opaque') {
    console.log(`serial=${m.row.actor_serial}  ${locStr}${distStr}  OPAQUE size=${s.size} numElements=${s.numElements}`);
  } else {
    const t = s.trailing;
    const tStr = t == null ? '(no trailing)' : t.raw ? t.raw : `tailTrailing[${t.sections.length}]: ${t.sections.map(x => `(stride=${x.stride},count=${x.count},${x.dataBytes}B)`).join(' ')}`;
    const perEl = s.perElementTrailings;
    const perElStr = perEl ? `  perElementTrailings=${perEl.filter(x => x).length}/${perEl.length}` : '';
    console.log(`serial=${m.row.actor_serial}  ${locStr}${distStr}  STRUCTURAL elements=${s.elementsLen}  ${tStr}${perElStr}`);
    for (let ei = 0; ei < s.elements.length; ei++) {
      const el = s.elements[ei];
      const kind = el?._objectKind ?? '?';
      const path = el?.path ?? null;
      const cp = el?.classPath ?? null;
      const emb = el?.embedded ? `embedded[${el.embedded.length}]` : '';
      const tr = el?.hasTerminatorTrailer ? 'TRAILER' : '';
      let pathPretty = path == null ? '(null)' : path.length > 80 ? path.slice(0, 77) + '...' : path;
      let pet = '';
      if (perEl && perEl[ei]) {
        const e = perEl[ei];
        pet = ` perElTrailing(${e.sections.map(x => `s${x.stride}c${x.count}`).join(',')})`;
      }
      console.log(`    elem[${ei}]: kind=${kind} path=${JSON.stringify(pathPretty)} classPath=${JSON.stringify(cp)} ${emb} ${tr}${pet}`);
    }
  }
}

// If a single serial was requested, dump its raw bytes if opaque, OR the
// element list + trailing JSON if structural.
if (filterSerial != null && matches.length > 0) {
  const m = matches[0];
  console.log('\n--- FULL DUMP for serial=' + filterSerial + ' ---');
  if (m.summary?.kind === 'opaque') {
    const hex = Array.from(m.summary.bytes).map(b => b.toString(16).padStart(2, '0'));
    for (let i = 0; i < hex.length; i += 32) {
      const offset = i.toString().padStart(6, ' ');
      console.log(`${offset}: ${hex.slice(i, i + 32).join(' ')}`);
    }
  } else if (m.summary?.kind === 'structural') {
    console.log(JSON.stringify({
      elements: m.summary.elements.map(el => ({
        kind: el?._objectKind,
        kindOnePrefix: el?._kindOnePrefix,
        path: el?.path,
        classPath: el?.classPath,
        embedded: el?.embedded?.map(p => ({
          name: p.tag?.name?.value,
          type: p.tag?.type?.value,
          size: p.tag?.size,
        })),
        terminated: el?.terminated,
        hasTerminatorTrailer: el?.hasTerminatorTrailer,
      })),
      trailing: m.summary.trailing,
    }, null, 2));
  }
}
