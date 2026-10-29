"""Actor-safe retrieval over adventure memories and source transcript turns."""

import unittest

from lke.retrieval.story_memory import bounded_story_history, select_story_episodes, select_story_memories


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


if __name__ == "__main__":
    unittest.main()
