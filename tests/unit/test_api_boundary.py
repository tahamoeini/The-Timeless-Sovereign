"""Authenticated local API behavior using an in-memory database."""

from __future__ import annotations

import asyncio
import hashlib
import json
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
        self.structured_calls: list[tuple[str, list[dict[str, str]]]] = []
        self.structured_response = {
            "entities": [{"label": "Aria", "entity_type": "person", "quote": "Aria"}],
            "claims": [{
                "subject_label": "Aria", "predicate": "guards", "object_value": "the archive",
                "quote": "Aria guards the archive.",
            }],
        }

    def list_models(self) -> list[str]:
        return ["test-model"]

    def generate(self, model: str, messages: list[dict[str, str]]) -> str:
        self.calls.append((model, messages))
        if self.failure:
            raise OllamaError("Ollama is not responding on this device.")
        return "Aria waits for the user's next choice."

    def generate_json(self, model: str, messages: list[dict[str, str]]) -> dict[str, object]:
        self.structured_calls.append((model, messages))
        if self.failure:
            raise OllamaError("Ollama is not responding on this device.")
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
        self.assertEqual(imported.json()["result"]["exchange_id"], "external-api-1")

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
