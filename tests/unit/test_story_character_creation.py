"""World-defined character creation rules and point-buy validation."""

from __future__ import annotations

import asyncio
import unittest

import httpx

from lke.api.app import create_app
from lke.core import CommandGateway, Database, ValidationError


class StoryCharacterCreationTests(unittest.TestCase):
    stat_names = ("might", "agility", "insight", "presence", "will", "charm", "craft")

    def setUp(self) -> None:
        self.database = Database(":memory:")
        self.gateway = CommandGateway(self.database)
        self.workspace_id = "character-creation"
        self.gateway.create_workspace("Character creation", self.workspace_id)
        self.command("hero", "create_entity", {
            "entity_id": "hero", "entity_type": "character", "label": "Mira", "properties": {},
        })
        self.command("world", "create_story_world", {
            "world_id": "seven-stat-world", "name": "Seven Stat World", "template_key": "custom",
            "content": self.world_content(),
        })
        self.main_revision = self.gateway.current_revision(self.workspace_id, "main")
        self.app = create_app(self.database, auth_token="test-token")

    def tearDown(self) -> None:
        self.database.close()

    def world_content(self, *, point_budget: int = 10, allow_unspent: bool = False) -> dict:
        return {
            "starting_location": "The Crossroads",
            "stats": {name: 0 for name in self.stat_names},
            "trackers": {"health": {"value": 8, "max": 10}},
            "character_creation": {
                "point_budget": point_budget,
                "allow_unspent_points": allow_unspent,
                "allow_below_baseline": False,
                "stats": {
                    name: {"label": name.title(), "minimum": 0, "maximum": 5, "point_cost": 1}
                    for name in self.stat_names
                },
            },
        }

    def allocation(self, **updates: int) -> dict[str, int]:
        values = {name: 0 for name in self.stat_names}
        values.update(updates)
        return values

    def command(self, key: str, command_type: str, payload: dict) -> dict:
        return self.gateway.execute(
            workspace_id=self.workspace_id, branch_id="main",
            expected_revision=self.gateway.current_revision(self.workspace_id, "main"),
            idempotency_key=key, command_type=command_type, payload=payload,
            actor="user", reason="Character creation contract",
        )

    def create_adventure(self, adventure_id: str, stats: dict[str, int]) -> dict:
        self.gateway.create_branch(
            self.workspace_id, "main", adventure_id, self.main_revision, f"{adventure_id}-snapshot",
        )
        return self.gateway.execute(
            workspace_id=self.workspace_id, branch_id=adventure_id,
            expected_revision=self.main_revision, idempotency_key=f"{adventure_id}-create",
            command_type="create_story_adventure", actor="user", reason="Start a point-buy adventure",
            payload={
                "adventure_id": adventure_id, "world_id": "seven-stat-world", "world_version": 1,
                "conversation_id": f"conversation-{adventure_id}", "name": adventure_id,
                "actor_entity_id": "hero", "stats": stats,
            },
        )

    def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        async def send() -> httpx.Response:
            transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 8000))
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.request(method, path, **kwargs)

        return asyncio.run(send())

    def test_seven_world_stats_accept_and_persist_exact_ten_points(self) -> None:
        stats = self.allocation(might=2, agility=2, insight=2, presence=1, will=1, charm=1, craft=1)
        self.create_adventure("valid-adventure", stats)

        sheet = self.gateway.get_rpg_state(self.workspace_id, "valid-adventure", "valid-adventure")["sheet"]
        self.assertEqual(sheet["stats"], stats)
        self.assertEqual(sheet["trackers"], {"health": {"value": 8, "max": 10}})

    def test_gateway_rejects_overspending_under_spending_and_out_of_bounds(self) -> None:
        invalid_allocations = {
            "overspend": self.allocation(might=5, agility=5, insight=1),
            "underspend": self.allocation(might=5, agility=4),
            "out-of-bounds": self.allocation(might=6, agility=4),
            "missing-stat": {name: 0 for name in self.stat_names[:-1]} | {"might": 10},
        }
        for name, stats in invalid_allocations.items():
            with self.subTest(name=name), self.assertRaises(ValidationError):
                self.create_adventure(f"invalid-{name}", stats)
            self.assertEqual(
                self.gateway.current_revision(self.workspace_id, f"invalid-{name}"), self.main_revision,
            )

    def test_api_preflights_invalid_allocation_before_creating_branch(self) -> None:
        response = self.request(
            "POST", f"/api/v1/workspaces/{self.workspace_id}/story/adventures",
            headers={"Authorization": "Bearer test-token"},
            json={
                "expected_revision": self.main_revision, "idempotency_key": "api-overspend",
                "adventure_id": "api-invalid", "world_id": "seven-stat-world", "world_version": 1,
                "conversation_id": "api-invalid-conversation", "name": "Invalid", "actor_entity_id": "hero",
                "stats": self.allocation(might=5, agility=5, insight=1),
            },
        )

        self.assertEqual(response.status_code, 422)
        self.assertNotIn("api-invalid", {item["branch_id"] for item in self.gateway.list_branches(self.workspace_id)})

    def test_public_world_export_keeps_the_point_buy_contract(self) -> None:
        package = self.gateway.export_world_package(
            self.workspace_id, "seven-stat-world", export_mode="public_world",
        )

        exported = package["versions"][0]["content"]
        self.assertEqual(exported["character_creation"], self.world_content()["character_creation"])

    def test_optional_below_baseline_rule_can_fund_increases(self) -> None:
        content = self.world_content()
        content["character_creation"]["allow_below_baseline"] = True
        for definition in content["character_creation"]["stats"].values():
            definition["minimum"] = -2
        self.command("below-baseline-world", "create_story_world", {
            "world_id": "below-baseline-world", "name": "Flexible World", "template_key": "custom",
            "content": content,
        })
        stats = self.allocation(might=-1, agility=3, insight=2, presence=2, will=2, charm=1, craft=1)

        validated = self.gateway.validate_story_character_allocation(
            self.workspace_id, "below-baseline-world", 1, stats,
        )

        self.assertEqual(validated, stats)

    def test_optional_unspent_rule_allows_a_partial_budget(self) -> None:
        content = self.world_content(allow_unspent=True)
        self.command("unspent-world", "create_story_world", {
            "world_id": "unspent-world", "name": "Flexible Budget World", "template_key": "custom",
            "content": content,
        })
        stats = self.allocation(might=5, agility=4)

        validated = self.gateway.validate_story_character_allocation(
            self.workspace_id, "unspent-world", 1, stats,
        )

        self.assertEqual(validated, stats)

    def test_world_rejects_incomplete_or_duplicate_creation_rules(self) -> None:
        incomplete = self.world_content()
        incomplete["character_creation"]["stats"].pop("craft")
        with self.assertRaises(ValidationError):
            self.command("bad-world-incomplete", "create_story_world", {
                "world_id": "bad-incomplete", "name": "Incomplete", "template_key": "custom", "content": incomplete,
            })

        duplicate = self.world_content()
        duplicate["stats"] = {"Might": 0, "might": 0}
        duplicate["character_creation"]["stats"] = {
            name: {"label": name, "minimum": 0, "maximum": 5, "point_cost": 1}
            for name in duplicate["stats"]
        }
        with self.assertRaises(ValidationError):
            self.command("bad-world-duplicate", "create_story_world", {
                "world_id": "bad-duplicate", "name": "Duplicate", "template_key": "custom", "content": duplicate,
            })


if __name__ == "__main__":
    unittest.main()
