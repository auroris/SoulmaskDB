"""Stare at one specific property end-to-end. The BaoGuoComponent
ObjectProperty in a chest BG actor — its value is a known object path,
so we can compare the encoded bytes to the decoded string and figure
out the back-ref scheme."""
import sqlite3
import os
import sys

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'world.db')


def hexrun(blob, start, end):
    out = []
    for i in range(start, end, 16):
        chunk = blob[i:min(i + 16, end)]
        hp = ' '.join(f'{b:02x}' for b in chunk)
        ap = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        out.append(f'  {i:06x}  {hp:<48}  |{ap}|')
    return '\n'.join(out)


def main():
    serial = int(sys.argv[1]) if len(sys.argv) > 1 else 22637
    conn = sqlite3.connect(DB)
    blob = conn.execute(
        "SELECT actor_data FROM actor_table WHERE actor_serial = ?", (serial,)
    ).fetchone()[0]

    print(f'serial={serial} size={len(blob):,}B')
    print(f'first 400 bytes:\n{hexrun(blob, 0, 400)}')
    print()

    # We expect the ObjectProperty path to start at body offset (after the
    # Name + Type FStrings). For a BG-actor row:
    #   0x0e:  [u32 16] BaoGuoComponent\0   (4 + 16 = 20 bytes, ends at 0x22)
    #   0x22:  [u32 15] ObjectProperty\0    (4 + 15 = 19 bytes, ends at 0x35)
    #   then some PropertyTag bytes...
    #   then the value FString (length-prefixed): [u32 length][bytes][\0]

    # Find the next u32 that looks like a plausible length (large enough
    # to hold an object path).
    print('scanning offsets 0x35..0x60 for a plausible length prefix:')
    import struct
    for off in range(0x30, 0x60):
        if off + 4 > len(blob):
            break
        L = struct.unpack_from('<I', blob, off)[0]
        if 50 < L < 500:
            print(f'  @0x{off:x}: u32={L}  -> if length, content at 0x{off+4:x}..0x{off+4+L:x}')
            # Show some content
            print(f'    starts with: {blob[off+4:off+4+30]!r}')

    # We know from earlier exploration that the path starts at 0x41 with
    # length 0x8e = 142 (length prefix at 0x3d).
    # Verify and inspect:
    LENGTH_OFF = 0x3d
    L = struct.unpack_from('<I', blob, LENGTH_OFF)[0]
    print(f'\nat 0x{LENGTH_OFF:x}: length prefix u32 = {L} (0x{L:x})')
    print(f'so the encoded value spans 0x{LENGTH_OFF+4:x} .. 0x{LENGTH_OFF+4+L:x}')

    # Dump that span with annotation:
    print(f'\nFull hex of the encoded ObjectProperty value:')
    start = LENGTH_OFF + 4
    end = LENGTH_OFF + 4 + L
    print(hexrun(blob, start, end))

    # ASCII-only view: show only printable bytes, replace others with dots
    raw = blob[start:end]
    print(f'\nASCII-only view ({len(raw)} bytes):')
    print(''.join(chr(b) if 32 <= b < 127 else '.' for b in raw))

    # Try to identify "stretches of ASCII" + "interludes" pattern
    print('\nStructural breakdown:')
    i = 0
    while i < len(raw):
        # Read ASCII run
        if 32 <= raw[i] < 127:
            j = i
            while j < len(raw) and 32 <= raw[j] < 127:
                j += 1
            print(f'  ASCII @ {i:3d}..{j:3d}  ({j-i:2d} chars):  {raw[i:j].decode("ascii")!r}')
            i = j
        else:
            j = i
            while j < len(raw) and not (32 <= raw[j] < 127):
                j += 1
            interlude = raw[i:j]
            hex_str = ' '.join(f'{b:02x}' for b in interlude)
            print(f'  NON-ASCII @ {i:3d}..{j:3d} ({j-i:2d} bytes):  [{hex_str}]')
            i = j


if __name__ == '__main__':
    main()
