/**
 * StructValue + STRUCT_HANDLERS registry.
 *
 * Soulmask is UE 4.27 so "core" structs (Vector etc.) use 32-bit floats.
 * Known struct names read directly as binary; unknown struct names fall
 * through to a nested property stream (handled in properties.mjs, not here
 * — StructValue.read is supplied a `streamReader` callback to avoid a
 * load-order cycle).
 */

import { FGuid } from './primitives.mjs';

// Binary struct handlers. Each entry has read(cursor) → plain object and
// write(writer, plainObject). The plain object is what callers see as
// `structValue.value` when the struct is one of these known shapes.
export const STRUCT_HANDLERS = {
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
  Guid:        { read: c => FGuid.read(c).value,
                 write: (w, v) => new FGuid(v).write(w) },
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
  Transform:   { read: c => ({ rotation: STRUCT_HANDLERS.Quat.read(c), translation: STRUCT_HANDLERS.Vector.read(c), scale3D: STRUCT_HANDLERS.Vector.read(c) }),
                 write: (w, v) => { STRUCT_HANDLERS.Quat.write(w, v.rotation); STRUCT_HANDLERS.Vector.write(w, v.translation); STRUCT_HANDLERS.Vector.write(w, v.scale3D); } },
};

export class StructValue {
  constructor(structName, { value = null, terminated = false, decodeError = null, opaqueTail = null } = {}) {
    this._structName = structName;
    this.value = value;
    this.terminated = terminated;
    if (decodeError) this._structDecodeError = decodeError;
    if (opaqueTail) this._opaqueTail = opaqueTail;
  }

  get structName() { return this._structName; }
  get isKnownBinary() { return STRUCT_HANDLERS[this._structName] != null; }

  /**
   * `streamReader(cursor, endOffset)` is `readPropertyStream` from
   * properties.mjs, passed in to avoid a module cycle. Returns
   * { properties, terminated, endPos }.
   *
   * `peekFn(cursor)` (optional) peeks at the cursor without advancing it
   * and returns true if the bytes look like the start of a tagged
   * PropertyTag (FString name with identifier-character ASCII content).
   * When supplied and the wire bytes look tagged, the read switches to
   * the property-stream path even for structs that have a known binary
   * handler — Soulmask encodes known-binary structs (Transform, Box, ...)
   * as TAGGED property streams inside Map struct values, which would
   * otherwise be misread as raw 40-byte Transforms / etc. The decision
   * is recorded on the returned StructValue via `Array.isArray(value)`,
   * so `write()` dispatches correctly.
   */
  static read(cursor, structName, sizeHint, streamReader, peekFn = null) {
    const handler = STRUCT_HANDLERS[structName];
    if (handler && (!peekFn || !peekFn(cursor))) {
      return new StructValue(structName, { value: handler.read(cursor) });
    }
    const startOff = cursor.pos();
    let nested;
    try { nested = streamReader(cursor, startOff + sizeHint); }
    catch (e) {
      const consumed = cursor.pos() - startOff;
      const tail = sizeHint - consumed;
      const opaqueTail = tail > 0 ? cursor.readBytes(tail).slice() : null;
      return new StructValue(structName, { value: [], decodeError: e.message, opaqueTail });
    }
    return new StructValue(structName, { value: nested.properties, terminated: nested.terminated });
  }

  /**
   * `streamWriter(writer, propertiesArray)` is `writePropertyStream` (nested form).
   *
   * Dispatches on the value shape, NOT on whether a handler exists: when
   * `value` is an array of Property objects, the struct was decoded via
   * the property-stream path (regardless of handler registration) and
   * must be written the same way for byte-identical round-trip. The
   * handler path runs only when the value is a plain object.
   */
  write(writer, streamWriter) {
    if (Array.isArray(this.value)) {
      if (this._structDecodeError && this.value.length === 0) {
        if (this._opaqueTail) writer.writeBytes(this._opaqueTail);
        return;
      }
      if (this._structDecodeError && this.value.length > 0) {
        throw new Error(`StructValue.write: struct '${this._structName}' had decode error and partial properties; cannot safely re-emit`);
      }
      streamWriter(writer, this.value);
      return;
    }
    const handler = STRUCT_HANDLERS[this._structName];
    if (handler) { handler.write(writer, this.value); return; }
    if (this._structDecodeError) {
      if (this._opaqueTail) writer.writeBytes(this._opaqueTail);
      return;
    }
    throw new Error(`StructValue.write: no handler for '${this._structName}' and value is not a property array`);
  }
}
