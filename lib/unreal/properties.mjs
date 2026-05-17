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

import { FName, FGuid }                                       from './primitives.mjs';
import { StructValue, STRUCT_HANDLERS }                       from './structs.mjs';
import { ObjectRef, SoftObjectRef, FTextValue, OpaqueValue }  from './values.mjs';

// ==========================================================================
// PropertyTag — the header preceding each property's value bytes.
// ==========================================================================
export class PropertyTag {
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
export class ArrayValue {
  constructor({ elements = [], innerTag = null } = {}) {
    this.elements = elements;
    this._arrayInnerTag = innerTag;
  }
}

export class SetValue {
  constructor({ removed = [], elements = [] } = {}) {
    this.removed = removed;
    this.elements = elements;
  }
}

export class MapValue {
  constructor({ removed = [], entries = [] } = {}) {
    this.removed = removed;
    this.entries = entries;
  }
}

// ==========================================================================
// Property — one tag + its decoded value.
// ==========================================================================
export class Property {
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
export function readValue(cursor, tag, sizeHint) {
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
    case 'WSObjectProperty':           // Soulmask-specific alias (per BLOB_FORMAT.md)
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
      return readFText(cursor, sizeHint);
    case 'MulticastDelegateProperty':
    case 'MulticastInlineDelegateProperty':
    case 'MulticastSparseDelegateProperty':
    case 'DelegateProperty':
      // Wire format (per UE source):
      //   [int32 NumDelegates]
      //   For each: [UObject ref] [FName FunctionName]
      // The UObject-ref encoding inside a delegate is archive-dependent and
      // we don't have ground-truth Soulmask data to verify it. Preserve the
      // bytes verbatim so round-trip via OpaqueValue stays byte-identical;
      // a structured decoder can be slotted in later when we see real data.
      return new OpaqueValue(cursor.readBytes(sizeHint).slice(), `${t} (recognized; structured decode not yet implemented)`);
    default:
      return new OpaqueValue(cursor.readBytes(sizeHint).slice(), `Unknown property type ${t}`);
  }
}

export function writeValue(writer, tag, value) {
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
    case 'WSObjectProperty':
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
      if (value instanceof FTextValue) { writeFText(writer, value); return; }
      if (value instanceof OpaqueValue) { value.write(writer); return; }
      throw new Error('writeValue: TextProperty: expected FTextValue or OpaqueValue');
    default:
      if (value instanceof OpaqueValue) { value.write(writer); return; }
      throw new Error(`writeValue: no encoder for type ${t}`);
  }
}

// -------- TextProperty (FText) --------
function readFText(cursor, sizeHint) {
  const start = cursor.pos();
  try {
    const flags = cursor.readUint32();
    const historyType = cursor.readInt8();
    if (historyType === -1) {
      // None / culture-invariant: optional display string
      const bHas = cursor.readInt32();
      const displayString = bHas ? cursor.readFString().value : null;
      return new FTextValue({ flags, historyType: -1, displayString });
    }
    if (historyType === 0) {
      // Base / localized: namespace + key + source string
      const namespace    = cursor.readFString().value;
      const key          = cursor.readFString().value;
      const sourceString = cursor.readFString().value;
      return new FTextValue({ flags, historyType: 0, namespace, key, sourceString });
    }
    // Unknown history type: preserve remaining bytes verbatim for round-trip
    const remaining = sizeHint - (cursor.pos() - start);
    const raw = remaining > 0 ? cursor.readBytes(remaining).slice() : new Uint8Array(0);
    return new FTextValue({ flags, historyType, _raw: raw });
  } catch (e) {
    cursor.seek(start);
    return new OpaqueValue(cursor.readBytes(sizeHint).slice(), `TextProperty decode failed: ${e.message}`);
  }
}

function writeFText(writer, value) {
  writer.writeUint32(value.flags);
  writer.writeInt8(value.historyType);
  if (value.historyType === -1) {
    const has = value.displayString != null ? 1 : 0;
    writer.writeInt32(has);
    if (has) writer.writeFString(value.displayString);
  } else if (value.historyType === 0) {
    writer.writeFString(value.namespace ?? '');
    writer.writeFString(value.key ?? '');
    writer.writeFString(value.sourceString ?? null);
  } else {
    if (value._raw) writer.writeBytes(value._raw);
  }
}

// -------- ObjectProperty (top-level shape) --------
function readObjectValue(cursor, sizeHint) {
  const start = cursor.pos();
  try {
    const kind = cursor.readUint8();
    // sizeHint=1 → value is just the kind byte (null/bare reference).
    if (cursor.pos() - start >= sizeHint) {
      return new ObjectRef({ kind });
    }
    const path = cursor.readFString().value;
    // Guard against path FStrings whose SaveNum overshoots the value budget —
    // this happens for properties whose format differs from kind+path+... and
    // whose first "path" bytes happen to encode a huge length.
    if (cursor.pos() - start > sizeHint) throw new Error('path FString exceeded value budget');
    if (cursor.pos() - start >= sizeHint) {
      return new ObjectRef({ kind, path });
    }
    const classPath = cursor.readFString().value;
    if (cursor.pos() - start > sizeHint) throw new Error('classPath FString exceeded value budget');
    if (cursor.pos() - start >= sizeHint) {
      return new ObjectRef({ kind, path, classPath });
    }
    const stream = readPropertyStream(cursor, start + sizeHint);
    // Some Soulmask embedded streams (e.g. JianZhuInstGLQComponent) use the
    // outermost-stream None trailer (4-byte FName.Number). Skip it when
    // exactly 4 bytes remain within the tag's size budget.
    if (stream.terminated && cursor.pos() + 4 === start + sizeHint && cursor.remaining() >= 4) {
      cursor.skip(4);
    }
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
  for (let i = 0; i < numKeysToRemove; i++) removed.push(readMapElement(cursor, keyType, /*isKey=*/true));
  const numElements = cursor.readInt32();
  const entries = [];
  for (let i = 0; i < numElements; i++) {
    const key = readMapElement(cursor, keyType, /*isKey=*/true);
    const val = readMapElement(cursor, valType, /*isKey=*/false);
    entries.push({ key, value: val });
  }
  return new MapValue({ removed, entries });
}

function writeMapValue(writer, tag, value) {
  const keyType = tag.innerType.value;
  const valType = tag.valueType.value;
  writer.writeInt32(value.removed.length);
  for (const k of value.removed) writeMapElement(writer, keyType, k, /*isKey=*/true);
  writer.writeInt32(value.entries.length);
  for (const e of value.entries) {
    writeMapElement(writer, keyType, e.key, /*isKey=*/true);
    writeMapElement(writer, valType, e.value, /*isKey=*/false);
  }
}

/**
 * Map element (one key or one value) when the map's inner/value type is
 * StructProperty — Soulmask uses several conventions that diverge from
 * stock UE 4.27 here:
 *
 *   Key  (StructProperty)  → a raw 16-byte FGuid. The map tag declares
 *                            no struct shape; every populated Map<Struct,_>
 *                            we've observed in world.db (the guild
 *                            manager maps in GAMEMODE) uses guids as
 *                            keys. Other key shapes would need this
 *                            assumption revisited.
 *   Value (StructProperty) → EITHER a nested property stream
 *                            (`GongHuiMap`, `PlayerGongHuiDataMap`,
 *                            `GeRenJianZhuYingHuoList`, `GeRenMapRiZhi`)
 *                            OR a raw 16-byte FGuid (`PlayerGongHuiMap`,
 *                            a player→guild membership lookup).
 *                            We sniff which by peeking ahead — a
 *                            property stream starts with an FString
 *                            length prefix for the first tag's name
 *                            (small positive int, body is identifier
 *                            chars + NUL); a Guid's first 4 bytes
 *                            are arbitrary hex and almost never satisfy
 *                            that pattern.
 *
 * For non-struct inner/value types we delegate to readArrayElement /
 * writeArrayElement (array and set elements share the same wire shape
 * as map keys/values for those types).
 *
 * Note: for these custom Soulmask maps the MapProperty's tag.size does
 * NOT match the actual byte span of the data section (observed:
 * tag.size=632838, actual=636422 for a populated GongHuiMap). The
 * decoder advances the cursor based on pair count + per-pair shape,
 * NOT the tag.size — which is why this works despite the size lie.
 */
function readMapElement(cursor, type, isKey) {
  if (type !== 'StructProperty') return readArrayElement(cursor, type);
  if (isKey) return FGuid.read(cursor).value;
  if (peekLooksLikePropertyTag(cursor)) {
    const stream = readPropertyStream(cursor);
    return new StructValue('(map value)', { value: stream.properties, terminated: stream.terminated });
  }
  return FGuid.read(cursor).value;
}

function writeMapElement(writer, type, value, isKey) {
  if (type !== 'StructProperty') { writeArrayElement(writer, type, value); return; }
  if (isKey) { new FGuid(value).write(writer); return; }
  // Distinguish on the decoded value's shape:
  //   StructValue → property stream (write tags + None)
  //   string      → 16-byte Guid
  if (value instanceof StructValue && Array.isArray(value.value)) {
    writePropertyStream(writer, value.value, false);
    return;
  }
  if (typeof value === 'string') {
    new FGuid(value).write(writer);
    return;
  }
  throw new Error('writeMapElement: unexpected StructProperty map value shape');
}

/**
 * Peek the next bytes of `cursor` (without advancing): do they look like
 * the start of a PropertyTag — i.e. an FString that names a property?
 *
 * A property name FString is:
 *   - int32 SaveNum > 0 and reasonably small (<= 64 chars in Soulmask)
 *   - SaveNum bytes of ANSI body whose last byte is NUL
 *   - body chars (minus NUL) are identifier-safe: A-Z, a-z, 0-9, _.
 *
 * Random GUID bytes effectively never satisfy this — the first uint32
 * of a Guid is ~uniform over [0..2^32), and even when it lands in a
 * "plausible length" range the printable-ASCII + NUL-terminator check
 * eliminates the false positives.
 */
function peekLooksLikePropertyTag(cursor) {
  if (cursor.remaining() < 8) return false;
  const off = cursor.pos();
  const len = cursor.dv.getInt32(off, true);
  if (len <= 1 || len > 64) return false;
  if (cursor.remaining() < 4 + len) return false;
  if (cursor.bytes[off + 4 + len - 1] !== 0) return false;   // NUL terminator
  for (let i = 0; i < len - 1; i++) {
    const b = cursor.bytes[off + 4 + i];
    const ok = b === 0x5F                          // _
            || (b >= 0x30 && b <= 0x39)             // 0-9
            || (b >= 0x41 && b <= 0x5A)             // A-Z
            || (b >= 0x61 && b <= 0x7A);            // a-z
    if (!ok) return false;
  }
  return true;
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
    case 'LazyObjectProperty':
    case 'WSObjectProperty': {
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
    case 'WSObjectProperty':
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
export function readPropertyStream(cursor, endOffset = Infinity, consumeTerminatorTrailer = false) {
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

export function writePropertyStream(writer, properties, emitTerminatorTrailer = false) {
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

// Nested-stream wrapper (no terminator trailer). Imported by values.mjs
// (ObjectRef.write) to avoid needing a writePropertyStream re-export.
export function writeNestedPropertyStream(writer, properties) {
  writePropertyStream(writer, properties, false);
}
