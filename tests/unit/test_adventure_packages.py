"""End-to-end package checks for isolated Story Studio adventures."""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import io
import json
import unittest
from unittest.mock import patch

import httpx
from PIL import Image

import lke.core.commands as command_module
from lke.api.app import create_app
from lke.core import CommandGateway, Database


class AdventurePackageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.gateway.create_workspace("Source", "source")
        self.gateway.create_workspace("Destination", "destination")
        self.gateway.create_workspace("Atomic import", "atomic")
        self._create_source_adventure()
        self.app = create_app(self.database, auth_token="test-token")
        self.headers = {"Authorization": "Bearer test-token"}

    def tearDown(self) -> None:
        self.database.close()

    def command(self, workspace: str, branch: str, key: str, kind: str, payload: dict):
        return self.gateway.execute(
            workspace_id=workspace,
            branch_id=branch,
            expected_revision=self.gateway.current_revision(workspace, branch),
            idempotency_key=key,
            command_type=kind,
            payload=payload,
            actor="user",
            reason="Adventure package test",
        )

    def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        async def send() -> httpx.Response:
            transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 8000))
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.request(method, path, **kwargs)

        return asyncio.run(send())

    def _create_source_adventure(self) -> None:
        self.command("source", "main", "hero", "create_entity", {
            "entity_id": "hero", "entity_type": "character", "label": "Mira", "properties": {},
        })
        self.command("source", "main", "world", "create_story_world", {
            "world_id": "harbor", "name": "The Harbor", "template_key": "fantasy",
            "content": {
                "starting_location": "Old Harbor", "stats": {"might": 2},
                "trackers": {"health": {"value": 8, "max": 10}},
                "public_lore": "A town at the edge of a cold sea.",
                "author_notes": "The lighthouse keeper is secretly the duke.",
                "mno_source": {"raw_author_secret": "Only the GM should know."},
            },
        })
        revision = self.gateway.current_revision("source", "main")
        self.gateway.create_branch("source", "main", "source-adventure", revision, "source-branch")
        self.command("source", "source-adventure", "adventure", "create_story_adventure", {
            "adventure_id": "source-adventure", "world_id": "harbor", "world_version": 1,
            "conversation_id": "conversation", "name": "Fog on the Coast", "actor_entity_id": "hero",
        })
        self.command("source", "source-adventure", "npc", "create_entity", {
            "entity_id": "ferryman", "entity_type": "character", "label": "The Ferryman", "properties": {},
        })
        self.command("source", "source-adventure", "npc-profile", "update_story_npc", {
            "adventure_id": "source-adventure", "npc_entity_id": "ferryman", "aliases": ["Boatman"],
            "public_profile": {
                "appearance": "A gray coat", "current_goal": "Guard the old ferry",
                "relationship_to_actor": "Cautiously trusts Mira after the storm",
            },
            "private_profile": {"notes": "Knows the captain's secret."}, "review_status": "accepted",
        })
        revision = self.gateway.current_revision("source", "source-adventure")
        manifest = {
            "manifest_id": "private-manifest", "base_revision": revision,
            "workspace_id": "source", "branch_id": "source-adventure",
            "actor": {"entity_id": "hero"}, "included": [], "excluded": [],
        }
        turn = self.gateway.execute(
            workspace_id="source", branch_id="source-adventure", expected_revision=revision,
            idempotency_key="source-turn", command_type="append_story_turn",
            payload={
                "conversation_id": "conversation", "user_content": "Ask about the ferry.",
                "assistant_content": "The ferryman looks away from Mira.", "provider": "ollama",
                "model": "local-test", "narrative_order": 1, "context_revision": revision,
                "context_manifest_id": manifest["manifest_id"], "context_manifest": manifest,
            }, actor="user", reason="Adventure package test",
        )
        self.turn_id = turn["assistant_turn_id"]
        self.command("source", "source-adventure", "check", "record_d20_check", {
            "adventure_id": "source-adventure", "check_id": "ferry-check", "stat_name": "might",
            "die_roll": 12, "target": 10,
        })
        self.command("source", "source-adventure", "note", "create_story_memory", {
            "adventure_id": "source-adventure", "memory_id": "promise", "kind": "note",
            "content": "Mira promised to return before dawn.", "context_enabled": True,
            "knowledge_scope": "actors", "known_by": ["hero"], "review_status": "accepted",
        })
        self.command("source", "source-adventure", "thread", "save_story_thread", {
            "adventure_id": "source-adventure", "thread_id": "missing-sailor",
            "title": "The missing sailor", "detail": "No one has seen him since the storm.",
        })
        image = io.BytesIO()
        Image.new("RGB", (2, 2), (15, 70, 100)).save(image, format="PNG")
        self.image_bytes = image.getvalue()
        self.command("source", "source-adventure", "image", "add_story_asset", {
            "adventure_id": "source-adventure", "asset_id": "scene-image", "target_kind": "scene",
            "target_id": self.turn_id, "display_name": "Ferry scene.png", "mime_type": "image/png",
            "data_base64": base64.b64encode(self.image_bytes).decode("ascii"),
            "provenance": {"origin": "user_upload"},
        })
        proposal = self.command("source", "source-adventure", "location-proposal", "propose_rpg_state", {
            "adventure_id": "source-adventure", "source_turn_id": self.turn_id,
            "changes": [{"operation": "set_location", "location": "Smuggler's Cove"}],
        })
        self.command("source", "source-adventure", "accept-location", "review_rpg_state_proposal", {
            "proposal_id": proposal["proposal_id"], "review_status": "accepted",
        })

    def test_api_round_trip_preserves_adventure_and_excludes_private_manifests(self) -> None:
        exported = self.request(
            "GET",
            "/api/v1/workspaces/source/story/adventures/source-adventure/package?branch_id=source-adventure&export_mode=full_private_archive&confirm_private=true",
            headers=self.headers,
        )
        self.assertEqual(exported.status_code, 200, exported.text)
        package = exported.json()
        self.assertEqual(package["protocol"], "lke.adventure.v2")
        self.assertEqual(package["manifest"]["algorithm"], "sha256")
        self.assertEqual(package["manifest"]["assets"][0]["size_bytes"], len(self.image_bytes))
        self.assertFalse(package["context_manifests_included"])
        self.assertNotIn("context_manifest_id", json.dumps(package))
        self.assertNotIn("context_manifest_json", json.dumps(package))

        self.command("destination", "main", "conflicting-hero", "create_entity", {
            "entity_id": "hero", "entity_type": "character", "label": "Another Mira", "properties": {},
        })
        main_revision = self.gateway.current_revision("destination", "main")
        invalid = copy.deepcopy(package)
        invalid["adventure"]["assets"][0]["data_base64"] = base64.b64encode(self.image_bytes[:24]).decode("ascii")
        rejected = self.request(
            "POST", "/api/v1/workspaces/destination/story/adventures/package-preview",
            headers=self.headers, json=invalid,
        )
        self.assertEqual(rejected.status_code, 422, rejected.text)
        self.assertEqual(self.gateway.current_revision("destination", "main"), main_revision)
        self.assertEqual(self.gateway.list_story_worlds("destination"), [])

        preview = self.request(
            "POST", "/api/v1/workspaces/destination/story/adventures/package-preview",
            headers=self.headers, json=package,
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertTrue(preview.json()["world_import_required"])
        self.assertEqual([item["entity_id"] for item in preview.json()["entity_id_conflicts"]], ["hero"])

        legacy = copy.deepcopy(package)
        legacy["protocol"] = "lke.adventure.v1"
        legacy.pop("manifest")
        legacy["world"]["protocol"] = "lke.world.v1"
        legacy["world"].pop("manifest")
        legacy_preview = self.request(
            "POST", "/api/v1/workspaces/destination/story/adventures/package-preview",
            headers=self.headers, json=legacy,
        )
        self.assertEqual(legacy_preview.status_code, 200, legacy_preview.text)
        self.assertEqual(legacy_preview.json()["protocol"], "lke.adventure.v2")

        changed_asset = copy.deepcopy(package)
        another_image = io.BytesIO()
        Image.new("RGB", (2, 2), (220, 30, 40)).save(another_image, format="PNG")
        changed_asset["adventure"]["assets"][0]["data_base64"] = base64.b64encode(another_image.getvalue()).decode("ascii")
        payload = {key: value for key, value in changed_asset.items() if key != "manifest"}
        changed_asset["manifest"]["payload_sha256"] = hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        ).hexdigest()
        asset_rejected = self.request(
            "POST", "/api/v1/workspaces/destination/story/adventures/package-preview",
            headers=self.headers, json=changed_asset,
        )
        self.assertEqual(asset_rejected.status_code, 422, asset_rejected.text)
        self.assertIn("asset checksums", asset_rejected.text)

        imported = self.request(
            "POST", "/api/v1/workspaces/destination/story/adventures/package-import",
            headers=self.headers,
            json={
                "expected_revision": main_revision,
                "idempotency_key": "adventure-package-import",
                "adventure_id": "imported-adventure",
                "name": "Fog on the Coast (copy)",
                "package": package,
            },
        )
        self.assertEqual(imported.status_code, 200, imported.text)
        body = imported.json()
        self.assertTrue(body["world_imported"])
        self.assertNotEqual(body["entity_id_map"]["hero"], "hero")
        state = self.gateway.get_rpg_state("destination", "imported-adventure", "imported-adventure")
        self.assertEqual(state["adventure"]["world_version"], 1)
        self.assertEqual(body["adventure"]["name"], "Fog on the Coast (copy)")
        self.assertEqual(state["sheet"]["current_location"], "Smuggler's Cove")
        self.assertEqual(state["checks"][0]["total"], 14)

        studio = self.gateway.get_story_memories("destination", "imported-adventure", "imported-adventure")
        imported_note = next(item for item in studio["memories"] if item["memory_id"] == "promise")
        self.assertEqual(imported_note["known_by"], [body["entity_id_map"]["hero"]])
        self.assertEqual(studio["threads"][0]["thread_id"], "missing-sailor")
        npc = self.gateway.list_story_npcs("destination", "imported-adventure", "imported-adventure")[0]
        self.assertEqual(npc["public_profile"]["current_goal"], "Guard the old ferry")
        self.assertEqual(
            npc["public_profile"]["relationship_to_actor"],
            "Cautiously trusts Mira after the storm",
        )
        asset = self.gateway.list_story_assets("destination", "imported-adventure", "imported-adventure")[0]
        self.assertEqual(asset["target_id"], self.turn_id)
        self.assertEqual(
            self.gateway.get_story_asset("destination", "imported-adventure", "imported-adventure", "scene-image")["content"],
            self.image_bytes,
        )
        conversation = self.gateway.get_conversation(
            "destination", "imported-adventure", body["adventure"]["conversation_id"],
        )
        self.assertEqual(conversation["title"], "Fog on the Coast (copy)")
        self.assertEqual(len(conversation["turns"]), 2)
        self.assertEqual(conversation["turns"][1]["content"], "The ferryman looks away from Mira.")
        manifest_count = self.database.connection.execute(
            "SELECT COUNT(*) FROM story_turns WHERE workspace_id='destination' AND branch_id='imported-adventure' AND context_manifest_json IS NOT NULL"
        ).fetchone()[0]
        self.assertEqual(manifest_count, 0)
        main_hero = self.database.connection.execute(
            "SELECT label FROM entities WHERE workspace_id='destination' AND branch_id='main' AND entity_id='hero'"
        ).fetchone()
        self.assertEqual(main_hero["label"], "Another Mira")

    def test_export_modes_preview_private_data_and_keep_packages_importable(self) -> None:
        base = "/api/v1/workspaces/source/story/adventures/source-adventure"
        preview = self.request(
            "GET", f"{base}/package-preview?branch_id=source-adventure&export_mode=full_private_archive",
            headers=self.headers,
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        report = preview.json()
        self.assertTrue(report["requires_private_confirmation"])
        self.assertEqual(report["sensitive"]["private_npc_profiles"], 1)

        denied = self.request(
            "GET", f"{base}/package?branch_id=source-adventure&export_mode=full_private_archive",
            headers=self.headers,
        )
        self.assertEqual(denied.status_code, 422, denied.text)

        shared = self.request("GET", f"{base}/package?branch_id=source-adventure", headers=self.headers)
        self.assertEqual(shared.status_code, 200, shared.text)
        shared_package = shared.json()
        self.assertNotIn("captain's secret", json.dumps(shared_package))
        self.assertIsNone(shared_package["adventure"]["source_archive"])
        self.assertEqual(shared_package["adventure"]["npcs"][0]["private_profile"], {})
        self.assertEqual(shared_package["adventure"]["threads"], [])
        check_shared = self.request(
            "POST", "/api/v1/workspaces/destination/story/adventures/package-preview",
            headers=self.headers, json=shared_package,
        )
        self.assertEqual(check_shared.status_code, 200, check_shared.text)
        self.assertTrue(check_shared.json()["world_import_required"])

        public_world = self.request(
            "POST", f"{base}/package-export", headers=self.headers,
            json={"branch_id": "source-adventure", "export_mode": "public_world"},
        )
        self.assertEqual(public_world.status_code, 200, public_world.text)
        world_package = public_world.json()
        self.assertEqual(world_package["protocol"], "lke.world.v2")
        self.assertNotIn("mno_source", json.dumps(world_package))
        self.assertNotIn("author_notes", json.dumps(world_package))

        full = self.request(
            "GET", f"{base}/package?branch_id=source-adventure&export_mode=full_private_archive&confirm_private=true",
            headers=self.headers,
        )
        self.assertEqual(full.status_code, 200, full.text)
        self.assertIn("captain's secret", json.dumps(full.json()))

        selected = {"turn_ids": [self.turn_id]}
        selected_preview = self.request(
            "POST", f"{base}/package-export-preview", headers=self.headers,
            json={"branch_id": "source-adventure", "export_mode": "selected_content", "selection": selected},
        )
        self.assertEqual(selected_preview.status_code, 200, selected_preview.text)
        selected_export = self.request(
            "POST", f"{base}/package-export", headers=self.headers,
            json={"branch_id": "source-adventure", "export_mode": "selected_content", "selection": selected},
        )
        self.assertEqual(selected_export.status_code, 200, selected_export.text)
        selected_package = selected_export.json()
        self.assertEqual([turn["turn_id"] for turn in selected_package["adventure"]["turns"]], [self.turn_id])
        self.assertIsNone(selected_package["adventure"]["source_archive"])

    def test_adventure_bundle_import_rolls_back_every_stage_and_replays_after_commit(self) -> None:
        package = self.gateway.export_story_adventure_package(
            "source", "source-adventure", "source-adventure",
            export_mode="full_private_archive", confirm_private=True,
        )
        original_apply = self.gateway._apply

        def fail_after_world_write(*args, **kwargs):
            result = original_apply(*args, **kwargs)
            if args[4] == "import_story_world":
                raise RuntimeError("injected failure after world write")
            return result

        with patch.object(self.gateway, "_apply", side_effect=fail_after_world_write):
            with self.assertRaisesRegex(RuntimeError, "world write"):
                self.gateway.import_story_adventure_bundle(
                    workspace_id="atomic", expected_revision=0, idempotency_key="atomic-import",
                    adventure_id="atomic-adventure", package=package,
                )

        original_snapshot = command_module._snapshot_branch

        def fail_after_snapshot(*args, **kwargs):
            result = original_snapshot(*args, **kwargs)
            raise RuntimeError("injected failure after branch snapshot")

        with patch.object(command_module, "_snapshot_branch", side_effect=fail_after_snapshot):
            with self.assertRaisesRegex(RuntimeError, "branch snapshot"):
                self.gateway.import_story_adventure_bundle(
                    workspace_id="atomic", expected_revision=0, idempotency_key="atomic-import",
                    adventure_id="atomic-adventure", package=package,
                )

        original_import = command_module._import_adventure_records

        def fail_after_adventure_write(*args, **kwargs):
            result = original_import(*args, **kwargs)
            raise RuntimeError("injected failure after adventure write")

        with patch.object(command_module, "_import_adventure_records", side_effect=fail_after_adventure_write):
            with self.assertRaisesRegex(RuntimeError, "adventure write"):
                self.gateway.import_story_adventure_bundle(
                    workspace_id="atomic", expected_revision=0, idempotency_key="atomic-import",
                    adventure_id="atomic-adventure", package=package,
                )

        self.assertEqual(self.gateway.current_revision("atomic", "main"), 0)
        self.assertEqual(self.gateway.list_story_worlds("atomic"), [])
        self.assertEqual(
            [item["branch_id"] for item in self.gateway.list_branches("atomic")], ["main"]
        )

        imported = self.gateway.import_story_adventure_bundle(
            workspace_id="atomic", expected_revision=0, idempotency_key="atomic-import",
            adventure_id="atomic-adventure", package=package,
        )
        replay = self.gateway.import_story_adventure_bundle(
            workspace_id="atomic", expected_revision=0, idempotency_key="atomic-import",
            adventure_id="atomic-adventure", package=package,
        )
        self.assertFalse(imported["idempotent_replay"])
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(imported["adventure_id"], replay["adventure_id"])
        self.assertEqual(self.gateway.current_revision("atomic", "main"), 1)
        self.assertEqual(self.gateway.current_revision("atomic", "atomic-adventure"), 2)


if __name__ == "__main__":
    unittest.main()
