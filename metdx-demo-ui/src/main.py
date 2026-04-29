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
FIXTURE_PATH = os.path.join(_HERE, "data", "polytope_items.json")


async def main(page: ft.Page):
    page.title = "WIS2 Catalogue"

    fixture = FIXTURE_PATH if TEST_MODE else None

    async def view_pop(view):
        page.views.pop()
        page.update()

    page.on_view_pop = view_pop

    catalogue = CatalogueView(page, local_fixture=fixture)
    page.views.append(catalogue)
    page.update()


ft.run(main)
