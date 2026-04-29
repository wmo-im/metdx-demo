import flet as ft
import os
from views.catalogue import CatalogueView

# Set METDX_TEST=1 to load the local polytope fixture
# instead of hitting the live WIS2 GDC endpoint.
# e.g.  METDX_TEST=1 flet run
TEST_MODE = os.environ.get("METDX_TEST") == "1"

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
