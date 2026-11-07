#!/usr/bin/env python3
"""Show the grid geometry of a GRIB file using earthkit-data.

Prints the earth shape, grid size, first/last grid points and spacing as
written in the GRIB header, and the longitudes earthkit actually assigns to
the data columns. Useful for questions like "does this grid start at 0° or
-180°?". Note that 180° and -180° are the same meridian: earthkit reports
longitudes in the -180..180 range even when the header says 180.

Examples:
    python grib_grid.py file.grib2
    python grib_grid.py file.grib2 --message 5
"""
import argparse

import earthkit.data as ekd

KEYS = ["gridType", "shapeOfTheEarth", "radius", "Ni", "Nj",
        "latitudeOfFirstGridPointInDegrees", "longitudeOfFirstGridPointInDegrees",
        "latitudeOfLastGridPointInDegrees", "longitudeOfLastGridPointInDegrees",
        "iDirectionIncrementInDegrees", "jDirectionIncrementInDegrees"]


def meta(field, key):
    """Return a GRIB key, or 'n/a' if the message doesn't have it."""
    try:
        return field.metadata(key)
    except Exception:
        return "n/a"


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("file", help="path to a GRIB file")
    p.add_argument("--message", type=int, default=1,
                   help="which message to describe, counting from 1 (default: 1)")
    args = p.parse_args()

    fields = list(ekd.from_source("file", args.file).to_fieldlist())
    if not 1 <= args.message <= len(fields):
        raise SystemExit(f"--message must be between 1 and {len(fields)}")
    f = fields[args.message - 1]

    print(f"File:    {args.file}")
    print(f"Message: {args.message} of {len(fields)} "
          f"({meta(f, 'shortName')} at level {meta(f, 'level')})\n")
    print("GRIB header:")
    for k in KEYS:
        print(f"  {k:<36} {meta(f, k)}")

    lats = f.geography.latitudes().reshape(f.shape)
    lons = f.geography.longitudes().reshape(f.shape)
    print("\nCoordinates earthkit assigns to the data array:")
    print(f"  {'first / second / last longitude':<36} "
          f"{lons[0, 0]:g} / {lons[0, 1]:g} / {lons[0, -1]:g}")
    print(f"  {'first / last latitude':<36} {lats[0, 0]:g} / {lats[-1, 0]:g}")

    # Are all messages on the same grid?
    grids = {tuple(meta(x, k) for k in KEYS) for x in fields}
    same = "yes" if len(grids) == 1 else f"no ({len(grids)} different grids)"
    print(f"\nAll {len(fields)} messages on this grid: {same}")


if __name__ == "__main__":
    main()
