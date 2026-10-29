"""End-to-end recovery checks for SQLite workspace backups."""

from __future__ import annotations

import json
import hashlib
import base64
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image

from lke.core import CommandGateway, Database
from lke.core.database import SCHEMA_VERSION
from lke.ops.backup import BackupError, create_backup, restore_backup, restore_backup_into_database


class BackupRestoreTests(unittest.TestCase):
    def test_restore_replaces_the_active_database_after_full_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            active = Database(root / "active.sqlite3")
            active_gateway = CommandGateway(active)
            active_gateway.create_workspace("Old workspace", "old-workspace")

            source = Database(root / "source.sqlite3")
            source_gateway = CommandGateway(source)
            source_gateway.create_workspace("Restored workspace", "restored-workspace")
            source_gateway.execute(
                workspace_id="restored-workspace", idempotency_key="restored-entity", expected_revision=0,
                command_type="create_entity",
                payload={"entity_id": "aria", "entity_type": "person", "label": "Aria"},
                reason="Create restored fixture",
            )
            backup_path = root / "restore.lkebackup"
            create_backup(source, backup_path)
            source.close()

            manifest = restore_backup_into_database(active, backup_path)

            self.assertEqual(manifest["schema_version"], SCHEMA_VERSION)
            self.assertEqual([item["workspace_id"] for item in active_gateway.list_workspaces()], ["restored-workspace"])
            self.assertEqual(active_gateway.list_entities("restored-workspace")[0]["label"], "Aria")
            self.assertEqual(active_gateway.current_revision("restored-workspace"), 1)
            active.close()

    def test_restore_preserves_sources_revisions_and_search(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original_path = root / "original.sqlite3"
            backup_path = root / "workspace.lkebackup"
            restored_path = root / "restored" / "knowledge.sqlite3"
            database = Database(original_path)
            gateway = CommandGateway(database)
            gateway.create_workspace("Recovery test", "recovery-test")
            entity = gateway.execute(
                workspace_id="recovery-test",
                idempotency_key="recovery-entity",
                expected_revision=0,
                command_type="create_entity",
                payload={"entity_id": "aria", "entity_type": "character", "label": "Aria", "properties": {}},
                reason="Create test character",
            )
            gateway.execute(
                workspace_id="recovery-test",
                idempotency_key="recovery-source",
                expected_revision=entity["revision"],
                command_type="import_source",
                payload={"source_id": "ledger", "display_name": "Ledger", "content": "Aria guards the brass key.", "media_type": "text/plain"},
                reason="Import recovery fixture",
            )
            turns = [{
                "turn_number": 1,
                "messages": [
                    {"role": "user", "content": "Continue the recovery test."},
                    {"role": "assistant", "content": "The archived transcript is preserved."},
                ],
            }]
            canonical_turns = json.dumps(turns, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            gateway.execute(
                workspace_id="recovery-test", idempotency_key="recovery-exchange", expected_revision=2,
                command_type="import_exchange",
                payload={
                    "protocol": "lke.exchange.v1", "workspace_id": "recovery-test", "branch_id": "main",
                    "base_revision": 2, "exchange_id": "recovery-exchange",
                    "transcript_id": "recovery-transcript", "transcript_total_turns": 1,
                    "context_manifest_id": "recovery-context",
                    "context_manifest": {
                        "protocol": "lke.context.v1", "manifest_id": "recovery-context",
                        "workspace_id": "recovery-test", "branch_id": "main", "base_revision": 2,
                        "actor": {}, "included": [], "excluded": [],
                    },
                    "transcript_range": {"from_turn": 1, "to_turn": 1},
                    "transcript_hash": "sha256:" + hashlib.sha256(canonical_turns.encode("utf-8")).hexdigest(),
                    "turns": turns, "proposed_change_ids": [],
                },
                reason="Import a transcript for recovery",
            )
            expected_entities = gateway.list_entities("recovery-test")
            expected_revisions = gateway.revisions("recovery-test")
            expected_exchanges = gateway.list_external_exchanges("recovery-test")

            manifest = create_backup(database, backup_path)
            database.close()
            restored_manifest = restore_backup(backup_path, restored_path)

            restored = Database(restored_path)
            restored_gateway = CommandGateway(restored)
            self.assertEqual(manifest, restored_manifest)
            self.assertEqual(restored_gateway.list_entities("recovery-test"), expected_entities)
            self.assertEqual(restored_gateway.list_sources("recovery-test")[0]["source_id"], "ledger")
            self.assertEqual(restored_gateway.search_sources("recovery-test", "brass key")[0]["source_id"], "ledger")
            self.assertEqual(restored_gateway.revisions("recovery-test"), expected_revisions)
            self.assertEqual(restored_gateway.list_external_exchanges("recovery-test"), expected_exchanges)
            restored.close()

    def test_story_and_rpg_records_survive_restore_to_a_separate_install_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original_path = root / "install-a" / "lorethra.sqlite3"
            backup_path = root / "transfer" / "campaign.lkebackup"
            restored_path = root / "install-b" / "lorethra.sqlite3"
            database = Database(original_path)
            gateway = CommandGateway(database)
            workspace_id = "campaign-recovery"
            gateway.create_workspace("Campaign recovery", workspace_id)

            def command(key: str, branch: str, command_type: str, payload: dict, *, actor: str = "user") -> dict:
                return gateway.execute(
                    workspace_id=workspace_id, branch_id=branch,
                    expected_revision=gateway.current_revision(workspace_id, branch),
                    idempotency_key=key, command_type=command_type, payload=payload,
                    actor=actor, reason="Build a complete RPG backup fixture",
                )

            command("create-hero", "main", "create_entity", {
                "entity_id": "hero", "entity_type": "character", "label": "Mira", "properties": {},
            })
            command("create-world", "main", "create_story_world", {
                "world_id": "harbor", "name": "The Harbor", "template_key": "fantasy",
                "description": "A port beneath a cold cliff.",
                "content": {
                    "starting_location": "Old Harbor", "locations": ["Old Harbor", "Cliff Road"],
                    "stats": {"might": 2}, "trackers": {"health": {"value": 8, "max": 10}},
                    "public_lore": "The harbor bell marks the tide.",
                },
            })
            parent_revision = gateway.current_revision(workspace_id, "main")
            gateway.create_branch(workspace_id, "main", "campaign", parent_revision, "campaign-snapshot")
            command("start-adventure", "campaign", "create_story_adventure", {
                "adventure_id": "campaign", "world_id": "harbor", "world_version": 1,
                "conversation_id": "campaign-chat", "name": "The Harbor Bell", "actor_entity_id": "hero",
            })
            base_revision = gateway.current_revision(workspace_id, "campaign")
            manifest = {
                "protocol": "lke.context.v1", "manifest_id": "campaign-context",
                "workspace_id": workspace_id, "branch_id": "campaign", "base_revision": base_revision,
                "actor": {"entity_id": "hero", "label": "Mira", "entity_type": "character"},
                "as_of_narrative_order": 1, "included": [], "excluded": [], "token_estimate": 1,
            }
            turn = command("story-turn", "campaign", "append_story_turn", {
                "conversation_id": "campaign-chat", "user_content": "Climb toward the bell.",
                "assistant_content": "The bell rings once above the fog.", "provider": "ollama",
                "model": "local-test", "narrative_order": 1,
                "context_manifest_id": manifest["manifest_id"], "context_manifest": manifest,
                "context_revision": base_revision,
            })
            command("record-check", "campaign", "record_d20_check", {
                "adventure_id": "campaign", "stat_name": "might", "die_roll": 13, "target": 14,
                "check_id": "harbor-climb",
            })
            command("create-npc", "campaign", "create_story_npc", {
                "adventure_id": "campaign", "npc_entity_id": "ferryman", "label": "The Ferryman",
                "aliases": ["Boatman"], "public_profile": {"appearance": "A gray coat"},
                "private_profile": {"notes": "Keeps a brass token hidden."}, "review_status": "accepted",
            })
            command("create-memory", "campaign", "create_story_memory", {
                "adventure_id": "campaign", "memory_id": "bell-memory", "kind": "event",
                "content": "The harbor bell rang once above the fog.", "context_enabled": True,
                "source_turn_id": turn["assistant_turn_id"], "review_status": "accepted",
                "knowledge_scope": "shared",
            })
            command("save-thread", "campaign", "save_story_thread", {
                "adventure_id": "campaign", "thread_id": "missing-token", "title": "The brass token",
                "detail": "The ferryman keeps a token hidden.",
            })
            proposal = command("propose-state", "campaign", "propose_rpg_state", {
                "adventure_id": "campaign", "source_turn_id": turn["assistant_turn_id"],
                "changes": [
                    {"operation": "tracker_delta", "tracker_id": "health", "delta": -1},
                    {"operation": "set_location", "location": "Cliff Road"},
                    {"operation": "npc_profile", "npc_entity_id": "ferryman", "updates": {"current_goal": "Find the token"}},
                ],
            }, actor="ai:local")
            command("accept-state", "campaign", "review_rpg_state_proposal", {
                "proposal_id": proposal["proposal_id"], "review_status": "accepted",
            })
            image = io.BytesIO()
            Image.new("RGB", (3, 2), (30, 70, 120)).save(image, format="PNG")
            image_bytes = image.getvalue()
            command("add-art", "campaign", "add_story_asset", {
                "adventure_id": "campaign", "asset_id": "harbor-reference", "target_kind": "scene",
                "target_id": turn["assistant_turn_id"], "display_name": "Harbor reference.png",
                "mime_type": "image/png", "data_base64": base64.b64encode(image_bytes).decode("ascii"),
                "provenance": {"origin": "user_upload"},
            })

            expected = {
                "world": gateway.get_story_world(workspace_id, "harbor"),
                "adventures": gateway.list_story_adventures(workspace_id, "campaign"),
                "conversation": gateway.get_conversation(workspace_id, "campaign", "campaign-chat"),
                "rpg": gateway.get_rpg_state(workspace_id, "campaign", "campaign"),
                "memories": gateway.get_story_memories(workspace_id, "campaign", "campaign"),
                "npcs": gateway.list_story_npcs(workspace_id, "campaign", "campaign"),
                "locations": gateway.list_story_locations(workspace_id, "campaign", "campaign"),
                "assets": gateway.list_story_assets(workspace_id, "campaign", "campaign"),
                "asset_content": gateway.get_story_asset(workspace_id, "campaign", "campaign", "harbor-reference")["content"],
                "revisions": gateway.revisions(workspace_id, "campaign"),
                "revision": gateway.current_revision(workspace_id, "campaign"),
            }
            backup_manifest = create_backup(database, backup_path)
            database.close()

            restored_manifest = restore_backup(backup_path, restored_path)
            restored = Database(restored_path)
            restored_gateway = CommandGateway(restored)
            actual = {
                "world": restored_gateway.get_story_world(workspace_id, "harbor"),
                "adventures": restored_gateway.list_story_adventures(workspace_id, "campaign"),
                "conversation": restored_gateway.get_conversation(workspace_id, "campaign", "campaign-chat"),
                "rpg": restored_gateway.get_rpg_state(workspace_id, "campaign", "campaign"),
                "memories": restored_gateway.get_story_memories(workspace_id, "campaign", "campaign"),
                "npcs": restored_gateway.list_story_npcs(workspace_id, "campaign", "campaign"),
                "locations": restored_gateway.list_story_locations(workspace_id, "campaign", "campaign"),
                "assets": restored_gateway.list_story_assets(workspace_id, "campaign", "campaign"),
                "asset_content": restored_gateway.get_story_asset(workspace_id, "campaign", "campaign", "harbor-reference")["content"],
                "revisions": restored_gateway.revisions(workspace_id, "campaign"),
                "revision": restored_gateway.current_revision(workspace_id, "campaign"),
            }
            self.assertEqual(backup_manifest, restored_manifest)
            self.assertEqual(actual, expected)
            self.assertEqual(actual["asset_content"], image_bytes)
            self.assertEqual(actual["rpg"]["sheet"]["trackers"]["health"]["value"], 7)
            self.assertEqual(actual["rpg"]["sheet"]["current_location"], "Cliff Road")
            restored.close()

    def test_corrupt_database_digest_is_rejected_without_creating_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = Database(root / "original.sqlite3")
            CommandGateway(database).create_workspace("Corruption test", "corruption-test")
            valid_path = root / "valid.lkebackup"
            corrupt_path = root / "corrupt.lkebackup"
            target_path = root / "restored.sqlite3"
            create_backup(database, valid_path)
            database.close()
            with zipfile.ZipFile(valid_path) as valid:
                manifest = valid.read("manifest.json")
                snapshot = valid.read("knowledge.sqlite3")
            with zipfile.ZipFile(corrupt_path, "w", compression=zipfile.ZIP_DEFLATED) as corrupt:
                corrupt.writestr("manifest.json", manifest)
                corrupt.writestr("knowledge.sqlite3", snapshot + b"tampered")

            with self.assertRaises(BackupError):
                restore_backup(corrupt_path, target_path)
            self.assertFalse(target_path.exists())

    def test_archive_path_entries_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            malicious = root / "malicious.lkebackup"
            target = root / "restored.sqlite3"
            manifest = json.dumps({"format": "lke.backup.v1"})
            with zipfile.ZipFile(malicious, "w") as archive:
                archive.writestr("manifest.json", manifest)
                archive.writestr("../outside.sqlite3", "not a database")
            with self.assertRaises(BackupError):
                restore_backup(malicious, target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
