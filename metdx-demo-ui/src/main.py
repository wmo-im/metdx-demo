import flet as ft
import os
import sys
import traceback
from views.catalogue import CatalogueView

_LOG = open("/tmp/metdx_debug.log", "w", buffering=1)
def log(msg):
    _LOG.write(msg + "\n")
    _LOG.flush()
    print(msg, flush=True)

log("module loaded")

# Set METDX_TEST=1 to load the local polytope fixture
# instead of hitting the live WIS2 GDC endpoint.
# e.g.  METDX_TEST=1 flet run ./main.py
TEST_MODE = os.environ.get("METDX_TEST") == "1"

_HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_PATH = os.path.join(_HERE, "data", "polytope_items.json")


async def main(page: ft.Page):
    try:
        log("[main] main() called")
        page.title = "WIS2 Catalogue"

        fixture = FIXTURE_PATH if TEST_MODE else None

        async def view_pop(view):
            log(f"[main] view_pop, views: {len(page.views)}")
            page.views.pop()
            page.update()

        page.on_view_pop = view_pop

        log("[main] building CatalogueView")
        catalogue = CatalogueView(page, local_fixture=fixture)
        log(f"[main] CatalogueView built: {catalogue}")
        page.views.append(catalogue)
        log(f"[main] calling page.update(), views={len(page.views)}")
        page.update()
        log("[main] done")
    except Exception as ex:
        log(f"[main] ERROR: {ex}")
        log(traceback.format_exc())


log("Starting Flet app...")
if TEST_MODE:
    log(f"TEST MODE: loading local fixture {FIXTURE_PATH}")

ft.run(main)
