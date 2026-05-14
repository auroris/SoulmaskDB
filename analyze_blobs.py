"""One-off: decode the two actor_data_b64 blobs from soulmaskdb stash JSON
exports and figure out where they differ. Writes a few report files.

Usage:
  python analyze_blobs.py A.json B.json out_dir/
"""
import base64
import json
import struct
import sys
from pathlib import Path


def load_stash(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    entry = data['entries'][0]
    blob = base64.b64decode(entry['row']['actor_data_b64'])
    return entry, blob


# -----------------------------------------------------------------
# UE FArchive primitives — mirror codec-unreal-properties.js
# -----------------------------------------------------------------
class Cursor:
    def __init__(self, buf, off=0):
        self.buf = buf
        self.off = off

    def remaining(self):
        return len(self.buf) - self.off

    def peek(self, n):
        return self.buf[self.off:self.off + n]

    def read(self, n):
        if self.off + n > len(self.buf):
            raise EOFError(f'read {n} @ {self.off}: only {self.remaining()} left')
        out = self.buf[self.off:self.off + n]
        self.off += n
        return out

    def read_u8(self):  return struct.unpack_from('<B', self.read(1))[0]
    def read_i8(self):  return struct.unpack_from('<b', self.read(1))[0]
    def read_u16(self): return struct.unpack_from('<H', self.read(2))[0]
    def read_i16(self): return struct.unpack_from('<h', self.read(2))[0]
    def read_u32(self): return struct.unpack_from('<I', self.read(4))[0]
    def read_i32(self): return struct.unpack_from('<i', self.read(4))[0]
    def read_u64(self): return struct.unpack_from('<Q', self.read(8))[0]
    def read_i64(self): return struct.unpack_from('<q', self.read(8))[0]
    def read_f32(self): return struct.unpack_from('<f', self.read(4))[0]
    def read_f64(self): return struct.unpack_from('<d', self.read(8))[0]

    def read_fstring(self):
        n = self.read_i32()
        if n == 0:
            return ''
        if n > 0:
            data = self.read(n)
            return data[:-1].decode('ascii', errors='replace')
        n = -n
        data = self.read(n * 2)
        return data[:-2].decode('utf-16-le', errors='replace')

    def read_fname(self):
        s = self.read_fstring()
        num = self.read_i32()
        return (s, num)

    def read_fguid(self):
        a = self.read_u32(); b = self.read_u32(); c = self.read_u32(); d = self.read_u32()
        return f'{a:08X}-{(b>>16)&0xFFFF:04X}-{b&0xFFFF:04X}-{(c>>16)&0xFFFF:04X}-{c&0xFFFF:04X}{d:08X}'


# -----------------------------------------------------------------
# Property tag walk
# -----------------------------------------------------------------
def read_property_tag(cur):
    start = cur.off
    name, num = cur.read_fname()
    if name == 'None':
        return {'name': name, 'num': num, 'terminator': True, 'start': start}

    type_name, _ = cur.read_fname()
    size = cur.read_i32()
    array_index = cur.read_i32()
    tag = {
        'name': name, 'num': num, 'type': type_name, 'size': size,
        'array_index': array_index, 'terminator': False, 'start': start,
    }
    if type_name == 'StructProperty':
        tag['struct_name'], _ = cur.read_fname()
        tag['struct_guid'] = cur.read_fguid()
    elif type_name == 'BoolProperty':
        tag['bool_val'] = cur.read_u8()
    elif type_name in ('ByteProperty', 'EnumProperty', 'ArrayProperty', 'SetProperty'):
        tag['inner'], _ = cur.read_fname()
    elif type_name == 'MapProperty':
        tag['inner'], _ = cur.read_fname()
        tag['value_type'], _ = cur.read_fname()
    tag['has_guid'] = cur.read_u8() != 0
    if tag['has_guid']:
        tag['guid'] = cur.read_fguid()
    return tag


def walk_property_stream(cur, end_offset, depth=0, max_depth=64):
    """Try to walk a property-tag stream. Returns list of tag dicts. On parse
    error captures the error and stops."""
    out = []
    while cur.off < end_offset:
        before = cur.off
        try:
            tag = read_property_tag(cur)
        except (EOFError, UnicodeDecodeError) as e:
            return out, {'error': str(e), 'at': before}
        if tag.get('terminator'):
            out.append(tag)
            return out, {'terminated': True}
        value_start = cur.off
        # We don't try to decode the value here — just step past `size` bytes.
        if value_start + tag['size'] > len(cur.buf):
            return out, {'error': f'size {tag["size"]} overruns @ {value_start}', 'at': value_start}
        cur.off = value_start + tag['size']
        tag['value_start'] = value_start
        tag['value_end'] = cur.off
        out.append(tag)
    return out, {'reached_end': True}


# -----------------------------------------------------------------
# FName extraction (passive — same heuristic as soulmaskdiff.py)
# -----------------------------------------------------------------
def extract_fnames(buf, start=0):
    """[u32 length][ASCII bytes][\\0]. Bumps past valid matches; otherwise +1."""
    out = []
    i = start
    n = len(buf)
    while i < n - 4:
        L = struct.unpack_from('<I', buf, i)[0]
        if 2 <= L <= 1024 and i + 4 + L <= n:
            s = buf[i + 4: i + 4 + L]
            if s[-1] == 0 and all(32 <= b < 127 for b in s[:-1]):
                out.append((i, s[:-1].decode('ascii')))
                i += 4 + L
                continue
        i += 1
    return out


# -----------------------------------------------------------------
# Reports
# -----------------------------------------------------------------
def hexdump(buf, start, end, width=16, max_lines=20):
    lines = []
    i = start
    line_count = 0
    while i < end and line_count < max_lines:
        chunk = buf[i:min(i + width, end)]
        hexpart = ' '.join(f'{b:02x}' for b in chunk)
        asciipart = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        lines.append(f'  {i:06x}  {hexpart:<48}  |{asciipart}|')
        i += width
        line_count += 1
    if i < end:
        lines.append(f'  ... ({end - i} more bytes)')
    return '\n'.join(lines)


def header_summary(buf):
    if len(buf) < 14:
        return '<too small>'
    v = struct.unpack_from('<I', buf, 0)[0]
    h1 = struct.unpack_from('<I', buf, 4)[0]
    h2 = struct.unpack_from('<I', buf, 8)[0]
    he = struct.unpack_from('<H', buf, 12)[0]
    return f'versionTag={v:#010x} headerWord1={h1:#010x} headerWord2={h2:#010x} headerExtra={he:#06x}'


def diff_runs(a, b):
    """Byte-diff with 8-byte rejoin gap, only useful for same-length buffers.
    For different-length buffers, walks until first mismatch and returns that."""
    if a == b:
        return []
    if len(a) == len(b):
        runs = []
        n = len(a); i = 0
        while i < n:
            while i < n and a[i] == b[i]: i += 1
            if i >= n: break
            start = i
            while i < n:
                if a[i] == b[i]:
                    ahead = 0
                    while i + ahead < n and a[i + ahead] == b[i + ahead]:
                        ahead += 1
                    if ahead >= 8: break
                    i += ahead
                else:
                    i += 1
            runs.append((start, i))
        return runs
    # different lengths — just find first diff and last common prefix/suffix.
    pre = 0
    while pre < len(a) and pre < len(b) and a[pre] == b[pre]: pre += 1
    suf = 0
    while (suf < len(a) - pre and suf < len(b) - pre
           and a[len(a) - 1 - suf] == b[len(b) - 1 - suf]):
        suf += 1
    return [('mismatch', pre, len(a) - suf, pre, len(b) - suf)]


# -----------------------------------------------------------------
# Main
# -----------------------------------------------------------------
def analyse(a_path, b_path, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    entry_a, blob_a = load_stash(a_path)
    entry_b, blob_b = load_stash(b_path)

    print(f'A: {entry_a["label"]}  blob={len(blob_a):,}B  level={entry_a["row"]["actor_level"]}')
    print(f'B: {entry_b["label"]}  blob={len(blob_b):,}B  level={entry_b["row"]["actor_level"]}')
    print(f'   length delta: B - A = {len(blob_b) - len(blob_a):+}')
    print()
    print(f'A header: {header_summary(blob_a)}')
    print(f'B header: {header_summary(blob_b)}')
    print()

    # --- raw FName lists ---
    a_names = extract_fnames(blob_a, 14)
    b_names = extract_fnames(blob_b, 14)
    print(f'FNames found (heuristic): A={len(a_names)}  B={len(b_names)}')

    a_set = [n for _, n in a_names]
    b_set = [n for _, n in b_names]
    only_a = [n for n in a_set if n not in set(b_set)]
    only_b = [n for n in b_set if n not in set(a_set)]
    print(f'  in A only: {len(only_a)}   in B only: {len(only_b)}')
    if only_a:
        print('  in A only:')
        for n in only_a[:40]: print(f'    {n!r}')
        if len(only_a) > 40: print(f'    ... ({len(only_a) - 40} more)')
    if only_b:
        print('  in B only:')
        for n in only_b[:40]: print(f'    {n!r}')
        if len(only_b) > 40: print(f'    ... ({len(only_b) - 40} more)')
    print()

    # --- write full FName lists side by side ---
    a_text = '\n'.join(f'{off:06x}  {name}' for off, name in a_names)
    b_text = '\n'.join(f'{off:06x}  {name}' for off, name in b_names)
    (out_dir / 'fnames_A.txt').write_text(a_text, encoding='utf-8')
    (out_dir / 'fnames_B.txt').write_text(b_text, encoding='utf-8')

    # --- attempt property-tag walk from offset 14 ---
    for label, blob in (('A', blob_a), ('B', blob_b)):
        cur = Cursor(blob, 14)
        tags, status = walk_property_stream(cur, len(blob))
        lines = [f'# property stream walk for {label} starting @ 14',
                 f'# parsed {len(tags)} tags, status={status}',
                 '']
        for t in tags:
            if t.get('terminator'):
                lines.append(f'{t["start"]:06x}  TERMINATOR (None)')
                continue
            extra = ''
            if t.get('type') == 'StructProperty':
                extra = f' struct={t.get("struct_name")!r}'
            elif t.get('type') in ('ArrayProperty', 'SetProperty', 'ByteProperty', 'EnumProperty'):
                extra = f' inner={t.get("inner")!r}'
            elif t.get('type') == 'MapProperty':
                extra = f' inner={t.get("inner")!r} val={t.get("value_type")!r}'
            elif t.get('type') == 'BoolProperty':
                extra = f' bool={t.get("bool_val")}'
            lines.append(f'{t["start"]:06x}  {t["name"]!r:40} {t["type"]:18} size={t["size"]:6}  arr={t["array_index"]}{extra}')
        (out_dir / f'tagwalk_{label}.txt').write_text('\n'.join(lines), encoding='utf-8')
        print(f'tag-walk {label}: parsed {len(tags)} tags, status={status}')

    print()

    # --- show what's around the very first difference ---
    common = 0
    while common < len(blob_a) and common < len(blob_b) and blob_a[common] == blob_b[common]:
        common += 1
    print(f'common leading prefix: {common} bytes')
    suffix = 0
    while (suffix < len(blob_a) - common and suffix < len(blob_b) - common
           and blob_a[len(blob_a) - 1 - suffix] == blob_b[len(blob_b) - 1 - suffix]):
        suffix += 1
    print(f'common trailing suffix: {suffix} bytes')
    a_diff_start, a_diff_end = common, len(blob_a) - suffix
    b_diff_start, b_diff_end = common, len(blob_b) - suffix
    print(f'A diff slice: 0x{a_diff_start:x} .. 0x{a_diff_end:x}  ({a_diff_end - a_diff_start} bytes)')
    print(f'B diff slice: 0x{b_diff_start:x} .. 0x{b_diff_end:x}  ({b_diff_end - b_diff_start} bytes)')

    pre_ctx = 32
    post_ctx = 0
    a_window_start = max(0, a_diff_start - pre_ctx)
    print('\n--- A around first diff ---')
    print(hexdump(blob_a, a_window_start, min(a_diff_end + 64, len(blob_a)), max_lines=40))
    print('\n--- B around first diff ---')
    print(hexdump(blob_b, max(0, b_diff_start - pre_ctx), min(b_diff_end + 64, len(blob_b)), max_lines=40))

    # --- write full hexdumps for offline inspection ---
    def full_hex(buf):
        lines = []
        for i in range(0, len(buf), 16):
            chunk = buf[i:i + 16]
            hexpart = ' '.join(f'{b:02x}' for b in chunk)
            asc = ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
            lines.append(f'{i:06x}  {hexpart:<48}  |{asc}|')
        return '\n'.join(lines)
    (out_dir / 'hex_A.txt').write_text(full_hex(blob_a), encoding='utf-8')
    (out_dir / 'hex_B.txt').write_text(full_hex(blob_b), encoding='utf-8')

    # --- byte-diff runs ---
    if len(blob_a) == len(blob_b):
        runs = diff_runs(blob_a, blob_b)
        print(f'\nbyte-diff runs (same-length): {len(runs)}')
        for s, e in runs[:20]:
            ctx_name = None
            for off, name in a_names:
                if off <= s:
                    ctx_name = (off, name)
                else:
                    break
            label = f' (after FName {ctx_name[1]!r} @+{s-ctx_name[0]})' if ctx_name else ''
            print(f'  @0x{s:06x}..0x{e:06x}  ({e-s}B){label}')
    else:
        print(f'\n(blobs differ in length by {len(blob_b)-len(blob_a):+}, skipping fine-grained run diff)')


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    analyse(sys.argv[1], sys.argv[2], sys.argv[3])
