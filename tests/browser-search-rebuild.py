"""Verify UI search-projection recovery against the isolated acceptance app."""

import os
import sqlite3
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}


def create_command(page, workspace_id, revision, key, command_type, payload):
    response = page.request.post(
        f"{API}/workspaces/{workspace_id}/commands",
        headers=HEADERS,
        data={
            "branch_id": "main",
            "expected_revision": revision,
            "idempotency_key": key,
            "command_type": command_type,
            "reason": "Search projection browser acceptance",
            "payload": payload,
        },
    )
    assert response.status == 200, response.text()
    return response.json()["revision"]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page()
        page.set_default_timeout(10000)
        suffix = uuid4().hex[:10]
        workspace_id = f"browser-search-rebuild-{suffix}"
        created = page.request.post(
            f"{API}/workspaces", headers=HEADERS,
            data={"workspace_id": workspace_id, "name": workspace_id},
        )
        assert created.status == 201, created.text()
        revision = create_command(page, workspace_id, 0, f"{suffix}-entity", "create_entity", {
            "entity_id": "aria", "entity_type": "person", "label": "Aria", "properties": {"role": "Archivist"},
        })
        revision = create_command(page, workspace_id, revision, f"{suffix}-source", "import_source", {
            "source_id": "ledger", "display_name": "Ledger", "media_type": "text/plain",
            "content": "Aria keeps the brass key in the archive.",
        })

        data_dir = Path(os.environ.get("LKE_DATA_DIR", Path(__file__).resolve().parents[1] / "output" / "playwright" / "acceptance-data"))
        with sqlite3.connect(data_dir / "knowledge.sqlite3") as database:
            entity_count = database.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
            source_count = database.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
            database.execute("DELETE FROM entity_search")
            database.execute("DELETE FROM source_search")

        denied = page.request.post(f"{API}/projections/search/rebuild")
        assert denied.status == 401
        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")
        page.get_by_role("combobox", name="Select workspace").select_option(workspace_id)
        page.get_by_role("button", name="Rebuild search", exact=True).click()
        entity_label = "entity" if entity_count == 1 else "entities"
        source_label = "source" if source_count == 1 else "sources"
        confirmation = f"Search indexes rebuilt from {entity_count} {entity_label} and {source_count} {source_label}"
        expect(page.get_by_role("status").filter(has_text=confirmation)).to_be_visible()

        entity_search = page.request.get(
            f"{API}/workspaces/{workspace_id}/entities?branch_id=main&q=Archivist", headers=HEADERS,
        )
        source_search = page.request.get(
            f"{API}/workspaces/{workspace_id}/sources?q=brass", headers=HEADERS,
        )
        current = page.request.get(f"{API}/workspaces/{workspace_id}/revision?branch_id=main", headers=HEADERS)
        assert entity_search.status == 200 and [row["entity_id"] for row in entity_search.json()] == ["aria"]
        assert source_search.status == 200 and [row["source_id"] for row in source_search.json()] == ["ledger"]
        assert current.status == 200 and current.json()["revision"] == revision
        print("UI rebuild restored entity/source search from canonical rows without advancing the workspace revision.")
    finally:
        browser.close()
