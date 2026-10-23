"""Browser acceptance against the isolated local acceptance servers."""
import re
from uuid import uuid4
from playwright.sync_api import expect, sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page()
        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")
        suffix = uuid4().hex[:10]
        created_name = "UI workspace " + suffix
        page.get_by_role("combobox", name="Select workspace").select_option("")
        page.get_by_role("textbox", name="Workspace name").fill(created_name)
        page.get_by_role("button", name=re.compile("Create workspace")).click()
        expect(page.get_by_role("heading", name="Story Studio", exact=True)).to_be_visible()
        expect(page.get_by_role("combobox", name="Select workspace").locator("option:checked")).to_have_text(created_name)
        first_id, second_id = f"browser-first-{suffix}", f"browser-second-{suffix}"
        headers = {"Authorization": "Bearer lke-browser-acceptance-local-only"}
        api = "http://127.0.0.1:48124/api/v1"
        for identifier in (first_id, second_id):
            response = page.request.post(api + "/workspaces", headers=headers,
                                         data={"workspace_id": identifier, "name": identifier})
            assert response.status == 201, response.text()
        character = f"Isolated character {suffix}"
        response = page.request.post(api + f"/workspaces/{first_id}/commands", headers=headers, data={
            "branch_id": "main", "expected_revision": 0, "idempotency_key": suffix,
            "command_type": "create_entity", "reason": "Browser isolation fixture",
            "payload": {"entity_id": "isolated-character", "entity_type": "character", "label": character},
        })
        assert response.status == 200, response.text()
        page.reload()
        page.wait_for_load_state("networkidle")
        selector = page.get_by_role("combobox", name="Select workspace")
        selector.select_option(first_id)
        page.get_by_role("button", name=re.compile("Knowledge.*Sources and relationships", re.S)).click()
        expect(page.get_by_role("combobox", name="From", exact=True).locator("option", has_text=character)).to_have_count(1)
        selector.select_option(second_id)
        expect(page.get_by_text("Loading the selected workspace and branch…")).to_have_count(0)
        expect(page.get_by_text(character, exact=True)).to_have_count(0)
        selector.select_option(first_id)
        expect(page.get_by_role("combobox", name="From", exact=True).locator("option", has_text=character)).to_have_count(1)
        page.reload()
        page.wait_for_load_state("networkidle")
        selector.select_option(first_id)
        page.get_by_role("button", name=re.compile("Knowledge.*Sources and relationships", re.S)).click()
        expect(page.get_by_role("combobox", name="From", exact=True).locator("option", has_text=character)).to_have_count(1)
        print("Browser workspace creation, isolation, switching, and reload persistence passed.")
    finally:
        browser.close()
