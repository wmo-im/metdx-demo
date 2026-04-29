import flet as ft
from flet import Page, TextField, ListView
from dataclasses import field
from datetime import datetime, timezone

try:
    from pyodide.http import pyfetch as _pyfetch
    _is_pyodide = True
except ModuleNotFoundError:
    import httpx
    _is_pyodide = False

from .record import RecordView

POLYTOPE_BASE = "https://polytope-edr.lumi.apps.dte.destination-earth.eu"
POLYTOPE_COLLECTIONS = f"{POLYTOPE_BASE}/collections?f=json"


async def _fetch_json(url: str) -> dict:
    if _is_pyodide:
        response = await _pyfetch(url, method="GET")
        return await response.json()
    else:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=10)
            return response.json()


def _collection_to_record(col: dict) -> dict:
    """Map a polytope OGC API collection to a WIS2-style record dict
    so RecordView can consume it without modification."""

    col_id = col.get("id", "unknown")
    title = col.get("title", col_id)
    description = col.get("description", "No description available.")
    keywords = col.get("keywords", [])

    # Spatial extent -> geometry
    extent = col.get("extent", {})
    spatial = extent.get("spatial", {})
    bbox = spatial.get("bbox", [[-180, -90, 180, 90]])[0]  # first bbox
    # Build a Polygon from bbox [minx, miny, maxx, maxy]
    minx, miny, maxx, maxy = bbox
    geometry = {
        "type": "Polygon",
        "coordinates": [[
            [minx, miny],
            [maxx, miny],
            [maxx, maxy],
            [minx, maxy],
            [minx, miny],
        ]],
    }

    # Temporal extent
    temporal = extent.get("temporal", {})
    interval = temporal.get("interval", [[None, None]])[0]
    time_start = interval[0] or ""
    time_end = interval[1] or ".."

    # Parameter names -> keywords supplement
    param_names = list(col.get("parameter_names", {}).keys())
    all_keywords = list(set(keywords + param_names))

    # Build links: EDR collection self link as rel=data
    collection_url = f"{POLYTOPE_BASE}/collections/{col_id}?f=json"
    links = [
        {
            "rel": "data",
            "type": "application/json",
            "href": collection_url,
            "title": f"OGC API Collection JSON for {title}",
        }
    ]

    # Add any map links from the original collection links
    OGC_MAP_REL = "http://www.opengis.net/def/rel/ogc/1.0/map"
    for lnk in col.get("links", []):
        if lnk.get("rel") == OGC_MAP_REL:
            links.append(lnk)

    created_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "id": f"urn:dte:polytope:{col_id}",
        "conformsTo": ["http://wis.wmo.int/spec/wcmp/2/conf/core"],
        "type": "Feature",
        "time": {
            "interval": [time_start, time_end],
        },
        "geometry": geometry,
        "properties": {
            "type": "dataset",
            "identifier": f"urn:dte:polytope:{col_id}",
            "title": title,
            "description": description,
            "keywords": all_keywords,
            "themes": [],
            "contacts": [
                {
                    "organization": "Destination Earth / ECMWF",
                    "emails": [{"value": ""}],
                    "phones": [],
                    "roles": ["host"],
                }
            ],
            "created": created_str,
            "rights": "Destination Earth Data",
            "wmo:dataPolicy": "core",
        },
        "links": links,
    }


def PolytopeCatalogueView(page: ft.Page):

    page.theme_mode = ft.ThemeMode.LIGHT
    page.update()

    async def on_click_record(e, record):
        record_view, check_endpoints = RecordView(page, record)
        page.views.append(record_view)
        page.update()
        await check_endpoints(None)

    @ft.control
    class CollectionResult(ft.Container):
        record: dict = field(default_factory=dict)

        def init(self):
            props = self.record.get("properties", {})
            title_text = props.get("title", "No Title")
            desc_text = props.get("description", "No description")
            keywords = props.get("keywords", [])

            self.padding = 10
            self.border_radius = 5
            self.border = ft.Border.all(1, ft.Colors.BLUE_GREY_200)
            self.bgcolor = ft.Colors.BLUE_GREY_50

            title_control = ft.Text(
                value=title_text,
                weight=ft.FontWeight.BOLD,
                size=16,
                max_lines=1,
                overflow=ft.TextOverflow.ELLIPSIS,
            )

            desc_control = ft.Text(
                value=desc_text,
                color=ft.Colors.GREY_800,
                size=12,
                max_lines=1,
                overflow=ft.TextOverflow.ELLIPSIS,
            )

            tags_row = ft.Row(wrap=True, spacing=5)
            for tag in keywords[:5]:
                tags_row.controls.append(
                    ft.Container(
                        content=ft.Text(tag, size=10, color=ft.Colors.WHITE),
                        bgcolor=ft.Colors.TEAL_700,
                        padding=ft.Padding.symmetric(horizontal=8, vertical=2),
                        border_radius=10,
                    )
                )

            async def _on_click(e, r=self.record):
                await on_click_record(e, r)

            self.on_click = _on_click
            self.content = ft.Column(controls=[title_control, desc_control, tags_row])

    results_list = ListView(expand=True, spacing=10, padding=20, visible=False)
    status_text = ft.Text("", size=14, weight=ft.FontWeight.BOLD)
    loading_ring = ft.ProgressRing(visible=False, width=24, height=24)

    async def load_collections(e=None):
        loading_ring.visible = True
        status_text.value = "Loading collections..."
        results_list.visible = False
        page.update()

        try:
            data = await _fetch_json(POLYTOPE_COLLECTIONS)
            collections = data.get("collections", [])

            results_list.controls.clear()
            status_text.value = f"{len(collections)} collection(s) available"

            for col in collections:
                record = _collection_to_record(col)
                results_list.controls.append(CollectionResult(record=record))

            results_list.visible = True

        except Exception as ex:
            status_text.value = f"Error loading collections: {ex}"

        loading_ring.visible = False
        page.update()

    header_row = ft.Row(
        controls=[
            ft.Text("Polytope EDR Collections", size=20, weight=ft.FontWeight.BOLD),
            loading_ring,
        ],
        vertical_alignment=ft.CrossAxisAlignment.CENTER,
        spacing=10,
    )

    layout = ft.Column(
        controls=[header_row, status_text, results_list],
        alignment=ft.MainAxisAlignment.START,
        horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        expand=True,
    )

    view = ft.View(
        route="/polytope",
        padding=20,
        controls=[
            ft.AppBar(title=ft.Text("Polytope EDR")),
            layout,
        ],
    )

    # Kick off the load — caller must await this
    return view, load_collections
