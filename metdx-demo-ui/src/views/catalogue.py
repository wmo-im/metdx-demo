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

PAGE_SIZE = 10


def CatalogueView(page: ft.Page, local_fixture: str | None = None):

    page.theme_mode = ft.ThemeMode.LIGHT

    # --- Pagination state ---
    state = {"query": "", "offset": 0, "total": 0}

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

            # API badges — EDR (blue) and OGC Maps (green), shown once detected.
            self._edr_badge = ft.Container(
                content=ft.Text("EDR", size=9, color=ft.Colors.WHITE),
                bgcolor=ft.Colors.BLUE,
                padding=ft.Padding.symmetric(horizontal=8, vertical=3),
                border_radius=8,
                visible=False,
            )
            self._maps_badge = ft.Container(
                content=ft.Text("OGC Maps", size=9, color=ft.Colors.WHITE),
                bgcolor=ft.Colors.GREEN,
                padding=ft.Padding.symmetric(horizontal=8, vertical=3),
                border_radius=8,
                visible=False,
            )
            self._badges_row = ft.Row(
                controls=[self._edr_badge, self._maps_badge],
                spacing=4,
            )

            # Row of EDR query-type chips (position, area, ...), shown when EDR found
            self._query_types_row = ft.Row(wrap=True, spacing=4, visible=False)

            async def _on_click(e, r=self.record):
                await on_click_record(e, r)
            self.on_click = _on_click

            self.content = ft.Column(controls=[
                ft.Row(controls=[ft.Column(controls=[title_control, desc_control], expand=True), self._badges_row], vertical_alignment=ft.CrossAxisAlignment.START),
                self._query_types_row,
                tags_row,
            ])

        async def check_apis(self):
            """Check collection links for EDR/Maps support and advertise query types."""
            record_links = self.record.get("links", [])
            OGC_MAP_REL = "http://www.opengis.net/def/rel/ogc/1.0/map"
            edr_query_types: list[str] = []
            has_edr = False
            has_maps = False

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

                data_queries = data.get("data_queries")
                if data_queries:
                    has_edr = True
                    for qt in data_queries.keys():
                        if qt not in edr_query_types:
                            edr_query_types.append(qt)

                for lnk in data.get("links", []):
                    if lnk.get("rel") == OGC_MAP_REL:
                        has_maps = True
                        break

            self._edr_badge.visible = has_edr
            self._maps_badge.visible = has_maps

            if edr_query_types:
                self._query_types_row.controls.clear()
                self._query_types_row.controls.append(
                    ft.Text("EDR queries:", size=10, color=ft.Colors.GREY_600)
                )
                for qt in edr_query_types:
                    self._query_types_row.controls.append(
                        ft.Container(
                            content=ft.Text(qt, size=9, color=ft.Colors.WHITE),
                            bgcolor=ft.Colors.BLUE_700,
                            padding=ft.Padding.symmetric(horizontal=6, vertical=2),
                            border_radius=8,
                        )
                    )
                self._query_types_row.visible = True

            page.update()

    async def _load_results(query: str, offset: int):
        """Fetch a page of results (from live GDC or the local fixture) and render them."""
        try:
            if local_fixture:
                with open(local_fixture, "r") as f:
                    data = json.load(f)
                q = (query or "").lower()
                feats = data.get("features", [])
                if q:
                    feats = [feat for feat in feats if q in json.dumps(feat).lower()]
                total = len(feats)
                results = feats[offset:offset + PAGE_SIZE]
            else:
                url = f"{GDC_ENDPOINT}?limit={PAGE_SIZE}&offset={offset}"
                if query:
                    url += f"&q={query}"
                data = await _fetch_json(url)
                total = data.get("numberMatched", 0)
                results = data.get("features", [])

            state["query"] = query
            state["offset"] = offset
            state["total"] = total

            search_results.controls.clear()
            if query:
                header = f"Found {total} results for '{query}'"
            else:
                header = f"Showing latest datasets ({total} available)"
            search_results.controls.append(
                ft.Text(header, weight=ft.FontWeight.BOLD)
            )

            for item in results:
                search_results.controls.append(SearchResult(record=item))

            # Pagination controls
            start = offset + 1 if results else 0
            end = offset + len(results)
            page_info.value = f"{start}–{end} of {total}"
            prev_btn.disabled = offset <= 0
            next_btn.disabled = end >= total
            pagination_row.visible = total > 0

            search_results.visible = True
            page.update()

            for ctrl in search_results.controls:
                if isinstance(ctrl, SearchResult):
                    await ctrl.check_apis()

        except Exception as ex:
            page.show_dialog(
                ft.SnackBar(
                    ft.Text(f"Error loading results: {ex}"),
                    bgcolor=ft.Colors.RED,
                    action="Dismiss",
                )
            )

    async def on_search(e):
        await _load_results(search_bar.value or "", 0)

    async def on_prev(e):
        new_offset = max(0, state["offset"] - PAGE_SIZE)
        await _load_results(state["query"], new_offset)

    async def on_next(e):
        new_offset = state["offset"] + PAGE_SIZE
        await _load_results(state["query"], new_offset)

    search_bar = TextField(
        hint_text="Search datasets...",
        autofocus=True,
        on_submit=on_search,
        align=ft.Alignment.CENTER,
        width=600,
    )

    search_results = ListView(expand=True, spacing=10, padding=20, visible=False)

    page_info = ft.Text("", size=12, color=ft.Colors.GREY_700)
    prev_btn = ft.Button(content="Previous", icon=ft.Icons.CHEVRON_LEFT, on_click=on_prev)
    next_btn = ft.Button(content="Next", icon=ft.Icons.CHEVRON_RIGHT, on_click=on_next)
    pagination_row = ft.Row(
        controls=[prev_btn, page_info, next_btn],
        alignment=ft.MainAxisAlignment.CENTER,
        vertical_alignment=ft.CrossAxisAlignment.CENTER,
        spacing=12,
        visible=False,
    )

    async def _load_default(e=None):
        await _load_results("", 0)

    # Show the first page of datasets by default (no search required)
    page.run_task(_load_default)

    layout = ft.Column(
        controls=[search_bar, search_results, pagination_row],
        alignment=ft.MainAxisAlignment.CENTER,
        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
        expand=True,
    )

    return ft.View(route="/", controls=[layout])
