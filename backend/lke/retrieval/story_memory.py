"""Permission-first recall for adventure memories and older transcript episodes."""

from __future__ import annotations

import re
from typing import Any


_STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
    "he", "her", "his", "how", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or",
    "our", "she", "that", "the", "their", "them", "there", "this", "to", "was", "we", "were",
    "what", "when", "where", "who", "why", "will", "with", "you", "your",
    "از", "اگر", "اما", "این", "آن", "برای", "به", "با", "تا", "در", "را", "که", "من", "ما",
    "او", "تو", "یک", "هم", "و", "یا",
}


def _terms(value: str) -> set[str]:
    return {
        term for term in re.findall(r"\w{2,}", value.casefold(), flags=re.UNICODE)
        if term not in _STOP_WORDS
    }


def _rank_score(text: str, query_terms: set[str], importance: int, order: int, latest_order: int) -> float:
    matching = query_terms & _terms(text)
    relevance = float(len(matching))
    recency = 0.5 * (order / latest_order) if latest_order > 0 else 0.0
    return relevance * 4.0 + max(1, min(5, importance)) * 0.65 + recency


def bounded_story_history(
    turns: list[dict[str, Any]], as_of_narrative_order: int, character_budget: int = 12_000
) -> list[dict[str, str]]:
    """Select recent active turns that are not later than the requested story time."""
    eligible = [
        turn for turn in turns
        if turn.get("status", "active") == "active"
        and turn.get("role") in {"user", "assistant"}
        and turn.get("narrative_order", 0) <= as_of_narrative_order
    ]
    selected: list[dict[str, str]] = []
    used = 0
    for turn in reversed(eligible):
        content = turn["content"]
        if used + len(content) > character_budget:
            break
        selected.append({"role": turn["role"], "content": content})
        used += len(content)
    return list(reversed(selected))


def select_story_memories(
    memories: list[dict[str, Any]],
    *,
    actor_entity_id: str,
    as_of_narrative_order: int,
    query: str,
    max_items: int = 12,
    character_budget: int = 4000,
    author_budget: int = 1500,
) -> dict[str, Any]:
    """Filter actor access before ranking; return selected and explained exclusions."""
    query_terms = _terms(query)
    latest_order = max((item.get("narrative_order", 0) for item in memories), default=0)
    actor_candidates: list[dict[str, Any]] = []
    author_candidates: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for memory in memories:
        memory_id = memory["memory_id"]
        reason = None
        if memory["review_status"] != "accepted":
            reason = f"review_status:{memory['review_status']}"
        elif not memory["context_enabled"]:
            reason = "context_disabled"
        elif memory["narrative_order"] > as_of_narrative_order:
            reason = "future_memory"
        elif memory.get("knowledge_scope") == "private":
            reason = "private_memory"
        elif memory.get("knowledge_scope") == "actors" and actor_entity_id not in memory.get("known_by", []):
            reason = "actor_not_authorized"
        elif memory.get("knowledge_scope") == "author":
            author_candidates.append(memory)
        else:
            actor_candidates.append(memory)
        if reason:
            excluded.append({"memory_id": memory_id, "reason": reason})

    def rank(items: list[dict[str, Any]]) -> list[tuple[float, dict[str, Any]]]:
        scored = [
            (
                _rank_score(item["content"], query_terms, item.get("importance", 3),
                            item["narrative_order"], latest_order),
                item,
            )
            for item in items
        ]
        scored.sort(key=lambda pair: (pair[0], pair[1]["created_revision"], pair[1]["memory_id"]), reverse=True)
        return scored

    selected: list[dict[str, Any]] = []
    used_characters = 0
    ranked_actor = rank(actor_candidates)
    for score, memory in ranked_actor:
        too_many = len(selected) >= max_items
        too_long = used_characters + len(memory["content"]) > character_budget
        if too_many or too_long:
            excluded.append({
                "memory_id": memory["memory_id"],
                "reason": "context_budget" if too_long else "lower_relevance",
                "selection_score": round(score, 3),
            })
            continue
        selected.append({**memory, "selection_score": round(score, 3)})
        used_characters += len(memory["content"])

    author_notes: list[dict[str, Any]] = []
    used_author_characters = 0
    for score, memory in rank(author_candidates):
        if used_author_characters + len(memory["content"]) > author_budget:
            excluded.append({
                "memory_id": memory["memory_id"],
                "reason": "author_context_budget",
                "selection_score": round(score, 3),
            })
            continue
        author_notes.append({**memory, "selection_score": round(score, 3)})
        used_author_characters += len(memory["content"])

    return {"memories": selected, "author_notes": author_notes, "excluded_memories": excluded}


def select_story_episodes(
    turns: list[dict[str, Any]],
    *,
    as_of_narrative_order: int,
    query: str,
    recent_character_budget: int = 12_000,
    max_items: int = 4,
    character_budget: int = 4_000,
    excerpt_limit: int = 2_000,
) -> dict[str, Any]:
    """Recall older active transcript turns without replacing or summarizing their source."""
    active_turns = [
        turn for turn in turns
        if turn.get("status", "active") == "active"
        and turn.get("role") in {"user", "assistant"}
        and turn.get("narrative_order", 0) <= as_of_narrative_order
    ]
    recent_ids: set[str] = set()
    used_recent = 0
    for turn in reversed(active_turns):
        content_length = len(turn.get("content", ""))
        if used_recent + content_length > recent_character_budget:
            break
        recent_ids.add(turn["turn_id"])
        used_recent += content_length

    eligible: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for turn in turns:
        turn_id = turn.get("turn_id")
        if turn.get("status", "active") != "active":
            excluded.append({"turn_id": turn_id, "reason": "turn_not_active"})
        elif turn.get("narrative_order", 0) > as_of_narrative_order:
            excluded.append({"turn_id": turn_id, "reason": "future_turn"})
        elif turn_id in recent_ids:
            continue
        elif turn.get("role") not in {"user", "assistant"}:
            excluded.append({"turn_id": turn_id, "reason": "unsupported_role"})
        else:
            eligible.append(turn)

    query_terms = _terms(query)
    latest_order = max((turn.get("narrative_order", 0) for turn in eligible), default=0)
    ranked: list[tuple[float, dict[str, Any]]] = []
    for turn in eligible:
        content_terms = _terms(turn.get("content", ""))
        if not query_terms or not query_terms.intersection(content_terms):
            excluded.append({"turn_id": turn.get("turn_id"), "reason": "no_query_match"})
        else:
            score = _rank_score(turn.get("content", ""), query_terms, 3, turn.get("narrative_order", 0), latest_order)
            ranked.append((score, turn))
    ranked.sort(key=lambda pair: (pair[0], pair[1].get("narrative_order", 0)), reverse=True)

    selected: list[dict[str, Any]] = []
    used_characters = 0
    for score, turn in ranked:
        content = turn.get("content", "")
        excerpt = content if len(content) <= excerpt_limit else content[:excerpt_limit]
        too_many = len(selected) >= max_items
        too_long = used_characters + len(excerpt) > character_budget
        if too_many or too_long:
            excluded.append({
                "turn_id": turn.get("turn_id"),
                "reason": "context_budget" if too_long else "lower_relevance",
                "selection_score": round(score, 3),
            })
            continue
        selected.append({
            "turn_id": turn["turn_id"],
            "role": turn["role"],
            "narrative_order": turn["narrative_order"],
            "content": excerpt,
            "selection_score": round(score, 3),
        })
        used_characters += len(excerpt)
    return {
        "episodes": sorted(selected, key=lambda item: item["narrative_order"]),
        "excluded_episodes": excluded[:100],
        "excluded_episode_count": len(excluded),
    }
