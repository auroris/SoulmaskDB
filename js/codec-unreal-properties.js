'use strict';
/**
 * Codec for the Soulmask "actor_data" blob: 14-byte chunk header followed
 * by a UE 4.27 FArchive property-tag stream where FNames are serialized as
 * FString (the FObjectAndNameAsStringProxyArchive pattern).
 *
 *   Header layout (14 bytes, LE):
 *     u32  versionTag      always 0x00000002
 *     u32  headerWord1     varies (loosely correlates with size — possibly
 *                          a per-save sequence number or rolling hash)
 *     u32  headerWord2     `?? ?? 02 00` pattern (top half always 0x0002).
 *                          Tens of distinct values per DB; likely an
 *                          FCustomVersion tag varying by class/instance.
 *     u16  headerExtra     always 0 in observed data
 *
 *   Body: stream of FPropertyTag + value pairs, terminated by FName "None".
 *
 *   See docs/blob-format.md for the full reverse-engineered layout,
 *   especially the inventory slot-record format and the descending-order
 *   + carry-high-byte count encoding used by stackable items.
 *
 *   FPropertyTag (UE 4.27, PropertyTag.h, with FNames as FString):
 *     FName  Name                       // FString + int32 Number
 *     [if Name == "None": stream end]
 *     FName  Type
 *     int32  Size                       // bytes of value data following the tag
 *     int32  ArrayIndex
 *     // type-specific tag data:
 *     if Type == "StructProperty":  FName StructName + FGuid StructGuid
 *     if Type == "BoolProperty":    u8 BoolVal
 *     if Type == "ByteProperty":    FName EnumName
 *     if Type == "EnumProperty":    FName EnumName
 *     if Type == "ArrayProperty":   FName InnerType
 *     if Type == "SetProperty":     FName InnerType
 *     if Type == "MapProperty":     FName InnerType + FName ValueType
 *     u8 HasPropertyGuid
 *     if HasPropertyGuid:           FGuid PropertyGuid
 *     // then: Size bytes of value data (format depends on Type)
 *
 * The decoder is robust: on any parse failure inside the body, it captures
 * what it parsed, stores the unread tail as `bodyTrailingBytes`, and sets
 * `.error`. The encoder refuses to re-emit a blob whose decode had an
 * error (that would risk silent corruption); callers can fall back to
 * `_raw` if they want pass-through.
 *
 * Round-trip safety: `verifyRoundTrip(bytes)` re-encodes a freshly
 * decoded view and asserts byte-for-byte equality. If this returns
 * `{ok:true}` for a blob, the codec is a faithful round-trip for that
 * blob's shape and structural edits are safe.
 */

window.SMDB = window.SMDB || {};

SMDB.codecUnrealProperties = (() => {
  const NAME = 'unreal-properties';
  const HEADER_SIZE = 14;
  const VERSION_TAG = 0x00000002;

  // ====================================================================
  // Cursor — read primitives
  // ====================================================================
  class Cursor {
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
     * FString:  int32 SaveNum  (length in code units, INCLUDING null terminator)
     *           SaveNum > 0 → ANSI;  SaveNum < 0 → UTF-16 LE;  SaveNum == 0 → empty.
     */
    readFString() {
      const saveNum = this.readInt32();
      if (saveNum === 0) return { value: '', isUnicode: false };
      const isUnicode = saveNum < 0;
      const codeUnits = isUnicode ? -saveNum : saveNum;
      const byteLen = isUnicode ? codeUnits * 2 : codeUnits;
      const slice = this.readBytes(byteLen);
      const data = isUnicode ? slice.subarray(0, byteLen - 2) : slice.subarray(0, byteLen - 1);
      let value;
      if (isUnicode) {
        // UTF-16 LE
        const codes = [];
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 0; i + 1 < data.length; i += 2) codes.push(dv.getUint16(i, true));
        value = String.fromCharCode(...codes);
      } else {
        value = '';
        for (let i = 0; i < data.length; i++) value += String.fromCharCode(data[i]);
      }
      return { value, isUnicode };
    }

    /** FName (FString form): { value, number, isUnicode } */
    readFName() {
      const s = this.readFString();
      const number = this.readInt32();
      return { value: s.value, number, isUnicode: s.isUnicode };
    }

    /** FGuid: 4 uint32 LE → standard 8-4-4-4-12 hex string */
    readFGuid() {
      const A = this.readUint32(), B = this.readUint32(), C = this.readUint32(), D = this.readUint32();
      const h = (n, w) => n.toString(16).padStart(w, '0').toUpperCase();
      return `${h(A, 8)}-${h(B >>> 16, 4)}-${h(B & 0xFFFF, 4)}-${h(C >>> 16, 4)}-${h(C & 0xFFFF, 4)}${h(D, 8)}`;
    }
  }

  // ====================================================================
  // Writer — write primitives
  // ====================================================================
  class Writer {
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

    writeUint8(v)   { this._ensure(1); this.dv.setUint8(this.offset, v);            this.offset += 1; }
    writeInt8(v)    { this._ensure(1); this.dv.setInt8(this.offset, v);             this.offset += 1; }
    writeUint16(v)  { this._ensure(2); this.dv.setUint16(this.offset, v, true);     this.offset += 2; }
    writeInt16(v)   { this._ensure(2); this.dv.setInt16(this.offset, v, true);      this.offset += 2; }
    writeUint32(v)  { this._ensure(4); this.dv.setUint32(this.offset, v >>> 0, true); this.offset += 4; }
    writeInt32(v)   { this._ensure(4); this.dv.setInt32(this.offset, v | 0, true);  this.offset += 4; }
    writeUint64(v)  { this._ensure(8); this.dv.setBigUint64(this.offset, BigInt(v), true); this.offset += 8; }
    writeInt64(v)   { this._ensure(8); this.dv.setBigInt64(this.offset, BigInt(v), true);  this.offset += 8; }
    writeFloat32(v) { this._ensure(4); this.dv.setFloat32(this.offset, v, true);    this.offset += 4; }
    writeFloat64(v) { this._ensure(8); this.dv.setFloat64(this.offset, v, true);    this.offset += 8; }
    writeBytes(u8)  { this._ensure(u8.length); this.bytes.set(u8, this.offset);     this.offset += u8.length; }

    writeFString(value, isUnicode = null) {
      if (value == null || value === '') { this.writeInt32(0); return; }
      if (isUnicode === null) {
        // Auto-detect: UTF-16 if any code unit is outside ASCII-7F.
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

    writeFName(name) {
      if (typeof name === 'string') name = { value: name, number: 0 };
      this.writeFString(name.value, name.isUnicode ?? null);
      this.writeInt32(name.number || 0);
    }

    writeFGuid(s) {
      const m = String(s).match(/^([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})([0-9A-Fa-f]{8})$/);
      if (!m) throw new Error(`writeFGuid: invalid FGuid string '${s}'`);
      const A = parseInt(m[1], 16);
      const B = (parseInt(m[2], 16) << 16) | parseInt(m[3], 16);
      const C = (parseInt(m[4], 16) << 16) | parseInt(m[5], 16);
      const D = parseInt(m[6], 16);
      this.writeUint32(A); this.writeUint32(B); this.writeUint32(C); this.writeUint32(D);
    }
  }

  // ====================================================================
  // Known struct types — read directly as binary, no nested property tags
  // ====================================================================
  // Soulmask is UE 4.27, so all "core" structs (Vector etc.) are 32-bit floats.
  const STRUCT_HANDLERS = {
    Vector:      { read: c => ({ x: c.readFloat32(), y: c.readFloat32(), z: c.readFloat32() }),
                   write: (w, v) => { w.writeFloat32(v.x); w.writeFloat32(v.y); w.writeFloat32(v.z); } },
    Vector2D:    { read: c => ({ x: c.readFloat32(), y: c.readFloat32() }),
                   write: (w, v) => { w.writeFloat32(v.x); w.writeFloat32(v.y); } },
    Vector4:     { read: c => ({ x: c.readFloat32(), y: c.readFloat32(), z: c.readFloat32(), w: c.readFloat32() }),
                   write: (w, v) => { w.writeFloat32(v.x); w.writeFloat32(v.y); w.writeFloat32(v.z); w.writeFloat32(v.w); } },
    Rotator:     { read: c => ({ pitch: c.readFloat32(), yaw: c.readFloat32(), roll: c.readFloat32() }),
                   write: (w, v) => { w.writeFloat32(v.pitch); w.writeFloat32(v.yaw); w.writeFloat32(v.roll); } },
    Quat:        { read: c => ({ x: c.readFloat32(), y: c.readFloat32(), z: c.readFloat32(), w: c.readFloat32() }),
                   write: (w, v) => { w.writeFloat32(v.x); w.writeFloat32(v.y); w.writeFloat32(v.z); w.writeFloat32(v.w); } },
    Color:       { read: c => ({ b: c.readUint8(), g: c.readUint8(), r: c.readUint8(), a: c.readUint8() }),
                   write: (w, v) => { w.writeUint8(v.b); w.writeUint8(v.g); w.writeUint8(v.r); w.writeUint8(v.a); } },
    LinearColor: { read: c => ({ r: c.readFloat32(), g: c.readFloat32(), b: c.readFloat32(), a: c.readFloat32() }),
                   write: (w, v) => { w.writeFloat32(v.r); w.writeFloat32(v.g); w.writeFloat32(v.b); w.writeFloat32(v.a); } },
    Guid:        { read: c => c.readFGuid(),
                   write: (w, v) => w.writeFGuid(v) },
    DateTime:    { read: c => c.readInt64().toString(),
                   write: (w, v) => w.writeInt64(v) },
    Timespan:    { read: c => c.readInt64().toString(),
                   write: (w, v) => w.writeInt64(v) },
    IntPoint:    { read: c => ({ x: c.readInt32(), y: c.readInt32() }),
                   write: (w, v) => { w.writeInt32(v.x); w.writeInt32(v.y); } },
    IntVector:   { read: c => ({ x: c.readInt32(), y: c.readInt32(), z: c.readInt32() }),
                   write: (w, v) => { w.writeInt32(v.x); w.writeInt32(v.y); w.writeInt32(v.z); } },
    Box:         { read: c => ({ min: STRUCT_HANDLERS.Vector.read(c), max: STRUCT_HANDLERS.Vector.read(c), isValid: c.readUint8() }),
                   write: (w, v) => { STRUCT_HANDLERS.Vector.write(w, v.min); STRUCT_HANDLERS.Vector.write(w, v.max); w.writeUint8(v.isValid); } },
    Sphere:      { read: c => ({ center: STRUCT_HANDLERS.Vector.read(c), radius: c.readFloat32() }),
                   write: (w, v) => { STRUCT_HANDLERS.Vector.write(w, v.center); w.writeFloat32(v.radius); } },
    Plane:       { read: c => ({ x: c.readFloat32(), y: c.readFloat32(), z: c.readFloat32(), w: c.readFloat32() }),
                   write: (w, v) => { w.writeFloat32(v.x); w.writeFloat32(v.y); w.writeFloat32(v.z); w.writeFloat32(v.w); } },
    Transform:   { // FTransform layout used by USaveGame: Quat rotation + Vector translation + Vector scale3D
                   read: c => ({ rotation: STRUCT_HANDLERS.Quat.read(c), translation: STRUCT_HANDLERS.Vector.read(c), scale3D: STRUCT_HANDLERS.Vector.read(c) }),
                   write: (w, v) => { STRUCT_HANDLERS.Quat.write(w, v.rotation); STRUCT_HANDLERS.Vector.write(w, v.translation); STRUCT_HANDLERS.Vector.write(w, v.scale3D); } },
  };

  // ====================================================================
  // Property tag (header) — read/write
  // ====================================================================
  function readPropertyTag(cursor) {
    const startOff = cursor.pos();
    const name = cursor.readFName();

    if (name.value === 'None') {
      return { name, isTerminator: true, _bytesRead: cursor.pos() - startOff };
    }

    const type = cursor.readFName();
    const size = cursor.readInt32();
    const arrayIndex = cursor.readInt32();

    const tag = {
      name, type, size, arrayIndex,
      isTerminator: false,
      structName: null, structGuid: null,
      boolVal: null,
      enumName: null,
      innerType: null, valueType: null,
      hasPropertyGuid: false, propertyGuid: null,
    };

    switch (type.value) {
      case 'StructProperty': tag.structName = cursor.readFName(); tag.structGuid = cursor.readFGuid(); break;
      case 'BoolProperty':   tag.boolVal = cursor.readUint8(); break;
      case 'ByteProperty':   tag.enumName = cursor.readFName(); break;
      case 'EnumProperty':   tag.enumName = cursor.readFName(); break;
      case 'ArrayProperty':  tag.innerType = cursor.readFName(); break;
      case 'SetProperty':    tag.innerType = cursor.readFName(); break;
      case 'MapProperty':    tag.innerType = cursor.readFName(); tag.valueType = cursor.readFName(); break;
    }
    tag.hasPropertyGuid = cursor.readUint8() !== 0;
    if (tag.hasPropertyGuid) tag.propertyGuid = cursor.readFGuid();

    tag._bytesRead = cursor.pos() - startOff;
    return tag;
  }

  function writePropertyTag(writer, tag) {
    writer.writeFName(tag.name);
    if (tag.isTerminator) return;
    writer.writeFName(tag.type);
    writer.writeInt32(tag.size);
    writer.writeInt32(tag.arrayIndex);
    switch (tag.type.value) {
      case 'StructProperty': writer.writeFName(tag.structName); writer.writeFGuid(tag.structGuid); break;
      case 'BoolProperty':   writer.writeUint8(tag.boolVal); break;
      case 'ByteProperty':   writer.writeFName(tag.enumName); break;
      case 'EnumProperty':   writer.writeFName(tag.enumName); break;
      case 'ArrayProperty':  writer.writeFName(tag.innerType); break;
      case 'SetProperty':    writer.writeFName(tag.innerType); break;
      case 'MapProperty':    writer.writeFName(tag.innerType); writer.writeFName(tag.valueType); break;
    }
    writer.writeUint8(tag.hasPropertyGuid ? 1 : 0);
    if (tag.hasPropertyGuid) writer.writeFGuid(tag.propertyGuid);
  }

  // ====================================================================
  // Property values — dispatch on Type
  // ====================================================================

  /**
   * Read the value bytes for a property whose tag has already been read.
   * `sizeHint` is the tag's Size field (bytes following the tag).
   * Containers (Array/Set/Map) and StructProperty use `sizeHint` as the
   * byte budget for nested decoding.
   */
  function readValue(cursor, tag, sizeHint) {
    const t = tag.type.value;
    switch (t) {
      case 'IntProperty':    return cursor.readInt32();
      case 'Int8Property':   return cursor.readInt8();
      case 'Int16Property':  return cursor.readInt16();
      case 'Int64Property':  return cursor.readInt64().toString();
      case 'UInt16Property': return cursor.readUint16();
      case 'UInt32Property': return cursor.readUint32();
      case 'UInt64Property': return cursor.readUint64().toString();
      case 'FloatProperty':  return cursor.readFloat32();
      case 'DoubleProperty': return cursor.readFloat64();
      case 'BoolProperty':   return tag.boolVal !== 0;        // value lives in tag, no body bytes
      case 'StrProperty':    return cursor.readFString().value;
      case 'NameProperty':   return cursor.readFName();
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'WeakObjectProperty':
      case 'LazyObjectProperty':
        return cursor.readFString().value;
      case 'SoftObjectProperty':
      case 'SoftClassProperty': {
        const assetPath = cursor.readFString().value;
        const subPath   = cursor.readFString().value;
        return { assetPath, subPath };
      }
      case 'ByteProperty':
        return tag.enumName.value === 'None' ? cursor.readUint8() : cursor.readFName();
      case 'EnumProperty':
        return cursor.readFName();
      case 'StructProperty':
        return readStructValue(cursor, tag.structName.value, sizeHint);
      case 'ArrayProperty':
        return readArrayValue(cursor, tag, sizeHint);
      case 'SetProperty':
        return readSetValue(cursor, tag, sizeHint);
      case 'MapProperty':
        return readMapValue(cursor, tag, sizeHint);
      case 'TextProperty':
        // FText is a complex multi-shape format. Capture as opaque so we can round-trip.
        return { _opaque: cursor.readBytes(sizeHint).slice(), _opaqueReason: 'TextProperty (read-only)' };
      default:
        return { _opaque: cursor.readBytes(sizeHint).slice(), _opaqueReason: `Unknown property type ${t}` };
    }
  }

  function writeValue(writer, tag, value) {
    const t = tag.type.value;
    switch (t) {
      case 'IntProperty':    writer.writeInt32(value);   return;
      case 'Int8Property':   writer.writeInt8(value);    return;
      case 'Int16Property':  writer.writeInt16(value);   return;
      case 'Int64Property':  writer.writeInt64(value);   return;
      case 'UInt16Property': writer.writeUint16(value);  return;
      case 'UInt32Property': writer.writeUint32(value);  return;
      case 'UInt64Property': writer.writeUint64(value);  return;
      case 'FloatProperty':  writer.writeFloat32(value); return;
      case 'DoubleProperty': writer.writeFloat64(value); return;
      case 'BoolProperty':   return;                     // value lives in tag
      case 'StrProperty':    writer.writeFString(value); return;
      case 'NameProperty':   writer.writeFName(value);   return;
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'WeakObjectProperty':
      case 'LazyObjectProperty':
        writer.writeFString(value); return;
      case 'SoftObjectProperty':
      case 'SoftClassProperty':
        writer.writeFString(value.assetPath || '');
        writer.writeFString(value.subPath || '');
        return;
      case 'ByteProperty':
        if (tag.enumName.value === 'None') writer.writeUint8(value);
        else writer.writeFName(value);
        return;
      case 'EnumProperty':
        writer.writeFName(value); return;
      case 'StructProperty':
        writeStructValue(writer, tag.structName.value, value);
        return;
      case 'ArrayProperty':
        writeArrayValue(writer, tag, value); return;
      case 'SetProperty':
        writeSetValue(writer, tag, value); return;
      case 'MapProperty':
        writeMapValue(writer, tag, value); return;
      case 'TextProperty':
        if (value && value._opaque) { writer.writeBytes(value._opaque); return; }
        throw new Error('writeValue: TextProperty without opaque bytes is not supported');
      default:
        if (value && value._opaque) { writer.writeBytes(value._opaque); return; }
        throw new Error(`writeValue: no encoder for type ${t}`);
    }
  }

  // ----- struct values ----------------------------------------------------
  function readStructValue(cursor, structName, sizeHint) {
    const handler = STRUCT_HANDLERS[structName];
    if (handler) {
      return { _structName: structName, value: handler.read(cursor) };
    }
    // Unknown struct → assume it's a nested property tag stream of `sizeHint` bytes.
    const startOff = cursor.pos();
    let nested;
    try { nested = readPropertyStream(cursor, startOff + sizeHint); }
    catch (e) {
      const consumed = cursor.pos() - startOff;
      const tail = sizeHint - consumed;
      const opaqueTail = tail > 0 ? cursor.readBytes(tail).slice() : null;
      return { _structName: structName, _structDecodeError: e.message, _opaqueTail: opaqueTail };
    }
    return { _structName: structName, value: nested.properties, terminated: nested.terminated };
  }

  function writeStructValue(writer, structName, sv) {
    const handler = STRUCT_HANDLERS[structName];
    if (handler) {
      handler.write(writer, sv.value);
      return;
    }
    if (sv._structDecodeError) {
      // We failed to fully decode → re-emit any opaque tail. Without the
      // properties we can't reconstruct, so this only works if there were
      // zero properties before the failure.
      if (Array.isArray(sv.value) && sv.value.length > 0) {
        throw new Error(`writeStructValue: struct '${structName}' had decode error and partial properties; cannot safely re-emit`);
      }
      if (sv._opaqueTail) writer.writeBytes(sv._opaqueTail);
      return;
    }
    writePropertyStream(writer, sv.value);
  }

  // ----- array / set / map values ----------------------------------------
  function readArrayValue(cursor, tag, sizeHint) {
    const startOff = cursor.pos();
    const numElements = cursor.readInt32();
    const innerType = tag.innerType.value;
    const elements = [];

    if (innerType === 'StructProperty') {
      // Inner tag describing the element struct. Field name in this tag is
      // typically the array property name (informational only).
      const innerTag = readPropertyTag(cursor);
      // Inner tag should have isTerminator===false; if not, the array is malformed.
      if (innerTag.isTerminator || innerTag.type.value !== 'StructProperty') {
        throw new Error(`readArrayValue: expected StructProperty inner tag, got ${innerTag.type?.value}`);
      }
      const structName = innerTag.structName.value;
      const handler = STRUCT_HANDLERS[structName];
      if (handler) {
        for (let i = 0; i < numElements; i++) elements.push({ _structName: structName, value: handler.read(cursor) });
      } else {
        // Per-element nested property stream. We don't know each element's byte
        // count individually; we allow them to consume up to the array's remaining
        // budget. UE serializes each element as a property stream terminated by None.
        for (let i = 0; i < numElements; i++) {
          const eStart = cursor.pos();
          const stream = readPropertyStream(cursor, startOff + sizeHint);
          elements.push({ _structName: structName, value: stream.properties, terminated: stream.terminated });
        }
      }
      return { _arrayInnerTag: innerTag, elements };
    }

    for (let i = 0; i < numElements; i++) {
      elements.push(readArrayElement(cursor, innerType, tag));
    }
    return { elements };
  }

  function writeArrayValue(writer, tag, value) {
    const innerType = tag.innerType.value;
    writer.writeInt32(value.elements.length);
    if (innerType === 'StructProperty') {
      writePropertyTag(writer, value._arrayInnerTag);
      const structName = value._arrayInnerTag.structName.value;
      const handler = STRUCT_HANDLERS[structName];
      for (const e of value.elements) {
        if (handler) handler.write(writer, e.value);
        else writePropertyStream(writer, e.value);
      }
      return;
    }
    for (const e of value.elements) writeArrayElement(writer, innerType, e);
  }

  // Read/write one array OR set element of a non-struct inner type.
  // (No per-element FPropertyTag wrapper.)
  function readArrayElement(cursor, innerType, tag) {
    switch (innerType) {
      case 'IntProperty':    return cursor.readInt32();
      case 'Int8Property':   return cursor.readInt8();
      case 'Int16Property':  return cursor.readInt16();
      case 'Int64Property':  return cursor.readInt64().toString();
      case 'UInt16Property': return cursor.readUint16();
      case 'UInt32Property': return cursor.readUint32();
      case 'UInt64Property': return cursor.readUint64().toString();
      case 'FloatProperty':  return cursor.readFloat32();
      case 'DoubleProperty': return cursor.readFloat64();
      case 'BoolProperty':   return cursor.readUint8() !== 0;   // arrays of bool are 1 byte each
      case 'ByteProperty':   return cursor.readUint8();
      case 'EnumProperty':   return cursor.readFName();
      case 'NameProperty':   return cursor.readFName();
      case 'StrProperty':    return cursor.readFString().value;
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'WeakObjectProperty':
      case 'LazyObjectProperty':
        return cursor.readFString().value;
      case 'SoftObjectProperty':
      case 'SoftClassProperty':
        return { assetPath: cursor.readFString().value, subPath: cursor.readFString().value };
      default:
        throw new Error(`readArrayElement: unsupported innerType '${innerType}'`);
    }
  }

  function writeArrayElement(writer, innerType, value) {
    switch (innerType) {
      case 'IntProperty':    writer.writeInt32(value);   return;
      case 'Int8Property':   writer.writeInt8(value);    return;
      case 'Int16Property':  writer.writeInt16(value);   return;
      case 'Int64Property':  writer.writeInt64(value);   return;
      case 'UInt16Property': writer.writeUint16(value);  return;
      case 'UInt32Property': writer.writeUint32(value);  return;
      case 'UInt64Property': writer.writeUint64(value);  return;
      case 'FloatProperty':  writer.writeFloat32(value); return;
      case 'DoubleProperty': writer.writeFloat64(value); return;
      case 'BoolProperty':   writer.writeUint8(value ? 1 : 0); return;
      case 'ByteProperty':   writer.writeUint8(value);   return;
      case 'EnumProperty':
      case 'NameProperty':   writer.writeFName(value);   return;
      case 'StrProperty':    writer.writeFString(value); return;
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'WeakObjectProperty':
      case 'LazyObjectProperty':
        writer.writeFString(value); return;
      case 'SoftObjectProperty':
      case 'SoftClassProperty':
        writer.writeFString(value.assetPath || '');
        writer.writeFString(value.subPath || '');
        return;
      default:
        throw new Error(`writeArrayElement: unsupported innerType '${innerType}'`);
    }
  }

  function readSetValue(cursor, tag, sizeHint) {
    const numToRemove = cursor.readInt32();
    const removed = [];
    for (let i = 0; i < numToRemove; i++) removed.push(readArrayElement(cursor, tag.innerType.value, tag));
    const numElements = cursor.readInt32();
    const elements = [];
    for (let i = 0; i < numElements; i++) elements.push(readArrayElement(cursor, tag.innerType.value, tag));
    return { removed, elements };
  }

  function writeSetValue(writer, tag, value) {
    writer.writeInt32(value.removed.length);
    for (const v of value.removed) writeArrayElement(writer, tag.innerType.value, v);
    writer.writeInt32(value.elements.length);
    for (const v of value.elements) writeArrayElement(writer, tag.innerType.value, v);
  }

  function readMapValue(cursor, tag, sizeHint) {
    const numKeysToRemove = cursor.readInt32();
    const removed = [];
    for (let i = 0; i < numKeysToRemove; i++) removed.push(readArrayElement(cursor, tag.innerType.value, tag));
    const numElements = cursor.readInt32();
    const entries = [];
    for (let i = 0; i < numElements; i++) {
      const key = readArrayElement(cursor, tag.innerType.value, tag);
      const val = readArrayElement(cursor, tag.valueType.value, tag);
      entries.push({ key, value: val });
    }
    return { removed, entries };
  }

  function writeMapValue(writer, tag, value) {
    writer.writeInt32(value.removed.length);
    for (const k of value.removed) writeArrayElement(writer, tag.innerType.value, k);
    writer.writeInt32(value.entries.length);
    for (const e of value.entries) {
      writeArrayElement(writer, tag.innerType.value, e.key);
      writeArrayElement(writer, tag.valueType.value, e.value);
    }
  }

  // ====================================================================
  // Property stream
  // ====================================================================
  /**
   * Read property tags until either a "None" terminator or `endOffset` is
   * reached (whichever comes first). Returns { properties, terminated, endPos }.
   */
  function readPropertyStream(cursor, endOffset = Infinity) {
    const properties = [];
    while (cursor.pos() < endOffset && !cursor.eof()) {
      const tag = readPropertyTag(cursor);
      if (tag.isTerminator) {
        return { properties, terminated: true, endPos: cursor.pos() };
      }
      const valueStart = cursor.pos();
      const value = readValue(cursor, tag, tag.size);
      const valueEnd = cursor.pos();
      const actualSize = valueEnd - valueStart;
      const entry = { tag, value };
      if (actualSize !== tag.size) {
        // Reader disagreed with the tag's claimed Size. Trust the tag and
        // capture the discrepancy so the encoder can warn.
        entry._sizeMismatch = { expected: tag.size, actual: actualSize };
        // Snap forward to where Size says the value ends.
        cursor.seek(valueStart + tag.size);
      }
      properties.push(entry);
    }
    return { properties, terminated: false, endPos: cursor.pos() };
  }

  function writePropertyStream(writer, properties) {
    for (const p of properties) {
      if (p._sizeMismatch) {
        throw new Error(`writePropertyStream: property '${p.tag.name?.value}' has _sizeMismatch (${JSON.stringify(p._sizeMismatch)}); cannot safely re-emit`);
      }
      writePropertyTag(writer, p.tag);
      writeValue(writer, p.tag, p.value);
    }
    // Terminator
    writer.writeFString('None');
    writer.writeInt32(0);
  }

  // ====================================================================
  // Top-level codec (header + body)
  // ====================================================================
  function detect(u8) {
    if (!u8 || u8.length < HEADER_SIZE) return false;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return dv.getUint32(0, true) === VERSION_TAG;
  }

  function readHeader(cursor) {
    return {
      versionTag:  cursor.readUint32(),
      headerWord1: cursor.readUint32(),
      headerWord2: cursor.readUint32(),
      headerExtra: cursor.readUint16(),
    };
  }

  function writeHeader(writer, header) {
    writer.writeUint32(header.versionTag);
    writer.writeUint32(header.headerWord1);
    writer.writeUint32(header.headerWord2);
    writer.writeUint16(header.headerExtra);
  }

  /**
   * Scan a byte range for length-prefixed UTF-8 FNames in the form
   * `[u32 length][bytes][\0]` where the inner bytes are printable ASCII.
   * This is a "peek-at-strings" pass — it doesn't claim to recover the
   * structure, but it surfaces every FName the format embeds literally.
   */
  function extractFNames(bytes, startOffset = 0) {
    const out = [];
    if (!bytes || bytes.length < startOffset + 5) return out;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = startOffset;
    while (i < bytes.length - 4) {
      const L = dv.getUint32(i, true);
      if (L >= 2 && L <= 1024 && i + 4 + L <= bytes.length) {
        const slice = bytes.subarray(i + 4, i + 4 + L);
        if (slice[slice.length - 1] === 0) {
          let ok = true;
          for (let j = 0; j < slice.length - 1; j++) {
            const b = slice[j];
            if (b < 32 || b >= 127) { ok = false; break; }
          }
          if (ok) {
            let text = '';
            for (let j = 0; j < slice.length - 1; j++) text += String.fromCharCode(slice[j]);
            out.push({ offset: i, length: L, text });
            i += 4 + L;
            continue;
          }
        }
      }
      i++;
    }
    return out;
  }

  /**
   * Decode the 14-byte header and capture the body as opaque bytes plus a
   * passive scan of embedded FNames.
   *
   * NOTE: the body of this format uses a non-standard tagged-property layout
   * that hasn't been fully reverse-engineered. Until then this codec is
   * read-only: encode() returns the original bytes untouched.
   */
  function decode(u8) {
    if (!detect(u8)) {
      const head = u8 ? Array.from(u8.subarray(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ') : '(empty)';
      throw new Error(`codec-unreal-properties: not an unreal-properties blob (header bytes: ${head})`);
    }
    const cursor = new Cursor(u8);
    const header = readHeader(cursor);
    const body = u8.subarray(HEADER_SIZE);
    const names = extractFNames(u8, HEADER_SIZE);
    return {
      kind: NAME,
      header,
      bodySize: body.length,
      names,
      totalSize: u8.length,
      _raw: u8,
    };
  }

  function encode(decoded) {
    if (!(decoded._raw instanceof Uint8Array)) {
      throw new Error('encode: original bytes missing; cannot synthesize a body (codec is read-only)');
    }
    return decoded._raw;
  }

  /**
   * Round-trip equality test. The current codec is read-only and uses
   * pass-through encode, so this just confirms decode succeeds and that
   * the original bytes are preserved verbatim.
   */
  function verifyRoundTrip(bytes) {
    let decoded;
    try { decoded = decode(bytes); }
    catch (e) { return { ok: false, reason: 'decode threw: ' + e.message }; }
    let encoded;
    try { encoded = encode(decoded); }
    catch (e) { return { ok: false, reason: 'encode threw: ' + e.message, decoded }; }
    if (encoded.length !== bytes.length) {
      return { ok: false, reason: `length mismatch`, decoded, encoded };
    }
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] !== bytes[i]) {
        return { ok: false, reason: `byte mismatch @0x${i.toString(16)}`, decoded, encoded };
      }
    }
    return { ok: true, decoded, encoded };
  }

  return {
    name: NAME,
    detect, decode, encode, verifyRoundTrip, extractFNames,
    HEADER_SIZE, VERSION_TAG,
    STRUCT_HANDLERS,
    // Phase-1/2 structured primitives — kept for the day we crack the body format.
    _internal: { Cursor, Writer, readPropertyTag, writePropertyTag, readPropertyStream, writePropertyStream, readValue, writeValue, writeHeader, readHeader },
  };
})();
