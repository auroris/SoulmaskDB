/**
 * Cursor + Writer — byte-level read/write primitives over a Uint8Array.
 *
 * No Unreal semantics here. FString lives here too because it's a stateful
 * read/write on the same DataView; everything else (FName, FGuid, structs,
 * properties) builds on top of these.
 */

export class Cursor {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }
  pos()       { return this.offset; }
  eof()       { return this.offset >= this.bytes.length; }
  remaining() { return this.bytes.length - this.offset; }
  skip(n)     { this.offset += n; }
  seek(n)     { this.offset = n; }

  readUint8()   { const v = this.dv.getUint8(this.offset);            this.offset += 1; return v; }
  readInt8()    { const v = this.dv.getInt8(this.offset);             this.offset += 1; return v; }
  readUint16()  { const v = this.dv.getUint16(this.offset, true);     this.offset += 2; return v; }
  readInt16()   { const v = this.dv.getInt16(this.offset, true);      this.offset += 2; return v; }
  readUint32()  { const v = this.dv.getUint32(this.offset, true);     this.offset += 4; return v; }
  readInt32()   { const v = this.dv.getInt32(this.offset, true);      this.offset += 4; return v; }
  readUint64()  { const v = this.dv.getBigUint64(this.offset, true);  this.offset += 8; return v; }
  readInt64()   { const v = this.dv.getBigInt64(this.offset, true);   this.offset += 8; return v; }
  readFloat32() { const v = this.dv.getFloat32(this.offset, true);    this.offset += 4; return v; }
  readFloat64() { const v = this.dv.getFloat64(this.offset, true);    this.offset += 8; return v; }
  readBytes(n)  { const out = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return out; }

  /**
   * FString:  int32 SaveNum  (length in code units INCLUDING null terminator)
   *           SaveNum > 0 → ANSI;  SaveNum < 0 → UTF-16 LE;  SaveNum == 0 → empty.
   *
   * The wire format distinguishes two flavors of empty:
   *   SaveNum =  0          → "null" form. No further bytes.
   *   SaveNum =  1 (or -1)  → "empty-with-terminator". 1 ANSI byte (or 1
   *                           UTF-16 unit) follows; both are the NUL
   *                           terminator. The decoded string is still "".
   *
   * Both produce the same JS value (""), but to round-trip byte-identical
   * we need to know which one was on the wire. That distinction lives in
   * `isNull` on the return value.
   */
  readFString() {
    const saveNum = this.readInt32();
    if (saveNum === 0) return { value: '', isUnicode: false, isNull: true };
    const isUnicode = saveNum < 0;
    const codeUnits = isUnicode ? -saveNum : saveNum;
    const byteLen = isUnicode ? codeUnits * 2 : codeUnits;
    const slice = this.readBytes(byteLen);
    const data = isUnicode ? slice.subarray(0, byteLen - 2) : slice.subarray(0, byteLen - 1);
    let value;
    if (isUnicode) {
      const codes = [];
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let i = 0; i + 1 < data.length; i += 2) codes.push(dv.getUint16(i, true));
      value = String.fromCharCode(...codes);
    } else {
      value = '';
      for (let i = 0; i < data.length; i++) value += String.fromCharCode(data[i]);
    }
    return { value, isUnicode, isNull: false };
  }
}

export class Writer {
  constructor(initialCapacity = 256) {
    this.buffer = new ArrayBuffer(initialCapacity);
    this.bytes = new Uint8Array(this.buffer);
    this.dv = new DataView(this.buffer);
    this.offset = 0;
  }
  pos() { return this.offset; }
  finalize() { return this.bytes.slice(0, this.offset); }

  _ensure(n) {
    if (this.offset + n <= this.buffer.byteLength) return;
    let cap = this.buffer.byteLength;
    while (cap < this.offset + n) cap *= 2;
    const newBuf = new ArrayBuffer(cap);
    const newU8 = new Uint8Array(newBuf);
    newU8.set(this.bytes.subarray(0, this.offset));
    this.buffer = newBuf;
    this.bytes = newU8;
    this.dv = new DataView(newBuf);
  }

  writeUint8(v)   { this._ensure(1); this.dv.setUint8(this.offset, v);              this.offset += 1; }
  writeInt8(v)    { this._ensure(1); this.dv.setInt8(this.offset, v);               this.offset += 1; }
  writeUint16(v)  { this._ensure(2); this.dv.setUint16(this.offset, v, true);       this.offset += 2; }
  writeInt16(v)   { this._ensure(2); this.dv.setInt16(this.offset, v, true);        this.offset += 2; }
  writeUint32(v)  { this._ensure(4); this.dv.setUint32(this.offset, v >>> 0, true); this.offset += 4; }
  writeInt32(v)   { this._ensure(4); this.dv.setInt32(this.offset, v | 0, true);    this.offset += 4; }
  writeUint64(v)  { this._ensure(8); this.dv.setBigUint64(this.offset, BigInt(v), true); this.offset += 8; }
  writeInt64(v)   { this._ensure(8); this.dv.setBigInt64(this.offset, BigInt(v), true);  this.offset += 8; }
  writeFloat32(v) { this._ensure(4); this.dv.setFloat32(this.offset, v, true);      this.offset += 4; }
  writeFloat64(v) { this._ensure(8); this.dv.setFloat64(this.offset, v, true);      this.offset += 8; }
  writeBytes(u8)  { this._ensure(u8.length); this.bytes.set(u8, this.offset);       this.offset += u8.length; }

  /**
   * Write an FString. The `isNull` parameter only matters when `value` is
   * the empty string (or `null`/`undefined`); for non-empty strings the
   * wire form is unambiguous.
   *
   *   value = null/undefined         → SaveNum = 0 (null form)
   *   value = ''  and isNull truthy  → SaveNum = 0 (null form)
   *   value = ''  and isNull false   → SaveNum = 1/-1 (empty-with-terminator)
   *   value = ''  and isNull null    → SaveNum = 0 (default; matches prior behavior)
   *   value = 'x' (any non-empty)    → SaveNum encodes content
   *
   * `isUnicode` is auto-detected from the content when not supplied. For
   * an empty-with-terminator string the caller picks the encoding via
   * `isUnicode` (defaults to ANSI).
   */
  writeFString(value, isUnicode = null, isNull = null) {
    // Null form: no payload bytes.
    if (value == null || (value === '' && isNull !== false)) {
      this.writeInt32(0);
      return;
    }
    // Auto-detect encoding for non-empty content. Empty-with-terminator
    // keeps whatever the caller passed (default ANSI).
    if (isUnicode === null) {
      isUnicode = false;
      for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) >= 0x80) { isUnicode = true; break; }
      }
    }
    if (isUnicode) {
      const len = value.length + 1;
      this.writeInt32(-len);
      this._ensure(len * 2);
      for (let i = 0; i < value.length; i++) {
        this.dv.setUint16(this.offset + i * 2, value.charCodeAt(i), true);
      }
      this.dv.setUint16(this.offset + value.length * 2, 0, true);
      this.offset += len * 2;
    } else {
      const len = value.length + 1;
      this.writeInt32(len);
      this._ensure(len);
      for (let i = 0; i < value.length; i++) this.bytes[this.offset + i] = value.charCodeAt(i);
      this.bytes[this.offset + value.length] = 0;
      this.offset += len;
    }
  }
}
