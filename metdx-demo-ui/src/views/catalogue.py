import flet as ft
from flet import Page, TextField, ListView
try:
    from pyodide.http import pyfetch as _pyfetch
    _is_pyodide = True
except ModuleNotFoundError:
    import httpx
    _is_pyodide = False
from dataclasses import field
import json
import os
from .record import RecordView

# GDC_ENDPOINT = "https://f0d0ef280f8c.ngrok-free.app/collections/wis2-discovery-metadata/items"
GDC_ENDPOINT = (
    "https://wis2-gdc.weather.gc.ca/collections/wis2-discovery-metadata/items"
)


def CatalogueView(page: ft.Page, local_fixture: str | None = None):

    page.theme_mode = ft.ThemeMode.LIGHT

    async def _fetch_json(url: str) -> dict:
        if _is_pyodide:
            response = await _pyfetch(url, method="GET")
            return await response.json()
        else:
            async with httpx.AsyncClient() as client:
                response = await client.get(url, timeout=10)
                return response.json()

    async def on_click_record(e, record):
        print(f"[catalogue] on_click_record: {record.get('id')}")
        record_view, check_endpoints = RecordView(page, record)
        print(f"[catalogue] RecordView built, appending to page.views (currently {len(page.views)})")
        page.views.append(record_view)
        page.update()
        print("[catalogue] page.update() called, now calling check_endpoints")
        await check_endpoints(None)
        print("[catalogue] check_endpoints done")

    @ft.control
    class SearchResult(ft.Container):
        record: dict = field(default_factory=dict)

        def init(self):

            props = self.record.get("properties", {})
            title_text = props.get("title", "No Title")
            desc_text = props.get("description", "No description")
            keywords = props.get("keywords", [])

            self.padding = 10
            self.border_radius = 5
            self.border = ft.Border.all(1, ft.Colors.GREY)
            self.bgcolor = ft.Colors.GREY_50

            # Title
            title_control = ft.Text(
                value=title_text,
                weight=ft.FontWeight.BOLD,
                size=16,
                max_lines=1,
                overflow=ft.TextOverflow.ELLIPSIS,
            )

            # Description
            desc_control = ft.Text(
                value=desc_text,
                color=ft.Colors.GREY_800,
                size=12,
                max_lines=1,
                overflow=ft.TextOverflow.ELLIPSIS,
            )

            # Tags
            tags_row = ft.Row(wrap=True, spacing=5)
            for tag in keywords[:5]:
                tags_row.controls.append(
                    ft.Container(
                        content=ft.Text(tag, size=10, color=ft.Colors.WHITE),
                        bgcolor=ft.Colors.BLUE_GREY_600,
                        padding=ft.Padding.symmetric(horizontal=8, vertical=2),
                        border_radius=10,
                    )
                )

            # API badges (EDR / Maps) — start as loading indicators
            self._edr_badge = ft.Container(
                content=ft.Text("EDR", size=9, color=ft.Colors.WHITE),
                bgcolor=ft.Colors.GREY_400,
                padding=ft.Padding.symmetric(horizontal=6, vertical=2),
                border_radius=8,
                visible=False,
            )
            self._map_badge = ft.Container(
                content=ft.Text("Maps", size=9, color=ft.Colors.WHITE),
                bgcolor=ft.Colors.GREY_400,
                padding=ft.Padding.symmetric(horizontal=6, vertical=2),
                border_radius=8,
                visible=False,
            )
            self._query_types_row = ft.Row(spacing=3, wrap=True, visible=False)
            badges_row = ft.Row(
                controls=[self._edr_badge, self._map_badge],
                spacing=4,
            )

            async def _on_click(e, r=self.record):
                await on_click_record(e, r)
            self.on_click = _on_click

            self.content = ft.Column(controls=[
                ft.Row(controls=[ft.Column(controls=[title_control, desc_control], expand=True), badges_row], vertical_alignment=ft.CrossAxisAlignment.START),
                tags_row,
            ])

        async def check_apis(self):
            """Check collection links for EDR/Maps support."""
            record_links = self.record.get("links", [])
            OGC_MAP_REL = "http://www.opengis.net/def/rel/ogc/1.0/map"

            for link in record_links:
                if link.get("rel") != "collection":
                    continue
                href = link.get("href", "")
                link_type = link.get("type", "")
                if not ("json" in link_type or href.endswith("?f=json") or "/collections/" in href):
                    continue
                url = href if "?f=json" in href else (href + "?f=json" if "?" not in href else href + "&f=json")
                try:
                    data = await _fetch_json(url)
                except Exception:
                    continue

                if data.get("data_queries"):
                    self._edr_badge.bgcolor = ft.Colors.BLUE
                    self._edr_badge.visible = True

                for lnk in data.get("links", []):
                    if lnk.get("rel") == OGC_MAP_REL:
                        self._map_badge.bgcolor = ft.Colors.GREEN
                        self._map_badge.visible = True
                        break

            page.update()

    async def on_search(e):
        try:
            if local_fixture:
                # Load from local JSON file — search is client-side substring match
                with open(local_fixture, "r") as f:
                    data = json.load(f)
                q = (search_bar.value or "").lower()
                if q:
                    data["features"] = [
                        feat for feat in data.get("features", [])
                        if q in json.dumps(feat).lower()
                    ]
                    data["numberMatched"] = len(data["features"])
            else:
                url = f"{GDC_ENDPOINT}?q={search_bar.value}"
                if _is_pyodide:
                    response = await _pyfetch(url, method="GET")
                    data = await response.json()
                else:
                    async with httpx.AsyncClient() as client:
                        response = await client.get(url)
                    data = response.json()

            number_of_results = data.get("numberMatched", 0)
            results = data.get("features", [])

            search_results.controls.clear()
            search_results.controls.append(
                ft.Text(
                    f"Found {number_of_results} results for '{search_bar.value}'",
                    weight=ft.FontWeight.BOLD,
                )
            )

            for item in results:
                search_results.controls.append(SearchResult(record=item))

            search_results.visible = True
            page.update()

            # Async check API badges for each result
            for ctrl in search_results.controls:
                if isinstance(ctrl, SearchResult):
                    await ctrl.check_apis()

        except Exception as ex:
            page.show_dialog(
                ft.SnackBar(
                    ft.Text(f"Error during search: {ex}"),
                    bgcolor=ft.Colors.RED,
                    action="Dismiss",
                )
            )

    search_bar = TextField(
        hint_text="Welcome...",
        autofocus=True,
        on_submit=on_search,
        align=ft.Alignment.CENTER,
        width=600,
    )

    search_results = ListView(expand=True, spacing=10, padding=20, visible=False)

    layout = ft.Column(
        controls=[search_bar, search_results],
        alignment=ft.MainAxisAlignment.CENTER,
        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
        expand=True,
    )

    return ft.View(route="/", controls=[layout])
