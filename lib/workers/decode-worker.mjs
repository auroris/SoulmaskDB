/**
 * Worker entry point — decodes a batch of actor-data blobs and returns
 * a small manifest per row.
 *
 * Runs in both browser (native Worker) and Node (web-worker package's
 * worker_threads polyfill that exposes `self`/`postMessage`/etc.).
 *
 * Message contract — see lib/workers/pool.mjs for the matching dispatch
 * side and a high-level overview.
 *
 * IN:  { type: 'decode-batch',
 *        items: [{ serial, buffer, byteOffset?, byteLength? }] }
 * OUT: { type: 'decode-batch-result',
 *        items: [{ serial, manifest }] }
 *
 * The manifest is intentionally minimal — see extractManifest below. The
 * full property tree stays in the worker (and is GC'd at end of batch);
 * if the main thread needs it, it re-decodes the row on demand. The
 * exception is `text`: a flat lowercased haystack of every string found
 * in the property tree (paths + values, joined). The SearchService keeps
 * one entry per serial and uses it as the substring-match haystack.
 */

import { codecs } from '../../js/codecs.mjs';
import { collectStrings } from '../unreal/strings.mjs';

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'decode-batch') return;
  const items = msg.items.map(decodeOne);
  self.postMessage({ type: 'decode-batch-result', items });
});

// Announce readiness AFTER the message handler is wired. The pool waits
// for this before dispatching the first batch — at least one browser we
// tested drops `worker.postMessage(...)` calls made before the worker
// module finishes evaluating, despite the spec saying they should be
// queued. The cost of this handshake is one postMessage per worker per
// lifetime, vs. silently losing the first batch every time.
self.postMessage({ type: 'worker-ready' });

function decodeOne({ serial, buffer, byteOffset = 0, byteLength = null }) {
  const len = byteLength != null ? byteLength : (buffer.byteLength - byteOffset);
  const u8 = new Uint8Array(buffer, byteOffset, len);
  let decoded;
  try {
    decoded = codecs.decode(u8);
  } catch (e) {
    return { serial, manifest: { kind: 'error', decodeOk: false, error: e.message, references: [], text: '' } };
  }
  return { serial, manifest: extractManifest(decoded) };
}

/**
 * Reduce a fully-decoded blob to the small POJO the main thread actually
 * uses. Designed to keep structured-clone return cost tiny — flat fields
 * + short arrays of primitives, no class instances.
 *
 * `text` is the per-row search haystack: every string the property tree
 * yields (FName values, asset paths, StrProperty contents, plus the
 * property-name paths so a search like "Inventory" matches the property
 * key as well as a value). Already lowercased so the main-thread filter
 * doesn't repeat the work per keystroke.
 */
function extractManifest(decoded) {
  const base = {
    kind: decoded.kind,
    decodeOk: !decoded.error,
    error: decoded.error || null,
    references: [],   // Populated once cross-row reference patterns are known
    text: buildHaystack(collectStrings(decoded)),
  };

  if (decoded.kind === 'unreal-properties') {
    return {
      ...base,
      terminated: !!decoded.terminated,
      bodyTrailingLen: decoded.bodyTrailing ? decoded.bodyTrailing.length : 0,
      topLevelPropertyNames: extractTopLevelNames(decoded.properties),
    };
  }
  if (decoded.kind === 'json-wrapped') {
    return { ...base, parseError: decoded.parseError || null };
  }
  return base;   // 'empty', 'unknown', or anything else
}

function extractTopLevelNames(properties) {
  if (!Array.isArray(properties)) return [];
  const out = [];
  for (const p of properties) {
    const n = p?.tag?.name?.value;
    if (typeof n === 'string') out.push(n);
  }
  return out;
}

/**
 * Flatten the {path,value} pairs from collectStrings into a single
 * lowercased newline-joined haystack. Path and value go in side-by-side
 * so a query matches whether the user types a property name or a string
 * the game stored. Newline separator is arbitrary — `String.includes`
 * doesn't care, and `\n` is unlikely to appear inside extracted values.
 */
function buildHaystack(strings) {
  if (!strings || strings.length === 0) return '';
  const parts = [];
  for (const s of strings) {
    if (s.path) parts.push(s.path);
    if (s.value) parts.push(s.value);
  }
  return parts.join('\n').toLowerCase();
}
