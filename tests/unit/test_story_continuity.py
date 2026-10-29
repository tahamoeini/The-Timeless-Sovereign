"""Continuity, NPC, map, and local image behavior for world-based stories."""

import base64
import io
import unittest

from PIL import Image

from lke.core import CommandGateway, ConflictError, Database, ValidationError


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

    def test_editing_any_turn_supersedes_all_later_turns_from_canonical_order(self):
        first = self.append_turn("ordered-one", self.revision, "Enter the hall", "A torch burns.", order=1)
        second = self.append_turn("ordered-two", first["revision"], "Open the door", "Footsteps echo.", order=2)
        third = self.append_turn("ordered-three", second["revision"], "Call out", "Someone answers.", order=3)
        turns = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")["turns"]
        target = turns[3]
        changed = self.command("edit-middle-assistant", third["revision"], "edit_story_turn", {
            "conversation_id": "conversation", "turn_id": target["turn_id"],
            "action": "edit", "content": "The corridor is empty.",
        }, branch="adventure")
        revised = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")["turns"]
        self.assertEqual([turn["status"] for turn in revised], ["active", "active", "active", "active", "superseded", "superseded"])
        self.assertEqual(revised[3]["content"], "The corridor is empty.")
        self.assertEqual(changed["superseded_count"], 2)

    def test_source_changes_prevent_proposal_acceptance_but_allow_rejection(self):
        revision = self.revision
        for action in ("edit", "delete", "supersede"):
            with self.subTest(action=action):
                turn = self.append_turn(f"source-{action}", revision, "Look around", "A door opens.")
                turns = self.gateway.get_conversation(self.workspace_id, "adventure", "conversation")["turns"]
                user_id, assistant_id = turns[-2]["turn_id"], turns[-1]["turn_id"]
                proposal = self.command(f"proposal-{action}", turn["revision"], "propose_rpg_state", {
                    "adventure_id": "adventure", "source_turn_id": assistant_id,
                    "changes": [{"operation": "tracker_delta", "tracker_id": "health", "delta": -1}],
                }, branch="adventure", actor="ai:local")
                payload = {"conversation_id": "conversation", "turn_id": assistant_id,
                           "action": "delete" if action == "delete" else "edit", "content": "The door stays shut."}
                if action == "supersede":
                    payload.update(turn_id=user_id, content="Wait outside.", superseded_turn_ids=[assistant_id])
                edited = self.command(f"change-{action}", proposal["revision"], "edit_story_turn", payload, branch="adventure")
                with self.assertRaisesRegex(ConflictError, "source turn changed"):
                    self.command(f"accept-{action}", edited["revision"], "review_rpg_state_proposal", {
                        "proposal_id": proposal["proposal_id"], "review_status": "accepted",
                    }, branch="adventure")
                state = self.gateway.get_rpg_state(self.workspace_id, "adventure", "adventure")
                self.assertEqual(state["sheet"]["trackers"]["health"]["value"], 8)
                self.assertEqual(self.gateway.current_revision(self.workspace_id, "adventure"), edited["revision"])
                rejected = self.command(f"reject-{action}", edited["revision"], "review_rpg_state_proposal", {
                    "proposal_id": proposal["proposal_id"], "review_status": "rejected",
                }, branch="adventure")
                revision = rejected["revision"]
                if action != "edit":
                    with self.assertRaisesRegex(ValidationError, "active assistant"):
                        self.command(f"inactive-{action}", revision, "propose_rpg_state", {
                            "adventure_id": "adventure", "source_turn_id": assistant_id,
                            "changes": [{"operation": "set_location", "location": "Elsewhere"}],
                        }, branch="adventure")

    def test_historical_turn_edit_rebuilds_rpg_state_and_keeps_manual_changes(self):
        turn = self.append_turn(
            "historical-battle", self.revision,
            "Defend the northern pass", "The ruler falls in battle.",
        )
        assistant_id = turn["assistant_turn_id"]
        proposal = self.command("battle-state", turn["revision"], "propose_rpg_state", {
            "adventure_id": "adventure", "source_turn_id": assistant_id,
            "changes": [{"operation": "tracker_delta", "tracker_id": "health", "delta": -4}],
        }, branch="adventure", actor="ai:local")
        accepted = self.command("accept-battle-state", proposal["revision"], "review_rpg_state_proposal", {
            "proposal_id": proposal["proposal_id"], "review_status": "accepted",
        }, branch="adventure")
        manual = self.command("manual-stat", accepted["revision"], "update_rpg_sheet", {
            "adventure_id": "adventure", "stats": {"might": 7},
        }, branch="adventure")
        preview = self.gateway.preview_story_turn_edit(
            self.workspace_id, "adventure", "adventure", "conversation", assistant_id,
        )
        self.assertEqual(preview["turns_to_replace_or_hide"], 1)
        self.assertEqual(preview["before"]["trackers"]["health"]["value"], 4)
        self.assertEqual(preview["after"]["trackers"]["health"]["value"], 8)
        self.assertEqual(len(preview["invalidated_proposals"]), 1)
        self.assertEqual(self.gateway.current_revision(self.workspace_id, "adventure"), manual["revision"])
        edited = self.command("rewrite-battle", manual["revision"], "edit_story_turn", {
            "conversation_id": "conversation", "turn_id": assistant_id,
            "action": "edit", "content": "The ruler survives and rallies the defenders.",
        }, branch="adventure")

        state = self.gateway.get_rpg_state(self.workspace_id, "adventure", "adventure")
        self.assertEqual(state["sheet"]["trackers"]["health"]["value"], 8)
        self.assertEqual(state["sheet"]["stats"]["might"], 7)
        reconstruction = edited["state_reconstruction"]
        self.assertTrue(reconstruction["reconstructed"])
        self.assertIn("trackers", reconstruction["changed_fields"])
        self.assertEqual(
            [item["proposal_id"] for item in reconstruction["invalidated_proposals"]],
            [proposal["proposal_id"]],
        )

    def test_historical_turn_edit_reconstructs_npc_profiles_from_valid_changes(self):
        npc = self.command("create-ferryman", self.revision, "create_story_npc", {
            "adventure_id": "adventure", "npc_entity_id": "ferryman", "label": "The Ferryman",
            "aliases": ["Boatman"],
            "public_profile": {"motivation": "Protect the harbor", "current_goal": "Guard the old ferry"},
            "private_profile": {}, "review_status": "accepted",
        }, branch="adventure")
        turn = self.append_turn(
            "ferryman-battle", npc["revision"], "Defend the ferry", "The ferryman is killed.",
        )
        proposal = self.command("ferryman-death", turn["revision"], "propose_rpg_state", {
            "adventure_id": "adventure", "source_turn_id": turn["assistant_turn_id"],
            "changes": [{
                "operation": "npc_profile", "npc_entity_id": "ferryman",
                "updates": {"current_goal": "Bury the fallen at the ferry"},
            }],
        }, branch="adventure", actor="ai:local")
        accepted = self.command("accept-ferryman-death", proposal["revision"], "review_rpg_state_proposal", {
            "proposal_id": proposal["proposal_id"], "review_status": "accepted",
        }, branch="adventure")
        self.assertEqual(
            self.gateway.list_story_npcs(self.workspace_id, "adventure", "adventure")[0]["public_profile"]["current_goal"],
            "Bury the fallen at the ferry",
        )

        edited = self.command("rewrite-ferryman-battle", accepted["revision"], "edit_story_turn", {
            "conversation_id": "conversation", "turn_id": turn["assistant_turn_id"],
            "action": "edit", "content": "The ferryman escapes the fight with a wound.",
        }, branch="adventure")
        current_npc = self.gateway.list_story_npcs(self.workspace_id, "adventure", "adventure")[0]
        self.assertEqual(current_npc["public_profile"]["current_goal"], "Guard the old ferry")
        self.assertIn("npc_profiles", edited["state_reconstruction"]["changed_fields"])
        self.assertEqual(edited["state_reconstruction"]["changed_npc_profiles"], ["ferryman"])

    def test_historical_reconstruction_is_branch_local_after_a_fork(self):
        turn = self.append_turn(
            "forked-battle", self.revision, "Hold the pass", "The guard captain falls.",
        )
        proposal = self.command("forked-state", turn["revision"], "propose_rpg_state", {
            "adventure_id": "adventure", "source_turn_id": turn["assistant_turn_id"],
            "changes": [{"operation": "tracker_delta", "tracker_id": "health", "delta": -3}],
        }, branch="adventure", actor="ai:local")
        accepted = self.command("accept-forked-state", proposal["revision"], "review_rpg_state_proposal", {
            "proposal_id": proposal["proposal_id"], "review_status": "accepted",
        }, branch="adventure")
        self.gateway.create_branch(
            self.workspace_id, "adventure", "alternate", accepted["revision"], "fork-alternate",
        )
        self.command("rewrite-alternate-battle", accepted["revision"], "edit_story_turn", {
            "conversation_id": "conversation", "turn_id": turn["assistant_turn_id"],
            "action": "edit", "content": "The guard captain survives the battle.",
        }, branch="alternate")

        parent_state = self.gateway.get_rpg_state(self.workspace_id, "adventure", "adventure")
        alternate_state = self.gateway.get_rpg_state(self.workspace_id, "alternate", "adventure")
        self.assertEqual(parent_state["sheet"]["trackers"]["health"]["value"], 5)
        self.assertEqual(alternate_state["sheet"]["trackers"]["health"]["value"], 8)

    def test_memory_review_rejects_a_changed_source_without_losing_proposal(self):
        turn = self.append_turn("memory-source-review", self.revision, "Listen", "A bell rings once.")
        proposed = self.command("propose-memory-review", turn["revision"], "create_story_memory", {
            "adventure_id": "adventure", "memory_id": "bell-memory", "kind": "event",
            "content": "A bell rings once.", "source_turn_id": turn["assistant_turn_id"], "review_status": "proposed",
        }, branch="adventure")
        edited = self.command("edit-memory-source", proposed["revision"], "edit_story_turn", {
            "conversation_id": "conversation", "turn_id": turn["assistant_turn_id"],
            "action": "edit", "content": "No bell is heard.",
        }, branch="adventure")
        with self.assertRaisesRegex(ConflictError, "source turn changed"):
            self.command("accept-stale-memory", edited["revision"], "review_story_memory", {
                "adventure_id": "adventure", "memory_id": "bell-memory", "version": 1, "review_status": "accepted",
            }, branch="adventure")
        memory = self.gateway.get_story_memories(self.workspace_id, "adventure", "adventure")["memories"][0]
        self.assertEqual(memory["review_status"], "proposed")
        self.assertEqual(self.gateway.current_revision(self.workspace_id, "adventure"), edited["revision"])
        self.command("reject-stale-memory", edited["revision"], "review_story_memory", {
            "adventure_id": "adventure", "memory_id": "bell-memory", "version": 1, "review_status": "rejected",
        }, branch="adventure")

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

    def test_adventure_turns_create_sourced_reviewable_memories_and_retries_refresh_them(self):
        turn = self.append_turn("automatic-memory", self.revision, "Look ahead", "A lantern glows above the ferry bell.")
        memory_state = self.gateway.get_story_memories(self.workspace_id, "adventure", "adventure")
        original = next(item for item in memory_state["memories"] if item["source_turn_id"] == turn["assistant_turn_id"])
        self.assertEqual(original["kind"], "event")
        self.assertEqual(original["review_status"], "proposed")
        self.assertEqual(original["knowledge_scope"], "actors")
        self.assertEqual(original["known_by"], ["hero"])
        self.assertIn("lantern glows", original["content"])

        edited = self.command("retry-automatic-memory", turn["revision"], "edit_story_turn", {
            "conversation_id": "conversation", "turn_id": turn["assistant_turn_id"], "action": "edit",
            "content": "A dark window faces the road.", "provider": "ollama", "model": "local-test",
            "context_manifest_id": "retry-auto-manifest",
            "context_manifest": {"manifest_id": "retry-auto-manifest", "base_revision": turn["revision"],
                                 "workspace_id": self.workspace_id, "branch_id": "adventure",
                                 "actor": {"entity_id": "hero"}, "included": [], "excluded": []},
            "context_revision": turn["revision"],
        }, branch="adventure")
        memory_state = self.gateway.get_story_memories(self.workspace_id, "adventure", "adventure")
        revised = [item for item in memory_state["memories"] if item["source_turn_id"] == turn["assistant_turn_id"]]
        self.assertEqual(len(revised), 2)
        latest = max(revised, key=lambda item: item["created_revision"])
        self.assertEqual(latest["review_status"], "proposed")
        self.assertIn("dark window", latest["content"])
        self.assertEqual(edited["revision"], turn["revision"] + 1)

    def test_actor_scoped_memory_revisions_preserve_importance_and_knowledge_holders(self):
        created = self.command("scoped-memory", self.revision, "create_story_memory", {
            "adventure_id": "adventure", "memory_id": "hero-secret", "kind": "event",
            "content": "Mira alone saw the silver key beneath the ferry bell.",
            "importance": 5, "knowledge_scope": "actors", "known_by": ["hero"],
            "context_enabled": True, "review_status": "accepted",
        }, branch="adventure")
        revised = self.command("disable-scoped-memory", created["revision"], "revise_story_memory", {
            "adventure_id": "adventure", "memory_id": "hero-secret", "expected_version": 1,
            "kind": "event", "content": "Mira alone saw the silver key beneath the ferry bell.",
            "context_enabled": False, "review_status": "accepted",
        }, branch="adventure")
        latest = next(
            item for item in self.gateway.get_story_memories(self.workspace_id, "adventure", "adventure")["memories"]
            if item["memory_id"] == "hero-secret"
        )
        self.assertEqual(latest["version"], 2)
        self.assertFalse(latest["context_enabled"])
        self.assertEqual(latest["importance"], 5)
        self.assertEqual(latest["knowledge_scope"], "actors")
        self.assertEqual(latest["known_by"], ["hero"])
        self.assertGreater(revised["revision"], created["revision"])

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
        self.assertEqual(locations[0]["effective_status"], "approved")
        self.command("rewrite-map-turn", self.gateway.current_revision(self.workspace_id, "adventure"),
                     "edit_story_turn", {
            "conversation_id": "conversation", "turn_id": conversation["turns"][-1]["turn_id"],
            "action": "edit", "content": "The coast is empty.",
        }, branch="adventure")
        locations = self.gateway.list_story_locations(self.workspace_id, "adventure", "adventure")
        self.assertEqual(locations[0]["status"], "approved")
        self.assertEqual(locations[0]["effective_status"], "superseded")
        self.assertEqual(self.gateway.get_rpg_state(self.workspace_id, "adventure", "adventure")["sheet"]["current_location"], "Old Harbor")
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
        revision = self.revision
        images = {}
        for image_format, mime_type, extension in (
            ("PNG", "image/png", "png"),
            ("JPEG", "image/jpeg", "jpg"),
            ("WEBP", "image/webp", "webp"),
        ):
            stream = io.BytesIO()
            Image.new("RGB", (3, 2), (24, 64, 128)).save(stream, format=image_format)
            images[mime_type] = stream.getvalue()
            result = self.command(f"image-{extension}", revision, "add_story_asset", {
                "adventure_id": "adventure", "asset_id": f"hero-reference-{extension}", "target_kind": "character",
                "target_id": "hero", "display_name": f"Mira reference.{extension}", "mime_type": mime_type,
                "data_base64": base64.b64encode(images[mime_type]).decode("ascii"), "provenance": {"origin": "user_upload"},
            }, branch="adventure")
            revision = result["revision"]
        assets = self.gateway.list_story_assets(self.workspace_id, "adventure", "adventure")
        self.assertEqual({asset["mime_type"] for asset in assets}, set(images))
        for asset in assets:
            content = self.gateway.get_story_asset(
                self.workspace_id, "adventure", "adventure", asset["asset_id"],
            )["content"]
            self.assertEqual(asset["size_bytes"], len(content))
            self.assertEqual(content, images[asset["mime_type"]])
        with self.assertRaisesRegex(ValidationError, "decodable"):
            self.command("truncated-image", revision, "add_story_asset", {
                "adventure_id": "adventure", "target_kind": "character", "target_id": "hero",
                "display_name": "truncated.png", "mime_type": "image/png",
                "data_base64": base64.b64encode(images["image/png"][:24]).decode("ascii"),
            }, branch="adventure")
        with self.assertRaisesRegex(ValidationError, "declared file type"):
            self.command("mismatched-image", revision, "add_story_asset", {
                "adventure_id": "adventure", "target_kind": "character", "target_id": "hero",
                "display_name": "mislabelled.png", "mime_type": "image/png",
                "data_base64": base64.b64encode(images["image/jpeg"]).decode("ascii"),
            }, branch="adventure")
        animated = io.BytesIO()
        frames = [Image.new("RGB", (2, 2), color) for color in ((0, 0, 0), (255, 255, 255))]
        frames[0].save(animated, format="WEBP", save_all=True, append_images=frames[1:])
        with self.assertRaisesRegex(ValidationError, "Animated"):
            self.command("animated-image", revision, "add_story_asset", {
                "adventure_id": "adventure", "target_kind": "character", "target_id": "hero",
                "display_name": "animated.webp", "mime_type": "image/webp",
                "data_base64": base64.b64encode(animated.getvalue()).decode("ascii"),
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
