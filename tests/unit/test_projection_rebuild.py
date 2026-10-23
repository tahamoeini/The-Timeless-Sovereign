"""Search projections can be rebuilt without changing canonical history."""

from __future__ import annotations

import unittest

from lke.core import CommandGateway, Database


class SearchProjectionRebuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.gateway.create_workspace("Projection recovery", "projection-recovery")
        self.gateway.execute(
            workspace_id="projection-recovery", idempotency_key="entity", expected_revision=0,
            command_type="create_entity",
            payload={"entity_id": "aria", "entity_type": "person", "label": "Aria", "properties": {"role": "Archivist"}},
            reason="Create projection fixture",
        )
        self.gateway.execute(
            workspace_id="projection-recovery", idempotency_key="source", expected_revision=1,
            command_type="import_source",
            payload={"source_id": "ledger", "display_name": "Old ledger", "content": "The brass key rests in the archive.", "media_type": "text/plain"},
            reason="Import projection fixture",
        )

    def tearDown(self) -> None:
        self.database.close()

    def test_rebuild_restores_search_from_canonical_rows_without_revision(self) -> None:
        connection = self.database.connection
        connection.execute("DELETE FROM entity_search")
        connection.execute("DELETE FROM source_search")
        before_entities = connection.execute("SELECT entity_id,label,properties_json FROM entities").fetchall()
        before_sources = connection.execute("SELECT source_id,display_name,content FROM sources").fetchall()
        revision_before = self.gateway.current_revision("projection-recovery")

        counts = self.database.rebuild_search_projections()

        self.assertEqual(counts, {"entities": 1, "sources": 1})
        self.assertEqual(connection.execute(
            "SELECT entity_id FROM entity_search WHERE entity_search MATCH ? AND workspace_id=? AND branch_id=?",
            ("Archivist", "projection-recovery", "main"),
        ).fetchone()[0], "aria")
        self.assertEqual(self.gateway.search_sources("projection-recovery", "brass key")[0]["source_id"], "ledger")
        self.assertEqual(connection.execute("SELECT entity_id,label,properties_json FROM entities").fetchall(), before_entities)
        self.assertEqual(connection.execute("SELECT source_id,display_name,content FROM sources").fetchall(), before_sources)
        self.assertEqual(self.gateway.current_revision("projection-recovery"), revision_before)

    def test_rebuild_recreates_missing_projection_tables_and_is_repeatable(self) -> None:
        self.database.connection.execute("DROP TABLE entity_search")
        first = self.database.rebuild_search_projections()
        second = self.database.rebuild_search_projections()

        self.assertEqual(first, {"entities": 1, "sources": 1})
        self.assertEqual(second, first)
        self.assertEqual(self.gateway.search_sources("projection-recovery", "archive")[0]["source_id"], "ledger")


if __name__ == "__main__":
    unittest.main()
