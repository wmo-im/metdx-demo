import flet as ft
import tempfile
import os

try:
    from pyodide.http import pyfetch as _pyfetch
    _is_pyodide = True
except ModuleNotFoundError:
    import httpx
    _is_pyodide = False

# Keep track of temp files so they persist while displayed
_temp_files: list[str] = []


def OGCMapView(page: ft.Page, map_url: str, collection_title: str):
    """Display an OGC Maps image with bbox / size / datetime controls."""

    # --- State ---
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
        value="", label="Datetime (optional)", width=220, text_size=12,
        hint_text="e.g. 2026-04-30T00:00:00Z",
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
    )

    map_image = ft.Image(
        src="",
        fit=ft.BoxFit.CONTAIN,
        expand=True,
        visible=False,
    )
    loading = ft.ProgressRing(width=24, height=24, visible=False)
    status_text = ft.Text("Configure parameters and click Load Map", size=12, color=ft.Colors.GREY_600)

    url_display = ft.TextField(
        value="",
        read_only=True,
        text_size=11,
        expand=True,
        border_color=ft.Colors.GREY_300,
        content_padding=ft.Padding.symmetric(horizontal=8, vertical=4),
        hint_text="Map URL will appear here",
    )

    def build_url() -> str:
        base = map_url.split("?")[0]
        params = [f"f=png"]
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
        if dt:
            params.append(f"datetime={dt}")
        return f"{base}?{'&'.join(params)}"

    async def load_map(e):
        url = build_url()
        url_display.value = url
        loading.visible = True
        map_image.visible = False
        status_text.value = "Loading..."
        page.update()

        try:
            if _is_pyodide:
                # For pyodide, set the image src directly (browser handles fetch)
                map_image.src = url
            else:
                # For native, fetch the image and write to a temp file
                async with httpx.AsyncClient() as client:
                    resp = await client.get(url, timeout=60)
                    if resp.status_code != 200:
                        status_text.value = f"Error: HTTP {resp.status_code}"
                        loading.visible = False
                        page.update()
                        return
                    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
                    tmp.write(resp.content)
                    tmp.close()
                    _temp_files.append(tmp.name)
                    map_image.src = tmp.name

            map_image.visible = True
            loading.visible = False
            status_text.value = "Map loaded"
            status_text.color = ft.Colors.GREEN_700
        except Exception as ex:
            loading.visible = False
            status_text.value = f"Failed: {ex}"
            status_text.color = ft.Colors.RED_400

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

    controls_row = ft.Row(
        controls=[bbox_field, width_field, height_field, datetime_field, load_btn],
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

    image_container = ft.Container(
        content=ft.Stack(
            controls=[
                map_image,
                ft.Container(content=loading, alignment=ft.Alignment(0, 0)),
            ],
            expand=True,
        ),
        expand=True,
        bgcolor=ft.Colors.GREY_200,
        border_radius=4,
    )

    view = ft.View(
        route="/ogc-map",
        padding=10,
        controls=[
            ft.AppBar(title=ft.Text(f"OGC Maps — {collection_title}")),
            ft.Column(
                expand=True,
                spacing=8,
                controls=[
                    controls_row,
                    ft.Row(controls=[status_text], spacing=8),
                    url_row,
                    ft.Divider(height=1),
                    image_container,
                ],
            ),
        ],
    )

    return view
