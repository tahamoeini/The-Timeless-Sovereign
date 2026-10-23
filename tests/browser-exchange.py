"""Verify external transcript import stays reviewable and separate from canon in the browser."""
import json
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}


def envelope(workspace_id, *, exchange_id, turn_number, content, total_turns=4):
    context_id = "context-main-0"
    return {
        "protocol": "lke.exchange.v1",
        "transcript_id": "external-conversation-1",
        "workspace_id": workspace_id,
        "branch_id": "main",
        "base_revision": 0,
        "exchange_id": exchange_id,
        "context_manifest_id": context_id,
        "context_manifest": {
            "protocol": "lke.context.v1",
            "manifest_id": context_id,
            "workspace_id": workspace_id,
            "branch_id": "main",
            "base_revision": 0,
            "actor": {"entity_id": None, "label": "Narrator", "entity_type": "narrator"},
            "as_of_narrative_order": turn_number,
            "included": [],
            "excluded": [],
            "token_estimate": 0,
        },
        "transcript_range": {"from_turn": turn_number, "to_turn": turn_number},
        "transcript_total_turns": total_turns,
        "turns": [{
            "turn_number": turn_number,
            "messages": [
                {"role": "user", "content": f"Continue from turn {turn_number}."},
                {"role": "assistant", "content": content},
            ],
        }],
        "proposed_change_ids": ["claim-proposal-1"],
    }


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page()
        page.set_default_timeout(10000)
        suffix = uuid4().hex[:10]
        workspace_id = f"exchange-browser-{suffix}"
        created = page.request.post(
            f"{API}/workspaces", headers=HEADERS,
            data={"workspace_id": workspace_id, "name": workspace_id},
        )
        assert created.status == 201, created.text()

        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")
        page.get_by_role("combobox", name="Select workspace").select_option(workspace_id)
        panel = page.locator(".external-exchange-panel")
        expect(panel.get_by_role("heading", name="External conversation exchange", exact=True)).to_be_visible()
        expect(panel).to_contain_text("Importing never accepts facts or applies proposed changes.")

        first = envelope(
            workspace_id, exchange_id="external-segment-first", turn_number=2,
            content="The archive door opens.",
        )
        upload = panel.locator("input[name='exchange_file']")
        upload.set_input_files({
            "name": "segment-first.json", "mimeType": "application/json",
            "buffer": json.dumps(first, ensure_ascii=False).encode("utf-8"),
        })
        panel.get_by_role("button", name="Import transcript", exact=True).click()
        expect(panel.locator(".external-exchange")).to_have_count(1)
        expect(panel.locator(".context-export-success")).to_contain_text("Missing turn ranges were detected")
        first_exchange = panel.locator(".external-exchange").filter(has_text="external-segment-first")
        first_exchange.locator("summary").first.click()
        expect(first_exchange).to_contain_text("Transcript external-conversation-1")
        expect(first_exchange).to_contain_text("Turns 2–2 of 4")
        expect(first_exchange).to_contain_text("Missing turns in this transcript: 1–1, 3–4")
        expect(first_exchange).to_contain_text("The archive door opens.")
        expect(first_exchange).to_contain_text("claim-proposal-1")

        upload.set_input_files({
            "name": "segment-first.json", "mimeType": "application/json",
            "buffer": json.dumps(first, ensure_ascii=False).encode("utf-8"),
        })
        panel.get_by_role("button", name="Import transcript", exact=True).click()
        expect(panel.locator(".context-export-success")).to_contain_text("already imported; no duplicate was added")
        expect(panel.locator(".external-exchange")).to_have_count(1)
        revision = page.request.get(
            f"{API}/workspaces/{workspace_id}/revision?branch_id=main", headers=HEADERS,
        )
        assert revision.status == 200 and revision.json()["revision"] == 1

        second = envelope(
            workspace_id, exchange_id="external-segment-later", turn_number=4,
            content="The archive closes behind her.",
        )
        upload.set_input_files({
            "name": "segment-later.json", "mimeType": "application/json",
            "buffer": json.dumps(second, ensure_ascii=False).encode("utf-8"),
        })
        panel.get_by_role("button", name="Import transcript", exact=True).click()
        expect(panel.locator(".external-exchange")).to_have_count(2)
        later_exchange = panel.locator(".external-exchange").filter(has_text="external-segment-later")
        later_exchange.locator("summary").first.click()
        expect(later_exchange.locator(".exchange-status")).to_have_text("Stale context")
        expect(later_exchange).to_contain_text("Missing turns in this transcript: 1–1, 3–3")
        expect(later_exchange).to_contain_text("The archive closes behind her.")

        entities = page.request.get(
            f"{API}/workspaces/{workspace_id}/entities?branch_id=main", headers=HEADERS,
        )
        claims = page.request.get(
            f"{API}/workspaces/{workspace_id}/claims?branch_id=main", headers=HEADERS,
        )
        conversations = page.request.get(
            f"{API}/workspaces/{workspace_id}/conversations?branch_id=main", headers=HEADERS,
        )
        exchanges = page.request.get(
            f"{API}/workspaces/{workspace_id}/exchanges?branch_id=main", headers=HEADERS,
        )
        assert entities.status == claims.status == conversations.status == exchanges.status == 200
        assert entities.json() == [] and claims.json() == [] and conversations.json() == []
        assert len(exchanges.json()) == 2
        assert all(item["transcript_hash"].startswith("sha256:") for item in exchanges.json())
        assert all(item["proposed_change_ids"] == ["claim-proposal-1"] for item in exchanges.json())
        print("External transcript browser import, gap review, stale-context retention, deduplication, and canon separation passed.")
    finally:
        browser.close()
