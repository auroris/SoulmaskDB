'use strict';
/**
 * FName and FGuid.
 *
 * In this Soulmask format FName is serialized as a plain FString (no
 * trailing FName.Number int32). The `number` field stays 0 and exists
 * only for symmetry with full UE FNames.
 */
window.SMDB = window.SMDB || {};
SMDB.unreal = SMDB.unreal || {};

(() => {
  class FName {
    constructor(value, { isUnicode = false, number = 0 } = {}) {
      this.value = value;
      this.isUnicode = isUnicode;
      this.number = number;
    }
    toString() { return this.value; }

    static read(cursor) {
      const s = cursor.readFString();
      return new FName(s.value, { isUnicode: s.isUnicode });
    }

    write(writer) { writer.writeFString(this.value, this.isUnicode); }

    /** Accepts an FName, a bare string, or a plain {value,isUnicode} record. */
    static from(x) {
      if (x instanceof FName) return x;
      if (typeof x === 'string') return new FName(x);
      if (x && typeof x === 'object') return new FName(x.value, { isUnicode: !!x.isUnicode, number: x.number || 0 });
      throw new Error('FName.from: unsupported value ' + typeof x);
    }
  }

  class FGuid {
    /** Stored as the canonical 8-4-4-4-12 hex string (uppercase). */
    constructor(value) { this.value = value; }
    toString() { return this.value; }

    static read(cursor) {
      const A = cursor.readUint32(), B = cursor.readUint32(), C = cursor.readUint32(), D = cursor.readUint32();
      const h = (n, w) => n.toString(16).padStart(w, '0').toUpperCase();
      return new FGuid(`${h(A, 8)}-${h(B >>> 16, 4)}-${h(B & 0xFFFF, 4)}-${h(C >>> 16, 4)}-${h(C & 0xFFFF, 4)}${h(D, 8)}`);
    }

    write(writer) {
      const m = String(this.value).match(/^([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})([0-9A-Fa-f]{8})$/);
      if (!m) throw new Error(`FGuid.write: invalid FGuid string '${this.value}'`);
      const A = parseInt(m[1], 16);
      const B = (parseInt(m[2], 16) << 16) | parseInt(m[3], 16);
      const C = (parseInt(m[4], 16) << 16) | parseInt(m[5], 16);
      const D = parseInt(m[6], 16);
      writer.writeUint32(A); writer.writeUint32(B); writer.writeUint32(C); writer.writeUint32(D);
    }

    static from(x) {
      if (x instanceof FGuid) return x;
      if (typeof x === 'string') return new FGuid(x);
      throw new Error('FGuid.from: unsupported value ' + typeof x);
    }
  }

  SMDB.unreal.FName = FName;
  SMDB.unreal.FGuid = FGuid;
})();
