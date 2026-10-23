"""Relationship correction parity acceptance against isolated local servers."""
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}


def command(page, workspace_id, revision, key, command_type, payload):
    response = page.request.post(
        f"{API}/workspaces/{workspace_id}/commands",
        headers=HEADERS,
        data={
            "branch_id": "main",
            "expected_revision": revision,
            "idempotency_key": key,
            "command_type": command_type,
            "reason": "Relationship correction browser fixture",
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
        workspace_id = f"browser-correction-{suffix}"
        response = page.request.post(
            f"{API}/workspaces", headers=HEADERS,
            data={"workspace_id": workspace_id, "name": workspace_id},
        )
        assert response.status == 201, response.text()
        revision = 0
        revision = command(page, workspace_id, revision, f"{suffix}-source", "import_source", {
            "source_id": "archive-source",
            "display_name": "Archive source",
            "media_type": "text/plain",
            "content": "Aria guards the archive.",
        })
        for entity_id, label, entity_type in (
            ("aria", "Aria", "character"),
            ("kael", "Kael", "character"),
            ("mira", "Mira", "person"),
        ):
            revision = command(page, workspace_id, revision, f"{suffix}-{entity_id}", "create_entity", {
                "entity_id": entity_id, "entity_type": entity_type, "label": label,
                "properties": {"role": "guardian", "rank": 1} if entity_id == "aria" else {},
            })
        revision = command(page, workspace_id, revision, f"{suffix}-relation", "add_relation", {
            "relation_id": "aria-kael",
            "source_entity_id": "aria",
            "target_entity_id": "kael",
            "relation_type": "trusts",
            "review_status": "accepted",
            "properties": {},
        })
        revision = command(page, workspace_id, revision, f"{suffix}-evidence", "add_evidence", {
            "evidence_id": "archive-quote",
            "source_id": "archive-source",
            "anchor": "chars:0:24",
            "quote": "Aria guards the archive.",
        })
        revision = command(page, workspace_id, revision, f"{suffix}-claim", "add_claim", {
            "claim_id": "aria-claim",
            "subject_entity_id": "aria",
            "predicate": "guards",
            "object_value": "the archive",
            "epistemic_status": "known",
            "review_status": "accepted",
            "visibility": "public",
            "narrative_order": 0,
            "evidence": ["archive-quote"],
        })

        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")
        page.get_by_role("combobox", name="Select workspace").select_option(workspace_id)
        page.get_by_role("button", name=re.compile("Knowledge.*Sources and relationships", re.S)).click()
        graph = page.get_by_role("img", name="Knowledge graph")
        expect(graph.locator("text.edge-label")).to_have_text(["trusts"])
        expect(graph.locator("line.edge:not(.proposed)")).to_have_count(1)

        page.get_by_role("button", name="Relationship matrix").click()
        matrix_row = page.locator(".relation-matrix tbody tr").filter(has_text="Aria")
        expect(matrix_row.locator("td").nth(1)).to_contain_text("trusts")
        expect(matrix_row.locator("td").nth(1)).to_contain_text("Accepted")

        page.get_by_role("button", name="Edit records").click()
        relation_panel = page.locator(".knowledge-record-panel").nth(1)
        relation_row = relation_panel.locator(".knowledge-record-row").filter(has_text="Aria · trusts · Kael")
        relation_row.get_by_role("button", name="Edit", exact=True).click()
        editor = relation_row.locator(".record-edit-form")
        editor.get_by_label("Relationship").fill("fears")
        editor.get_by_label("To").select_option("mira")
        editor.get_by_role("button", name="Save correction").click()
        relation_row = relation_panel.locator(".knowledge-record-row").filter(has_text="Aria · fears · Mira")
        expect(relation_row).to_contain_text("Aria · fears · Mira")
        expect(relation_row).to_contain_text("proposed · relationship aria-kael")

        page.get_by_role("button", name="Knowledge map").click()
        graph = page.get_by_role("img", name="Knowledge graph")
        expect(graph.locator("text.edge-label")).to_have_text(["fears"])
        expect(graph.locator("line.edge.proposed")).to_have_count(1)

        page.get_by_role("button", name="Relationship matrix").click()
        matrix_row = page.locator(".relation-matrix tbody tr").filter(has_text="Aria")
        expect(matrix_row.locator("td").nth(1)).to_contain_text("—")
        expect(matrix_row.locator("td").nth(2)).to_contain_text("fears")
        expect(matrix_row.locator("td").nth(2)).to_contain_text("Needs review")

        page.get_by_role("button", name="History").click()
        revision_row = page.locator(".revision-row").filter(has_text="Correct relationship Aria")
        expect(revision_row).to_be_visible()
        revision_row.locator(".revision-detail summary").click()
        expect(revision_row.locator("pre")).to_contain_text('"target_entity_id": "mira"')
        expect(revision_row.locator("pre")).to_contain_text('"review_status": "proposed"')

        page.get_by_role("button", name="Review").click()
        review_row = page.locator(".review-row").filter(has_text="aria · fears · mira")
        expect(review_row).to_be_visible()
        review_row.get_by_role("button", name="Accept", exact=True).click()
        expect(page.locator(".review-row").filter(has_text="aria · fears · mira")).to_have_count(0)

        relation_response = page.request.get(
            f"{API}/workspaces/{workspace_id}/relations?branch_id=main", headers=HEADERS,
        )
        assert relation_response.status == 200, relation_response.text()
        relation = relation_response.json()[0]
        assert relation["source_entity_id"] == "aria"
        assert relation["target_entity_id"] == "mira"
        assert relation["relation_type"] == "fears"
        assert relation["review_status"] == "accepted"

        page.get_by_role("button", name="Knowledge map").click()
        graph = page.get_by_role("img", name="Knowledge graph")
        expect(graph.locator("text.edge-label")).to_have_text(["fears"])
        expect(graph.locator("line.edge:not(.proposed)")).to_have_count(1)
        page.get_by_role("button", name="Relationship matrix").click()
        matrix_row = page.locator(".relation-matrix tbody tr").filter(has_text="Aria")
        expect(matrix_row.locator("td").nth(2)).to_contain_text("fears")
        expect(matrix_row.locator("td").nth(2)).to_contain_text("Accepted")

        page.get_by_role("button", name="Edit records").click()
        entity_panel = page.locator(".knowledge-record-panel").nth(0)
        entity_row = entity_panel.locator(".knowledge-record-row").filter(has_text="Aria")
        entity_row.get_by_role("button", name="Edit", exact=True).click()
        entity_editor = entity_row.locator(".record-edit-form")
        entity_editor.get_by_label("Display name").fill("Aria Vale")
        entity_editor.get_by_label("Type").fill("person")
        entity_editor.get_by_label("Properties (JSON)").fill('{"rank": 2, "role": "archive guardian"}')
        entity_editor.get_by_role("button", name="Save correction").click()
        entity_row = entity_panel.locator(".knowledge-record-row").filter(has_text="Aria Vale")
        expect(entity_row).to_contain_text("person · updated at revision")

        entity_response = page.request.get(
            f"{API}/workspaces/{workspace_id}/entities?branch_id=main", headers=HEADERS,
        )
        assert entity_response.status == 200, entity_response.text()
        aria = next(entity for entity in entity_response.json() if entity["entity_id"] == "aria")
        assert aria["label"] == "Aria Vale" and aria["entity_type"] == "person"
        assert aria["properties"] == {"rank": 2, "role": "archive guardian"}

        page.get_by_role("button", name="Knowledge map").click()
        graph = page.get_by_role("img", name="Knowledge graph")
        expect(graph.locator("text.node-label").filter(has_text="Aria Vale")).to_have_count(1)
        page.get_by_role("button", name="Relationship matrix").click()
        renamed_row = page.locator(".relation-matrix tbody tr").filter(has_text="Aria Vale")
        expect(renamed_row.locator("th")).to_contain_text("Aria Vale")
        expect(renamed_row.locator("td").nth(2)).to_contain_text("fears")

        page.get_by_role("button", name="Edit records").click()
        claim_panel = page.locator(".knowledge-record-panel").nth(2)
        claim_row = claim_panel.locator(".knowledge-record-row").filter(has_text="Aria Vale · guards · the archive")
        claim_row.get_by_role("button", name="Edit", exact=True).click()
        claim_editor = claim_row.locator(".record-edit-form")
        claim_editor.get_by_label("Epistemic status").select_option("contested")
        claim_editor.get_by_label("Visibility").select_option("actor_scoped")
        claim_editor.get_by_label("Narrative order").fill("1")
        claim_editor.get_by_role("button", name="Save correction").click()
        claim_row = claim_panel.locator(".knowledge-record-row").filter(has_text="Aria Vale · guards · the archive")
        expect(claim_row).to_contain_text("contested · proposed · actor_scoped")

        page.get_by_role("button", name="Review").click()
        claim_review_row = page.locator(".review-row").filter(has_text="aria · guards · the archive")
        expect(claim_review_row).to_be_visible()
        claim_review_row.get_by_role("button", name="Accept", exact=True).click()
        expect(page.locator(".review-row").filter(has_text="aria · guards · the archive")).to_have_count(0)

        claims_response = page.request.get(
            f"{API}/workspaces/{workspace_id}/claims?branch_id=main", headers=HEADERS,
        )
        assert claims_response.status == 200, claims_response.text()
        claim = next(item for item in claims_response.json() if item["claim_id"] == "aria-claim")
        assert claim["subject_entity_id"] == "aria" and claim["predicate"] == "guards"
        assert claim["object_value"] == "the archive" and claim["review_status"] == "accepted"
        assert claim["epistemic_status"] == "contested" and claim["visibility"] == "actor_scoped"
        assert claim["narrative_order"] == 1 and claim["evidence"] == ["archive-quote"]

        page.get_by_role("button", name="History").click()
        history = page.locator(".revision-row")
        expect(history.filter(has_text="Correct relationship Aria")).to_be_visible()
        expect(history.filter(has_text="User accepted relation")).to_be_visible()
        entity_revision = history.filter(has_text="Correct entity Aria")
        expect(entity_revision).to_be_visible()
        entity_revision.locator(".revision-detail summary").click()
        expect(entity_revision.locator("pre")).to_contain_text('"entity_id": "aria"')
        expect(entity_revision.locator("pre")).to_contain_text('"label": "Aria Vale"')
        claim_revision = history.filter(has_text="Correct claim Aria Vale · guards")
        expect(claim_revision).to_be_visible()
        claim_revision.locator(".revision-detail summary").click()
        expect(claim_revision.locator("pre")).to_contain_text('"review_status": "proposed"')
        expect(claim_revision.locator("pre")).to_contain_text('"epistemic_status": "contested"')
        expect(claim_revision.locator("pre")).to_contain_text("archive-quote")
        expect(history.filter(has_text="User accepted claim")).to_be_visible()
        print("Relationship, entity, and claim correction, renewed review, cross-view consistency, and revision history passed.")
    finally:
        browser.close()
