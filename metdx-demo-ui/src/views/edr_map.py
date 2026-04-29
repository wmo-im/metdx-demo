import flet as ft
import flet_map as fm
import math
from enum import Enum
from datetime import datetime, timezone

try:
    from pyodide.http import pyfetch as _pyfetch
    _is_pyodide = True
except ModuleNotFoundError:
    import httpx
    _is_pyodide = False


async def _fetch_json(url: str) -> dict:
    if _is_pyodide:
        response = await _pyfetch(url, method="GET")
        return await response.json()
    else:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=15)
            return response.json()


class EDRMode(Enum):
    POSITION = "position"
    AREA = "area"
    TRAJECTORY = "trajectory"
    RADIUS = "radius"


MODE_COLOR = {
    EDRMode.POSITION:   ft.Colors.BLUE,
    EDRMode.AREA:       ft.Colors.GREEN,
    EDRMode.TRAJECTORY: ft.Colors.ORANGE,
    EDRMode.RADIUS:     ft.Colors.PURPLE,
}

MODE_ICON = {
    EDRMode.POSITION:   ft.Icons.PLACE,
    EDRMode.AREA:       ft.Icons.CROP_SQUARE,
    EDRMode.TRAJECTORY: ft.Icons.TIMELINE,
    EDRMode.RADIUS:     ft.Icons.RADIO_BUTTON_UNCHECKED,
}

MODE_HELP = {
    EDRMode.POSITION:   "Tap to set a single point",
    EDRMode.AREA:       "Tap two corners to define a bounding box",
    EDRMode.TRAJECTORY: "Tap points to build a path",
    EDRMode.RADIUS:     "Tap to set centre, then tap again to set radius edge",
}


def _latlng(lat, lon):
    return fm.MapLatitudeLongitude(lat, lon)


def _build_edr_url(
    base_url: str,
    mode: EDRMode,
    points: list,
    selected_params: list[str],
    selected_datetime: str | None,
) -> str | None:
    """Build an EDR query URL from the collected points, parameters, and datetime."""
    base = base_url.split("?")[0].rstrip("/")

    coords_part = None

    if mode == EDRMode.POSITION and len(points) >= 1:
        lat, lon = points[0]
        coords_part = f"POINT({lon} {lat})"
        endpoint = "position"

    elif mode == EDRMode.AREA and len(points) >= 2:
        lats = [p[0] for p in points]
        lons = [p[1] for p in points]
        min_lat, max_lat = min(lats), max(lats)
        min_lon, max_lon = min(lons), max(lons)
        coords_part = (
            f"POLYGON(({min_lon} {min_lat},"
            f"{max_lon} {min_lat},"
            f"{max_lon} {max_lat},"
            f"{min_lon} {max_lat},"
            f"{min_lon} {min_lat}))"
        )
        endpoint = "area"

    elif mode == EDRMode.TRAJECTORY and len(points) >= 2:
        coord_str = ",".join(f"{lon} {lat}" for lat, lon in points)
        coords_part = f"LINESTRING({coord_str})"
        endpoint = "trajectory"

    elif mode == EDRMode.RADIUS and len(points) >= 2:
        lat, lon = points[0]
        lat2, lon2 = points[1]
        dlat = math.radians(lat2 - lat)
        dlon = math.radians(lon2 - lon)
        a = (math.sin(dlat / 2) ** 2 +
             math.cos(math.radians(lat)) * math.cos(math.radians(lat2)) *
             math.sin(dlon / 2) ** 2)
        radius_km = round(6371 * 2 * math.asin(math.sqrt(a)), 2)
        coords_part = f"POINT({lon} {lat})"
        endpoint = "radius"
    else:
        return None

    url = f"{base}/{endpoint}?coords={coords_part}"

    if mode == EDRMode.RADIUS and len(points) >= 2:
        url += f"&within={radius_km}&within-units=km"

    if selected_params:
        url += f"&parameter-name={','.join(selected_params)}"

    if selected_datetime:
        url += f"&datetime={selected_datetime}"

    url += "&f=json"
    return url


def EDRMapView(page: ft.Page, collection_url: str, collection_title: str) -> ft.View:
    """Interactive map for building EDR queries against a collection."""

    # --- State ---
    current_mode = EDRMode.POSITION
    tapped_points: list[tuple[float, float]] = []
    selected_params: list[str] = []
    selected_datetime: str | None = None

    # Available params/dates fetched from collection — populated async
    available_params: dict[str, dict] = {}  # id -> {name, unit}
    temporal_start: str | None = None
    temporal_end: str | None = None

    # --- Map layers ---
    marker_layer = fm.MarkerLayer(markers=[])
    polyline_layer = fm.PolylineLayer(polylines=[])
    polygon_layer = fm.PolygonLayer(polygons=[])
    circle_layer = fm.CircleLayer(circles=[])

    # --- URL display ---
    url_field = ft.TextField(
        value="",
        read_only=True,
        hint_text="EDR query URL will appear here",
        expand=True,
        text_size=11,
        border_color=ft.Colors.GREY_300,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
    )
    async def copy_url(e):
        if url_field.value:
            await page.clipboard.set(url_field.value)

    copy_btn = ft.IconButton(
        icon=ft.Icons.COPY,
        tooltip="Copy URL",
        on_click=copy_url,
        icon_size=18,
    )
    async def open_url(e):
        if url_field.value:
            await page.launch_url(url_field.value)

    open_btn = ft.IconButton(
        icon=ft.Icons.OPEN_IN_BROWSER,
        tooltip="Open in browser",
        on_click=open_url,
        icon_size=18,
    )

    # --- Status ---
    status_text = ft.Text(
        MODE_HELP[current_mode],
        size=12,
        color=ft.Colors.GREY_700,
        italic=True,
    )

    # --- Parameter selection ---
    param_chips_row = ft.Row(wrap=True, spacing=4, visible=False)
    param_section_label = ft.Text("Parameters", weight=ft.FontWeight.BOLD, size=12)
    param_loading = ft.Row(
        controls=[
            ft.ProgressRing(width=14, height=14, stroke_width=2),
            ft.Text("Loading parameters...", size=11, color=ft.Colors.GREY_500),
        ],
        spacing=6,
    )

    # --- Datetime selection ---
    datetime_row = ft.Row(spacing=8, visible=False, vertical_alignment=ft.CrossAxisAlignment.CENTER)
    datetime_label = ft.Text("Datetime", weight=ft.FontWeight.BOLD, size=12)
    date_field = ft.TextField(
        hint_text="YYYY-MM-DD",
        width=130,
        text_size=12,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
        border_color=ft.Colors.GREY_400,
    )
    time_field = ft.TextField(
        hint_text="HH:MM",
        width=80,
        text_size=12,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
        border_color=ft.Colors.GREY_400,
    )
    datetime_hint = ft.Text("", size=10, color=ft.Colors.GREY_500, italic=True)

    def on_datetime_change(e=None):
        nonlocal selected_datetime
        d = date_field.value.strip() if date_field.value else ""
        t = time_field.value.strip() if time_field.value else ""
        if d and t:
            selected_datetime = f"{d}T{t}:00Z"
        elif d:
            selected_datetime = f"{d}T00:00:00Z"
        else:
            selected_datetime = None
        refresh_url()
        page.update()

    date_field.on_change = on_datetime_change
    time_field.on_change = on_datetime_change

    # --- Wire up param/datetime into URL ---
    def refresh_url():
        url = _build_edr_url(collection_url, current_mode, tapped_points,
                             selected_params, selected_datetime)
        url_field.value = url or ""

    def rebuild_layers():
        marker_layer.markers = []
        polyline_layer.polylines = []
        polygon_layer.polygons = []
        circle_layer.circles = []

        color = MODE_COLOR[current_mode]

        if current_mode == EDRMode.POSITION:
            for lat, lon in tapped_points:
                marker_layer.markers.append(
                    fm.Marker(
                        coordinates=_latlng(lat, lon),
                        content=ft.Icon(ft.Icons.PLACE, color=color, size=28),
                    )
                )

        elif current_mode == EDRMode.AREA:
            for lat, lon in tapped_points:
                marker_layer.markers.append(
                    fm.Marker(
                        coordinates=_latlng(lat, lon),
                        content=ft.Icon(ft.Icons.CLOSE, color=color, size=20),
                    )
                )
            if len(tapped_points) >= 2:
                lats = [p[0] for p in tapped_points]
                lons = [p[1] for p in tapped_points]
                min_lat, max_lat = min(lats), max(lats)
                min_lon, max_lon = min(lons), max(lons)
                box = [
                    _latlng(min_lat, min_lon),
                    _latlng(min_lat, max_lon),
                    _latlng(max_lat, max_lon),
                    _latlng(max_lat, min_lon),
                ]
                polygon_layer.polygons.append(
                    fm.PolygonMarker(
                        coordinates=box,
                        color=ft.Colors.with_opacity(0.2, color),
                        border_color=color,
                        border_stroke_width=2,
                    )
                )

        elif current_mode == EDRMode.TRAJECTORY:
            for lat, lon in tapped_points:
                marker_layer.markers.append(
                    fm.Marker(
                        coordinates=_latlng(lat, lon),
                        content=ft.Icon(ft.Icons.CIRCLE, color=color, size=14),
                    )
                )
            if len(tapped_points) >= 2:
                polyline_layer.polylines.append(
                    fm.PolylineMarker(
                        coordinates=[_latlng(lat, lon) for lat, lon in tapped_points],
                        color=color,
                        stroke_width=3,
                    )
                )

        elif current_mode == EDRMode.RADIUS:
            if tapped_points:
                lat, lon = tapped_points[0]
                marker_layer.markers.append(
                    fm.Marker(
                        coordinates=_latlng(lat, lon),
                        content=ft.Icon(ft.Icons.PLACE, color=color, size=28),
                    )
                )
            if len(tapped_points) >= 2:
                lat1, lon1 = tapped_points[0]
                lat2, lon2 = tapped_points[1]
                dlat = math.radians(lat2 - lat1)
                dlon = math.radians(lon2 - lon1)
                a = (math.sin(dlat / 2) ** 2 +
                     math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
                     math.sin(dlon / 2) ** 2)
                radius_km = 6371 * 2 * math.asin(math.sqrt(a))
                circle_layer.circles.append(
                    fm.CircleMarker(
                        coordinates=_latlng(lat1, lon1),
                        radius=radius_km * 1000,
                        use_radius_in_meter=True,
                        color=ft.Colors.with_opacity(0.2, color),
                        border_color=color,
                        border_stroke_width=2,
                    )
                )

        refresh_url()
        page.update()

    def on_map_tap(e: fm.MapTapEvent):
        nonlocal tapped_points

        lat = e.coordinates.latitude
        lon = e.coordinates.longitude

        if current_mode == EDRMode.POSITION:
            tapped_points = [(lat, lon)]
        elif current_mode == EDRMode.AREA:
            if len(tapped_points) >= 2:
                tapped_points = [(lat, lon)]
            else:
                tapped_points.append((lat, lon))
        elif current_mode == EDRMode.TRAJECTORY:
            tapped_points.append((lat, lon))
        elif current_mode == EDRMode.RADIUS:
            if len(tapped_points) >= 2:
                tapped_points = [(lat, lon)]
            else:
                tapped_points.append((lat, lon))

        rebuild_layers()

    def set_mode(mode: EDRMode):
        nonlocal current_mode, tapped_points
        current_mode = mode
        tapped_points = []
        status_text.value = MODE_HELP[mode]
        url_field.value = ""
        rebuild_layers()
        for m, btn in mode_buttons.items():
            btn.style = ft.ButtonStyle(
                bgcolor=MODE_COLOR[m] if m == current_mode else ft.Colors.GREY_200,
                color=ft.Colors.WHITE if m == current_mode else ft.Colors.GREY_700,
            )
        page.update()

    def clear_points(e):
        nonlocal tapped_points
        tapped_points = []
        rebuild_layers()

    # --- Parameter chip toggle handler ---
    def on_param_toggle(e):
        nonlocal selected_params
        chip = e.control
        param_id = chip.data
        if chip.selected:
            if param_id not in selected_params:
                selected_params.append(param_id)
        else:
            if param_id in selected_params:
                selected_params.remove(param_id)
        refresh_url()
        page.update()

    def select_all_params(e):
        nonlocal selected_params
        selected_params = list(available_params.keys())
        for c in param_chips_row.controls:
            if isinstance(c, ft.Chip):
                c.selected = True
        refresh_url()
        page.update()

    def clear_all_params(e):
        nonlocal selected_params
        selected_params = []
        for c in param_chips_row.controls:
            if isinstance(c, ft.Chip):
                c.selected = False
        refresh_url()
        page.update()

    # --- Load collection metadata ---
    async def load_collection_metadata():
        nonlocal available_params, temporal_start, temporal_end
        try:
            data = await _fetch_json(collection_url)
        except Exception as ex:
            param_loading.controls = [
                ft.Text(f"Failed to load: {ex}", size=11, color=ft.Colors.RED_400)
            ]
            page.update()
            return

        # Parameters
        raw_params = data.get("parameter_names", {})
        for pid, pdata in raw_params.items():
            unit = pdata.get("unit", {}).get("symbol", {}).get("value", "")
            label_en = pdata.get("observedProperty", {}).get("label", {}).get("en", pid)
            available_params[pid] = {"name": label_en, "unit": unit}

        # Build chips
        param_chips_row.controls.clear()
        for pid, pinfo in available_params.items():
            chip_label = f"{pid}" if pid == pinfo["name"] else f"{pid} ({pinfo['name']})"
            if pinfo["unit"]:
                chip_label += f" [{pinfo['unit']}]"
            param_chips_row.controls.append(
                ft.Chip(
                    label=ft.Text(chip_label, size=10),
                    bgcolor=ft.Colors.BLUE_GREY_50,
                    selected_color=ft.Colors.BLUE_100,
                    selected=False,
                    on_select=on_param_toggle,
                    data=pid,
                )
            )
        param_chips_row.visible = True
        param_loading.visible = False

        # Temporal
        extent = data.get("extent", {})
        temporal = extent.get("temporal", {})
        intervals = temporal.get("interval", [[None, None]])
        if intervals:
            temporal_start = intervals[0][0]
            temporal_end = intervals[0][1]

        hint_parts = []
        if temporal_start:
            hint_parts.append(f"from {temporal_start[:10]}")
        if temporal_end:
            hint_parts.append(f"to {temporal_end[:10]}")
        elif temporal_start:
            hint_parts.append("to now")
        datetime_hint.value = "Available: " + " ".join(hint_parts) if hint_parts else ""

        # Pre-fill date with today
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        date_field.value = today
        time_field.value = "00:00"
        on_datetime_change()

        datetime_row.visible = True
        page.update()

    # --- Mode toggle buttons ---
    mode_buttons: dict[EDRMode, ft.Button] = {}
    for mode in EDRMode:
        def make_handler(m):
            return lambda e: set_mode(m)
        btn = ft.Button(
            content=mode.value.capitalize(),
            icon=MODE_ICON[mode],
            style=ft.ButtonStyle(
                bgcolor=MODE_COLOR[mode] if mode == EDRMode.POSITION else ft.Colors.GREY_200,
                color=ft.Colors.WHITE if mode == EDRMode.POSITION else ft.Colors.GREY_700,
            ),
            on_click=make_handler(mode),
        )
        mode_buttons[mode] = btn

    # --- Map ---
    the_map = fm.Map(
        layers=[
            fm.TileLayer(
                url_template="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
                subdomains=["a", "b", "c", "d"],
                user_agent_package_name="com.metdx.demo",
            ),
            marker_layer,
            polyline_layer,
            polygon_layer,
            circle_layer,
        ],
        initial_center=_latlng(20, 0),
        initial_zoom=2.0,
        on_tap=on_map_tap,
        expand=True,
    )

    # --- Layout ---
    toolbar = ft.Row(
        controls=[
            *mode_buttons.values(),
            ft.VerticalDivider(width=1),
            ft.IconButton(
                icon=ft.Icons.DELETE_OUTLINE,
                tooltip="Clear",
                on_click=clear_points,
                icon_color=ft.Colors.RED_400,
            ),
        ],
        spacing=6,
        wrap=True,
    )

    url_row = ft.Row(
        controls=[url_field, copy_btn, open_btn],
        spacing=4,
    )

    param_header = ft.Row(
        controls=[
            param_section_label,
            ft.TextButton("All", on_click=select_all_params),
            ft.TextButton("None", on_click=clear_all_params),
        ],
        spacing=4,
        vertical_alignment=ft.CrossAxisAlignment.CENTER,
    )

    datetime_row.controls = [
        datetime_label,
        date_field,
        time_field,
        datetime_hint,
    ]

    # Scrollable side/bottom panel with params + datetime + URL
    options_panel = ft.Container(
        content=ft.Column(
            controls=[
                toolbar,
                status_text,
                ft.Divider(height=1),
                param_header,
                param_loading,
                param_chips_row,
                ft.Divider(height=1),
                datetime_row,
                ft.Divider(height=1),
                url_row,
            ],
            spacing=6,
            scroll=ft.ScrollMode.AUTO,
        ),
        padding=ft.Padding.symmetric(horizontal=12, vertical=8),
        bgcolor=ft.Colors.WHITE,
        border=ft.Border(top=ft.BorderSide(1, ft.Colors.GREY_300)),
        height=260,
    )

    view = ft.View(
        route="/edr-map",
        padding=0,
        controls=[
            ft.AppBar(title=ft.Text(f"EDR Query — {collection_title}")),
            ft.Column(
                controls=[the_map, options_panel],
                expand=True,
                spacing=0,
            ),
        ],
    )

    return view, load_collection_metadata
