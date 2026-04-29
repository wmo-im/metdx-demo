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

            async def _on_click(e, r=self.record):
                await on_click_record(e, r)
            self.on_click = _on_click

            self.content = ft.Column(controls=[title_control, desc_control, tags_row])

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
