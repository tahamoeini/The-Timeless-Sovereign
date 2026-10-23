"""Versioned external transcript exchanges stay reviewable and deduplicated."""

import hashlib
import json
import sqlite3
import unittest

from lke.core import CommandGateway, Database
from lke.core.errors import ConflictError, ValidationError


class ExchangeWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.gateway.create_workspace("Story", "story")
        created = self.command("aria", 0, "create_entity", {
            "entity_id": "aria", "entity_type": "character", "label": "Aria", "properties": {},
        })
        self.revision = created["revision"]

    def tearDown(self):
        self.database.close()

    def command(self, key, revision, kind, payload, *, branch="main", actor="user"):
        return self.gateway.execute(
            workspace_id="story", branch_id=branch, idempotency_key=key,
            expected_revision=revision, command_type=kind, payload=payload,
            actor=actor, reason="external exchange workflow test",
        )

    @staticmethod
    def turns(number=10, assistant_content="The archive door opens."):
        return [{
            "turn_number": number,
            "messages": [
                {"role": "user", "content": "Continue the scene."},
                {"role": "assistant", "content": assistant_content},
            ],
        }]

    @staticmethod
    def transcript_hash(turns):
        canonical = json.dumps(turns, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def envelope(self, *, exchange_id="external-1", branch="main", base_revision=1, turns=None,
                 from_turn=10, to_turn=10, transcript_total_turns=None, proposed_change_ids=None):
        turns = turns or self.turns()
        transcript_total_turns = transcript_total_turns or max(turn["turn_number"] for turn in turns)
        return {
            "protocol": "lke.exchange.v1",
            "transcript_id": "external-conversation-1",
            "workspace_id": "story",
            "branch_id": branch,
            "base_revision": base_revision,
            "exchange_id": exchange_id,
            "context_manifest_id": f"context-{branch}-{base_revision}",
            "context_manifest": {
                "protocol": "lke.context.v1",
                "manifest_id": f"context-{branch}-{base_revision}",
                "workspace_id": "story",
                "branch_id": branch,
                "base_revision": base_revision,
                "actor": {"entity_id": "aria", "label": "Aria", "entity_type": "character"},
                "as_of_narrative_order": 10,
                "included": [],
                "excluded": [],
                "token_estimate": 0,
            },
            "transcript_range": {"from_turn": from_turn, "to_turn": to_turn},
            "transcript_total_turns": transcript_total_turns,
            "transcript_hash": self.transcript_hash(turns),
            "turns": turns,
            "proposed_change_ids": proposed_change_ids or [],
        }

    def test_import_preserves_text_and_deduplicates_retries_without_revision(self):
        envelope = self.envelope(proposed_change_ids=["change-1"])
        imported = self.command("import-one", 1, "import_exchange", envelope)

        self.assertEqual(imported["revision"], 2)
        self.assertEqual(imported["turn_count"], 1)
        self.assertFalse(imported["stale_context"])
        self.assertEqual(imported["missing_turns"], [{"from_turn": 1, "to_turn": 9}])
        exchange = self.gateway.list_external_exchanges("story")[0]
        self.assertEqual(exchange["turns"], envelope["turns"])
        self.assertEqual(exchange["proposed_change_ids"], ["change-1"])
        self.assertFalse(exchange["stale_context"])
        self.assertEqual(self.gateway.list_conversations("story"), [])

        duplicate = self.command("import-one-again", 2, "import_exchange", envelope)
        self.assertEqual(duplicate["revision"], 2)
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(len(self.gateway.list_external_exchanges("story")), 1)

        same_text = self.envelope(exchange_id="different-id")
        same_text_duplicate = self.command("import-same-text", 2, "import_exchange", same_text)
        self.assertEqual(same_text_duplicate["revision"], 2)
        self.assertTrue(same_text_duplicate["duplicate"])
        self.assertEqual(same_text_duplicate["exchange_id"], "external-1")

    def test_identity_reuse_with_changed_text_is_a_conflict(self):
        self.command("import-one", 1, "import_exchange", self.envelope())
        changed = self.envelope(turns=self.turns(assistant_content="The archive is sealed."))

        with self.assertRaises(ConflictError):
            self.command("changed-content", 2, "import_exchange", changed)
        self.assertEqual(self.gateway.current_revision("story"), 2)
        self.assertEqual(len(self.gateway.list_external_exchanges("story")), 1)

    def test_missing_turns_are_reported_across_segments_and_overlaps_must_agree(self):
        first_turns = [self.turns(1)[0], self.turns(2)[0]]
        first = self.envelope(turns=first_turns, from_turn=1, to_turn=2, transcript_total_turns=6)
        self.command("import-first-segment", 1, "import_exchange", first)

        later_turns = [self.turns(5)[0], self.turns(6)[0]]
        later = self.envelope(
            exchange_id="external-2", base_revision=2, turns=later_turns, from_turn=5, to_turn=6,
            transcript_total_turns=6,
        )
        imported = self.command("import-later-segment", 2, "import_exchange", later)
        self.assertEqual(imported["missing_turns"], [{"from_turn": 3, "to_turn": 4}])
        saved = self.gateway.list_external_exchanges("story")
        self.assertEqual(saved[0]["missing_turns"], [{"from_turn": 3, "to_turn": 4}])

        conflicting_overlap = self.envelope(
            exchange_id="external-conflict", base_revision=3,
            turns=self.turns(2, assistant_content="A different answer."), from_turn=2, to_turn=2,
            transcript_total_turns=6,
        )
        with self.assertRaises(ConflictError):
            self.command("import-conflicting-overlap", 3, "import_exchange", conflicting_overlap)
        self.assertEqual(self.gateway.current_revision("story"), 3)

    def test_identical_text_in_a_different_transcript_remains_distinct(self):
        self.command("import-one", 1, "import_exchange", self.envelope())
        separate = self.envelope(exchange_id="separate-conversation", base_revision=2)
        separate["transcript_id"] = "external-conversation-2"
        separate["context_manifest_id"] = "context-main-2"
        separate["context_manifest"]["manifest_id"] = "context-main-2"
        separate["context_manifest"]["base_revision"] = 2
        imported = self.command("import-separate", 2, "import_exchange", separate)
        self.assertFalse(imported["duplicate"])
        self.assertEqual(imported["revision"], 3)
        self.assertEqual(len(self.gateway.list_external_exchanges("story")), 2)

    def test_known_transcript_end_exposes_a_missing_tail(self):
        self.command("import-one", 1, "import_exchange", self.envelope())
        extended_snapshot = self.envelope(
            exchange_id="external-extended", base_revision=2, transcript_total_turns=12,
        )
        imported = self.command("import-extended-snapshot", 2, "import_exchange", extended_snapshot)
        self.assertEqual(imported["missing_turns"], [
            {"from_turn": 1, "to_turn": 9}, {"from_turn": 11, "to_turn": 12},
        ])
        self.assertEqual(len(self.gateway.list_external_exchanges("story")), 2)

    def test_hash_gaps_future_context_and_ai_imports_fail_without_writes(self):
        bad_hash = self.envelope()
        bad_hash["transcript_hash"] = "sha256:" + ("0" * 64)
        with self.assertRaises(ValidationError):
            self.command("bad-hash", 1, "import_exchange", bad_hash)

        gap_turns = [self.turns(10)[0], self.turns(12)[0]]
        gap = self.envelope(turns=gap_turns, from_turn=10, to_turn=12)
        with self.assertRaises(ValidationError):
            self.command("missing-turn", 1, "import_exchange", gap)

        future = self.envelope(base_revision=2)
        with self.assertRaises(ConflictError):
            self.command("future-context", 1, "import_exchange", future)

        with self.assertRaises(ValidationError):
            self.command("ai-import", 1, "import_exchange", self.envelope(), actor="ai:codex")
        self.assertEqual(self.gateway.current_revision("story"), 1)
        self.assertEqual(self.gateway.list_external_exchanges("story"), [])

    def test_stale_context_is_retained_as_an_exchange_proposal(self):
        self.command("other-entity", 1, "create_entity", {
            "entity_id": "kael", "entity_type": "character", "label": "Kael", "properties": {},
        })
        stale = self.command("import-stale", 2, "import_exchange", self.envelope(base_revision=1))

        self.assertTrue(stale["stale_context"])
        self.assertEqual(self.gateway.current_revision("story"), 3)
        self.assertEqual(len(self.gateway.list_entities("story")), 2)
        exchange = self.gateway.list_external_exchanges("story")[0]
        self.assertTrue(exchange["stale_context"])
        self.assertEqual(exchange["base_revision"], 1)

    def test_exchange_snapshot_and_promotion_preserve_branch_provenance(self):
        self.command("import-main", 1, "import_exchange", self.envelope())
        self.gateway.create_branch("story", "main", "what-if", 2, "branch-exchange")
        inherited = self.gateway.list_external_exchanges("story", "what-if")
        self.assertEqual(len(inherited), 1)
        self.assertTrue(inherited[0]["stale_context"])

        branch_exchange = self.envelope(
            exchange_id="branch-exchange", branch="what-if", base_revision=2,
            turns=self.turns(11, "Aria remembers a different ending."), from_turn=11, to_turn=11,
        )
        self.command("import-branch", 2, "import_exchange", branch_exchange, branch="what-if")
        self.assertEqual(self.gateway.current_revision("story", "main"), 2)
        self.assertEqual(len(self.gateway.list_external_exchanges("story", "main")), 1)

        promoted = self.command("promote-exchange", 2, "promote_branch", {
            "source_branch_id": "what-if", "source_revision": 3,
        })
        self.assertEqual(promoted["revision"], 3)
        main_exchanges = self.gateway.list_external_exchanges("story", "main")
        self.assertEqual({item["exchange_id"] for item in main_exchanges}, {"external-1", "branch-exchange"})
        imported_branch_text = next(item for item in main_exchanges if item["exchange_id"] == "branch-exchange")
        self.assertTrue(imported_branch_text["stale_context"])
        self.assertEqual(imported_branch_text["context_manifest"]["branch_id"], "what-if")
        self.assertEqual(self.gateway.current_revision("story", "what-if"), 3)

    def test_exchange_records_are_immutable(self):
        self.command("import-one", 1, "import_exchange", self.envelope())
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.connection.execute(
                "UPDATE external_exchanges SET turns_json='[]' WHERE exchange_id='external-1'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.connection.execute(
                "DELETE FROM external_exchanges WHERE exchange_id='external-1'"
            )


if __name__ == "__main__":
    unittest.main()
