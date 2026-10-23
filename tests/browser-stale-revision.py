"""Verify stale browser writes fail cleanly and succeed after refreshing the selected workspace."""
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}


def graph_label(value):
    return value if len(value) <= 18 else value[:17] + "…"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page()
        page.set_default_timeout(10000)
        suffix = uuid4().hex[:10]
        workspace_id = f"stale-revision-{suffix}"
        created = page.request.post(
            f"{API}/workspaces", headers=HEADERS,
            data={"workspace_id": workspace_id, "name": workspace_id},
        )
        assert created.status == 201, created.text()
        initial = page.request.post(
            f"{API}/workspaces/{workspace_id}/commands", headers=HEADERS,
            data={
                "branch_id": "main", "expected_revision": 0, "idempotency_key": f"{suffix}-initial",
                "command_type": "create_entity", "reason": "Create stale revision fixture",
                "payload": {"entity_id": "aria", "entity_type": "person", "label": "Aria"},
            },
        )
        assert initial.status == 200, initial.text()

        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")
        page.get_by_role("combobox", name="Select workspace").select_option(workspace_id)
        page.get_by_role("button", name=re.compile("Knowledge.*Sources and relationships", re.S)).click()
        graph = page.get_by_role("img", name="Knowledge graph")
        expect(graph.locator("text.node-label")).to_have_text(["Aria"])
        expect(page.locator(".revision-chip")).to_have_text("Revision 1")

        external = page.request.post(
            f"{API}/workspaces/{workspace_id}/commands", headers=HEADERS,
            data={
                "branch_id": "main", "expected_revision": 1, "idempotency_key": f"{suffix}-external",
                "command_type": "update_entity", "reason": "Simulate another local writer",
                "payload": {
                    "entity_id": "aria", "entity_type": "person", "label": "Aria externally corrected",
                    "properties": {"updated_by": "second local window"},
                },
            },
        )
        assert external.status == 200, external.text()

        entity_form = page.locator(".stacked-panels .compact-form").first.locator("form")
        new_label = f"Retry after refresh {suffix}"
        entity_form.get_by_label("Display name").fill(new_label)
        entity_form.get_by_role("button", name=re.compile("Add concept")).click()
        expect(page.get_by_role("status")).to_contain_text("Expected revision 1; current revision is 2")

        before_refresh = page.request.get(
            f"{API}/workspaces/{workspace_id}/entities?branch_id=main", headers=HEADERS,
        )
        assert before_refresh.status == 200, before_refresh.text()
        assert [entity["label"] for entity in before_refresh.json()] == ["Aria externally corrected"]
        expect(entity_form.get_by_label("Display name")).to_have_value(new_label)

        page.get_by_role("button", name="Refresh", exact=True).click()
        expect(page.locator(".revision-chip")).to_have_text("Revision 2")
        expect(graph.locator("text.node-label")).to_have_text([graph_label("Aria externally corrected")])
        entity_form.get_by_role("button", name=re.compile("Add concept")).click()
        expect(page.get_by_role("status")).to_contain_text("Added to this branch.")
        expect(graph.locator("text.node-label")).to_have_text([
            graph_label("Aria externally corrected"), graph_label(new_label),
        ])
        expect(page.locator(".revision-chip")).to_have_text("Revision 3")

        final = page.request.get(
            f"{API}/workspaces/{workspace_id}/entities?branch_id=main", headers=HEADERS,
        )
        assert final.status == 200, final.text()
        labels = [entity["label"] for entity in final.json()]
        assert labels == ["Aria externally corrected", new_label]
        assert labels.count(new_label) == 1
        print("Stale write was rejected without partial data; refresh and retry completed at the current revision.")
    finally:
        browser.close()
