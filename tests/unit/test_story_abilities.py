"""World-pinned exceptional abilities retain their declared mechanics."""

from __future__ import annotations

import asyncio
import unittest

import httpx

from lke.api.app import _story_messages, create_app
from lke.core import CommandGateway, Database, ValidationError


def ability(
    ability_id: str,
    name: str,
    *,
    costs: list[dict[str, object]] | None = None,
    cooldown_turns: int | None = None,
) -> dict[str, object]:
    return {
        "ability_id": ability_id,
        "name": name,
        "description": f"{name} follows its recorded definition.",
        "category": "Temporal",
        "source": "Innate",
        "activation": "Will it into effect.",
        "deactivation": "Release the effect.",
        "effects": ["Stops time in the stated area."],
        "costs": costs or [],
        "cooldown_turns": cooldown_turns,
        "duration": "Until manually deactivated",
        "range": "The established local area",
        "magic_interactions": ["Ordinary magic does not shorten the effect."],
        "demonstrated_capabilities": ["Time remains stopped while the user acts."],
        "confirmed_limitations": [],
        "unresolved_aspects": ["The effect on distant clocks is unknown."],
    }


class StoryAbilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.workspace_id = "exceptional-abilities"
        self.gateway.create_workspace("Exceptional abilities", self.workspace_id)
        self.command("hero", "create_entity", {
            "entity_id": "hero", "entity_type": "character", "label": "Mira", "properties": {},
        })
        self.command("world", "create_story_world", {
            "world_id": "ability-world", "name": "Ability World", "template_key": "custom",
            "content": {
                "stats": {"might": 0, "insight": 0},
                "trackers": {"health": {"value": 8, "max": 10}, "mana": {"value": 0, "max": 10}},
                "starting_location": "The Crossroads",
                "abilities": [
                    ability("time-stop", "Time Stop"),
                    ability("flame-burst", "Flame Burst", costs=[{"resource": "mana", "amount": 1}], cooldown_turns=2),
                ],
            },
        })
        self.world_revision = self.gateway.current_revision(self.workspace_id, "main")
        self.branch_id = "ability-adventure"
        self.gateway.create_branch(self.workspace_id, "main", self.branch_id, self.world_revision, "ability-snapshot")
        self.command_on(self.branch_id, "adventure", "create_story_adventure", {
            "adventure_id": self.branch_id, "world_id": "ability-world", "world_version": 1,
            "conversation_id": "ability-conversation", "name": "Time at the Crossroads", "actor_entity_id": "hero",
        }, expected_revision=self.world_revision)

    def tearDown(self) -> None:
        self.database.close()

    def command(self, key: str, command_type: str, payload: dict) -> dict:
        return self.command_on("main", key, command_type, payload)

    def command_on(
        self, branch_id: str, key: str, command_type: str, payload: dict, *, expected_revision: int | None = None,
    ) -> dict:
        return self.gateway.execute(
            workspace_id=self.workspace_id,
            branch_id=branch_id,
            expected_revision=expected_revision if expected_revision is not None else self.gateway.current_revision(self.workspace_id, branch_id),
            idempotency_key=key,
            command_type=command_type,
            payload=payload,
            actor="user",
            reason="Player-defined ability behavior",
        )

    def activate(self, key: str, ability_id: str, active: bool = True) -> dict:
        return self.command_on(self.branch_id, key, "set_story_ability_active", {
            "adventure_id": self.branch_id, "ability_id": ability_id, "active": active,
        })

    def test_unlimited_time_stop_works_at_zero_mana_without_a_roll(self) -> None:
        initial_revision = self.gateway.current_revision(self.workspace_id, self.branch_id)
        initial = self.gateway.get_rpg_state(self.workspace_id, self.branch_id, self.branch_id)
        time_stop = next(item for item in initial["sheet"]["abilities"] if item["ability_id"] == "time-stop")
        self.assertEqual(time_stop["costs"], [])
        self.assertIsNone(time_stop["cooldown_turns"])
        self.assertEqual(initial["sheet"]["trackers"]["mana"]["value"], 0)

        first_use = self.activate("time-stop-once", "time-stop")
        self.activate("time-stop-off", "time-stop", False)
        self.activate("time-stop-twice", "time-stop")

        final = self.gateway.get_rpg_state(self.workspace_id, self.branch_id, self.branch_id)
        state = next(item for item in final["sheet"]["abilities"] if item["ability_id"] == "time-stop")
        self.assertTrue(state["is_active"])
        self.assertEqual(state["activation_count"], 2)
        self.assertEqual(final["sheet"]["trackers"]["mana"]["value"], 0)
        self.assertEqual(final["checks"], [])
        historical = self.gateway.get_rpg_state(
            self.workspace_id, self.branch_id, self.branch_id, as_of_revision=initial_revision,
        )
        self.assertFalse(next(item for item in historical["sheet"]["abilities"] if item["ability_id"] == "time-stop")["is_active"])
        at_first_use = self.gateway.get_rpg_state(
            self.workspace_id, self.branch_id, self.branch_id, as_of_revision=first_use["revision"],
        )
        self.assertTrue(next(item for item in at_first_use["sheet"]["abilities"] if item["ability_id"] == "time-stop")["is_active"])

    def test_explicit_mana_cost_and_cooldown_are_enforced(self) -> None:
        revision = self.gateway.current_revision(self.workspace_id, self.branch_id)
        with self.assertRaisesRegex(ValidationError, "needs 1 mana"):
            self.activate("flame-without-mana", "flame-burst")
        self.assertEqual(self.gateway.current_revision(self.workspace_id, self.branch_id), revision)
        self.command_on(self.branch_id, "give-mana", "update_rpg_sheet", {
            "adventure_id": self.branch_id, "trackers": {"health": {"value": 8, "max": 10}, "mana": {"value": 2, "max": 10}},
        })
        self.activate("flame-ready", "flame-burst")
        state = self.gateway.get_rpg_state(self.workspace_id, self.branch_id, self.branch_id)
        self.assertEqual(state["sheet"]["trackers"]["mana"]["value"], 1)
        flame = next(item for item in state["sheet"]["abilities"] if item["ability_id"] == "flame-burst")
        self.assertEqual(flame["ready_after_turn"], 2)
        self.activate("flame-off", "flame-burst", False)
        revision = self.gateway.current_revision(self.workspace_id, self.branch_id)
        with self.assertRaisesRegex(ValidationError, "cooldown"):
            self.activate("flame-too-soon", "flame-burst")
        self.assertEqual(self.gateway.current_revision(self.workspace_id, self.branch_id), revision)

    def test_world_and_adventure_packages_preserve_ability_definitions_and_state(self) -> None:
        self.activate("export-time-stop", "time-stop")
        world = self.gateway.export_world_package(self.workspace_id, "ability-world", export_mode="public_world")
        self.assertEqual(world["versions"][0]["content"]["abilities"][0]["name"], "Time Stop")
        package = self.gateway.export_story_adventure_package(
            self.workspace_id, self.branch_id, self.branch_id, export_mode="shareable_adventure",
        )
        self.assertTrue(next(item for item in package["adventure"]["sheet"]["ability_states"] if item["ability_id"] == "time-stop")["is_active"])

        self.gateway.create_workspace("Imported abilities", "abilities-import")
        imported = self.gateway.import_story_adventure_bundle(
            workspace_id="abilities-import", expected_revision=0, idempotency_key="import-abilities",
            adventure_id="imported-ability-adventure", package=package,
        )
        imported_state = self.gateway.get_rpg_state(
            "abilities-import", imported["branch_id"], "imported-ability-adventure",
        )
        ability_state = next(item for item in imported_state["sheet"]["abilities"] if item["ability_id"] == "time-stop")
        self.assertTrue(ability_state["is_active"])
        self.assertEqual(ability_state["demonstrated_capabilities"], ["Time remains stopped while the user acts."])

    def test_story_prompt_keeps_authoritative_ability_properties(self) -> None:
        ability_record = next(
            item for item in self.gateway.get_rpg_state(self.workspace_id, self.branch_id, self.branch_id)["sheet"]["abilities"]
            if item["ability_id"] == "time-stop"
        )
        messages = _story_messages(
            {"actor_is_user_controlled": True, "turns": []},
            {
                "actor": {"entity_id": "hero"}, "as_of_narrative_order": 1, "included": [], "excluded": [],
                "manifest_id": "manifest", "base_revision": self.world_revision,
                "story": {"character_sheet": {"abilities": [ability_record]}},
            },
            "Use Time Stop.",
        )
        self.assertIn("Time Stop", messages[0]["content"])
        self.assertIn("Time remains stopped while the user acts.", messages[0]["content"])
        self.assertIn("Do not add resource costs (including mana), checks, cooldowns", messages[0]["content"])
        self.assertIn("Keep confirmed limitations distinct from unresolved aspects", messages[0]["content"])

    def test_world_rejects_duplicate_ability_ids_and_unavailable_cost_contracts(self) -> None:
        content = {
            "stats": {"might": 0},
            "abilities": [ability("same", "First"), ability("same", "Second")],
        }
        with self.assertRaisesRegex(ValidationError, "unique"):
            self.command("duplicate-ability", "create_story_world", {
                "world_id": "duplicate-ability", "name": "Invalid", "content": content,
            })
        bad_cost = ability("bad-cost", "Bad Cost", costs=[{"resource": "mana", "amount": 0}])
        with self.assertRaisesRegex(ValidationError, "positive"):
            self.command("bad-cost", "create_story_world", {
                "world_id": "bad-cost", "name": "Invalid Cost", "content": {"stats": {"might": 0}, "abilities": [bad_cost]},
            })


if __name__ == "__main__":
    unittest.main()
