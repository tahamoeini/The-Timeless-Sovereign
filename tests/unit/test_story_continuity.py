"""Continuity, NPC, map, and local image behavior for world-based stories."""

import base64
import unittest

from lke.core import CommandGateway, Database, ValidationError


class StoryContinuityTests(unittest.TestCase):
    def setUp(self):
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.workspace_id = "continuity-workspace"
        self.gateway.create_workspace("Continuity", self.workspace_id)
        created = self.command("hero", 0, "create_entity", {
            "entity_id": "hero", "entity_type": "character", "label": "Mira", "properties": {},
        })
        self.revision = created["revision"]
        world = self.command("world", self.revision, "create_story_world", {
            "world_id": "harbor", "name": "The Harbor", "template_key": "fantasy",
            "content": {
                "starting_location": "Old Harbor", "locations": ["Old Harbor", "Cliff Road"],
                "stats": {"might": 1}, "trackers": {"health": {"value": 8, "max": 10}},
                "public_lore": "A town at the edge of a cold sea.",
            },
        })
        self.revision = world["revision"]
        self.gateway.create_branch(self.workspace_id, "main", "adventure", self.revision, "branch")
        adventure = self.command("adventure", self.revision, "create_story_adventure", {
            "adventure_id": "adventure", "world_id": "harbor", "world_version": 1,
            "conversation_id": "conversation", "name": "Fog on the Coast", "actor_entity_id": "hero",
        }, branch="adventure")
        self.revision = adventure["revision"]

    def tearDown(self):
        self.database.close()

    def command(self, key, revision, kind, payload, *, branch="main", actor="user"):
        return self.gateway.execute(
            workspace_id=self.workspace_id, branch_id=branch, idempotency_key=key,
            expected_revision=revision, command_type=kind, payload=payload, actor=actor,
            reason="Story continuity test",
        )

    def append_turn(self, key, revision, prompt, response, order=1):
        manifest = {
            "manifest_id": f"manifest-{key}", "base_revision": revision,
            "workspace_id": self.workspace_id, "branch_id": "adventure",
            "actor": {"entity_id": "hero"}, "included": [], "excluded": [],
        }
        return self.command(key, revision, "append_story_turn", {
            "conversation_id": "conversation", "user_content": prompt, "assistant_content": response,
            "provider": "ollama", "model": "local-test", "narrative_order": order,
            "context_revision": revision, "context_manifest_id": manifest["manifest_id"],
            "context_manifest": manifest,
        }, branch="adventure")

    def test_turn_edits_preserve_history_and_hide_downstream_turns(self):
        first = self.append_turn("turn-one", self.revision, "Walk to the gate", "The gate is closed.")
        conversation = first["revision"]
        turns = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")["turns"]
        changed = self.command("edit-prompt", conversation, "edit_story_turn", {
            "conversation_id": "conversation", "turn_id": turns[0]["turn_id"], "action": "edit",
            "content": "Walk to the bridge", "superseded_turn_ids": [turns[1]["turn_id"]],
        }, branch="adventure")
        revised = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")
        self.assertEqual([turn["status"] for turn in revised["turns"]], ["active", "superseded"])
        self.assertEqual(revised["turns"][0]["edit_history"][0]["content"], "Walk to the bridge")
        self.assertEqual(revised["turns"][1]["content"], "The gate is closed.")
        self.assertEqual(self.gateway.current_revision(self.workspace_id, "adventure"), changed["revision"])

    def test_retry_metadata_is_audited_and_turn_revisions_are_immutable(self):
        first = self.append_turn("retry-base", self.revision, "Look at the sea", "The sea is dark.")
        conversation = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")
        assistant = conversation["turns"][1]
        revision = first["revision"]
        manifest = {
            "manifest_id": "retry-manifest", "base_revision": revision,
            "workspace_id": self.workspace_id, "branch_id": "adventure",
            "actor": {"entity_id": "hero"}, "included": [], "excluded": [],
        }
        result = self.command("retry-turn", revision, "edit_story_turn", {
            "conversation_id": "conversation", "turn_id": assistant["turn_id"], "action": "edit",
            "content": "A cold wind crosses the dark sea.", "provider": "ollama", "model": "local-test-2",
            "context_manifest_id": "retry-manifest", "context_manifest": manifest,
            "context_revision": revision,
        }, branch="adventure")
        retried = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")["turns"][1]
        self.assertEqual(retried["content"], "A cold wind crosses the dark sea.")
        self.assertEqual(retried["model"], "local-test-2")
        self.assertEqual(retried["context_manifest_id"], "retry-manifest")
        self.assertEqual(len(retried["edit_history"]), 1)
        with self.assertRaises(Exception):
            self.database.connection.execute(
                "UPDATE story_turn_edits SET content='tampered' WHERE workspace_id=? AND branch_id=? AND turn_id=?",
                (self.workspace_id, "adventure", assistant["turn_id"]),
            )
        self.assertEqual(result["revision"], revision + 1)

    def test_memories_are_versioned_reviewable_and_threads_are_scoped(self):
        turn = self.append_turn("memory-source", self.revision, "Knock on the door", "A lantern appears in the window.")
        conversation = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")
        source_turn = conversation["turns"][1]["turn_id"]
        note = self.command("note", turn["revision"], "create_story_memory", {
            "adventure_id": "adventure", "memory_id": "promise", "kind": "note",
            "content": "Mira promised to return before dawn.", "context_enabled": True,
        }, branch="adventure")
        event = self.command("event", note["revision"], "create_story_memory", {
            "adventure_id": "adventure", "memory_id": "lantern", "kind": "event",
            "content": "A lantern appeared in the window.", "context_enabled": True,
            "source_turn_id": source_turn, "review_status": "proposed",
        }, branch="adventure")
        self.command("review-event", event["revision"], "review_story_memory", {
            "adventure_id": "adventure", "memory_id": "lantern", "version": 1, "review_status": "accepted",
        }, branch="adventure")
        memory_state = self.gateway.get_story_memories(self.workspace_id, "adventure", "adventure")
        by_id = {memory["memory_id"]: memory for memory in memory_state["memories"]}
        self.assertEqual(by_id["promise"]["review_status"], "accepted")
        self.assertEqual(by_id["lantern"]["review_status"], "accepted")
        self.assertEqual(by_id["lantern"]["source_turn_id"], source_turn)

        thread = self.command("thread", self.gateway.current_revision(self.workspace_id, "adventure"), "save_story_thread", {
            "adventure_id": "adventure", "thread_id": "missing-sailor", "title": "The missing sailor",
            "detail": "No one has seen him since the storm.",
        }, branch="adventure")
        threads = self.gateway.get_story_memories(self.workspace_id, "adventure", "adventure")["threads"]
        self.assertEqual(threads[0]["status"], "open")
        self.assertEqual(threads[0]["thread_id"], "missing-sailor")
        self.assertGreater(thread["revision"], note["revision"])

    def test_npc_simulation_changes_wait_for_review_and_create_event_memory(self):
        npc = self.command("npc-entity", self.revision, "create_entity", {
            "entity_id": "ferryman", "entity_type": "character", "label": "The Ferryman", "properties": {},
        }, branch="adventure")
        profile = self.command("npc-profile", npc["revision"], "update_story_npc", {
            "adventure_id": "adventure", "npc_entity_id": "ferryman", "aliases": ["Boatman"],
            "public_profile": {"appearance": "A gray coat", "current_goal": "Guard the old ferry"},
            "private_profile": {"notes": "Knows the captain's secret."}, "review_status": "accepted",
        }, branch="adventure")
        turn = self.append_turn("npc-turn", profile["revision"], "Ask about the ferry", "The ferryman turns away.")
        source_turn = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")["turns"][-1]["turn_id"]
        proposed = self.command("npc-simulation", turn["revision"], "propose_rpg_state", {
            "adventure_id": "adventure", "source_turn_id": source_turn, "changes": [
                {"operation": "npc_profile", "npc_entity_id": "ferryman", "updates": {"current_goal": "Find the lost key"}},
                {"operation": "add_event_memory", "content": "The ferryman turned away from Mira.", "context_enabled": True},
            ],
        }, branch="adventure", actor="ai:local")
        before = self.gateway.list_story_npcs(self.workspace_id, "adventure", "adventure")[0]
        self.assertEqual(before["public_profile"]["current_goal"], "Guard the old ferry")
        self.command("review-npc-simulation", proposed["revision"], "review_rpg_state_proposal", {
            "proposal_id": proposed["proposal_id"], "review_status": "accepted",
        }, branch="adventure")
        after = self.gateway.list_story_npcs(self.workspace_id, "adventure", "adventure")[0]
        self.assertEqual(after["public_profile"]["current_goal"], "Find the lost key")
        memories = self.gateway.get_story_memories(self.workspace_id, "adventure", "adventure")["memories"]
        self.assertEqual(memories[0]["kind"], "event")
        self.assertEqual(memories[0]["review_status"], "accepted")
        self.assertEqual(memories[0]["source_turn_id"], source_turn)

    def test_approved_map_travel_and_location_proposals(self):
        turn = self.append_turn("map-turn", self.revision, "Explore the coast", "A path winds toward the cliffs.")
        conversation = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")
        proposed = self.command("map-proposal", turn["revision"], "propose_rpg_state", {
            "adventure_id": "adventure", "source_turn_id": conversation["turns"][-1]["turn_id"],
            "changes": [{"operation": "set_location", "location": "Smuggler's Cove"}],
        }, branch="adventure", actor="ai:local")
        self.command("accept-map", proposed["revision"], "review_rpg_state_proposal", {
            "proposal_id": proposed["proposal_id"], "review_status": "accepted",
        }, branch="adventure")
        locations = self.gateway.list_story_locations(self.workspace_id, "adventure", "adventure")
        self.assertEqual(locations[0]["name"], "Smuggler's Cove")
        travel = self.command("travel", self.gateway.current_revision(self.workspace_id, "adventure"), "travel_to_location", {
            "adventure_id": "adventure", "location": "Cliff Road",
        }, branch="adventure")
        state = self.gateway.get_rpg_state(self.workspace_id, "adventure", "adventure")
        self.assertEqual(state["sheet"]["current_location"], "Cliff Road")
        with self.assertRaises(ValidationError):
            self.command("unknown-travel", travel["revision"], "travel_to_location", {
                "adventure_id": "adventure", "location": "Unreviewed Cave",
            }, branch="adventure")

    def test_local_image_assets_validate_bytes_and_are_branch_scoped(self):
        png = b"\x89PNG\r\n\x1a\n" + b"test-image"
        result = self.command("image", self.revision, "add_story_asset", {
            "adventure_id": "adventure", "asset_id": "hero-reference", "target_kind": "character",
            "target_id": "hero", "display_name": "Mira reference.png", "mime_type": "image/png",
            "data_base64": base64.b64encode(png).decode("ascii"), "provenance": {"origin": "user_upload"},
        }, branch="adventure")
        assets = self.gateway.list_story_assets(self.workspace_id, "adventure", "adventure")
        self.assertEqual(assets[0]["asset_id"], "hero-reference")
        self.assertEqual(assets[0]["size_bytes"], len(png))
        self.assertEqual(self.gateway.get_story_asset(self.workspace_id, "adventure", "adventure", "hero-reference")["content"], png)
        with self.assertRaises(ValidationError):
            self.command("bad-image", result["revision"], "add_story_asset", {
                "adventure_id": "adventure", "target_kind": "character", "target_id": "hero",
                "display_name": "fake.png", "mime_type": "image/png", "data_base64": base64.b64encode(b"not png").decode("ascii"),
            }, branch="adventure")

    def test_simulation_is_off_by_default_and_completed_turns_are_counted(self):
        state = self.gateway.get_rpg_state(self.workspace_id, "adventure", "adventure")
        self.assertFalse(state["adventure"]["npc_simulation_enabled"])
        enabled = self.command("enable-simulation", self.revision, "set_npc_simulation", {
            "adventure_id": "adventure", "enabled": True,
        }, branch="adventure")
        turn = self.append_turn("count-turn", enabled["revision"], "Look around", "The docks are quiet.")
        state = self.gateway.get_rpg_state(self.workspace_id, "adventure", "adventure")
        self.assertEqual(state["adventure"]["completed_turns"], 1)
        self.assertTrue(state["adventure"]["npc_simulation_enabled"])
        self.assertGreater(turn["revision"], enabled["revision"])


if __name__ == "__main__":
    unittest.main()
