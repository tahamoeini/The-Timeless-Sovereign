"""Migration checks for upgrading existing workspace databases."""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from lke.core import CommandGateway, Database
from lke.core.database import SCHEMA_VERSION, _SCHEMA_V7


class DatabaseMigrationTests(unittest.TestCase):
    def _drop_extractions(self, database):
        for table in ("extraction_candidates", "extraction_batches", "entity_evidence"):
            database.connection.execute(f"DROP TABLE {table}")

    def _drop_story_extensions(self, database):
        for table in ("story_map_locations", "story_assets", "story_npc_profiles", "story_threads", "story_memories", "story_turn_edits"):
            database.connection.execute(f"DROP TABLE IF EXISTS {table}")
        database.connection.execute("ALTER TABLE story_adventures DROP COLUMN npc_simulation_enabled")
        database.connection.execute("ALTER TABLE story_adventures DROP COLUMN completed_turns")

    def _drop_scenarios(self, database):
        for table in (
            "scenario_assumptions", "scenario_source_evidence", "scenario_claim_evidence",
            "scenario_options", "scenarios",
        ):
            database.connection.execute(f"DROP TABLE {table}")

    def _drop_exchanges(self, database):
        database.connection.execute("DROP TABLE external_exchanges")
        self._drop_story_rpg(database)

    def _drop_story_rpg(self, database):
        self._drop_story_extensions(database)
        for table in (
            "rpg_state_proposals", "rpg_checks", "rpg_sheets", "story_adventures",
            "story_world_versions", "story_worlds",
        ):
            database.connection.execute(f"DROP TABLE {table}")

    def test_v1_database_upgrades_through_all_current_schemas(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            self._drop_extractions(database)
            self._drop_scenarios(database)
            self._drop_exchanges(database)
            database.connection.execute("DROP TABLE rules")
            database.connection.execute("DROP TABLE journal_events")
            database.connection.execute("DROP TABLE story_turns")
            database.connection.execute("DROP TABLE story_conversations")
            database.connection.execute("DELETE FROM schema_migrations WHERE version>1")
            database.close()

            upgraded = Database(database_path)
            version = upgraded.connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
            tables = {
                row[0]
                for row in upgraded.connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            upgraded.close()

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertTrue({"story_conversations", "story_turns", "journal_events", "rules", "scenarios", "scenario_assumptions", "extraction_batches", "extraction_candidates", "entity_evidence", "external_exchanges", "story_worlds", "story_world_versions", "story_adventures", "rpg_sheets", "rpg_checks", "rpg_state_proposals", "story_turn_edits", "story_memories", "story_threads", "story_npc_profiles", "story_assets", "story_map_locations"} <= tables)

    def test_v2_database_upgrades_to_journal_and_rule_schemas(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            self._drop_extractions(database)
            self._drop_scenarios(database)
            self._drop_exchanges(database)
            database.connection.execute("DROP TABLE rules")
            database.connection.execute("DROP TABLE journal_events")
            database.connection.execute("DELETE FROM schema_migrations WHERE version>2")
            database.close()

            upgraded = Database(database_path)
            version = upgraded.connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
            table = upgraded.connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='journal_events'"
            ).fetchone()
            rules = upgraded.connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='rules'"
            ).fetchone()
            upgraded.close()

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIsNotNone(table)
        self.assertIsNotNone(rules)

    def test_v3_database_upgrades_to_rule_schema(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            self._drop_extractions(database)
            self._drop_scenarios(database)
            self._drop_exchanges(database)
            database.connection.execute("DROP TABLE rules")
            database.connection.execute("DELETE FROM schema_migrations WHERE version>3")
            database.close()

            upgraded = Database(database_path)
            version = upgraded.connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
            table = upgraded.connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='rules'"
            ).fetchone()
            upgraded.close()

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIsNotNone(table)

    def test_v4_database_upgrades_to_scenario_schema(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            self._drop_extractions(database)
            self._drop_scenarios(database)
            self._drop_exchanges(database)
            database.connection.execute("DELETE FROM schema_migrations WHERE version>4")
            database.close()

            upgraded = Database(database_path)
            version = upgraded.connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
            tables = {
                row[0]
                for row in upgraded.connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            upgraded.close()

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertTrue({"scenarios", "scenario_options", "scenario_assumptions", "scenario_claim_evidence", "scenario_source_evidence"} <= tables)

    def test_v5_database_upgrades_to_source_extraction_schema(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            self._drop_extractions(database)
            self._drop_exchanges(database)
            database.connection.execute("DELETE FROM schema_migrations WHERE version>5")
            database.close()

            upgraded = Database(database_path)
            version = upgraded.connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
            tables = {
                row[0]
                for row in upgraded.connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            upgraded.close()

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertTrue({"extraction_batches", "extraction_candidates", "entity_evidence"} <= tables)

    def test_v6_database_upgrades_to_external_exchange_schema(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            self._drop_exchanges(database)
            database.connection.execute("DELETE FROM schema_migrations WHERE version>6")
            database.close()

            upgraded = Database(database_path)
            version = upgraded.connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
            exchange_table = upgraded.connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='external_exchanges'"
            ).fetchone()
            upgraded.close()

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertIsNotNone(exchange_table)

    def test_v7_database_backfills_known_transcript_end(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            self._drop_story_rpg(database)
            gateway = CommandGateway(database)
            gateway.create_workspace("Migration", "migration-workspace")
            database.connection.execute("DROP TABLE external_exchanges")
            database.connection.executescript(_SCHEMA_V7)
            database.connection.execute(
                "INSERT INTO external_exchanges(workspace_id,branch_id,exchange_id,transcript_id,"
                "context_manifest_id,base_revision,from_turn,to_turn,transcript_hash,context_manifest_json,"
                "turns_json,proposed_change_ids_json,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("migration-workspace", "main", "old-exchange", "old-transcript", "old-context", 0,
                 0, 1, "sha256:" + "0" * 64, "{}", "[]", "[]", 0, "2026-01-01T00:00:00.000Z"),
            )
            database.connection.execute("DELETE FROM schema_migrations WHERE version>7")
            database.close()

            upgraded = Database(database_path)
            version = upgraded.connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
            migrated = upgraded.connection.execute(
                "SELECT from_turn,to_turn,transcript_total_turns FROM external_exchanges WHERE exchange_id='old-exchange'"
            ).fetchone()
            upgraded.close()

        self.assertEqual(version, SCHEMA_VERSION)
        self.assertEqual(tuple(migrated), (0, 1, 1))

    def test_v9_world_versions_gain_a_pinned_name(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            gateway = CommandGateway(database)
            gateway.create_workspace("Migration", "world-migration")
            gateway.execute(
                workspace_id="world-migration", idempotency_key="world-migration-create", expected_revision=0,
                command_type="create_story_world",
                payload={"world_id": "harbor", "name": "Old Harbor", "template_key": "blank", "content": {}},
                reason="Create migration fixture",
            )
            database.connection.execute("ALTER TABLE story_world_versions DROP COLUMN name")
            self._drop_story_extensions(database)
            database.connection.execute("DELETE FROM schema_migrations WHERE version>9")
            database.close()

            upgraded = Database(database_path)
            version_name = upgraded.connection.execute(
                "SELECT name FROM story_world_versions WHERE world_id='harbor' AND version=1"
            ).fetchone()["name"]
            with self.assertRaises(sqlite3.IntegrityError):
                upgraded.connection.execute(
                    "UPDATE story_world_versions SET name='Changed' WHERE world_id='harbor' AND version=1"
                )
            upgraded.close()

        self.assertEqual(version_name, "Old Harbor")


if __name__ == "__main__":
    unittest.main()
