import flet as ft
import flet.canvas as cv
import flet_map as fm
import math
from enum import Enum
from datetime import datetime, timezone, timedelta

try:
    from pyodide.http import pyfetch as _pyfetch
    _is_pyodide = True
except ModuleNotFoundError:
    import httpx
    _is_pyodide = False


async def _fetch_json(url: str, *, follow_jobs: bool = False) -> dict:
    if _is_pyodide:
        response = await _pyfetch(url, method="GET")
        return await response.json()
    else:
        async with httpx.AsyncClient() as client:
            if not follow_jobs:
                response = await client.get(url, timeout=15, follow_redirects=True)
                return response.json()
            # EDR async job pattern: don't auto-follow redirects
            import asyncio
            response = await client.get(url, timeout=30, follow_redirects=False)
            # If 303 redirect → async job
            if response.status_code == 303:
                job_url = response.headers.get("location", "")
                if job_url.startswith("/"):
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    job_url = f"{parsed.scheme}://{parsed.netloc}{job_url}"
                # Long-poll the job endpoint
                for _ in range(60):  # up to ~5 minutes
                    resp = await client.get(job_url, timeout=10)
                    data = resp.json()
                    status = data.get("status", "")
                    if status in ("successful", "completed", "finished"):
                        # Get result from the result link or inline
                        for lnk in data.get("links", []):
                            if lnk.get("rel") == "results":
                                result_url = lnk["href"]
                                if result_url.startswith("/"):
                                    result_url = f"{parsed.scheme}://{parsed.netloc}{result_url}"
                                r = await client.get(result_url, timeout=30)
                                return r.json()
                        return data
                    elif status in ("failed", "error", "dismissed"):
                        raise Exception(f"Job failed: {data.get('message', status)}")
                    await asyncio.sleep(5)
                raise Exception("Job timed out after 5 minutes")
            elif response.status_code in (301, 302, 307, 308):
                loc = response.headers.get("location", "")
                if loc.startswith("/"):
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    loc = f"{parsed.scheme}://{parsed.netloc}{loc}"
                response = await client.get(loc, timeout=30)
                return response.json()
            else:
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
    EDRMode.RADIUS:     "Tap to set centre, then tap again to set radius (or enter manually)",
}


def _latlng(lat, lon):
    return fm.MapLatitudeLongitude(lat, lon)


def _build_edr_url(
    base_url: str,
    mode: EDRMode,
    points: list,
    selected_params: list[str],
    selected_datetime: str | None,
    instance_id: str | None,
    radius_degrees: float | None = None,
) -> str | None:
    """Build an EDR query URL from the collected points, parameters, datetime, and instance."""
    base = base_url.split("?")[0].rstrip("/")

    # Insert instance into path if selected
    if instance_id:
        base = f"{base}/instances/{instance_id}"

    coords_part = None
    radius_km = None

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

    elif mode == EDRMode.RADIUS and len(points) >= 1 and radius_degrees is not None:
        lat, lon = points[0]
        coords_part = f"POINT({lon} {lat})"
        endpoint = "radius"
    else:
        return None

    url = f"{base}/{endpoint}?coords={coords_part}"

    if mode == EDRMode.RADIUS and radius_degrees is not None:
        url += f"&within={radius_degrees}&within-units=degrees"

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
    selected_instance: str | None = None

    # Available data fetched from collection — populated async
    available_params: dict[str, dict] = {}
    available_instances: list[dict] = []  # [{id, temporal_start, temporal_end}, ...]

    # --- Map layers ---
    marker_layer = fm.MarkerLayer(markers=[])
    polyline_layer = fm.PolylineLayer(polylines=[])
    polygon_layer = fm.PolygonLayer(polygons=[])
    bbox_layer = fm.PolygonLayer(polygons=[])
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
        icon=ft.Icons.COPY, tooltip="Copy URL", on_click=copy_url, icon_size=18,
    )

    async def open_url(e):
        if url_field.value:
            await page.launch_url(url_field.value)

    open_btn = ft.IconButton(
        icon=ft.Icons.OPEN_IN_BROWSER, tooltip="Open in browser",
        on_click=open_url, icon_size=18,
    )

    # --- Status ---
    status_text = ft.Text(
        MODE_HELP[current_mode], size=12, color=ft.Colors.GREY_700, italic=True,
    )

    # --- Radius input ---
    radius_field = ft.TextField(
        value="5",
        label="Radius (degrees)",
        width=140,
        text_size=12,
        visible=False,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
        on_change=lambda e: (rebuild_layers(), refresh_url(), page.update()),
    )

    def _get_radius_degrees() -> float | None:
        try:
            return float(radius_field.value)
        except (ValueError, TypeError):
            return None

    # --- Instance selection (optional) ---
    use_instance = False  # toggled by the switch

    instance_dropdown = ft.Dropdown(
        label="Instance (reference time)",
        width=320,
        text_size=12,
        options=[],
        visible=False,
    )
    instance_loading = ft.Row(
        controls=[
            ft.ProgressRing(width=14, height=14, stroke_width=2),
            ft.Text("Loading instances...", size=11, color=ft.Colors.GREY_500),
        ],
        spacing=6,
        visible=False,
    )
    instance_content = ft.Column(controls=[instance_loading, instance_dropdown], spacing=4, visible=False)

    def on_instance_toggle(e):
        nonlocal use_instance, selected_instance
        use_instance = e.control.value
        instance_content.visible = use_instance
        if not use_instance:
            selected_instance = None
        elif instance_dropdown.value:
            selected_instance = instance_dropdown.value
        refresh_url()
        page.update()

    instance_switch = ft.Switch(
        label="Use specific instance",
        value=False,
        on_change=on_instance_toggle,
        label_text_style=ft.TextStyle(size=12),
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

    # --- Datetime range selection ---
    datetime_section = ft.Column(spacing=4, visible=False)
    datetime_label = ft.Text("Datetime", weight=ft.FontWeight.BOLD, size=12)
    datetime_hint = ft.Text("", size=10, color=ft.Colors.GREY_500, italic=True)

    _tf_kwargs = dict(
        text_size=12,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
        border_color=ft.Colors.GREY_400,
    )
    start_date_field = ft.TextField(hint_text="YYYY-MM-DD", width=130, **_tf_kwargs)
    start_time_field = ft.TextField(hint_text="HH:MM", width=80, **_tf_kwargs)
    end_date_field = ft.TextField(hint_text="YYYY-MM-DD", width=130, **_tf_kwargs)
    end_time_field = ft.TextField(hint_text="HH:MM", width=80, **_tf_kwargs)

    def _make_iso(date_val, time_val):
        d = date_val.strip() if date_val else ""
        t = time_val.strip() if time_val else ""
        if d and t:
            return f"{d}T{t}:00Z"
        elif d:
            return f"{d}T00:00:00Z"
        return None

    def on_datetime_change(e=None):
        nonlocal selected_datetime
        dt_start = _make_iso(start_date_field.value, start_time_field.value)
        dt_end = _make_iso(end_date_field.value, end_time_field.value)
        if dt_start and dt_end:
            selected_datetime = f"{dt_start}/{dt_end}"
        elif dt_start:
            selected_datetime = dt_start
        else:
            selected_datetime = None
        refresh_url()
        page.update()

    start_date_field.on_change = on_datetime_change
    start_time_field.on_change = on_datetime_change
    end_date_field.on_change = on_datetime_change
    end_time_field.on_change = on_datetime_change

    # --- Wire up URL building ---
    def refresh_url():
        url = _build_edr_url(
            collection_url, current_mode, tapped_points,
            selected_params, selected_datetime, selected_instance,
            radius_degrees=_get_radius_degrees() if current_mode == EDRMode.RADIUS else None,
        )
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
                        color=color, stroke_width=3,
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
                rd = _get_radius_degrees()
                if rd and rd > 0:
                    # Convert degrees to km for display (approx 111 km per degree)
                    radius_km = rd * 111.0
                    circle_layer.circles.append(
                        fm.CircleMarker(
                            coordinates=_latlng(lat, lon),
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
                if len(tapped_points) == 2:
                    # Compute radius in degrees from the two points
                    lat1, lon1 = tapped_points[0]
                    lat2, lon2 = tapped_points[1]
                    deg = ((lat2 - lat1) ** 2 + (lon2 - lon1) ** 2) ** 0.5
                    radius_field.value = f"{deg:.2f}"

        rebuild_layers()

    def set_mode(mode: EDRMode):
        nonlocal current_mode, tapped_points
        current_mode = mode
        tapped_points = []
        status_text.value = MODE_HELP[mode]
        url_field.value = ""
        rebuild_layers()
        radius_field.visible = (current_mode == EDRMode.RADIUS)
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

    # --- Parameter chip toggle ---
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

    # --- Instance change handler ---
    async def on_instance_change(e):
        nonlocal selected_instance
        selected_instance = instance_dropdown.value if use_instance else None
        if not selected_instance:
            refresh_url()
            page.update()
            return

        # Fetch instance metadata to get its temporal extent
        base = collection_url.split("?")[0].rstrip("/")
        instance_url = f"{base}/instances/{selected_instance}?f=json"

        datetime_hint.value = "Loading forecast range..."
        datetime_section.visible = True
        page.update()

        try:
            inst_data = await _fetch_json(instance_url)
            extents = inst_data.get("extents", inst_data.get("extent", {}))
            temporal = extents.get("temporal", {})
            intervals = temporal.get("interval", [[None, None]])
            t_start = intervals[0][0] if intervals else None
            t_end = intervals[0][1] if intervals else None

            hint_parts = []
            if t_start:
                hint_parts.append(f"from {t_start[:16]}")
            if t_end:
                hint_parts.append(f"to {t_end[:16]}")
            datetime_hint.value = "Valid range: " + " ".join(hint_parts) if hint_parts else ""

            # Pre-fill start from instance start, end from instance end
            if t_start:
                start_date_field.value = t_start[:10]
                start_time_field.value = t_start[11:16] if len(t_start) > 11 else "00:00"
            if t_end:
                end_date_field.value = t_end[:10]
                end_time_field.value = t_end[11:16] if len(t_end) > 11 else "00:00"
            on_datetime_change()

        except Exception as ex:
            datetime_hint.value = f"Could not load instance details: {ex}"

        refresh_url()
        page.update()

    instance_dropdown.on_change = on_instance_change

    # --- Load collection metadata ---
    async def load_collection_metadata():
        nonlocal available_params, available_instances, selected_instance

        # 1. Fetch collection JSON for parameters
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

        # 2. Fetch instances (preload but don't auto-select unless user enables)
        base = collection_url.split("?")[0].rstrip("/")
        instances_url = f"{base}/instances?f=json"
        has_instances = False
        try:
            inst_data = await _fetch_json(instances_url)
            instances = inst_data.get("instances", [])

            instance_dropdown.options = [
                ft.dropdown.Option(key=inst["id"], text=inst["id"])
                for inst in instances
            ]

            if instances:
                has_instances = True
                instance_dropdown.visible = True
                instance_loading.visible = False
                # Pre-select the first but don't activate until switch is on
                instance_dropdown.value = instances[0]["id"]
            else:
                instance_loading.controls = [
                    ft.Text("No instances available", size=11, color=ft.Colors.GREY_500)
                ]
                instance_loading.visible = True

        except Exception as ex:
            instance_loading.controls = [
                ft.Text(f"No instances: {ex}", size=11, color=ft.Colors.GREY_500)
            ]
            instance_loading.visible = True

        # Show the instance switch only if instances exist
        instance_switch.visible = has_instances

        # Fall back to collection-level temporal extent for datetime prefill
        extent = data.get("extent", {})

        # Show spatial bbox on map
        spatial = extent.get("spatial", {})
        spatial_bbox = spatial.get("bbox", [])
        if spatial_bbox:
            bb = spatial_bbox[0]  # [west, south, east, north]
            if len(bb) >= 4:
                w, s, e, n = bb[0], bb[1], bb[2], bb[3]
                bbox_layer.polygons = [
                    fm.PolygonMarker(
                        coordinates=[
                            _latlng(n, w),
                            _latlng(n, e),
                            _latlng(s, e),
                            _latlng(s, w),
                        ],
                        color=ft.Colors.with_opacity(0.25, ft.Colors.ORANGE),
                        border_color=ft.Colors.ORANGE_700,
                        border_stroke_width=3,
                    )
                ]

        temporal = extent.get("temporal", {})
        intervals = temporal.get("interval", [[None, None]])
        t_start = intervals[0][0] if intervals else None
        t_end = intervals[0][1] if intervals else None

        hint_parts = []
        if t_start:
            hint_parts.append(f"from {t_start[:16]}")
        if t_end:
            hint_parts.append(f"to {t_end[:16]}")
        elif t_start:
            hint_parts.append("to now")
        datetime_hint.value = "Available: " + " ".join(hint_parts) if hint_parts else ""

        if t_start:
            start_date_field.value = t_start[:10]
            start_time_field.value = t_start[11:16] if len(t_start) > 11 else "00:00"
        else:
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            start_date_field.value = today
            start_time_field.value = "00:00"

        if t_end:
            end_date_field.value = t_end[:10]
            end_time_field.value = t_end[11:16] if len(t_end) > 11 else "00:00"

        on_datetime_change()
        datetime_section.visible = True

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
            bbox_layer,
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
            radius_field,
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

    url_row = ft.Row(controls=[url_field, copy_btn, open_btn], spacing=4)

    # --- Response display ---
    response_text = ft.Text("", size=11, selectable=True, no_wrap=False)
    response_container = ft.Container(
        content=ft.Column(
            controls=[response_text],
            scroll=ft.ScrollMode.AUTO,
        ),
        bgcolor=ft.Colors.GREY_100,
        border_radius=6,
        padding=8,
        visible=False,
        height=200,
    )
    response_status = ft.Text("", size=11, color=ft.Colors.GREY_600)

    # --- Timeseries chart ---
    chart_container = ft.Container(
        visible=False,
        height=220,
        bgcolor=ft.Colors.WHITE,
        border=ft.Border.all(1, ft.Colors.GREY_300),
        border_radius=6,
        padding=10,
    )

    MAX_DISPLAY_SIZE = 50_000  # chars

    def _build_timeseries_chart(data: dict) -> bool:
        """Try to extract timeseries from CoverageJSON and build a canvas chart.
        Returns True if a chart was built."""
        if not isinstance(data, dict):
            return False

        # Handle both single Coverage and CoverageCollection
        coverage = None
        if data.get("type") == "CoverageCollection":
            coverages = data.get("coverages", [])
            if coverages:
                coverage = coverages[0]
        elif data.get("type") == "Coverage":
            coverage = data
        elif data.get("domain") and data.get("ranges"):
            coverage = data

        if not coverage:
            return False

        domain = coverage.get("domain", {})
        axes = domain.get("axes", {})
        t_axis = axes.get("t", {})
        t_values = t_axis.get("values", [])
        ranges = coverage.get("ranges", {})

        # Also check top-level parameters for unit info
        top_params = data.get("parameters", {})

        if not t_values or not ranges:
            return False

        # Use first range
        param_name = list(ranges.keys())[0]
        range_data = ranges[param_name]
        values = range_data.get("values", [])

        if not values or len(values) != len(t_values):
            return False

        # Filter out None values
        points = [(i, v) for i, v in enumerate(values) if v is not None]
        if len(points) < 2:
            return False

        # Chart dimensions
        chart_w = 600.0
        chart_h = 180.0
        margin_l = 50.0
        margin_b = 30.0
        plot_w = chart_w - margin_l - 10
        plot_h = chart_h - margin_b - 10

        y_vals = [p[1] for p in points]
        y_min, y_max = min(y_vals), max(y_vals)
        if y_min == y_max:
            y_min -= 1
            y_max += 1
        x_min, x_max = points[0][0], points[-1][0]
        if x_min == x_max:
            x_max += 1

        def to_canvas(ix, val):
            x = margin_l + (ix - x_min) / (x_max - x_min) * plot_w
            y = 10 + plot_h - (val - y_min) / (y_max - y_min) * plot_h
            return x, y

        shapes = []

        # Axes
        shapes.append(cv.Line(margin_l, 10, margin_l, 10 + plot_h, paint=ft.Paint(color=ft.Colors.GREY_400, stroke_width=1, style=ft.PaintingStyle.STROKE)))
        shapes.append(cv.Line(margin_l, 10 + plot_h, margin_l + plot_w, 10 + plot_h, paint=ft.Paint(color=ft.Colors.GREY_400, stroke_width=1, style=ft.PaintingStyle.STROKE)))

        # Y-axis labels
        for i in range(5):
            val = y_min + (y_max - y_min) * i / 4
            _, y = to_canvas(x_min, val)
            shapes.append(cv.Text(margin_l - 45, y - 5, f"{val:.1f}", style=ft.TextStyle(size=8, color=ft.Colors.GREY_700)))

        # X-axis labels (first, middle, last) — show date
        for idx in [0, len(t_values) // 2, len(t_values) - 1]:
            x, _ = to_canvas(idx, y_min)
            label = t_values[idx][:10]  # YYYY-MM-DD
            shapes.append(cv.Text(x - 25, 10 + plot_h + 5, label, style=ft.TextStyle(size=8, color=ft.Colors.GREY_700)))

        # Line path
        path_points = []
        for ix, val in points:
            px, py = to_canvas(ix, val)
            path_points.append((px, py))

        # Draw line segments
        for i in range(len(path_points) - 1):
            x1, y1 = path_points[i]
            x2, y2 = path_points[i + 1]
            shapes.append(cv.Line(x1, y1, x2, y2, paint=ft.Paint(color=ft.Colors.BLUE_700, stroke_width=2, style=ft.PaintingStyle.STROKE)))

        # Data points
        for px, py in path_points:
            shapes.append(cv.Circle(px, py, 2, paint=ft.Paint(color=ft.Colors.BLUE_900)))

        # Title
        unit = range_data.get("unit", {}).get("symbol", {}).get("value", "")
        if not unit and param_name in top_params:
            unit = top_params[param_name].get("unit", {}).get("symbol", "")
        label_name = param_name
        if param_name in top_params:
            label_name = top_params[param_name].get("observedProperty", {}).get("label", {}).get("en", param_name)
        title = f"{label_name}" + (f" ({unit})" if unit else "")
        shapes.append(cv.Text(margin_l, 0, title, style=ft.TextStyle(size=10, weight=ft.FontWeight.BOLD, color=ft.Colors.GREY_900)))

        canvas = cv.Canvas(shapes=shapes, width=chart_w, height=chart_h)
        chart_container.content = canvas
        chart_container.visible = True
        return True

    async def _save_response(e, json_str=None):
        """Save response JSON to a temp file and open it."""
        if not json_str:
            return
        import tempfile, os
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", prefix="edr_response_", delete=False
        )
        tmp.write(json_str)
        tmp.close()
        await page.launch_url(f"file://{tmp.name}")

    download_btn = ft.Button(
        content="Save response as file",
        icon=ft.Icons.DOWNLOAD,
        style=ft.ButtonStyle(bgcolor=ft.Colors.TEAL, color=ft.Colors.WHITE),
        visible=False,
    )

    show_data_btn = ft.Button(
        content="Show Data",
        icon=ft.Icons.CODE,
        style=ft.ButtonStyle(bgcolor=ft.Colors.BLUE_GREY, color=ft.Colors.WHITE),
        visible=False,
    )

    def _toggle_data(e):
        response_container.visible = not response_container.visible
        show_data_btn.content = "Hide Data" if response_container.visible else "Show Data"
        page.update()

    show_data_btn.on_click = _toggle_data

    async def execute_query(e):
        if not url_field.value:
            return
        response_status.value = "Fetching..."
        response_container.visible = False
        chart_container.visible = False
        download_btn.visible = False
        show_data_btn.visible = False
        page.update()
        try:
            data = await _fetch_json(url_field.value, follow_jobs=True)
            import json
            full_json = json.dumps(data, indent=2)
            size = len(full_json)

            # Try to build timeseries chart for position + single param
            has_chart = False
            if (current_mode == EDRMode.POSITION and
                    len(selected_params) == 1 and
                    isinstance(data, dict)):
                has_chart = _build_timeseries_chart(data)

            if size > MAX_DISPLAY_SIZE:
                n_keys = len(data) if isinstance(data, dict) else len(data) if isinstance(data, list) else 0
                summary = f"Response too large to display ({size:,} chars).\n"
                if isinstance(data, dict):
                    summary += f"Top-level keys: {', '.join(data.keys())}\n"
                    if "ranges" in data:
                        summary += f"Ranges: {', '.join(data['ranges'].keys())}\n"
                    if "coverages" in data:
                        summary += f"Coverages: {len(data['coverages'])}\n"
                response_text.value = summary
                response_status.value = f"Response received ({size:,} chars — truncated)"

                async def _do_save(e, js=full_json):
                    await _save_response(e, js)
                download_btn.on_click = _do_save
                download_btn.visible = True
            else:
                response_text.value = full_json
                response_status.value = "Response received"
                download_btn.visible = False

            response_status.color = ft.Colors.GREEN_700

            if has_chart:
                # Show chart, hide data by default with button to reveal
                response_container.visible = False
                show_data_btn.visible = True
                show_data_btn.content = "Show Data"
            else:
                response_container.visible = True

        except Exception as ex:
            response_text.value = str(ex)
            response_status.value = "Request failed"
            response_status.color = ft.Colors.RED_400
            response_container.visible = True
            download_btn.visible = False
            show_data_btn.visible = False
        page.update()

    execute_btn = ft.Button(
        content="Execute Query",
        icon=ft.Icons.PLAY_ARROW,
        style=ft.ButtonStyle(bgcolor=ft.Colors.TEAL, color=ft.Colors.WHITE),
        on_click=execute_query,
    )

    query_row = ft.Row(
        controls=[execute_btn, response_status, show_data_btn, download_btn],
        spacing=8,
        vertical_alignment=ft.CrossAxisAlignment.CENTER,
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

    datetime_section.controls = [
        datetime_label,
        ft.Row(
            controls=[
                ft.Text("Start:", size=11, width=40),
                start_date_field,
                start_time_field,
            ],
            spacing=6,
            vertical_alignment=ft.CrossAxisAlignment.CENTER,
        ),
        ft.Row(
            controls=[
                ft.Text("End:", size=11, width=40),
                end_date_field,
                end_time_field,
            ],
            spacing=6,
            vertical_alignment=ft.CrossAxisAlignment.CENTER,
        ),
        datetime_hint,
    ]

    options_panel = ft.Container(
        content=ft.Column(
            controls=[
                toolbar,
                status_text,
                ft.Divider(height=1),
                # Instance selector (optional)
                instance_switch,
                instance_content,
                ft.Divider(height=1),
                # Parameters
                param_header,
                param_loading,
                param_chips_row,
                ft.Divider(height=1),
                # Datetime range
                datetime_section,
                ft.Divider(height=1),
                url_row,
                ft.Divider(height=1),
                query_row,
                response_container,
                chart_container,
            ],
            spacing=6,
            scroll=ft.ScrollMode.AUTO,
        ),
        padding=ft.Padding.symmetric(horizontal=12, vertical=8),
        bgcolor=ft.Colors.WHITE,
        border=ft.Border(top=ft.BorderSide(1, ft.Colors.GREY_300)),
        height=300,
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
