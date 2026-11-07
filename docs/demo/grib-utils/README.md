# grib-utils

Small command-line tools for looking at GRIB files with ECMWF
[earthkit](https://github.com/ecmwf/earthkit):

- `grib_inspect.py` describes the contents of a GRIB file
- `grib_plot.py` draws one field on a world map
- `grib_grid.py` shows a GRIB file's grid geometry (where it starts, spacing, earth shape)
- `grib_index.py` summarises an ECMWF open-data index file, without reading the GRIB file

They were written for, and tested against, ECMWF IFS open-data
pressure-level files such as
`https://data.ecmwf.int/forecasts/YYYYMMDD/HHz/ifs/0p1/oper/YYYYMMDDHH0000-0h-oper-fc-pl.grib2`,
the form used in ECMWF's WIS2 notifications (`…/ecpds/home/opendata/…` serves the same files).

`grib_index.py` uses only the Python standard library, so it runs with any
`python3`. The other scripts need the venv described below.

## Setup

Tested with Python 3.14 on macOS. Unzip the folder
anywhere, then from inside it:

```
cd grib-utils
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

`requirements.txt` pins earthkit-data 1.3.1 and earthkit-plots 1.0.4, the
versions the scripts were tested with. `grib_plot.py` patches earthkit-plots
1.0.4 internals (see "Known earthkit-plots 1.0.4 issues" below), so other
versions may not work.

The packages live in `.venv`, so the scripts must be run with that venv's
Python. Running them with the system `python3` fails with
`ModuleNotFoundError: No module named 'earthkit'`. Either activate the venv
once per terminal session:

```
source .venv/bin/activate
python3 grib_inspect.py file.grib2
```

or call the venv's Python directly:

```
.venv/bin/python grib_inspect.py file.grib2
```

The examples below assume the venv is active.

## `grib_inspect.py`: describe a GRIB file

```
grib_inspect.py FILE [--stats LEVEL ...] [--param SHORTNAME ...]
```

| Argument | Meaning |
|---|---|
| `FILE` | GRIB file to read (required) |
| `--stats 850 500 …` | Also print min, mean and max for every field on these levels |
| `--param t u …` | Limit `--stats` to these parameters |

Output:

- the number of messages
- the date, time, step and level-type combinations in the file
- the grid and encoding keys from the first message
- one row per parameter: shortName, paramId, units, name and levels
- with `--stats`, min, mean and max per field; the mean is weighted by
  cos(latitude) so polar grid points don't count too much

Examples:

```
python3 grib_inspect.py file.grib2                          # summary only
python3 grib_inspect.py file.grib2 --stats 850 500 250      # + stats, all params
python3 grib_inspect.py file.grib2 --stats 500 --param t gh # + stats, t and gh at 500 hPa
```

## `grib_plot.py`: draw one field on a world map

```
grib_plot.py FILE OUTPUT [--param P] [--level L] [--units U] [--style auto|generic] [--title T] [--dpi N]
```

| Argument | Default | Meaning |
|---|---|---|
| `FILE` | – | GRIB file to read (required) |
| `OUTPUT` | – | Image to write, e.g. `map.png` (required) |
| `--param` | `t` | Parameter shortName, e.g. `t`, `u`, `v`, `w`, `q`, `r`, `gh`, `z`, `vo` or `d` in pressure-level files; `2t`, `msl`, `10u`, `tp` … in surface files (`grib_inspect.py` lists them) |
| `--level` | `850` | Level: hPa for pressure-level fields; for surface-file fields, the GRIB `level` (`2` for `2t`, `10` for `10u`, `0` for `msl`) |
| `--units` | °C for fields stored in kelvin (`t`, `2t`, `2d`, `skt`, …), otherwise native | Units to convert to, e.g. `km/h`, `g/kg`, `K` |
| `--style` | `auto` | `auto` uses earthkit's built-in colours; `generic` uses a colour scale fitted to the data. Requesting non-default units switches to `generic` automatically. |
| `--title` | from metadata | Custom title (earthkit-plots format keys such as `{time:%Y-%m-%d}` are allowed) |
| `--dpi` | `150` | Image resolution |

Examples:

```
python3 grib_plot.py file.grib2 t850.png                                         # 850 hPa temperature, °C
python3 grib_plot.py file.grib2 gh500.png --param gh --level 500                 # 500 hPa heights
python3 grib_plot.py file.grib2 u250.png --param u --level 250 --style generic   # jet stream, m/s
python3 grib_plot.py file.grib2 q850.png --param q --level 850 --units g/kg
python3 grib_plot.py sfc.grib2 t2m.png --param 2t --level 2                     # surface file: 2 m temperature, °C
```

Titles name the level only where it adds something: `Temperature at 850 hPa`, but just
`2 metre temperature` or `Mean sea level pressure` for single-level fields.

### Coastline download

The first plot downloads coastline data (via cartopy). If it fails with
`CERTIFICATE_VERIFY_FAILED`, which is common with the python.org macOS
installer, run this first:

```
export SSL_CERT_FILE=$(python3 -c "import certifi; print(certifi.where())")
```

or run `Install Certificates.command` from your Python install folder once.

## `grib_grid.py`: show the grid geometry

```
grib_grid.py FILE [--message N]
```

| Argument | Default | Meaning |
|---|---|---|
| `FILE` | – | GRIB file to read (required) |
| `--message` | `1` | Which message to describe, counting from 1 |

Prints:

- the grid keys from the GRIB header: grid type, earth shape and radius,
  grid size, first and last grid points, and spacing
- the longitudes and latitudes earthkit assigns to the data array
- whether every message in the file is on the same grid

Use it for questions like "does this grid start at 0° or −180°?". For the
ECMWF IFS 0.1° open-data files the header says the first longitude is
**180°** and the last 179.9°. earthkit reports the same columns as −180 …
179.9, because 180° and −180° are the same meridian. So the grid starts at
the dateline, not at Greenwich.

```
python3 grib_grid.py file.grib2
python3 grib_grid.py file.grib2 --message 5
```

## `grib_index.py`: summarise a GRIB index file

```
grib_index.py INDEX [--list] [--param PARAM ...] [--level LEVEL ...]
```

| Argument | Meaning |
|---|---|
| `INDEX` | Index file to read (required) |
| `--list` | Also list every message with its offset, length and a `curl -r` byte range |
| `--param t u …` | Limit `--list` to these params |
| `--level 850 500 …` | Limit `--list` to these levels |

ECMWF open data publishes an index next to each GRIB file. It is JSON Lines:
one object per GRIB message, holding that message's MARS keys (`param`,
`levelist`, `step`, `date`, `time`, …) and its position in the GRIB file
(`_offset`, `_length`).

Output, laid out like `grib_inspect.py` for comparison:

- the number of messages (should equal `grib_inspect.py`'s count)
- the date, time, step and level-type combinations
- the file-wide MARS keys (`class`, `stream`, `type`, `expver`, `domain`)
- the byte layout: total size, and any gaps or overlaps between messages.
  The expected GRIB file size should equal the real file's size.
- one row per param with its levels and total bytes

Examples:

```
python3 grib_index.py file.index.json
python3 grib_index.py file.index.json --list --param t --level 850
```

The `curl range` column downloads a single field instead of the whole file:

```
curl -r 90155398-91294975 -o t850.grib2 https://data.ecmwf.int/…/20261104060000-0h-oper-fc-pl.grib2
```

### Comparing with `grib_inspect.py`

The index holds MARS keys; the GRIB file holds GRIB keys. They describe the
same things in different notation:

| `grib_index.py` | `grib_inspect.py` |
|---|---|
| `param` (`t`) | `shortName` (`t`); name, units and paramId are only in the GRIB file |
| `levelist` | `level` |
| `levtype` `pl` | `typeOfLevel` `isobaricInhPa` |
| `time` `0600` | `dataTime` `600` |
| `class` / `stream` / `type` | `marsClass` / `marsStream` / `marsType` |

Grid, packing and data values are only in the GRIB file.

## Known earthkit-plots 1.0.4 issues

`grib_plot.py` works around these:

- **Unit strings containing spaces** (`m s**-1`, `Pa s**-1`, `kg kg**-1`)
  make earthkit-plots crash with `DefinitionSyntaxError: unknown operator '.'`.
  The script patches earthkit-plots' unit parsing at start-up. Remove the
  `_patch_unit_parsing()` function once this is fixed upstream.
- **Unit conversion doesn't rescale the built-in styles**, so e.g. wind in
  km/h is drawn against the m/s contour levels. Requesting non-default units
  therefore switches to the generic style.
- **Converted units can be mislabelled** (g/kg shows as "dimensionless"),
  so the legend label is set explicitly when `--units` is given.
- **The built-in u/v wind style stops at ±24 m/s**, which saturates
  upper-level jets. Use `--style generic` for 250 hPa winds.

`FieldList.sel()` doesn't match on `shortName`/`level` in earthkit-data 1.3.1,
so both scripts filter fields by their metadata instead.

Both scripts also print their usage with `--help`.

## Changes

- **2026-11-06:** the example URL now uses `data.ecmwf.int/forecasts/…`, as in ECMWF's WIS2 notifications. `grib_plot.py`:
  - Fields stored in kelvin (`2t`, `2d`, `skt`, `mx2t3`, `sot`, …) are now shown in °C by default with earthkit's own temperature style. Before, only `t` was.
  - Titles name the level only where it adds something: `2 metre temperature`, not `2 metre temperature at heightAboveGround 2`.
  - The README now covers plotting fields from surface files.
- **2026-11-05:** first shared version.
