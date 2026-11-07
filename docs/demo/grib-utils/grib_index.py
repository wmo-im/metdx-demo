#!/usr/bin/env python3
"""Summarise an ECMWF open-data GRIB index file, without reading the GRIB file.

The index is JSON Lines: one object per GRIB message, holding the message's
MARS keys (param, levelist, step, ...) and its byte range in the GRIB file
(_offset, _length). Output is laid out like grib_inspect.py so the two can
be compared.

Examples:
    python grib_index.py file.index.json
    python grib_index.py file.index.json --list
    python grib_index.py file.index.json --list --param t u --level 850 500
"""
import argparse
import json
from collections import Counter, defaultdict

# MARS keys that describe the whole file rather than individual fields
FILE_KEYS = ["class", "stream", "type", "expver", "domain"]


def level_sort_key(level):
    """Sort numeric levels by value (1000 after 925), anything else afterwards."""
    try:
        return (0, float(level), "")
    except (TypeError, ValueError):
        return (1, 0.0, str(level))


def read_index(path):
    entries = []
    with open(path) as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise SystemExit(f"{path}:{lineno}: not valid JSON ({e})")
    return entries


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("index", help="path to a GRIB index file (JSON Lines)")
    p.add_argument("--list", action="store_true",
                   help="also list every message with its byte range")
    p.add_argument("--param", nargs="+", metavar="PARAM",
                   help="limit --list to these params (e.g. t u v)")
    p.add_argument("--level", nargs="+", metavar="LEVEL",
                   help="limit --list to these levels (e.g. 850 500)")
    args = p.parse_args()

    entries = read_index(args.index)
    if not entries:
        raise SystemExit("index is empty")
    print(f"Index:    {args.index}")
    print(f"Messages: {len(entries)}\n")

    # Time / level-type combinations
    combos = Counter((e.get("date"), e.get("time"), e.get("step"), e.get("levtype"))
                     for e in entries)
    print("Date      Time  Step  LevelType  Messages")
    for (d, t, s, lt), n in sorted(combos.items(), key=lambda kv: str(kv[0])):
        print(f"{d!s:<9} {t!s:>4}  {s!s:>4}  {lt!s:<9}  {n}")

    # File-wide keys
    print("\nFile-wide MARS keys:")
    for k in FILE_KEYS:
        values = sorted({str(e.get(k)) for e in entries})
        print(f"  {k:<36} {', '.join(values)}")

    # Byte layout, checked from the index alone
    ranges = sorted((e["_offset"], e["_length"]) for e in entries)
    total = sum(length for _, length in ranges)
    end = ranges[-1][0] + ranges[-1][1]
    gaps = sum(1 for (o1, l1), (o2, _) in zip(ranges, ranges[1:]) if o2 > o1 + l1)
    overlaps = sum(1 for (o1, l1), (o2, _) in zip(ranges, ranges[1:]) if o2 < o1 + l1)
    print("\nByte layout:")
    print(f"  {'first offset':<36} {ranges[0][0]}")
    print(f"  {'sum of message lengths':<36} {total:,} bytes")
    print(f"  {'expected GRIB file size':<36} {end:,} bytes")
    print(f"  {'gaps / overlaps':<36} {gaps} / {overlaps}")
    print(f"  {'message size min / max':<36} "
          f"{min(l for _, l in ranges):,} / {max(l for _, l in ranges):,} bytes")

    # One row per parameter, in order of first appearance
    levels = defaultdict(set)
    nbytes = Counter()
    for e in entries:
        levels[e.get("param")].add(e.get("levelist"))
        nbytes[e.get("param")] += e["_length"]
    print(f"\nParameters ({len(levels)}):")
    print(f"  {'param':<7} {'bytes':>13}  levels")
    for prm, lv in levels.items():
        lv_text = ", ".join(str(x) for x in sorted(lv, key=level_sort_key))
        print(f"  {prm!s:<7} {nbytes[prm]:>13,}  {lv_text}")

    if args.list:
        rows = [e for e in entries
                if (not args.param or e.get("param") in args.param)
                and (not args.level or str(e.get("levelist")) in args.level)]
        print(f"\nMessages ({len(rows)}), in file order:")
        print(f"  {'#':>4} {'param':<7} {'level':>6} {'offset':>13} {'length':>11}  curl range")
        order = {id(e): i for i, e in enumerate(sorted(entries, key=lambda x: x["_offset"]), 1)}
        for e in sorted(rows, key=lambda x: x["_offset"]):
            o, n = e["_offset"], e["_length"]
            print(f"  {order[id(e)]:>4} {e.get('param')!s:<7} {e.get('levelist')!s:>6} "
                  f"{o:>13,} {n:>11,}  -r {o}-{o + n - 1}")
        if not rows:
            print("  (no matching messages)")


if __name__ == "__main__":
    main()
