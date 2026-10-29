"""MNO RPG Engine package conversion and isolated-import coverage."""

from __future__ import annotations

import asyncio
import copy
import sqlite3
import unittest

import httpx

from lke.api.app import _story_adventure_context, _story_context_turns, create_app
from lke.core import CommandGateway, Database
from lke.core.commands import _validated_import_archive
from lke.core.errors import ValidationError
from lke.importers.mno import convert_mno_adventure, convert_mno_world


PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgp0ZXN0"


def sample_world() -> dict:
    return {
        "format": "mno-world", "version": 1,
        "meta": {"id": "world-verdant", "name": "The Verdant Divide", "description": "A divided mountain valley.", "nsfw": True},
        "stats": {"averageThreshold": 10, "modStep": 1, "dieSides": 20, "formula": "never execute me",
                  "defs": [{"key": "strength", "start": 10}, {"key": "agility", "start": 12}]},
        "trackers": [
            {"key": "hp", "label": "Health", "type": "number", "start": 20, "max": 20},
            {"key": "location", "label": "Location", "type": "text", "start": "Hollow Reed"},
            {"key": "quest", "label": "Quest", "type": "text", "start": "Reach the ridge"},
        ],
        "lorebook": [
            {"title": "Valley truth", "type": "premise", "activation": "always", "content": "The valley is divided."},
            {"title": "Reed clan", "type": "faction", "activation": "keywords", "keywords": ["hollow reed"], "content": "The clan guards the pass."},
        ],
        "npcs": [{"name": "Kaelen", "details": {"race": "orc", "secrets": "Author-only template secret."}}],
    }


def sample_adventure() -> dict:
    return {
        "version": 2, "id": "adventure-verdant", "worldId": "world-verdant", "worldName": "The Verdant Divide",
        "name": "The Missing Caravan", "settings": {"simNpcLife": True, "showInnerThoughts": False},
        "character": {
            "name": "Taha", "age": "adult", "gender": "male", "race": "human", "job": "scout",
            "appearance": "A weathered traveler.", "persona": "Patient but wary.", "stats": {"strength": 14, "agility": 12},
            "portrait": PNG_DATA_URL,
        },
        "initialTrackers": {"hp": 18, "location": "Hollow Reed", "quest": "Find the caravan"},
        "messages": [
            {"role": "action", "text": "I ask Kaelen about the caravan.", "ts": 1_792_000_000_000},
            {"role": "narrator", "text": "Rain darkens the trail."},
            {"role": "npc", "name": "Kaelen", "text": "I saw tracks near the river."},
            {"role": "check", "text": "The result is described here, but no die record exists."},
            {"role": "thought", "text": "Kaelen fears the clan elder."},
            {"role": "meta", "text": "OOC: keep the secret hidden."},
        ],
        "npcs": {"kaelen": {
            "name": "Kaelen", "portrait": PNG_DATA_URL,
            "details": {"age": "mid-twenties", "gender": "male", "race": "orc", "job": "scavenger",
                        "appearance": "Green skin and worn armor.", "persona": "High-strung and opportunistic.",
                        "secrets": "Kaelen fears the clan elder."},
            "trackers": {"personal-loyalty": 15, "respect": 15},
            "lifeGoal": "Recover a stolen token", "lifeWhere": "At the river", "lifeHistory": ["Left camp"],
            "lifeTick": "Searches the river bank", "firstSeenTurn": 4, "lastSeenTurn": 0,
        }},
        "map": {"loc": "Verdant Divide", "scale": "regional", "hero": {"x": 244, "y": -549}, "pois": [
            {"name": "Hollow Reed", "type": "clan", "desc": "A guarded stone entrance.", "icon": "📍", "dx": 244, "dy": -549},
            {"name": "Silverthread River", "type": "river", "desc": "A bright river through the valley.", "icon": "🌊", "dx": -120, "dy": -200},
        ]},
        "memories": {"manual": ["The caravan departed at dusk."], "auto": [{"title": "Tracks found", "content": "Tracks lead to the river."}]},
        "latestSituation": "The search is beginning.", "openThreads": [],
    }


class MnoImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = Database(":memory:")
        self.gateway = CommandGateway(self.db)
        self.gateway.create_workspace("MNO import", "mno-import")
        self.app = create_app(self.db, auth_token="mno-test-token")
        self.headers = {"Authorization": "Bearer mno-test-token"}

    def tearDown(self) -> None:
        self.db.close()

    def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        async def send() -> httpx.Response:
            transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 8000))
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.request(method, path, **kwargs)

        return asyncio.run(send())

    def import_world(self, source: dict) -> dict:
        package, _ = convert_mno_world(source)
        result = self.gateway.execute(
            workspace_id="mno-import", branch_id="main",
            expected_revision=self.gateway.current_revision("mno-import", "main"),
            idempotency_key="import-mno-world", command_type="import_story_world",
            payload={"world_id": "mno-world-copy", "package": package}, actor="user", reason="Test MNO import",
        )
        return result

    def test_world_and_adventure_preview_require_explicit_import_and_keep_private_boundaries(self) -> None:
        world_source = sample_world()
        adventure_source = sample_adventure()
        before_preview = self.gateway.current_revision("mno-import", "main")

        world_preview = self.request(
            "POST", "/api/v1/workspaces/mno-import/story/worlds/mno-preview",
            headers=self.headers, json={"source": world_source, "filename": "verdant.mno-world"},
        )
        self.assertEqual(world_preview.status_code, 200, world_preview.text)
        self.assertEqual(world_preview.json()["preview"]["content_warning"], "This world is tagged NSFW by its source.")
        self.assertEqual(self.gateway.current_revision("mno-import", "main"), before_preview)
        self.import_world(world_source)

        adventure_preview = self.request(
            "POST", "/api/v1/workspaces/mno-import/story/adventures/mno-preview",
            headers=self.headers, json={"source": adventure_source, "filename": "verdant.mno-adv"},
        )
        self.assertEqual(adventure_preview.status_code, 200, adventure_preview.text)
        preview = adventure_preview.json()["preview"]
        self.assertEqual(preview["message_count"], 6)
        self.assertEqual(preview["context_excluded_message_count"], 2)
        self.assertEqual(preview["map_location_count"], 2)
        self.assertFalse(adventure_preview.json()["package"]["adventure"]["npc_simulation_enabled"])

        raw_package = adventure_preview.json()["package"]
        turns = raw_package["adventure"]["turns"]
        self.assertEqual([turn["role"] for turn in turns], ["user", "assistant", "assistant", "assistant", "assistant", "assistant"])
        self.assertEqual(len(_story_context_turns(turns)), 4)
        self.assertIn("[Imported NPC: Kaelen]", _story_context_turns(turns)[2]["content"])
        self.assertIn("no verified die result", _story_context_turns(turns)[3]["content"])
        self.assertNotIn("Author-only", repr(_story_context_turns(turns)))

        package_preview = self.request(
            "POST", "/api/v1/workspaces/mno-import/story/adventures/package-preview",
            headers=self.headers, json=raw_package,
        )
        self.assertEqual(package_preview.status_code, 200, package_preview.text)
        self.assertFalse(package_preview.json()["world_import_required"])
        main_revision = self.gateway.current_revision("mno-import", "main")
        imported = self.request(
            "POST", "/api/v1/workspaces/mno-import/story/adventures/package-import",
            headers=self.headers,
            json={"expected_revision": main_revision, "idempotency_key": "import-mno-adventure",
                  "adventure_id": "mno-adventure-copy", "package": raw_package},
        )
        self.assertEqual(imported.status_code, 200, imported.text)

        state = self.gateway.get_rpg_state("mno-import", "mno-adventure-copy", "mno-adventure-copy")
        self.assertEqual(state["sheet"]["stats"], {"strength": 2, "agility": 1})
        self.assertEqual(state["sheet"]["map_region"], "Verdant Divide")
        locations = self.gateway.list_story_locations("mno-import", "mno-adventure-copy", "mno-adventure-copy")
        river = next(location for location in locations if location["name"] == "Silverthread River")
        self.assertEqual((river["x"], river["y"], river["location_type"]), (-120, -200, "river"))
        npc = self.gateway.list_story_npcs("mno-import", "mno-adventure-copy", "mno-adventure-copy")[0]
        self.assertEqual(npc["private_profile"]["notes"], "Kaelen fears the clan elder.")
        self.assertEqual(npc["private_profile"]["trackers"]["respect"], 15)
        context = _story_adventure_context(
            self.gateway, "mno-import", "mno-adventure-copy", state["adventure"]["conversation_id"], query="Kaelen river",
        )
        self.assertNotIn("Kaelen fears the clan elder", str(context))
        self.assertNotIn("Author-only template secret", str(context))
        memories = self.gateway.get_story_memories("mno-import", "mno-adventure-copy", "mno-adventure-copy")["memories"]
        self.assertTrue(all(memory["review_status"] == "proposed" for memory in memories if memory["kind"] in {"event", "situation"}))

        with self.assertRaises(ValidationError):
            self.gateway.execute(
                workspace_id="mno-import", branch_id="mno-adventure-copy",
                expected_revision=self.gateway.current_revision("mno-import", "mno-adventure-copy"),
                idempotency_key="bad-world-cast-npc", command_type="create_story_npc",
                payload={"adventure_id": "mno-adventure-copy", "npc_entity_id": "bad-cast", "label": "Too Large",
                         "private_profile": {"notes": "x" * 21_000}}, actor="user", reason="Reject oversized NPC profile",
            )
        self.assertIsNone(self.db.connection.execute(
            "SELECT 1 FROM entities WHERE workspace_id='mno-import' AND branch_id='mno-adventure-copy' AND entity_id='bad-cast'"
        ).fetchone())
        self.gateway.execute(
            workspace_id="mno-import", branch_id="mno-adventure-copy",
            expected_revision=self.gateway.current_revision("mno-import", "mno-adventure-copy"),
            idempotency_key="add-world-cast-npc", command_type="create_story_npc",
            payload={"adventure_id": "mno-adventure-copy", "npc_entity_id": "world-cast-gorthak", "label": "Gorthak",
                     "public_profile": {"race": "orc", "persona": "Guarded."},
                     "private_profile": {"notes": "A secret known only to the author."}, "review_status": "accepted"},
            actor="user", reason="Add a selected world cast character",
        )
        cast_npc = next(item for item in self.gateway.list_story_npcs("mno-import", "mno-adventure-copy", "mno-adventure-copy")
                        if item["npc_entity_id"] == "world-cast-gorthak")
        self.assertEqual(cast_npc["private_profile"]["notes"], "A secret known only to the author.")
        cast_context = _story_adventure_context(
            self.gateway, "mno-import", "mno-adventure-copy", state["adventure"]["conversation_id"], query="Gorthak",
        )
        self.assertIn("Guarded.", str(cast_context))
        self.assertNotIn("A secret known only to the author", str(cast_context))

        source_archive = raw_package["adventure"]["source_archive"]
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.connection.execute(
                "UPDATE story_adventures SET source_archive_json='{}' WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                ("mno-import", "mno-adventure-copy", "mno-adventure-copy"),
            )
        exported = self.request(
            "GET", "/api/v1/workspaces/mno-import/story/adventures/mno-adventure-copy/package?branch_id=mno-adventure-copy",
            headers=self.headers,
        )
        self.assertEqual(exported.status_code, 200, exported.text)
        self.assertEqual(exported.json()["adventure"]["source_archive"], source_archive)

    def test_invalid_mno_versions_and_credential_fields_are_rejected_without_writes(self) -> None:
        base_revision = self.gateway.current_revision("mno-import", "main")
        invalid = copy.deepcopy(sample_world())
        invalid["version"] = 99
        response = self.request(
            "POST", "/api/v1/workspaces/mno-import/story/worlds/mno-preview",
            headers=self.headers, json={"source": invalid},
        )
        self.assertEqual(response.status_code, 422)

        invalid = copy.deepcopy(sample_world())
        invalid["apiKey"] = "must-not-be-imported"
        response = self.request(
            "POST", "/api/v1/workspaces/mno-import/story/worlds/mno-preview",
            headers=self.headers, json={"source": invalid},
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.gateway.current_revision("mno-import", "main"), base_revision)

    def test_preserved_adventure_archive_uses_its_own_ten_megabyte_limit(self) -> None:
        archive = {"format": "mno-adv", "version": 2, "filename": "large.mno-adv", "data": {"transcript_cache": "x" * 1_600_000}}
        validated = _validated_import_archive(archive)
        self.assertEqual(len(validated["data"]["transcript_cache"]), 1_600_000)


if __name__ == "__main__":
    unittest.main()
