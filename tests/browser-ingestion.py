"""Verify Unicode text import/search and browser-side binary-file rejection."""
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}
UNICODE_TEXT = "آریا به فارسی نوشت: the brass key waits beneath the moon. 🗝️"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page()
        page.set_default_timeout(10000)
        suffix = uuid4().hex[:10]
        workspace_id = f"ingestion-browser-{suffix}"
        created = page.request.post(
            f"{API}/workspaces", headers=HEADERS,
            data={"workspace_id": workspace_id, "name": workspace_id},
        )
        assert created.status == 201, created.text()

        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")
        page.get_by_role("combobox", name="Select workspace").select_option(workspace_id)
        page.get_by_role("button", name=re.compile("Knowledge.*Sources and relationships", re.S)).click()
        page.get_by_role("button", name="Sources", exact=True).click()
        source_form = page.locator(".compact-form").filter(has_text="Add a source").locator("form")
        source_form.locator("input[name='file']").set_input_files({
            "name": "یادداشت سفر.txt", "mimeType": "text/plain", "buffer": UNICODE_TEXT.encode("utf-8"),
        })
        source_form.get_by_role("button", name=re.compile("Save source locally")).click()
        expect(page.get_by_role("status")).to_contain_text("Source is stored locally. No extraction has been run.")

        sources_response = page.request.get(f"{API}/workspaces/{workspace_id}/sources", headers=HEADERS)
        assert sources_response.status == 200, sources_response.text()
        sources = sources_response.json()
        assert len(sources) == 1
        source = page.request.get(
            f"{API}/workspaces/{workspace_id}/sources/{sources[0]['source_id']}", headers=HEADERS,
        )
        assert source.status == 200, source.text()
        assert source.json()["display_name"] == "یادداشت سفر.txt"
        assert source.json()["media_type"] == "text/plain"
        assert source.json()["content"] == UNICODE_TEXT

        page.get_by_role("textbox", name="Search workspace").fill("brass key")
        result = page.locator(".source-result").filter(has_text="یادداشت سفر.txt")
        expect(result).to_be_visible()
        expect(result).to_contain_text("the [brass] [key] waits beneath the moon")

        source_form.locator("input[name='file']").set_input_files({
            "name": "binary.txt", "mimeType": "text/plain", "buffer": b"header\x00payload",
        })
        source_form.get_by_role("button", name=re.compile("Save source locally")).click()
        expect(page.get_by_role("status")).to_contain_text("contains binary data")
        after_rejection = page.request.get(f"{API}/workspaces/{workspace_id}/sources", headers=HEADERS)
        revision = page.request.get(
            f"{API}/workspaces/{workspace_id}/revision?branch_id=main", headers=HEADERS,
        )
        assert after_rejection.status == revision.status == 200
        assert len(after_rejection.json()) == 1
        assert revision.json()["revision"] == 1
        print("Unicode text import and search passed; binary text fixture was rejected without a source or revision.")
    finally:
        browser.close()
