'use strict';
/**
 * Codec for the length-prefixed JSON wrapper format.
 *
 * Layout: [u32 LE: payload length][payload bytes][optional trailing NUL]
 *
 * The only known instance in the wild is actor #9 (GAME_SETTINGS), whose
 * payload is `{"AppliedMODs": [...]}`. The codec is deliberately
 * format-only — it doesn't enforce a particular schema for the JSON body.
 */
window.SMDB = window.SMDB || {};

SMDB.codecJson = (() => {
  const NAME = 'json-wrapped';

  function detect(u8) {
    if (!u8 || u8.length < 5) return false;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const declared = dv.getUint32(0, true);
    // Payload occupies all remaining bytes.
    if (declared !== u8.length - 4) return false;
    // Sniff payload: must look like JSON (object or array) at first non-whitespace byte.
    for (let i = 4; i < u8.length; i++) {
      const b = u8[i];
      if (b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D) continue;
      return b === 0x7B /* { */ || b === 0x5B /* [ */;
    }
    return false;
  }

  function decode(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const declared = dv.getUint32(0, true);
    const payload = u8.subarray(4, 4 + declared);
    const trailingNull = payload.length > 0 && payload[payload.length - 1] === 0;
    const textBytes = trailingNull ? payload.subarray(0, payload.length - 1) : payload;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(textBytes);
    let parsed = null;
    let parseError = null;
    try { parsed = JSON.parse(text); }
    catch (e) { parseError = e.message; }
    return {
      kind: NAME,
      header: { declaredLength: declared },
      text,
      parsed,
      parseError,
      _trailingNull: trailingNull,
      _raw: u8,
    };
  }

  /**
   * Re-encode. Prefers (in order):
   *   1. decoded.parsed     — re-stringified (compact)
   *   2. decoded.text       — used as-is
   * Always restores the [u32 length][text][trailing NUL?] envelope.
   */
  function encode(decoded) {
    let bodyText;
    if (decoded.parsed !== undefined && decoded.parsed !== null) {
      bodyText = JSON.stringify(decoded.parsed);
    } else if (typeof decoded.text === 'string') {
      bodyText = decoded.text;
    } else {
      throw new Error('codec-json: nothing to encode (missing .parsed and .text)');
    }
    const body = new TextEncoder().encode(bodyText);
    const includeNull = decoded._trailingNull !== false;
    const payloadLen = body.length + (includeNull ? 1 : 0);
    const out = new Uint8Array(4 + payloadLen);
    new DataView(out.buffer).setUint32(0, payloadLen, true);
    out.set(body, 4);
    // includeNull leaves the trailing zero byte in place from `new Uint8Array`.
    return out;
  }

  return { name: NAME, detect, decode, encode };
})();
