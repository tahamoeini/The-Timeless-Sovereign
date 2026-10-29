"""Canonical library lifecycle, archival, and duplicate-safe story commands."""

import unittest
import base64
from unittest.mock import patch

from lke.core import CommandGateway, Database, ValidationError


class StoryLibraryTests(unittest.TestCase):
    def setUp(self):
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.workspace_id = "library-workspace"
        self.gateway.create_workspace("Library workspace", self.workspace_id)
        self.revision = self.command("hero", 0, "create_entity", {
            "entity_id": "hero", "entity_type": "character", "label": "Mira", "properties": {},
        })["revision"]
        self.world = self.command("world", self.revision, "create_story_world", {
            "world_id": "world", "name": "Glass Archive", "description": "A living library.",
            "template_key": "fantasy", "content": {"stats": {"insight": 1}, "starting_location": "Atrium"},
        })
        self.revision = self.world["revision"]
        self.create_adventure("adventure-one")

    def tearDown(self):
        self.database.close()

    def command(self, key, revision, kind, payload, *, branch="main", actor="user"):
        return self.gateway.execute(
            workspace_id=self.workspace_id,
            branch_id=branch,
            idempotency_key=key,
            expected_revision=revision,
            command_type=kind,
            payload=payload,
            actor=actor,
            reason="Story library test",
        )

    def create_adventure(self, adventure_id):
        self.gateway.create_branch(
            self.workspace_id, "main", adventure_id, self.revision, f"branch-{adventure_id}",
        )
        return self.command(f"create-{adventure_id}", self.revision, "create_story_adventure", {
            "adventure_id": adventure_id,
            "world_id": "world",
            "world_version": 1,
            "conversation_id": f"conversation-{adventure_id}",
            "name": f"Adventure {adventure_id}",
            "actor_entity_id": "hero",
        }, branch=adventure_id)

    def test_world_archive_restore_preserves_versions_and_blocks_new_adventures(self):
        archived = self.command("archive-world", self.revision, "set_story_world_archived", {
            "world_id": "world", "archived": True,
        })
        self.revision = archived["revision"]
        world = self.gateway.list_story_worlds(self.workspace_id)[0]
        self.assertIsNotNone(world["archived_at"])
        self.assertEqual(world["latest_version"], 1)
        self.assertEqual(len(self.gateway.get_story_world(self.workspace_id, "world")["versions"]), 1)

        self.gateway.create_branch(
            self.workspace_id, "main", "blocked-adventure", self.revision, "blocked-branch",
        )
        with self.assertRaisesRegex(ValidationError, "Restore this world"):
            self.command("blocked-create", self.revision, "create_story_adventure", {
                "adventure_id": "blocked-adventure", "world_id": "world", "world_version": 1,
                "conversation_id": "blocked-conversation", "name": "Blocked", "actor_entity_id": "hero",
            }, branch="blocked-adventure")

        restored = self.command("restore-world", self.revision, "set_story_world_archived", {
            "world_id": "world", "archived": False,
        })
        self.revision = restored["revision"]
        self.assertIsNone(self.gateway.list_story_worlds(self.workspace_id)[0]["archived_at"])
        self.create_adventure("adventure-two")

    def test_duplicate_world_copies_version_history_with_a_distinct_library_name(self):
        source = self.gateway.get_story_world(self.workspace_id, "world")["versions"][0]
        revised = self.command("revise-world", self.revision, "revise_story_world", {
            "world_id": "world", "expected_world_version": 1, "name": "Glass Archive",
            "description": "A living library with a sealed wing.", "template_key": "fantasy",
            "content": source["content"],
        })
        self.revision = revised["revision"]

        duplicate = self.command("duplicate-world", self.revision, "duplicate_story_world", {
            "source_world_id": "world", "world_id": "world-copy", "name": "Glass Archive (copy)",
        })

        self.assertEqual(duplicate["version"], 2)
        copied = self.gateway.get_story_world(self.workspace_id, "world-copy")
        self.assertEqual(copied["name"], "Glass Archive (copy)")
        self.assertEqual([item["version"] for item in copied["versions"]], [2, 1])
        self.assertEqual(copied["versions"][0]["description"], "A living library with a sealed wing.")
        self.assertEqual(copied["versions"][0]["content"], source["content"])
        self.assertEqual(self.gateway.get_story_world(self.workspace_id, "world")["name"], "Glass Archive")

    def test_world_cover_is_pinned_and_survives_public_package_export(self):
        content = self.gateway.get_story_world(self.workspace_id, "world")["versions"][0]["content"]
        content["cover_image"] = {
            "mime_type": "image/jpeg",
            "data_base64": base64.b64encode(b"validated by image decoder").decode("ascii"),
            "alt_text": "A moonlit library entrance",
        }
        with patch("lke.core.commands._validate_image_content") as validate_image:
            revised = self.command("cover-world", self.revision, "revise_story_world", {
                "world_id": "world", "expected_world_version": 1, "name": "Glass Archive",
                "description": "A moonlit archive.", "template_key": "fantasy", "content": content,
            })
            package = self.gateway.export_world_package(self.workspace_id, "world", export_mode="public_world")

        self.assertEqual(revised["version"], 2)
        self.assertEqual(validate_image.call_count, 2)
        self.assertTrue(all(call.args == ("image/jpeg", b"validated by image decoder")
                            for call in validate_image.call_args_list))
        self.assertEqual(package["versions"][-1]["content"]["cover_image"], content["cover_image"])

    def test_adventure_rename_status_archive_restore_and_snapshot(self):
        initial = self.gateway.list_story_adventures(self.workspace_id)[0]
        renamed = self.command("rename", initial["updated_revision"], "set_story_adventure_library_state", {
            "adventure_id": "adventure-one", "name": "The Quiet Archive", "status": "paused",
        }, branch="adventure-one")
        self.assertEqual(renamed["revision"], initial["updated_revision"] + 1)
        conversation = self.gateway.get_conversation(
            self.workspace_id, "adventure-one", "conversation-adventure-one",
        )
        self.assertEqual(conversation["title"], "The Quiet Archive")

        archived = self.command("archive-adventure", renamed["revision"], "set_story_adventure_library_state", {
            "adventure_id": "adventure-one", "archived": True,
        }, branch="adventure-one")
        listed = self.gateway.list_story_adventures(self.workspace_id)[0]
        self.assertIsNotNone(listed["archived_at"])
        self.assertEqual(listed["status"], "paused")

        fork = self.gateway.create_branch(
            self.workspace_id, "adventure-one", "adventure-one-save", archived["revision"], "snapshot-archived",
        )
        self.assertEqual(fork["branch_id"], "adventure-one-save")
        forked = next(item for item in self.gateway.list_story_adventures(self.workspace_id, "adventure-one-save"))
        self.assertIsNotNone(forked["archived_at"])
        self.assertEqual(forked["name"], "The Quiet Archive")

        restored = self.command("restore-adventure", archived["revision"], "set_story_adventure_library_state", {
            "adventure_id": "adventure-one", "archived": False, "status": "active",
        }, branch="adventure-one")
        active = self.gateway.list_story_adventures(self.workspace_id, "adventure-one")[0]
        self.assertIsNone(active["archived_at"])
        self.assertEqual(active["status"], "active")
        self.assertGreater(restored["revision"], archived["revision"])

    def test_adventure_library_updates_validate_values_and_actor(self):
        current_revision = self.gateway.current_revision(self.workspace_id, "adventure-one")
        with self.assertRaises(ValidationError):
            self.command("bad-status", current_revision, "set_story_adventure_library_state", {
                "adventure_id": "adventure-one", "status": [],
            }, branch="adventure-one")
        with self.assertRaises(ValidationError):
            self.command("ai-rename", current_revision, "set_story_adventure_library_state", {
                "adventure_id": "adventure-one", "name": "Spoiler",
            }, branch="adventure-one", actor="ai:local")
        self.assertEqual(self.gateway.current_revision(self.workspace_id, "adventure-one"), current_revision)


if __name__ == "__main__":
    unittest.main()
