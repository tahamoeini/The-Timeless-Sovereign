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


def situation_dependency_revision(
    turns: list[dict[str, Any]], sheet: dict[str, Any], threads: list[dict[str, Any]]
) -> int:
    """Return the newest revision of the inputs used to build a situation draft."""
    revisions = [sheet.get("updated_revision", 0) or 0]
    revisions.extend(thread.get("updated_revision", 0) or 0 for thread in threads)
    for turn in turns:
        revisions.append(turn.get("created_revision", 0) or 0)
        revisions.extend(edit.get("created_revision", 0) or 0 for edit in turn.get("edit_history", []))
    return max(revisions)


def memory_content_revision(memory: dict[str, Any], versions: list[dict[str, Any]]) -> int:
    """Context toggles do not make unchanged memory content fresh again."""
    basis = memory["created_revision"]
    if memory.get("reviewed_revision") is not None:
        return basis
    fields = ("kind", "content", "source_turn_id", "narrative_order")
    for previous in reversed(versions[:-1]):
        if any(previous.get(field) != memory.get(field) for field in fields):
            break
        basis = previous["created_revision"]
        if previous.get("reviewed_revision") is not None:
            break
    return basis


def restrict_retry_context(
    current: dict[str, Any], original: dict[str, Any], *, original_revision: int
) -> dict[str, Any]:
    """Keep a retry inside its recorded historical view and today's permissions."""
    original_claims = {
        item.get("claim_id"): item for item in original.get("included", []) if isinstance(item, dict)
    }
    current_claims = current.get("included", [])
    # Current compilation rechecks today's permissions; use the exact fact values
    # from the saved manifest so a later edit to the same stable ID cannot leak
    # into a retry of an older scene.
    included = [
        original_claims[item["claim_id"]]
        for item in current_claims
        if isinstance(item, dict) and item.get("claim_id") in original_claims
    ]
    excluded = list(current.get("excluded", []))
    excluded.extend(
        {"claim_id": item.get("claim_id"), "reason": "not_in_original_turn_context"}
        for item in current_claims
        if isinstance(item, dict) and item.get("claim_id") not in original_claims
    )
    result = {**current, "included": included, "excluded": excluded}
    original_story = original.get("story")
    current_story = current.get("story")
    if not isinstance(original_story, dict):
        result.pop("story", None)
        return result
    if not isinstance(current_story, dict):
        return result
    story = {**current_story}
    for key in ("character_sheet", "recent_checks"):
        if key in original_story:
            story[key] = original_story[key]
    for key, identity_key in (("memories", "memory_id"), ("author_notes", "memory_id"),
                              ("open_threads", "thread_id"), ("public_npcs", "entity_id")):
        original_items = {item.get(identity_key): item for item in original_story.get(key, []) if isinstance(item, dict)}
        current_items = [item for item in current_story.get(key, []) if isinstance(item, dict)]
        story[key] = [item for item in current_items if item.get(identity_key) in original_items
                      and item.get("created_revision", 0) <= original_revision
                      and item.get("updated_revision", 0) <= original_revision]
    original_locations = set(original_story.get("approved_locations", []))
    story["approved_locations"] = [
        location for location in current_story.get("approved_locations", []) if location in original_locations
    ]
    original_episodes = {
        item.get("turn_id"): item.get("content")
        for item in original_story.get("retrieved_episodes", []) if isinstance(item, dict)
    }
    story["retrieved_episodes"] = [
        item for item in current_story.get("retrieved_episodes", [])
        if original_episodes.get(item.get("turn_id")) == item.get("content")
    ]
    story["excluded_episode_count"] = max(
        current_story.get("excluded_episode_count", 0),
        original_story.get("excluded_episode_count", 0) + len(original_episodes) - len(story["retrieved_episodes"]),
    )
    result["story"] = story
    return result


def select_story_memories(
    memories: list[dict[str, Any]],
    *,
    actor_entity_id: str,
    as_of_narrative_order: int,
    query: str,
    source_turns: list[dict[str, Any]] | None = None,
    situation_revision: int | None = None,
    memory_history: dict[str, list[dict[str, Any]]] | None = None,
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
    turns_by_id = {turn["turn_id"]: turn for turn in source_turns} if source_turns is not None else None
    for memory in memories:
        memory_id = memory["memory_id"]
        versions = (memory_history or {}).get(memory_id, [memory])
        content_revision = memory_content_revision(memory, versions)
        reason = None
        if memory["review_status"] != "accepted":
            reason = f"review_status:{memory['review_status']}"
        elif not memory["context_enabled"]:
            reason = "context_disabled"
        elif memory["narrative_order"] > as_of_narrative_order:
            reason = "future_memory"
        if reason is None and memory.get("kind") == "situation" and situation_revision is not None:
            if content_revision < situation_revision:
                reason = "stale_situation"
        if reason is None and memory.get("source_turn_id") and turns_by_id is not None:
            source = turns_by_id.get(memory["source_turn_id"])
            if source is None:
                reason = "source_turn_outside_history"
            elif source.get("status", "active") != "active":
                reason = "source_turn_inactive"
            elif any(edit.get("created_revision", 0) > content_revision for edit in source.get("edit_history", [])):
                reason = "source_turn_changed"
        if reason is None and memory.get("knowledge_scope") == "private":
            reason = "private_memory"
        elif reason is None and memory.get("knowledge_scope") == "actors" and actor_entity_id not in memory.get("known_by", []):
            reason = "actor_not_authorized"
        if reason:
            excluded.append({"memory_id": memory_id, "reason": reason})
        elif memory.get("knowledge_scope") == "author":
            author_candidates.append(memory)
        else:
            actor_candidates.append(memory)

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
