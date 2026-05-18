/**
 * UnrealBlob — top-level Soulmask "actor_data" blob.
 *
 * Wire layout:
 *   [0..3]   u32 LE   version tag = 0x00000002  (literal, NOT compressed)
 *   [4..7]   u32 LE   uncompressed size of what follows
 *   [8..]    LZ4 raw block → expands to a property stream:
 *
 *     [0..3]   u32 LE  inner version tag = 0x00000002
 *     [4..]    FPropertyTag stream terminated by FString "None" + int32 0
 *
 * Column sign convention: the SQLite `actor_table.data_version` column
 * stores the NEGATIVE of the wire-format DataVersion. A healthy blob
 * with DataVersion=2 lives in a row whose `data_version` column reads
 * -2. The wire bytes themselves (both the outer header at offset 0 and
 * the inner header after LZ4 decompression) are always the unsigned
 * 0x00000002 — the negation is purely a column-side encoding.
 *
 * Round-trip safety: LZ4 has many valid encodings for the same data so
 * re-compression is NOT byte-identical. UnrealBlob keeps the original
 * bytes around and returns them verbatim on serialize() when nothing has
 * been mutated. Mutation support is a later step — for now `serialize`
 * throws if `_dirty` is set.
 */

import { Cursor } from './io.mjs';
import { readPropertyStream } from './properties.mjs';

const NAME = 'unreal-properties';
const OUTER_HEADER_SIZE = 4;
export const OUTER_VERSION_TAG = 0x00000002;
const INNER_HEADER_SIZE = 4;

// --------------------------------------------------------------------------
// LZ4 raw-block codec (size-prefixed variant: [u32 LE size][block bytes]).
//
// The actual wasm backend lives in lib/lz4-wasm/lz4-service.mjs and is
// bound here via `bindLz4(service)` at boot time — the orchestrator does
// it on the main thread; the decode-worker does it inside each Worker.
// Decoupling means importing blob.mjs has no side effects: no implicit
// `await import('lz4-wasm-nodejs')` at module load, no TLA chain
// poisoning every transitive importer.
//
// `lz4Decompress`/`lz4Compress` throw if no backend is bound — callers
// in environments that haven't booted an Lz4Service (Node tests, an SSR
// build, etc.) need to construct one and call `bindLz4(svc)` first.
// --------------------------------------------------------------------------
let _lz4 = null;

/**
 * Bind the lz4 backend used by lz4Decompress / lz4Compress. `service`
 * must expose `decompress(u8, srcOff?)` and `compress(u8)` — see
 * Lz4Service in lib/lz4-wasm/lz4-service.mjs. Pass null to unbind.
 */
export function bindLz4(service) { _lz4 = service; }

export function lz4Decompress(src, srcOff = 0) {
  if (!_lz4) throw new Error('lz4: no backend bound — call bindLz4(service) first');
  return _lz4.decompress(src, srcOff);
}

export function lz4Compress(decompressed) {
  if (!_lz4) throw new Error('lz4: no backend bound — call bindLz4(service) first');
  return _lz4.compress(decompressed);
}

// --------------------------------------------------------------------------
// UnrealBlob — the object handed back from decode.
// --------------------------------------------------------------------------
export class UnrealBlob {
  constructor({
    outerVersionTag = OUTER_VERSION_TAG,
    innerVersionTag = OUTER_VERSION_TAG,
    decompressedSize = 0,
    properties = [],
    terminated = false,
    bodyTrailing = null,
    error = null,
    raw = null,
    decompressed = null,
  } = {}) {
    this.outerVersionTag = outerVersionTag;
    this.innerVersionTag = innerVersionTag;
    this.decompressedSize = decompressedSize;
    this.properties = properties;
    this.terminated = terminated;
    this.bodyTrailing = bodyTrailing;
    this.error = error;
    this._raw = raw;
    this._decompressed = decompressed;
    this._dirty = false;
  }

  get kind()      { return NAME; }
  get totalSize() { return this._raw ? this._raw.length : 0; }

  /** First top-level property with the given name, or null. */
  findProperty(propName) {
    for (const p of this.properties) {
      if (p.tag && p.tag.name && p.tag.name.value === propName) return p;
    }
    return null;
  }

  static detect(u8) {
    if (!u8 || u8.length < OUTER_HEADER_SIZE + 4) return false;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return dv.getUint32(0, true) === OUTER_VERSION_TAG;
  }

  static decode(u8) {
    if (!UnrealBlob.detect(u8)) {
      const head = u8 ? Array.from(u8.subarray(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ') : '(empty)';
      throw new Error(`UnrealBlob.decode: not an unreal-properties blob (header bytes: ${head})`);
    }

    let decompressed;
    try {
      decompressed = lz4Decompress(u8, OUTER_HEADER_SIZE);
    } catch (e) {
      return new UnrealBlob({ raw: u8, error: 'lz4 decompress failed: ' + e.message });
    }

    let innerVersionTag = null;
    let properties = [];
    let terminated = false;
    let parseError = null;
    let bodyTrailing = null;

    if (decompressed.length >= INNER_HEADER_SIZE) {
      const dv = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
      innerVersionTag = dv.getUint32(0, true);
      const cursor = new Cursor(decompressed, INNER_HEADER_SIZE);
      try {
        const stream = readPropertyStream(cursor, decompressed.length, /*consumeTerminatorTrailer=*/true);
        properties = stream.properties;
        terminated = stream.terminated;
        if (cursor.pos() < decompressed.length) {
          bodyTrailing = decompressed.slice(cursor.pos());
        }
      } catch (e) {
        parseError = e.message;
      }
    }

    return new UnrealBlob({
      outerVersionTag: OUTER_VERSION_TAG,
      innerVersionTag,
      decompressedSize: decompressed.length,
      properties,
      terminated,
      bodyTrailing,
      error: parseError,
      raw: u8,
      decompressed,
    });
  }

  /**
   * Re-serialize. Currently pass-through: returns the original bytes
   * when nothing has been mutated. Mutating callers must set `_dirty`
   * — and right now that throws because LZ4 isn't byte-stable so we
   * haven't decided what the game accepts as a re-emitted blob.
   */
  serialize() {
    if (this._dirty) {
      throw new Error('UnrealBlob.serialize: re-encoding edited blobs is not implemented yet');
    }
    if (!(this._raw instanceof Uint8Array)) {
      throw new Error('UnrealBlob.serialize: original bytes missing; cannot synthesize a body');
    }
    return this._raw;
  }
}

// --------------------------------------------------------------------------
// Codec-registry adapter. SMDB.codecs.register() consumes this.
// --------------------------------------------------------------------------
export const codec = {
  name: NAME,
  detect: u8 => UnrealBlob.detect(u8),
  decode: u8 => UnrealBlob.decode(u8),
  encode: blob => blob.serialize(),
};
