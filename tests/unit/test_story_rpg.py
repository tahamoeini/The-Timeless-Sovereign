"""Revisioned Story Studio worlds, isolated adventures, and RPG transactions."""

import unittest

from lke.core import CommandGateway, ConflictError, Database, ValidationError
from lke.api.app import _story_adventure_context, _story_messages


class StoryRpgTests(unittest.TestCase):
    def setUp(self):
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.workspace_id = "rpg-workspace"
        self.gateway.create_workspace("RPG workspace", self.workspace_id)
        self.main_revision = self.command("hero", 0, "create_entity", {
            "entity_id": "hero", "entity_type": "character", "label": "Mira", "properties": {},
        })["revision"]
        self.world = self.command("world", self.main_revision, "create_story_world", {
            "world_id": "world", "name": "The Harbor", "description": "A small coastal fantasy setting.",
            "template_key": "fantasy", "content": {
                "starting_location": "Old Harbor",
                "public_lore": "A foggy fishing town faces a cold sea.",
                "author_notes": "The harbor master is secretly a ghost.",
                "stats": {"might": 2, "agility": 1},
                "trackers": {"health": {"value": 8, "max": 10}},
            },
        })
        self.main_revision = self.world["revision"]
        self.adventure_revision = self.create_adventure("adventure-a")

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
            reason="RPG test",
        )

    def create_adventure(self, adventure_id, *, world_version=1):
        self.gateway.create_branch(
            self.workspace_id, "main", adventure_id, self.main_revision, f"branch-{adventure_id}"
        )
        result = self.command(f"create-{adventure_id}", self.main_revision, "create_story_adventure", {
            "adventure_id": adventure_id,
            "world_id": "world",
            "world_version": world_version,
            "conversation_id": f"conversation-{adventure_id}",
            "name": f"Adventure {adventure_id}",
            "actor_entity_id": "hero",
        }, branch=adventure_id)
        return result["revision"]

    def test_world_revision_is_pinned_and_adventures_are_isolated(self):
        revised = self.command("revise-world", self.main_revision, "revise_story_world", {
            "world_id": "world", "expected_world_version": 1, "name": "Harbor After Winter",
            "description": "A revised setting.", "template_key": "fantasy",
            "content": {"starting_location": "Cliff Road", "stats": {"might": 3}},
        })
        self.main_revision = revised["revision"]
        second = self.create_adventure("adventure-b", world_version=2)

        first_state = self.gateway.get_rpg_state(self.workspace_id, "adventure-a", "adventure-a")
        second_state = self.gateway.get_rpg_state(self.workspace_id, "adventure-b", "adventure-b")
        self.assertEqual(first_state["adventure"]["world_version"], 1)
        self.assertEqual(second_state["adventure"]["world_version"], 2)
        self.assertEqual(first_state["sheet"]["current_location"], "Old Harbor")
        self.assertEqual(second_state["sheet"]["current_location"], "Cliff Road")
        adventure_names = {
            row["adventure_id"]: row["world_name"]
            for row in self.gateway.list_story_adventures(self.workspace_id)
        }
        self.assertEqual(adventure_names["adventure-a"], "The Harbor")
        self.assertEqual(adventure_names["adventure-b"], "Harbor After Winter")

        self.command("first-location", self.adventure_revision, "update_rpg_sheet", {
            "adventure_id": "adventure-a", "current_location": "Under the bridge",
        }, branch="adventure-a")
        self.assertEqual(
            self.gateway.get_rpg_state(self.workspace_id, "adventure-b", "adventure-b")["sheet"]["current_location"],
            "Cliff Road",
        )
        self.assertEqual(second, self.main_revision + 1)

    def test_d20_math_is_calculated_and_recorded_from_sheet(self):
        result = self.command("check", self.adventure_revision, "record_d20_check", {
            "adventure_id": "adventure-a", "stat_name": "might", "die_roll": 18, "target": 20,
        }, branch="adventure-a")
        self.assertEqual(
            (result["die_roll"], result["modifier"], result["total"], result["target"], result["outcome"]),
            (18, 2, 20, 20, "success"),
        )
        state = self.gateway.get_rpg_state(self.workspace_id, "adventure-a", "adventure-a")
        self.assertEqual(state["checks"][0]["total"], 20)

        with self.assertRaises(ValidationError):
            self.command("bad-check", result["revision"], "record_d20_check", {
                "adventure_id": "adventure-a", "stat_name": "might", "die_roll": 21, "target": 20,
            }, branch="adventure-a")
        self.assertEqual(self.gateway.current_revision(self.workspace_id, "adventure-a"), result["revision"])

    def test_proposals_do_not_change_canon_until_human_review(self):
        proposal = self.command("proposal", self.adventure_revision, "propose_rpg_state", {
            "adventure_id": "adventure-a",
            "changes": [
                {"operation": "tracker_delta", "tracker_id": "health", "delta": -3},
                {"operation": "set_location", "location": "Below the cliffs"},
            ],
        }, branch="adventure-a", actor="ai:local")
        before = self.gateway.get_rpg_state(self.workspace_id, "adventure-a", "adventure-a")["sheet"]
        self.assertEqual(before["trackers"]["health"]["value"], 8)
        self.assertEqual(before["current_location"], "Old Harbor")

        with self.assertRaises(ConflictError):
            self.command("stale-review", self.adventure_revision, "review_rpg_state_proposal", {
                "proposal_id": proposal["proposal_id"], "review_status": "accepted",
            }, branch="adventure-a")

        accepted = self.command("accept-proposal", proposal["revision"], "review_rpg_state_proposal", {
            "proposal_id": proposal["proposal_id"], "review_status": "accepted",
        }, branch="adventure-a")
        after = self.gateway.get_rpg_state(self.workspace_id, "adventure-a", "adventure-a")["sheet"]
        self.assertEqual(after["trackers"]["health"]["value"], 5)
        self.assertEqual(after["current_location"], "Below the cliffs")
        self.assertEqual(accepted["applied_changes"], proposal["changes"])

    def test_rejected_proposal_remains_out_of_canonical_state(self):
        proposal = self.command("proposal-reject", self.adventure_revision, "propose_rpg_state", {
            "adventure_id": "adventure-a",
            "changes": [{"operation": "tracker_delta", "tracker_id": "health", "delta": -2}],
        }, branch="adventure-a")
        self.command("reject-proposal", proposal["revision"], "review_rpg_state_proposal", {
            "proposal_id": proposal["proposal_id"], "review_status": "rejected",
        }, branch="adventure-a")
        state = self.gateway.get_rpg_state(self.workspace_id, "adventure-a", "adventure-a")
        self.assertEqual(state["sheet"]["trackers"]["health"]["value"], 8)
        self.assertEqual(state["proposals"][0]["review_status"], "rejected")

    def test_proposal_cannot_overwrite_a_sheet_changed_after_proposal(self):
        proposal = self.command("proposal-before-sheet-change", self.adventure_revision, "propose_rpg_state", {
            "adventure_id": "adventure-a",
            "changes": [{"operation": "tracker_delta", "tracker_id": "health", "delta": -2}],
        }, branch="adventure-a", actor="ai:local")
        changed = self.command("sheet-change-after-proposal", proposal["revision"], "update_rpg_sheet", {
            "adventure_id": "adventure-a", "trackers": {"health": {"value": 6, "max": 10}},
        }, branch="adventure-a")

        with self.assertRaisesRegex(ConflictError, "proposal is stale"):
            self.command("accept-stale-proposal", changed["revision"], "review_rpg_state_proposal", {
                "proposal_id": proposal["proposal_id"], "review_status": "accepted",
            }, branch="adventure-a")

        state = self.gateway.get_rpg_state(self.workspace_id, "adventure-a", "adventure-a")
        self.assertEqual(state["sheet"]["trackers"]["health"]["value"], 6)
        self.assertEqual(state["proposals"][0]["review_status"], "proposed")
        self.assertEqual(self.gateway.current_revision(self.workspace_id, "adventure-a"), changed["revision"])

    def test_rpg_state_branches_and_promotes_with_revision_checks(self):
        self.gateway.create_branch(
            self.workspace_id, "adventure-a", "rpg-alternate", self.adventure_revision, "branch-rpg-alternate"
        )
        self.command("alternate-location", self.adventure_revision, "update_rpg_sheet", {
            "adventure_id": "adventure-a", "current_location": "The northern road",
        }, branch="rpg-alternate")
        self.assertEqual(
            self.gateway.get_rpg_state(self.workspace_id, "adventure-a", "adventure-a")["sheet"]["current_location"],
            "Old Harbor",
        )
        alternate_revision = self.gateway.current_revision(self.workspace_id, "rpg-alternate")
        self.command("promote-rpg", self.adventure_revision, "promote_branch", {
            "source_branch_id": "rpg-alternate", "source_revision": alternate_revision,
        }, branch="adventure-a")
        self.assertEqual(
            self.gateway.get_rpg_state(self.workspace_id, "adventure-a", "adventure-a")["sheet"]["current_location"],
            "The northern road",
        )

    def test_story_context_uses_only_public_world_data_and_approved_rpg_state(self):
        self.command("pending-context", self.adventure_revision, "propose_rpg_state", {
            "adventure_id": "adventure-a",
            "changes": [{"operation": "set_location", "location": "An unreviewed hidden chamber"}],
        }, branch="adventure-a", actor="ai:local")
        story_context = _story_adventure_context(
            self.gateway, self.workspace_id, "adventure-a", "conversation-adventure-a"
        )
        self.assertEqual(story_context["public_lore"], "A foggy fishing town faces a cold sea.")
        self.assertEqual(story_context["author_notes"], [])
        self.assertNotIn("secretly a ghost", str(story_context))
        self.assertNotIn("unreviewed hidden chamber", str(story_context))

        conversation = self.gateway.get_conversation(
            self.workspace_id, "adventure-a", "conversation-adventure-a"
        )
        context = {
            "actor": {"entity_id": "hero", "label": "Mira", "entity_type": "character"},
            "as_of_narrative_order": 0,
            "included": [], "excluded": [], "manifest_id": "context-test", "base_revision": self.adventure_revision,
            "story": story_context,
        }
        messages = _story_messages(conversation, context, "Look around.")
        self.assertIn("A foggy fishing town", messages[0]["content"])
        self.assertNotIn("secretly a ghost", messages[0]["content"])


if __name__ == "__main__":
    unittest.main()
