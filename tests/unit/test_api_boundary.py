"""Authenticated local API behavior using an in-memory database."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import threading
import unittest
from unittest.mock import patch

import httpx

from lke.ai import OllamaError
from lke.api.app import _external_provider_context, create_app
from lke.core import Database


class FakeOllama:
    def __init__(self, failure: bool = False) -> None:
        self.failure = failure
        self.calls: list[tuple[str, list[dict[str, str]]]] = []
        self.structured_calls: list[tuple[str, list[dict[str, str]]]] = []
        self.structured_response = {
            "entities": [{"label": "Aria", "entity_type": "person", "quote": "Aria"}],
            "claims": [{
                "subject_label": "Aria", "predicate": "guards", "object_value": "the archive",
                "quote": "Aria guards the archive.",
            }],
        }
        self.structured_callback = None
        self.generation_callback = None

    def list_models(self) -> list[str]:
        return ["test-model"]

    def generate(self, model: str, messages: list[dict[str, str]], *, cancel_event: threading.Event | None = None) -> str:
        self.calls.append((model, messages))
        if self.generation_callback:
            return self.generation_callback(model, messages, cancel_event)
        if self.failure:
            raise OllamaError("Ollama is not responding on this device.")
        return "Aria waits for the user's next choice."

    def generate_json(
        self, model: str, messages: list[dict[str, str]], *, cancel_event: threading.Event | None = None,
    ) -> dict[str, object]:
        self.structured_calls.append((model, messages))
        if self.failure:
            raise OllamaError("Ollama is not responding on this device.")
        if self.structured_callback:
            self.structured_callback()
        return self.structured_response


class ApiBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = Database(":memory:")
        self.ollama = FakeOllama()
        self.app = create_app(self.database, auth_token="test-token", ollama=self.ollama)
        self.headers = {"Authorization": "Bearer test-token"}

    def tearDown(self) -> None:
        self.database.close()

    def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        async def send() -> httpx.Response:
            transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 8000))
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.request(method, path, **kwargs)

        return asyncio.run(send())

    def test_application_title_is_lorethra(self) -> None:
        self.assertEqual(self.app.title, "Lorethra")

    def test_health_is_public_but_data_requires_authentication(self) -> None:
        self.assertEqual(self.request("GET", "/api/v1/health").status_code, 200)
        self.assertEqual(self.request("GET", "/api/v1/workspaces").status_code, 401)

    def test_chunked_request_body_without_content_length_is_still_bounded(self) -> None:
        async def send() -> httpx.Response:
            async def oversized_body():
                yield b" " * (11 * 1024 * 1024 + 1)

            transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 8000))
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.post(
                    "/api/v1/workspaces/destination/story/adventures/package-preview",
                    headers=self.headers, content=oversized_body(),
                )

        response = asyncio.run(send())
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(response.json(), {"detail": "Request body is too large"})

    def test_remote_model_discovery_requires_authentication_and_explicit_post(self) -> None:
        with patch("lke.ai.providers.StoryProviderRegistry.discover_models", return_value=["model-a"]) as discover:
            self.assertEqual(self.request("POST", "/api/v1/providers/story/openai/models").status_code, 401)
            discover.assert_not_called()
            response = self.request("POST", "/api/v1/providers/story/openai/models", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"models": ["model-a"]})
        discover.assert_called_once_with("openai")

    def test_codex_model_discovery_returns_supported_effort_choices(self) -> None:
        options = [{
            "model": "model-a", "display_name": "Model A", "default_reasoning_effort": "medium",
            "supported_reasoning_efforts": ["low", "medium", "high"], "effort_descriptions": {},
        }]
        with patch("lke.ai.providers.StoryProviderRegistry.discover_model_options", return_value=options) as discover:
            response = self.request("POST", "/api/v1/providers/story/codex/models", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"models": ["model-a"], "model_options": options})
        discover.assert_called_once_with("codex")

    def test_unknown_origin_is_rejected(self) -> None:
        response = self.request(
            "GET",
            "/api/v1/workspaces",
            headers={**self.headers, "Origin": "https://untrusted.example"},
        )
        self.assertEqual(response.status_code, 403)

    def test_vite_origin_is_allowed_only_in_dev_mode(self) -> None:
        origin = "http://127.0.0.1:5173"
        with patch.dict(os.environ, {"LKE_DEV_MODE": "0"}):
            self.app = create_app(self.database, auth_token="test-token")
            rejected = self.request("GET", "/api/v1/health", headers={"Origin": origin})
        self.assertEqual(rejected.status_code, 403)

        with patch.dict(os.environ, {"LKE_DEV_MODE": "1"}):
            self.app = create_app(self.database, auth_token="test-token")
            allowed = self.request("GET", "/api/v1/health", headers={"Origin": origin})
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), origin)

    def test_preflight_allows_only_required_methods_and_headers(self) -> None:
        origin = "http://127.0.0.1:5173"
        with patch.dict(os.environ, {"LKE_DEV_MODE": "1"}):
            self.app = create_app(self.database, auth_token="test-token")
            allowed = self.request(
                "OPTIONS",
                "/api/v1/workspaces",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "authorization, content-type",
                },
            )
            denied = self.request(
                "OPTIONS",
                "/api/v1/workspaces",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "DELETE",
                    "Access-Control-Request-Headers": "authorization, content-type",
                },
            )
        self.assertEqual(allowed.status_code, 204)
        self.assertEqual(denied.status_code, 403)

    def test_authenticated_command_round_trip(self) -> None:
        created = self.request(
            "POST",
            "/api/v1/workspaces",
            headers=self.headers,
            json={"workspace_id": "api-workspace", "name": "API Test"},
        )
        self.assertEqual(created.status_code, 201)
        response = self.request(
            "POST",
            "/api/v1/workspaces/api-workspace/commands",
            headers=self.headers,
            json={
                "branch_id": "main",
                "expected_revision": 0,
                "idempotency_key": "create-api-entity",
                "command_type": "create_entity",
                "reason": "Exercise the authenticated API",
                "payload": {
                    "entity_id": "api-entity",
                    "entity_type": "concept",
                    "label": "API Entity",
                    "properties": {},
                },
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        source = self.request(
            "POST",
            "/api/v1/workspaces/api-workspace/commands",
            headers=self.headers,
            json={
                "branch_id": "main",
                "expected_revision": 1,
                "idempotency_key": "import-api-source",
                "command_type": "import_source",
                "reason": "Exercise source listing",
                "payload": {
                    "source_id": "api-source",
                    "display_name": "API source",
                    "content": "Aria keeps the brass key.",
                    "media_type": "text/plain",
                },
            },
        )
        self.assertEqual(source.status_code, 200, source.text)
        entities = self.request(
            "GET", "/api/v1/workspaces/api-workspace/entities", headers=self.headers
        )
        self.assertEqual([item["entity_id"] for item in entities.json()], ["api-entity"])
        sources = self.request(
            "GET", "/api/v1/workspaces/api-workspace/sources", headers=self.headers
        )
        self.assertEqual([item["source_id"] for item in sources.json()], ["api-source"])
        detail = self.request(
            "GET", "/api/v1/workspaces/api-workspace/sources/api-source", headers=self.headers
        )
        self.assertEqual(detail.json()["content"], "Aria keeps the brass key.")
        event = self.request(
            "POST",
            "/api/v1/workspaces/api-workspace/commands",
            headers=self.headers,
            json={
                "branch_id": "main",
                "expected_revision": 2,
                "idempotency_key": "record-api-event",
                "command_type": "create_journal_event",
                "reason": "Record a sourced personal memory",
                "payload": {
                    "event_id": "found-key",
                    "title": "Found the brass key",
                    "participants": ["Aria"],
                    "temporal_kind": "relative",
                    "time_note": "before sunrise",
                    "source_id": "api-source",
                    "source_quote": "Aria keeps the brass key.",
                },
            },
        )
        self.assertEqual(event.status_code, 200, event.text)
        timeline = self.request(
            "GET", "/api/v1/workspaces/api-workspace/journal-events?branch_id=main", headers=self.headers
        )
        self.assertEqual(timeline.status_code, 200, timeline.text)
        self.assertEqual(timeline.json()[0]["event_id"], "found-key")
        self.assertEqual(timeline.json()[0]["source_name"], "API source")
        dated_timeline = self.request(
            "GET",
            "/api/v1/workspaces/api-workspace/journal-events?branch_id=main&from_date=2024-01-01",
            headers=self.headers,
        )
        self.assertEqual(dated_timeline.status_code, 200, dated_timeline.text)
        self.assertEqual(dated_timeline.json(), [])
        claim = self.request(
            "POST",
            "/api/v1/workspaces/api-workspace/commands",
            headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 3, "idempotency_key": "record-known-city",
                "command_type": "add_claim", "reason": "Record a known property",
                "payload": {
                    "claim_id": "api-city", "subject_entity_id": "api-entity", "predicate": "current city",
                    "object_value": "Paris", "epistemic_status": "known", "review_status": "accepted",
                },
            },
        )
        self.assertEqual(claim.status_code, 200, claim.text)
        rule = self.request(
            "POST",
            "/api/v1/workspaces/api-workspace/commands",
            headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 4, "idempotency_key": "create-api-rule",
                "command_type": "create_rule", "reason": "Add a reviewed constraint",
                "payload": {
                    "rule_id": "api-require-paris", "name": "Known location",
                    "rule_mode": "require", "severity": "hard", "subject_entity_id": "api-entity",
                    "predicate": "current city", "object_value": "Paris", "predicate_cardinality": "single",
                },
            },
        )
        self.assertEqual(rule.status_code, 200, rule.text)
        pending_rule = self.request(
            "GET", "/api/v1/workspaces/api-workspace/rules/evaluations?branch_id=main", headers=self.headers,
        )
        self.assertEqual(pending_rule.json()[0]["evaluation"]["status"], "unknown")
        self.assertEqual(pending_rule.json()[0]["evaluation"]["reason_code"], "rule_not_accepted")
        reviewed = self.request(
            "POST",
            "/api/v1/workspaces/api-workspace/commands",
            headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 5, "idempotency_key": "accept-api-rule",
                "command_type": "review_rule", "reason": "Accept the reviewed constraint",
                "payload": {"rule_id": "api-require-paris", "review_status": "accepted"},
            },
        )
        self.assertEqual(reviewed.status_code, 200, reviewed.text)
        evaluations = self.request(
            "GET", "/api/v1/workspaces/api-workspace/rules/evaluations?branch_id=main", headers=self.headers,
        )
        self.assertEqual(evaluations.json()[0]["evaluation"]["status"], "satisfied")
        scenario = self.request(
            "POST", "/api/v1/workspaces/api-workspace/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 6, "idempotency_key": "create-api-scenario",
                "command_type": "create_scenario", "reason": "Compare two funding options",
                "payload": {
                    "scenario_id": "api-funding-choice", "title": "Funding choice",
                    "problem": "Decide whether to proceed.", "constraints": ["Keep the approved budget."],
                    "options": [{"option_id": "continue", "label": "Continue"},
                                {"option_id": "pause", "label": "Pause"}],
                    "evidence_claim_ids": ["api-city"], "evidence_source_ids": ["api-source"],
                },
            },
        )
        self.assertEqual(scenario.status_code, 200, scenario.text)
        assumption = self.request(
            "POST", "/api/v1/workspaces/api-workspace/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 7, "idempotency_key": "assume-london",
                "command_type": "set_scenario_assumption", "reason": "Test the alternative outcome",
                "payload": {
                    "scenario_id": "api-funding-choice", "option_id": "pause",
                    "assumption_id": "city-changes", "subject_entity_id": "api-entity",
                    "predicate": "current city", "object_value": "London",
                    "assumption_action": "replace", "predicate_cardinality": "single",
                },
            },
        )
        self.assertEqual(assumption.status_code, 200, assumption.text)
        scenarios = self.request(
            "GET", "/api/v1/workspaces/api-workspace/scenarios?branch_id=main", headers=self.headers,
        )
        self.assertEqual(scenarios.status_code, 200, scenarios.text)
        pause = next(option for option in scenarios.json()[0]["options"] if option["option_id"] == "pause")
        self.assertEqual(pause["rule_evaluations"][0]["evaluation"]["status"], "violated")
        self.assertTrue(pause["rule_evaluations"][0]["evaluation"]["conditional"])

    def create_story_conversation(self) -> int:
        workspace = self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "story-api", "name": "Story API"},
        )
        self.assertEqual(workspace.status_code, 201)
        created = self.request(
            "POST", "/api/v1/workspaces/story-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 0, "idempotency_key": "create-story-character",
                "command_type": "create_entity", "reason": "Create a story character",
                "payload": {"entity_id": "aria", "entity_type": "character", "label": "Aria"},
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        conversation = self.request(
            "POST", "/api/v1/workspaces/story-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 1, "idempotency_key": "create-story-conversation",
                "command_type": "create_conversation", "reason": "Start a story",
                "payload": {
                    "conversation_id": "story-1", "actor_entity_id": "aria", "title": "The Brass Key",
                    "actor_is_user_controlled": True,
                },
            },
        )
        self.assertEqual(conversation.status_code, 200, conversation.text)
        return conversation.json()["revision"]

    def test_world_adventure_and_d20_api_flow_is_revisioned_and_idempotent(self) -> None:
        created_workspace = self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "rpg-api", "name": "RPG API"},
        )
        self.assertEqual(created_workspace.status_code, 201)
        hero = self.request(
            "POST", "/api/v1/workspaces/rpg-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 0, "idempotency_key": "rpg-api-hero",
                "command_type": "create_entity", "reason": "Create the RPG protagonist",
                "payload": {"entity_id": "hero", "entity_type": "character", "label": "Mira"},
            },
        )
        self.assertEqual(hero.status_code, 200, hero.text)
        world = self.request(
            "POST", "/api/v1/workspaces/rpg-api/story/worlds", headers=self.headers,
            json={
                "expected_revision": 1, "idempotency_key": "rpg-api-world", "name": "Harbor",
                "description": "A coastal town.", "template_key": "fantasy",
                "content": {"public_lore": "Fog covers the sea.", "stats": {"might": 2},
                            "trackers": {"health": {"value": 8, "max": 10}}},
            },
        )
        self.assertEqual(world.status_code, 201, world.text)
        world_id = world.json()["world_id"]
        adventure = self.request(
            "POST", "/api/v1/workspaces/rpg-api/story/adventures", headers=self.headers,
            json={
                "expected_revision": 2, "idempotency_key": "rpg-api-start", "adventure_id": "adventure-api",
                "world_id": world_id, "world_version": 1, "conversation_id": "conversation-api",
                "name": "Into the Fog", "actor_entity_id": "hero",
            },
        )
        self.assertEqual(adventure.status_code, 201, adventure.text)
        branch_id = adventure.json()["branch_id"]
        self.assertEqual(branch_id, "adventure-api")
        state = self.request(
            "GET", f"/api/v1/workspaces/rpg-api/story/adventures/adventure-api/rpg?branch_id={branch_id}",
            headers=self.headers,
        )
        self.assertEqual(state.status_code, 200, state.text)
        self.assertEqual(state.json()["sheet"]["stats"], {"might": 2})

        check_body = {
            "branch_id": branch_id, "expected_revision": adventure.json()["revision"],
            "idempotency_key": "rpg-api-check", "stat_name": "might", "target": 1,
        }
        check = self.request(
            "POST", "/api/v1/workspaces/rpg-api/story/adventures/adventure-api/checks",
            headers=self.headers, json=check_body,
        )
        self.assertEqual(check.status_code, 200, check.text)
        recorded = check.json()
        self.assertEqual(recorded["total"], recorded["die_roll"] + 2)
        self.assertEqual(recorded["outcome"], "success")
        replay = self.request(
            "POST", "/api/v1/workspaces/rpg-api/story/adventures/adventure-api/checks",
            headers=self.headers, json=check_body,
        )
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertTrue(replay.json()["idempotent_replay"])
        self.assertEqual(replay.json()["die_roll"], recorded["die_roll"])

    def add_temporal_claim(
        self,
        revision: int,
        claim_id: str,
        object_value: str,
        *,
        narrative_order: int = 1,
        epistemic_status: str = "known",
        review_status: str = "accepted",
        visibility: str = "public",
    ) -> int:
        created = self.request(
            "POST", "/api/v1/workspaces/story-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": revision, "idempotency_key": f"claim-{claim_id}",
                "command_type": "add_claim", "reason": "Add a character memory claim",
                "payload": {
                    "claim_id": claim_id, "subject_entity_id": "aria", "predicate": "remembers",
                    "object_value": object_value, "epistemic_status": epistemic_status,
                    "review_status": review_status, "visibility": visibility, "narrative_order": narrative_order,
                },
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        return created.json()["revision"]

    def add_temporal_belief(self, revision: int, claim_id: str, *, stance: str = "knows", awareness_order: int = 1) -> int:
        created = self.request(
            "POST", "/api/v1/workspaces/story-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": revision, "idempotency_key": f"belief-{claim_id}",
                "command_type": "add_belief", "reason": "Record character awareness",
                "payload": {
                    "belief_id": f"belief-{claim_id}", "actor_entity_id": "aria", "claim_id": claim_id,
                    "stance": stance, "awareness_order": awareness_order,
                },
            },
        )
        self.assertEqual(created.status_code, 200, created.text)
        return created.json()["revision"]

    def query_temporal_memory(
        self, revision: int, *, order: int = 2, model: str | None = "test-model",
        provider: str = "ollama", external_provider_consent: str | None = None,
    ) -> httpx.Response:
        return self.request(
            "POST", "/api/v1/workspaces/story-api/temporal-query", headers=self.headers,
            json={
                "branch_id": "main", "actor_entity_id": "aria", "expected_revision": revision,
                "as_of_narrative_order": order, "model": model, "provider": provider,
                "external_provider_consent": external_provider_consent,
                "question": "What does Aria remember about the archive?",
            },
        )

    def test_temporal_query_uses_only_reviewed_actor_aware_facts_and_cites_them(self) -> None:
        revision = self.create_story_conversation()
        revision = self.add_temporal_claim(revision, "past", "the bronze key", narrative_order=1)
        revision = self.add_temporal_belief(revision, "past", awareness_order=1)
        revision = self.add_temporal_claim(
            revision, "uncertain", "the old bell rang before dawn", narrative_order=1,
            epistemic_status="unknown",
        )
        revision = self.add_temporal_belief(revision, "uncertain", stance="believes", awareness_order=1)
        revision = self.add_temporal_claim(revision, "future", "the hidden vault", narrative_order=4)
        revision = self.add_temporal_belief(revision, "future", awareness_order=4)
        revision = self.add_temporal_claim(revision, "unreviewed", "the silver map", review_status="proposed")
        revision = self.add_temporal_belief(revision, "unreviewed")
        revision = self.add_temporal_claim(revision, "unaware", "the eastern gate")
        self.ollama.structured_response = {
            "status": "answered", "answer": "She remembers the bronze key.", "claim_ids": ["past"],
        }

        response = self.query_temporal_memory(revision)
        current = self.request(
            "GET", "/api/v1/workspaces/story-api/revision?branch_id=main", headers=self.headers,
        )

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["status"], "answered")
        self.assertEqual(body["answer"], "She remembers the bronze key.")
        self.assertEqual([item["claim_id"] for item in body["citations"]], ["past"])
        self.assertEqual(body["citations"][0]["epistemic_status"], "known")
        self.assertEqual(body["context_manifest"]["base_revision"], revision)
        self.assertEqual(
            {item["claim_id"]: item["epistemic_status"] for item in body["context_manifest"]["included"]},
            {"past": "known", "uncertain": "unknown"},
        )
        self.assertEqual(
            {item["claim_id"]: item["reason"] for item in body["context_manifest"]["excluded"]},
            {"future": "future_fact", "unreviewed": "not_reviewed", "unaware": "actor_unaware"},
        )
        provider_request = self.ollama.structured_calls[0][1][1]["content"]
        self.assertIn("the bronze key", provider_request)
        self.assertIn("the old bell rang before dawn", provider_request)
        self.assertIn('"epistemic_status":"unknown"', provider_request)
        self.assertIn("`unknown` means the proposition itself is unresolved", self.ollama.structured_calls[0][1][0]["content"])
        self.assertNotIn("the hidden vault", provider_request)
        self.assertNotIn("the silver map", provider_request)
        self.assertNotIn("the eastern gate", provider_request)
        self.assertEqual(current.json()["revision"], revision)

    def test_temporal_query_without_eligible_memory_does_not_call_provider_or_write(self) -> None:
        revision = self.create_story_conversation()

        response = self.query_temporal_memory(revision, model=None)
        current = self.request(
            "GET", "/api/v1/workspaces/story-api/revision?branch_id=main", headers=self.headers,
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "insufficient")
        self.assertEqual(response.json()["citations"], [])
        self.assertEqual(self.ollama.structured_calls, [])
        self.assertEqual(current.json()["revision"], revision)

    def test_temporal_query_requires_a_model_only_when_eligible_memory_exists(self) -> None:
        revision = self.create_story_conversation()
        revision = self.add_temporal_claim(revision, "past", "the bronze key")
        revision = self.add_temporal_belief(revision, "past")

        response = self.query_temporal_memory(revision, model=None)

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.ollama.structured_calls, [])

    def test_temporal_query_rejects_stale_revision_before_provider_call(self) -> None:
        revision = self.create_story_conversation()

        response = self.query_temporal_memory(revision - 1)

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.ollama.structured_calls, [])

    def test_temporal_query_discards_result_if_branch_changes_during_provider_call(self) -> None:
        revision = self.create_story_conversation()
        revision = self.add_temporal_claim(revision, "past", "the bronze key")
        revision = self.add_temporal_belief(revision, "past")
        self.ollama.structured_response = {
            "status": "answered", "answer": "She remembers the bronze key.", "claim_ids": ["past"],
        }

        def advance_branch() -> None:
            self.app.state.gateway.execute(
                workspace_id="story-api", branch_id="main", idempotency_key="concurrent-claim",
                expected_revision=revision, command_type="add_claim",
                payload={
                    "claim_id": "concurrent", "subject_entity_id": "aria", "predicate": "learns",
                    "object_value": "the clock is broken", "epistemic_status": "known",
                    "review_status": "accepted", "narrative_order": 2,
                },
                actor="user", reason="Simulate a concurrent branch change",
            )

        self.ollama.structured_callback = advance_branch
        response = self.query_temporal_memory(revision)

        self.assertEqual(response.status_code, 409, response.text)

    def test_temporal_query_rejects_provider_citations_outside_manifest(self) -> None:
        revision = self.create_story_conversation()
        revision = self.add_temporal_claim(revision, "past", "the bronze key")
        revision = self.add_temporal_belief(revision, "past")
        self.ollama.structured_response = {
            "status": "answered", "answer": "She remembers a hidden vault.", "claim_ids": ["future"],
        }

        response = self.query_temporal_memory(revision)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "insufficient")
        self.assertEqual(response.json()["citations"], [])
        self.assertNotIn("hidden vault", response.json()["answer"])

    def test_temporal_query_requires_authentication(self) -> None:
        response = self.request(
            "POST", "/api/v1/workspaces/story-api/temporal-query",
            json={
                "branch_id": "main", "actor_entity_id": "aria", "expected_revision": 0,
                "as_of_narrative_order": 0, "model": "test-model", "question": "What does Aria know?",
            },
        )

        self.assertEqual(response.status_code, 401)

    def test_temporal_query_provider_failure_leaves_revision_unchanged(self) -> None:
        revision = self.create_story_conversation()
        revision = self.add_temporal_claim(revision, "past", "the bronze key")
        revision = self.add_temporal_belief(revision, "past")
        self.ollama.failure = True

        response = self.query_temporal_memory(revision)
        current = self.request(
            "GET", "/api/v1/workspaces/story-api/revision?branch_id=main", headers=self.headers,
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(current.json()["revision"], revision)

    def test_external_temporal_query_requires_consent_and_sends_only_public_facts(self) -> None:
        revision = self.create_story_conversation()
        revision = self.add_temporal_claim(revision, "public-memory", "the public bronze key")
        revision = self.add_temporal_belief(revision, "public-memory")
        revision = self.add_temporal_claim(
            revision, "private-memory", "Aria's private escape route", visibility="actor_scoped",
        )
        revision = self.add_temporal_belief(revision, "private-memory")
        with patch(
            "lke.ai.providers.StoryProviderRegistry.generate_json",
            return_value={"status": "answered", "answer": "The bronze key.", "claim_ids": ["public-memory"]},
        ) as generate:
            denied = self.query_temporal_memory(revision, provider="openai")
            allowed = self.query_temporal_memory(
                revision, provider="openai", external_provider_consent="openai",
            )

        self.assertEqual(denied.status_code, 422, denied.text)
        self.assertEqual(allowed.status_code, 200, allowed.text)
        generate.assert_called_once()
        messages = generate.call_args.args[2]
        encoded_request = "\n".join(message["content"] for message in messages)
        self.assertIn("the public bronze key", encoded_request)
        self.assertNotIn("Aria's private escape route", encoded_request)
        self.assertEqual([item["claim_id"] for item in allowed.json()["citations"]], ["public-memory"])

    def test_story_turn_uses_actor_context_and_is_idempotent(self) -> None:
        revision = self.create_story_conversation()
        body = {
            "branch_id": "main", "conversation_id": "story-1", "expected_revision": revision,
            "idempotency_key": "story-turn-1", "model": "test-model", "prompt": "Continue the scene.",
            "narrative_order": 0,
        }
        response = self.request(
            "POST", "/api/v1/workspaces/story-api/story/generate", headers=self.headers, json=body,
        )
        replay = self.request(
            "POST", "/api/v1/workspaces/story-api/story/generate", headers=self.headers, json=body,
        )
        conversation = self.request(
            "GET", "/api/v1/workspaces/story-api/conversations/story-1?branch_id=main", headers=self.headers,
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertFalse(response.json()["idempotent_replay"])
        self.assertTrue(replay.json()["idempotent_replay"])
        self.assertEqual(len(self.ollama.calls), 1)
        self.assertIn("controlled by the user", self.ollama.calls[0][1][0]["content"])
        self.assertEqual([turn["role"] for turn in conversation.json()["turns"]], ["user", "assistant"])
        self.assertEqual(conversation.json()["turns"][1]["provider"], "ollama")
        self.assertEqual(conversation.json()["turns"][1]["content"], "Aria waits for the user's next choice.")
        self.assertEqual(self.request(
            "GET", "/api/v1/workspaces/story-api/revision?branch_id=main", headers=self.headers,
        ).json()["revision"], revision + 1)

    def test_codex_reasoning_effort_is_forwarded_for_generation_and_retry(self) -> None:
        revision = self.create_story_conversation()
        generation_body = {
            "branch_id": "main", "conversation_id": "story-1", "expected_revision": revision,
            "idempotency_key": "codex-effort-turn", "provider": "codex", "external_provider_consent": "codex",
            "model": "model-a", "reasoning_effort": "high", "prompt": "Continue the scene.",
            "narrative_order": 0,
        }
        with patch("lke.ai.providers.StoryProviderRegistry.generate", return_value="The door opens.") as generate:
            response = self.request(
                "POST", "/api/v1/workspaces/story-api/story/generate", headers=self.headers, json=generation_body,
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(generate.call_args.kwargs["reasoning_effort"], "high")

        assistant_turn = response.json()["conversation"]["turns"][1]
        retry_body = {
            "branch_id": "main", "conversation_id": "story-1", "turn_id": assistant_turn["turn_id"],
            "expected_revision": response.json()["revision"], "idempotency_key": "codex-effort-retry",
            "provider": "codex", "external_provider_consent": "codex", "model": "model-a",
            "reasoning_effort": "low",
        }
        with patch("lke.ai.providers.StoryProviderRegistry.generate", return_value="The door opens wider.") as retry:
            retried = self.request(
                "POST", "/api/v1/workspaces/story-api/story/retry", headers=self.headers, json=retry_body,
            )
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertEqual(retry.call_args.kwargs["reasoning_effort"], "low")

    def test_reasoning_effort_is_rejected_for_non_codex_providers(self) -> None:
        revision = self.create_story_conversation()
        response = self.request(
            "POST", "/api/v1/workspaces/story-api/story/generate", headers=self.headers,
            json={
                "branch_id": "main", "conversation_id": "story-1", "expected_revision": revision,
                "idempotency_key": "invalid-effort-provider", "provider": "ollama", "model": "test-model",
                "reasoning_effort": "high", "prompt": "Continue the scene.", "narrative_order": 0,
            },
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("only for Codex", response.json()["detail"])

    def test_world_architect_deduplicates_repeated_locations_and_keeps_starting_place(self) -> None:
        created = self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "world-draft-api", "name": "World draft"},
        )
        self.assertEqual(created.status_code, 201, created.text)
        model_draft = {
            "public_lore": "A silver harbor below a quiet moon.",
            "starting_location": "MOON   HARBOR",
            "locations": ["Moon Harbor", " moon   harbor ", "The Glass Orchard"],
            "opening_scene": {"situation": "Ships wait beneath the moon.", "hook": "One lantern is moving."},
        }
        with patch("lke.ai.providers.StoryProviderRegistry.generate_json", return_value=model_draft):
            response = self.request(
                "POST", "/api/v1/workspaces/world-draft-api/story/worlds/draft", headers=self.headers,
                json={"name": "Moon Harbor", "template_key": "fantasy", "brief": "A moonlit port.", "model": "test-model"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["draft"]["locations"], ["Moon Harbor", "The Glass Orchard"])
        self.assertEqual(response.json()["draft"]["starting_location"], "Moon Harbor")
        self.assertFalse(response.json()["saved"])
        self.assertEqual(self.request(
            "GET", "/api/v1/workspaces/world-draft-api/story/worlds", headers=self.headers,
        ).json(), [])

    def test_aborting_story_request_cancels_provider_work_before_any_commit(self) -> None:
        revision = self.create_story_conversation()
        provider_started = threading.Event()
        provider_stopped = threading.Event()

        def wait_for_cancel(model, messages, cancel_event):
            provider_started.set()
            if cancel_event is None or not cancel_event.wait(5):
                raise AssertionError("The API did not signal provider cancellation")
            provider_stopped.set()
            raise OllamaError("Generation was stopped")

        self.ollama.generation_callback = wait_for_cancel
        body = {
            "branch_id": "main", "conversation_id": "story-1", "expected_revision": revision,
            "idempotency_key": "cancel-story-turn", "model": "test-model", "prompt": "Continue the scene.",
            "narrative_order": 0,
        }

        async def abort_request() -> None:
            transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 8000))
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                request_task = asyncio.create_task(client.post(
                    "/api/v1/workspaces/story-api/story/generate", headers=self.headers, json=body,
                ))
                if not await asyncio.to_thread(provider_started.wait, 2):
                    self.fail("Provider generation did not start")
                request_task.cancel()
                try:
                    await request_task
                except asyncio.CancelledError:
                    pass
                self.assertTrue(await asyncio.to_thread(provider_stopped.wait, 3))

        asyncio.run(abort_request())
        gateway = self.app.state.gateway
        self.assertEqual(gateway.current_revision("story-api", "main"), revision)
        self.assertEqual(gateway.get_conversation("story-api", "main", "story-1")["turns"], [])

    def test_external_story_generation_requires_matching_consent_and_excludes_private_facts(self) -> None:
        revision = self.create_story_conversation()
        revision = self.add_temporal_claim(revision, "public-fact", "the public bronze seal")
        revision = self.add_temporal_belief(revision, "public-fact")
        revision = self.add_temporal_claim(
            revision, "actor-fact", "Aria's private route", visibility="actor_scoped",
        )
        revision = self.add_temporal_belief(revision, "actor-fact")
        body = {
            "branch_id": "main", "conversation_id": "story-1", "expected_revision": revision,
            "idempotency_key": "external-consent-turn", "provider": "openai", "model": "gpt-test",
            "prompt": "Continue the scene.", "narrative_order": 2,
        }
        with patch("lke.ai.providers.StoryProviderRegistry.generate", return_value="The seal glints.") as generate:
            denied = self.request(
                "POST", "/api/v1/workspaces/story-api/story/generate", headers=self.headers, json=body,
            )
            wrong_provider = self.request(
                "POST", "/api/v1/workspaces/story-api/story/generate", headers=self.headers,
                json={**body, "external_provider_consent": "claude"},
            )
            allowed = self.request(
                "POST", "/api/v1/workspaces/story-api/story/generate", headers=self.headers,
                json={**body, "external_provider_consent": "openai"},
            )

        self.assertEqual(denied.status_code, 422, denied.text)
        self.assertEqual(wrong_provider.status_code, 422, wrong_provider.text)
        self.assertEqual(allowed.status_code, 200, allowed.text)
        generate.assert_called_once()
        messages = generate.call_args.args[2]
        encoded_request = "\n".join(message["content"] for message in messages)
        self.assertIn("the public bronze seal", encoded_request)
        self.assertNotIn("Aria's private route", encoded_request)
        self.assertIn("external_provider_private_scope", str(allowed.json()["conversation"]["turns"][1]["context_manifest"]["excluded"]))

    def test_external_context_removes_author_private_and_unshared_story_notes(self) -> None:
        context = {
            "included": [{"claim_id": "public", "visibility": "public"},
                         {"claim_id": "private", "visibility": "actor_scoped"}],
            "excluded": [],
            "story": {
                "author_notes": [{"content": "hidden author clue"}],
                "hero_profile": {"secret": "private character note"},
                "world_reference": {"content": "hidden lorebook entry"},
                "open_threads": [{"detail": "unclassified private thread"}],
                "excluded_memories": [{"content": "private memory"}],
                "memories": [
                    {"knowledge_scope": "shared", "review_status": "accepted", "content": "shared clue"},
                    {"knowledge_scope": "actors", "review_status": "accepted", "content": "actor-only clue"},
                    {"knowledge_scope": "shared", "review_status": "proposed", "content": "unreviewed clue"},
                ],
            },
        }
        remote = _external_provider_context(context)
        encoded = json.dumps(remote, ensure_ascii=False)
        self.assertEqual([item["claim_id"] for item in remote["included"]], ["public"])
        self.assertIn("shared clue", encoded)
        self.assertNotIn("hidden author clue", encoded)
        self.assertNotIn("private character note", encoded)
        self.assertNotIn("hidden lorebook entry", encoded)
        self.assertNotIn("unclassified private thread", encoded)
        self.assertNotIn("actor-only clue", encoded)
        self.assertNotIn("unreviewed clue", encoded)

    def test_provider_failure_does_not_record_a_partial_turn(self) -> None:
        self.ollama.failure = True
        revision = self.create_story_conversation()
        response = self.request(
            "POST", "/api/v1/workspaces/story-api/story/generate", headers=self.headers,
            json={
                "branch_id": "main", "conversation_id": "story-1", "expected_revision": revision,
                "idempotency_key": "failed-turn", "model": "test-model", "prompt": "Continue.",
                "narrative_order": 0,
            },
        )
        conversation = self.request(
            "GET", "/api/v1/workspaces/story-api/conversations/story-1?branch_id=main", headers=self.headers,
        )
        current = self.request(
            "GET", "/api/v1/workspaces/story-api/revision?branch_id=main", headers=self.headers,
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(conversation.json()["turns"], [])
        self.assertEqual(current.json()["revision"], revision)

    def test_local_model_discovery_reports_availability(self) -> None:
        response = self.request("GET", "/api/v1/providers/ollama/models", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"available": True, "models": ["test-model"]})

    def test_extraction_is_idempotent_and_requires_review_for_canonical_writes(self) -> None:
        workspace = self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "extraction-api", "name": "Extraction API"},
        )
        self.assertEqual(workspace.status_code, 201)
        source = self.request(
            "POST", "/api/v1/workspaces/extraction-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 0, "idempotency_key": "import-extraction-source",
                "command_type": "import_source", "reason": "Add a local source",
                "payload": {
                    "source_id": "archive-notes", "display_name": "Archive notes",
                    "media_type": "text/plain", "content": "Aria guards the archive.",
                },
            },
        )
        self.assertEqual(source.status_code, 200, source.text)
        body = {
            "branch_id": "main", "expected_revision": 1, "idempotency_key": "extract-archive-notes",
            "model": "test-model",
        }
        extracted = self.request(
            "POST", "/api/v1/workspaces/extraction-api/sources/archive-notes/extract",
            headers=self.headers, json=body,
        )
        replay = self.request(
            "POST", "/api/v1/workspaces/extraction-api/sources/archive-notes/extract",
            headers=self.headers, json=body,
        )
        self.assertEqual(extracted.status_code, 200, extracted.text)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertFalse(extracted.json()["idempotent_replay"])
        self.assertTrue(replay.json()["idempotent_replay"])
        self.assertEqual(len(self.ollama.structured_calls), 1)
        self.assertEqual(self.ollama.structured_calls[0][0], "test-model")
        batch = extracted.json()["batch"]
        entity_candidate = next(item for item in batch["candidates"] if item["kind"] == "entity")
        claim_candidate = next(item for item in batch["candidates"] if item["kind"] == "claim")
        self.assertEqual(entity_candidate["payload"]["quote"], "Aria")
        self.assertEqual(claim_candidate["payload"]["quote"], "Aria guards the archive.")
        self.assertEqual(self.request(
            "GET", "/api/v1/workspaces/extraction-api/entities?branch_id=main", headers=self.headers,
        ).json(), [])
        self.assertEqual(self.request(
            "GET", "/api/v1/workspaces/extraction-api/claims?branch_id=main", headers=self.headers,
        ).json(), [])

        accepted_entity = self.request(
            "POST", "/api/v1/workspaces/extraction-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": extracted.json()["revision"],
                "idempotency_key": "accept-extracted-entity", "command_type": "review_extraction_candidate",
                "reason": "Review the extracted person",
                "payload": {"candidate_id": entity_candidate["candidate_id"], "review_status": "accepted"},
            },
        )
        self.assertEqual(accepted_entity.status_code, 200, accepted_entity.text)
        accepted_claim = self.request(
            "POST", "/api/v1/workspaces/extraction-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": accepted_entity.json()["revision"],
                "idempotency_key": "accept-extracted-claim", "command_type": "review_extraction_candidate",
                "reason": "Review the source-grounded claim",
                "payload": {
                    "candidate_id": claim_candidate["candidate_id"], "review_status": "accepted",
                    "subject_entity_id": accepted_entity.json()["canonical_record_id"],
                    "epistemic_status": "unknown", "visibility": "public",
                },
            },
        )
        self.assertEqual(accepted_claim.status_code, 200, accepted_claim.text)
        claims = self.request(
            "GET", "/api/v1/workspaces/extraction-api/claims?branch_id=main", headers=self.headers,
        ).json()
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0]["review_status"], "accepted")
        self.assertEqual(claims[0]["epistemic_status"], "unknown")
        self.assertEqual(len(claims[0]["evidence"]), 1)

    def test_failed_extraction_provider_does_not_advance_revision(self) -> None:
        self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "failed-extraction-api", "name": "Failed Extraction"},
        )
        source = self.request(
            "POST", "/api/v1/workspaces/failed-extraction-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 0, "idempotency_key": "import-before-failure",
                "command_type": "import_source", "reason": "Add a local source",
                "payload": {
                    "source_id": "failed-source", "display_name": "Notes",
                    "media_type": "text/plain", "content": "Aria guards the archive.",
                },
            },
        )
        self.assertEqual(source.status_code, 200, source.text)
        self.ollama.failure = True
        response = self.request(
            "POST", "/api/v1/workspaces/failed-extraction-api/sources/failed-source/extract",
            headers=self.headers,
            json={"branch_id": "main", "expected_revision": 1, "idempotency_key": "failed-extract", "model": "test-model"},
        )
        revision = self.request(
            "GET", "/api/v1/workspaces/failed-extraction-api/revision?branch_id=main", headers=self.headers,
        )
        extractions = self.request(
            "GET", "/api/v1/workspaces/failed-extraction-api/extractions?branch_id=main", headers=self.headers,
        )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(revision.json()["revision"], 1)
        self.assertEqual(extractions.json(), [])

    def test_backup_download_and_restore_replace_the_live_database(self) -> None:
        created = self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "before-backup", "name": "Before backup"},
        )
        self.assertEqual(created.status_code, 201)
        backup = self.request("GET", "/api/v1/backup", headers=self.headers)
        self.assertEqual(backup.status_code, 200, backup.text)
        self.assertEqual(backup.headers["content-type"], "application/zip")
        self.assertTrue(backup.headers["content-disposition"].endswith(".lkebackup\""))

        changed = self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "after-backup", "name": "After backup"},
        )
        self.assertEqual(changed.status_code, 201)
        restored = self.request(
            "POST", "/api/v1/backup/restore", headers={**self.headers, "Content-Type": "application/octet-stream"},
            content=backup.content,
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertTrue(restored.json()["restored"])
        self.assertEqual([item["workspace_id"] for item in restored.json()["workspaces"]], ["before-backup"])
        listed = self.request("GET", "/api/v1/workspaces", headers=self.headers)
        self.assertEqual([item["workspace_id"] for item in listed.json()], ["before-backup"])

    def test_search_projection_rebuild_requires_auth_and_does_not_advance_revision(self) -> None:
        created = self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "projection-api", "name": "Projection API"},
        )
        self.assertEqual(created.status_code, 201)
        entity = self.request(
            "POST", "/api/v1/workspaces/projection-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 0, "idempotency_key": "projection-entity",
                "command_type": "create_entity", "reason": "Create projection fixture",
                "payload": {"entity_id": "aria", "entity_type": "person", "label": "Aria", "properties": {}},
            },
        )
        self.assertEqual(entity.status_code, 200)
        source = self.request(
            "POST", "/api/v1/workspaces/projection-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 1, "idempotency_key": "projection-source",
                "command_type": "import_source", "reason": "Import projection fixture",
                "payload": {"source_id": "ledger", "display_name": "Ledger", "content": "Aria holds the brass key.", "media_type": "text/plain"},
            },
        )
        self.assertEqual(source.status_code, 200)
        self.database.connection.execute("DELETE FROM entity_search")
        self.database.connection.execute("DELETE FROM source_search")

        denied = self.request("POST", "/api/v1/projections/search/rebuild")
        rebuilt = self.request("POST", "/api/v1/projections/search/rebuild", headers=self.headers)
        revision = self.request("GET", "/api/v1/workspaces/projection-api/revision", headers=self.headers)
        search = self.request("GET", "/api/v1/workspaces/projection-api/sources?q=brass", headers=self.headers)

        self.assertEqual(denied.status_code, 401)
        self.assertEqual(rebuilt.status_code, 200, rebuilt.text)
        self.assertEqual(rebuilt.json(), {"entities": 1, "sources": 1})
        self.assertEqual(revision.json()["revision"], 2)
        self.assertEqual([row["source_id"] for row in search.json()], ["ledger"])

    def test_invalid_backup_does_not_replace_live_database(self) -> None:
        created = self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "preserved", "name": "Preserved data"},
        )
        self.assertEqual(created.status_code, 201)
        response = self.request(
            "POST", "/api/v1/backup/restore", headers={**self.headers, "Content-Type": "application/zip"},
            content=b"not a zip archive",
        )
        listed = self.request("GET", "/api/v1/workspaces", headers=self.headers)
        self.assertEqual(response.status_code, 422)
        self.assertEqual([item["workspace_id"] for item in listed.json()], ["preserved"])

    def test_external_exchange_import_and_listing_are_authenticated(self) -> None:
        created = self.request(
            "POST", "/api/v1/workspaces", headers=self.headers,
            json={"workspace_id": "exchange-api", "name": "Exchange API"},
        )
        self.assertEqual(created.status_code, 201, created.text)
        turns = [{
            "turn_number": 1,
            "messages": [
                {"role": "user", "content": "Continue the scene."},
                {"role": "assistant", "content": "The archive door opens."},
            ],
        }]
        canonical_turns = json.dumps(turns, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        transcript_hash = "sha256:" + hashlib.sha256(canonical_turns.encode("utf-8")).hexdigest()
        envelope = {
            "protocol": "lke.exchange.v1",
            "transcript_id": "external-conversation-api",
            "workspace_id": "exchange-api",
            "branch_id": "main",
            "base_revision": 0,
            "exchange_id": "external-api-1",
            "context_manifest_id": "context-api-0",
            "context_manifest": {
                "protocol": "lke.context.v1",
                "manifest_id": "context-api-0",
                "workspace_id": "exchange-api",
                "branch_id": "main",
                "base_revision": 0,
                "actor": {"entity_id": None, "label": "Narrator", "entity_type": "narrator"},
                "included": [],
                "excluded": [],
            },
            "transcript_range": {"from_turn": 1, "to_turn": 1},
            "transcript_total_turns": 1,
            "transcript_hash": transcript_hash,
            "turns": turns,
            "proposed_change_ids": ["proposal-1"],
        }
        imported = self.request(
            "POST", "/api/v1/workspaces/exchange-api/commands", headers=self.headers,
            json={
                "branch_id": "main", "expected_revision": 0, "idempotency_key": "import-exchange-api",
                "command_type": "import_exchange", "reason": "Import an external transcript",
                "payload": envelope,
            },
        )
        self.assertEqual(imported.status_code, 200, imported.text)
        self.assertEqual(imported.json()["exchange_id"], "external-api-1")

        listed = self.request(
            "GET", "/api/v1/workspaces/exchange-api/exchanges?branch_id=main", headers=self.headers,
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json()[0]["turns"], turns)
        self.assertFalse(listed.json()[0]["stale_context"])
        conversations = self.request(
            "GET", "/api/v1/workspaces/exchange-api/conversations?branch_id=main", headers=self.headers,
        )
        self.assertEqual(conversations.status_code, 200, conversations.text)
        self.assertEqual(conversations.json(), [])


if __name__ == "__main__":
    unittest.main()
