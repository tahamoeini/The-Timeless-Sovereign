"""Verify browser backup and confirmed restore on the isolated acceptance server."""
import json
from pathlib import Path
import tempfile
from uuid import uuid4
import zipfile
from playwright.sync_api import expect, sync_playwright


with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix="lke-browser-backup-") as temporary:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page(accept_downloads=True)
        headers = {"Authorization": "Bearer lke-browser-acceptance-local-only"}
        api = "http://127.0.0.1:48124/api/v1"
        before = page.request.get(api + "/workspaces", headers=headers).json()
        assert before, "Seed the isolated acceptance database before this check"
        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")
        with page.expect_download() as event:
            page.get_by_role("button", name="Back up", exact=True).click()
        backup = Path(temporary) / "browser.lkebackup"
        event.value.save_as(backup)
        with zipfile.ZipFile(backup) as archive:
            assert "knowledge.sqlite3" in archive.namelist()
            assert json.loads(archive.read("manifest.json"))["format"] == "lke.backup.v1"
        marker = "after-backup-" + uuid4().hex[:10]
        created = page.request.post(api + "/workspaces", headers=headers, data={"workspace_id": marker, "name": marker})
        assert created.status == 201, created.text()
        page.reload()
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("combobox", name="Select workspace").locator("option", has_text=marker)).to_have_count(1)
        page.on("dialog", lambda dialog: dialog.accept())
        with page.expect_file_chooser() as chooser:
            page.get_by_role("button", name="Restore", exact=True).click()
        chooser.value.set_files(backup)
        expect(page.get_by_role("status").filter(has_text="Restored backup from")).to_be_visible()
        after = page.request.get(api + "/workspaces", headers=headers).json()
        assert {row["workspace_id"] for row in after} == {row["workspace_id"] for row in before}
        page.reload()
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("combobox", name="Select workspace").locator("option", has_text=marker)).to_have_count(0)
        print("Browser backup download, archive envelope, confirmed restore, and reload equivalence passed.")
    finally:
        browser.close()
