"""Scenario branch acceptance against the isolated local acceptance servers."""
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}


def post_command(page, workspace_id, revision, key, command_type, payload, branch_id="main"):
    response = page.request.post(
        f"{API}/workspaces/{workspace_id}/commands",
        headers=HEADERS,
        data={
            "branch_id": branch_id,
            "expected_revision": revision,
            "idempotency_key": key,
            "command_type": command_type,
            "reason": "Scenario browser acceptance fixture",
            "payload": payload,
        },
    )
    assert response.status == 200, response.text()
    return response.json()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page()
        page.set_default_timeout(10000)
        suffix = uuid4().hex[:10]
        workspace_id = f"browser-scenario-{suffix}"
        response = page.request.post(
            f"{API}/workspaces", headers=HEADERS,
            data={"workspace_id": workspace_id, "name": workspace_id},
        )
        assert response.status == 201, response.text()

        revision = post_command(page, workspace_id, 0, f"{suffix}-entity", "create_entity", {
            "entity_id": "project", "entity_type": "concept", "label": "Project", "properties": {},
        })["revision"]
        revision = post_command(page, workspace_id, revision, f"{suffix}-claim", "add_claim", {
            "claim_id": "funding",
            "subject_entity_id": "project",
            "predicate": "funding",
            "object_value": "secured",
            "epistemic_status": "known",
            "review_status": "accepted",
            "visibility": "public",
        })["revision"]
        revision = post_command(page, workspace_id, revision, f"{suffix}-rule", "create_rule", {
            "rule_id": "funding-required",
            "name": "Funding must be secured",
            "rule_mode": "require",
            "severity": "hard",
            "subject_entity_id": "project",
            "predicate": "funding",
            "object_value": "secured",
            "predicate_cardinality": "single",
            "review_status": "accepted",
        })["revision"]
        revision = post_command(page, workspace_id, revision, f"{suffix}-source", "import_source", {
            "source_id": "budget-note",
            "display_name": "Budget note",
            "media_type": "text/plain",
            "content": "The project currently has secured funding.",
        })["revision"]
        print("Seeded scenario workspace and canonical evidence.", flush=True)

        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")
        page.get_by_role("combobox", name="Select workspace").select_option(workspace_id)
        print("Selected the seeded workspace in the app.", flush=True)
        page.get_by_role("button", name=re.compile("Scenarios")).click()
        expect(page.get_by_role("heading", name="Decision & Scenario Lab")).to_be_visible()
        print("Opened the Scenario Lab.", flush=True)
        page.get_by_role("button", name=re.compile("Create scenario branch")).click()

        branch_selector = page.get_by_role("combobox", name="Select branch")
        expect(branch_selector.locator("option:checked")).to_have_text(re.compile(r"^scenario_"))
        branch_id = branch_selector.locator("option:checked").inner_text()
        branch_response = page.request.get(f"{API}/workspaces/{workspace_id}/branches", headers=HEADERS)
        assert branch_response.status == 200, branch_response.text()
        branch = next(item for item in branch_response.json() if item["branch_id"] == branch_id)
        assert branch["parent_branch_id"] == "main"
        assert branch["parent_revision"] == revision
        print("Created and loaded the isolated branch.", flush=True)

        form = page.locator(".scenario-create-form")
        form.get_by_label("Decision title").fill("Funding decision")
        form.get_by_label("Problem").fill("Should the project proceed while funding is secured?")
        form.get_by_label("Constraints").fill("Keep the project within its approved budget.")
        form.locator('input[name="option_a_label"]').fill("Proceed")
        form.locator('textarea[name="option_a_description"]').fill("Continue with the current plan.")
        form.locator('input[name="option_b_label"]').fill("Pause")
        form.locator('textarea[name="option_b_description"]').fill("Wait until funding changes.")
        form.get_by_text(re.compile(r"Link related claims")).click()
        form.locator('input[name="evidence_claim_ids"][value="funding"]').check()
        form.get_by_text(re.compile(r"Link sources")).click()
        form.locator('input[name="evidence_source_ids"][value="budget-note"]').check()
        form.get_by_role("button", name=re.compile("Save decision frame")).click()

        expect(page.get_by_role("combobox", name="Scenario").locator("option", has_text="Funding decision")).to_have_count(1)
        expect(page.get_by_text("Project · funding · secured", exact=True)).to_be_visible()
        expect(page.get_by_text("Budget note", exact=True)).to_be_visible()
        print("Saved the scenario with claim and source evidence.", flush=True)
        pause = page.locator(".scenario-option-card").nth(1)
        pause.get_by_label("Property").fill("funding")
        pause.get_by_label("Assumed value").fill("suspended")
        pause.get_by_role("button", name="Add assumption", exact=True).click()
        expect(pause.get_by_text("Project · funding · suspended", exact=True)).to_be_visible()
        expect(pause.get_by_text("accepted · v1", exact=True)).to_be_visible()
        expect(pause.get_by_text("violated", exact=True)).to_be_visible()
        expect(pause.get_by_text("conditional", exact=True)).to_be_visible()
        print("Added the option assumption and saw its conditional rule result.", flush=True)

        branch_scenarios_response = page.request.get(
            f"{API}/workspaces/{workspace_id}/scenarios?branch_id={branch_id}", headers=HEADERS,
        )
        assert branch_scenarios_response.status == 200, branch_scenarios_response.text()
        scenario = branch_scenarios_response.json()[0]
        assert scenario["title"] == "Funding decision"
        assert [item["claim_id"] for item in scenario["evidence_claims"]] == ["funding"]
        assert [item["source_id"] for item in scenario["evidence_sources"]] == ["budget-note"]
        pause_data = next(item for item in scenario["options"] if item["label"] == "Pause")
        outcome = pause_data["rule_evaluations"][0]["evaluation"]
        assert outcome["status"] == "violated" and outcome["conditional"]
        assert pause_data["assumptions"][0]["review_status"] == "accepted"

        main_scenarios_response = page.request.get(
            f"{API}/workspaces/{workspace_id}/scenarios?branch_id=main", headers=HEADERS,
        )
        assert main_scenarios_response.status == 200, main_scenarios_response.text()
        assert main_scenarios_response.json() == []
        main_claims_response = page.request.get(
            f"{API}/workspaces/{workspace_id}/claims?branch_id=main", headers=HEADERS,
        )
        assert main_claims_response.status == 200, main_claims_response.text()
        assert main_claims_response.json()[0]["object_value"] == "secured"
        print("Confirmed the main branch was unchanged before promotion.", flush=True)

        expect(page.get_by_text("2 branch changes", exact=True)).to_be_visible()
        history = page.locator(".branch-review-list li")
        expect(history).to_have_count(2)
        for index in range(2):
            revision_entry = history.nth(index)
            revision_entry.locator("summary").click()
            expect(revision_entry.locator("pre")).to_contain_text('"command_type"')
        assumption_revision = history.filter(has_text="Add a scenario assumption").first
        expect(assumption_revision.locator("pre")).to_contain_text("set_scenario_assumption")
        expect(assumption_revision.locator("pre")).to_contain_text("suspended")
        review_checkbox = page.get_by_role("checkbox", name=re.compile("I reviewed these branch changes"))
        promote_button = page.get_by_role("button", name=re.compile("Promote to main"))
        expect(review_checkbox).to_be_visible()
        expect(promote_button).to_be_disabled()
        review_checkbox.check()
        expect(promote_button).to_be_enabled()
        page.once("dialog", lambda dialog: dialog.accept())
        promote_button.click()

        expect(branch_selector.locator("option:checked")).to_have_text("Main")
        expect(page.get_by_text(re.compile(f"Promoted {re.escape(branch_id)} into main"))).to_be_visible()
        promoted_response = page.request.get(
            f"{API}/workspaces/{workspace_id}/scenarios?branch_id=main", headers=HEADERS,
        )
        assert promoted_response.status == 200, promoted_response.text()
        promoted = promoted_response.json()
        assert len(promoted) == 1 and promoted[0]["scenario_id"] == scenario["scenario_id"]
        promoted_pause = next(item for item in promoted[0]["options"] if item["label"] == "Pause")
        assert promoted_pause["assumptions"][0]["object_value"] == "suspended"
        assert promoted_pause["rule_evaluations"][0]["evaluation"]["conditional"] is True
        promoted_claims = page.request.get(
            f"{API}/workspaces/{workspace_id}/claims?branch_id=main", headers=HEADERS,
        )
        assert promoted_claims.status == 200, promoted_claims.text()
        assert promoted_claims.json()[0]["object_value"] == "secured"
        print("Promoted the reviewed branch and verified the canonical claim stayed unchanged.", flush=True)
        print("Scenario UI, evidence links, conditional comparison, branch isolation, reviewed promotion, and canonical claim preservation passed.")
    finally:
        browser.close()
