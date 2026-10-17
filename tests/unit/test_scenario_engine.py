"""Versioned scenario assumptions and deterministic conditional outcomes."""

import sqlite3
import unittest

from lke.core import CommandGateway, Database
from lke.core.errors import ConflictError, NotFoundError, ValidationError


class ScenarioEngineTests(unittest.TestCase):
    def setUp(self):
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.gateway.create_workspace("Decision workspace", "decisions")
        self.revision = self.command("entity", 0, "create_entity", {
            "entity_id": "project", "entity_type": "concept", "label": "Project", "properties": {},
        })["revision"]
        self.revision = self.command("claim", self.revision, "add_claim", {
            "claim_id": "funding", "subject_entity_id": "project", "predicate": "funding",
            "object_value": "secured", "epistemic_status": "known", "review_status": "accepted",
        })["revision"]
        self.revision = self.command("rule", self.revision, "create_rule", {
            "rule_id": "funding-required", "name": "Funding must be secured", "rule_mode": "require",
            "severity": "hard", "subject_entity_id": "project", "predicate": "funding",
            "object_value": "secured", "predicate_cardinality": "single", "review_status": "accepted",
        })["revision"]
        self.revision = self.command("source", self.revision, "import_source", {
            "source_id": "budget", "display_name": "Budget note", "media_type": "text/plain",
            "content": "The project currently has secured funding.",
        })["revision"]
        self.revision = self.command("scenario", self.revision, "create_scenario", {
            "scenario_id": "funding-choice", "title": "Funding choice",
            "problem": "Choose whether to proceed with the project.",
            "constraints": ["Do not spend beyond the approved budget."],
            "options": [
                {"option_id": "proceed", "label": "Proceed", "description": "Keep the current plan."},
                {"option_id": "pause", "label": "Pause", "description": "Wait for a new decision."},
            ],
            "evidence_claim_ids": ["funding"], "evidence_source_ids": ["budget"],
        })["revision"]

    def tearDown(self):
        self.database.close()

    def command(self, key, revision, kind, payload, *, branch="main", actor="user"):
        return self.gateway.execute(
            workspace_id="decisions", branch_id=branch, idempotency_key=key,
            expected_revision=revision, command_type=kind, payload=payload,
            actor=actor, reason="scenario unit test",
        )

    def assumption(self, *, option="pause", value="suspended", assumption_id="funding-state", expected_version=None, revision=None):
        payload = {
            "scenario_id": "funding-choice", "option_id": option, "assumption_id": assumption_id,
            "subject_entity_id": "project", "predicate": "funding", "object_value": value,
            "assumption_action": "replace", "predicate_cardinality": "single",
        }
        if expected_version is not None:
            payload["expected_version"] = expected_version
        current_revision = self.revision if revision is None else revision
        result = self.command(f"assumption-{current_revision}-{expected_version}", current_revision,
                              "set_scenario_assumption", payload)
        self.revision = result["revision"]
        return result

    def scenario(self, branch="main"):
        rows = self.gateway.scenario_evaluations("decisions", branch)
        self.assertEqual(len(rows), 1)
        return rows[0]

    def test_options_keep_assumptions_separate_and_evaluate_conditionally(self):
        self.assumption()

        scenario = self.scenario()
        by_option = {option["label"]: option for option in scenario["options"]}
        proceed = by_option["Proceed"]["rule_evaluations"][0]["evaluation"]
        pause = by_option["Pause"]["rule_evaluations"][0]["evaluation"]

        self.assertEqual(scenario["constraints"], ["Do not spend beyond the approved budget."])
        self.assertEqual(scenario["evidence_claims"][0]["claim_id"], "funding")
        self.assertEqual(scenario["evidence_sources"][0]["source_id"], "budget")
        self.assertEqual(proceed["status"], "satisfied")
        self.assertFalse(proceed["conditional"])
        self.assertEqual(pause["status"], "violated")
        self.assertTrue(pause["conditional"])
        self.assertEqual(pause["assumption_ids"], ["funding-state"])
        self.assertEqual(self.gateway.list_claims("decisions")[0]["object_value"], "secured")
        self.assertEqual(self.gateway.evaluate_rules("decisions")[0]["evaluation"]["status"], "satisfied")

    def test_changing_an_assumption_appends_a_version_and_recomputes_the_option(self):
        first = self.assumption()
        second = self.assumption(value="secured", expected_version=1)

        pause = next(option for option in self.scenario()["options"] if option["label"] == "Pause")
        assumption = pause["assumptions"][0]
        evaluation = pause["rule_evaluations"][0]["evaluation"]
        self.assertEqual(first["version"], 1)
        self.assertEqual(second["version"], 2)
        self.assertEqual(assumption["version"], 2)
        self.assertEqual(len(pause["assumption_history"]), 2)
        self.assertEqual(assumption["supersedes_version"], 1)
        self.assertEqual(evaluation["status"], "satisfied")
        self.assertTrue(evaluation["conditional"])

    def test_branch_snapshot_copies_scenario_then_keeps_assumption_edits_isolated(self):
        self.assumption()
        self.gateway.create_branch("decisions", "main", "what-if", self.revision, "branch-scenario")
        self.command("branch-revise", self.revision, "set_scenario_assumption", {
            "scenario_id": "funding-choice", "option_id": "pause", "assumption_id": "funding-state",
            "expected_version": 1, "subject_entity_id": "project", "predicate": "funding",
            "object_value": "secured", "assumption_action": "replace", "predicate_cardinality": "single",
        }, branch="what-if")

        main_pause = next(option for option in self.scenario("main")["options"] if option["label"] == "Pause")
        branch_pause = next(option for option in self.scenario("what-if")["options"] if option["label"] == "Pause")
        self.assertEqual(main_pause["assumptions"][0]["object_value"], "suspended")
        self.assertEqual(branch_pause["assumptions"][0]["object_value"], "secured")
        self.assertEqual(main_pause["rule_evaluations"][0]["evaluation"]["status"], "violated")
        self.assertEqual(branch_pause["rule_evaluations"][0]["evaluation"]["status"], "satisfied")

    def test_unreviewed_ai_assumption_is_visible_but_not_applied(self):
        result = self.command("ai-assumption", self.revision, "set_scenario_assumption", {
            "scenario_id": "funding-choice", "option_id": "pause", "assumption_id": "ai-funding",
            "subject_entity_id": "project", "predicate": "funding", "object_value": "suspended",
            "assumption_action": "replace", "predicate_cardinality": "single",
        }, actor="ai:planner")
        self.revision = result["revision"]

        pause = next(option for option in self.scenario()["options"] if option["label"] == "Pause")
        evaluation = pause["rule_evaluations"][0]["evaluation"]
        self.assertEqual(pause["assumptions"][0]["review_status"], "proposed")
        self.assertEqual(evaluation["status"], "satisfied")
        self.assertEqual(evaluation["unreviewed_assumption_ids"], ["ai-funding"])

    def test_stale_assumption_version_and_invalid_property_action_are_rejected(self):
        self.assumption()
        with self.assertRaises(ConflictError):
            self.command("stale", self.revision, "set_scenario_assumption", {
                "scenario_id": "funding-choice", "option_id": "pause", "assumption_id": "funding-state",
                "expected_version": 0, "subject_entity_id": "project", "predicate": "funding",
                "object_value": "secured", "assumption_action": "replace", "predicate_cardinality": "single",
            })
        with self.assertRaises(ValidationError):
            self.command("bad-action", self.revision, "set_scenario_assumption", {
                "scenario_id": "funding-choice", "option_id": "proceed", "subject_entity_id": "project",
                "predicate": "funding", "object_value": "more funding", "assumption_action": "add",
                "predicate_cardinality": "single",
            })
        with self.assertRaises(NotFoundError):
            self.command("bad-evidence", self.revision, "create_scenario", {
                "title": "Invalid", "problem": "Missing evidence", "options": [
                    {"label": "A"}, {"label": "B"},
                ], "evidence_claim_ids": ["missing"],
            })

    def test_assumption_versions_are_append_only(self):
        self.assumption()
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.connection.execute(
                "UPDATE scenario_assumptions SET object_value='rewritten' WHERE assumption_id='funding-state'"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.connection.execute(
                "DELETE FROM scenario_assumptions WHERE assumption_id='funding-state'"
            )


if __name__ == "__main__":
    unittest.main()
