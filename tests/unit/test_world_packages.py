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
        self.assertEqual(package["protocol"], "lke.world.v2")
        self.assertEqual(package["manifest"]["algorithm"], "sha256")
        self.assertEqual(package["manifest"]["assets"], [])
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

    def test_v1_world_import_is_upcast_and_v2_checksum_rejects_tampering(self):
        legacy = {"protocol": "lke.world.v1", "provenance": {"workspace_id": "source", "world_id": "legacy"},
                  "versions": [{"version": 1, "name": "Legacy", "description": "", "template_key": "blank",
                                "content": {"public_lore": "A remembered place"}}]}
        preview = self.gateway.preview_world_package("destination", legacy)
        self.assertEqual(preview["protocol"], "lke.world.v2")
        self.assertEqual(self.gateway.current_revision("destination"), 0)

        created = self.command("source", 0, "create-for-tamper", "create_story_world", {
            "world_id": "checksum-world", "name": "Checksum", "template_key": "blank", "content": {"public_lore": "Original"},
        })
        tampered = copy.deepcopy(self.gateway.export_world_package("source", "checksum-world"))
        tampered["versions"][0]["content"]["public_lore"] = "Altered after export"
        with self.assertRaisesRegex(ValidationError, "payload checksum"):
            self.gateway.preview_world_package("destination", tampered)
        self.assertEqual(self.gateway.current_revision("source", "main"), created["revision"])

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

    def test_fictional_secrets_are_portable_but_credentials_are_not(self):
        package = {
            "protocol": "lke.world.v1",
            "provenance": {"workspace_id": "source", "world_id": "secrets-world"},
            "versions": [{
                "version": 1, "name": "The Veiled Coast", "description": "", "template_key": "fantasy",
                "content": {
                    "secrets": {"villain_identity": "The lighthouse keeper"},
                    "hidden_history": "The crown was buried under the tide chapel.",
                    "private_npc_knowledge": {"keeper": ["The door opens at moonrise."]},
                },
            }],
        }
        imported = self.command("destination", 0, "fictional-secrets", "import_story_world", {
            "world_id": "secrets-copy", "package": package,
        })
        copied = self.gateway.get_story_world("destination", "secrets-copy")
        self.assertEqual(copied["versions"][0]["content"]["secrets"], package["versions"][0]["content"]["secrets"])
        self.assertEqual(imported["revision"], 1)

        credential_package = copy.deepcopy(package)
        credential_package["versions"][0]["content"]["provider"] = {"api_key": "must-not-export"}
        with self.assertRaises(ValidationError):
            self.command("destination", imported["revision"], "credential-secrets", "import_story_world", {
                "world_id": "credential-copy", "package": credential_package,
            })
        worlds = self.gateway.list_story_worlds("destination")
        self.assertEqual([world["world_id"] for world in worlds], ["secrets-copy"])

    def test_public_world_export_omits_unclassified_fields_and_private_export_requires_confirmation(self):
        created = self.command("source", 0, "private-world", "create_story_world", {
            "world_id": "private-world", "name": "The Veiled Coast", "template_key": "fantasy",
            "content": {
                "starting_location": "Old Harbor", "stats": {"might": 1},
                "trackers": {"health": {"value": 8, "max": 10}},
                "public_lore": "A cold harbor at the edge of the sea.",
                "author_notes": "The lighthouse keeper serves the duke.",
                "mno_source": {"raw_secret": "The crown is buried under the chapel."},
            },
        })
        preview = self.gateway.preview_world_export("source", "private-world", "full_private_archive")
        self.assertTrue(preview["requires_private_confirmation"])
        with self.assertRaisesRegex(ValidationError, "preview and explicitly confirm"):
            self.gateway.export_world_package("source", "private-world")

        public = self.gateway.export_world_package("source", "private-world", export_mode="public_world")
        public_json = str(public)
        self.assertNotIn("author_notes", public_json)
        self.assertNotIn("mno_source", public_json)
        self.assertEqual(public["versions"][0]["content"]["public_lore"],
                         "A cold harbor at the edge of the sea.")
        private = self.gateway.export_world_package(
            "source", "private-world", export_mode="full_private_archive", confirm_private=True,
        )
        self.assertIn("author_notes", private["versions"][0]["content"])
        self.assertEqual(created["revision"], self.gateway.current_revision("source", "main"))


if __name__ == "__main__":
    unittest.main()
