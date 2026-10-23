"""Verify character-memory Q&A is time-scoped and cites only eligible claims."""

import asyncio
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from uuid import uuid4

from playwright.async_api import async_playwright, expect


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}


class MockOllamaHandler(BaseHTTPRequestHandler):
    query_calls = 0

    def log_message(self, _format, *_args):
        pass

    def send_json(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/tags":
            self.send_json({"models": [{"name": "acceptance-model"}]})
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length).decode("utf-8"))
        assert request["model"] == "acceptance-model"
        assert request["format"] == "json"
        message = next(item for item in request["messages"] if item["role"] == "user")
        query = json.loads(message["content"])
        claim_ids = [claim["claim_id"] for claim in query["memory_claims"]]
        assert query["as_of_narrative_order"] == 2
        assert claim_ids == ["past"]
        assert "future" not in message["content"]
        assert "unreviewed" not in message["content"]
        assert "unaware" not in message["content"]
        type(self).query_calls += 1
        time.sleep(0.2)
        self.send_json({
            "message": {
                "content": json.dumps({
                    "status": "answered",
                    "answer": "Aria remembers the bronze key.",
                    "claim_ids": ["past"],
                }, ensure_ascii=False),
            },
        })


def create_command(page, workspace_id, revision, key, command_type, payload):
    response = page.request.post(
        f"{API}/workspaces/{workspace_id}/commands",
        headers=HEADERS,
        data={
            "branch_id": "main", "expected_revision": revision, "idempotency_key": key,
            "command_type": command_type, "reason": "Temporal query browser acceptance", "payload": payload,
        },
    )
    assert response.status == 200, response.text()
    return response.json()["revision"]


server = ThreadingHTTPServer(("127.0.0.1", 11434), MockOllamaHandler)
server_thread = Thread(target=server.serve_forever, daemon=True)
server_thread.start()


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel="msedge", headless=True)
        try:
            page = await browser.new_page()
            page.set_default_timeout(10000)
            suffix = uuid4().hex[:10]
            workspace_id = f"temporal-query-{suffix}"
            created = await page.request.post(
                f"{API}/workspaces", headers=HEADERS,
                data={"workspace_id": workspace_id, "name": workspace_id},
            )
            assert created.status == 201, await created.text()
            revision = create_command(page, workspace_id, 0, f"{suffix}-actor", "create_entity", {
                "entity_id": "aria", "entity_type": "character", "label": "Aria",
            })
            revision = create_command(page, workspace_id, revision, f"{suffix}-past", "add_claim", {
                "claim_id": "past", "subject_entity_id": "aria", "predicate": "remembers",
                "object_value": "the bronze key", "epistemic_status": "known", "review_status": "accepted",
                "narrative_order": 1,
            })
            revision = create_command(page, workspace_id, revision, f"{suffix}-past-belief", "add_belief", {
                "belief_id": "past-belief", "actor_entity_id": "aria", "claim_id": "past",
                "stance": "knows", "awareness_order": 1,
            })
            revision = create_command(page, workspace_id, revision, f"{suffix}-future", "add_claim", {
                "claim_id": "future", "subject_entity_id": "aria", "predicate": "will find",
                "object_value": "the hidden vault", "epistemic_status": "known", "review_status": "accepted",
                "narrative_order": 4,
            })
            revision = create_command(page, workspace_id, revision, f"{suffix}-future-belief", "add_belief", {
                "belief_id": "future-belief", "actor_entity_id": "aria", "claim_id": "future",
                "stance": "knows", "awareness_order": 4,
            })
            revision = create_command(page, workspace_id, revision, f"{suffix}-unreviewed", "add_claim", {
                "claim_id": "unreviewed", "subject_entity_id": "aria", "predicate": "may have",
                "object_value": "the silver map", "epistemic_status": "believed", "review_status": "proposed",
                "narrative_order": 1,
            })
            revision = create_command(page, workspace_id, revision, f"{suffix}-unreviewed-belief", "add_belief", {
                "belief_id": "unreviewed-belief", "actor_entity_id": "aria", "claim_id": "unreviewed",
                "stance": "believes", "awareness_order": 1,
            })
            revision = create_command(page, workspace_id, revision, f"{suffix}-unaware", "add_claim", {
                "claim_id": "unaware", "subject_entity_id": "aria", "predicate": "guards",
                "object_value": "the eastern gate", "epistemic_status": "known", "review_status": "accepted",
                "narrative_order": 1,
            })
            assert revision > 0

            await page.goto("http://127.0.0.1:5173")
            await page.wait_for_load_state("networkidle")
            await page.get_by_role("combobox", name="Select workspace").select_option(workspace_id)
            await expect(page.get_by_role("heading", name="Story Studio", exact=True)).to_be_visible()
            await expect(page.get_by_label("Local model").get_by_role("option", name="acceptance-model")).to_have_count(1)

            order = page.locator(".context-panel input[type=number]")
            question = page.locator(".temporal-query-form textarea")
            submit = page.locator(".temporal-query-form button")
            await question.fill("What does Aria remember about the archive?")
            await submit.click()
            await expect(page.get_by_text("Insufficient memory", exact=True)).to_be_visible()
            assert MockOllamaHandler.query_calls == 0

            await order.fill("2")
            await question.fill("What does Aria remember at this point?")
            await submit.click()
            await expect(page.get_by_text("Aria remembers the bronze key.", exact=True)).to_be_visible()
            await expect(page.get_by_text("the bronze key", exact=False)).to_be_visible()
            assert MockOllamaHandler.query_calls == 1

            response = await page.request.get(f"{API}/workspaces/{workspace_id}/revision?branch_id=main", headers=HEADERS)
            assert response.status == 200 and response.json()["revision"] == revision
            print("Temporal Q&A omitted future, unreviewed, and actor-unaware claims; cited the eligible claim and left revision unchanged.")
        finally:
            await browser.close()


try:
    asyncio.run(main())
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=2)
