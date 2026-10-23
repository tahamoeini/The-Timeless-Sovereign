"""Journal & Memory browser acceptance against isolated local servers."""
import re
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}


def add_journal_event(page, workspace_id, title, temporal_kind, *, from_date=None, through_date=None, time_note="", participants="", source_title="", source_quote=""):
    form = page.locator(".journal-event-form form")
    form.get_by_label("What happened?").fill(title)
    form.get_by_label("More detail").fill("A personal account recorded in the browser acceptance flow.")
    form.get_by_label("People mentioned").fill(participants)
    form.get_by_label("How certain is the timing?").select_option(temporal_kind)
    if from_date:
        form.locator('input[name="occurred_from"]').fill(from_date)
    if through_date:
        form.locator('input[name="occurred_to"]').fill(through_date)
    if temporal_kind in {"relative", "unknown"}:
        form.get_by_label("Timing note").fill(time_note)
    if source_title:
        form.get_by_label("Saved source (optional)").select_option(label=source_title)
    if source_quote:
        form.get_by_label("Exact quote from the source (optional)").fill(source_quote)
    submit = form.get_by_role("button", name=re.compile("Add to memory timeline"))
    with page.expect_response(
        lambda response: response.url.endswith(f"/workspaces/{workspace_id}/commands")
        and response.request.method == "POST"
    ) as response_info:
        submit.click()
    response = response_info.value
    assert response.status == 200, response.text()
    expect(submit).to_be_enabled()
    expect(page.locator(".journal-event-card").filter(has_text=title)).to_be_visible()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page()
        page.set_default_timeout(10000)
        page.goto("http://127.0.0.1:5173")
        page.wait_for_load_state("networkidle")

        suffix = uuid4().hex[:10]
        workspace_name = f"Journal browser {suffix}"
        workspace_selector = page.get_by_role("combobox", name="Select workspace")
        workspace_selector.select_option("")
        page.get_by_role("textbox", name="Workspace name").fill(workspace_name)
        page.get_by_role("button", name=re.compile("Create workspace")).click()
        expect(page.get_by_role("heading", name="Story Studio", exact=True)).to_be_visible()
        selected_option = workspace_selector.locator("option:checked")
        expect(selected_option).to_have_text(workspace_name)
        workspace_id = selected_option.get_attribute("value")
        assert workspace_id

        page.get_by_role("button", name=re.compile("Journal.*Notes and memories", re.S)).click()
        expect(page.get_by_role("heading", name="Journal & Memory", exact=True)).to_be_visible()
        source_title = "Travel note"
        source_text = "Mina and I reached the coast on a cold morning."
        source_form = page.locator(".journal-grid form").first
        source_form.get_by_label("Source title").fill(source_title)
        source_form.get_by_label("Text content").fill(source_text)
        source_form.get_by_role("button", name=re.compile("Save source locally")).click()
        expect(page.get_by_role("heading", name=source_title, exact=True)).to_be_visible()
        expect(page.locator(".journal-reader pre")).to_have_text(source_text)

        add_journal_event(
            page, workspace_id, "Reached the coast", "exact", from_date="2024-03-05", participants="Mina",
            source_title=source_title, source_quote=source_text,
        )
        add_journal_event(page, workspace_id, "Arrival within a range", "range", from_date="2024-03-07", through_date="2024-03-08")
        add_journal_event(page, workspace_id, "Winter after university", "relative", time_note="The winter after university")
        add_journal_event(page, workspace_id, "Undated account", "unknown", time_note="The date was not recorded")

        original_card = page.locator(".journal-event-card").filter(has_text="Reached the coast")
        expect(original_card).to_be_visible()
        expect(original_card).to_contain_text("Mina")
        expect(original_card).to_contain_text(source_title)
        expect(original_card).to_contain_text(source_text)
        expect(page.locator(".journal-event-card")).to_have_count(4)
        page.get_by_role("textbox", name="From", exact=True).fill("2024-03-05")
        page.get_by_role("textbox", name="Through", exact=True).fill("2024-03-05")
        expect(page.locator(".journal-event-card")).to_have_count(1)
        expect(page.locator(".journal-event-card").first).to_contain_text("Reached the coast")
        page.get_by_role("textbox", name="Through", exact=True).fill("2024-03-07")
        page.get_by_role("textbox", name="From", exact=True).fill("2024-03-07")
        expect(page.locator(".journal-event-card")).to_have_count(1)
        expect(page.locator(".journal-event-card").first).to_contain_text("Arrival within a range")
        page.get_by_role("button", name="Clear dates", exact=True).click()
        expect(page.locator(".journal-event-card")).to_have_count(4)
        original_card = page.locator(".journal-event-card").filter(has_text="Reached the coast")
        expect(original_card).to_be_visible()

        original_card.get_by_role("button", name="Correct this account").click()
        correction_form = page.locator(".journal-event-form form")
        correction_form.get_by_label("What happened?").fill("Coast arrival, corrected")
        correction_form.get_by_label("More detail").fill("I checked the dated letter and corrected this account.")
        correction_form.locator('input[name="occurred_from"]').fill("2024-03-06")
        correction_form.get_by_role("button", name="Save correction").click()
        corrected_card = page.locator(".journal-event-card").filter(has_text="Coast arrival, corrected")
        expect(corrected_card).to_be_visible()
        expect(corrected_card).to_contain_text("Version 2")
        expect(corrected_card).to_contain_text("I checked the dated letter and corrected this account.")
        expect(corrected_card).to_contain_text(source_text)
        corrected_card.locator(".journal-event-history summary").click()
        expect(corrected_card.locator(".journal-event-history")).to_contain_text("Version 1")
        expect(corrected_card.locator(".journal-event-history")).to_contain_text("Reached the coast")
        expect(corrected_card.locator(".journal-event-history")).to_contain_text("March 5, 2024")
        expect(page.locator(".journal-reader pre")).to_have_text(source_text)

        page.get_by_role("button", name=re.compile("Scenarios")).click()
        page.get_by_role("button", name=re.compile("Create scenario branch")).click()
        branch_selector = page.get_by_role("combobox", name="Select branch")
        expect(branch_selector.locator("option:checked")).to_have_text(re.compile(r"^scenario_"))
        branch_id = branch_selector.locator("option:checked").inner_text()
        page.get_by_role("button", name=re.compile("Journal.*Notes and memories", re.S)).click()
        expect(page.locator(".journal-event-card").filter(has_text="Coast arrival, corrected")).to_be_visible()

        branch_card = page.locator(".journal-event-card").filter(has_text="Coast arrival, corrected")
        branch_card.get_by_role("button", name="Correct this account").click()
        branch_form = page.locator(".journal-event-form form")
        branch_form.get_by_label("What happened?").fill("Alternate branch arrival")
        branch_form.get_by_label("More detail").fill("This wording belongs only to the alternative branch.")
        branch_form.locator('input[name="occurred_from"]').fill("2024-03-07")
        branch_form.get_by_role("button", name="Save correction").click()
        expect(page.locator(".journal-event-card").filter(has_text="Alternate branch arrival")).to_be_visible()

        main_events_response = page.request.get(
            f"{API}/workspaces/{workspace_id}/journal-events?branch_id=main", headers=HEADERS,
        )
        branch_events_response = page.request.get(
            f"{API}/workspaces/{workspace_id}/journal-events?branch_id={branch_id}", headers=HEADERS,
        )
        assert main_events_response.status == 200, main_events_response.text()
        assert branch_events_response.status == 200, branch_events_response.text()
        main_event = next(event for event in main_events_response.json() if event["title"] == "Coast arrival, corrected")
        branch_event = next(
            event for event in branch_events_response.json()
            if event["event_id"] == main_event["event_id"]
        )
        assert main_event["title"] == "Coast arrival, corrected"
        assert main_event["version"] == 2 and main_event["occurred_from"] == "2024-03-06"
        assert branch_event["title"] == "Alternate branch arrival"
        assert branch_event["version"] == 3 and branch_event["occurred_from"] == "2024-03-07"

        page.get_by_role("combobox", name="Select branch").select_option("main")
        expect(page.locator(".journal-event-card").filter(has_text="Coast arrival, corrected")).to_be_visible()
        expect(page.locator(".journal-event-card").filter(has_text="Alternate branch arrival")).to_have_count(0)
        expect(page.locator(".journal-reader pre")).to_have_text(source_text)

        isolated_workspace_id = f"journal-isolation-{uuid4().hex[:10]}"
        isolated_workspace_response = page.request.post(
            f"{API}/workspaces", headers=HEADERS,
            data={"workspace_id": isolated_workspace_id, "name": isolated_workspace_id},
        )
        assert isolated_workspace_response.status == 201, isolated_workspace_response.text()
        page.reload()
        page.wait_for_load_state("networkidle")
        workspace_selector = page.get_by_role("combobox", name="Select workspace")
        workspace_selector.select_option(isolated_workspace_id)
        page.get_by_role("button", name=re.compile("Journal.*Notes and memories", re.S)).click()
        expect(page.get_by_role("heading", name="Journal & Memory", exact=True)).to_be_visible()
        expect(page.locator(".journal-event-card")).to_have_count(0)
        expect(page.get_by_text("Your notes remain yours.", exact=True)).to_be_visible()
        workspace_selector.select_option(workspace_id)
        expect(page.locator(".journal-event-card").filter(has_text="Coast arrival, corrected")).to_be_visible()
        expect(page.locator(".journal-reader pre")).to_have_text(source_text)
        print("Journal note preservation, sourced event capture, date filtering, correction history, branch isolation, and workspace isolation passed.")
    finally:
        browser.close()
