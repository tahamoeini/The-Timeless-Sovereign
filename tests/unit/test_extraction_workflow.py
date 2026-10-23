"""Persisted local extraction proposals require explicit human review."""

import sqlite3
import unittest

from lke.core import CommandGateway, Database
from lke.core.errors import ConflictError, ValidationError


class ExtractionWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.gateway.create_workspace("Research", "research")
        self.source_text = "Aria guards the archive. She leaves before dawn."
        imported = self.command("source", 0, "import_source", {
            "source_id": "notes", "display_name": "Notes", "media_type": "text/plain", "content": self.source_text,
        })
        self.revision = imported["revision"]
        source = self.gateway.get_source("research", "notes")
        entity_quote = "Aria"
        first_quote = "Aria guards the archive."
        second_quote = "She leaves before dawn."
        self.stable_payload = {
            "batch_id": "batch-notes-1", "source_id": "notes", "source_sha256": source["content_sha256"],
            "model": "llama3.2", "extractor_version": "1", "prompt_version": "1", "output_schema_version": 1,
        }
        candidates = [
            {"candidate_id": "person-aria", "kind": "entity", "label": "Aria", "entity_type": "person",
             "quote": entity_quote, "source_start": 0, "source_end": len(entity_quote)},
            {"candidate_id": "claim-guards", "kind": "claim", "subject_label": "Aria", "predicate": "guards",
             "object_value": "the archive", "quote": first_quote,
             "source_start": self.source_text.index(first_quote),
             "source_end": self.source_text.index(first_quote) + len(first_quote)},
            {"candidate_id": "claim-leaves", "kind": "claim", "subject_label": "Aria", "predicate": "leaves before",
             "object_value": "dawn", "quote": second_quote,
             "source_start": self.source_text.index(second_quote),
             "source_end": self.source_text.index(second_quote) + len(second_quote)},
        ]
        self.batch_result = self.command(
            "record-batch", self.revision, "record_extraction_batch",
            {**self.stable_payload, "candidates": candidates}, actor="ai:ollama",
        )
        self.revision = self.batch_result["revision"]

    def tearDown(self):
        self.database.close()

    def command(self, key, revision, kind, payload, *, branch="main", actor="user"):
        return self.gateway.execute(
            workspace_id="research", branch_id=branch, idempotency_key=key,
            expected_revision=revision, command_type=kind, payload=payload,
            actor=actor, reason="extraction workflow test",
        )

    def test_extraction_stays_proposed_until_a_user_accepts_each_candidate(self):
        self.assertEqual(self.gateway.list_entities("research"), [])
        self.assertEqual(self.gateway.list_claims("research"), [])
        batch = self.gateway.list_extraction_batches("research")[0]
        self.assertEqual(batch["model"], "llama3.2")
        self.assertEqual([item["review_status"] for item in batch["candidates"]], ["proposed"] * 3)

        entity = self.command("accept-person", self.revision, "review_extraction_candidate", {
            "candidate_id": "person-aria", "review_status": "accepted",
        })
        self.revision = entity["revision"]
        entity_id = entity["canonical_record_id"]
        self.assertEqual(entity["canonical_record_type"], "entity")
        evidence_link = self.database.connection.execute(
            "SELECT e.quote FROM entity_evidence ee JOIN evidence e ON e.workspace_id=ee.workspace_id "
            "AND e.branch_id=ee.branch_id AND e.evidence_id=ee.evidence_id "
            "WHERE ee.workspace_id='research' AND ee.branch_id='main' AND ee.entity_id=?",
            (entity_id,),
        ).fetchone()
        self.assertEqual(evidence_link["quote"], "Aria")

        claim = self.command("accept-fact", self.revision, "review_extraction_candidate", {
            "candidate_id": "claim-guards", "review_status": "accepted", "subject_entity_id": entity_id,
            "epistemic_status": "unknown", "visibility": "public",
        })
        self.revision = claim["revision"]
        saved_claim = self.gateway.list_claims("research")[0]
        self.assertEqual(saved_claim["review_status"], "accepted")
        self.assertEqual(saved_claim["epistemic_status"], "unknown")
        self.assertEqual(len(saved_claim["evidence"]), 1)
        evidence = self.database.connection.execute(
            "SELECT quote FROM evidence WHERE workspace_id='research' AND branch_id='main' AND evidence_id=?",
            (saved_claim["evidence"][0],),
        ).fetchone()
        self.assertEqual(evidence["quote"], "Aria guards the archive.")

    def test_rejection_and_branch_review_do_not_change_the_parent_batch(self):
        self.gateway.create_branch("research", "main", "alternate", self.revision, "branch-1")
        rejected = self.command("reject-in-branch", self.revision, "review_extraction_candidate", {
            "candidate_id": "claim-leaves", "review_status": "rejected",
        }, branch="alternate")
        self.assertEqual(rejected["review_status"], "rejected")
        main_candidate = next(
            candidate for candidate in self.gateway.list_extraction_batches("research", "main")[0]["candidates"]
            if candidate["candidate_id"] == "claim-leaves"
        )
        branch_candidate = next(
            candidate for candidate in self.gateway.list_extraction_batches("research", "alternate")[0]["candidates"]
            if candidate["candidate_id"] == "claim-leaves"
        )
        self.assertEqual(main_candidate["review_status"], "proposed")
        self.assertEqual(branch_candidate["review_status"], "rejected")

    def test_stable_request_replay_ignores_nondeterministic_model_candidates(self):
        replayed = self.gateway.replay(
            workspace_id="research", branch_id="main", idempotency_key="record-batch",
            expected_revision=1, command_type="record_extraction_batch", payload=self.stable_payload,
            actor="ai:ollama", reason="extraction workflow test",
        )

        self.assertEqual(replayed, self.batch_result)
        self.assertEqual(self.gateway.current_revision("research"), 2)

    def test_ai_cannot_review_candidates_and_invalid_quotes_never_persist(self):
        with self.assertRaises(ValidationError):
            self.command("ai-review", self.revision, "review_extraction_candidate", {
                "candidate_id": "person-aria", "review_status": "accepted",
            }, actor="ai:ollama")
        with self.assertRaises(ValidationError):
            self.command("bad-quote", self.revision, "record_extraction_batch", {
                **self.stable_payload, "batch_id": "bad-batch", "candidates": [{
                    "candidate_id": "bad", "kind": "entity", "label": "Nobody", "entity_type": "person",
                    "quote": "Not in the source", "source_start": 0, "source_end": 3,
                }],
            }, actor="ai:ollama")
        self.assertEqual(self.gateway.current_revision("research"), self.revision)

    def test_failed_claim_acceptance_rolls_back_its_evidence(self):
        with self.assertRaises(ConflictError):
            self.command("bad-subject", self.revision, "review_extraction_candidate", {
                "candidate_id": "claim-guards", "review_status": "accepted", "subject_entity_id": "missing",
            })
        evidence_count = self.database.connection.execute(
            "SELECT COUNT(*) FROM evidence WHERE workspace_id='research' AND branch_id='main'"
        ).fetchone()[0]
        self.assertEqual(evidence_count, 0)
        candidate = next(
            item for item in self.gateway.list_extraction_batches("research")[0]["candidates"]
            if item["candidate_id"] == "claim-guards"
        )
        self.assertEqual(candidate["review_status"], "proposed")

    def test_extraction_payload_cannot_be_rewritten_or_deleted(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.connection.execute(
                "UPDATE extraction_candidates SET payload_json='{}' WHERE candidate_id='person-aria'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.connection.execute(
                "DELETE FROM extraction_candidates WHERE candidate_id='person-aria'"
            )


if __name__ == "__main__":
    unittest.main()
