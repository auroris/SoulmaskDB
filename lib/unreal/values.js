'use strict';
/**
 * Wrapper classes for non-trivial property-value shapes:
 *   ObjectRef       — ObjectProperty / ClassProperty / Weak / Lazy
 *   SoftObjectRef   — SoftObjectProperty / SoftClassProperty
 *   OpaqueValue     — bytes we don't decode (e.g. TextProperty, fallback)
 *
 * Array/Set/Map values live in properties.js because they're tightly
 * coupled to PropertyTag (struct arrays carry an inner tag).
 */
window.SMDB = window.SMDB || {};
SMDB.unreal = SMDB.unreal || {};

(() => {
  /**
   * Soulmask ObjectProperty value layout:
   *   u8       kind          (observed always 0x03 in top-level; arrays vary)
   *   FString  path          (full object path incl. instance ID)
   *   FString  classPath     (optional — e.g. "/Script/WS.HBaoGuoComponent")
   *   embedded property stream (optional, self-terminated by "None")
   */
  class ObjectRef {
    constructor({ kind = 0x03, path = '', classPath = null, embedded = null, terminated = false } = {}) {
      this._objectKind = kind;
      this.path = path;
      this.classPath = classPath;
      this.embedded = embedded;
      this.terminated = terminated;
    }

    /** When true, this ObjectRef carries an embedded nested property stream. */
    get hasEmbedded() { return Array.isArray(this.embedded); }

    write(writer, { requireClassPath = false } = {}) {
      writer.writeUint8(this._objectKind ?? 0x03);
      writer.writeFString(this.path);
      if (requireClassPath || this.classPath != null || this.hasEmbedded) {
        writer.writeFString(this.classPath ?? '');
      }
      if (this.hasEmbedded) {
        SMDB.unreal._writeNestedStream(writer, this.embedded);
      }
    }
  }

  class SoftObjectRef {
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
   * Holds raw bytes we couldn't (or wouldn't) decode. `reason` is for
   * debugging only; encoding writes the bytes back verbatim.
   *
   * Kept compatible with the old `{ _opaque, _opaqueReason }` shape via
   * matching property names so consumers reading `value._opaque` still work.
   */
  class OpaqueValue {
    constructor(bytes, reason = null) {
      this._opaque = bytes;
      if (reason) this._opaqueReason = reason;
    }
    get bytes()  { return this._opaque; }
    get reason() { return this._opaqueReason ?? null; }
    write(writer) { writer.writeBytes(this._opaque); }
  }

  SMDB.unreal.ObjectRef = ObjectRef;
  SMDB.unreal.SoftObjectRef = SoftObjectRef;
  SMDB.unreal.OpaqueValue = OpaqueValue;
})();
