import flet as ft
import os

try:
    import pyodide  # noqa: F401
    _is_pyodide = True
except ModuleNotFoundError:
    _is_pyodide = False

from views.catalogue import CatalogueView

# Use the local fixture when:
#   - METDX_TEST=1 env var is set (native desktop), or
#   - running in the browser via pyodide (no live GDC available from WASM)
TEST_MODE = os.environ.get("METDX_TEST") == "1" or _is_pyodide

_HERE = os.path.dirname(os.path.abspath(__file__))
_RECORDS_DIR = os.path.join(_HERE, "data", "records")

# Each fixture is a single OGC API - Records record (a GeoJSON Feature) in its
# own file. Listed explicitly so it works both natively and in the browser
# (pyodide), where directory listing of bundled assets is unreliable.
RECORD_FILES = [
    os.path.join(_RECORDS_DIR, "ecmwf-destine-forecast.json"),
    os.path.join(_RECORDS_DIR, "ecmwf-opendata.json"),
]


async def main(page: ft.Page):
    page.title = "WIS2 Catalogue"

    records = RECORD_FILES if TEST_MODE else None

    async def view_pop(view):
        page.views.pop()
        page.update()

    page.on_view_pop = view_pop

    catalogue = CatalogueView(page, local_records=records)
    page.views.append(catalogue)
    page.update()


ft.run(main)
