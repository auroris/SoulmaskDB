'use strict';
/**
 * Codec registry.
 *
 * Each codec is an object: { name, detect(u8), decode(u8), encode(decoded) }.
 *   detect: cheap probe — return true if this codec recognizes the bytes.
 *   decode: parse bytes into a structured view tagged with `.kind === name`.
 *   encode: opposite of decode. May throw if the codec is decode-only or if
 *           the structured view can't be safely re-serialized.
 *
 * Registration order matters: detect() returns the FIRST matching codec.
 * Register more specific formats before more permissive ones.
 */
window.SMDB = window.SMDB || {};

SMDB.codecs = (() => {
  const codecs = [];

  function register(codec) {
    if (!codec || typeof codec.name !== 'string') {
      throw new Error('codecs.register: codec must have a string `name`');
    }
    codecs.push(codec);
  }

  function detect(u8) {
    if (!u8 || u8.length === 0) return null;
    for (const c of codecs) {
      try { if (c.detect(u8)) return c; } catch { /* swallow malformed */ }
    }
    return null;
  }

  function decode(u8) {
    if (!u8 || u8.length === 0) {
      return { kind: 'empty', totalSize: 0 };
    }
    const codec = detect(u8);
    if (!codec) {
      return { kind: 'unknown', totalSize: u8.length, _raw: u8 };
    }
    return codec.decode(u8);
  }

  function encode(decoded) {
    if (!decoded || typeof decoded.kind !== 'string') {
      throw new Error('codecs.encode: decoded view must have a `.kind`');
    }
    const codec = codecs.find(c => c.name === decoded.kind);
    if (!codec || typeof codec.encode !== 'function') {
      throw new Error(`codecs.encode: no encoder registered for kind '${decoded.kind}'`);
    }
    return codec.encode(decoded);
  }

  function list() { return codecs.slice(); }

  return { register, detect, decode, encode, list };
})();

// Default registrations. Order matters: JSON wrapper is very specific
// (declaredLength === total - 4 + JSON-looking payload), so it goes first.
SMDB.codecs.register(SMDB.codecJson);
SMDB.codecs.register(SMDB.codecUnrealProperties);
