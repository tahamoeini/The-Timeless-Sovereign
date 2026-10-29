"""Actor-safe retrieval over adventure memories and source transcript turns."""

import unittest

from lke.retrieval.story_memory import (
    bounded_story_history, restrict_retry_context, select_story_episodes, select_story_memories,
    situation_dependency_revision,
)


class StoryMemoryRetrievalTests(unittest.TestCase):
    def test_recent_history_excludes_future_and_superseded_turns(self):
        turns = [
            {"role": "user", "content": "Ask about the harbor.", "narrative_order": 2, "status": "active"},
            {"role": "assistant", "content": "The harbor is quiet.", "narrative_order": 2, "status": "active"},
            {"role": "assistant", "content": "A hidden future is revealed.", "narrative_order": 8, "status": "active"},
            {"role": "assistant", "content": "A discarded account.", "narrative_order": 1, "status": "superseded"},
        ]
        self.assertEqual(bounded_story_history(turns, 2), [
            {"role": "user", "content": "Ask about the harbor."},
            {"role": "assistant", "content": "The harbor is quiet."},
        ])

    def memory(
        self, memory_id, content, *, scope="shared", known_by=None, importance=3,
        order=1, status="accepted", enabled=True,
    ):
        return {
            "memory_id": memory_id,
            "version": 1,
            "kind": "event",
            "content": content,
            "context_enabled": enabled,
            "review_status": status,
            "source_turn_id": f"turn-{memory_id}",
            "narrative_order": order,
            "created_revision": order,
            "importance": importance,
            "knowledge_scope": scope,
            "known_by": known_by or [],
        }

    def test_permissions_and_time_are_applied_before_relevance_ranking(self):
        result = select_story_memories([
            self.memory("shared", "The silver key opens the east gate."),
            self.memory("hero", "Mira hid the silver key.", scope="actors", known_by=["hero"]),
            self.memory("npc", "The ferryman knows about the silver key.", scope="actors", known_by=["ferryman"]),
            self.memory("author", "Do not reveal who forged the key yet.", scope="author"),
            self.memory("private", "A private note about the silver key.", scope="private"),
            self.memory("future", "The key breaks in the final chamber.", order=9),
            self.memory("pending", "The key is cursed.", status="proposed"),
            self.memory("disabled", "The key belongs to Mira.", enabled=False),
        ], actor_entity_id="hero", as_of_narrative_order=5, query="silver key")

        selected_ids = {item["memory_id"] for item in result["memories"]}
        self.assertEqual(selected_ids, {"shared", "hero"})
        self.assertEqual([item["memory_id"] for item in result["author_notes"]], ["author"])
        reasons = {item["memory_id"]: item["reason"] for item in result["excluded_memories"]}
        self.assertEqual(reasons["npc"], "actor_not_authorized")
        self.assertEqual(reasons["private"], "private_memory")
        self.assertEqual(reasons["future"], "future_memory")
        self.assertEqual(reasons["pending"], "review_status:proposed")
        self.assertEqual(reasons["disabled"], "context_disabled")

    def test_importance_breaks_relevance_ties_and_context_budget_is_explained(self):
        result = select_story_memories([
            self.memory("minor", "A silver key rests near the locked door.", importance=1),
            self.memory("major", "The silver key rests near the locked door.", importance=5),
            self.memory("too-large", "The silver key " + ("detail " * 100), importance=5),
        ], actor_entity_id="hero", as_of_narrative_order=2, query="silver key", character_budget=90)

        self.assertEqual(result["memories"][0]["memory_id"], "major")
        excluded = {item["memory_id"]: item["reason"] for item in result["excluded_memories"]}
        self.assertEqual(excluded["too-large"], "context_budget")

    def test_sourced_memories_are_omitted_if_their_turn_changes_or_leaves_history(self):
        memories = [self.memory(name, "A key appeared.") for name in ("valid", "changed", "inactive", "missing")]
        turns = [
            {"turn_id": "turn-valid", "status": "active", "edit_history": []},
            {"turn_id": "turn-changed", "status": "active", "edit_history": [{"created_revision": 2}]},
            {"turn_id": "turn-inactive", "status": "superseded", "edit_history": []},
        ]
        result = select_story_memories(
            memories, actor_entity_id="hero", as_of_narrative_order=5,
            query="key", source_turns=turns,
        )
        self.assertEqual([item["memory_id"] for item in result["memories"]], ["valid"])
        reasons = {item["memory_id"]: item["reason"] for item in result["excluded_memories"]}
        self.assertEqual(reasons["changed"], "source_turn_changed")
        self.assertEqual(reasons["inactive"], "source_turn_inactive")
        self.assertEqual(reasons["missing"], "source_turn_outside_history")

    def test_situation_is_excluded_after_its_scene_location_or_threads_change(self):
        situation = {**self.memory("situation", "At the harbor."), "kind": "situation", "source_turn_id": None,
                     "created_revision": 10}
        cases = [
            ([{"created_revision": 11}], {"updated_revision": 2}, []),
            ([{"created_revision": 3, "edit_history": [{"created_revision": 11}]}], {"updated_revision": 2}, []),
            ([], {"updated_revision": 11}, []),
            ([], {"updated_revision": 2}, [{"updated_revision": 11}]),
        ]
        for turns, sheet, threads in cases:
            with self.subTest(turns=turns, sheet=sheet, threads=threads):
                result = select_story_memories(
                    [situation], actor_entity_id="hero", as_of_narrative_order=5, query="harbor",
                    situation_revision=situation_dependency_revision(turns, sheet, threads),
                )
                self.assertEqual(result["memories"], [])
                self.assertEqual(result["excluded_memories"][0]["reason"], "stale_situation")

        result = select_story_memories(
            [situation], actor_entity_id="hero", as_of_narrative_order=5, query="harbor",
            situation_revision=10,
        )
        self.assertEqual([item["memory_id"] for item in result["memories"]], ["situation"])

    def test_context_toggle_does_not_refresh_stale_situation(self):
        original = {**self.memory("situation", "At the harbor."), "kind": "situation", "source_turn_id": None,
                    "created_revision": 5}
        toggled = {**original, "version": 2, "created_revision": 12}
        result = select_story_memories(
            [toggled], actor_entity_id="hero", as_of_narrative_order=5, query="harbor",
            situation_revision=10, memory_history={"situation": [original, toggled]},
        )
        self.assertEqual(result["excluded_memories"][0]["reason"], "stale_situation")
        rereviewed = {**toggled, "version": 3, "created_revision": 13, "reviewed_revision": 14}
        result = select_story_memories(
            [rereviewed], actor_entity_id="hero", as_of_narrative_order=5, query="harbor",
            situation_revision=10, memory_history={"situation": [original, toggled, rereviewed]},
        )
        self.assertEqual([item["memory_id"] for item in result["memories"]], ["situation"])
        rebuilt = {**toggled, "version": 3, "content": "Now at the market.", "created_revision": 13}
        result = select_story_memories(
            [rebuilt], actor_entity_id="hero", as_of_narrative_order=5, query="market",
            situation_revision=10, memory_history={"situation": [original, toggled, rebuilt]},
        )
        self.assertEqual([item["memory_id"] for item in result["memories"]], ["situation"])

    def test_context_toggle_does_not_refresh_memory_from_an_edited_turn(self):
        original = {**self.memory("event", "A key appeared."), "created_revision": 5}
        toggled = {**original, "version": 2, "created_revision": 12}
        result = select_story_memories(
            [toggled], actor_entity_id="hero", as_of_narrative_order=5, query="key",
            source_turns=[{"turn_id": "turn-event", "status": "active", "edit_history": [{"created_revision": 10}]}],
            memory_history={"event": [original, toggled]},
        )
        self.assertEqual(result["excluded_memories"][0]["reason"], "source_turn_changed")

    def test_older_transcript_details_are_retrieved_with_source_turn_ids(self):
        turns = [
            {"turn_id": "old-user", "role": "user", "narrative_order": 1, "status": "active",
             "content": "Remember that the silver key is hidden under the ferry bell."},
            {"turn_id": "old-assistant", "role": "assistant", "narrative_order": 2, "status": "active",
             "content": "The ferryman rings the bell once."},
            {"turn_id": "recent", "role": "assistant", "narrative_order": 8, "status": "active",
             "content": "Mira waits by the harbor."},
            {"turn_id": "future", "role": "assistant", "narrative_order": 10, "status": "active",
             "content": "The silver key opens the final vault."},
            {"turn_id": "superseded", "role": "assistant", "narrative_order": 3, "status": "superseded",
             "content": "The silver key was made of glass."},
        ]
        result = select_story_episodes(
            turns, as_of_narrative_order=9, query="where is the silver key",
            recent_character_budget=30, character_budget=1000,
        )

        self.assertEqual([item["turn_id"] for item in result["episodes"]], ["old-user"])
        self.assertIn("hidden under the ferry bell", result["episodes"][0]["content"])
        reasons = {item.get("turn_id"): item["reason"] for item in result["excluded_episodes"]}
        self.assertEqual(reasons["future"], "future_turn")
        self.assertEqual(reasons["superseded"], "turn_not_active")
        self.assertEqual(reasons["old-assistant"], "no_query_match")
        self.assertNotIn("recent", reasons)

    def test_retry_uses_recorded_fact_values_and_historical_story_snapshot(self):
        original = {
            "base_revision": 10,
            "manifest_id": "scene-manifest-10",
            "included": [
                {"claim_id": "gate", "object": "The gate opens at dawn."},
                {"claim_id": "secret", "object": "The ferryman betrayed Mira."},
            ],
            "story": {
                "character_sheet": {"level": 1, "updated_revision": 8},
                "recent_checks": [{"check_id": "check-old", "outcome": "success"}],
                "memories": [{"memory_id": "event-old", "content": "Mira found a brass key.",
                              "created_revision": 7, "updated_revision": 7}],
                "author_notes": [{"memory_id": "note-old", "content": "Keep the ferryman's motive hidden.",
                                  "created_revision": 6, "updated_revision": 6}],
                "open_threads": [{"thread_id": "thread-old", "content": "Who forged the key?",
                                  "created_revision": 5, "updated_revision": 5}],
                "public_npcs": [{"entity_id": "npc-old", "name": "Ilan", "created_revision": 4,
                                 "updated_revision": 4}],
                "approved_locations": ["Harbor", "Old tower"],
                "retrieved_episodes": [{"turn_id": "turn-old", "content": "Ilan rang the bell twice."}],
                "excluded_episode_count": 0,
            },
        }
        current = {
            "base_revision": 20,
            "included": [
                {"claim_id": "gate", "object": "The gate opens only after Mira's trial."},
                {"claim_id": "new-fact", "object": "The ferryman is the prince."},
            ],
            "excluded": [{"claim_id": "secret", "reason": "author_only"}],
            "story": {
                "character_sheet": {"level": 4, "updated_revision": 18},
                "recent_checks": [{"check_id": "check-new", "outcome": "failure"}],
                "memories": [
                    {"memory_id": "event-old", "content": "Mira gave away the brass key.",
                     "created_revision": 7, "updated_revision": 16},
                    {"memory_id": "event-new", "content": "The ferryman was unmasked.",
                     "created_revision": 17, "updated_revision": 17},
                ],
                "author_notes": [{"memory_id": "note-new", "content": "Reveal the prince now.",
                                  "created_revision": 17, "updated_revision": 17}],
                "open_threads": [
                    {"thread_id": "thread-old", "content": "Who forged the key?", "created_revision": 5,
                     "updated_revision": 5},
                    {"thread_id": "thread-new", "content": "Why was Ilan at the palace?", "created_revision": 17,
                     "updated_revision": 17},
                ],
                "public_npcs": [{"entity_id": "npc-old", "name": "Ilan, the prince", "created_revision": 4,
                                 "updated_revision": 18}],
                "approved_locations": ["Harbor", "Palace"],
                "retrieved_episodes": [
                    {"turn_id": "turn-old", "content": "Ilan rang the bell once."},
                    {"turn_id": "turn-new", "content": "Ilan entered the palace."},
                ],
                "excluded_episode_count": 0,
            },
        }

        result = restrict_retry_context(current, original, original_revision=10)

        self.assertEqual(result["included"], original["included"][:1])
        self.assertEqual(result["excluded"][-1], {"claim_id": "new-fact", "reason": "not_in_original_turn_context"})
        self.assertEqual(result["story"]["character_sheet"], original["story"]["character_sheet"])
        self.assertEqual(result["story"]["recent_checks"], original["story"]["recent_checks"])
        self.assertEqual(result["story"]["memories"], [])
        self.assertEqual(result["story"]["author_notes"], [])
        self.assertEqual(result["story"]["open_threads"], original["story"]["open_threads"])
        self.assertEqual(result["story"]["public_npcs"], [])
        self.assertEqual(result["story"]["approved_locations"], ["Harbor"])
        self.assertEqual(result["story"]["retrieved_episodes"], [])
        self.assertEqual(result["story"]["excluded_episode_count"], 1)

    def test_retry_without_a_saved_story_snapshot_does_not_add_current_rpg_state(self):
        result = restrict_retry_context(
            {"included": [], "excluded": [], "story": {"character_sheet": {"level": 9}}},
            {"base_revision": 4, "included": [], "excluded": []},
            original_revision=4,
        )

        self.assertNotIn("story", result)


if __name__ == "__main__":
    unittest.main()
