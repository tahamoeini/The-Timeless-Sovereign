"""Portable world history, collision handling and validation."""

import copy
import unittest

from lke.core import CommandGateway, ConflictError, Database, ValidationError


class WorldPackageTests(unittest.TestCase):
    def setUp(self):
        self.db = Database(":memory:")
        self.gateway = CommandGateway(self.db)
        self.gateway.create_workspace("Source", "source")
        self.gateway.create_workspace("Destination", "destination")

    def tearDown(self):
        self.db.close()

    def command(self, workspace, revision, key, kind, payload):
        return self.gateway.execute(workspace_id=workspace, branch_id="main", expected_revision=revision,
                                    idempotency_key=key, command_type=kind, payload=payload,
                                    actor="user", reason="World package test")

    def test_round_trip_preserves_versions_and_imports_a_separate_world(self):
        first = self.command("source", 0, "create", "create_story_world", {
            "world_id": "harbor", "name": "Harbor", "description": "Fog", "template_key": "fantasy",
            "content": {"public_lore": "مه روی دریا", "stats": {"might": 1}},
        })
        self.command("source", first["revision"], "revise", "revise_story_world", {
            "world_id": "harbor", "expected_world_version": 1, "name": "Harbor in winter",
            "description": "Snow", "template_key": "fantasy", "content": {"public_lore": "برف"},
        })
        package = self.gateway.export_world_package("source", "harbor")
        preview = self.gateway.preview_world_package("source", package)
        self.assertTrue(preview["source_id_conflict"])
        self.assertEqual(preview["versions"], 2)
        self.assertFalse(self.gateway.preview_world_package("destination", package)["source_id_conflict"])
        payload = {"world_id": "copy", "package": package}
        imported = self.command("destination", 0, "import", "import_story_world", payload)
        duplicate = self.command("destination", 0, "import", "import_story_world", payload)
        self.assertEqual(imported, duplicate)
        copied = self.gateway.export_world_package("destination", "copy")
        self.assertEqual(copied["versions"], package["versions"])
        self.assertEqual(imported["source"], {"workspace_id": "source", "world_id": "harbor"})
        with self.assertRaises(ConflictError):
            self.command("destination", imported["revision"], "collision", "import_story_world", payload)
        self.assertEqual(self.gateway.current_revision("destination"), imported["revision"])

    def test_invalid_packages_do_not_mutate_the_destination(self):
        base = {"protocol": "lke.world.v1", "provenance": {"workspace_id": "source", "world_id": "w"},
                "versions": [{"version": 1, "name": "World", "description": "", "template_key": "blank", "content": {}}]}
        invalid = []
        unsupported = copy.deepcopy(base); unsupported["protocol"] = "lke.world.v2"; invalid.append(unsupported)
        missing_version = copy.deepcopy(base); missing_version["versions"][0]["version"] = 2; invalid.append(missing_version)
        secret = copy.deepcopy(base); secret["versions"][0]["content"] = {"provider": {"api_key": "hidden"}}; invalid.append(secret)
        oversized = copy.deepcopy(base); oversized["versions"][0]["content"] = {"lore": "x" * 100_001}; invalid.append(oversized)
        extra = copy.deepcopy(base); extra["provider_key"] = "hidden"; invalid.append(extra)
        for index, package in enumerate(invalid):
            with self.subTest(index=index), self.assertRaises(ValidationError):
                self.command("destination", 0, f"bad-{index}", "import_story_world", {"world_id": "copy", "package": package})
            self.assertEqual(self.gateway.current_revision("destination"), 0)
        self.assertEqual(self.gateway.list_story_worlds("destination"), [])


if __name__ == "__main__":
    unittest.main()
