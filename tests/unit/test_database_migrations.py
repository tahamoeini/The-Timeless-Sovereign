"""Migration checks for upgrading existing workspace databases."""

import tempfile
import unittest
from pathlib import Path

from lke.core import CommandGateway, Database
from lke.core.database import _SCHEMA_V7


class DatabaseMigrationTests(unittest.TestCase):
    def _drop_extractions(self, database):
        for table in ("extraction_candidates", "extraction_batches", "entity_evidence"):
            database.connection.execute(f"DROP TABLE {table}")

    def _drop_scenarios(self, database):
        for table in (
            "scenario_assumptions", "scenario_source_evidence", "scenario_claim_evidence",
            "scenario_options", "scenarios",
        ):
            database.connection.execute(f"DROP TABLE {table}")

    def _drop_exchanges(self, database):
        database.connection.execute("DROP TABLE external_exchanges")

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

        self.assertEqual(version, 8)
        self.assertTrue({"story_conversations", "story_turns", "journal_events", "rules", "scenarios", "scenario_assumptions", "extraction_batches", "extraction_candidates", "entity_evidence", "external_exchanges"} <= tables)

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

        self.assertEqual(version, 8)
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

        self.assertEqual(version, 8)
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

        self.assertEqual(version, 8)
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

        self.assertEqual(version, 8)
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

        self.assertEqual(version, 8)
        self.assertIsNotNone(exchange_table)

    def test_v7_database_backfills_known_transcript_end(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
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
            database.connection.execute("DELETE FROM schema_migrations WHERE version=8")
            database.close()

            upgraded = Database(database_path)
            version = upgraded.connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
            migrated = upgraded.connection.execute(
                "SELECT from_turn,to_turn,transcript_total_turns FROM external_exchanges WHERE exchange_id='old-exchange'"
            ).fetchone()
            upgraded.close()

        self.assertEqual(version, 8)
        self.assertEqual(tuple(migrated), (0, 1, 1))


if __name__ == "__main__":
    unittest.main()
