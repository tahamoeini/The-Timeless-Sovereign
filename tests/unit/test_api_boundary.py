"""Authenticated local API behavior using an in-memory database."""

from __future__ import annotations

import asyncio
import os
import unittest
from unittest.mock import patch

import httpx

from lke.ai import OllamaError
from lke.api.app import create_app
from lke.core import Database


class FakeOllama:
    def __init__(self, failure: bool = False) -> None:
        self.failure = failure
        self.calls: list[tuple[str, list[dict[str, str]]]] = []

    def list_models(self) -> list[str]:
        return ["test-model"]

    def generate(self, model: str, messages: list[dict[str, str]]) -> str:
        self.calls.append((model, messages))
        if self.failure:
            raise OllamaError("Ollama is not responding on this device.")
        return "Aria waits for the user's next choice."


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

    def test_health_is_public_but_data_requires_authentication(self) -> None:
        self.assertEqual(self.request("GET", "/api/v1/health").status_code, 200)
        self.assertEqual(self.request("GET", "/api/v1/workspaces").status_code, 401)

    def test_unknown_origin_is_rejected(self) -> None:
        response = self.request(
            "GET",
            "/api/v1/workspaces",
            headers={**self.headers, "Origin": "https://untrusted.example"},
        )
        self.assertEqual(response.status_code, 403)

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


if __name__ == "__main__":
    unittest.main()
