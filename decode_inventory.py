"""Inventory-slot decoder for Soulmask's BG-actor blobs.

Reverse-engineered slot record structure (per inventory entry):

  [SEP]                           Item-class name-table index (2 bytes), e.g.
                                    bandage = d3 01, arrow = dd 01, wall = bc 01,
                                    hammer  = d3 01. Acts as both the slot
                                    delimiter and the item-class tag.

  Count property (omitted for slot 0):
    11 1f LOW                     u8 count (high byte carried from prev slot's
                                    11 2f, starting at max_stack_high_byte for
                                    slot 0).
    11 2f LO HI                   u16 LE count (also resets running high byte
                                    to HI).
  [SEP]
  Slot index property (omitted for slot 0):
    15 1f IDX                     paired with 11 1f
    14 1f IDX                     paired with 11 2f
  [SEP]
  Other per-slot properties:
    bIsSuoDing / FBool            boolean "is locked"
    [item-specific properties inside CunDangShuXingJi nested stream]
  [SEP]
  Pre-hash sentinel (3 bytes):
    7f ff 01 / 80 ff 01 / 80 ff 00
  16-byte instance FGuid
  [SEP]                           slot terminator

For slot 0, the count comes from a property INSIDE the slot's sub-stream
(typically an `Amount` property visible as `mount\0` due to back-reference
encoding).

Universal tags (independent of item class):
  11 1f  =  Count (u8 form)
  11 2f  =  Count (u16 LE form)
  15 1f  =  Slot index (u8 form, paired with 11 1f count)
  14 1f  =  Slot index (u8 form, paired with 11 2f count)
  3a 1f  =  Slot index, no count (implicit max — seen in shared inventories
            but not in our TestBox tests)
"""
import sqlite3
import sys
from collections import Counter

DB = r'C:\Users\steph\AppData\Local\WS\76561197994085904\2646460\AutoGames\AP0DKUMNGGVM2JNU9UDDDZJ52\world_mannual_2.db'

SENTINELS = (b'\x7f\xff\x01', b'\x80\xff\x01', b'\x80\xff\x00', b'\x2b\xff\x01')
COUNT_TAG_1B = b'\x11\x1f'
COUNT_TAG_2B = b'\x11\x2f'
SLOTIDX_TAG_1B = b'\x15\x1f'
SLOTIDX_TAG_2B = b'\x14\x1f'
SLOTIDX_TAG_IMPLICIT = b'\x3a\x1f'


def find_array_start(blob):
    """Locate the `Entries` array body. Returns offset just past the
    `[None]` terminator that signals the end of the array header / start of
    the actual slot records (which follow at the next non-array property)."""
    # The literal "Entries" FName has length 7, encoded as: 07 00 00 00 'Entries' 00.
    # But it's typically preceded by a back-ref name table entry. Find the
    # ASCII string "Entries" and scan forward to the FIRST slot start.
    p = blob.find(b'Entries\x00')
    if p < 0:
        return None
    # After "Entries\0" comes the ArrayProperty marker and a length-prefixed
    # array payload. The first slot record begins after a `JNone\x00\x0d\x00\x0f`
    # sequence (the "None" array terminator + 3 bytes of post-marker padding)
    # OR after some other delimiter. The most reliable next-anchor is the first
    # candidate slot separator (XX YY pattern repeating).
    return p + len(b'Entries\x00')


def detect_separator(blob, start, end):
    """Find the slot-record separator within a given window. The separator
    is the 2-byte pattern `XX YY` that repeats most often within a slot.
    Common values: d3 01 (bandage/hammer), dd 01 (arrow), bc 01 (wall)."""
    candidates = Counter()
    i = start
    while i < end - 1:
        # Only consider plausible separator patterns: second byte = 01 (typical
        # name-table-index high byte for inventory items), first byte high bit
        # might or might not be set.
        if blob[i+1] == 0x01:
            candidates[blob[i:i+2]] += 1
        i += 1
    if not candidates:
        return None
    sep, _ = candidates.most_common(1)[0]
    return sep


def find_slot_records(blob, separator=None, start_offset=0):
    """Find slot-record starts. A slot begins at `[XX YY] [11 1f|11 2f|3a 1f]`,
    where `XX YY` is the item-class separator (variable per item). Returns a
    list of (offset, separator_bytes) tuples sorted by offset.

    If `separator` is given, only matches that one. Otherwise, accepts any
    2-byte pattern whose second byte is `01` (the common high-byte for
    inventory item-class name-table indices)."""
    found = []
    n = len(blob)
    i = max(0, start_offset)
    while i < n - 4:
        b1, b2 = blob[i], blob[i+1]
        sep_ok = (separator is not None and bytes([b1, b2]) == separator) or \
                 (separator is None and b2 == 0x01)
        if sep_ok and blob[i+2:i+4] in (COUNT_TAG_1B, COUNT_TAG_2B, SLOTIDX_TAG_IMPLICIT):
            found.append((i, bytes([b1, b2])))
        i += 1
    return found


def find_first_slot(blob, slot1_start, separator):
    """Walk backward from slot 1 to locate slot 0. Slot 0's trailer ends at
    slot1_start (it shares the `[separator]` byte with slot 1's preamble).
    The trailer is `[sentinel][16-byte FGuid][separator]`."""
    sent_end = slot1_start
    sent_pos = sent_end - 16 - 3
    if sent_pos < 0:
        return None
    if blob[sent_pos:sent_pos+3] not in SENTINELS:
        return None
    # Walk back to find slot 0's leading separator.
    for back in range(2, 100):
        p = sent_pos - back
        if p < 0:
            return None
        if blob[p:p+2] == separator:
            return p
    return None


def parse_slot(blob, start, separator, current_high):
    """Parse a slot starting at `start` (points at the leading separator).
    Returns (rec, new_current_high, end_offset)."""
    pos = start + 2  # skip leading separator
    rec = {'start': start, 'separator': separator.hex()}

    tag = blob[pos:pos+2]
    if tag == COUNT_TAG_1B:
        low = blob[pos+2]
        rec['count'] = current_high * 256 + low
        rec['count_form'] = '1B'
        rec['count_bytes'] = blob[pos:pos+3].hex()
        pos += 3
    elif tag == COUNT_TAG_2B:
        low = blob[pos+2]; high = blob[pos+3]
        rec['count'] = high * 256 + low
        rec['count_form'] = '2B'
        rec['count_bytes'] = blob[pos:pos+4].hex()
        current_high = high
        pos += 4
    elif tag == SLOTIDX_TAG_IMPLICIT:
        rec['count'] = None
        rec['count_form'] = '3a1f-implicit'
        rec['slot_index_tag'] = '3a1f'
        rec['slot_index'] = blob[pos+2]
        pos += 3
    else:
        # Slot 0 — no count or slot-idx in the record. Count lives in the
        # nested sub-stream (look for `mount` / Amount property inside).
        rec['count'] = None
        rec['count_form'] = 'implicit-first'
        rec['count_bytes'] = ''
        rec['slot_index_tag'] = '(implicit)'
        rec['slot_index'] = 0

    # If we had an explicit count tag, parse separator + slot-index next.
    if rec['count_form'] in ('1B', '2B'):
        if blob[pos:pos+2] == separator:
            pos += 2
        slot_tag = blob[pos:pos+2]
        if slot_tag in (SLOTIDX_TAG_1B, SLOTIDX_TAG_2B):
            rec['slot_index_tag'] = slot_tag.hex()
            rec['slot_index'] = blob[pos+2]
            pos += 3

    if blob[pos:pos+2] == separator:
        pos += 2

    # Read instance metadata up to the pre-hash sentinel.
    meta_start = pos
    while pos < len(blob) - 3:
        if blob[pos:pos+3] in SENTINELS:
            break
        # Don't overshoot into next slot
        if blob[pos:pos+2] == separator and blob[pos+2:pos+4] in (
                COUNT_TAG_1B, COUNT_TAG_2B, SLOTIDX_TAG_IMPLICIT):
            break
        pos += 1
    rec['instance_meta'] = blob[meta_start:pos]
    rec['instance_meta_ascii'] = ''.join(chr(b) if 32 <= b < 127 else '.' for b in rec['instance_meta'])

    if pos < len(blob) - 3 and blob[pos:pos+3] in SENTINELS:
        rec['sentinel'] = blob[pos:pos+3].hex()
        pos += 3
        rec['instance_guid'] = blob[pos:pos+16].hex()
        pos += 16
        if blob[pos:pos+2] == separator:
            pos += 2

    rec['end'] = pos
    return rec, current_high, pos


def decode_inventory(blob, max_stack=300, dump=True):
    """Decode the slot array. `max_stack` is used to seed the high-byte
    carry. Slots may have different per-class separators within the same
    inventory; each slot's separator is detected from its own record."""
    arr_start = find_array_start(blob)
    if arr_start is None:
        return []

    found = find_slot_records(blob, start_offset=arr_start)
    if not found:
        return []

    # Try to locate slot 0 by walking back from slot 1.
    first_off = found[0][0]
    first_sep = found[0][1]
    slot0_off = find_first_slot(blob, first_off, first_sep)
    if slot0_off is not None and not any(s[0] == slot0_off for s in found):
        found.insert(0, (slot0_off, first_sep))

    if dump:
        print(f'Slot starts: {[(hex(o), s.hex()) for (o, s) in found]}')

    max_high = max_stack >> 8
    current_high = max_high
    slots = []
    for off, sep in found:
        rec, current_high, _ = parse_slot(blob, off, sep, current_high)
        if rec['count'] is None and rec['count_form'] in ('3a1f-implicit', 'implicit-first'):
            rec['count'] = max_stack  # placeholder — real value needs sub-stream parsing
            rec['count_note'] = '(implicit; max_stack placeholder)'
        slots.append(rec)
    return slots


def main():
    serial = int(sys.argv[1]) if len(sys.argv) > 1 else 39159
    max_stack = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    blob = sqlite3.connect(DB).execute(
        'SELECT actor_data FROM actor_table WHERE actor_serial = ?', (serial,)
    ).fetchone()[0]
    print(f'Decoding inventory for actor_serial={serial}, max_stack={max_stack}  ({len(blob)}B)')

    slots = decode_inventory(blob, max_stack=max_stack)
    if not slots:
        print('No slots found.')
        return

    print()
    print(f'{"slot":>4} {"idx_tag":>10} {"form":>16} {"count":>5}  sep   count_bytes  meta_ascii')
    print('-' * 95)
    for i, s in enumerate(slots):
        cnt = str(s.get('count', '?'))
        if 'count_note' in s:
            cnt += ' ?'
        print(f'  {i:2d} {s.get("slot_index_tag","-"):>10} {s["count_form"]:>16} {cnt:>5}  '
              f'{s["separator"]}  {s.get("count_bytes",""):8s}     {s["instance_meta_ascii"][:32]!r}')


if __name__ == '__main__':
    main()
