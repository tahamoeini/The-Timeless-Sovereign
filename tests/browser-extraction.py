"""Source extraction and candidate review through the browser against isolated local services."""
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}
SOURCE_TEXT = "Aria guards the archive. Kael carries a brass key."
MODEL_OUTPUT = {
    "entities": [{"label": "Aria", "entity_type": "person", "quote": "Aria"}],
    "claims": [
        {
            "subject_label": "Aria",
            "predicate": "guards",
            "object_value": "the archive",
            "quote": "Aria guards the archive.",
        },
        {
            "subject_label": "Kael",
            "predicate": "carries",
            "object_value": "a brass key",
            "quote": "Kael carries a brass key.",
        },
    ],
}


class MockOllamaHandler(BaseHTTPRequestHandler):
    chat_calls = 0

    def log_message(self, _format, *_args):
        pass

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/tags":
            self.send_json(200, {"models": [{"name": "acceptance-model"}]})
            return
        self.send_json(404, {"error": "unknown mock Ollama route"})

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_json(404, {"error": "unknown mock Ollama route"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length).decode("utf-8"))
        assert request["model"] == "acceptance-model"
        assert request["format"] == "json"
        type(self).chat_calls += 1
        self.send_json(200, {"message": {"content": json.dumps(MODEL_OUTPUT, ensure_ascii=False)}})


server = ThreadingHTTPServer(("127.0.0.1", 11434), MockOllamaHandler)
server_thread = Thread(target=server.serve_forever, daemon=True)
server_thread.start()

with sync_playwright() as playwright:
    browser = None
    try:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page()
        page.set_default_timeout(10000)
        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")

        suffix = uuid4().hex[:10]
        workspace_name = f"Extraction browser {suffix}"
        workspace_selector = page.get_by_role("combobox", name="Select workspace")
        workspace_selector.select_option("")
        page.get_by_role("textbox", name="Workspace name").fill(workspace_name)
        page.get_by_role("button", name=re.compile("Create workspace")).click()
        expect(page.get_by_role("heading", name="Story Studio", exact=True)).to_be_visible()
        workspace_id = workspace_selector.locator("option:checked").get_attribute("value")
        assert workspace_id

        page.get_by_role("button", name=re.compile("Knowledge.*Sources and relationships", re.S)).click()
        expect(page.get_by_role("heading", name="Knowledge Explorer", exact=True)).to_be_visible()
        page.get_by_role("button", name="Sources", exact=True).click()
        source_title = "Extraction evidence"
        source_form = page.locator(".compact-form").filter(has_text="Add a source").locator("form")
        source_form.get_by_label("Source title").fill(source_title)
        source_form.get_by_label("Text content").fill(SOURCE_TEXT)
        source_form.get_by_role("button", name=re.compile("Save source locally")).click()
        expect(page.get_by_role("status")).to_contain_text("Source is stored locally. No extraction has been run.")

        page.get_by_role("button", name="AI extraction", exact=True).click()
        expect(page.get_by_role("heading", name="Extract source candidates", exact=True)).to_be_visible()
        model_selector = page.get_by_label("Local model")
        expect(model_selector.get_by_role("option", name="acceptance-model")).to_have_count(1)
        model_selector.select_option(label="acceptance-model")
        page.locator(".extraction-control-row select").first.select_option(label=source_title)

        with page.expect_response(
            lambda response: "/sources/" in response.url and response.url.endswith("/extract")
            and response.request.method == "POST"
        ) as extraction_response_info:
            page.get_by_role("button", name=re.compile("Extract for review")).click()
        extraction_response = extraction_response_info.value
        assert extraction_response.status == 200, extraction_response.text()
        expect(page.get_by_role("status")).to_contain_text("Source candidates are ready for review.")

        candidates = page.locator(".extraction-candidate")
        expect(candidates).to_have_count(3)
        expect(page.locator(".extraction-status", has_text="proposed")).to_have_count(3)
        expect(candidates.filter(has_text="Aria guards the archive.")).to_be_visible()
        expect(candidates.filter(has_text="Kael carries a brass key.")).to_be_visible()
        expect(page.locator(".extraction-controls .panel-count")).to_have_text("3 awaiting review")

        assert page.request.get(
            f"{API}/workspaces/{workspace_id}/entities?branch_id=main", headers=HEADERS,
        ).json() == []
        assert page.request.get(
            f"{API}/workspaces/{workspace_id}/claims?branch_id=main", headers=HEADERS,
        ).json() == []

        entity_card = page.locator(".extraction-candidate").filter(
            has=page.locator(".extraction-candidate-title strong").filter(has_text=re.compile(r"^Aria$"))
        )
        entity_card.get_by_role("button", name="Accept reviewed item").click()
        expect(entity_card.locator(".extraction-status")).to_have_text("accepted")

        claim_card = page.locator(".extraction-candidate").filter(
            has=page.locator(".extraction-candidate-title strong").filter(
                has_text=re.compile(r"^Aria\s*·\s*guards\s*·\s*the archive$")
            )
        )
        claim_card.get_by_label("Claim subject").select_option(label="Aria · person")
        claim_card.get_by_label("Confidence").select_option(label="Known")
        claim_card.get_by_label("Visibility").select_option(label="Actor scoped")
        claim_card.get_by_role("button", name="Accept reviewed item").click()
        expect(claim_card.locator(".extraction-status")).to_have_text("accepted")

        rejected_card = page.locator(".extraction-candidate").filter(
            has=page.locator(".extraction-candidate-title strong").filter(
                has_text=re.compile(r"^Kael\s*·\s*carries\s*·\s*a brass key$")
            )
        )
        rejected_card.get_by_role("button", name="Reject", exact=True).click()
        expect(rejected_card.locator(".extraction-status")).to_have_text("rejected")
        expect(page.locator(".extraction-controls .panel-count")).to_have_text("0 awaiting review")

        entities = page.request.get(
            f"{API}/workspaces/{workspace_id}/entities?branch_id=main", headers=HEADERS,
        ).json()
        claims = page.request.get(
            f"{API}/workspaces/{workspace_id}/claims?branch_id=main", headers=HEADERS,
        ).json()
        batches = page.request.get(
            f"{API}/workspaces/{workspace_id}/extractions?branch_id=main", headers=HEADERS,
        ).json()
        assert len(entities) == 1 and entities[0]["label"] == "Aria"
        assert len(claims) == 1
        assert claims[0]["predicate"] == "guards" and claims[0]["object_value"] == "the archive"
        assert claims[0]["epistemic_status"] == "known" and claims[0]["visibility"] == "actor_scoped"
        assert len(claims[0]["evidence"]) == 1
        assert len(batches) == 1 and len(batches[0]["candidates"]) == 3
        statuses = {candidate["payload"].get("predicate", candidate["payload"].get("label")): candidate["review_status"]
                    for candidate in batches[0]["candidates"]}
        assert statuses == {"Aria": "accepted", "guards": "accepted", "carries": "rejected"}
        assert MockOllamaHandler.chat_calls == 1
        print("Browser source extraction and review passed using deterministic mock Ollama output; live model quality was not exercised.")
    finally:
        if browser is not None:
            browser.close()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
