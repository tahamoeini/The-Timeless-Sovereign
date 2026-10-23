"""Verify that delayed workspace and branch loads cannot replace the selected scope."""
import asyncio
import re
from uuid import uuid4

from playwright.async_api import async_playwright, expect


API = "http://127.0.0.1:48124/api/v1"
HEADERS = {"Authorization": "Bearer lke-browser-acceptance-local-only"}


async def create_workspace(request, workspace_id):
    response = await request.post(
        f"{API}/workspaces", headers=HEADERS,
        data={"workspace_id": workspace_id, "name": workspace_id},
    )
    assert response.status == 201, await response.text()


async def create_entity(request, workspace_id, revision, entity_id, label, *, branch_id="main", key):
    response = await request.post(
        f"{API}/workspaces/{workspace_id}/commands", headers=HEADERS,
        data={
            "branch_id": branch_id,
            "expected_revision": revision,
            "idempotency_key": key,
            "command_type": "create_entity",
            "reason": "Scope race browser fixture",
            "payload": {"entity_id": entity_id, "entity_type": "person", "label": label},
        },
    )
    assert response.status == 200, await response.text()
    return (await response.json())["revision"]


async def main():
    suffix = uuid4().hex[:10]
    primary_id = f"scope-primary-{suffix}"
    secondary_id = f"scope-secondary-{suffix}"

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel="msedge", headless=True)
        try:
            page = await browser.new_page()
            page.set_default_timeout(10000)
            await create_workspace(page.request, primary_id)
            await create_workspace(page.request, secondary_id)
            primary_revision = await create_entity(
                page.request, primary_id, 0, "primary-person", "Primary person", key=f"{suffix}-primary",
            )
            await create_entity(page.request, secondary_id, 0, "secondary-person", "Secondary person", key=f"{suffix}-secondary")

            branch_response = await page.request.post(
                f"{API}/workspaces/{primary_id}/branches", headers=HEADERS,
                data={
                    "branch_id": "alternative",
                    "parent_branch_id": "main",
                    "expected_revision": primary_revision,
                    "idempotency_key": f"{suffix}-branch",
                    "reason": "Create a scope race fixture branch",
                },
            )
            assert branch_response.status == 201, await branch_response.text()
            await create_entity(
                page.request, primary_id, primary_revision, "alternative-person", "Alternative person",
                branch_id="alternative", key=f"{suffix}-alternative",
            )

            await page.goto("http://127.0.0.1:5173")
            await page.wait_for_load_state("networkidle")
            workspace_selector = page.get_by_role("combobox", name="Select workspace")
            await workspace_selector.select_option(primary_id)
            await page.get_by_role("button", name=re.compile("Knowledge.*Sources and relationships", re.S)).click()
            graph = page.get_by_role("img", name="Knowledge graph")
            await expect(graph.locator("text.node-label")).to_have_text(["Primary person"])

            branch_selector = page.get_by_role("combobox", name="Select branch")
            await expect(branch_selector.get_by_role("option", name="alternative")).to_have_count(1)
            alternative_url = f"{API}/workspaces/{primary_id}/entities?branch_id=alternative"
            alternative_started = asyncio.Event()
            release_alternative = asyncio.Event()
            alternative_response_received = asyncio.Event()

            async def pause_alternative(route):
                alternative_started.set()
                await release_alternative.wait()
                await route.continue_()

            def observe_alternative(response):
                if response.url == alternative_url:
                    alternative_response_received.set()

            await page.route(alternative_url, pause_alternative)
            page.on("response", observe_alternative)
            await branch_selector.select_option("alternative")
            await asyncio.wait_for(alternative_started.wait(), timeout=10)
            await branch_selector.select_option("main")
            await expect(graph.locator("text.node-label")).to_have_text(["Primary person"])
            release_alternative.set()
            await asyncio.wait_for(alternative_response_received.wait(), timeout=10)
            await expect(graph.locator("text.node-label")).to_have_text(["Primary person"])
            await page.unroute(alternative_url)
            page.remove_listener("response", observe_alternative)

            primary_url = f"{API}/workspaces/{primary_id}/entities?branch_id=main"
            primary_started = asyncio.Event()
            release_primary = asyncio.Event()
            primary_response_received = asyncio.Event()

            async def pause_primary(route):
                primary_started.set()
                await release_primary.wait()
                await route.continue_()

            def observe_primary(response):
                if response.url == primary_url:
                    primary_response_received.set()

            await page.route(primary_url, pause_primary)
            page.on("response", observe_primary)
            await page.get_by_role("button", name="Refresh", exact=True).click()
            await asyncio.wait_for(primary_started.wait(), timeout=10)
            await workspace_selector.select_option(secondary_id)
            await expect(graph.locator("text.node-label")).to_have_text(["Secondary person"])
            release_primary.set()
            await asyncio.wait_for(primary_response_received.wait(), timeout=10)
            await expect(graph.locator("text.node-label")).to_have_text(["Secondary person"])
            await expect(graph.get_by_text("Primary person", exact=True)).to_have_count(0)
            await expect(graph.get_by_text("Alternative person", exact=True)).to_have_count(0)
            await page.unroute(primary_url)
            page.remove_listener("response", observe_primary)
            print("Delayed branch and workspace responses did not replace the currently selected scope.")
        finally:
            await browser.close()


asyncio.run(main())
