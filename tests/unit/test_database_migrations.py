"""Migration checks for upgrading existing workspace databases."""

import tempfile
import unittest
from pathlib import Path

from lke.core import Database


class DatabaseMigrationTests(unittest.TestCase):
    def test_v1_database_upgrades_through_all_current_schemas(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            database.connection.execute("DROP TABLE rules")
            database.connection.execute("DELETE FROM schema_migrations WHERE version=4")
            database.connection.execute("DROP TABLE journal_events")
            database.connection.execute("DELETE FROM schema_migrations WHERE version=3")
            database.connection.execute("DROP TABLE story_turns")
            database.connection.execute("DROP TABLE story_conversations")
            database.connection.execute("DELETE FROM schema_migrations WHERE version=2")
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

        self.assertEqual(version, 4)
        self.assertTrue({"story_conversations", "story_turns", "journal_events", "rules"} <= tables)

    def test_v2_database_upgrades_to_journal_and_rule_schemas(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            database.connection.execute("DROP TABLE rules")
            database.connection.execute("DELETE FROM schema_migrations WHERE version=4")
            database.connection.execute("DROP TABLE journal_events")
            database.connection.execute("DELETE FROM schema_migrations WHERE version=3")
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

        self.assertEqual(version, 4)
        self.assertIsNotNone(table)
        self.assertIsNotNone(rules)

    def test_v3_database_upgrades_to_rule_schema(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
            database.connection.execute("DROP TABLE rules")
            database.connection.execute("DELETE FROM schema_migrations WHERE version=4")
            database.close()

            upgraded = Database(database_path)
            version = upgraded.connection.execute(
                "SELECT MAX(version) FROM schema_migrations"
            ).fetchone()[0]
            table = upgraded.connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='rules'"
            ).fetchone()
            upgraded.close()

        self.assertEqual(version, 4)
        self.assertIsNotNone(table)


if __name__ == "__main__":
    unittest.main()
