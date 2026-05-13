"""Soulmask world.db helper.

Subcommands (run `python soulmaskdb.py <cmd> -h` for details):
  info                  Show schema, row count, distinct values.
  query SQL             Run an arbitrary SELECT and pretty-print rows.
  csv SQL -o file       Export a SELECT to CSV (blobs as hex by default).
  get SERIAL            Print one row's text fields and blob length.
  set SERIAL FIELD VAL  Update a text field on one row.
  blob-export SERIAL F  Write actor_data blob to file F.
  blob-import SERIAL F  Read file F into actor_data blob.
  blob-strings SERIAL   Scan blob for printable strings.
  blob-hex SERIAL       Hex-dump blob (with --start/--len).
  blob-replace SERIAL   Replace an exact byte sequence in a blob.
  backup                Copy world.db to a timestamped backup.

Writes are gated behind --write. Without it, the tool runs read-only and
prints what it would do. Always make a backup before --write on the blob.
"""

import argparse
import base64
import csv
import shutil
import sqlite3
import struct
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_DB = "world.db"
TEXT_FIELDS = {
    "actor_name", "actor_level", "actor_script",
    "actor_owner", "actor_transf", "actor_time",
}
ALL_FIELDS = [
    "actor_serial", "server_id", "data_version",
    "actor_name", "actor_level", "actor_script",
    "actor_owner", "actor_transf", "actor_data", "actor_time",
]


def open_db(path, write=False):
    uri = f"file:{path}?mode={'rw' if write else 'ro'}"
    return sqlite3.connect(uri, uri=True)


def ensure_select_only(sql):
    head = sql.lstrip().split(None, 1)[0].lower()
    if head not in ("select", "with", "explain"):
        sys.exit(f"refusing non-SELECT statement (got '{head}'). Use --write helpers for edits.")


def fmt_cell(v, max_len=80):
    if v is None:
        return "NULL"
    if isinstance(v, bytes):
        return f"<blob {len(v)}B {v[:8].hex()}…>"
    s = str(v)
    if len(s) > max_len:
        return s[:max_len - 1] + "…"
    return s


def print_table(cur):
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    if not rows:
        print(f"(no rows; columns: {', '.join(cols)})")
        return
    widths = [len(c) for c in cols]
    fmt_rows = []
    for r in rows:
        fr = [fmt_cell(v) for v in r]
        fmt_rows.append(fr)
        for i, cell in enumerate(fr):
            widths[i] = max(widths[i], len(cell))
    header = " | ".join(c.ljust(widths[i]) for i, c in enumerate(cols))
    print(header)
    print("-+-".join("-" * w for w in widths))
    for fr in fmt_rows:
        print(" | ".join(fr[i].ljust(widths[i]) for i in range(len(cols))))
    print(f"\n({len(rows)} row{'s' if len(rows) != 1 else ''})")


# ---------------- subcommands ----------------

def cmd_info(args):
    con = open_db(args.db)
    cur = con.cursor()
    cur.execute("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
    print("== tables ==")
    for n, s in cur.fetchall():
        print(f"  {n}: {s}")
    print()
    cur.execute("SELECT COUNT(*) FROM actor_table")
    print(f"actor_table rows: {cur.fetchone()[0]:,}")
    cur.execute("SELECT DISTINCT server_id FROM actor_table")
    print(f"server_id values: {[r[0] for r in cur.fetchall()]}")
    cur.execute("SELECT DISTINCT data_version FROM actor_table")
    print(f"data_version values: {[r[0] for r in cur.fetchall()]}")
    cur.execute("SELECT MIN(actor_time), MAX(actor_time) FROM actor_table")
    mn, mx = cur.fetchone()
    print(f"actor_time range: {mn} .. {mx}")


def cmd_query(args):
    ensure_select_only(args.sql)
    con = open_db(args.db)
    cur = con.cursor()
    cur.execute(args.sql)
    print_table(cur)


def cmd_csv(args):
    ensure_select_only(args.sql)
    con = open_db(args.db)
    cur = con.cursor()
    cur.execute(args.sql)
    cols = [d[0] for d in cur.description]
    out = Path(args.out)
    n = 0
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for row in cur:
            wrow = []
            for v in row:
                if isinstance(v, bytes):
                    if args.blob == "hex":
                        wrow.append(v.hex())
                    elif args.blob == "base64":
                        wrow.append(base64.b64encode(v).decode())
                    elif args.blob == "len":
                        wrow.append(str(len(v)))
                    else:  # skip
                        wrow.append("")
                else:
                    wrow.append("" if v is None else str(v))
            w.writerow(wrow)
            n += 1
    print(f"wrote {n:,} rows to {out}")


def cmd_get(args):
    con = open_db(args.db)
    cur = con.cursor()
    cur.execute(f"SELECT {', '.join(ALL_FIELDS)} FROM actor_table WHERE actor_serial = ?", (args.serial,))
    row = cur.fetchone()
    if not row:
        sys.exit(f"no row with actor_serial={args.serial}")
    for k, v in zip(ALL_FIELDS, row):
        if k == "actor_data":
            blen = len(v) if v else 0
            print(f"  {k}: <blob {blen}B>")
        else:
            print(f"  {k}: {v!r}")


def cmd_set(args):
    if args.field not in TEXT_FIELDS:
        sys.exit(f"--field must be one of: {sorted(TEXT_FIELDS)} (use blob-* for actor_data; numeric fields not supported)")
    con = open_db(args.db, write=args.write)
    cur = con.cursor()
    cur.execute(f"SELECT {args.field} FROM actor_table WHERE actor_serial = ?", (args.serial,))
    row = cur.fetchone()
    if not row:
        sys.exit(f"no row with actor_serial={args.serial}")
    print(f"  before: {row[0]!r}")
    print(f"  after : {args.value!r}")
    if not args.write:
        print("  (dry run; pass --write to apply)")
        return
    cur.execute(f"UPDATE actor_table SET {args.field} = ? WHERE actor_serial = ?", (args.value, args.serial))
    con.commit()
    print(f"  updated {cur.rowcount} row(s)")


def cmd_blob_export(args):
    con = open_db(args.db)
    cur = con.cursor()
    cur.execute("SELECT actor_data FROM actor_table WHERE actor_serial = ?", (args.serial,))
    row = cur.fetchone()
    if not row:
        sys.exit(f"no row with actor_serial={args.serial}")
    blob = row[0]
    if blob is None:
        sys.exit("actor_data is NULL")
    Path(args.file).write_bytes(blob)
    print(f"wrote {len(blob):,} bytes to {args.file}")


def cmd_blob_import(args):
    data = Path(args.file).read_bytes()
    con = open_db(args.db, write=args.write)
    cur = con.cursor()
    cur.execute("SELECT length(actor_data) FROM actor_table WHERE actor_serial = ?", (args.serial,))
    row = cur.fetchone()
    if not row:
        sys.exit(f"no row with actor_serial={args.serial}")
    old_len = row[0] or 0
    print(f"  serial={args.serial} blob: {old_len:,}B -> {len(data):,}B")
    if not args.write:
        print("  (dry run; pass --write to apply)")
        return
    cur.execute("UPDATE actor_table SET actor_data = ? WHERE actor_serial = ?", (data, args.serial))
    con.commit()
    print(f"  updated {cur.rowcount} row(s)")


def cmd_blob_strings(args):
    con = open_db(args.db)
    cur = con.cursor()
    cur.execute("SELECT actor_data FROM actor_table WHERE actor_serial = ?", (args.serial,))
    row = cur.fetchone()
    if not row or row[0] is None:
        sys.exit(f"no blob for serial={args.serial}")
    blob = row[0]
    n = len(blob)

    # Length-prefixed (uint32 LE + bytes ending in \0)
    print(f"== length-prefixed strings in {n:,}B blob ==")
    i, prefixed = 0, []
    while i < n - 4:
        L = struct.unpack_from("<I", blob, i)[0]
        if 1 <= L <= 1024 and i + 4 + L <= n:
            s = blob[i + 4: i + 4 + L]
            if s.endswith(b"\x00") and all(32 <= b < 127 for b in s[:-1]):
                prefixed.append((i, L, s[:-1].decode("ascii")))
                i += 4 + L
                continue
        i += 1
    for off, L, txt in prefixed:
        print(f"  @0x{off:06x} len={L:3d}  {txt}")

    # Bare runs of printable ASCII (>= min length)
    print(f"\n== bare ASCII runs (>= {args.min}) ==")
    out, start = bytearray(), None
    for j, b in enumerate(blob):
        if 32 <= b < 127:
            if start is None:
                start = j
            out.append(b)
        else:
            if start is not None and len(out) >= args.min:
                print(f"  @0x{start:06x} len={len(out):3d}  {out.decode('ascii')}")
            out.clear(); start = None
    if start is not None and len(out) >= args.min:
        print(f"  @0x{start:06x} len={len(out):3d}  {out.decode('ascii')}")


def cmd_blob_hex(args):
    con = open_db(args.db)
    cur = con.cursor()
    cur.execute("SELECT actor_data FROM actor_table WHERE actor_serial = ?", (args.serial,))
    row = cur.fetchone()
    if not row or row[0] is None:
        sys.exit(f"no blob for serial={args.serial}")
    blob = row[0]
    end = min(len(blob), args.start + args.len) if args.len else len(blob)
    for off in range(args.start, end, 16):
        chunk = blob[off:off + 16]
        hex_part = " ".join(f"{b:02x}" for b in chunk)
        ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        print(f"{off:08x}  {hex_part:<47s}  {ascii_part}")


def cmd_blob_replace(args):
    find = bytes.fromhex(args.find.replace(" ", ""))
    repl = bytes.fromhex(args.replace.replace(" ", ""))
    if len(find) != len(repl):
        sys.exit(f"find ({len(find)}B) and replace ({len(repl)}B) must be the same length")
    con = open_db(args.db, write=args.write)
    cur = con.cursor()
    cur.execute("SELECT actor_data FROM actor_table WHERE actor_serial = ?", (args.serial,))
    row = cur.fetchone()
    if not row or row[0] is None:
        sys.exit(f"no blob for serial={args.serial}")
    blob = row[0]
    occurrences = blob.count(find)
    if occurrences == 0:
        sys.exit("pattern not found in blob")
    if occurrences > 1 and not args.all:
        sys.exit(f"pattern found {occurrences}x; pass --all to replace every occurrence, or refine the pattern")
    new = blob.replace(find, repl) if args.all else blob.replace(find, repl, 1)
    print(f"  replaced {occurrences if args.all else 1} occurrence(s) of {find.hex()} -> {repl.hex()}")
    if not args.write:
        print("  (dry run; pass --write to apply)")
        return
    cur.execute("UPDATE actor_table SET actor_data = ? WHERE actor_serial = ?", (new, args.serial))
    con.commit()
    print(f"  updated {cur.rowcount} row(s)")


def cmd_backup(args):
    src = Path(args.db)
    if not src.exists():
        sys.exit(f"{src} does not exist")
    dst = src.with_suffix(src.suffix + f".bak.{datetime.now():%Y%m%d_%H%M%S}")
    shutil.copy2(src, dst)
    print(f"backed up {src} -> {dst} ({dst.stat().st_size:,}B)")


# ---------------- argparse ----------------

def main():
    p = argparse.ArgumentParser(prog="soulmaskdb", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=DEFAULT_DB, help=f"path to world.db (default: {DEFAULT_DB})")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("info", help="show schema and counts").set_defaults(func=cmd_info)

    pq = sub.add_parser("query", help="run a SELECT and pretty-print")
    pq.add_argument("sql"); pq.set_defaults(func=cmd_query)

    pc = sub.add_parser("csv", help="run a SELECT and write CSV")
    pc.add_argument("sql"); pc.add_argument("-o", "--out", required=True)
    pc.add_argument("--blob", choices=["hex", "base64", "len", "skip"], default="hex",
                    help="how to render BLOB columns (default: hex)")
    pc.set_defaults(func=cmd_csv)

    pg = sub.add_parser("get", help="print one row")
    pg.add_argument("serial", type=int); pg.set_defaults(func=cmd_get)

    ps = sub.add_parser("set", help="update a text field on one row")
    ps.add_argument("serial", type=int); ps.add_argument("field"); ps.add_argument("value")
    ps.add_argument("--write", action="store_true", help="actually apply the change")
    ps.set_defaults(func=cmd_set)

    pe = sub.add_parser("blob-export", help="dump actor_data to a file")
    pe.add_argument("serial", type=int); pe.add_argument("file"); pe.set_defaults(func=cmd_blob_export)

    pi = sub.add_parser("blob-import", help="load actor_data from a file")
    pi.add_argument("serial", type=int); pi.add_argument("file")
    pi.add_argument("--write", action="store_true")
    pi.set_defaults(func=cmd_blob_import)

    pst = sub.add_parser("blob-strings", help="scan blob for ASCII strings")
    pst.add_argument("serial", type=int)
    pst.add_argument("--min", type=int, default=4, help="min length for bare-ASCII runs (default: 4)")
    pst.set_defaults(func=cmd_blob_strings)

    ph = sub.add_parser("blob-hex", help="hex-dump blob")
    ph.add_argument("serial", type=int)
    ph.add_argument("--start", type=int, default=0)
    ph.add_argument("--len", type=int, default=0, help="0 = until end")
    ph.set_defaults(func=cmd_blob_hex)

    pr = sub.add_parser("blob-replace", help="replace exact bytes in a blob (same length)")
    pr.add_argument("serial", type=int)
    pr.add_argument("--find", required=True, help="hex bytes to find")
    pr.add_argument("--replace", required=True, help="hex bytes to write (must match find length)")
    pr.add_argument("--all", action="store_true", help="replace every occurrence (default: must be unique)")
    pr.add_argument("--write", action="store_true")
    pr.set_defaults(func=cmd_blob_replace)

    sub.add_parser("backup", help="copy world.db to a timestamped backup file").set_defaults(func=cmd_backup)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
