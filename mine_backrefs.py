"""Pattern-miner for the Soulmask back-reference FName scheme.

For one blob, dump:
  1. All length-prefixed FNames ([u32 length][bytes][\\0])
  2. All standalone ASCII runs (≥3 printable chars), with the bytes
     immediately before and after.

Then tabulate fragments by their leading byte(s) and see if a back-ref
scheme falls out.

Usage:
  python mine_backrefs.py <actor_serial> [<actor_serial> ...]

If no serial supplied, picks a moderately complex BG-actor row by hand.
"""
import sqlite3
import struct
import sys
import os
from collections import Counter, defaultdict

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'world.db')


def length_prefixed_fnames(blob, start=14):
    """Find every `[u32 length 2..1024][printable bytes][\\0]` in the blob.
    Returns list of (offset, length, text)."""
    out = []
    i = start
    n = len(blob)
    while i < n - 4:
        L = struct.unpack_from('<I', blob, i)[0]
        if 2 <= L <= 1024 and i + 4 + L <= n:
            s = blob[i + 4: i + 4 + L]
            if s[-1] == 0 and all(32 <= b < 127 for b in s[:-1]):
                out.append((i, L, s[:-1].decode('ascii')))
                i += 4 + L
                continue
        i += 1
    return out


def ascii_runs(blob, start=14, min_len=3, max_len=64):
    """Return all (offset, run_text) tuples for ASCII printable runs.
    Each run that is NOT a length-prefixed FName (we filter those out
    separately) is a "fragment"."""
    out = []
    n = len(blob)
    i = start
    while i < n:
        if 32 <= blob[i] < 127:
            j = i
            while j < n and 32 <= blob[j] < 127:
                j += 1
            if j - i >= min_len and j - i <= max_len:
                out.append((i, blob[i:j].decode('ascii')))
            i = j
        else:
            i += 1
    return out


def analyze_blob(blob, label=''):
    print(f'\n=== blob: {label} ({len(blob):,}B) ===')

    fnames = length_prefixed_fnames(blob, start=14)
    print(f'Full FNames (length-prefixed): {len(fnames)}')
    for off, L, text in fnames[:15]:
        print(f'  @0x{off:06x} len={L:3d}  {text!r}')
    if len(fnames) > 15:
        print(f'  ... ({len(fnames) - 15} more)')

    # Compute byte-offset coverage of full FNames (so we can mark fragments)
    covered = set()
    for off, L, _ in fnames:
        for k in range(off, off + 4 + L):
            covered.add(k)

    runs = ascii_runs(blob, start=14, min_len=3, max_len=64)
    # Filter out runs that overlap a known full FName.
    fragments = []
    for off, text in runs:
        if any(k in covered for k in range(off, off + len(text))):
            continue
        # Capture 4 bytes before and 4 after
        before = bytes(blob[max(0, off - 4): off])
        after  = bytes(blob[off + len(text): off + len(text) + 4])
        fragments.append({
            'off': off, 'text': text, 'len': len(text),
            'before': before, 'after': after,
        })

    print(f'\nASCII fragments (after filtering full FNames): {len(fragments)}')
    print('Sample (first 25):')
    for f in fragments[:25]:
        before_hex = ' '.join(f'{b:02x}' for b in f['before'])
        after_hex  = ' '.join(f'{b:02x}' for b in f['after'])
        print(f"  @0x{f['off']:06x}  before=[{before_hex}]  '{f['text'][:40]}'  after=[{after_hex}]")

    return fnames, fragments


def cross_match(all_fnames_by_blob, all_fragments_by_blob):
    """For each fragment, find the longest FName in the SAME blob whose
    suffix matches the fragment. If found, record the (leading bytes,
    matched FName) pair to look for a consistent scheme."""

    leading_to_completions = defaultdict(Counter)

    for blob_id, fnames in all_fnames_by_blob.items():
        fragments = all_fragments_by_blob[blob_id]
        fname_set = [t for _, _, t in fnames]
        for f in fragments:
            text = f['text']
            # Try to find a known FName ending with this fragment.
            # (Try long fragments first to bias toward unique completions.)
            matches = [n for n in fname_set if n != text and n.endswith(text)]
            if not matches:
                continue
            # Use the longest matching FName as the "completion"
            best = max(matches, key=len)
            # Catalog: what byte(s) precede the fragment?
            lead2 = f['before'][-2:] if len(f['before']) >= 2 else f['before']
            leading_to_completions[(bytes(lead2), len(best) - len(text))][best] += 1

    print('\n\n=== cross-match: leading-bytes -> completions ===')
    print('(grouped by [last 2 bytes before fragment, # chars stripped])')
    print(f'{len(leading_to_completions)} distinct lead/strip combinations\n')
    # Top combinations by total fragment count
    sorted_combos = sorted(leading_to_completions.items(),
                           key=lambda kv: -sum(kv[1].values()))
    for (lead, strip_n), completions in sorted_combos[:40]:
        total = sum(completions.values())
        lead_hex = ' '.join(f'{b:02x}' for b in lead)
        print(f'  lead=[{lead_hex}]  strip={strip_n}  total={total}')
        for name, n in completions.most_common(3):
            print(f'    {n:4d}x  → {name!r}')


def main():
    if len(sys.argv) > 1:
        serials = [int(x) for x in sys.argv[1:]]
    else:
        # Default: take a few diverse moderately-sized blobs
        serials = [13568, 18699, 18700, 38109, 22637, 22638]

    conn = sqlite3.connect(DB)
    c = conn.cursor()

    all_fnames = {}
    all_fragments = {}
    for serial in serials:
        row = c.execute(
            "SELECT actor_serial, actor_script, actor_data FROM actor_table "
            "WHERE actor_serial = ?", (serial,)
        ).fetchone()
        if not row:
            print(f'no row at serial {serial}')
            continue
        s, sc, blob = row
        label = f'serial={s} class={sc.split(".")[-1] if sc else "?"}'
        fnames, fragments = analyze_blob(blob, label=label)
        all_fnames[s] = fnames
        all_fragments[s] = fragments

    cross_match(all_fnames, all_fragments)


if __name__ == '__main__':
    main()
