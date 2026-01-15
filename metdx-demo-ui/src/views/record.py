import flet as ft
from datetime import datetime


def RecordView(page: ft.Page, record: dict) -> ft.View:
    
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
                ft.Text(value, size=12, selectable=True, expand=True), # Expand prevents overflow
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
                disabled=True # Purely visual
            )
        )

    # Links
    links = record.get("links", [])
    edr_tile = ft.Container()
    mqtt_tile = ft.Container()

    for link in links:
        rel = link.get("rel")
        if rel == "collection":
            edr_tile = ft.ListTile(
                leading=ft.Icon(ft.Icons.DATA_EXPLORATION, color=ft.Colors.BLUE),
                title=ft.Text("Access Data (EDR)"),
                subtitle=ft.Text("Environmental Data Retrieval API"),
                trailing=ft.Icon(ft.Icons.CHEVRON_RIGHT, size=16),
                # on_click=lambda e, url=link.get("href"): page.launch_url(url),
                bgcolor=ft.Colors.SURFACE_CONTAINER_LOW,
                shape=ft.RoundedRectangleBorder(radius=8)
            )
        elif rel == "items":
            mqtt_tile = ft.ListTile(
                leading=ft.Icon(ft.Icons.NOTIFICATIONS_ACTIVE, color=ft.Colors.AMBER_800),
                title=ft.Text("Subscribe (AMQP/MQTT)"),
                subtitle=ft.Text(f"Channel: {link.get('channel', 'N/A')}"),
                trailing=ft.Icon(ft.Icons.CHEVRON_RIGHT, size=16),
                # on_click=lambda e, code=link.get("href"): page.set_clipboard(code),
                bgcolor=ft.Colors.SURFACE_CONTAINER_LOW,
                shape=ft.RoundedRectangleBorder(radius=8)
            )

    return ft.View(
        route=f"/{rec_id}",
        padding=20,
        controls=[
            ft.AppBar(
                title=ft.Text(title), 
            ),
            
            # Scrollable Column for content
            ft.Column(
                scroll=ft.ScrollMode.AUTO,
                expand=True,
                controls=[
                    tags_wrap,
                    ft.Divider(height= 10),
                    ft.Text(desc_text, size=14, max_lines=3, overflow=ft.TextOverflow.ELLIPSIS),
                    ft.Divider(height=10),
                    metadata_card,
                    ft.Divider(height=10),
                    
                    # Links
                    edr_tile,
                    mqtt_tile,
                ]
            )
        ]
    )