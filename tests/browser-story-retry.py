"""Verify delayed story generation and retry after a committed response is lost."""
import asyncio
import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from uuid import uuid4

from playwright.async_api import async_playwright, expect


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}


class MockOllamaHandler(BaseHTTPRequestHandler):
    story_calls = 0

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
        assert "format" not in request
        assert any("What should happen next?" in message["content"] for message in request["messages"])
        type(self).story_calls += 1
        time.sleep(1.25)
        self.send_json({"message": {"content": "The lantern waits at the threshold."}})


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
            workspace_id = f"story-retry-{suffix}"
            created = await page.request.post(
                f"{API}/workspaces", headers=HEADERS,
                data={"workspace_id": workspace_id, "name": workspace_id},
            )
            assert created.status == 201, await created.text()
            entity = await page.request.post(
                f"{API}/workspaces/{workspace_id}/commands", headers=HEADERS,
                data={
                    "branch_id": "main", "expected_revision": 0, "idempotency_key": f"{suffix}-character",
                    "command_type": "create_entity", "reason": "Create story retry fixture",
                    "payload": {"entity_id": "aria", "entity_type": "character", "label": "Aria"},
                },
            )
            assert entity.status == 200, await entity.text()

            await page.goto("http://127.0.0.1:5173")
            await page.wait_for_load_state("networkidle")
            await page.get_by_role("combobox", name="Select workspace").select_option(workspace_id)
            await expect(page.get_by_role("heading", name="Story Studio", exact=True)).to_be_visible()
            await expect(page.get_by_label("I control this character. Let me choose their words and actions.")).to_be_checked()
            await page.get_by_label("Story title").fill("The Lantern Door")
            await page.get_by_role("button", name="Start story", exact=False).click()
            saved_story = page.get_by_role("combobox", name="Select saved story")
            await expect(saved_story).not_to_have_value("")
            conversation_id = await saved_story.input_value()
            model_selector = page.get_by_label("Local model")
            await expect(model_selector.get_by_role("option", name="acceptance-model")).to_have_count(1)
            await model_selector.select_option(label="acceptance-model")
            prompt = "What should happen next?"
            prompt_field = page.get_by_label("Your direction")
            await prompt_field.fill(prompt)

            endpoint = f"{API}/workspaces/{workspace_id}/story/generate"
            intercepted_requests = []
            first_committed_response = None

            async def drop_first_response(route):
                nonlocal first_committed_response
                request_body = json.loads(route.request.post_data)
                intercepted_requests.append(request_body)
                response = await route.fetch()
                payload = await response.json()
                if len(intercepted_requests) == 1:
                    assert response.status == 200
                    assert payload["idempotent_replay"] is False
                    first_committed_response = payload
                    await route.abort("internetdisconnected")
                    return
                await route.fulfill(response=response)

            await page.route(endpoint, drop_first_response)
            submit = page.locator(".story-compose-form button")
            await submit.click()
            await expect(submit).to_contain_text("Writing locally…")
            await expect(submit).to_be_disabled()
            await expect(submit).to_have_text(re.compile("Continue story locally"), timeout=10000)
            await expect(page.locator(".story-canvas [role=alert]")).to_be_visible()
            await expect(prompt_field).to_have_value(prompt)
            assert first_committed_response is not None

            persisted_before_retry = await page.request.get(
                f"{API}/workspaces/{workspace_id}/conversations/{conversation_id}?branch_id=main",
                headers=HEADERS,
            )
            assert persisted_before_retry.status == 200, await persisted_before_retry.text()
            assert len((await persisted_before_retry.json())["turns"]) == 2
            assert MockOllamaHandler.story_calls == 1

            await submit.click()
            await expect(page.get_by_text("The lantern waits at the threshold.", exact=True)).to_be_visible()
            await expect(prompt_field).to_have_value("")
            assert len(intercepted_requests) == 2
            assert intercepted_requests[0] == intercepted_requests[1]
            assert intercepted_requests[0]["idempotency_key"]
            assert len(intercepted_requests[0]["idempotency_key"]) > 0

            final_conversation = await page.request.get(
                f"{API}/workspaces/{workspace_id}/conversations/{conversation_id}?branch_id=main",
                headers=HEADERS,
            )
            assert final_conversation.status == 200, await final_conversation.text()
            turns = (await final_conversation.json())["turns"]
            assert len(turns) == 2
            assert turns[0]["content"] == prompt and turns[1]["content"] == "The lantern waits at the threshold."
            assert MockOllamaHandler.story_calls == 1
            assert intercepted_requests[0]["idempotency_key"] == intercepted_requests[1]["idempotency_key"]
            print("Delayed generation and lost-response retry passed; the turn persisted once and replay avoided a second model call.")
            await page.unroute(endpoint)
        finally:
            await browser.close()


try:
    asyncio.run(main())
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=2)
