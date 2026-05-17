/**
 * dev-fileserver.mjs — tiny loopback HTTP server that streams .db files
 * off the dev machine into the browser running `wrangler dev`.
 *
 * Started by `npm run start-dev` alongside wrangler. Never deployed, never
 * imported by the page bundle. The single endpoint is:
 *
 *   GET /load?path=<absolute-or-cwd-relative path to a .db file>
 *
 * Defenses (in order):
 *   1. Binds to 127.0.0.1 only — never reachable from another machine.
 *      The user explicitly chose loopback as the trust boundary, so
 *      there is no path allowlist beyond the extension check.
 *   2. Rejects anything whose extension isn't `.db` (case-insensitive).
 *      Prevents an accidental fetch from slurping a .env / .key / etc.
 *   3. Permissive CORS so the wrangler-served page (different origin
 *      and port) can fetch us.
 *
 * Pair with js/dev/loader.mjs in the browser:
 *
 *   SMDB.dev.load('C:\\path\\to\\world.db')
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.SMDB_DEV_PORT) || 7777;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname !== '/load') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found — try GET /load?path=<absolute path to a .db file>\n');
    return;
  }

  const rawPath = url.searchParams.get('path');
  if (!rawPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing ?path= query parameter\n');
    return;
  }

  if (extname(rawPath).toLowerCase() !== '.db') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('only .db files are served\n');
    return;
  }

  const absPath = resolve(rawPath);
  try {
    const bytes = await readFile(absPath);
    res.writeHead(200, {
      'Content-Type':   'application/x-sqlite3',
      'Content-Length': bytes.length,
      'X-Source-Path':  absPath,
    });
    res.end(bytes);
    console.log(`[dev-fileserver] served ${bytes.length} bytes from ${absPath}`);
  } catch (e) {
    const status = e.code === 'ENOENT' ? 404
                 : e.code === 'EACCES' ? 403
                 : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(`${e.code || 'error'}: ${e.message}\n`);
    console.warn(`[dev-fileserver] ${status} for ${absPath}: ${e.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[dev-fileserver] listening on http://${HOST}:${PORT} (loopback only)`);
  console.log(`[dev-fileserver]   GET /load?path=<absolute path to a .db file>`);
});
