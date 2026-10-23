"""End-to-end recovery checks for SQLite workspace backups."""

from __future__ import annotations

import json
import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path

from lke.core import CommandGateway, Database
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

            self.assertEqual(manifest["schema_version"], 8)
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
