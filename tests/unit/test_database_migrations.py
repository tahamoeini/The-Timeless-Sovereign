"""Migration checks for upgrading an existing v1 workspace database."""

import tempfile
import unittest
from pathlib import Path

from lke.core import Database


class DatabaseMigrationTests(unittest.TestCase):
    def test_v1_database_upgrades_to_story_turn_schema(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "knowledge.sqlite3"
            database = Database(database_path)
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

        self.assertEqual(version, 2)
        self.assertTrue({"story_conversations", "story_turns"} <= tables)


if __name__ == "__main__":
    unittest.main()
