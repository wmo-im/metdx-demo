import flet as ft
from datetime import datetime

try:
    from pyodide.http import pyfetch as _pyfetch
    _is_pyodide = True
except ModuleNotFoundError:
    import httpx
    _is_pyodide = False

from .edr_map import EDRMapView
from .ogc_map import OGCMapView

async def _fetch_json(url: str) -> dict:
    if _is_pyodide:
        response = await _pyfetch(url, method="GET")
        return await response.json()
    else:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=10)
            return response.json()


def RecordView(page: ft.Page, record: dict):

    # Extract data from the record
    props = record.get("properties", {})
    title = props.get("title", "No Title")
    rec_id = record.get("id", "unknown-id")
    desc_text = props.get("description", "No description available.")
    rights = props.get("rights", "Unknown License")
    created_raw = props.get("created", "")
    data_policy = props.get("wmo:dataPolicy", "Unknown")
    keywords = props.get("keywords", [])

    # Contact Info
    contacts = props.get("contacts", [])
    if contacts:
        contact = contacts[0]
        org_name = contact.get("organization", "Unknown Organization")
        email = contact.get("emails", [{}])[0].get("value", "No email")
        phone = contact.get("phones", [{}])[0].get("value", "")
    else:
        org_name, email, phone = "Unknown", "N/A", ""

    # Format Date
    try:
        created_dt = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
        created_str = created_dt.strftime("%B %d, %Y")
    except ValueError:
        created_str = created_raw

    def meta_row(icon, label, value):
        return ft.Row(
            controls=[
                ft.Icon(icon, size=16, color=ft.Colors.GREY_500),
                ft.Text(f"{label}:", weight=ft.FontWeight.BOLD, size=12, color=ft.Colors.GREY_700, width=100),
                ft.Text(value, size=12, selectable=True, expand=True),
            ],
            vertical_alignment=ft.CrossAxisAlignment.CENTER,
        )

    metadata_card = ft.Column(
        controls=[
            meta_row(ft.Icons.BUSINESS, "Organization", org_name),
            meta_row(ft.Icons.POLICY, "License", rights),
            meta_row(ft.Icons.CALENDAR_TODAY, "Created", created_str),
            meta_row(ft.Icons.SHIELD, "Data Policy", data_policy),
            meta_row(ft.Icons.EMAIL, "Email", email),
        ] + ([meta_row(ft.Icons.PHONE, "Phone", phone)] if phone else [])
    )

    # Keywords
    tags_wrap = ft.Row(wrap=True, spacing=5)
    for tag in keywords:
        tags_wrap.controls.append(
            ft.Chip(
                label=ft.Text(tag, size=10),
                bgcolor=ft.Colors.BLUE_GREY_50,
                disabled=True,
            )
        )

    # MQTT links and data links (from record directly)
    links = record.get("links", [])
    mqtt_tile = ft.Container()
    collection_urls = []

    for link in links:
        rel = link.get("rel")
        if rel == "items":
            mqtt_tile = ft.ListTile(
                leading=ft.Icon(ft.Icons.NOTIFICATIONS_ACTIVE, color=ft.Colors.AMBER_800),
                title=ft.Text("Subscribe (AMQP/MQTT)"),
                subtitle=ft.Text(f"Channel: {link.get('channel', 'N/A')}"),
                trailing=ft.Icon(ft.Icons.CHEVRON_RIGHT, size=16),
                bgcolor=ft.Colors.SURFACE_CONTAINER_LOW,
                shape=ft.RoundedRectangleBorder(radius=8),
            )
        elif rel == "collection":
            href = link.get("href", "")
            link_type = link.get("type", "")
            if "json" in link_type or href.endswith("?f=json") or "/collections/" in href:
                url = href if "?f=json" in href else (href + "?f=json" if "?" not in href else href + "&f=json")
                collection_urls.append(url)

    # --- EDR / OGC Maps endpoint buttons ---
    # Start in loading/unknown state; update after async check.

    EDR_COLOR_ACTIVE = ft.Colors.BLUE
    MAP_COLOR_ACTIVE = ft.Colors.GREEN
    DISABLED_COLOR = ft.Colors.GREY_400

    edr_btn = ft.Button(
        content="EDR",
        icon=ft.Icons.DATA_EXPLORATION,
        bgcolor=DISABLED_COLOR,
        disabled=True,
        tooltip="Checking for EDR support..." if collection_urls else "No EDR endpoint available",
    )

    map_btn = ft.Button(
        content="OGC Maps",
        icon=ft.Icons.MAP,
        bgcolor=DISABLED_COLOR,
        disabled=True,
        tooltip="Checking for OGC Maps support..." if collection_urls else "No OGC Maps endpoint available",
    )

    endpoint_row = ft.Row(
        controls=[edr_btn, map_btn],
        spacing=10,
    )

    query_types_row = ft.Row(wrap=True, spacing=4, visible=False)

    async def check_endpoints(e):
        if not collection_urls:
            return

        from urllib.parse import urlparse

        edr_url = None
        edr_query_types = []
        map_url = None
        map_collection_url = None
        OGC_MAP_REL = "http://www.opengis.net/def/rel/ogc/1.0/map"

        for col_url in collection_urls:
            try:
                data = await _fetch_json(col_url)
            except Exception:
                continue

            # EDR: presence of data_queries key
            if not edr_url and data.get("data_queries"):
                edr_url = col_url
                edr_query_types = list(data["data_queries"].keys())

            # OGC Maps: link with map relation
            if not map_url:
                for lnk in data.get("links", []):
                    if lnk.get("rel") == OGC_MAP_REL:
                        raw = lnk.get("href", "")
                        if raw.startswith("/"):
                            parsed = urlparse(col_url)
                            raw = f"{parsed.scheme}://{parsed.netloc}{raw}"
                        map_url = raw
                        map_collection_url = col_url
                        break

        if edr_url:
            edr_btn.bgcolor = EDR_COLOR_ACTIVE
            edr_btn.disabled = False
            edr_btn.tooltip = "Query this EDR collection on a map"

            # Show available query types as chips
            if edr_query_types:
                query_types_row.controls.clear()
                query_types_row.controls.append(
                    ft.Text("Query types:", size=12, color=ft.Colors.GREY_700)
                )
                for qt in edr_query_types:
                    query_types_row.controls.append(
                        ft.Container(
                            content=ft.Text(qt, size=10, color=ft.Colors.WHITE),
                            bgcolor=ft.Colors.BLUE_700,
                            padding=ft.Padding.symmetric(horizontal=8, vertical=3),
                            border_radius=10,
                        )
                    )
                query_types_row.visible = True

            async def open_edr_map(e, url=edr_url, t=title):
                map_view, load_metadata = EDRMapView(page, url, t)
                page.views.append(map_view)
                page.update()
                await load_metadata()

            edr_btn.on_click = open_edr_map
        else:
            edr_btn.tooltip = "EDR not available for this collection"

        if map_url:
            map_btn.bgcolor = MAP_COLOR_ACTIVE
            map_btn.disabled = False
            map_btn.tooltip = "View OGC Maps for this collection"

            async def open_ogc_map(e, url=map_url, col_url=map_collection_url, t=title):
                ogc_view, load_meta = OGCMapView(page, url, t, col_url)
                page.views.append(ogc_view)
                page.update()
                await load_meta()

            map_btn.on_click = open_ogc_map
        else:
            map_btn.tooltip = "OGC Maps not available for this collection"

        page.update()

    view = ft.View(
        route=f"/{rec_id}",
        padding=20,
        controls=[
            ft.AppBar(title=ft.Text(title)),
            ft.Column(
                scroll=ft.ScrollMode.AUTO,
                expand=True,
                controls=[
                    tags_wrap,
                    ft.Divider(height=10),
                    ft.Text(desc_text, size=14, max_lines=3, overflow=ft.TextOverflow.ELLIPSIS),
                    ft.Divider(height=10),
                    metadata_card,
                    ft.Divider(height=10),
                    ft.Text("Data Access", weight=ft.FontWeight.BOLD, size=14),
                    endpoint_row,
                    query_types_row,
                    ft.Divider(height=10),
                    mqtt_tile,
                ],
            ),
        ],
    )

    return view, check_endpoints
