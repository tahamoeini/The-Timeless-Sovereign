"""Explicit, audited fast-forward promotion of scenario branches."""

import json
import unittest

from lke.core import CommandGateway, Database
from lke.core.errors import ConflictError, ValidationError


class BranchPromotionTests(unittest.TestCase):
    def setUp(self):
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.workspace_id = "promotion-workspace"
        self.gateway.create_workspace("Promotion workspace", self.workspace_id)
        self.revision = 0
        self.revision = self.command("hero", self.revision, "create_entity", {
            "entity_id": "hero", "entity_type": "character", "label": "Mira", "properties": {},
        })["revision"]
        self.revision = self.command("source", self.revision, "import_source", {
            "source_id": "notes", "display_name": "Field notes", "media_type": "text/plain",
            "content": "Mira enters the old station. The hidden vault contains maps.",
        })["revision"]
        self.revision = self.command("evidence", self.revision, "add_evidence", {
            "evidence_id": "arrival-evidence", "source_id": "notes", "anchor": "opening sentence",
            "quote": "Mira enters the old station.", "entity_id": "hero",
        })["revision"]
        self.revision = self.command("claim", self.revision, "add_claim", {
            "claim_id": "arrival", "subject_entity_id": "hero", "predicate": "enters",
            "object_value": "the old station", "epistemic_status": "known", "review_status": "proposed",
            "evidence": ["arrival-evidence"],
        })["revision"]
        self.revision = self.command("scenario", self.revision, "create_scenario", {
            "scenario_id": "station-choice", "title": "Station choice", "problem": "What should Mira do?",
            "constraints": [], "options": [
                {"option_id": "wait", "label": "Wait", "description": "Stay in the station."},
                {"option_id": "leave", "label": "Leave", "description": "Return outside."},
            ], "evidence_claim_ids": ["arrival"], "evidence_source_ids": ["notes"],
        })["revision"]
        self.revision = self.command("conversation", self.revision, "create_conversation", {
            "conversation_id": "mira-story", "actor_entity_id": "hero", "title": "The old station",
        })["revision"]

    def tearDown(self):
        self.database.close()

    def command(self, key, revision, kind, payload, *, branch="main", actor="user"):
        return self.gateway.execute(
            workspace_id=self.workspace_id,
            branch_id=branch,
            idempotency_key=key,
            expected_revision=revision,
            command_type=kind,
            payload=payload,
            actor=actor,
            reason="branch promotion test",
        )

    def create_scenario_branch(self, branch_id="what-if"):
        return self.gateway.create_branch(
            self.workspace_id, "main", branch_id, self.revision, f"create-{branch_id}"
        )

    def promote(self, branch_id, source_revision, *, target_revision=None, key="promote", actor="user"):
        return self.command(
            key,
            self.revision if target_revision is None else target_revision,
            "promote_branch",
            {"source_branch_id": branch_id, "source_revision": source_revision},
            actor=actor,
        )

    def test_promotes_reviewed_branch_snapshot_and_preserves_both_histories(self):
        self.create_scenario_branch()
        branch_revision = self.revision
        branch_revision = self.command("entity-update", branch_revision, "update_entity", {
            "entity_id": "hero", "label": "Mira of the Station", "properties": {"role": "lead"},
        }, branch="what-if")["revision"]
        branch_revision = self.command("new-place", branch_revision, "create_entity", {
            "entity_id": "station", "entity_type": "location", "label": "Old station", "properties": {},
        }, branch="what-if")["revision"]
        branch_revision = self.command("relation", branch_revision, "add_relation", {
            "relation_id": "visited-station", "source_entity_id": "hero", "target_entity_id": "station",
            "relation_type": "visited", "review_status": "proposed", "properties": {"when": "after arrival"},
        }, branch="what-if")["revision"]
        branch_revision = self.command("relation-review", branch_revision, "review_relation", {
            "relation_id": "visited-station", "review_status": "accepted",
        }, branch="what-if")["revision"]
        branch_revision = self.command("claim-review", branch_revision, "review_claim", {
            "claim_id": "arrival", "review_status": "accepted",
        }, branch="what-if")["revision"]
        branch_revision = self.command("assumption", branch_revision, "set_scenario_assumption", {
            "scenario_id": "station-choice", "option_id": "wait", "assumption_id": "vault-found",
            "subject_entity_id": "hero", "predicate": "finds", "object_value": "a hidden vault",
            "assumption_action": "add", "predicate_cardinality": "multiple", "review_status": "accepted",
        }, branch="what-if")["revision"]
        branch_revision = self.command("journal", branch_revision, "create_journal_event", {
            "event_id": "station-entry", "title": "Mira enters the station", "details": "",
            "participants": ["Mira"], "temporal_kind": "relative", "time_note": "At the beginning",
            "source_id": "notes", "source_quote": "Mira enters the old station.",
        }, branch="what-if")["revision"]
        branch_revision = self.command("story-turn", branch_revision, "append_story_turn", {
            "conversation_id": "mira-story", "user_content": "Look around.",
            "assistant_content": "Mira studies the station walls.", "provider": "ollama", "model": "llama3.2",
            "narrative_order": 1, "context_revision": branch_revision, "context_manifest_id": "branch-context",
            "context_manifest": {
                "manifest_id": "branch-context", "workspace_id": self.workspace_id, "branch_id": "what-if",
                "base_revision": branch_revision, "actor": {"entity_id": "hero"}, "included": [], "excluded": [],
            },
        }, branch="what-if")["revision"]
        source = self.gateway.get_source(self.workspace_id, "notes")
        quote = "The hidden vault contains maps."
        start = source["content"].index(quote)
        branch_revision = self.command("extract", branch_revision, "record_extraction_batch", {
            "batch_id": "vault-extract", "source_id": "notes", "source_sha256": source["content_sha256"],
            "model": "llama3.2", "extractor_version": "1", "prompt_version": "1", "output_schema_version": 1,
            "candidates": [{"candidate_id": "vault-candidate", "kind": "entity", "label": "Vault",
                            "entity_type": "location", "quote": quote, "source_start": start,
                            "source_end": start + len(quote)}],
        }, branch="what-if", actor="ai:ollama")["revision"]
        branch_revision = self.command("extract-review", branch_revision, "review_extraction_candidate", {
            "candidate_id": "vault-candidate", "review_status": "accepted",
        }, branch="what-if")["revision"]
        branch_revision = self.command("rule", branch_revision, "create_rule", {
            "rule_id": "vault-required", "name": "Vault should be recorded", "rule_mode": "require",
            "severity": "soft", "subject_entity_id": "hero", "predicate": "finds",
            "object_value": "a hidden vault", "predicate_cardinality": "multiple", "review_status": "proposed",
        }, branch="what-if")["revision"]

        result = self.promote("what-if", branch_revision)

        self.assertEqual(result["revision"], self.revision + 1)
        self.assertEqual(result["source_revision_range"], [self.revision + 1, branch_revision])
        self.assertGreater(result["copied_rows"]["entities"], 0)
        self.assertEqual(self.gateway.current_revision(self.workspace_id, "main"), result["revision"])
        self.assertEqual(self.gateway.current_revision(self.workspace_id, "what-if"), branch_revision)

        entities = {item["entity_id"]: item for item in self.gateway.list_entities(self.workspace_id)}
        vault_entity = next(item for item in entities.values() if item["label"] == "Vault")
        self.assertEqual(entities["hero"]["label"], "Mira of the Station")
        self.assertEqual(entities["hero"]["properties"], {"role": "lead"})
        self.assertIn("station", entities)
        self.assertEqual(vault_entity["label"], "Vault")
        self.assertEqual(entities["station"]["created_revision"], result["revision"])
        self.assertEqual(entities["hero"]["updated_revision"], result["revision"])
        indexed = self.database.connection.execute(
            "SELECT label FROM entity_search WHERE workspace_id=? AND branch_id='main' AND entity_id='hero'",
            (self.workspace_id,),
        ).fetchone()
        self.assertEqual(indexed["label"], "Mira of the Station")

        relation = self.gateway.relations(self.workspace_id, "main")[0]
        self.assertEqual(relation["review_status"], "accepted")
        self.assertEqual(relation["created_revision"], result["revision"])
        claim = self.gateway.list_claims(self.workspace_id, "main")[0]
        self.assertEqual(claim["review_status"], "accepted")
        assumption = self.database.connection.execute(
            "SELECT object_value,review_status,created_revision FROM scenario_assumptions "
            "WHERE workspace_id=? AND branch_id='main' AND assumption_id='vault-found'",
            (self.workspace_id,),
        ).fetchone()
        self.assertEqual(assumption["object_value"], "a hidden vault")
        self.assertEqual(assumption["review_status"], "accepted")
        self.assertEqual(assumption["created_revision"], result["revision"])
        self.assertFalse(any(item["object_value"] == "a hidden vault" for item in self.gateway.list_claims(self.workspace_id, "main")))

        journal = self.gateway.list_journal_events(self.workspace_id, "main")
        self.assertEqual(journal[0]["source_quote"], "Mira enters the old station.")
        self.assertEqual(journal[0]["created_revision"], result["revision"])
        conversation = self.gateway.get_conversation(self.workspace_id, "main", "mira-story")
        self.assertEqual(len(conversation["turns"]), 2)
        self.assertEqual(conversation["turns"][1]["context_manifest"]["branch_id"], "what-if")
        self.assertEqual(conversation["turns"][1]["created_revision"], result["revision"])
        candidate = self.gateway.list_extraction_batches(self.workspace_id, "main")[0]["candidates"][0]
        self.assertEqual(candidate["review_status"], "accepted")
        self.assertEqual(candidate["canonical_record_id"], vault_entity["entity_id"])
        self.assertEqual(candidate["reviewed_revision"], result["revision"])
        evidence = self.database.connection.execute(
            "SELECT e.quote FROM entity_evidence ee JOIN evidence e ON e.workspace_id=ee.workspace_id "
            "AND e.branch_id=ee.branch_id AND e.evidence_id=ee.evidence_id "
            "WHERE ee.workspace_id=? AND ee.branch_id='main' AND ee.entity_id=?",
            (self.workspace_id, vault_entity["entity_id"]),
        ).fetchone()
        self.assertEqual(evidence["quote"], "The hidden vault contains maps.")
        self.assertEqual(len(self.gateway.evaluate_rules(self.workspace_id, "main")), 1)
        self.assertEqual(len(self.gateway.get_conversation(self.workspace_id, "what-if", "mira-story")["turns"]), 2)
        self.assertGreater(len(self.gateway.revisions(self.workspace_id, "what-if")), 1)

        audit = self.database.connection.execute(
            "SELECT revision,event_type,payload_json FROM audit_events WHERE workspace_id=? AND branch_id='main' "
            "ORDER BY revision DESC LIMIT 1",
            (self.workspace_id,),
        ).fetchone()
        self.assertEqual(audit["revision"], result["revision"])
        self.assertEqual(audit["event_type"], "branch.promoted")
        self.assertEqual(json.loads(audit["payload_json"])["source_branch_id"], "what-if")
        outbox = self.database.connection.execute(
            "SELECT revision,status FROM projection_outbox WHERE workspace_id=? AND branch_id='main' "
            "ORDER BY rowid DESC LIMIT 1",
            (self.workspace_id,),
        ).fetchone()
        self.assertEqual(outbox["revision"], result["revision"])
        replay = self.promote("what-if", branch_revision)
        self.assertEqual(replay, result)

    def test_rejects_empty_ai_stale_source_stale_parent_and_non_direct_promotion(self):
        self.create_scenario_branch()
        with self.assertRaises(ValidationError):
            self.promote("what-if", self.revision, key="empty")
        with self.assertRaises(ValidationError):
            self.promote("what-if", self.revision, key="ai", actor="ai:planner")

        branch_revision = self.command("child-entity", self.revision, "create_entity", {
            "entity_id": "alternate", "entity_type": "concept", "label": "Alternate", "properties": {},
        }, branch="what-if")["revision"]
        with self.assertRaises(ConflictError):
            self.promote("what-if", self.revision, key="stale-source")

        self.revision = self.command("parent-entity", self.revision, "create_entity", {
            "entity_id": "parent-change", "entity_type": "concept", "label": "Parent change", "properties": {},
        })["revision"]
        with self.assertRaises(ConflictError):
            self.promote("what-if", branch_revision, key="stale-parent")
        self.assertNotIn("alternate", {item["entity_id"] for item in self.gateway.list_entities(self.workspace_id)})

        self.gateway.create_branch(self.workspace_id, "what-if", "nested", branch_revision, "create-nested")
        nested_revision = self.command("nested-entity", branch_revision, "create_entity", {
            "entity_id": "nested-entity", "entity_type": "concept", "label": "Nested", "properties": {},
        }, branch="nested")["revision"]
        with self.assertRaises(ValidationError):
            self.command("nested-to-main", self.revision, "promote_branch", {
                "source_branch_id": "nested", "source_revision": nested_revision,
            })

    def test_copy_failure_rolls_back_parent_rows_revision_audit_and_outbox(self):
        self.create_scenario_branch()
        branch_revision = self.command("child-entity", self.revision, "create_entity", {
            "entity_id": "alternate", "entity_type": "concept", "label": "Alternate", "properties": {},
        }, branch="what-if")["revision"]
        connection = self.database.connection
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute(
            "INSERT INTO relations(workspace_id,branch_id,relation_id,source_entity_id,target_entity_id,relation_type,properties_json,review_status,created_revision) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (self.workspace_id, "what-if", "broken-relation", "missing", "alternate", "points-to", "{}", "proposed", branch_revision),
        )
        connection.execute("PRAGMA foreign_keys=ON")
        with self.assertRaises(ConflictError):
            self.promote("what-if", branch_revision, key="copy-fails")
        self.assertNotIn("alternate", {item["entity_id"] for item in self.gateway.list_entities(self.workspace_id)})
        self.assertEqual(self.gateway.current_revision(self.workspace_id, "main"), self.revision)
        self.assertIsNone(connection.execute(
            "SELECT 1 FROM audit_events WHERE workspace_id=? AND branch_id='main' AND event_type='branch.promoted'",
            (self.workspace_id,),
        ).fetchone())
        self.assertEqual(connection.execute(
            "SELECT COUNT(*) FROM projection_outbox WHERE workspace_id=? AND branch_id='main' AND revision>?",
            (self.workspace_id, self.revision),
        ).fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
