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
// Two backends, picked by environment:
//   Node:     lz4-wasm-nodejs   (bare specifier; resolves through npm)
//   Browser:  ../lz4-wasm/lz4-browser.mjs (local; loads lz4_wasm_bg.wasm
//             via fetch + WebAssembly.instantiateStreaming so we don't
//             need an import map or a bundler)
//
// Both backends expose compress(Uint8Array)/decompress(Uint8Array) over
// the same wire format Soulmask uses: [u32 LE uncompressed_size][LZ4 raw
// block]. Bytes-out are verified identical against the prior node-lz4
// path on a 12k-row corpus.
//
// Top-level await keeps the dynamic-import dance off every call. Module
// importers wait for resolution; consumers see a ready API.
// --------------------------------------------------------------------------
let _wasmLz4 = null;
try {
  // Node path. In a browser this throws (bare specifier unresolvable).
  _wasmLz4 = await import('lz4-wasm-nodejs');
} catch {
  try {
    // Browser path. Relative import → resolvable in native ESM. The
    // adapter's ready() loads the .wasm before the first call.
    const mod = await import('../lz4-wasm/lz4-browser.mjs');
    await mod.ready();
    _wasmLz4 = mod;
  } catch { /* leave null; lz4Decompress/Compress will throw on use */ }
}

export function lz4Decompress(src, srcOff = 0) {
  if (!_wasmLz4) throw new Error('lz4: no lz4-wasm implementation available');
  // The wasm bindings expect [u32 LE uncompressed_size][LZ4 raw block].
  // Soulmask blobs already encode it that way starting at srcOff, so we
  // just hand over the subarray.
  const view = srcOff === 0 ? src : src.subarray(srcOff);
  return _wasmLz4.decompress(view);
}

export function lz4Compress(decompressed) {
  if (!_wasmLz4) throw new Error('lz4: no lz4-wasm implementation available');
  return _wasmLz4.compress(decompressed);
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

  /** Decode → serialize → byte-compare. Reports terminator/trailing-bytes problems too. */
  static verifyRoundTrip(bytes) {
    let blob;
    try { blob = UnrealBlob.decode(bytes); }
    catch (e) { return { ok: false, reason: 'decode threw: ' + e.message }; }
    if (blob.error)        return { ok: false, reason: 'decode error: ' + blob.error, decoded: blob };
    if (!blob.terminated)  return { ok: false, reason: 'property stream not terminated by None', decoded: blob };
    if (blob.bodyTrailing && blob.bodyTrailing.length > 0) {
      return { ok: false, reason: `${blob.bodyTrailing.length} bytes trailing after terminator`, decoded: blob };
    }
    let encoded;
    try { encoded = blob.serialize(); }
    catch (e) { return { ok: false, reason: 'serialize threw: ' + e.message, decoded: blob }; }
    if (encoded.length !== bytes.length) {
      return { ok: false, reason: 'length mismatch', decoded: blob, encoded };
    }
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] !== bytes[i]) {
        return { ok: false, reason: `byte mismatch @0x${i.toString(16)}`, decoded: blob, encoded };
      }
    }
    return { ok: true, decoded: blob, encoded };
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
  verifyRoundTrip: bytes => UnrealBlob.verifyRoundTrip(bytes),
};
