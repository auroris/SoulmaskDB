"""Dump ASCII runs and length-prefixed strings from both stash blobs, and
compare side-by-side. Looking for the back-reference / dictionary scheme
that's compressing FNames so aggressively that we only find 4 of them."""
import base64
import json
import struct
import sys
from pathlib import Path


def load_blob(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    return base64.b64decode(data['entries'][0]['row']['actor_data_b64'])


def length_prefixed(buf, start=0):
    """[u32 length][bytes][\\0] with printable ASCII content."""
    out = []
    i = start
    n = len(buf)
    while i < n - 4:
        L = struct.unpack_from('<I', buf, i)[0]
        if 2 <= L <= 1024 and i + 4 + L <= n:
            s = buf[i + 4: i + 4 + L]
            if s[-1] == 0 and all(32 <= b < 127 for b in s[:-1]):
                out.append((i, L, s[:-1].decode('ascii')))
                i += 4 + L
                continue
        i += 1
    return out


def ascii_runs(buf, min_len=3):
    """Bare runs of printable ASCII."""
    out = []
    start = None
    cur = []
    for i, b in enumerate(buf):
        if 32 <= b < 127:
            if start is None:
                start = i
                cur = []
            cur.append(b)
        else:
            if start is not None and len(cur) >= min_len:
                out.append((start, len(cur), bytes(cur).decode('ascii')))
            start = None; cur = []
    if start is not None and len(cur) >= min_len:
        out.append((start, len(cur), bytes(cur).decode('ascii')))
    return out


def main(a_path, b_path):
    a = load_blob(a_path); b = load_blob(b_path)
    print(f'A: {len(a):,}B    B: {len(b):,}B    delta: {len(b)-len(a):+d}')
    print()

    a_lp = length_prefixed(a, 14)
    b_lp = length_prefixed(b, 14)
    print(f'length-prefixed strings:  A={len(a_lp)}  B={len(b_lp)}')
    for off, L, t in a_lp[:10]:
        print(f'  A @0x{off:06x}  len={L:3d}  {t!r}')
    print('  ...')
    for off, L, t in b_lp[:10]:
        print(f'  B @0x{off:06x}  len={L:3d}  {t!r}')
    print()

    a_ar = ascii_runs(a, 4)
    b_ar = ascii_runs(b, 4)
    print(f'bare ASCII runs (>=4):  A={len(a_ar)}  B={len(b_ar)}')

    # Most-frequent run patterns
    from collections import Counter
    a_texts = Counter(t for _, _, t in a_ar)
    b_texts = Counter(t for _, _, t in b_ar)
    print()
    print('Top 30 strings (by occurrence) — common to A and B:')
    in_both = set(a_texts) & set(b_texts)
    for t in sorted(in_both, key=lambda s: -(a_texts[s] + b_texts[s]))[:30]:
        print(f'  {a_texts[t]:3d} A / {b_texts[t]:3d} B   {t!r}')

    print()
    print('Strings ONLY in A (top 20 by count):')
    only_a = sorted(set(a_texts) - set(b_texts), key=lambda s: -a_texts[s])
    for t in only_a[:20]:
        print(f'  {a_texts[t]:3d}x  {t!r}')

    print()
    print('Strings ONLY in B (top 20 by count):')
    only_b = sorted(set(b_texts) - set(a_texts), key=lambda s: -b_texts[s])
    for t in only_b[:20]:
        print(f'  {b_texts[t]:3d}x  {t!r}')

    # Dump full ASCII run lists for offline study
    Path('blob_analysis/ascii_A.txt').write_text(
        '\n'.join(f'{o:06x}  {L:3d}  {t}' for o, L, t in a_ar), encoding='utf-8')
    Path('blob_analysis/ascii_B.txt').write_text(
        '\n'.join(f'{o:06x}  {L:3d}  {t}' for o, L, t in b_ar), encoding='utf-8')

    # Patterns suggesting back-references:
    # If FName 'StructProperty' (length 15, prefix `0f 00 00 00`) is in
    # both files at offset 0x1d, can we find a SHORTER encoding of
    # 'StructProperty' elsewhere? Or partial fragments?
    print()
    print('Truncated fragments of common names (sliding window):')
    common_names = ['StructProperty', 'ZhuRenGuid', 'HJSBaoGuoComponent',
                    'BP_HongJingShi20_C', 'Blueprints', 'Persistent',
                    'PlayerState', 'HPlayerState', 'GObject']
    for nm in common_names:
        for suffix_len in (3, 4, 5, 6, 8):
            if suffix_len >= len(nm): continue
            suffix = nm[-suffix_len:]
            a_count = a.count(suffix.encode('ascii'))
            b_count = b.count(suffix.encode('ascii'))
            # report only if more occurrences than the full name (suggesting partial repeats)
            full_a = a.count(nm.encode('ascii'))
            full_b = b.count(nm.encode('ascii'))
            if a_count > full_a + 1 or b_count > full_b + 1:
                print(f'  {nm!r}  suffix[-{suffix_len}:]={suffix!r}  full=A:{full_a} B:{full_b}  partial=A:{a_count} B:{b_count}')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
