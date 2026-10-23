"""Exercise actual Story Studio JSON downloads against isolated test servers."""
import json
from pathlib import Path
from uuid import uuid4
from playwright.sync_api import expect, sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page(accept_downloads=True)
        workspace = "export-" + uuid4().hex[:10]
        api = "http://127.0.0.1:48124/api/v1"
        headers = {"Authorization": "Bearer lke-browser-acceptance-local-only"}
        response = page.request.post(api + "/workspaces", headers=headers, data={"workspace_id": workspace, "name": workspace})
        assert response.status == 201, response.text()

        def command(revision, kind, payload):
            response = page.request.post(api + f"/workspaces/{workspace}/commands", headers=headers, data={
                "branch_id": "main", "expected_revision": revision, "command_type": kind,
                "idempotency_key": uuid4().hex, "reason": "Browser export fixture", "payload": payload,
            })
            assert response.status == 200, response.text()

        command(0, "create_entity", {"entity_id": "aria", "entity_type": "character", "label": "Aria"})
        command(1, "create_conversation", {"conversation_id": "export-story", "actor_entity_id": "aria", "title": "داستان"})
        command(2, "append_story_turn", {
            "conversation_id": "export-story", "user_content": "PRIVATE_PROMPT", "assistant_content": "متن داستان",
            "provider": "ollama", "model": "fixture-model", "narrative_order": 0,
            "context_revision": 2, "context_manifest_id": "fixture-context",
            "context_manifest": {"manifest_id": "fixture-context", "workspace_id": workspace, "branch_id": "main",
                "base_revision": 2, "actor": {"entity_id": "aria", "label": "PRIVATE_CONTEXT"}, "included": [], "excluded": []},
        })
        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")
        page.get_by_role("combobox", name="Select workspace").select_option(workspace)
        expect(page.get_by_role("combobox", name="Select saved story")).to_have_value("export-story")

        def download():
            with page.expect_download() as event:
                page.get_by_role("button", name="Export story JSON").click()
            return json.loads(Path(event.value.path()).read_text(encoding="utf-8"))

        default = download()
        assert default["workspace_id"] == workspace and default["branch_id"] == "main"
        assert default["conversation"]["turns"][1]["content"] == "متن داستان"
        assert "PRIVATE_CONTEXT" not in json.dumps(default)
        page.get_by_label("Include my prompts in export").uncheck()
        narrative = download()
        assert narrative["user_prompts_included"] is False
        assert "PRIVATE_PROMPT" not in json.dumps(narrative)
        page.get_by_label("Include character context manifests in export").check()
        full_context = download()
        assert full_context["context_manifests_included"] is True
        assert "PRIVATE_CONTEXT" in json.dumps(full_context)
        print("Browser story JSON download, Persian text, scope, prompt omission, and context opt-in passed.")
    finally:
        browser.close()
