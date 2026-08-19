import flet as ft
import flet_map as fm
import tempfile
import os
import time
import logging
from collections import OrderedDict
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] ogc_map: %(message)s",
)
log = logging.getLogger("metdx.ogc_map")

try:
    from pyodide.http import pyfetch as _pyfetch
    _is_pyodide = True
except ModuleNotFoundError:
    import httpx
    _is_pyodide = False

# Keep track of temp files so they persist while displayed
_temp_files: list[str] = []

# --- Small LRU cache of rendered maps, keyed by the exact request URL ---
# The map server encodes bbox/width/height/datetime in the URL, so only an
# identical request can reuse a cached image. This still helps because the
# server is slow and flaky: once a frame is fetched it can be re-displayed
# instantly (e.g. revisiting the same view/datetime). Values are the resolved
# image ``src`` (a local temp-file path on native, or the URL under pyodide).
_MAP_CACHE_MAX = 12
_map_cache: "OrderedDict[str, str]" = OrderedDict()


def _cache_get(url: str) -> str | None:
    src = _map_cache.get(url)
    if src is None:
        return None
    # On native, ensure the cached temp file still exists
    if not _is_pyodide and not os.path.exists(src):
        _map_cache.pop(url, None)
        return None
    _map_cache.move_to_end(url)  # mark as most-recently-used
    return src


def _cache_put(url: str, src: str) -> None:
    _map_cache[url] = src
    _map_cache.move_to_end(url)
    while len(_map_cache) > _MAP_CACHE_MAX:
        _, old_src = _map_cache.popitem(last=False)
        # Best-effort cleanup of evicted native temp files
        if not _is_pyodide and old_src and os.path.exists(old_src):
            try:
                os.remove(old_src)
                if old_src in _temp_files:
                    _temp_files.remove(old_src)
            except OSError:
                pass


def _latlng(lat, lon):
    return fm.MapLatitudeLongitude(lat, lon)


async def _fetch_json(url: str) -> dict:
    if _is_pyodide:
        response = await _pyfetch(url, method="GET")
        return await response.json()
    else:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, timeout=15, follow_redirects=True)
            return response.json()


def OGCMapView(page: ft.Page, map_url: str, collection_title: str, collection_url: str | None = None):
    """Display an OGC Maps image with interactive bbox selection on a map."""

    # --- BBOX drawing state ---
    bbox_corners: list[tuple[float, float]] = []  # [(lat,lon), (lat,lon)]
    bbox_polygon_layer = fm.PolygonLayer(polygons=[])

    bbox_field = ft.TextField(
        value="-180,-90,180,90",
        label="BBOX (minLon,minLat,maxLon,maxLat)",
        width=320,
        text_size=12,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
    )
    width_field = ft.TextField(
        value="800", label="Width", width=80, text_size=12,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
    )
    height_field = ft.TextField(
        value="600", label="Height", width=80, text_size=12,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
    )
    datetime_field = ft.TextField(
        value=datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z"),
        label="Datetime", width=260, text_size=12,
        hint_text="e.g. 2026-04-30T00:00:00Z",
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
    )
    datetime_dropdown = ft.Dropdown(
        label="Datetime",
        width=280,
        text_size=12,
        visible=False,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
    )

    instance_dropdown = ft.Dropdown(
        label="Instance (run date)",
        width=260,
        text_size=12,
        visible=False,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
    )

    param_dropdown = ft.Dropdown(
        label="Parameter",
        width=200,
        text_size=12,
        visible=False,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
    )

    schema_loading = ft.Text(
        "Loading schema..." if collection_url else "",
        size=11, color=ft.Colors.GREY_500,
        visible=bool(collection_url),
    )

    # Schema state: all datetimes keyed by instance
    _schema_datetimes: list[str] = []  # all datetimes from schema
    _schema_instances: list[str] = []

    def _clean_dt(s: str) -> str:
        """Normalize datetime to ISO 8601 with T separator and Z suffix.

        Schema enum values look like '2026-08-18 00:00:00+00:00'; the backend
        expects '2026-08-18T00:00:00Z'.
        """
        if not s:
            return s
        import re
        s = s.strip()
        # Date/time separator: space → T (e.g. '2026-08-18 00:00:00' → '2026-08-18T00:00:00')
        s = re.sub(r'(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})', r'\1T\2', s)
        # Fix space before tz offset (rare) → '+'
        s = re.sub(r'(\d{2}:\d{2}:\d{2}) (\d{2}:\d{2})$', r'\1+\2', s)
        # UTC offset → Z
        s = re.sub(r'\+00:00$', 'Z', s)
        return s

    def on_datetime_selected(e):
        if datetime_dropdown.value:
            datetime_field.value = datetime_dropdown.value
            page.update()

    datetime_dropdown.on_change = on_datetime_selected

    def _filter_datetimes_for_instance():
        """When instance changes, filter datetimes to only those >= instance date."""
        inst = instance_dropdown.value
        if not inst or not _schema_datetimes:
            return

        # Instance is the base run; only offer forecast datetimes at/after it.
        # Both instance and datetimes are _clean_dt-normalized to the same
        # 'YYYY-MM-DDTHH:MM:SSZ' format, so full-string comparison is valid.
        inst_clean = _clean_dt(inst)

        filtered = [dt for dt in _schema_datetimes if dt >= inst_clean]
        datetime_dropdown.options = [
            ft.dropdown.Option(key=dt, text=dt) for dt in filtered
        ]
        if filtered:
            datetime_dropdown.value = filtered[0]
            datetime_field.value = filtered[0]
        page.update()

    def on_instance_selected(e):
        _filter_datetimes_for_instance()

    instance_dropdown.on_change = on_instance_selected

    map_image = ft.Image(
        src="",
        fit=ft.BoxFit.CONTAIN,
        expand=True,
        visible=False,
        opacity=1.0,
    )
    loading = ft.ProgressRing(width=24, height=24, visible=False)
    result_placeholder = ft.Text(
        "Rendered map will appear here after you click Load Map",
        size=12, color=ft.Colors.GREY_500,
    )
    status_text = ft.Text(
        "Click Draw BBOX to select an area on the map, or edit BBOX manually",
        size=12, color=ft.Colors.GREY_600,
    )

    url_display = ft.TextField(
        value="",
        read_only=True,
        text_size=11,
        expand=True,
        border_color=ft.Colors.GREY_300,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
        hint_text="Map URL will appear here",
    )

    def clear_overlay(e):
        map_image.visible = False
        map_image.src = ""
        result_placeholder.visible = True
        status_text.value = "Result cleared"
        status_text.color = ft.Colors.GREY_600
        page.update()

    clear_result_btn = ft.IconButton(
        icon=ft.Icons.LAYERS_CLEAR,
        tooltip="Clear rendered map",
        on_click=clear_overlay,
        icon_size=18,
        visible=False,
    )

    def _update_bbox_polygon():
        if len(bbox_corners) == 2:
            (lat1, lon1), (lat2, lon2) = bbox_corners
            n, s = max(lat1, lat2), min(lat1, lat2)
            e, w = max(lon1, lon2), min(lon1, lon2)
            bbox_polygon_layer.polygons = [
                fm.PolygonMarker(
                    coordinates=[
                        _latlng(n, w), _latlng(n, e),
                        _latlng(s, e), _latlng(s, w),
                    ],
                    color=ft.Colors.with_opacity(0.2, ft.Colors.GREEN),
                    border_color=ft.Colors.GREEN_700,
                    border_stroke_width=2,
                )
            ]
            bbox_field.value = f"{w},{s},{e},{n}"
        elif len(bbox_corners) == 1:
            bbox_polygon_layer.polygons = []
        else:
            bbox_polygon_layer.polygons = []

    # --- BBOX drawing mode ---
    drawing_active = [False]

    draw_bbox_btn = ft.Button(
        content="Draw BBOX",
        icon=ft.Icons.CROP_SQUARE,
        style=ft.ButtonStyle(bgcolor=ft.Colors.GREY_400, color=ft.Colors.WHITE),
        tooltip="Click to enable drawing a bounding box on the map",
    )

    def toggle_draw(e):
        drawing_active[0] = not drawing_active[0]
        if drawing_active[0]:
            bbox_corners.clear()
            bbox_polygon_layer.polygons = []
            draw_bbox_btn.style = ft.ButtonStyle(bgcolor=ft.Colors.ORANGE, color=ft.Colors.WHITE)
            draw_bbox_btn.content = "Drawing..."
            status_text.value = "Click the first corner on the map"
            status_text.color = ft.Colors.ORANGE
        else:
            draw_bbox_btn.style = ft.ButtonStyle(bgcolor=ft.Colors.GREY_400, color=ft.Colors.WHITE)
            draw_bbox_btn.content = "Draw BBOX"
            status_text.value = "Drawing cancelled"
            status_text.color = ft.Colors.GREY_600
        page.update()

    draw_bbox_btn.on_click = toggle_draw

    def on_map_tap(e):
        if not drawing_active[0]:
            return

        lat = round(e.coordinates.latitude, 3)
        lon = round(e.coordinates.longitude, 3)

        bbox_corners.append((lat, lon))

        if len(bbox_corners) == 1:
            status_text.value = f"First corner: ({lat:.3f}, {lon:.3f}) — click second corner"
            status_text.color = ft.Colors.ORANGE
        elif len(bbox_corners) >= 2:
            # Done drawing
            drawing_active[0] = False
            draw_bbox_btn.style = ft.ButtonStyle(bgcolor=ft.Colors.GREY_400, color=ft.Colors.WHITE)
            draw_bbox_btn.content = "Draw BBOX"
            status_text.value = "Bounding box set — click Load Map or redraw"
            status_text.color = ft.Colors.GREEN_700

        _update_bbox_polygon()
        page.update()

    def clear_bbox(e):
        bbox_corners.clear()
        bbox_polygon_layer.polygons = []
        bbox_field.value = "-180,-90,180,90"
        drawing_active[0] = False
        draw_bbox_btn.style = ft.ButtonStyle(bgcolor=ft.Colors.GREY_400, color=ft.Colors.WHITE)
        draw_bbox_btn.content = "Draw BBOX"
        status_text.value = "Click Draw BBOX to select an area on the map"
        status_text.color = ft.Colors.GREY_600
        page.update()

    # --- Interactive map ---
    the_map = fm.Map(
        layers=[
            fm.TileLayer(
                url_template="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
                subdomains=["a", "b", "c", "d"],
                user_agent_package_name="com.metdx.demo",
            ),
            bbox_polygon_layer,
        ],
        initial_center=_latlng(20, 0),
        initial_zoom=2.0,
        on_tap=on_map_tap,
        expand=True,
    )

    def _default_datetime() -> str:
        """Pick a sensible datetime so the map server never gets a request
        without one (which returns a 500). Prefer a schema datetime matching
        today, otherwise the latest schema value, otherwise today at 00:00Z."""
        from datetime import date, datetime as _dt, timezone
        today = date.today().isoformat()
        if _schema_datetimes:
            for dt in _schema_datetimes:
                if dt[:10] == today:
                    return dt
            return _schema_datetimes[-1]
        return _dt.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z")

    def build_url() -> str:
        base = map_url.split("?")[0]
        params = ["f=png"]
        bbox = bbox_field.value.strip()
        if bbox:
            params.append(f"bbox={bbox}")
        w = width_field.value.strip()
        h = height_field.value.strip()
        if w:
            params.append(f"width={w}")
        if h:
            params.append(f"height={h}")
        dt = datetime_field.value.strip()
        if not dt:
            # Always send a datetime — an empty one 500s on the server.
            dt = _default_datetime()
            datetime_field.value = dt
        params.append(f"datetime={dt}")
        return f"{base}?{'&'.join(params)}"

    async def load_map(e):
        url = build_url()
        url_display.value = url
        loading.visible = True
        map_image.visible = False
        result_placeholder.visible = False
        load_btn.disabled = True
        status_text.value = "Loading..."
        status_text.color = ft.Colors.GREY_600
        page.update()

        log.info("Map request START url=%s", url)
        _t0 = time.monotonic()
        try:
            cached_src = _cache_get(url)
            if cached_src is not None:
                map_image.src = cached_src
                cache_hit = True
                log.info("Cache HIT (%.1fs) src=%s", time.monotonic() - _t0, cached_src)
            elif _is_pyodide:
                map_image.src = url
                # Browser HTTP-caches the image; record the URL as "seen".
                _cache_put(url, url)
                cache_hit = False
            else:
                cache_hit = False
                # The map server can be slow (10-50s) and occasionally drops the
                # connection, so use a generous timeout and retry a couple of times.
                import asyncio
                last_err = None
                resp = None
                for attempt in range(3):
                    _ta = time.monotonic()
                    try:
                        log.info("HTTP GET attempt %d/3 (timeout=120s) ...", attempt + 1)
                        async with httpx.AsyncClient() as client:
                            resp = await client.get(url, timeout=120, follow_redirects=True)
                        log.info(
                            "HTTP GET attempt %d/3 returned status=%s in %.1fs (%d bytes)",
                            attempt + 1, resp.status_code,
                            time.monotonic() - _ta, len(resp.content),
                        )
                        break
                    except Exception as ex:
                        last_err = ex
                        resp = None
                        log.warning(
                            "HTTP GET attempt %d/3 FAILED after %.1fs: %s: %s "
                            "(connection dropped before a response byte — most "
                            "likely the ~50s edge gateway timeout while the "
                            "backend is still rendering)",
                            attempt + 1, time.monotonic() - _ta,
                            type(ex).__name__, ex,
                        )
                        if attempt < 2:
                            status_text.value = f"Retrying ({attempt + 2}/3)..."
                            page.update()
                            await asyncio.sleep(2)
                if resp is None:
                    raise last_err or Exception("Request failed")
                if resp.status_code != 200:
                    raise Exception(f"HTTP {resp.status_code}")
                tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
                tmp.write(resp.content)
                tmp.close()
                _temp_files.append(tmp.name)
                map_image.src = tmp.name
                _cache_put(url, tmp.name)

            map_image.visible = True
            loading.visible = False
            result_placeholder.visible = False
            clear_result_btn.visible = True
            if cache_hit:
                status_text.value = "Map rendered (from cache)"
            else:
                status_text.value = "Map rendered below"
            status_text.color = ft.Colors.GREEN_700
            log.info("Map request DONE in %.1fs (cache_hit=%s)",
                     time.monotonic() - _t0, cache_hit)
        except Exception as ex:
            loading.visible = False
            status_text.value = f"Failed: {ex}"
            status_text.color = ft.Colors.RED_400
            log.error("Map request FAILED after %.1fs: %s: %s",
                      time.monotonic() - _t0, type(ex).__name__, ex)
        finally:
            loading.visible = False
            load_btn.disabled = False

        page.update()

    async def copy_url(e):
        if url_display.value:
            await page.clipboard.set(url_display.value)

    async def open_url(e):
        if url_display.value:
            await page.launch_url(url_display.value)

    load_btn = ft.Button(
        content="Load Map",
        icon=ft.Icons.MAP,
        style=ft.ButtonStyle(bgcolor=ft.Colors.GREEN, color=ft.Colors.WHITE),
        on_click=load_map,
    )

    clear_btn = ft.IconButton(
        icon=ft.Icons.DELETE_OUTLINE,
        tooltip="Clear BBOX",
        on_click=clear_bbox,
        icon_color=ft.Colors.RED_400,
    )

    controls_row = ft.Row(
        controls=[
            instance_dropdown, datetime_dropdown, param_dropdown, schema_loading,
            bbox_field, width_field, height_field, datetime_field,
            draw_bbox_btn, load_btn, clear_btn,
        ],
        spacing=8,
        wrap=True,
        vertical_alignment=ft.CrossAxisAlignment.END,
    )

    url_row = ft.Row(
        controls=[
            url_display,
            ft.IconButton(icon=ft.Icons.COPY, tooltip="Copy URL", on_click=copy_url, icon_size=18),
            ft.IconButton(icon=ft.Icons.OPEN_IN_BROWSER, tooltip="Open in browser", on_click=open_url, icon_size=18),
        ],
        spacing=4,
    )

    # Top: interactive map used only for drawing/selecting the bbox.
    interactive_map_panel = ft.Container(
        content=the_map,
        expand=2,
        bgcolor=ft.Colors.GREY_200,
    )

    # Bottom: the rendered PNG result (or a placeholder / loading spinner).
    result_panel = ft.Container(
        content=ft.Stack(
            controls=[
                ft.Container(content=result_placeholder, alignment=ft.Alignment(0, 0)),
                map_image,
                ft.Container(content=loading, alignment=ft.Alignment(0, 0)),
            ],
            expand=True,
        ),
        expand=2,
        bgcolor=ft.Colors.BLACK12,
    )

    # Layout: interactive selection map on top, controls in the middle,
    # rendered map result at the bottom.
    view = ft.View(
        route="/ogc-map",
        padding=0,
        controls=[
            ft.AppBar(title=ft.Text(f"OGC Maps — {collection_title}")),
            ft.Column(
                expand=True,
                spacing=0,
                controls=[
                    # Interactive map for bbox selection
                    interactive_map_panel,
                    # Controls panel
                    ft.Container(
                        content=ft.Column(
                            controls=[
                                controls_row,
                                ft.Row(
                                    controls=[status_text, clear_result_btn],
                                    spacing=8,
                                    vertical_alignment=ft.CrossAxisAlignment.CENTER,
                                ),
                                url_row,
                            ],
                            spacing=6,
                            scroll=ft.ScrollMode.AUTO,
                        ),
                        padding=ft.Padding.symmetric(horizontal=12, vertical=8),
                        bgcolor=ft.Colors.WHITE,
                        border=ft.Border(
                            top=ft.BorderSide(1, ft.Colors.GREY_300),
                            bottom=ft.BorderSide(1, ft.Colors.GREY_300),
                        ),
                    ),
                    # Rendered map result at the bottom
                    result_panel,
                ],
            ),
        ],
    )

    async def load_metadata():
        """Fetch schema endpoint to populate instances, datetimes, and parameters."""
        if not collection_url:
            return

        # 1. Fetch collection for spatial bbox
        try:
            col_data = await _fetch_json(collection_url)
            extent = col_data.get("extent", {})
            spatial = extent.get("spatial", {})
            spatial_bbox = spatial.get("bbox", [])
            if spatial_bbox:
                bb = spatial_bbox[0]
                if len(bb) >= 4:
                    w, s, e, n = bb[0], bb[1], bb[2], bb[3]
                    bbox_polygon_layer.polygons.append(
                        fm.PolygonMarker(
                            coordinates=[
                                _latlng(n, w), _latlng(n, e),
                                _latlng(s, e), _latlng(s, w),
                            ],
                            color=ft.Colors.with_opacity(0.15, ft.Colors.ORANGE),
                            border_color=ft.Colors.ORANGE_700,
                            border_stroke_width=2,
                        )
                    )
        except Exception:
            pass

        # 2. Fetch schema for instances, datetimes, parameters
        base = collection_url.split("?")[0].rstrip("/")
        schema_url = f"{base}/schema?f=json"
        try:
            schema = await _fetch_json(schema_url)
        except Exception as ex:
            schema_loading.value = f"Failed to load schema: {ex}"
            schema_loading.color = ft.Colors.RED_400
            page.update()
            return

        props = schema.get("properties", {})
        skip_keys = {"geometry", "instance_id", "datetime"}

        # Instances
        inst_prop = props.get("instance_id", {})
        instances = [_clean_dt(v) for v in inst_prop.get("enum", [])]
        _schema_instances.clear()
        _schema_instances.extend(instances)

        if instances:
            # Default to today's date instance if available
            from datetime import date
            today = date.today().isoformat()
            default_inst = None
            for inst in instances:
                if inst[:10] == today:
                    default_inst = inst
                    break
            if not default_inst:
                default_inst = instances[-1]  # latest

            instance_dropdown.options = [
                ft.dropdown.Option(key=v, text=v) for v in instances
            ]
            instance_dropdown.value = default_inst
            instance_dropdown.visible = True

        # Datetimes
        dt_prop = props.get("datetime", {})
        all_datetimes = [_clean_dt(v) for v in dt_prop.get("enum", [])]
        _schema_datetimes.clear()
        _schema_datetimes.extend(all_datetimes)

        # Filter datetimes for selected instance
        _filter_datetimes_for_instance()
        datetime_dropdown.visible = bool(all_datetimes)

        # Parameters (all properties except geometry, instance_id, datetime)
        param_names = [k for k in props if k not in skip_keys]
        if param_names:
            param_dropdown.options = [
                ft.dropdown.Option(key=p, text=p) for p in param_names
            ]
            param_dropdown.value = param_names[0]
            param_dropdown.visible = True

        schema_loading.visible = False
        page.update()

    return view, load_metadata
