import flet as ft
from flet import Checkbox, FloatingActionButton, Icons, Page, TextField, ListView
import requests
from dataclasses import field
import json
from .record import RecordView

GDC_ENDPOINT = "https://f0d0ef280f8c.ngrok-free.app/collections/wis2-discovery-metadata/items"

def CatalogueView(page: ft.Page):

    def on_click_record(e, record):
        record_view = RecordView(page, record)
        page.views.append(record_view)

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
            self.border = ft.border.all(1, ft.Colors.GREY)
            self.bgcolor = ft.Colors.GREY_50

            # Title
            title_control = ft.Text(
                value=title_text,
                weight=ft.FontWeight.BOLD,
                size=16,
                max_lines=1,
                overflow=ft.TextOverflow.ELLIPSIS
            )

            # Description
            desc_control = ft.Text(
                value=desc_text,
                color=ft.Colors.GREY_800,
                size=12,
                max_lines=1,
                overflow=ft.TextOverflow.ELLIPSIS
            )

            # Tags
            tags_row = ft.Row(wrap=True, spacing=5)
            for tag in keywords[:5]: 
                tags_row.controls.append(
                    ft.Container(
                        content=ft.Text(tag, size=10, color=ft.Colors.WHITE),
                        bgcolor=ft.Colors.BLUE_GREY_600,
                        padding=ft.padding.symmetric(horizontal=8, vertical=2),
                        border_radius=10
                    )
                )
            
            self.on_click = lambda e: on_click_record(e, self.record)

            self.content = ft.Column(
                controls=[
                    title_control,
                    desc_control,
                    tags_row
                ]
            )


    def on_search(e):
        try:
            resp = requests.get(GDC_ENDPOINT, params={"q": search_bar.value})
            resp.raise_for_status()
            data = resp.json()
            number_of_results = data.get("numberMatched", 0)
            results = data.get("features", [])
            search_results.controls.clear()
            search_results.controls.append(
                ft.Text(f"Found {number_of_results} results for '{search_bar.value}'", weight=ft.FontWeight.BOLD)
            )
            for item in results:
                search_results.controls.append(SearchResult(record=item))
            search_results.visible = True            
            page.update()

        except Exception as ex:
            page.show_dialog(ft.SnackBar(
                ft.Text(f"Error during search: {ex}"),
                bgcolor=ft.Colors.RED,
                action="Dismiss"
            ))

    search_bar = TextField(hint_text="Welcome...", autofocus=True, on_submit=on_search, align=ft.Alignment.CENTER, width=600)

    search_results = ListView(expand=True, spacing=10, padding=20, visible=False)

    layout = ft.Column(
        controls=[
            search_bar,
            search_results
        ],
        alignment=ft.MainAxisAlignment.CENTER, 
        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
        expand=True
    )

    return ft.View(
        route="/",
        controls=[
            layout
        ]
    )
