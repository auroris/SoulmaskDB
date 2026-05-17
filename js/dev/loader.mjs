/**
 * dev/loader.mjs — browser-side console helper for loading .db files off
 * the dev machine without dragging-and-dropping each time.
 *
 * Loaded only when index.html detects a loopback hostname; never executes
 * in the deployed Cloudflare build (the dynamic import is gated). Pairs
 * with scripts/dev-fileserver.mjs which serves the actual bytes.
 *
 * Console API (exposed as SMDB.dev):
 *
 *   await SMDB.dev.load('C:\\path\\to\\world.db')
 *     → fetches the file from the loopback dev server, adds it to
 *       DataService, validates it, and switches the active DB to it.
 *       Resolves with the DataService entry; throws on any failure.
 *
 *   SMDB.dev.endpoint
 *     → the URL the helper hits (override before calling load() to point
 *       at a different port, e.g. SMDB.dev.endpoint = 'http://127.0.0.1:9999/load').
 */

const DEFAULT_PORT = 7777;
const state = {
  endpoint: `http://127.0.0.1:${DEFAULT_PORT}/load`,
};

async function load(path) {
  if (!path || typeof path !== 'string') {
    throw new Error('SMDB.dev.load(path): path must be a non-empty string');
  }
  const data = window.SMDB && window.SMDB.data;
  if (!data) {
    throw new Error('SMDB.dev.load: SMDB.data not ready yet — page still booting?');
  }

  const url = `${state.endpoint}?path=${encodeURIComponent(path)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(
      `SMDB.dev.load: fetch failed (${e.message}). Is the dev fileserver running? ` +
      `Start it with: npm run start-dev`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SMDB.dev.load: ${res.status} ${res.statusText} — ${body.trim()}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const name  = path.split(/[\\/]/).pop() || 'dev-loaded.db';
  const file  = new File([bytes], name, { type: 'application/x-sqlite3' });

  const entry = await data.addFile(file);
  if (entry.status === 'invalid') {
    throw new Error(`SMDB.dev.load: file invalid — ${entry.error}`);
  }
  await data.switchTo(entry.id);
  console.log(
    `[SMDB.dev] loaded ${name} (${entry.kind}, ${entry.metadata.rowCount ?? '?'} rows, ${bytes.length} bytes)`,
  );
  return entry;
}

const root = (typeof window !== 'undefined') ? window : globalThis;
root.SMDB = root.SMDB || {};
root.SMDB.dev = {
  load,
  get endpoint()  { return state.endpoint; },
  set endpoint(v) { state.endpoint = v; },
};

console.log(
  '%c[SMDB.dev] ready',
  'color:#569cd6',
  '— use SMDB.dev.load("/abs/path/to/file.db") to load a .db off disk',
);
