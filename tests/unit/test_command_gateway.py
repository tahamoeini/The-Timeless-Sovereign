"""Integrity tests for the canonical store and command boundary."""

import sqlite3
import unittest

from backend.lke.core import (
    CommandGateway,
    ConflictError,
    Database,
    IdempotencyConflictError,
    NotFoundError,
    ValidationError,
)
from backend.lke.retrieval import ContextCompiler


class CommandGatewayTests(unittest.TestCase):
    def setUp(self):
        self.db = Database(":memory:")
        self.gateway = CommandGateway(self.db)
        self.gateway.create_workspace("Story workspace", "story")

    def tearDown(self):
        self.db.close()

    def command(self, key, revision, kind, payload, *, branch="main", actor="user"):
        return self.gateway.execute(
            workspace_id="story",
            branch_id=branch,
            idempotency_key=key,
            expected_revision=revision,
            command_type=kind,
            payload=payload,
            actor=actor,
            reason="unit test",
        )

    def create_entity(self, key, revision=0, branch="main", entity_id="aria", label="Aria"):
        return self.command(
            key,
            revision,
            "create_entity",
            {"entity_id": entity_id, "entity_type": "character", "label": label, "properties": {"role": "protagonist"}},
            branch=branch,
        )

    def test_write_commits_revision_audit_and_projection_outbox_atomically(self):
        result = self.create_entity("create-aria")

        self.assertEqual(result["revision"], 1)
        self.assertEqual(self.gateway.current_revision("story"), 1)
        self.assertEqual(len(self.gateway.revisions("story")), 2)
        counts = self.db.connection.execute(
            "SELECT (SELECT COUNT(*) FROM audit_events WHERE revision=1) AS audit, "
            "(SELECT COUNT(*) FROM projection_outbox WHERE revision=1) AS outbox"
        ).fetchone()
        self.assertEqual((counts["audit"], counts["outbox"]), (1, 1))

    def test_same_idempotency_key_returns_original_result_without_duplicate_write(self):
        first = self.create_entity("create-aria")
        second = self.create_entity("create-aria")

        self.assertEqual(first, second)
        self.assertEqual(self.gateway.current_revision("story"), 1)
        self.assertEqual(len(self.gateway.list_entities("story")), 1)

    def test_reusing_key_for_different_command_is_rejected(self):
        self.create_entity("key-1")

        with self.assertRaises(IdempotencyConflictError):
            self.create_entity("key-1", revision=1, entity_id="kael", label="Kael")

        self.assertEqual([item["entity_id"] for item in self.gateway.list_entities("story")], ["aria"])

    def test_stale_revision_is_rejected_without_partial_mutation(self):
        self.create_entity("first")

        with self.assertRaises(ConflictError):
            self.create_entity("stale", revision=0, entity_id="kael", label="Kael")

        self.assertEqual(self.gateway.current_revision("story"), 1)
        self.assertEqual(len(self.gateway.list_entities("story")), 1)

    def test_branch_is_a_snapshot_and_mutations_stay_isolated(self):
        self.create_entity("create-aria")
        self.gateway.create_branch("story", "main", "what-if", 1, "branch-1")
        self.command("rename-aria", 1, "update_entity", {"entity_id": "aria", "label": "Aria in the branch"}, branch="what-if")
        self.create_entity("create-kael", revision=2, branch="what-if", entity_id="kael", label="Kael")

        main = self.gateway.list_entities("story", "main")
        branch = self.gateway.list_entities("story", "what-if")
        self.assertEqual([(row["entity_id"], row["label"]) for row in main], [("aria", "Aria")])
        self.assertEqual([(row["entity_id"], row["label"]) for row in branch], [("aria", "Aria in the branch"), ("kael", "Kael")])
        self.assertEqual(self.gateway.current_revision("story", "main"), 1)
        self.assertEqual(self.gateway.current_revision("story", "what-if"), 3)

    def test_foreign_workspace_data_is_not_visible(self):
        self.gateway.create_workspace("Private workspace", "private")
        self.create_entity("create-aria")

        self.assertEqual(self.gateway.list_entities("private"), [])
        with self.assertRaises(ConflictError):
            self.gateway.execute(
                workspace_id="private", branch_id="main", idempotency_key="bad-edge", expected_revision=0,
                command_type="add_relation", payload={"source_entity_id": "aria", "target_entity_id": "missing", "relation_type": "knows"},
                reason="test workspace boundary",
            )
        self.assertEqual(self.gateway.current_revision("private"), 0)

    def test_source_import_is_deduplicated_and_searchable(self):
        first = self.command("source-1", 0, "import_source", {
            "display_name": "chapter.txt", "media_type": "text/plain", "content": "Aria received the sealed letter from Kael."})
        duplicate = self.command("source-2", 1, "import_source", {
            "display_name": "renamed-copy.txt", "media_type": "text/plain", "content": "Aria received the sealed letter from Kael."})

        self.assertFalse(first["duplicate"])
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(first["source_id"], duplicate["source_id"])
        self.assertEqual(duplicate["revision"], 1)
        self.assertEqual(len(self.gateway.search_sources("story", "sealed letter")), 1)

    def test_source_content_is_readable_only_inside_its_workspace(self):
        self.gateway.create_workspace("Private workspace", "private")
        imported = self.command("source-1", 0, "import_source", {
            "display_name": "journal-note.txt", "media_type": "text/plain", "content": "I found the old lighthouse at dawn."})

        detail = self.gateway.get_source("story", imported["source_id"])

        self.assertEqual(detail["content"], "I found the old lighthouse at dawn.")
        with self.assertRaises(NotFoundError):
            self.gateway.get_source("private", imported["source_id"])

    def test_journal_events_keep_conflicts_sources_and_correction_history_in_branches(self):
        source = self.command("journal-source", 0, "import_source", {
            "display_name": "travel note.txt", "media_type": "text/plain",
            "content": "Mina and I reached the coast on a cold morning.",
        })
        first = self.command("journal-event-1", 1, "create_journal_event", {
            "event_id": "coast-arrival", "title": "Reached the coast", "details": "We arrived before sunrise.",
            "participants": ["Mina", "mina"], "temporal_kind": "exact", "occurred_from": "2024-03-05",
            "source_id": source["source_id"], "source_quote": "Mina and I reached the coast on a cold morning.",
        })
        self.command("journal-event-conflict", 2, "create_journal_event", {
            "event_id": "coast-arrival-later-report", "title": "Another account dates the arrival later",
            "temporal_kind": "range", "occurred_from": "2024-03-07", "occurred_to": "2024-03-08",
            "time_note": "A separate note gives a different date.",
        })

        self.assertEqual(first["version"], 1)
        main_events = self.gateway.list_journal_events("story")
        self.assertEqual(len(main_events), 2)
        self.assertEqual(main_events[0]["event_id"], "coast-arrival")
        self.assertEqual(main_events[0]["participants"], ["Mina"])
        self.assertEqual(main_events[0]["source_quote"], "Mina and I reached the coast on a cold morning.")
        self.assertEqual(main_events[0]["source_name"], "travel note.txt")

        self.gateway.create_branch("story", "main", "journal-test", 3, "journal-branch")
        revised = self.command("journal-event-correction", 3, "revise_journal_event", {
            "event_id": "coast-arrival", "expected_event_version": 1, "title": "Reached the coast",
            "details": "I checked the dated letter and corrected this account.", "participants": ["Mina"],
            "temporal_kind": "exact", "occurred_from": "2024-03-06",
            "source_id": source["source_id"], "source_quote": "Mina and I reached the coast on a cold morning.",
        }, branch="journal-test")

        corrected = self.gateway.list_journal_events("story", "journal-test")
        original = self.gateway.list_journal_events("story", "main")
        corrected_event = next(item for item in corrected if item["event_id"] == "coast-arrival")
        original_event = next(item for item in original if item["event_id"] == "coast-arrival")
        self.assertEqual(revised["version"], 2)
        self.assertEqual(corrected_event["version"], 2)
        self.assertEqual(corrected_event["occurred_from"], "2024-03-06")
        self.assertEqual(corrected_event["history"][0]["occurred_from"], "2024-03-05")
        self.assertEqual(original_event["version"], 1)
        self.assertEqual(original_event["occurred_from"], "2024-03-05")
        self.assertEqual(len(corrected), 2)

        with self.assertRaises(ConflictError):
            self.command("stale-journal-correction", 4, "revise_journal_event", {
                "event_id": "coast-arrival", "expected_event_version": 1, "title": "Stale correction",
                "temporal_kind": "unknown",
            }, branch="journal-test")
        self.assertEqual(self.gateway.current_revision("story", "journal-test"), 4)

    def test_journal_event_validation_preserves_uncertainty_and_requires_source_quotes(self):
        invalid_payloads = [
            {"title": "Missing exact date", "temporal_kind": "exact"},
            {"title": "Reversed range", "temporal_kind": "range", "occurred_from": "2024-03-09", "occurred_to": "2024-03-01"},
            {"title": "Vague without wording", "temporal_kind": "relative"},
            {"title": "Quote without source", "temporal_kind": "unknown", "source_quote": "some text"},
        ]
        for index, payload in enumerate(invalid_payloads):
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                self.command(f"bad-journal-event-{index}", 0, "create_journal_event", payload)
        self.assertEqual(self.gateway.current_revision("story"), 0)

        self.command("journal-source", 0, "import_source", {
            "display_name": "diary.txt", "media_type": "text/plain", "content": "I left after the rain."})
        source = self.gateway.list_sources("story")[0]
        with self.assertRaises(ValidationError):
            self.command("bad-journal-quote", 1, "create_journal_event", {
                "title": "Left", "temporal_kind": "relative", "time_note": "after the rain",
                "source_id": source["source_id"], "source_quote": "This wording is not in the note.",
            })
        self.assertEqual(self.gateway.current_revision("story"), 1)
        self.assertEqual(self.gateway.list_journal_events("story"), [])

    def test_source_import_rejects_binary_empty_and_unsupported_content(self):
        invalid_payloads = [
            {"display_name": "archive.zip", "media_type": "application/zip", "content": "not an archive"},
            {"display_name": "binary.txt", "media_type": "text/plain", "content": "header\u0000payload"},
            {"display_name": "empty.txt", "media_type": "text/plain", "content": "  \n"},
            {"display_name": "large.txt", "media_type": "text/plain", "content": "x" * (10 * 1024 * 1024 + 1)},
        ]
        for index, payload in enumerate(invalid_payloads):
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                self.command(f"unsafe-source-{index}", 0, "import_source", payload)
        self.assertEqual(self.gateway.current_revision("story"), 0)
        self.assertEqual(self.gateway.list_sources("story"), [])

    def test_claims_are_proposals_by_default_and_ai_cannot_accept(self):
        self.create_entity("create-aria")
        proposed = self.command("claim-1", 1, "add_claim", {
            "subject_entity_id": "aria", "predicate": "knows", "object_value": "the secret"}, actor="ai:ollama")
        self.assertEqual(proposed["review_status"], "proposed")

        with self.assertRaises(ValidationError):
            self.command("claim-2", 2, "add_claim", {
                "subject_entity_id": "aria", "predicate": "knows", "object_value": "the secret",
                "review_status": "accepted"}, actor="ai:ollama")
        self.assertEqual(self.gateway.current_revision("story"), 2)

    def test_evidence_must_quote_an_imported_source(self):
        source = self.command("source-1", 0, "import_source", {
            "display_name": "note.md", "content": "The winter gate was sealed at dawn."})

        with self.assertRaises(ValidationError):
            self.command("evidence-bad", 1, "add_evidence", {
                "source_id": source["source_id"], "anchor": "paragraph-1", "quote": "The gate was open."})
        accepted = self.command("evidence-good", 1, "add_evidence", {
            "source_id": source["source_id"], "anchor": "paragraph-1", "quote": "The winter gate was sealed"})
        self.assertEqual(accepted["revision"], 2)

    def test_actor_context_excludes_future_and_unaware_claims(self):
        self.create_entity("create-aria")
        self.create_entity("create-kael", revision=1, entity_id="kael", label="Kael")
        secret = self.command("secret", 2, "add_claim", {
            "claim_id": "secret", "subject_entity_id": "kael", "predicate": "guards",
            "object_value": "a hidden letter", "review_status": "accepted",
            "visibility": "actor_scoped", "narrative_order": 5,
        })
        self.command("awareness", secret["revision"], "add_belief", {
            "actor_entity_id": "aria", "claim_id": "secret", "stance": "knows", "awareness_order": 8,
        })
        self.command("future", 4, "add_claim", {
            "claim_id": "future", "subject_entity_id": "kael", "predicate": "will_reveal",
            "object_value": "the letter tomorrow", "review_status": "accepted", "visibility": "public",
            "narrative_order": 12,
        })

        compiler = ContextCompiler(self.db)
        before_learning = compiler.compile_actor_context("story", "main", "aria", as_of_narrative_order=7)
        after_learning = compiler.compile_actor_context("story", "main", "aria", as_of_narrative_order=8)

        self.assertEqual(before_learning["included"], [])
        self.assertEqual([item["claim_id"] for item in after_learning["included"]], ["secret"])
        self.assertNotIn("future", [item["claim_id"] for item in after_learning["included"]])

    def test_story_turn_is_revisioned_and_idempotent_on_retry(self):
        self.create_entity("create-aria")
        conversation = self.command("conversation", 1, "create_conversation", {
            "conversation_id": "story-1", "actor_entity_id": "aria", "title": "The Brass Key",
            "actor_is_user_controlled": True,
        })
        payload = {
            "conversation_id": "story-1", "user_content": "What does Aria notice?",
            "assistant_content": "The stairwell is quiet.", "provider": "ollama", "model": "llama3.2",
            "narrative_order": 0, "context_revision": conversation["revision"],
            "context_manifest_id": "context-1",
            "context_manifest": {
                "manifest_id": "context-1", "workspace_id": "story", "branch_id": "main",
                "base_revision": conversation["revision"], "actor": {"entity_id": "aria"},
                "included": [], "excluded": [],
            },
        }
        first = self.command("turn-1", conversation["revision"], "append_story_turn", payload)
        retry = self.command("turn-1", conversation["revision"], "append_story_turn", {
            **payload, "assistant_content": "A different model response.", "context_manifest_id": "context-retry",
            "context_manifest": {**payload["context_manifest"], "manifest_id": "context-retry"},
        })
        saved = self.gateway.get_conversation("story", "main", "story-1")

        self.assertEqual(first, retry)
        self.assertEqual(self.gateway.current_revision("story"), first["revision"])
        self.assertTrue(saved["actor_is_user_controlled"])
        self.assertEqual([turn["role"] for turn in saved["turns"]], ["user", "assistant"])
        self.assertEqual(saved["turns"][1]["content"], "The stairwell is quiet.")
        self.assertEqual(saved["turns"][1]["context_manifest_id"], "context-1")
        self.assertEqual(saved["turns"][1]["context_manifest"]["base_revision"], conversation["revision"])

    def test_story_conversation_snapshot_isolated_between_branches(self):
        self.create_entity("create-aria")
        conversation = self.command("conversation", 1, "create_conversation", {
            "conversation_id": "story-1", "actor_entity_id": "aria", "title": "The Brass Key",
        })
        self.command("turn-1", conversation["revision"], "append_story_turn", {
            "conversation_id": "story-1", "user_content": "Begin.", "assistant_content": "The hall waits.",
            "provider": "ollama", "model": "llama3.2", "narrative_order": 0,
            "context_revision": conversation["revision"], "context_manifest_id": "context-1",
            "context_manifest": {
                "manifest_id": "context-1", "workspace_id": "story", "branch_id": "main",
                "base_revision": conversation["revision"], "actor": {"entity_id": "aria"},
                "included": [], "excluded": [],
            },
        })
        self.gateway.create_branch("story", "main", "what-if", 3, "branch-1")
        branch_conversation = self.gateway.get_conversation("story", "what-if", "story-1")
        self.assertEqual(len(branch_conversation["turns"]), 2)

        self.command("turn-branch", 3, "append_story_turn", {
            "conversation_id": "story-1", "user_content": "Open the door.",
            "assistant_content": "A draft describes what waits beyond it.", "provider": "ollama",
            "model": "llama3.2", "narrative_order": 1, "context_revision": 3,
            "context_manifest_id": "context-2",
            "context_manifest": {
                "manifest_id": "context-2", "workspace_id": "story", "branch_id": "what-if",
                "base_revision": 3, "actor": {"entity_id": "aria"}, "included": [], "excluded": [],
            },
        }, branch="what-if")

        self.assertEqual(len(self.gateway.get_conversation("story", "main", "story-1")["turns"]), 2)
        self.assertEqual(len(self.gateway.get_conversation("story", "what-if", "story-1")["turns"]), 4)
        self.assertEqual(self.gateway.current_revision("story", "main"), 3)
        self.assertEqual(self.gateway.current_revision("story", "what-if"), 4)

    def test_audit_events_cannot_be_updated_or_deleted(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.connection.execute("UPDATE audit_events SET reason='rewritten' WHERE workspace_id='story'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.connection.execute("DELETE FROM audit_events WHERE workspace_id='story'")


if __name__ == "__main__":
    unittest.main()
