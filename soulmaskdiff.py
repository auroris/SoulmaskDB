"""Differential reverse-engineering helper for Soulmask world.db.

Usage:
  python soulmaskdiff.py OLD.db NEW.db
  python soulmaskdiff.py OLD.db NEW.db --serial 91
  python soulmaskdiff.py OLD.db NEW.db --ignore-time --summary-only

Workflow:
  1. Stop the server cleanly, copy world.db -> snap_before.db.
  2. Restart, log in, do ONE specific in-game action with a known value
     (e.g. pick up exactly 7 sticks).
  3. Stop the server, copy world.db -> snap_after.db.
  4. Run:  python soulmaskdiff.py snap_before.db snap_after.db --ignore-time
  5. The output points at exactly which bytes encoded that change, and the
     nearest preceding length-prefixed FName tells you what UE property the
     bytes belong to.
"""

import argparse
import difflib
import struct
import sqlite3
import sys
from collections import OrderedDict


TEXT_COLS = ['server_id', 'data_version', 'actor_name', 'actor_level',
             'actor_script', 'actor_owner', 'actor_transf', 'actor_time']

# A row's identity for the purposes of diff is `actor_serial`. Both snapshots
# come from the same dedicated server, so serials match across snapshots.


def load_rows(db_path):
    """Return {actor_serial: dict_of_columns} for every row in actor_table."""
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute("""
        SELECT actor_serial, server_id, data_version, actor_name, actor_level,
               actor_script, actor_owner, actor_transf, actor_data, actor_time
        FROM actor_table
    """)
    out = {}
    for r in cur.fetchall():
        out[r[0]] = {
            'actor_serial': r[0], 'server_id': r[1], 'data_version': r[2],
            'actor_name':   r[3], 'actor_level': r[4], 'actor_script': r[5],
            'actor_owner':  r[6], 'actor_transf': r[7], 'actor_data':  r[8],
            'actor_time':   r[9],
        }
    con.close()
    return out


def extract_fnames(blob):
    """Length-prefixed UTF-8 FNames embedded in the blob.

    Format: [u32 length][bytes][\\0], inner bytes must be printable ASCII.
    Returns ordered list of (offset, name).
    """
    out = []
    if not blob:
        return out
    n = len(blob)
    i = 0
    while i < n - 4:
        L = struct.unpack_from('<I', blob, i)[0]
        if 2 <= L <= 1024 and i + 4 + L <= n:
            s = blob[i + 4: i + 4 + L]
            if s[-1] == 0 and all(32 <= b < 127 for b in s[:-1]):
                try:
                    out.append((i, s[:-1].decode('ascii')))
                    i += 4 + L
                    continue
                except UnicodeDecodeError:
                    pass
        i += 1
    return out


def nearest_fname(fnames, offset):
    """Return (offset, name, distance) for the FName whose offset is the
    largest <= `offset`. None if no FName precedes `offset`."""
    best = None
    for off, name in fnames:
        if off <= offset:
            best = (off, name, offset - off)
        else:
            break
    return best


def diff_runs(old, new):
    """Return a list of (tag, i1, i2, j1, j2) opcodes describing the changes,
    where slices are old[i1:i2] -> new[j1:j2]. tag is 'replace', 'delete',
    or 'insert'. Equal runs are omitted.

    Same-length blobs use a fast contiguous-run scan with an 8-byte
    "rejoin" gap. Differently-sized blobs fall back to SequenceMatcher.
    """
    if old is None and new is None:
        return []
    if old is None:
        return [('insert', 0, 0, 0, len(new))]
    if new is None:
        return [('delete', 0, len(old), 0, 0)]
    if old == new:
        return []

    if len(old) == len(new):
        n = len(old)
        i = 0
        out = []
        while i < n:
            while i < n and old[i] == new[i]:
                i += 1
            if i >= n:
                break
            start = i
            while i < n:
                if old[i] == new[i]:
                    ahead = 0
                    while i + ahead < n and old[i + ahead] == new[i + ahead]:
                        ahead += 1
                    if ahead >= 8:
                        break
                    i += ahead
                else:
                    i += 1
            out.append(('replace', start, i, start, i))
        return out

    matcher = difflib.SequenceMatcher(a=old, b=new, autojunk=False)
    return [op for op in matcher.get_opcodes() if op[0] != 'equal']


def hex_line(buf, marked_start=None, marked_end=None):
    """One line: hex bytes (optionally with [..] markers around a slice) +
    ASCII gutter."""
    if not buf:
        return ''
    hex_parts = []
    for i, b in enumerate(buf):
        if marked_start is not None and i == marked_start:
            hex_parts.append('[' + f'{b:02x}')
        elif marked_end is not None and i == marked_end:
            hex_parts.append(']' + f'{b:02x}')
        else:
            hex_parts.append(f'{b:02x}')
    if marked_end is not None and marked_end == len(buf):
        hex_parts.append(']')
    hex_str = ' '.join(hex_parts)
    ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in buf)
    return f'{hex_str}  |{ascii_str}|'


def show_blob_change(old, new, opcodes, context, fnames):
    """Print each change run with offset, FName context, and a hex window."""
    for tag, i1, i2, j1, j2 in opcodes:
        old_run = old[i1:i2] if old else b''
        new_run = new[j1:j2] if new else b''
        ctx_offset = i1 if old else j1
        ctx = nearest_fname(fnames, ctx_offset)
        ctx_text = ''
        if ctx:
            off, name, dist = ctx
            ctx_text = f'  (after FName "{name}" @+{dist})'

        size_note = ''
        if tag == 'replace' and len(old_run) != len(new_run):
            size_note = f'  [REPLACE {len(old_run)}B -> {len(new_run)}B]'
        elif tag == 'insert':
            size_note = f'  [INSERT {len(new_run)}B]'
        elif tag == 'delete':
            size_note = f'  [DELETE {len(old_run)}B]'

        print(f'  @0x{ctx_offset:06x}{ctx_text}{size_note}')

        # Snapshot windows with `context` bytes before and after.
        if old:
            o_start = max(0, i1 - context)
            o_end = min(len(old), i2 + context)
            o_win = old[o_start:o_end]
            mark_s = i1 - o_start
            mark_e = i2 - o_start
            print(f'    - {hex_line(o_win, mark_s, mark_e)}')
        if new:
            n_start = max(0, j1 - context)
            n_end = min(len(new), j2 + context)
            n_win = new[n_start:n_end]
            mark_s = j1 - n_start
            mark_e = j2 - n_start
            print(f'    + {hex_line(n_win, mark_s, mark_e)}')


def fmt_value(v, max_len=80):
    if v is None:
        return 'NULL'
    if isinstance(v, (bytes, bytearray)):
        return f'<blob {len(v)} bytes>'
    s = str(v)
    if len(s) > max_len:
        return s[:max_len - 1] + '…'
    return s


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument('old_db', help='Older snapshot of world.db')
    ap.add_argument('new_db', help='Newer snapshot of world.db')
    ap.add_argument('--serial', type=int,
                    help='Only show this actor_serial (very useful once you know which row to watch)')
    ap.add_argument('--context', type=int, default=8,
                    help='Bytes of context to show before/after each diff run (default: 8)')
    ap.add_argument('--ignore-time', action='store_true',
                    help='Ignore actor_time differences (changes on every save; usually noise)')
    ap.add_argument('--ignore-transf', action='store_true',
                    help='Ignore actor_transf differences (positions drift constantly for moving actors)')
    ap.add_argument('--ignore-blob-of', action='append', default=[],
                    help='Ignore blob changes on rows whose actor_script LIKE this pattern; can be repeated. Useful for filtering noise like world chunks that re-save on every tick.')
    ap.add_argument('--summary-only', action='store_true',
                    help='Just count what changed; skip per-row details')
    ap.add_argument('--no-blob', action='store_true',
                    help='Skip blob diffs entirely (only show text column changes)')
    ap.add_argument('--max-rows', type=int, default=0,
                    help='Max changed rows to detail (0 = unlimited)')
    args = ap.parse_args()

    print(f'old: {args.old_db}')
    print(f'new: {args.new_db}')
    print()

    old = load_rows(args.old_db)
    new = load_rows(args.new_db)

    old_serials = set(old)
    new_serials = set(new)
    added   = sorted(new_serials - old_serials)
    removed = sorted(old_serials - new_serials)
    common  = sorted(old_serials & new_serials)

    if args.serial is not None:
        added   = [s for s in added   if s == args.serial]
        removed = [s for s in removed if s == args.serial]
        common  = [s for s in common  if s == args.serial]

    cols_to_check = list(TEXT_COLS)
    if args.ignore_time:   cols_to_check.remove('actor_time')
    if args.ignore_transf: cols_to_check.remove('actor_transf')

    changed = []
    blob_ignored_rows = 0
    for serial in common:
        o = old[serial]
        n = new[serial]
        col_diffs = [(c, o[c], n[c]) for c in cols_to_check if o[c] != n[c]]
        blob_diffs = []
        if not args.no_blob:
            script = o.get('actor_script') or ''
            if any(pat.lower() in script.lower() for pat in args.ignore_blob_of):
                if o['actor_data'] != n['actor_data']:
                    blob_ignored_rows += 1
            else:
                blob_diffs = diff_runs(o['actor_data'], n['actor_data'])
        if col_diffs or blob_diffs:
            changed.append((serial, o, n, col_diffs, blob_diffs))

    print('== summary ==')
    print(f'  rows added:   {len(added):,}')
    print(f'  rows removed: {len(removed):,}')
    print(f'  rows changed: {len(changed):,}')
    if blob_ignored_rows:
        print(f'  rows whose blob diff was ignored (--ignore-blob-of): {blob_ignored_rows:,}')
    print(f'  rows total:   old={len(old):,}  new={len(new):,}')
    print()

    if args.summary_only:
        return 0

    if added:
        print('== rows added (in new, not in old) ==')
        for s in added:
            r = new[s]
            blen = len(r['actor_data']) if r['actor_data'] else 0
            print(f'  +#{s}  {fmt_value(r["actor_script"], 100)}  blob={blen:,}B')
            print(f'        name={fmt_value(r["actor_name"])}')
        print()

    if removed:
        print('== rows removed (in old, not in new) ==')
        for s in removed:
            r = old[s]
            blen = len(r['actor_data']) if r['actor_data'] else 0
            print(f'  -#{s}  {fmt_value(r["actor_script"], 100)}  blob={blen:,}B')
            print(f'        name={fmt_value(r["actor_name"])}')
        print()

    shown = 0
    for serial, o, n, col_diffs, blob_diffs in changed:
        if args.max_rows and shown >= args.max_rows:
            print(f'... ({len(changed) - shown} more changed rows; raise --max-rows to see them)')
            break
        shown += 1

        print(f'== #{serial}  {fmt_value(o["actor_script"], 100)} ==')
        for c, ov, nv in col_diffs:
            print(f'  {c}: {fmt_value(ov)} -> {fmt_value(nv)}')

        if blob_diffs:
            ob = o['actor_data'] or b''
            nb = n['actor_data'] or b''
            print(f'  blob: {len(ob):,}B -> {len(nb):,}B  ({len(blob_diffs)} change run{"s" if len(blob_diffs) != 1 else ""})')
            fnames = extract_fnames(ob if ob else nb)
            show_blob_change(ob, nb, blob_diffs, args.context, fnames)
        print()

    return 0


if __name__ == '__main__':
    sys.exit(main())
