"""World-pinned mechanics, persistent progression, and portable RPG state."""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

import httpx

from lke.api.app import create_app
from lke.core import CommandGateway, Database, ValidationError


def mechanics_profile(*, mode: str = "custom_dice", dice: dict | None = None) -> dict:
    return {
        "mode": mode,
        "dice": dice or {
            "count": 2, "sides": 6, "resolution": "success_count",
            "success_threshold": 4, "include_attribute": True,
        },
        "difficulties": [{"difficulty_id": "standard", "label": "Standard", "target": 4}],
        "encounter_types": [
            {"encounter_type": "combat", "label": "Combat"},
            {"encounter_type": "investigation", "label": "Investigation"},
        ],
        "skills": [{
            "skill_id": "lore", "label": "Lore", "attribute": "cunning",
            "starting_rank": 1, "max_rank": 5, "rank_bonus": 1,
        }],
        "experience": {
            "mode": "hybrid", "starting_xp": 5, "per_completed_turn": 3,
            "allow_manual_awards": True, "maximum_xp": 20,
        },
    }


class StoryMechanicsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.workspace_id = "mechanics-workspace"
        self.destination_id = "mechanics-destination"
        self.gateway.create_workspace("Mechanics", self.workspace_id)
        self.gateway.create_workspace("Portable destination", self.destination_id)

        self.command("hero", "main", "create_entity", {
            "entity_id": "hero", "entity_type": "character", "label": "Mira", "properties": {},
        })
        self.command("custom-world", "main", "create_story_world", {
            "world_id": "custom-world", "name": "The Salt Library", "template_key": "fantasy",
            "content": {
                "starting_location": "Salt Library", "stats": {"cunning": 2},
                "game_mechanics": mechanics_profile(),
            },
        })
        self.command("narrative-world", "main", "create_story_world", {
            "world_id": "narrative-world", "name": "The Quiet Road", "template_key": "blank",
            "content": {
                "starting_location": "The Road", "stats": {"cunning": 0},
                "game_mechanics": mechanics_profile(mode="narrative_only"),
            },
        })
        main_revision = self.gateway.current_revision(self.workspace_id, "main")
        self.gateway.create_branch(
            self.workspace_id, "main", "custom-adventure", main_revision, "fork-custom-adventure",
        )
        self.gateway.create_branch(
            self.workspace_id, "main", "narrative-adventure", main_revision, "fork-narrative-adventure",
        )
        self.command("start-custom", "custom-adventure", "create_story_adventure", {
            "adventure_id": "custom-adventure", "world_id": "custom-world", "world_version": 1,
            "conversation_id": "custom-conversation", "name": "The Salt Library",
            "actor_entity_id": "hero", "stats": {"cunning": 2},
        })
        self.command("start-narrative", "narrative-adventure", "create_story_adventure", {
            "adventure_id": "narrative-adventure", "world_id": "narrative-world", "world_version": 1,
            "conversation_id": "narrative-conversation", "name": "The Quiet Road",
            "actor_entity_id": "hero", "stats": {"cunning": 0},
        })

    def tearDown(self) -> None:
        self.database.close()

    def command(self, key: str, branch: str, command_type: str, payload: dict, *, actor: str = "user"):
        return self.gateway.execute(
            workspace_id=self.workspace_id, branch_id=branch,
            expected_revision=self.gateway.current_revision(self.workspace_id, branch),
            idempotency_key=key, command_type=command_type, payload=payload,
            actor=actor, reason="Story mechanics test",
        )

    def append_player_turn(self, key: str, branch: str) -> dict:
        revision = self.gateway.current_revision(self.workspace_id, branch)
        manifest_id = f"manifest-{key}"
        manifest = {
            "manifest_id": manifest_id, "base_revision": revision,
            "workspace_id": self.workspace_id, "branch_id": branch,
            "actor": {"entity_id": "hero"}, "included": [], "excluded": [],
        }
        return self.command(key, branch, "append_story_turn", {
            "conversation_id": "custom-conversation", "user_content": "Search the shelves.",
            "assistant_content": "A salt-stiff ledger lies beneath the atlas.",
            "provider": "ollama", "model": "local-test", "narrative_order": 1,
            "context_revision": revision, "context_manifest_id": manifest_id,
            "context_manifest": manifest,
        })

    def test_world_pinned_dice_skills_and_experience_are_deterministic(self) -> None:
        initial = self.gateway.get_rpg_state(self.workspace_id, "custom-adventure", "custom-adventure")
        self.assertEqual(initial["mechanics"]["mode"], "custom_dice")
        self.assertEqual(initial["sheet"]["skills"], {"lore": 1})
        self.assertEqual(initial["sheet"]["experience"]["total_xp"], 5)

        revised_content = {
            "starting_location": "Salt Library", "stats": {"cunning": 2},
            "game_mechanics": mechanics_profile(mode="custom_dice", dice={
                "count": 1, "sides": 8, "resolution": "sum",
                "success_threshold": None, "include_attribute": False,
            }),
        }
        main_revision = self.gateway.current_revision(self.workspace_id, "main")
        self.gateway.execute(
            workspace_id=self.workspace_id, branch_id="main", expected_revision=main_revision,
            idempotency_key="revise-custom-world", command_type="revise_story_world",
            payload={"world_id": "custom-world", "expected_world_version": 1,
                     "name": "The Salt Library", "template_key": "fantasy", "content": revised_content},
            actor="user", reason="Revise future world rules",
        )
        pinned = self.gateway.get_rpg_state(self.workspace_id, "custom-adventure", "custom-adventure")
        self.assertEqual(pinned["adventure"]["world_version"], 1)
        self.assertEqual(pinned["mechanics"]["dice"]["sides"], 6)

        check = self.command("configured-check", "custom-adventure", "record_rpg_mechanic_check", {
            "adventure_id": "custom-adventure", "check_id": "library-check",
            "encounter_type": "investigation", "difficulty_id": "standard",
            "stat_name": "cunning", "skill_id": "lore", "dice_rolls": [4, 2],
        })
        self.assertEqual(check["dice_rolls"], [4, 2])
        self.assertEqual(check["modifier"], 3)
        self.assertEqual(check["total"], 4)
        self.assertEqual(check["outcome"], "success")

        changed_skills = self.command("advance-skill", "custom-adventure", "update_story_skills", {
            "adventure_id": "custom-adventure", "skill_ranks": {"lore": 3},
        })
        self.assertEqual(changed_skills["skill_ranks"], {"lore": 3})
        with self.assertRaisesRegex(ValidationError, "pinned world rule"):
            self.command("invalid-skill", "custom-adventure", "update_story_skills", {
                "adventure_id": "custom-adventure", "skill_ranks": {"lore": 6},
            })

        turn = self.append_player_turn("complete-player-turn", "custom-adventure")
        after_turn = self.gateway.get_rpg_state(self.workspace_id, "custom-adventure", "custom-adventure")
        self.assertEqual(after_turn["adventure"]["completed_turns"], 1)
        self.assertEqual(after_turn["sheet"]["experience"]["automatic_xp"], 3)
        self.assertEqual(after_turn["sheet"]["experience"]["total_xp"], 8)

        historic = self.gateway.get_rpg_state(
            self.workspace_id, "custom-adventure", "custom-adventure", as_of_revision=turn["revision"],
        )
        self.assertEqual(historic["sheet"]["skills"], {"lore": 3})
        self.assertEqual(historic["sheet"]["experience"]["total_xp"], 8)
        awarded = self.command("award-xp", "custom-adventure", "award_story_experience", {
            "adventure_id": "custom-adventure", "amount": 4,
        })
        self.assertEqual(awarded["experience"]["total_xp"], 12)

        narrative_state = self.gateway.get_rpg_state(
            self.workspace_id, "narrative-adventure", "narrative-adventure",
        )
        self.assertEqual(narrative_state["mechanics"]["mode"], "narrative_only")
        with self.assertRaisesRegex(ValidationError, "narrative-only"):
            self.command("narrative-roll", "narrative-adventure", "record_rpg_mechanic_check", {
                "adventure_id": "narrative-adventure", "encounter_type": "combat",
                "difficulty_id": "standard", "stat_name": "cunning", "dice_rolls": [1],
            })
        self.assertEqual(self.gateway.get_rpg_state(
            self.workspace_id, "narrative-adventure", "narrative-adventure",
        )["mechanic_checks"], [])

    def test_branch_snapshot_and_portable_package_preserve_mechanics_state(self) -> None:
        self.command("configured-check", "custom-adventure", "record_rpg_mechanic_check", {
            "adventure_id": "custom-adventure", "check_id": "portable-check",
            "encounter_type": "investigation", "difficulty_id": "standard",
            "stat_name": "cunning", "skill_id": "lore", "dice_rolls": [4, 2],
        })
        self.command("advance-skill", "custom-adventure", "update_story_skills", {
            "adventure_id": "custom-adventure", "skill_ranks": {"lore": 3},
        })
        self.append_player_turn("complete-player-turn", "custom-adventure")
        self.command("award-xp", "custom-adventure", "award_story_experience", {
            "adventure_id": "custom-adventure", "amount": 4,
        })

        fork_revision = self.gateway.current_revision(self.workspace_id, "custom-adventure")
        self.gateway.create_branch(
            self.workspace_id, "custom-adventure", "mechanics-alt", fork_revision, "fork-mechanics-alt",
        )
        forked = self.gateway.get_rpg_state(self.workspace_id, "mechanics-alt", "custom-adventure")
        self.assertEqual(forked["sheet"]["skills"], {"lore": 3})
        self.assertEqual(forked["sheet"]["experience"]["total_xp"], 12)
        self.assertEqual([item["check_id"] for item in forked["mechanic_checks"]], ["portable-check"])
        self.command("fork-skill-change", "mechanics-alt", "update_story_skills", {
            "adventure_id": "custom-adventure", "skill_ranks": {"lore": 4},
        })
        self.command("fork-check", "mechanics-alt", "record_rpg_mechanic_check", {
            "adventure_id": "custom-adventure", "check_id": "fork-only-check",
            "encounter_type": "investigation", "difficulty_id": "standard",
            "stat_name": "cunning", "skill_id": "lore", "dice_rolls": [4, 2],
        })
        parent_state = self.gateway.get_rpg_state(self.workspace_id, "custom-adventure", "custom-adventure")
        child_state = self.gateway.get_rpg_state(self.workspace_id, "mechanics-alt", "custom-adventure")
        self.assertEqual(parent_state["sheet"]["skills"], {"lore": 3})
        self.assertEqual([item["check_id"] for item in parent_state["mechanic_checks"]], ["portable-check"])
        self.assertEqual(child_state["sheet"]["skills"], {"lore": 4})
        self.assertEqual({item["check_id"] for item in child_state["mechanic_checks"]},
                         {"portable-check", "fork-only-check"})

        package = self.gateway.export_story_adventure_package(
            self.workspace_id, "custom-adventure", "custom-adventure",
            export_mode="full_private_archive", confirm_private=True,
        )
        self.assertEqual(package["adventure"]["sheet"]["skill_ranks"], {"lore": 3})
        self.assertEqual(package["adventure"]["sheet"]["experience"]["manual_awards"], 4)
        self.assertEqual(package["adventure"]["mechanic_checks"][0]["check_id"], "portable-check")
        imported = self.gateway.import_story_adventure_bundle(
            workspace_id=self.destination_id, expected_revision=0,
            idempotency_key="portable-mechanics-adventure", adventure_id="portable-adventure",
            package=package,
        )
        restored = self.gateway.get_rpg_state(
            self.destination_id, "portable-adventure", "portable-adventure",
        )
        self.assertTrue(imported["world_imported"])
        self.assertEqual(restored["mechanics"]["dice"]["sides"], 6)
        self.assertEqual(restored["sheet"]["skills"], {"lore": 3})
        self.assertEqual(restored["sheet"]["experience"]["total_xp"], 12)
        self.assertEqual([item["check_id"] for item in restored["mechanic_checks"]], ["portable-check"])

    def test_api_rolls_configured_dice_once_and_rejects_narrative_only(self) -> None:
        app = create_app(self.database, auth_token="test-token")

        def request(path: str, body: dict) -> httpx.Response:
            async def send() -> httpx.Response:
                transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 8000))
                async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                    return await client.post(path, headers={"Authorization": "Bearer test-token"}, json=body)
            return asyncio.run(send())

        revision = self.gateway.current_revision(self.workspace_id, "custom-adventure")
        body = {
            "branch_id": "custom-adventure", "expected_revision": revision,
            "idempotency_key": "api-configured-check", "encounter_type": "investigation",
            "difficulty_id": "standard", "stat_name": "cunning", "skill_id": "lore",
        }
        path = "/api/v1/workspaces/mechanics-workspace/story/adventures/custom-adventure/mechanic-checks"
        with patch("lke.api.app.secrets.randbelow", side_effect=[1, 5]) as random_roll:
            first = request(path, body)
            replay = request(path, body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertFalse(first.json()["idempotent_replay"])
        self.assertEqual(first.json()["dice_rolls"], [2, 6])
        self.assertTrue(replay.json()["idempotent_replay"])
        self.assertEqual(replay.json()["dice_rolls"], [2, 6])
        self.assertEqual(random_roll.call_count, 2)

        narrative_revision = self.gateway.current_revision(self.workspace_id, "narrative-adventure")
        narrative = request(
            "/api/v1/workspaces/mechanics-workspace/story/adventures/narrative-adventure/mechanic-checks",
            {"branch_id": "narrative-adventure", "expected_revision": narrative_revision,
             "idempotency_key": "api-narrative-check", "encounter_type": "combat",
             "difficulty_id": "standard", "stat_name": "cunning"},
        )
        self.assertEqual(narrative.status_code, 409, narrative.text)


if __name__ == "__main__":
    unittest.main()
