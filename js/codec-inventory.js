'use strict';
/**
 * Inventory-slot decoder for Soulmask "BG actor" blobs (the sibling rows
 * that hold the actual item-slot data for chests/players/animals).
 *
 * Reverse-engineered by repeated diffs in May 2026 (see investigation
 * scripts in repo root). The Python prototype is `decode_inventory.py`;
 * this file is the JS port wired into the UI.
 *
 * Slot record skeleton (per inventory entry):
 *
 *   [SEP] (2 bytes)             item-class name-table index, varies per
 *                               item (e.g. bandage = d3 01, arrow = dd 01,
 *                               wood deck wall = bc 01). Acts as the
 *                               separator within and between slot records.
 *
 *   Count property (omitted on the first slot in the array):
 *     11 1f LOW                 single-byte count. The HIGH byte is
 *                               "carried" from the previous slot's 2-byte
 *                               count, starting at (max_stack >> 8).
 *     11 2f LOW HIGH            u16 LE count. Resets the carry.
 *
 *   [SEP]
 *   Slot index property (also omitted on the first slot, and on slots that
 *   use 3a 1f implicit-max):
 *     15 1f IDX                 paired with 11 1f count
 *     14 1f IDX                 paired with 11 2f count
 *   [SEP]
 *
 *   Per-slot properties (the nested "CunDangShuXingJi" sub-stream:
 *   durability, quality, GUID, Amount, instance-specific state).
 *
 *   [SEP]
 *   Pre-hash sentinel (3 bytes):
 *     7f ff 01 / 80 ff 01 / 80 ff 00 / 2b ff 01
 *   [16-byte item-instance FGuid]
 *   [SEP]                       slot terminator (becomes the leading SEP
 *                               of the next slot — they're shared)
 *
 * 3a 1f variant: a slot whose first tag after [SEP] is `3a 1f IDX` has no
 * count property; the count equals the item's max stack. Used heavily by
 * NPC carry bags.
 *
 * Universal tags (independent of item class):
 *   11 1f = Count (u8 form)
 *   11 2f = Count (u16 LE form, also acts as high-byte transition marker)
 *   15 1f = Slot index (paired with 11 1f)
 *   14 1f = Slot index (paired with 11 2f)
 *   3a 1f = Slot index, no count (implicit max stack)
 */
window.SMDB = window.SMDB || {};

SMDB.codecInventory = (() => {
  const SENTINELS = [
    new Uint8Array([0x7f, 0xff, 0x01]),
    new Uint8Array([0x80, 0xff, 0x01]),
    new Uint8Array([0x80, 0xff, 0x00]),
    new Uint8Array([0x2b, 0xff, 0x01]),
  ];
  const COUNT_TAG_1B    = new Uint8Array([0x11, 0x1f]);
  const COUNT_TAG_2B    = new Uint8Array([0x11, 0x2f]);
  const SLOTIDX_TAG_1B  = new Uint8Array([0x15, 0x1f]);
  const SLOTIDX_TAG_2B  = new Uint8Array([0x14, 0x1f]);
  const SLOTIDX_TAG_IMP = new Uint8Array([0x3a, 0x1f]);

  // Bytewise equality for two-byte (or N-byte) Uint8Array slices.
  function eq2(a, ao, b) {
    return a[ao] === b[0] && a[ao + 1] === b[1];
  }
  function eq3(a, ao, b) {
    return a[ao] === b[0] && a[ao + 1] === b[1] && a[ao + 2] === b[2];
  }

  // Is the 3-byte window at `off` one of the known pre-hash sentinels?
  function isSentinel(buf, off) {
    if (off + 3 > buf.length) return false;
    for (const s of SENTINELS) if (eq3(buf, off, s)) return true;
    return false;
  }

  // Does `buf[off..off+2]` look like a slot-count tag (11 1f / 11 2f / 3a 1f)?
  function isCountOrImplicitTag(buf, off) {
    return eq2(buf, off, COUNT_TAG_1B)
        || eq2(buf, off, COUNT_TAG_2B)
        || eq2(buf, off, SLOTIDX_TAG_IMP);
  }

  // First offset (>= start) of the ASCII pattern "Entries\0" — the
  // Entries array property name. Returns -1 if not found.
  function findEntriesMarker(buf, start = 0) {
    const needle = [0x45, 0x6e, 0x74, 0x72, 0x69, 0x65, 0x73, 0x00];  // "Entries\0"
    outer: for (let i = start; i <= buf.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (buf[i + j] !== needle[j]) continue outer;
      }
      return i + needle.length;
    }
    return -1;
  }

  /**
   * Find slot-record starts (those that BEGIN with an explicit count or
   * implicit-max marker). Each slot starts at `[SEP] [tag]` where SEP is
   * the item-class 2-byte name-table index (last byte = 0x01) and `tag`
   * is one of 11 1f / 11 2f / 3a 1f.
   *
   * Returns an array of { offset, separator: Uint8Array(2) }.
   */
  function findSlotRecords(buf, startOffset = 0) {
    const out = [];
    const n = buf.length;
    let i = startOffset;
    while (i < n - 4) {
      // Plausible separator: any 2 bytes whose second byte is 0x01.
      if (buf[i + 1] === 0x01 && isCountOrImplicitTag(buf, i + 2)) {
        out.push({ offset: i, separator: new Uint8Array([buf[i], buf[i + 1]]) });
      }
      i++;
    }
    return out;
  }

  /**
   * Walk backward from slot 1's start to locate slot 0. Slot 0's trailer
   * ends at `slot1Off` and is `[sentinel 3B][hash 16B][SEP]`. The slot
   * itself starts at the SEP immediately preceding its instance metadata,
   * up to 64 bytes earlier.
   */
  function findFirstSlot(buf, slot1Off, separator) {
    const sentEnd = slot1Off;
    const sentPos = sentEnd - 16 - 3;
    if (sentPos < 0) return -1;
    if (!isSentinel(buf, sentPos)) return -1;
    for (let back = 2; back < 80; back++) {
      const p = sentPos - back;
      if (p < 0) return -1;
      if (eq2(buf, p, separator)) return p;
    }
    return -1;
  }

  // Hex-format helpers (small, no deps).
  function hex2(b) { return b.toString(16).padStart(2, '0'); }
  function bytesHex(u8, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += hex2(u8[off + i]);
    return s;
  }
  function guidString(u8, off) {
    if (off + 16 > u8.length) return '';
    const h = i => hex2(u8[off + i]);
    return `${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`;
  }

  /**
   * Parse a single slot record starting at `start` (which points at the
   * leading [SEP]). Returns { rec, newCurrentHigh, end }.
   */
  function parseSlot(buf, start, separator, currentHigh) {
    let pos = start + 2;  // skip the leading separator
    const rec = {
      start,
      separator: bytesHex(separator, 0, 2),
      separatorBytes: separator,
    };

    if (pos + 2 > buf.length) { rec.error = 'truncated'; rec.end = pos; return { rec, currentHigh, end: pos }; }

    if (eq2(buf, pos, COUNT_TAG_1B)) {
      const low = buf[pos + 2];
      rec.count = currentHigh * 256 + low;
      rec.countForm = '1B';
      rec.countBytes = bytesHex(buf, pos, 3);
      pos += 3;
    } else if (eq2(buf, pos, COUNT_TAG_2B)) {
      const low = buf[pos + 2]; const high = buf[pos + 3];
      rec.count = high * 256 + low;
      rec.countForm = '2B';
      rec.countBytes = bytesHex(buf, pos, 4);
      currentHigh = high;
      pos += 4;
    } else if (eq2(buf, pos, SLOTIDX_TAG_IMP)) {
      rec.count = null;  // caller fills from max_stack
      rec.countForm = 'implicit-max';
      rec.countBytes = '';
      rec.slotIndexTag = '3a1f';
      rec.slotIndex = buf[pos + 2];
      pos += 3;
    } else {
      // First slot — no count or slot-idx markers. The actual count
      // lives in the nested CunDangShuXingJi sub-stream (typically as
      // an "Amount" property). We don't fully parse the sub-stream yet,
      // so the caller fills in max_stack as a placeholder.
      rec.count = null;
      rec.countForm = 'implicit-first';
      rec.countBytes = '';
      rec.slotIndexTag = '(implicit)';
      rec.slotIndex = 0;
    }

    // After an explicit count, parse separator + slot-index tag. The tag's
    // second byte varies (1f / 13 / etc. — different name-table indices
    // for "SlotIndex") so we accept whatever 3-byte chunk we find and
    // read its third byte as the slot-index value.
    if (rec.countForm === '1B' || rec.countForm === '2B') {
      if (pos + 2 <= buf.length && eq2(buf, pos, separator)) pos += 2;
      if (pos + 3 <= buf.length) {
        rec.slotIndexTag = bytesHex(buf, pos, 2);
        rec.slotIndex = buf[pos + 2];
        pos += 3;
      }
    }

    // Optional separator before instance metadata.
    if (pos + 2 <= buf.length && eq2(buf, pos, separator)) pos += 2;

    // Read instance metadata up to (but not including) the pre-hash sentinel.
    const metaStart = pos;
    while (pos < buf.length - 3) {
      if (isSentinel(buf, pos)) break;
      // Don't overshoot into the next slot's [SEP][count-tag] pair.
      if (eq2(buf, pos, separator) && isCountOrImplicitTag(buf, pos + 2)) break;
      pos++;
    }
    rec.instanceMetaStart = metaStart;
    rec.instanceMetaEnd = pos;

    if (pos + 3 <= buf.length && isSentinel(buf, pos)) {
      rec.sentinel = bytesHex(buf, pos, 3);
      pos += 3;
      rec.instanceGuid = guidString(buf, pos);
      pos += 16;
      if (pos + 2 <= buf.length && eq2(buf, pos, separator)) pos += 2;
    }

    rec.end = pos;
    return { rec, currentHigh, end: pos };
  }

  /**
   * Decode the slot array of a BG actor blob.
   *
   * @param {Uint8Array} buf       The full BG-actor blob.
   * @param {object}     opts
   * @param {number}     opts.maxStack  Default max stack size for the
   *                                    item type in slot 0; used to seed
   *                                    the high-byte carry and to fill in
   *                                    counts for implicit slots.
   *                                    Defaults to 300 (bandages); the
   *                                    real value is item-specific.
   * @returns {object} { slots: [...], notes: [...] }
   */
  function decode(buf, opts = {}) {
    const maxStack = Number.isFinite(opts.maxStack) ? opts.maxStack : 300;
    const notes = [];
    const slots = [];

    const arrStart = findEntriesMarker(buf, 0);
    if (arrStart < 0) {
      notes.push('No "Entries" array marker found');
      return { slots, notes };
    }

    const found = findSlotRecords(buf, arrStart);
    if (found.length === 0) {
      notes.push('No slot records found (empty inventory, or non-stackable-only)');
      return { slots, notes };
    }

    // Slot 0: walk back from slot 1 to find its leading [SEP].
    const slot0Off = findFirstSlot(buf, found[0].offset, found[0].separator);
    if (slot0Off >= 0 && !found.some(f => f.offset === slot0Off)) {
      found.unshift({ offset: slot0Off, separator: found[0].separator });
    }

    let currentHigh = maxStack >> 8;
    for (const f of found) {
      const { rec, currentHigh: ch } = parseSlot(buf, f.offset, f.separator, currentHigh);
      currentHigh = ch;
      if (rec.count == null && (rec.countForm === 'implicit-max' || rec.countForm === 'implicit-first')) {
        rec.count = maxStack;
        rec.countIsPlaceholder = true;
      }
      slots.push(rec);
    }
    return { slots, notes };
  }

  /**
   * Heuristic: does this blob look like an inventory-bearing BG actor?
   * Cheap detect — just checks for the literal "Entries\0" marker.
   */
  function detect(buf) {
    return !!buf && findEntriesMarker(buf, 0) >= 0;
  }

  return {
    name: 'inventory',
    detect, decode,
    findEntriesMarker, findSlotRecords, findFirstSlot, parseSlot,
    SENTINELS, COUNT_TAG_1B, COUNT_TAG_2B,
    SLOTIDX_TAG_1B, SLOTIDX_TAG_2B, SLOTIDX_TAG_IMP,
  };
})();
