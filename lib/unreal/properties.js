'use strict';
/**
 * Property tag + property tree machinery.
 *
 * Layout (UE 4.27, PropertyTag.h, Soulmask tweaks):
 *
 *   FString  Name
 *   [if Name == "None": consume int32 trailer if outermost, stream ends]
 *   FString  Type
 *   int32    Size                  // bytes of value data following the tag
 *   int32    ArrayIndex
 *   // type-specific tag data:
 *   if Type == "StructProperty":  FString StructName + FGuid StructGuid
 *   if Type == "BoolProperty":    u8 BoolVal
 *   if Type == "ByteProperty":    FString EnumName
 *   if Type == "EnumProperty":    FString EnumName
 *   if Type == "ArrayProperty":   FString InnerType
 *   if Type == "SetProperty":     FString InnerType
 *   if Type == "MapProperty":     FString InnerType + FString ValueType
 *   u8 HasPropertyGuid
 *   if HasPropertyGuid:           FGuid PropertyGuid
 *   // then: Size bytes of value data (format depends on Type)
 *
 * The OUTERMOST property stream's "None" terminator carries a 4-byte
 * trailer (FName.Number = 0). Nested streams (struct, array-of-struct
 * elements, embedded object data) do NOT.
 */
window.SMDB = window.SMDB || {};
SMDB.unreal = SMDB.unreal || {};

(() => {
  const { FName, FGuid, StructValue, STRUCT_HANDLERS, ObjectRef, SoftObjectRef, OpaqueValue } = SMDB.unreal;

  // ==========================================================================
  // PropertyTag — the header preceding each property's value bytes.
  // ==========================================================================
  class PropertyTag {
    constructor(fields = {}) {
      this.name = fields.name ?? null;
      this.type = fields.type ?? null;
      this.size = fields.size ?? 0;
      this.arrayIndex = fields.arrayIndex ?? 0;
      this.structName = fields.structName ?? null;
      this.structGuid = fields.structGuid ?? null;
      this.boolVal = fields.boolVal ?? null;
      this.enumName = fields.enumName ?? null;
      this.innerType = fields.innerType ?? null;
      this.valueType = fields.valueType ?? null;
      this.hasPropertyGuid = !!fields.hasPropertyGuid;
      this.propertyGuid = fields.propertyGuid ?? null;
      this.isTerminator = !!fields.isTerminator;
    }

    static read(cursor) {
      const name = FName.read(cursor);
      if (name.value === 'None') return new PropertyTag({ name, isTerminator: true });

      const tag = new PropertyTag({
        name,
        type: FName.read(cursor),
        size: cursor.readInt32(),
        arrayIndex: cursor.readInt32(),
      });

      switch (tag.type.value) {
        case 'StructProperty': tag.structName = FName.read(cursor); tag.structGuid = FGuid.read(cursor); break;
        case 'BoolProperty':   tag.boolVal = cursor.readUint8(); break;
        case 'ByteProperty':   tag.enumName = FName.read(cursor); break;
        case 'EnumProperty':   tag.enumName = FName.read(cursor); break;
        case 'ArrayProperty':  tag.innerType = FName.read(cursor); break;
        case 'SetProperty':    tag.innerType = FName.read(cursor); break;
        case 'MapProperty':    tag.innerType = FName.read(cursor); tag.valueType = FName.read(cursor); break;
      }
      tag.hasPropertyGuid = cursor.readUint8() !== 0;
      if (tag.hasPropertyGuid) tag.propertyGuid = FGuid.read(cursor);
      return tag;
    }

    write(writer) {
      this.name.write(writer);
      if (this.isTerminator) return;
      this.type.write(writer);
      writer.writeInt32(this.size);
      writer.writeInt32(this.arrayIndex);
      switch (this.type.value) {
        case 'StructProperty': this.structName.write(writer); this.structGuid.write(writer); break;
        case 'BoolProperty':   writer.writeUint8(this.boolVal); break;
        case 'ByteProperty':   this.enumName.write(writer); break;
        case 'EnumProperty':   this.enumName.write(writer); break;
        case 'ArrayProperty':  this.innerType.write(writer); break;
        case 'SetProperty':    this.innerType.write(writer); break;
        case 'MapProperty':    this.innerType.write(writer); this.valueType.write(writer); break;
      }
      writer.writeUint8(this.hasPropertyGuid ? 1 : 0);
      if (this.hasPropertyGuid) this.propertyGuid.write(writer);
    }
  }

  // ==========================================================================
  // Container value classes
  // ==========================================================================
  class ArrayValue {
    constructor({ elements = [], innerTag = null } = {}) {
      this.elements = elements;
      this._arrayInnerTag = innerTag;
    }
  }

  class SetValue {
    constructor({ removed = [], elements = [] } = {}) {
      this.removed = removed;
      this.elements = elements;
    }
  }

  class MapValue {
    constructor({ removed = [], entries = [] } = {}) {
      this.removed = removed;
      this.entries = entries;
    }
  }

  // ==========================================================================
  // Property — one tag + its decoded value.
  // ==========================================================================
  class Property {
    constructor(tag, value, { sizeMismatch = null } = {}) {
      this.tag = tag;
      this.value = value;
      if (sizeMismatch) this._sizeMismatch = sizeMismatch;
    }
    get name() { return this.tag.name?.value ?? null; }
    get type() { return this.tag.type?.value ?? null; }
  }

  // ==========================================================================
  // Value codec — dispatches on tag.type.value.
  //
  // sizeHint is the tag's Size field (bytes following the tag). Containers
  // (Array/Set/Map) and StructProperty use it as the byte budget for nested
  // decoding; on failure they fall back to OpaqueValue so the stream stays
  // consistent.
  // ==========================================================================
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
      case 'BoolProperty':   return tag.boolVal !== 0;
      case 'StrProperty':    return cursor.readFString().value;
      case 'NameProperty':   return FName.read(cursor);
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'WeakObjectProperty':
      case 'LazyObjectProperty':
        return readObjectValue(cursor, sizeHint);
      case 'SoftObjectProperty':
      case 'SoftClassProperty':
        return new SoftObjectRef({ assetPath: cursor.readFString().value, subPath: cursor.readFString().value });
      case 'ByteProperty':
        return tag.enumName.value === 'None' ? cursor.readUint8() : FName.read(cursor);
      case 'EnumProperty':
        return FName.read(cursor);
      case 'StructProperty':
        return StructValue.read(cursor, tag.structName.value, sizeHint, readPropertyStream);
      case 'ArrayProperty':
      case 'SetProperty':
      case 'MapProperty': {
        const opaqueStart = cursor.pos();
        try {
          if (t === 'ArrayProperty') return readArrayValue(cursor, tag, sizeHint);
          if (t === 'SetProperty')   return readSetValue(cursor, tag);
          return readMapValue(cursor, tag);
        } catch (e) {
          cursor.seek(opaqueStart);
          return new OpaqueValue(cursor.readBytes(sizeHint).slice(), `${t} decode failed: ${e.message}`);
        }
      }
      case 'TextProperty':
        return new OpaqueValue(cursor.readBytes(sizeHint).slice(), 'TextProperty (read-only)');
      default:
        return new OpaqueValue(cursor.readBytes(sizeHint).slice(), `Unknown property type ${t}`);
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
      case 'BoolProperty':   return;                     // value lives in the tag
      case 'StrProperty':    writer.writeFString(value); return;
      case 'NameProperty':   FName.from(value).write(writer); return;
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'WeakObjectProperty':
      case 'LazyObjectProperty':
        writeObjectValue(writer, value); return;
      case 'SoftObjectProperty':
      case 'SoftClassProperty':
        if (value instanceof SoftObjectRef) value.write(writer);
        else new SoftObjectRef(value).write(writer);
        return;
      case 'ByteProperty':
        if (tag.enumName.value === 'None') writer.writeUint8(value);
        else FName.from(value).write(writer);
        return;
      case 'EnumProperty':
        FName.from(value).write(writer); return;
      case 'StructProperty':
        value.write(writer, writeNestedPropertyStream);
        return;
      case 'ArrayProperty': writeArrayValue(writer, tag, value); return;
      case 'SetProperty':   writeSetValue(writer, tag, value);   return;
      case 'MapProperty':   writeMapValue(writer, tag, value);   return;
      case 'TextProperty':
        if (value instanceof OpaqueValue) { value.write(writer); return; }
        throw new Error('writeValue: TextProperty without opaque bytes is not supported');
      default:
        if (value instanceof OpaqueValue) { value.write(writer); return; }
        throw new Error(`writeValue: no encoder for type ${t}`);
    }
  }

  // -------- ObjectProperty (top-level shape) --------
  function readObjectValue(cursor, sizeHint) {
    const start = cursor.pos();
    try {
      const kind = cursor.readUint8();
      const path = cursor.readFString().value;
      if (cursor.pos() - start >= sizeHint) {
        return new ObjectRef({ kind, path });
      }
      const classPath = cursor.readFString().value;
      if (cursor.pos() - start >= sizeHint) {
        return new ObjectRef({ kind, path, classPath });
      }
      const stream = readPropertyStream(cursor, start + sizeHint);
      return new ObjectRef({ kind, path, classPath, embedded: stream.properties, terminated: stream.terminated });
    } catch (e) {
      cursor.seek(start);
      return new OpaqueValue(cursor.readBytes(sizeHint).slice(), `ObjectProperty decode failed: ${e.message}`);
    }
  }

  function writeObjectValue(writer, value) {
    if (value instanceof ObjectRef) { value.write(writer); return; }
    // Bare-string fallback: write kind byte + path only.
    writer.writeUint8(0x03);
    writer.writeFString(value ?? '');
  }

  // -------- Array / Set / Map --------
  function readArrayValue(cursor, tag, sizeHint) {
    const startOff = cursor.pos();
    const numElements = cursor.readInt32();
    const innerType = tag.innerType.value;
    const elements = [];

    if (innerType === 'StructProperty') {
      const innerTag = PropertyTag.read(cursor);
      if (innerTag.isTerminator || innerTag.type.value !== 'StructProperty') {
        throw new Error(`readArrayValue: expected StructProperty inner tag, got ${innerTag.type?.value}`);
      }
      const structName = innerTag.structName.value;
      const handler = STRUCT_HANDLERS[structName];
      if (handler) {
        for (let i = 0; i < numElements; i++) elements.push(new StructValue(structName, { value: handler.read(cursor) }));
      } else {
        for (let i = 0; i < numElements; i++) {
          const stream = readPropertyStream(cursor, startOff + sizeHint);
          elements.push(new StructValue(structName, { value: stream.properties, terminated: stream.terminated }));
        }
      }
      return new ArrayValue({ elements, innerTag });
    }

    for (let i = 0; i < numElements; i++) elements.push(readArrayElement(cursor, innerType));
    return new ArrayValue({ elements });
  }

  function writeArrayValue(writer, tag, value) {
    const innerType = tag.innerType.value;
    writer.writeInt32(value.elements.length);
    if (innerType === 'StructProperty') {
      value._arrayInnerTag.write(writer);
      const structName = value._arrayInnerTag.structName.value;
      const handler = STRUCT_HANDLERS[structName];
      for (const e of value.elements) {
        if (handler) handler.write(writer, e.value);
        else writeNestedPropertyStream(writer, e.value);
      }
      return;
    }
    for (const e of value.elements) writeArrayElement(writer, innerType, e);
  }

  function readSetValue(cursor, tag) {
    const innerType = tag.innerType.value;
    const numToRemove = cursor.readInt32();
    const removed = [];
    for (let i = 0; i < numToRemove; i++) removed.push(readArrayElement(cursor, innerType));
    const numElements = cursor.readInt32();
    const elements = [];
    for (let i = 0; i < numElements; i++) elements.push(readArrayElement(cursor, innerType));
    return new SetValue({ removed, elements });
  }

  function writeSetValue(writer, tag, value) {
    const innerType = tag.innerType.value;
    writer.writeInt32(value.removed.length);
    for (const v of value.removed) writeArrayElement(writer, innerType, v);
    writer.writeInt32(value.elements.length);
    for (const v of value.elements) writeArrayElement(writer, innerType, v);
  }

  function readMapValue(cursor, tag) {
    const keyType = tag.innerType.value;
    const valType = tag.valueType.value;
    const numKeysToRemove = cursor.readInt32();
    const removed = [];
    for (let i = 0; i < numKeysToRemove; i++) removed.push(readArrayElement(cursor, keyType));
    const numElements = cursor.readInt32();
    const entries = [];
    for (let i = 0; i < numElements; i++) {
      const key = readArrayElement(cursor, keyType);
      const val = readArrayElement(cursor, valType);
      entries.push({ key, value: val });
    }
    return new MapValue({ removed, entries });
  }

  function writeMapValue(writer, tag, value) {
    const keyType = tag.innerType.value;
    const valType = tag.valueType.value;
    writer.writeInt32(value.removed.length);
    for (const k of value.removed) writeArrayElement(writer, keyType, k);
    writer.writeInt32(value.entries.length);
    for (const e of value.entries) {
      writeArrayElement(writer, keyType, e.key);
      writeArrayElement(writer, valType, e.value);
    }
  }

  // Read/write one array OR set element of a non-struct inner type.
  // (No per-element FPropertyTag wrapper for these inner types.)
  function readArrayElement(cursor, innerType) {
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
      case 'BoolProperty':   return cursor.readUint8() !== 0;
      case 'ByteProperty':   return cursor.readUint8();
      case 'EnumProperty':   return FName.read(cursor);
      case 'NameProperty':   return FName.read(cursor);
      case 'StrProperty':    return cursor.readFString().value;
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'WeakObjectProperty':
      case 'LazyObjectProperty': {
        const kind = cursor.readUint8();
        const path = cursor.readFString().value;
        const classPath = cursor.readFString().value;
        const stream = readPropertyStream(cursor);
        return new ObjectRef({ kind, path, classPath, embedded: stream.properties, terminated: stream.terminated });
      }
      case 'SoftObjectProperty':
      case 'SoftClassProperty':
        return new SoftObjectRef({ assetPath: cursor.readFString().value, subPath: cursor.readFString().value });
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
      case 'NameProperty':   FName.from(value).write(writer); return;
      case 'StrProperty':    writer.writeFString(value); return;
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'WeakObjectProperty':
      case 'LazyObjectProperty':
        if (value instanceof ObjectRef) { value.write(writer, { requireClassPath: true }); return; }
        // Bare-string fallback for array-of-ObjectProperty.
        writer.writeUint8(0x03);
        writer.writeFString(value ?? '');
        writer.writeFString('');
        writeNestedPropertyStream(writer, []);
        return;
      case 'SoftObjectProperty':
      case 'SoftClassProperty':
        (value instanceof SoftObjectRef ? value : new SoftObjectRef(value)).write(writer);
        return;
      default:
        throw new Error(`writeArrayElement: unsupported innerType '${innerType}'`);
    }
  }

  // ==========================================================================
  // Property stream
  // ==========================================================================
  /**
   * Read property tags until either a "None" terminator or `endOffset` is
   * reached. `consumeTerminatorTrailer` is for the outermost stream only.
   */
  function readPropertyStream(cursor, endOffset = Infinity, consumeTerminatorTrailer = false) {
    const properties = [];
    while (cursor.pos() < endOffset && !cursor.eof()) {
      const tag = PropertyTag.read(cursor);
      if (tag.isTerminator) {
        if (consumeTerminatorTrailer && cursor.pos() + 4 <= endOffset && cursor.remaining() >= 4) {
          cursor.skip(4);
        }
        return { properties, terminated: true, endPos: cursor.pos() };
      }
      const valueStart = cursor.pos();
      const value = readValue(cursor, tag, tag.size);
      const valueEnd = cursor.pos();
      const actualSize = valueEnd - valueStart;
      let sizeMismatch = null;
      if (actualSize !== tag.size) {
        // Reader disagreed with the tag's claimed Size. Trust the tag and
        // capture the discrepancy so the encoder can warn.
        sizeMismatch = { expected: tag.size, actual: actualSize };
        cursor.seek(valueStart + tag.size);
      }
      properties.push(new Property(tag, value, { sizeMismatch }));
    }
    return { properties, terminated: false, endPos: cursor.pos() };
  }

  function writePropertyStream(writer, properties, emitTerminatorTrailer = false) {
    for (const p of properties) {
      if (p._sizeMismatch) {
        throw new Error(`writePropertyStream: property '${p.name}' has _sizeMismatch (${JSON.stringify(p._sizeMismatch)}); cannot safely re-emit`);
      }
      p.tag.write(writer);
      writeValue(writer, p.tag, p.value);
    }
    new FName('None').write(writer);
    if (emitTerminatorTrailer) writer.writeInt32(0);
  }

  // Nested-stream wrappers (no terminator trailer). Exposed to values.js via
  // the shared namespace so ObjectRef.write can recurse without a load cycle.
  function writeNestedPropertyStream(writer, properties) {
    writePropertyStream(writer, properties, false);
  }
  SMDB.unreal._writeNestedStream = writeNestedPropertyStream;

  SMDB.unreal.PropertyTag = PropertyTag;
  SMDB.unreal.Property = Property;
  SMDB.unreal.ArrayValue = ArrayValue;
  SMDB.unreal.SetValue = SetValue;
  SMDB.unreal.MapValue = MapValue;
  SMDB.unreal.readPropertyStream = readPropertyStream;
  SMDB.unreal.writePropertyStream = writePropertyStream;
  SMDB.unreal.readValue = readValue;
  SMDB.unreal.writeValue = writeValue;
})();
