'use strict';
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
 * Round-trip safety: LZ4 has many valid encodings for the same data so
 * re-compression is NOT byte-identical. UnrealBlob keeps the original
 * bytes around and returns them verbatim on serialize() when nothing has
 * been mutated. Mutation support is a later step — for now `serialize`
 * throws if `_dirty` is set.
 *
 * Also registers `SMDB.codecUnrealProperties` as the adapter the
 * SMDB.codecs registry consumes.
 */
window.SMDB = window.SMDB || {};
SMDB.unreal = SMDB.unreal || {};

(() => {
  const { readPropertyStream, writePropertyStream } = SMDB.unreal;
  const { Cursor } = SMDB.unreal;

  const NAME = 'unreal-properties';
  const OUTER_HEADER_SIZE = 4;
  const OUTER_VERSION_TAG = 0x00000002;
  const INNER_HEADER_SIZE = 4;

  // --------------------------------------------------------------------------
  // LZ4 raw-block codec (size-prefixed variant: [u32 LE size][block bytes]).
  // Backed by node-lz4, surfaced at /lib/lz4/lz4.js which installs a global
  // `require` shim.
  // --------------------------------------------------------------------------
  const LZ4 = (typeof require === 'function') ? require('lz4') : null;
  const Buffer = (typeof require === 'function') ? require('buffer').Buffer : null;

  function lz4Decompress(src, srcOff = 0) {
    if (!LZ4 || !Buffer) throw new Error('lz4: lib/lz4/lz4.js not loaded');
    if (srcOff + 4 > src.length) throw new Error('lz4: source too small for size prefix');
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const expectedSize = dv.getUint32(srcOff, true);
    const input = Buffer.from(src.buffer, src.byteOffset + srcOff + 4, src.byteLength - srcOff - 4);
    const output = Buffer.alloc(expectedSize);
    const written = LZ4.decodeBlock(input, output);
    if (written < 0) throw new Error(`lz4: decodeBlock returned ${written} (error code)`);
    if (written !== expectedSize) throw new Error(`lz4: decoded ${written} bytes, expected ${expectedSize}`);
    return new Uint8Array(output.buffer, output.byteOffset, written);
  }

  function lz4Compress(decompressed) {
    if (!LZ4 || !Buffer) throw new Error('lz4: lib/lz4/lz4.js not loaded');
    const input = Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    const output = Buffer.alloc(LZ4.encodeBound(decompressed.length));
    const written = LZ4.encodeBlock(input, output);
    if (written <= 0) throw new Error(`lz4: encodeBlock returned ${written}`);
    const out = new Uint8Array(4 + written);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, decompressed.length, true);
    out.set(new Uint8Array(output.buffer, output.byteOffset, written), 4);
    return out;
  }

  // --------------------------------------------------------------------------
  // UnrealBlob — the object handed back from decode.
  // --------------------------------------------------------------------------
  class UnrealBlob {
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
  const codec = {
    name: NAME,
    detect: u8 => UnrealBlob.detect(u8),
    decode: u8 => UnrealBlob.decode(u8),
    encode: blob => blob.serialize(),
    verifyRoundTrip: bytes => UnrealBlob.verifyRoundTrip(bytes),
  };

  SMDB.unreal.UnrealBlob = UnrealBlob;
  SMDB.unreal.lz4Decompress = lz4Decompress;
  SMDB.unreal.lz4Compress = lz4Compress;
  SMDB.unreal.OUTER_VERSION_TAG = OUTER_VERSION_TAG;
  SMDB.unreal.codec = codec;

  // Back-compat shim: the codec registry (js/codecs.js) still references
  // this name. The bound `decode`/`encode` are the same as above; nothing
  // else from the old `SMDB.codecUnrealProperties` surface is re-exported.
  SMDB.codecUnrealProperties = codec;
})();
