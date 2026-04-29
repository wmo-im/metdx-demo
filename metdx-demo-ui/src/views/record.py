import flet as ft
from datetime import datetime

try:
    from pyodide.http import pyfetch as _pyfetch
    _is_pyodide = True
except ModuleNotFoundError:
    import httpx
    _is_pyodide = False

from .edr_map import EDRMapView

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

    # MQTT links (from record directly)
    links = record.get("links", [])
    mqtt_tile = ft.Container()
    collection_url = None

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
        elif rel == "data" and collection_url is None:
            href = link.get("href", "")
            # We want the OGC API collection endpoint, not a raw data file.
            # Heuristic: must be JSON and look like an OGC API collections path.
            link_type = link.get("type", "")
            if "json" in link_type or href.endswith("?f=json") or "/collections/" in href:
                collection_url = href if "?f=json" in href else (href + "?f=json" if "?" not in href else href + "&f=json")

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
        tooltip="Checking for EDR support..." if collection_url else "No EDR endpoint available",
    )

    map_btn = ft.Button(
        content="OGC Maps",
        icon=ft.Icons.MAP,
        bgcolor=DISABLED_COLOR,
        disabled=True,
        tooltip="Checking for OGC Maps support..." if collection_url else "No OGC Maps endpoint available",
    )

    endpoint_row = ft.Row(
        controls=[edr_btn, map_btn],
        spacing=10,
    )

    async def check_endpoints(e):
        print(f"[record] check_endpoints called, collection_url={collection_url}")
        if not collection_url:
            print("[record] no collection_url, returning")
            return
        try:
            print(f"[record] fetching {collection_url}")
            data = await _fetch_json(collection_url)
            print(f"[record] fetch done, keys={list(data.keys())}")
        except Exception as ex:
            print(f"[record] fetch failed: {ex}")
            edr_btn.tooltip = "Could not reach collection endpoint"
            map_btn.tooltip = "Could not reach collection endpoint"
            page.update()
            return

        # EDR: presence of data_queries key
        edr_url = None
        if data.get("data_queries"):
            edr_url = collection_url
        print(f"[record] edr_url={edr_url}")

        # OGC Maps: link with rel == OGC map relation
        map_url = None
        OGC_MAP_REL = "http://www.opengis.net/def/rel/ogc/1.0/map"
        for lnk in data.get("links", []):
            if lnk.get("rel") == OGC_MAP_REL:
                map_url = lnk.get("href")
                break
        print(f"[record] map_url={map_url}")

        if edr_url:
            edr_btn.bgcolor = EDR_COLOR_ACTIVE
            edr_btn.disabled = False
            edr_btn.tooltip = "Query this EDR collection on a map"

            async def open_edr_map(e, url=edr_url, t=title):
                print(f"[record] opening EDR map for {url}")
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
            map_btn.tooltip = "Open OGC Maps endpoint"
            map_btn.on_click = lambda e, url=map_url: page.launch_url(url)
        else:
            map_btn.tooltip = "OGC Maps not available for this collection"

        print("[record] calling page.update() after button state update")
        page.update()
        print("[record] check_endpoints complete")

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
                    ft.Divider(height=10),
                    mqtt_tile,
                ],
            ),
        ],
    )

    return view, check_endpoints
