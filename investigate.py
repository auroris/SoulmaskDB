"""Dump 32 bytes of context after each "TypeName\\0" occurrence, plus a
look at the bytes leading up to the next plausible FString length prefix
(a small u32 that points at printable ASCII)."""
import sqlite3, struct, collections

con = sqlite3.connect('world.db')
cur = con.cursor()

TYPES = ['ObjectProperty', 'StructProperty', 'IntProperty', 'FloatProperty',
         'BoolProperty', 'NameProperty', 'ArrayProperty', 'MapProperty',
         'StrProperty', 'ByteProperty']

def find_after(blob, type_name):
    needle = struct.pack('<I', len(type_name) + 1) + type_name.encode('ascii') + b'\x00'
    offs = []
    start = 0
    while True:
        i = blob.find(needle, start)
        if i < 0: break
        offs.append(i + len(needle))
        start = i + 1
    return offs

def find_next_fstring_start(blob, after, max_search=48):
    """After offset `after`, find the byte position where a plausible
    [u32 small length][printable ASCII] pattern starts. Returns (rel_pos, length, text_preview)."""
    end = min(len(blob) - 4, after + max_search)
    for i in range(after, end):
        L = struct.unpack_from('<I', blob, i)[0]
        if 1 <= L <= 256 and i + 4 + L <= len(blob):
            s = blob[i+4 : i+4+L]
            if s.endswith(b'\x00') and all(32 <= b < 127 for b in s[:-1]):
                return i - after, L, s[:-1].decode('ascii', errors='replace')
    return None, None, None

cur.execute('''SELECT actor_serial, actor_data FROM actor_table
               WHERE actor_data IS NOT NULL AND length(actor_data) > 100
               ORDER BY length(actor_data) DESC LIMIT 30''')
rows = cur.fetchall()

for t in TYPES:
    print(f'\n==================== {t} ====================')
    seen = 0
    for serial, blob in rows:
        for after in find_after(blob, t):
            if seen >= 6: break
            ctx = blob[after : after+32]
            rel, L, prev = find_next_fstring_start(blob, after, 48)
            hex_ctx = ' '.join(f'{b:02x}' for b in ctx)
            print(f'  #{serial}  after+32: {hex_ctx}')
            if rel is not None:
                print(f'      next FString @+{rel}  len={L:3d}  "{prev[:40]}"')
            seen += 1
        if seen >= 6: break
