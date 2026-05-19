/**
 * Wrapper classes for non-trivial property-value shapes:
 *   ObjectRef       — ObjectProperty / ClassProperty / Weak / Lazy
 *   SoftObjectRef   — SoftObjectProperty / SoftClassProperty
 *   FTextValue      — TextProperty (FText: localized / culture-invariant string)
 *   OpaqueValue     — bytes we don't decode (fallback for unknown/unimplemented)
 *
 * Array/Set/Map values live in properties.mjs because they're tightly
 * coupled to PropertyTag (struct arrays carry an inner tag).
 */

// Circular import: properties.mjs imports ObjectRef/SoftObjectRef/OpaqueValue
// from this module, and ObjectRef.write needs writeNestedPropertyStream
// at call time. ESM live bindings make this safe as long as the binding is
// only USED inside function bodies (deferred), which it is.
import { writeNestedPropertyStream } from './properties.mjs';

/**
 * Soulmask ObjectProperty value layout. Each field is optional — the wire
 * shape is bounded by the property tag's size budget and the reader stops
 * at whichever boundary it hits first:
 *
 *   u8       kind             always present (observed 0x03 at top level; arrays vary)
 *   u32      kindOnePrefix    ONLY when kind === 0x01. Soulmask-specific
 *                             4-byte field sitting between the kind byte
 *                             and pathFS. Observed value is always 1; the
 *                             semantic meaning is unclear (a flag, an
 *                             FName.Number, or a count) — we capture and
 *                             replay it verbatim for byte-identical
 *                             round-trip. Seen on hard actor references
 *                             like NPC `HBindBGCompActor` (the pawn's
 *                             link to its inventory actor).
 *   FString  path             present iff there's budget left after kind
 *                             (and kindOnePrefix, when applicable)
 *   FString  classPath        present iff sizeHint > kind + path length
 *   nested   stream           present iff sizeHint > kind + path + classPath length;
 *                             terminated by None, optionally followed by a 4-byte
 *                             FName.Number trailer for certain Soulmask embeddeds
 *
 * `null` for `path` or `classPath` means the field was NOT on the wire
 * (so the writer skips it). An empty string with the corresponding `isNull`
 * flag preserves the wire distinction between FString null-form (SaveNum=0,
 * 4 bytes) and empty-with-terminator (SaveNum=1, 5 bytes).
 */
export class ObjectRef {
  constructor({
    kind = 0x03,
    kindOnePrefix = null,
    path = null,
    pathIsNull = false,
    classPath = null,
    classPathIsNull = false,
    embedded = null,
    terminated = false,
    hasTerminatorTrailer = false,
  } = {}) {
    this._objectKind = kind;
    // null = "not on the wire" (any kind other than 0x01, or a kind=0x01
    // ObjectRef built programmatically without an explicit prefix).
    // Numeric = capture from the wire; replayed verbatim on write.
    this._kindOnePrefix = kindOnePrefix;
    this.path = path;
    this._pathIsNull = pathIsNull;
    this.classPath = classPath;
    this._classPathIsNull = classPathIsNull;
    this.embedded = embedded;
    this.terminated = terminated;
    // When true, the embedded property stream was followed by a 4-byte
    // FName.Number trailer (the outermost-stream None-trailer convention,
    // applied here by Soulmask to some nested ObjectProperty embeddeds —
    // e.g. JianZhuInstGLQComponent). The reader detects this when exactly
    // 4 trailing bytes remain inside the tag's size budget; the writer
    // replays them so round-trip stays byte-identical.
    this.hasTerminatorTrailer = hasTerminatorTrailer;
  }

  /** When true, this ObjectRef carries an embedded nested property stream. */
  get hasEmbedded() { return Array.isArray(this.embedded); }

  write(writer, { requireClassPath = false } = {}) {
    writer.writeUint8(this._objectKind ?? 0x03);
    // Soulmask kind=0x01 actor reference: replay the captured 4-byte
    // prefix between the kind byte and the path FString. Only emitted
    // when it was on the wire at read time (null otherwise).
    if (this._kindOnePrefix !== null && this._kindOnePrefix !== undefined) {
      writer.writeUint32(this._kindOnePrefix);
    }
    // Kind-only on the wire: path was null AND nothing forces emission.
    if (this.path === null && !requireClassPath && !this.hasEmbedded) return;
    writer.writeFString(this.path ?? '', null, this._pathIsNull);
    // classPath was either on the wire (non-null) or is forced by `requireClassPath`
    // (the array-of-ObjectProperty caller, which always writes all three fields)
    // or by the presence of an embedded stream (the stream can't be reached
    // on the wire without a classPath FString in front of it).
    if (requireClassPath || this.classPath !== null || this.hasEmbedded) {
      writer.writeFString(this.classPath ?? '', null, this._classPathIsNull);
    }
    if (this.hasEmbedded) {
      writeNestedPropertyStream(writer, this.embedded, this.hasTerminatorTrailer);
    }
  }
}

export class SoftObjectRef {
  constructor({ assetPath = '', subPath = '' } = {}) {
    this.assetPath = assetPath;
    this.subPath = subPath;
  }
  write(writer) {
    writer.writeFString(this.assetPath);
    writer.writeFString(this.subPath);
  }
}

/**
 * Decoded FText value (TextProperty).
 *
 * UE4 FText wire format:
 *   uint32  Flags
 *   int8    HistoryType
 *   — HistoryType -1 (None / culture-invariant):
 *       int32   bHasCultureInvariantString
 *       [FString displayString]   (only when bHasCultureInvariantString != 0)
 *   — HistoryType 0 (Base / localized):
 *       FString Namespace
 *       FString Key
 *       FString SourceString
 *   — HistoryType 2 (ArgumentFormat):
 *       FText   SourceFmt        — the format pattern, e.g. "{0} < {1} >"
 *       int32   NumArguments
 *       for each: int8 ContentType + value
 *         0=Int(int64)  1=UInt(uint64)  2=Float(f32)  3=Double(f64)
 *         4=Text(FText) 5=Gender(int8)
 *   — All other types: remaining bytes stored in _raw for verbatim round-trip.
 */
export class FTextValue {
  constructor({
    flags = 0, historyType = -1,
    displayString, displayStringIsNull = false,
    namespace, namespaceIsNull = false,
    key, keyIsNull = false,
    sourceString, sourceStringIsNull = false,
    sourceFmt, arguments: args,
    sourceValue, formatOptions, culture, cultureIsNull = false,
    _raw,
  } = {}) {
    this.flags = flags;
    this.historyType = historyType;
    // Per-field isNull flags preserve the wire's choice between FString
    // null-form (SaveNum=0, 4 B on wire) and empty-with-terminator
    // (SaveNum=1, 5 B). The two forms decode to the same JS string ("")
    // but round-trip-equal encoding requires picking the original form.
    if (historyType === -1) {
      this.displayString = displayString ?? null;
      this._displayStringIsNull = displayStringIsNull;
    } else if (historyType === 0) {
      this.namespace = namespace ?? '';
      this._namespaceIsNull = namespaceIsNull;
      this.key = key ?? '';
      this._keyIsNull = keyIsNull;
      this.sourceString = sourceString ?? null;
      this._sourceStringIsNull = sourceStringIsNull;
    } else if (historyType === 2) {
      this.sourceFmt = sourceFmt ?? null;   // FTextValue (the pattern)
      this.arguments = args ?? [];          // [{type, value}]
    } else if (historyType === 4) {
      this.sourceValue = sourceValue ?? null;  // { type: int8, value: number|string|FTextValue }
      this.formatOptions = formatOptions ?? null; // FNumberFormattingOptions or null
      this.culture = culture ?? null;          // FString value or null
      this._cultureIsNull = cultureIsNull;
    } else {
      this._raw = _raw ?? null;
    }
  }

  /** Best displayable string for this FText, or null if none. */
  get text() {
    if (this.historyType === -1) return this.displayString;
    if (this.historyType === 0) return this.sourceString ?? null;
    if (this.historyType === 2) return this.sourceFmt?.text ?? null;
    if (this.historyType === 4) {
      const v = this.sourceValue?.value;
      return v != null ? String(v) : null;
    }
    return null;
  }
}

/**
 * Holds raw bytes we couldn't (or wouldn't) decode. `reason` is for
 * debugging only; encoding writes the bytes back verbatim.
 *
 * Kept compatible with the old `{ _opaque, _opaqueReason }` shape via
 * matching property names so consumers reading `value._opaque` still work.
 */
export class OpaqueValue {
  constructor(bytes, reason = null) {
    this._opaque = bytes;
    if (reason) this._opaqueReason = reason;
  }
  get bytes()  { return this._opaque; }
  get reason() { return this._opaqueReason ?? null; }
  write(writer) { writer.writeBytes(this._opaque); }
}
