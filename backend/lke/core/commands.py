"""Validated, revisioned writes to the canonical knowledge store."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import base64
import binascii
from datetime import date, datetime, timezone
from typing import Any
from uuid import uuid4

from .database import Database
from .errors import ConflictError, IdempotencyConflictError, NotFoundError, ValidationError
from ..reasoning import evaluate_rule


_ALLOWED_COMMANDS = {
    "create_entity", "update_entity", "add_relation", "update_relation", "review_relation", "add_claim",
    "update_claim", "review_claim", "add_belief", "import_source", "add_evidence",
    "create_conversation", "append_story_turn", "create_journal_event", "revise_journal_event",
    "create_story_world", "revise_story_world", "import_story_world", "create_story_adventure", "update_rpg_sheet",
    "record_d20_check", "propose_rpg_state", "review_rpg_state_proposal",
    "edit_story_turn", "create_story_memory", "revise_story_memory", "review_story_memory",
    "save_story_thread", "update_story_npc", "travel_to_location", "add_story_asset",
    "set_npc_simulation",
    "create_rule", "review_rule", "create_scenario", "set_scenario_assumption",
    "review_scenario_assumption", "record_extraction_batch", "review_extraction_candidate",
    "import_exchange", "promote_branch",
}
_SEARCH_TOKEN = re.compile(r'"([^"\s]+)"|([^\s]+)')


_ALLOWED_STORY_PROVIDERS = {"ollama", "openai", "claude", "codex", "huggingface", "huggingface_local"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _required_text(value: Any, field: str, limit: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValidationError(f"{field} must be non-empty text of at most {limit} characters")
    return value.strip()


def _validated_exchange_payload(
    payload: dict[str, Any], workspace_id: str, branch_id: str
) -> dict[str, Any]:
    try:
        payload_size = len(_json(payload).encode("utf-8"))
    except (TypeError, ValueError) as error:
        raise ValidationError("Exchange must contain JSON-compatible data") from error
    if payload_size > 10 * 1024 * 1024:
        raise ValidationError("Exchange is limited to 10 MiB")
    if payload.get("protocol") != "lke.exchange.v1":
        raise ValidationError("Unsupported exchange protocol")
    if payload.get("workspace_id") != workspace_id or payload.get("branch_id") != branch_id:
        raise ValidationError("Exchange workspace and branch must match the import target")

    exchange_id = _required_text(payload.get("exchange_id"), "exchange_id", 100)
    transcript_id = _required_text(payload.get("transcript_id"), "transcript_id", 200)
    context_manifest_id = _required_text(payload.get("context_manifest_id"), "context_manifest_id", 100)
    base_revision = payload.get("base_revision")
    if type(base_revision) is not int or base_revision < 0:
        raise ValidationError("base_revision must be a non-negative integer")
    context_manifest = payload.get("context_manifest")
    if (
        not isinstance(context_manifest, dict)
        or context_manifest.get("protocol") != "lke.context.v1"
        or context_manifest.get("manifest_id") != context_manifest_id
        or context_manifest.get("workspace_id") != workspace_id
        or context_manifest.get("branch_id") != branch_id
        or type(context_manifest.get("base_revision")) is not int
        or context_manifest["base_revision"] != base_revision
        or not isinstance(context_manifest.get("actor"), dict)
        or not isinstance(context_manifest.get("included"), list)
        or not isinstance(context_manifest.get("excluded"), list)
    ):
        raise ValidationError("Exchange context manifest does not match its workspace, branch, or revision")

    transcript_range = payload.get("transcript_range")
    if not isinstance(transcript_range, dict):
        raise ValidationError("transcript_range must contain from_turn and to_turn")
    from_turn, to_turn = transcript_range.get("from_turn"), transcript_range.get("to_turn")
    if type(from_turn) is not int or type(to_turn) is not int or from_turn < 1 or to_turn < from_turn:
        raise ValidationError("transcript range must be an ordered one-based turn range")
    transcript_total_turns = payload.get("transcript_total_turns")
    if type(transcript_total_turns) is not int or transcript_total_turns < to_turn:
        raise ValidationError("transcript_total_turns must include the end of the imported range")
    turns = payload.get("turns")
    if not isinstance(turns, list) or not turns or len(turns) > 500:
        raise ValidationError("turns must contain between 1 and 500 transcript turns")
    if len(turns) != to_turn - from_turn + 1:
        raise ValidationError("Transcript range contains missing turns")
    allowed_roles = {"user", "assistant", "system", "developer", "tool"}
    for offset, turn in enumerate(turns):
        if not isinstance(turn, dict) or type(turn.get("turn_number")) is not int:
            raise ValidationError("Each transcript turn needs an integer turn_number")
        if turn["turn_number"] != from_turn + offset:
            raise ValidationError("Transcript turns must be contiguous and ordered")
        messages = turn.get("messages")
        if not isinstance(messages, list) or not messages or len(messages) > 50:
            raise ValidationError("Each turn must contain between 1 and 50 messages")
        roles: set[str] = set()
        for message in messages:
            if not isinstance(message, dict):
                raise ValidationError("Transcript messages must be objects")
            role = message.get("role")
            content = message.get("content")
            if not isinstance(role, str) or role not in allowed_roles or not isinstance(content, str) or not content.strip() or len(content) > 20000:
                raise ValidationError("Each transcript message needs a supported role and text content")
            roles.add(role)
        if not {"user", "assistant"} <= roles:
            raise ValidationError("Each transcript turn must include user and assistant messages")

    transcript_hash = payload.get("transcript_hash")
    computed_hash = "sha256:" + hashlib.sha256(_json(turns).encode("utf-8")).hexdigest()
    if transcript_hash != computed_hash:
        raise ValidationError("transcript_hash does not match the supplied turns")
    raw_change_ids = payload.get("proposed_change_ids", [])
    if not isinstance(raw_change_ids, list) or len(raw_change_ids) > 100:
        raise ValidationError("proposed_change_ids must contain at most 100 ids")
    change_ids = [_required_text(item, "proposed change id", 100) for item in raw_change_ids]
    if len(change_ids) != len(set(change_ids)):
        raise ValidationError("proposed_change_ids must be unique")
    return {
        "exchange_id": exchange_id,
        "transcript_id": transcript_id,
        "context_manifest_id": context_manifest_id,
        "base_revision": base_revision,
        "from_turn": from_turn,
        "to_turn": to_turn,
        "transcript_total_turns": transcript_total_turns,
        "transcript_hash": computed_hash,
        "context_manifest": context_manifest,
        "turns": turns,
        "proposed_change_ids": change_ids,
    }


def _missing_turn_ranges(
    ranges: list[tuple[int, int]], total_turns: int | None = None
) -> list[dict[str, int]]:
    ordered = sorted(ranges)
    missing: list[dict[str, int]] = []
    if not ordered:
        return missing
    previous_end = 0
    for start, end in ordered:
        if start > previous_end + 1:
            missing.append({"from_turn": previous_end + 1, "to_turn": start - 1})
        previous_end = max(previous_end, end)
    if total_turns is not None and previous_end < total_turns:
        missing.append({"from_turn": previous_end + 1, "to_turn": total_turns})
    return missing


def _optional_iso_date(value: Any, field: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be an ISO calendar date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValidationError(f"{field} must be an ISO calendar date") from error
    if parsed.isoformat() != value:
        raise ValidationError(f"{field} must use YYYY-MM-DD format")
    return value


def _fts_query(query: str) -> str:
    tokens = [match.group(1) or match.group(2) for match in _SEARCH_TOKEN.finditer(query)]
    if not tokens:
        return ""
    return " AND ".join('"' + token.replace('"', '""') + '"' for token in tokens)


def _command_request_hash(request: dict[str, Any]) -> str:
    stable_request = dict(request)
    if stable_request["command_type"] == "append_story_turn":
        stable_payload = dict(stable_request["payload"])
        stable_payload.pop("assistant_content", None)
        stable_payload.pop("context_manifest_id", None)
        stable_payload.pop("context_manifest", None)
        stable_request["payload"] = stable_payload
    if stable_request["command_type"] == "edit_story_turn" and stable_request["payload"].get("provider") == "ollama":
        stable_payload = dict(stable_request["payload"])
        stable_payload.pop("content", None)
        stable_payload.pop("context_manifest_id", None)
        stable_payload.pop("context_manifest", None)
        stable_payload.pop("context_revision", None)
        stable_request["payload"] = stable_payload
    if stable_request["command_type"] == "record_d20_check":
        stable_payload = dict(stable_request["payload"])
        stable_payload.pop("die_roll", None)
        stable_payload.pop("check_id", None)
        stable_request["payload"] = stable_payload
    if stable_request["command_type"] == "record_extraction_batch":
        stable_payload = dict(stable_request["payload"])
        stable_payload.pop("candidates", None)
        stable_request["payload"] = stable_payload
    return hashlib.sha256(_json(stable_request).encode("utf-8")).hexdigest()


def _validated_world_content(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError("world content must be an object")
    try:
        serialized = _json(value)
        if len(serialized.encode("utf-8")) > 100_000:
            raise ValidationError("world content is limited to 100 KB")
    except (TypeError, ValueError) as error:
        raise ValidationError("world content must contain JSON-compatible values") from error

    def reject_secrets(node: Any) -> None:
        if isinstance(node, dict):
            for key, nested in node.items():
                if any(marker in str(key).casefold() for marker in ("secret", "password", "api_key", "access_token")):
                    raise ValidationError("world content cannot contain provider credentials")
                reject_secrets(nested)
        elif isinstance(node, list):
            for nested in node:
                reject_secrets(nested)

    reject_secrets(value)
    return value


def validate_world_package(package: Any) -> dict[str, Any]:
    """Validate a bounded, portable world history without mutating the database."""
    if not isinstance(package, dict) or package.get("protocol") != "lke.world.v1":
        raise ValidationError("Unsupported world package format or version")
    if set(package) != {"protocol", "provenance", "versions"}:
        raise ValidationError("World package contains unsupported fields")
    try:
        if len(_json(package).encode("utf-8")) > 2_000_000:
            raise ValidationError("World package is limited to 2 MB")
    except (TypeError, ValueError, RecursionError) as error:
        raise ValidationError("World package must contain valid JSON") from error
    provenance = package.get("provenance")
    if not isinstance(provenance, dict) or set(provenance) != {"workspace_id", "world_id"}:
        raise ValidationError("World package provenance is required")
    source_workspace = _required_text(provenance.get("workspace_id"), "source workspace_id", 100)
    source_world = _required_text(provenance.get("world_id"), "source world_id", 100)
    versions = package.get("versions")
    if not isinstance(versions, list) or not 1 <= len(versions) <= 100:
        raise ValidationError("World package must contain between 1 and 100 versions")
    clean = []
    for number, item in enumerate(versions, 1):
        if not isinstance(item, dict) or type(item.get("version")) is not int or item["version"] != number:
            raise ValidationError("World package versions must be contiguous and start at 1")
        if set(item) != {"version", "name", "description", "template_key", "content"}:
            raise ValidationError("World package version contains unsupported fields")
        description = item.get("description", "")
        if not isinstance(description, str) or len(description.strip()) > 4000:
            raise ValidationError("World description must be text of at most 4000 characters")
        clean.append({
            "version": number,
            "name": _required_text(item.get("name"), "world name", 200),
            "description": description.strip(),
            "template_key": _required_text(item.get("template_key"), "template_key", 60),
            "content": _validated_world_content(item.get("content")),
        })
    return {"protocol": "lke.world.v1", "provenance": {"workspace_id": source_workspace, "world_id": source_world}, "versions": clean}


def _package_object(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValidationError(f"{label} contains unsupported or missing fields")
    return value


def _package_list(value: Any, fields: set[str], label: str, maximum: int = 10_000) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValidationError(f"{label} must be an array of at most {maximum} records")
    return [_package_object(row, fields, f"{label} record") for row in value]


def _package_time(value: Any, field: str) -> str:
    return _required_text(value, field, 80)


def _package_optional_text(value: Any, field: str, limit: int) -> str | None:
    return None if value is None else _required_text(value, field, limit)


def validate_adventure_package(package: Any) -> dict[str, Any]:
    """Validate a portable adventure snapshot. Historical context manifests are deliberately omitted."""
    root_fields = {"protocol", "provenance", "world", "context_manifests_included", "adventure"}
    root = _package_object(package, root_fields, "Adventure package")
    if root["protocol"] != "lke.adventure.v1":
        raise ValidationError("Unsupported adventure package format or version")
    if root["context_manifests_included"] is not False:
        raise ValidationError("Adventure packages must omit historical context manifests")
    try:
        if len(_json(root).encode("utf-8")) > 10_000_000:
            raise ValidationError("Adventure package is limited to 10 MB")
    except (TypeError, ValueError, RecursionError) as error:
        raise ValidationError("Adventure package must contain valid JSON") from error

    provenance = _package_object(root["provenance"], {"workspace_id", "branch_id", "adventure_id", "exported_at"}, "Adventure provenance")
    clean_provenance = {
        "workspace_id": _required_text(provenance["workspace_id"], "source workspace_id", 100),
        "branch_id": _required_text(provenance["branch_id"], "source branch_id", 100),
        "adventure_id": _required_text(provenance["adventure_id"], "source adventure_id", 100),
        "exported_at": _package_time(provenance["exported_at"], "exported_at"),
    }
    world = validate_world_package(root["world"])
    adventure = _package_object(
        root["adventure"],
        {"name", "status", "completed_turns", "npc_simulation_enabled", "actor_entity_id", "entities",
         "conversation", "sheet", "turns", "turn_edits", "checks", "proposals", "memories", "threads",
         "npcs", "assets", "locations"},
        "Adventure data",
    )
    name = _required_text(adventure["name"], "adventure name", 200)
    status = adventure["status"]
    if status not in {"active", "complete", "paused"}:
        raise ValidationError("Adventure status is unsupported")
    completed_turns = adventure["completed_turns"]
    if type(completed_turns) is not int or completed_turns < 0:
        raise ValidationError("completed_turns must be a non-negative integer")
    if not isinstance(adventure["npc_simulation_enabled"], bool):
        raise ValidationError("npc_simulation_enabled must be a boolean")

    entities = _package_list(adventure["entities"], {"entity_id", "entity_type", "label", "properties"}, "entities", 500)
    clean_entities: list[dict[str, Any]] = []
    entity_ids: set[str] = set()
    for entity in entities:
        entity_id = _required_text(entity["entity_id"], "entity_id", 100)
        if entity_id in entity_ids:
            raise ValidationError("Adventure entity IDs must be unique")
        entity_ids.add(entity_id)
        clean_entities.append({
            "entity_id": entity_id,
            "entity_type": _required_text(entity["entity_type"], "entity_type", 100),
            "label": _required_text(entity["label"], "entity label", 200),
            "properties": _validated_world_content(entity["properties"]),
        })
    actor_entity_id = _required_text(adventure["actor_entity_id"], "actor_entity_id", 100)
    actor = next((entity for entity in clean_entities if entity["entity_id"] == actor_entity_id), None)
    if not actor or actor["entity_type"] not in {"character", "person"}:
        raise ValidationError("Adventure protagonist must be a character in the package")

    conversation = _package_object(adventure["conversation"], {"title", "actor_is_user_controlled"}, "Conversation")
    clean_conversation = {
        "title": _required_text(conversation["title"], "conversation title", 200),
        "actor_is_user_controlled": conversation["actor_is_user_controlled"],
    }
    if not isinstance(clean_conversation["actor_is_user_controlled"], bool):
        raise ValidationError("actor_is_user_controlled must be a boolean")
    sheet = _package_object(adventure["sheet"], {"stats", "trackers", "current_location"}, "Character sheet")
    clean_sheet = {
        "stats": _validated_stats(sheet["stats"]),
        "trackers": _validated_trackers(sheet["trackers"]),
        "current_location": sheet["current_location"],
    }
    if not isinstance(clean_sheet["current_location"], str) or len(clean_sheet["current_location"]) > 200:
        raise ValidationError("current_location must be text of at most 200 characters")

    turns = _package_list(adventure["turns"], {"turn_id", "turn_order", "role", "narrative_order", "content", "provider", "model", "created_at"}, "turns")
    clean_turns: list[dict[str, Any]] = []
    turn_ids: set[str] = set()
    turn_orders: set[int] = set()
    for turn in turns:
        turn_id = _required_text(turn["turn_id"], "turn_id", 100)
        order, narrative_order = turn["turn_order"], turn["narrative_order"]
        if turn_id in turn_ids or type(order) is not int or order < 0 or order in turn_orders:
            raise ValidationError("Turn IDs and non-negative turn_order values must be unique")
        if type(narrative_order) is not int or narrative_order < 0 or turn["role"] not in {"user", "assistant"}:
            raise ValidationError("Turn role and narrative order are invalid")
        content = _required_text(turn["content"], "turn content", 200_000)
        clean_turns.append({
            "turn_id": turn_id, "turn_order": order, "role": turn["role"],
            "narrative_order": narrative_order, "content": content,
            "provider": _package_optional_text(turn["provider"], "provider", 100),
            "model": _package_optional_text(turn["model"], "model", 200),
            "created_at": _package_time(turn["created_at"], "turn created_at"),
        })
        turn_ids.add(turn_id)
        turn_orders.add(order)
    clean_turns.sort(key=lambda turn: turn["turn_order"])
    if turn_orders and turn_orders != set(range(len(turn_orders))):
        raise ValidationError("turn_order values must be contiguous and start at zero")

    edits = _package_list(adventure["turn_edits"], {"turn_id", "version", "content", "status", "provider", "model", "created_at"}, "turn_edits")
    clean_edits: list[dict[str, Any]] = []
    edit_versions: dict[str, list[int]] = {}
    for edit in edits:
        turn_id, version = _required_text(edit["turn_id"], "edited turn_id", 100), edit["version"]
        if turn_id not in turn_ids or type(version) is not int or version < 1 or edit["status"] not in {"active", "deleted", "superseded"}:
            raise ValidationError("Turn edit references an invalid turn, version, or status")
        clean_edits.append({
            "turn_id": turn_id, "version": version,
            "content": _required_text(edit["content"], "edited turn content", 200_000),
            "status": edit["status"], "provider": _package_optional_text(edit["provider"], "provider", 100),
            "model": _package_optional_text(edit["model"], "model", 200),
            "created_at": _package_time(edit["created_at"], "turn edit created_at"),
        })
        edit_versions.setdefault(turn_id, []).append(version)
    for versions in edit_versions.values():
        if sorted(versions) != list(range(1, len(versions) + 1)):
            raise ValidationError("Turn edit versions must be contiguous and start at one")

    checks = _package_list(adventure["checks"], {"check_id", "stat_name", "die_roll", "modifier", "total", "target", "outcome", "created_at"}, "checks")
    clean_checks: list[dict[str, Any]] = []
    check_ids: set[str] = set()
    for check in checks:
        check_id = _required_text(check["check_id"], "check_id", 100)
        stat_name = _required_text(check["stat_name"], "stat_name", 40)
        if check_id in check_ids or stat_name not in clean_sheet["stats"]:
            raise ValidationError("D20 check ID or stat reference is invalid")
        roll, modifier, total, target = check["die_roll"], check["modifier"], check["total"], check["target"]
        if any(type(value) is not int for value in (roll, modifier, total, target)) or not 1 <= roll <= 20 or not -20 <= modifier <= 20 or not 1 <= target <= 100 or total != roll + modifier:
            raise ValidationError("D20 check math or bounds are invalid")
        outcome = "success" if total >= target else "failure"
        if check["outcome"] != outcome:
            raise ValidationError("D20 check outcome does not match its recorded math")
        clean_checks.append({"check_id": check_id, "stat_name": stat_name, "die_roll": roll,
                             "modifier": modifier, "total": total, "target": target,
                             "outcome": outcome, "created_at": _package_time(check["created_at"], "check created_at")})
        check_ids.add(check_id)

    proposals = _package_list(adventure["proposals"], {"proposal_id", "source_turn_id", "changes", "review_status", "created_at"}, "proposals")
    clean_proposals: list[dict[str, Any]] = []
    proposal_ids: set[str] = set()
    for proposal in proposals:
        proposal_id = _required_text(proposal["proposal_id"], "proposal_id", 100)
        source_turn = proposal["source_turn_id"]
        if source_turn is not None:
            source_turn = _required_text(source_turn, "source_turn_id", 100)
            if source_turn not in turn_ids:
                raise ValidationError("Proposal source turn is missing from the adventure")
        if proposal_id in proposal_ids or proposal["review_status"] not in {"proposed", "accepted", "rejected"}:
            raise ValidationError("Proposal ID or review status is invalid")
        clean_changes = _validated_rpg_changes(proposal["changes"])
        for change in clean_changes:
            if change["operation"] == "npc_profile" and change["npc_entity_id"] not in entity_ids:
                raise ValidationError("NPC proposal references an entity missing from the package")
            if change["operation"] == "add_event_memory" and not set(change["known_by"]) <= entity_ids:
                raise ValidationError("Memory proposal references a character missing from the package")
        clean_proposals.append({"proposal_id": proposal_id, "source_turn_id": source_turn,
                                "changes": clean_changes, "review_status": proposal["review_status"],
                                "created_at": _package_time(proposal["created_at"], "proposal created_at")})
        proposal_ids.add(proposal_id)

    memories = _package_list(adventure["memories"], {"memory_id", "version", "kind", "content", "context_enabled", "review_status", "source_turn_id", "narrative_order", "supersedes_version", "importance", "knowledge_scope", "known_by", "created_at"}, "memories")
    clean_memories: list[dict[str, Any]] = []
    memory_versions: dict[str, list[int]] = {}
    for memory in memories:
        memory_id, version = _required_text(memory["memory_id"], "memory_id", 100), memory["version"]
        source_turn = memory["source_turn_id"]
        if source_turn is not None:
            source_turn = _required_text(source_turn, "memory source_turn_id", 100)
            if source_turn not in turn_ids:
                raise ValidationError("Memory source turn is missing from the adventure")
        known_by = memory["known_by"]
        if not isinstance(known_by, list) or any(not isinstance(item, str) or item not in entity_ids for item in known_by):
            raise ValidationError("Memory knowledge holders must reference packaged characters")
        if type(version) is not int or version < 1 or type(memory["narrative_order"]) is not int or memory["narrative_order"] < 0:
            raise ValidationError("Memory version and narrative order must be non-negative integers")
        if memory["kind"] not in {"note", "event", "situation"} or memory["review_status"] not in {"proposed", "accepted", "rejected"}:
            raise ValidationError("Memory type or review status is invalid")
        if not isinstance(memory["context_enabled"], bool) or type(memory["importance"]) is not int or not 1 <= memory["importance"] <= 5:
            raise ValidationError("Memory context setting or importance is invalid")
        if memory["knowledge_scope"] not in {"shared", "actors", "author", "private"}:
            raise ValidationError("Memory knowledge scope is invalid")
        if (memory["knowledge_scope"] == "actors") != bool(known_by):
            raise ValidationError("Actor-scoped memory must name its knowledge holders")
        supersedes = memory["supersedes_version"]
        if supersedes is not None and (type(supersedes) is not int or supersedes < 1 or supersedes >= version):
            raise ValidationError("Memory supersession reference is invalid")
        clean_memories.append({"memory_id": memory_id, "version": version, "kind": memory["kind"],
                               "content": _required_text(memory["content"], "memory content", 4000),
                               "context_enabled": memory["context_enabled"], "review_status": memory["review_status"],
                               "source_turn_id": source_turn, "narrative_order": memory["narrative_order"],
                               "supersedes_version": supersedes, "importance": memory["importance"],
                               "knowledge_scope": memory["knowledge_scope"], "known_by": list(dict.fromkeys(known_by)),
                               "created_at": _package_time(memory["created_at"], "memory created_at")})
        memory_versions.setdefault(memory_id, []).append(version)
    for versions in memory_versions.values():
        if sorted(versions) != list(range(1, len(versions) + 1)):
            raise ValidationError("Memory versions must be contiguous and start at one")

    threads = _package_list(adventure["threads"], {"thread_id", "title", "detail", "status", "created_at", "updated_at"}, "threads")
    clean_threads: list[dict[str, Any]] = []
    for thread in threads:
        if thread["status"] not in {"open", "closed"}:
            raise ValidationError("Thread status is invalid")
        detail = thread["detail"]
        if not isinstance(detail, str) or len(detail) > 2000:
            raise ValidationError("Thread detail is limited to 2000 characters")
        clean_threads.append({"thread_id": _required_text(thread["thread_id"], "thread_id", 100),
                              "title": _required_text(thread["title"], "thread title", 200), "detail": detail,
                              "status": thread["status"], "created_at": _package_time(thread["created_at"], "thread created_at"),
                              "updated_at": _package_time(thread["updated_at"], "thread updated_at")})

    npcs = _package_list(adventure["npcs"], {"npc_entity_id", "aliases", "public_profile", "private_profile", "review_status", "created_at", "updated_at"}, "npcs", 500)
    clean_npcs: list[dict[str, Any]] = []
    npc_ids: set[str] = set()
    for npc in npcs:
        npc_id = _required_text(npc["npc_entity_id"], "npc_entity_id", 100)
        aliases = npc["aliases"]
        if npc_id not in entity_ids or npc_id == actor_entity_id or npc_id in npc_ids:
            raise ValidationError("NPC profile must reference a separate packaged character")
        if not isinstance(aliases, list) or len(aliases) > 50:
            raise ValidationError("NPC aliases must be an array of at most 50 names")
        clean_aliases = [_required_text(alias, "NPC alias", 100) for alias in aliases]
        if npc["review_status"] not in {"proposed", "accepted", "rejected"}:
            raise ValidationError("NPC review status is invalid")
        clean_npcs.append({"npc_entity_id": npc_id, "aliases": clean_aliases,
                           "public_profile": _validated_world_content(npc["public_profile"]),
                           "private_profile": _validated_world_content(npc["private_profile"]),
                           "review_status": npc["review_status"],
                           "created_at": _package_time(npc["created_at"], "NPC created_at"),
                           "updated_at": _package_time(npc["updated_at"], "NPC updated_at")})
        npc_ids.add(npc_id)

    assets = _package_list(adventure["assets"], {"asset_id", "target_kind", "target_id", "display_name", "mime_type", "data_base64", "provenance", "created_at"}, "assets", 500)
    clean_assets: list[dict[str, Any]] = []
    for asset in assets:
        if asset["target_kind"] not in {"character", "scene"} or asset["mime_type"] not in {"image/png", "image/jpeg", "image/webp"}:
            raise ValidationError("Story asset target or media type is invalid")
        if asset["target_kind"] == "character" and asset["target_id"] not in entity_ids:
            raise ValidationError("Character asset target is missing from the package")
        try:
            content = base64.b64decode(_required_text(asset["data_base64"], "asset data", 7_000_000), validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValidationError("Story asset data must be valid base64") from error
        if not 1 <= len(content) <= 5_242_880:
            raise ValidationError("Each story asset must contain between 1 byte and 5 MB")
        clean_assets.append({"asset_id": _required_text(asset["asset_id"], "asset_id", 100),
                             "target_kind": asset["target_kind"],
                             "target_id": _required_text(asset["target_id"], "asset target_id", 100),
                             "display_name": _required_text(asset["display_name"], "asset display_name", 200),
                             "mime_type": asset["mime_type"], "content": content,
                             "provenance": _validated_world_content(asset["provenance"]),
                             "created_at": _package_time(asset["created_at"], "asset created_at")})

    locations = _package_list(adventure["locations"], {"location_id", "name", "status", "source_proposal_id", "created_at"}, "locations", 1000)
    clean_locations: list[dict[str, Any]] = []
    location_names: set[str] = set()
    for location in locations:
        clean_name = _required_text(location["name"], "location name", 200)
        name_key = clean_name.casefold()
        source_proposal_id = location["source_proposal_id"]
        if source_proposal_id is not None:
            source_proposal_id = _required_text(source_proposal_id, "source_proposal_id", 100)
            if source_proposal_id not in proposal_ids:
                raise ValidationError("Map location proposal reference is missing")
        if name_key in location_names or location["status"] not in {"approved", "rejected"}:
            raise ValidationError("Map locations must have unique names and supported statuses")
        clean_locations.append({"location_id": _required_text(location["location_id"], "location_id", 100),
                                "name": clean_name,
                                "status": location["status"], "source_proposal_id": source_proposal_id,
                                "created_at": _package_time(location["created_at"], "location created_at")})
        location_names.add(name_key)

    return {
        "protocol": "lke.adventure.v1", "provenance": clean_provenance, "world": world,
        "context_manifests_included": False,
        "adventure": {"name": name, "status": status, "completed_turns": completed_turns,
                      "npc_simulation_enabled": adventure["npc_simulation_enabled"],
                      "actor_entity_id": actor_entity_id, "entities": clean_entities,
                      "conversation": clean_conversation, "sheet": clean_sheet,
                      "turns": clean_turns, "turn_edits": clean_edits, "checks": clean_checks,
                      "proposals": clean_proposals, "memories": clean_memories, "threads": clean_threads,
                      "npcs": clean_npcs, "assets": clean_assets, "locations": clean_locations},
    }


def _validated_stats(value: Any) -> dict[str, int]:
    if not isinstance(value, dict) or len(value) > 20:
        raise ValidationError("stats must be an object with at most 20 values")
    stats: dict[str, int] = {}
    for raw_name, raw_value in value.items():
        name = _required_text(raw_name, "stat name", 40)
        if type(raw_value) is not int or not -10 <= raw_value <= 10:
            raise ValidationError("each stat modifier must be an integer from -10 to 10")
        stats[name] = raw_value
    if not stats:
        raise ValidationError("at least one stat is required")
    return stats


def _validated_trackers(value: Any) -> dict[str, dict[str, int]]:
    if not isinstance(value, dict) or len(value) > 30:
        raise ValidationError("trackers must be an object with at most 30 values")
    trackers: dict[str, dict[str, int]] = {}
    for raw_name, raw_value in value.items():
        name = _required_text(raw_name, "tracker name", 60)
        if not isinstance(raw_value, dict):
            raise ValidationError("each tracker must contain value and max integers")
        current, maximum = raw_value.get("value"), raw_value.get("max")
        if type(current) is not int or type(maximum) is not int or maximum < 0 or maximum > 100_000:
            raise ValidationError("tracker values must be integers with a non-negative maximum")
        if current < 0 or current > maximum:
            raise ValidationError("tracker value must be between zero and its maximum")
        trackers[name] = {"value": current, "max": maximum}
    return trackers


def _validated_rpg_changes(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value or len(value) > 20:
        raise ValidationError("changes must contain between 1 and 20 RPG state changes")
    clean: list[dict[str, Any]] = []
    for change in value:
        if not isinstance(change, dict):
            raise ValidationError("each RPG state change must be an object")
        operation = change.get("operation")
        if operation == "tracker_delta":
            tracker_id = _required_text(change.get("tracker_id"), "tracker_id", 60)
            delta = change.get("delta")
            if type(delta) is not int or not -100_000 <= delta <= 100_000:
                raise ValidationError("tracker delta must be an integer")
            clean.append({"operation": operation, "tracker_id": tracker_id, "delta": delta})
        elif operation == "set_location":
            clean.append({"operation": operation, "location": _required_text(change.get("location"), "location", 200)})
        elif operation == "npc_profile":
            npc_entity_id = _required_text(change.get("npc_entity_id"), "npc_entity_id", 100)
            updates = change.get("updates")
            allowed_fields = {"motivation", "current_goal", "whereabouts", "memory"}
            if not isinstance(updates, dict) or not updates or len(updates) > 4 or not set(updates) <= allowed_fields:
                raise ValidationError("NPC simulation updates must use the supported public profile fields")
            clean_updates = {key: _required_text(value, f"NPC {key}", 500) for key, value in updates.items()}
            clean.append({"operation": operation, "npc_entity_id": npc_entity_id, "updates": clean_updates})
        elif operation == "add_event_memory":
            context_enabled = change.get("context_enabled", True)
            importance = change.get("importance", 3)
            knowledge_scope = change.get("knowledge_scope", "shared")
            known_by = change.get("known_by", [])
            if not isinstance(context_enabled, bool):
                raise ValidationError("event memory context_enabled must be a boolean")
            if type(importance) is not int or not 1 <= importance <= 5:
                raise ValidationError("event memory importance must be from 1 to 5")
            if knowledge_scope not in {"shared", "actors"}:
                raise ValidationError("proposed event memories must be shared or actor-scoped")
            if not isinstance(known_by, list) or any(not isinstance(item, str) or not item.strip() for item in known_by):
                raise ValidationError("event memory known_by must be an array of character IDs")
            known_by = list(dict.fromkeys(item.strip() for item in known_by))
            if (knowledge_scope == "actors") != bool(known_by):
                raise ValidationError("actor-scoped event memories must name their characters")
            clean.append({
                "operation": operation,
                "content": _required_text(change.get("content"), "event memory", 1000),
                "context_enabled": context_enabled,
                "importance": importance,
                "knowledge_scope": knowledge_scope,
                "known_by": known_by,
            })
        else:
            raise ValidationError("unsupported RPG state change")
    return clean


def _validated_extraction_candidate(candidate: Any, source_content: str) -> tuple[str, str, dict[str, Any]]:
    if not isinstance(candidate, dict):
        raise ValidationError("Each extraction candidate must be an object")
    kind = candidate.get("kind")
    if not isinstance(kind, str) or kind not in {"entity", "claim"}:
        raise ValidationError("Extraction candidate kind must be entity or claim")
    quote = _required_text(candidate.get("quote"), "quote", 10000)
    start = candidate.get("source_start")
    end = candidate.get("source_end")
    if type(start) is not int or type(end) is not int or start < 0 or end <= start:
        raise ValidationError("Extraction candidate needs a valid source span")
    if source_content[start:end] != quote:
        raise ValidationError("Extraction candidate quote must match its exact source span")
    if kind == "entity":
        data = {
            "label": _required_text(candidate.get("label"), "label", 200),
            "entity_type": _required_text(candidate.get("entity_type"), "entity_type", 100),
        }
    else:
        data = {
            "subject_label": _required_text(candidate.get("subject_label"), "subject_label", 200),
            "predicate": _required_text(candidate.get("predicate"), "predicate", 200),
            "object_value": _required_text(candidate.get("object_value"), "object_value", 4000),
        }
    data.update({"quote": quote, "source_start": start, "source_end": end})
    candidate_id = _required_text(candidate.get("candidate_id") or str(uuid4()), "candidate_id", 100)
    return candidate_id, kind, data


_BRANCH_SNAPSHOT_TABLES = (
    ("entities", "entity_id,entity_type,label,properties_json,created_revision,updated_revision"),
    ("relations", "relation_id,source_entity_id,target_entity_id,relation_type,properties_json,review_status,created_revision"),
    ("claims", "claim_id,subject_entity_id,predicate,object_value,epistemic_status,review_status,visibility,narrative_order,evidence_json,created_revision"),
    ("rules", "rule_id,name,description,rule_mode,severity,subject_entity_id,predicate,object_value,predicate_cardinality,review_status,created_revision"),
    ("actor_beliefs", "belief_id,actor_entity_id,claim_id,stance,awareness_order,created_revision"),
    ("story_conversations", "conversation_id,actor_entity_id,title,actor_is_user_controlled,created_revision,updated_revision,created_at,updated_at"),
    ("story_turns", "conversation_id,turn_id,turn_order,role,narrative_order,content,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at"),
    ("story_adventures", "adventure_id,world_id,world_version,conversation_id,name,actor_entity_id,status,created_revision,updated_revision,created_at,updated_at,completed_turns,npc_simulation_enabled"),
    ("rpg_sheets", "adventure_id,conversation_id,stats_json,trackers_json,current_location,created_revision,updated_revision"),
    ("story_turn_edits", "conversation_id,turn_id,version,content,status,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at"),
    ("story_memories", "adventure_id,memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at"),
    ("story_threads", "adventure_id,thread_id,title,detail,status,created_revision,updated_revision,created_at,updated_at"),
    ("story_npc_profiles", "adventure_id,npc_entity_id,aliases_json,public_profile_json,private_profile_json,review_status,created_revision,updated_revision,created_at,updated_at"),
    ("story_assets", "adventure_id,asset_id,target_kind,target_id,display_name,mime_type,content,provenance_json,created_revision,created_at"),
    ("story_map_locations", "adventure_id,location_id,name,status,source_proposal_id,created_revision,reviewed_revision,created_at"),
    ("rpg_checks", "check_id,adventure_id,conversation_id,actor_entity_id,stat_name,die_roll,modifier,total,target,outcome,created_revision,created_at"),
    ("rpg_state_proposals", "proposal_id,adventure_id,conversation_id,source_turn_id,changes_json,review_status,created_revision,reviewed_revision,created_at"),
    ("external_exchanges", "exchange_id,transcript_id,context_manifest_id,base_revision,from_turn,to_turn,transcript_total_turns,transcript_hash,context_manifest_json,turns_json,proposed_change_ids_json,created_revision,created_at"),
    ("journal_events", "event_id,version,title,details,participants_json,temporal_kind,occurred_from,occurred_to,time_note,source_id,source_quote,supersedes_version,created_revision,created_at"),
    ("scenarios", "scenario_id,title,problem,constraints_json,created_revision,created_at"),
    ("scenario_options", "scenario_id,option_id,label,description,position,created_revision"),
    ("scenario_claim_evidence", "scenario_id,claim_id,created_revision"),
    ("scenario_source_evidence", "scenario_id,source_id,created_revision"),
    ("scenario_assumptions", "scenario_id,option_id,assumption_id,version,subject_entity_id,predicate,object_value,assumption_action,predicate_cardinality,review_status,supersedes_version,created_revision,created_at"),
    ("extraction_batches", "batch_id,source_id,source_sha256,model,extractor_version,prompt_version,output_schema_version,created_revision,created_at"),
    ("extraction_candidates", "candidate_id,batch_id,kind,payload_json,review_status,canonical_record_type,canonical_record_id,created_revision,reviewed_revision"),
    ("evidence", "evidence_id,source_id,anchor,quote,context_fingerprint,created_revision"),
    ("entity_evidence", "entity_id,evidence_id,created_revision"),
)


def _snapshot_branch(
    connection: sqlite3.Connection,
    *,
    workspace_id: str,
    parent_branch_id: str,
    branch_id: str,
    revision: int,
    actor: str,
    reason: str,
    command_id: str,
    idempotency_key: str,
    request_hash: str,
    envelope: dict[str, Any],
    created_at: str,
) -> dict[str, Any]:
    connection.execute(
        "INSERT INTO branches(workspace_id,branch_id,parent_branch_id,parent_revision,base_revision,head_revision,created_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (workspace_id, branch_id, parent_branch_id, revision, revision, revision, created_at),
    )
    for table, columns in _BRANCH_SNAPSHOT_TABLES:
        ordering = {
            "journal_events": " ORDER BY event_id,version",
            "scenario_assumptions": " ORDER BY scenario_id,option_id,assumption_id,version",
            "external_exchanges": " ORDER BY created_revision,exchange_id",
            "extraction_candidates": " ORDER BY candidate_id",
        }.get(table, "")
        connection.execute(
            f"INSERT INTO {table}(workspace_id,branch_id,{columns}) "
            f"SELECT workspace_id,?,{columns} FROM {table} WHERE workspace_id=? AND branch_id=?{ordering}",
            (branch_id, workspace_id, parent_branch_id),
        )
    connection.execute(
        "INSERT INTO entity_search(workspace_id,branch_id,entity_id,label,properties) "
        "SELECT workspace_id,?,entity_id,label,properties FROM entity_search WHERE workspace_id=? AND branch_id=?",
        (branch_id, workspace_id, parent_branch_id),
    )
    connection.execute(
        "INSERT INTO revisions(workspace_id,branch_id,revision,command_id,parent_revision,actor,reason,created_at,payload_json) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (workspace_id, branch_id, revision, command_id, revision, actor, reason, created_at, _json(envelope)),
    )
    connection.execute(
        "INSERT INTO audit_events(event_id,workspace_id,branch_id,revision,command_id,event_type,actor,reason,payload_json,created_at) "
        "VALUES(?,?,?,?,?,'branch.created',?,?,?,?)",
        (str(uuid4()), workspace_id, branch_id, revision, command_id, actor, reason, _json(envelope), created_at),
    )
    connection.execute(
        "INSERT INTO projection_outbox(outbox_id,workspace_id,branch_id,revision,projection,created_at) "
        "VALUES(?,?,?,?, 'all', ?)",
        (str(uuid4()), workspace_id, branch_id, revision, created_at),
    )
    result = {"workspace_id": workspace_id, "branch_id": branch_id,
              "parent_branch_id": parent_branch_id, "revision": revision}
    connection.execute(
        "INSERT INTO commands(workspace_id,idempotency_key,request_hash,branch_id,result_json,created_at) "
        "VALUES(?,?,?,?,?,?)",
        (workspace_id, idempotency_key, request_hash, branch_id, _json(result), created_at),
    )
    return result


def _promote_branch_snapshot(
    connection: sqlite3.Connection,
    workspace_id: str,
    target_branch_id: str,
    source_branch_id: str,
    source_base_revision: int,
    target_revision: int,
) -> dict[str, int]:
    """Fast-forward branch-scoped state into an unchanged parent branch."""
    table_specs = (
        ("entities", "entity_id,entity_type,label,properties_json,created_revision,updated_revision", "entity_id", ("entity_type", "label", "properties_json", "updated_revision"), ("created_revision", "updated_revision"), "entity_id"),
        ("relations", "relation_id,source_entity_id,target_entity_id,relation_type,properties_json,review_status,created_revision", "relation_id", ("source_entity_id", "target_entity_id", "relation_type", "properties_json", "review_status"), ("created_revision",), "relation_id"),
        ("claims", "claim_id,subject_entity_id,predicate,object_value,epistemic_status,review_status,visibility,narrative_order,evidence_json,created_revision", "claim_id", ("subject_entity_id", "predicate", "object_value", "epistemic_status", "review_status", "visibility", "narrative_order", "evidence_json"), ("created_revision",), "claim_id"),
        ("rules", "rule_id,name,description,rule_mode,severity,subject_entity_id,predicate,object_value,predicate_cardinality,review_status,created_revision", "rule_id", ("name", "description", "rule_mode", "severity", "subject_entity_id", "predicate", "object_value", "predicate_cardinality", "review_status"), ("created_revision",), "rule_id"),
        ("evidence", "evidence_id,source_id,anchor,quote,context_fingerprint,created_revision", None, (), ("created_revision",), "evidence_id"),
        ("entity_evidence", "entity_id,evidence_id,created_revision", None, (), ("created_revision",), "entity_id,evidence_id"),
        ("actor_beliefs", "belief_id,actor_entity_id,claim_id,stance,awareness_order,created_revision", None, (), ("created_revision",), "belief_id"),
        ("story_conversations", "conversation_id,actor_entity_id,title,actor_is_user_controlled,created_revision,updated_revision,created_at,updated_at", "conversation_id", ("actor_entity_id", "title", "actor_is_user_controlled", "updated_revision", "updated_at"), ("created_revision", "updated_revision"), "conversation_id"),
        ("story_turns", "conversation_id,turn_id,turn_order,role,narrative_order,content,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at", None, (), ("created_revision",), "conversation_id,turn_id"),
        ("story_adventures", "adventure_id,world_id,world_version,conversation_id,name,actor_entity_id,status,created_revision,updated_revision,created_at,updated_at,completed_turns,npc_simulation_enabled", "adventure_id", ("world_id", "world_version", "conversation_id", "name", "actor_entity_id", "status", "updated_revision", "updated_at", "completed_turns", "npc_simulation_enabled"), ("created_revision", "updated_revision"), "adventure_id"),
        ("rpg_sheets", "adventure_id,conversation_id,stats_json,trackers_json,current_location,created_revision,updated_revision", "adventure_id", ("conversation_id", "stats_json", "trackers_json", "current_location", "updated_revision"), ("created_revision", "updated_revision"), "adventure_id"),
        ("story_turn_edits", "conversation_id,turn_id,version,content,status,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at", None, (), ("created_revision",), "conversation_id,turn_id,version"),
        ("story_memories", "adventure_id,memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at", "adventure_id,memory_id,version", ("review_status", "reviewed_revision"), ("created_revision", "reviewed_revision"), "adventure_id,memory_id,version"),
        ("story_threads", "adventure_id,thread_id,title,detail,status,created_revision,updated_revision,created_at,updated_at", "adventure_id,thread_id", ("title", "detail", "status", "updated_revision", "updated_at"), ("created_revision", "updated_revision"), "adventure_id,thread_id"),
        ("story_npc_profiles", "adventure_id,npc_entity_id,aliases_json,public_profile_json,private_profile_json,review_status,created_revision,updated_revision,created_at,updated_at", "adventure_id,npc_entity_id", ("aliases_json", "public_profile_json", "private_profile_json", "review_status", "updated_revision", "updated_at"), ("created_revision", "updated_revision"), "adventure_id,npc_entity_id"),
        ("story_assets", "adventure_id,asset_id,target_kind,target_id,display_name,mime_type,content,provenance_json,created_revision,created_at", None, (), ("created_revision",), "adventure_id,asset_id"),
        ("story_map_locations", "adventure_id,location_id,name,status,source_proposal_id,created_revision,reviewed_revision,created_at", "adventure_id,location_id", ("name", "status", "source_proposal_id", "reviewed_revision"), ("created_revision", "reviewed_revision"), "adventure_id,location_id"),
        ("rpg_checks", "check_id,adventure_id,conversation_id,actor_entity_id,stat_name,die_roll,modifier,total,target,outcome,created_revision,created_at", None, (), ("created_revision",), "check_id"),
        ("rpg_state_proposals", "proposal_id,adventure_id,conversation_id,source_turn_id,changes_json,review_status,created_revision,reviewed_revision,created_at", "proposal_id", ("review_status", "reviewed_revision"), ("created_revision", "reviewed_revision"), "proposal_id"),
        ("external_exchanges", "exchange_id,transcript_id,context_manifest_id,base_revision,from_turn,to_turn,transcript_total_turns,transcript_hash,context_manifest_json,turns_json,proposed_change_ids_json,created_revision,created_at", None, (), ("created_revision",), "exchange_id"),
        ("journal_events", "event_id,version,title,details,participants_json,temporal_kind,occurred_from,occurred_to,time_note,source_id,source_quote,supersedes_version,created_revision,created_at", None, (), ("created_revision",), "event_id,version"),
        ("scenarios", "scenario_id,title,problem,constraints_json,created_revision,created_at", None, (), ("created_revision",), "scenario_id"),
        ("scenario_options", "scenario_id,option_id,label,description,position,created_revision", None, (), ("created_revision",), "scenario_id,option_id"),
        ("scenario_claim_evidence", "scenario_id,claim_id,created_revision", None, (), ("created_revision",), "scenario_id,claim_id"),
        ("scenario_source_evidence", "scenario_id,source_id,created_revision", None, (), ("created_revision",), "scenario_id,source_id"),
        ("scenario_assumptions", "scenario_id,option_id,assumption_id,version,subject_entity_id,predicate,object_value,assumption_action,predicate_cardinality,review_status,supersedes_version,created_revision,created_at", None, (), ("created_revision",), "scenario_id,option_id,assumption_id,version"),
        ("extraction_batches", "batch_id,source_id,source_sha256,model,extractor_version,prompt_version,output_schema_version,created_revision,created_at", None, (), ("created_revision",), "batch_id"),
        ("extraction_candidates", "candidate_id,batch_id,kind,payload_json,review_status,canonical_record_type,canonical_record_id,created_revision,reviewed_revision", "candidate_id", ("review_status", "canonical_record_type", "canonical_record_id", "reviewed_revision"), ("created_revision", "reviewed_revision"), "candidate_id"),
    )
    row_counts: dict[str, int] = {}
    for table, column_list, _, update_columns, revision_columns, primary_key in table_specs:
        columns = column_list.split(",")
        select_expressions = []
        revision_parameters: list[int] = []
        for column in columns:
            if column in revision_columns:
                select_expressions.append(f"CASE WHEN {column}>? THEN ? ELSE {column} END")
                revision_parameters.extend((source_base_revision, target_revision))
            else:
                select_expressions.append(column)
        insert_mode = "INSERT OR IGNORE" if not update_columns else "INSERT"
        sql = (
            f"{insert_mode} INTO {table}(workspace_id,branch_id,{column_list}) "
            f"SELECT workspace_id,?,{','.join(select_expressions)} FROM {table} "
            "WHERE workspace_id=? AND branch_id=?"
        )
        if table == "journal_events":
            sql += " ORDER BY event_id,version"
        elif table == "scenario_assumptions":
            sql += " ORDER BY scenario_id,option_id,assumption_id,version"
        elif table == "external_exchanges":
            sql += " ORDER BY created_revision,exchange_id"
        if update_columns:
            updates = ",".join(f"{column}=excluded.{column}" for column in update_columns)
            changed_columns = " OR ".join(
                f"{table}.{column} IS NOT excluded.{column}" for column in update_columns
            )
            sql += (
                f" ON CONFLICT(workspace_id,branch_id,{primary_key}) DO UPDATE SET {updates}"
                f" WHERE {changed_columns}"
            )
        before = connection.total_changes
        connection.execute(
            sql,
            (target_branch_id, *revision_parameters, workspace_id, source_branch_id),
        )
        row_counts[table] = connection.total_changes - before

    connection.execute(
        "DELETE FROM entity_search WHERE workspace_id=? AND branch_id=?",
        (workspace_id, target_branch_id),
    )
    before = connection.total_changes
    connection.execute(
        "INSERT INTO entity_search(workspace_id,branch_id,entity_id,label,properties) "
        "SELECT workspace_id,?,entity_id,label,properties_json FROM entities "
        "WHERE workspace_id=? AND branch_id=? ORDER BY entity_id",
        (target_branch_id, workspace_id, source_branch_id),
    )
    row_counts["entity_search"] = connection.total_changes - before
    return row_counts


class CommandGateway:
    """The only supported writer for branch-scoped canonical records."""

    def __init__(self, database: Database) -> None:
        self.db = database

    def create_workspace(self, name: str, workspace_id: str | None = None) -> dict[str, Any]:
        name = _required_text(name, "name", 200)
        workspace_id = _required_text(workspace_id or str(uuid4()), "workspace_id", 100)
        now = _now()
        command_id = str(uuid4())
        with self.db.lock:
            connection = self.db.connection
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    "INSERT INTO workspaces(workspace_id,name,created_at) VALUES(?,?,?)",
                    (workspace_id, name, now),
                )
                connection.execute(
                    "INSERT INTO branches(workspace_id,branch_id,base_revision,head_revision,created_at) "
                    "VALUES(?, 'main', 0, 0, ?)",
                    (workspace_id, now),
                )
                connection.execute(
                    "INSERT INTO revisions(workspace_id,branch_id,revision,command_id,parent_revision,actor,reason,created_at,payload_json) "
                    "VALUES(?, 'main', 0, ?, NULL, 'user', 'Workspace created', ?, '{}')",
                    (workspace_id, command_id, now),
                )
                connection.execute(
                    "INSERT INTO audit_events(event_id,workspace_id,branch_id,revision,command_id,event_type,actor,reason,payload_json,created_at) "
                    "VALUES(?,?, 'main', 0, ?, 'workspace.created', 'user', 'Workspace created', ?, ?)",
                    (str(uuid4()), workspace_id, command_id, _json({"name": name}), now),
                )
                connection.commit()
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise ConflictError("Workspace id already exists") from error
            except BaseException:
                connection.rollback()
                raise
        return {"workspace_id": workspace_id, "name": name, "branch_id": "main", "revision": 0}

    def create_branch(
        self,
        workspace_id: str,
        parent_branch_id: str,
        branch_id: str,
        expected_revision: int,
        idempotency_key: str,
        actor: str = "user",
        reason: str = "Create scenario branch",
    ) -> dict[str, Any]:
        """Create an isolated snapshot at an exact parent revision."""
        envelope = {
            "operation": "create_branch",
            "workspace_id": workspace_id,
            "parent_branch_id": parent_branch_id,
            "branch_id": branch_id,
            "expected_revision": expected_revision,
            "actor": actor,
            "reason": reason,
        }
        key = _required_text(idempotency_key, "idempotency_key", 200)
        branch_id = _required_text(branch_id, "branch_id", 100)
        parent_branch_id = _required_text(parent_branch_id, "parent_branch_id", 100)
        actor = _required_text(actor, "actor", 200)
        reason = _required_text(reason, "reason", 1000)
        request_hash = hashlib.sha256(_json(envelope).encode("utf-8")).hexdigest()
        now, command_id = _now(), str(uuid4())
        with self.db.lock:
            connection = self.db.connection
            connection.execute("BEGIN IMMEDIATE")
            try:
                old = connection.execute(
                    "SELECT request_hash,result_json FROM commands WHERE workspace_id=? AND idempotency_key=?",
                    (workspace_id, key),
                ).fetchone()
                if old:
                    if old["request_hash"] != request_hash:
                        raise IdempotencyConflictError("Idempotency key was already used for another command")
                    connection.commit()
                    return json.loads(old["result_json"])
                parent = connection.execute(
                    "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                    (workspace_id, parent_branch_id),
                ).fetchone()
                if not parent:
                    raise NotFoundError("Parent branch does not exist in this workspace")
                if parent["head_revision"] != expected_revision:
                    raise ConflictError(f"Expected revision {expected_revision}; current revision is {parent['head_revision']}")
                if not branch_id or branch_id == parent_branch_id:
                    raise ValidationError("branch_id must be new and distinct from its parent")
                result = _snapshot_branch(
                    connection,
                    workspace_id=workspace_id,
                    parent_branch_id=parent_branch_id,
                    branch_id=branch_id,
                    revision=expected_revision,
                    actor=actor,
                    reason=reason,
                    command_id=command_id,
                    idempotency_key=key,
                    request_hash=request_hash,
                    envelope=envelope,
                    created_at=now,
                )
                connection.commit()
                return result
            except (ConflictError, IdempotencyConflictError, NotFoundError, ValidationError):
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise ConflictError("Branch id already exists or branch snapshot is invalid") from error
            except BaseException:
                connection.rollback()
                raise

    def execute(
        self,
        *,
        workspace_id: str,
        branch_id: str = "main",
        idempotency_key: str,
        expected_revision: int,
        command_type: str,
        payload: dict[str, Any],
        actor: str = "user",
        reason: str = "",
    ) -> dict[str, Any]:
        if command_type not in _ALLOWED_COMMANDS:
            raise ValidationError(f"Unsupported command type: {command_type}")
        if not isinstance(payload, dict):
            raise ValidationError("payload must be an object")
        if not isinstance(expected_revision, int) or expected_revision < 0:
            raise ValidationError("expected_revision must be a non-negative integer")
        key = _required_text(idempotency_key, "idempotency_key", 200)
        actor = _required_text(actor, "actor", 200)
        reason = _required_text(reason, "reason", 1000)
        request = {
            "workspace_id": workspace_id,
            "branch_id": branch_id,
            "command_type": command_type,
            "expected_revision": expected_revision,
            "payload": payload,
            "actor": actor,
            "reason": reason,
        }
        request_hash = _command_request_hash(request)
        command_id, now = str(uuid4()), _now()
        with self.db.lock:
            connection = self.db.connection
            connection.execute("BEGIN IMMEDIATE")
            try:
                old = connection.execute(
                    "SELECT request_hash,result_json FROM commands WHERE workspace_id=? AND idempotency_key=?",
                    (workspace_id, key),
                ).fetchone()
                if old:
                    if old["request_hash"] != request_hash:
                        raise IdempotencyConflictError("Idempotency key was already used for another command")
                    connection.commit()
                    return json.loads(old["result_json"])
                branch = connection.execute(
                    "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                    (workspace_id, branch_id),
                ).fetchone()
                if not branch:
                    raise NotFoundError("Branch does not exist in this workspace")
                if branch["head_revision"] != expected_revision:
                    raise ConflictError(f"Expected revision {expected_revision}; current revision is {branch['head_revision']}")
                revision = expected_revision + 1
                result, event_type, changed = self._apply(
                    connection, workspace_id, branch_id, revision, command_type, payload, actor
                )
                if changed:
                    connection.execute(
                        "INSERT INTO revisions(workspace_id,branch_id,revision,command_id,parent_revision,actor,reason,created_at,payload_json) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (workspace_id, branch_id, revision, command_id, expected_revision, actor, reason, now, _json(request)),
                    )
                    connection.execute(
                        "UPDATE branches SET head_revision=? WHERE workspace_id=? AND branch_id=?",
                        (revision, workspace_id, branch_id),
                    )
                    connection.execute(
                        "INSERT INTO audit_events(event_id,workspace_id,branch_id,revision,command_id,event_type,actor,reason,payload_json,created_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (str(uuid4()), workspace_id, branch_id, revision, command_id, event_type, actor, reason, _json(result), now),
                    )
                    connection.execute(
                        "INSERT INTO projection_outbox(outbox_id,workspace_id,branch_id,revision,projection,created_at) "
                        "VALUES(?,?,?,?, 'all', ?)",
                        (str(uuid4()), workspace_id, branch_id, revision, now),
                    )
                    result["revision"] = revision
                else:
                    result["revision"] = expected_revision
                result.update({"workspace_id": workspace_id, "branch_id": branch_id, "command_id": command_id})
                connection.execute(
                    "INSERT INTO commands(workspace_id,idempotency_key,request_hash,branch_id,result_json,created_at) VALUES(?,?,?,?,?,?)",
                    (workspace_id, key, request_hash, branch_id, _json(result), now),
                )
                connection.commit()
                return result
            except (ConflictError, IdempotencyConflictError, NotFoundError, ValidationError):
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise ConflictError("Command violates a canonical data constraint") from error
            except BaseException:
                connection.rollback()
                raise

    def replay(
        self,
        *,
        workspace_id: str,
        branch_id: str,
        idempotency_key: str,
        expected_revision: int,
        command_type: str,
        payload: dict[str, Any],
        actor: str = "user",
        reason: str = "",
    ) -> dict[str, Any] | None:
        """Return a matching prior command without repeating expensive work."""
        request = {
            "workspace_id": workspace_id,
            "branch_id": branch_id,
            "command_type": command_type,
            "expected_revision": expected_revision,
            "payload": payload,
            "actor": _required_text(actor, "actor", 200),
            "reason": _required_text(reason, "reason", 1000),
        }
        key = _required_text(idempotency_key, "idempotency_key", 200)
        request_hash = _command_request_hash(request)
        with self.db.lock:
            old = self.db.connection.execute(
                "SELECT request_hash,result_json FROM commands WHERE workspace_id=? AND idempotency_key=?",
                (workspace_id, key),
            ).fetchone()
        if not old:
            return None
        if old["request_hash"] != request_hash:
            raise IdempotencyConflictError("Idempotency key was already used for another command")
        return json.loads(old["result_json"])

    def _journal_event_fields(
        self,
        connection: sqlite3.Connection,
        workspace_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        title = _required_text(payload.get("title"), "title", 200)
        details = payload.get("details", "")
        time_note = payload.get("time_note", "")
        if not isinstance(details, str) or len(details) > 4000:
            raise ValidationError("details must be text of at most 4000 characters")
        if not isinstance(time_note, str) or len(time_note.strip()) > 300:
            raise ValidationError("time_note must be text of at most 300 characters")
        details = details.strip()
        time_note = time_note.strip()

        participants = payload.get("participants", [])
        if not isinstance(participants, list) or len(participants) > 30:
            raise ValidationError("participants must be a list of at most 30 names")
        clean_participants: list[str] = []
        seen_participants: set[str] = set()
        for participant in participants:
            name = _required_text(participant, "participant", 200)
            identity = name.casefold()
            if identity not in seen_participants:
                clean_participants.append(name)
                seen_participants.add(identity)

        temporal_kind = payload.get("temporal_kind")
        if not isinstance(temporal_kind, str) or temporal_kind not in {"exact", "range", "relative", "unknown"}:
            raise ValidationError("temporal_kind must be exact, range, relative, or unknown")

        occurred_from = _optional_iso_date(payload.get("occurred_from"), "occurred_from")
        occurred_to = _optional_iso_date(payload.get("occurred_to"), "occurred_to")
        if temporal_kind == "exact" and (not occurred_from or occurred_to):
            raise ValidationError("An exact event needs one date")
        if temporal_kind == "range" and (not occurred_from or not occurred_to):
            raise ValidationError("A date range needs both a start and end date")
        if temporal_kind == "range" and occurred_from and occurred_to and occurred_to < occurred_from:
            raise ValidationError("The end date cannot be before the start date")
        if temporal_kind in {"relative", "unknown"} and (occurred_from or occurred_to):
            raise ValidationError("Relative or unknown events cannot include calendar dates")
        if temporal_kind == "relative" and not time_note:
            raise ValidationError("Describe the relative timing, for example 'the following winter'")

        source_id = payload.get("source_id")
        if source_id is not None and source_id != "":
            source_id = _required_text(source_id, "source_id", 100)
            source = connection.execute(
                "SELECT content FROM sources WHERE workspace_id=? AND source_id=?",
                (workspace_id, source_id),
            ).fetchone()
            if not source:
                raise NotFoundError("Journal event source does not exist in this workspace")
        else:
            source_id = None
        source_quote = payload.get("source_quote")
        if source_quote is not None and source_quote != "":
            source_quote = _required_text(source_quote, "source_quote", 10000)
            if not source_id:
                raise ValidationError("Choose a source before attaching an exact quote")
            if source_quote not in source["content"]:
                raise ValidationError("Journal event quote must be present in the imported source")
        else:
            source_quote = None

        return {
            "title": title,
            "details": details,
            "participants_json": _json(clean_participants),
            "temporal_kind": temporal_kind,
            "occurred_from": occurred_from,
            "occurred_to": occurred_to,
            "time_note": time_note,
            "source_id": source_id,
            "source_quote": source_quote,
        }

    def _apply(
        self,
        connection: sqlite3.Connection,
        workspace_id: str,
        branch_id: str,
        revision: int,
        command_type: str,
        payload: dict[str, Any],
        actor: str,
    ) -> tuple[dict[str, Any], str, bool]:
        if command_type == "promote_branch":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot promote branches")
            source_branch_id = _required_text(payload.get("source_branch_id"), "source_branch_id", 100)
            if source_branch_id == branch_id:
                raise ValidationError("A branch cannot be promoted into itself")
            source_revision = payload.get("source_revision")
            if type(source_revision) is not int or source_revision < 0:
                raise ValidationError("source_revision must be a non-negative integer")
            source_branch = connection.execute(
                "SELECT parent_branch_id,parent_revision,base_revision,head_revision "
                "FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, source_branch_id),
            ).fetchone()
            if not source_branch:
                raise NotFoundError("Source branch does not exist in this workspace")
            if source_branch["parent_branch_id"] != branch_id:
                raise ValidationError("Only a direct child branch can be promoted into its parent")
            parent_revision = source_branch["parent_revision"]
            if parent_revision is None or source_branch["base_revision"] != parent_revision:
                raise ConflictError("The source branch does not have a consistent parent snapshot")
            target_branch = connection.execute(
                "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if target_branch is None:
                raise NotFoundError("Target branch does not exist in this workspace")
            if target_branch["head_revision"] != parent_revision:
                raise ConflictError("The parent branch advanced after this scenario was created")
            if source_branch["head_revision"] != source_revision:
                raise ConflictError(
                    f"Expected source revision {source_revision}; current revision is {source_branch['head_revision']}"
                )
            if source_revision <= source_branch["base_revision"]:
                raise ValidationError("The source branch has no changes to promote")

            copied_rows = _promote_branch_snapshot(
                connection,
                workspace_id,
                branch_id,
                source_branch_id,
                source_branch["base_revision"],
                revision,
            )
            return {
                "target_branch_id": branch_id,
                "source_branch_id": source_branch_id,
                "source_base_revision": source_branch["base_revision"],
                "source_revision": source_revision,
                "source_revision_range": [source_branch["base_revision"] + 1, source_revision],
                "copied_rows": copied_rows,
            }, "branch.promoted", True

        if command_type == "create_entity":
            entity_id = _required_text(payload.get("entity_id") or str(uuid4()), "entity_id", 100)
            entity_type = _required_text(payload.get("entity_type"), "entity_type", 100)
            label = _required_text(payload.get("label"), "label")
            properties = payload.get("properties", {})
            if not isinstance(properties, dict):
                raise ValidationError("properties must be an object")
            properties_json = _json(properties)
            connection.execute(
                "INSERT INTO entities(workspace_id,branch_id,entity_id,entity_type,label,properties_json,created_revision,updated_revision) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, entity_id, entity_type, label, properties_json, revision, revision),
            )
            connection.execute(
                "INSERT INTO entity_search(workspace_id,branch_id,entity_id,label,properties) VALUES(?,?,?,?,?)",
                (workspace_id, branch_id, entity_id, label, properties_json),
            )
            return {"entity_id": entity_id, "entity_type": entity_type, "label": label}, "entity.created", True

        if command_type == "update_entity":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot directly correct canonical entities")
            entity_id = _required_text(payload.get("entity_id"), "entity_id", 100)
            row = connection.execute(
                "SELECT entity_type,label,properties_json FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, entity_id),
            ).fetchone()
            if not row:
                raise NotFoundError("Entity does not exist in this branch")
            before = {
                "entity_type": row["entity_type"],
                "label": row["label"],
                "properties": json.loads(row["properties_json"]),
            }
            entity_type = _required_text(payload.get("entity_type", row["entity_type"]), "entity_type", 100)
            label = _required_text(payload.get("label", row["label"]), "label")
            properties = payload.get("properties", json.loads(row["properties_json"]))
            if not isinstance(properties, dict):
                raise ValidationError("properties must be an object")
            properties_json = _json(properties)
            after = {"entity_type": entity_type, "label": label, "properties": json.loads(properties_json)}
            if after == before:
                return {"entity_id": entity_id, "before": before, "after": after}, "entity.updated", False
            connection.execute(
                "UPDATE entities SET entity_type=?,label=?,properties_json=?,updated_revision=? "
                "WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (entity_type, label, properties_json, revision, workspace_id, branch_id, entity_id),
            )
            connection.execute(
                "DELETE FROM entity_search WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, entity_id),
            )
            connection.execute(
                "INSERT INTO entity_search(workspace_id,branch_id,entity_id,label,properties) VALUES(?,?,?,?,?)",
                (workspace_id, branch_id, entity_id, label, properties_json),
            )
            return {"entity_id": entity_id, "before": before, "after": after}, "entity.updated", True

        if command_type == "add_relation":
            relation_id = _required_text(payload.get("relation_id") or str(uuid4()), "relation_id", 100)
            source_id = _required_text(payload.get("source_entity_id"), "source_entity_id", 100)
            target_id = _required_text(payload.get("target_entity_id"), "target_entity_id", 100)
            relation_type = _required_text(payload.get("relation_type"), "relation_type", 100)
            status = payload.get("review_status", "proposed")
            if status not in {"proposed", "accepted", "rejected"}:
                raise ValidationError("invalid review_status")
            if actor.startswith("ai:") and status == "accepted":
                raise ValidationError("AI actors may propose relations but cannot accept them")
            properties = payload.get("properties", {})
            if not isinstance(properties, dict):
                raise ValidationError("properties must be an object")
            connection.execute(
                "INSERT INTO relations(workspace_id,branch_id,relation_id,source_entity_id,target_entity_id,relation_type,properties_json,review_status,created_revision) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, relation_id, source_id, target_id, relation_type, _json(properties), status, revision),
            )
            return {"relation_id": relation_id, "review_status": status}, "relation.created", True

        if command_type == "update_relation":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot directly correct canonical relationships")
            relation_id = _required_text(payload.get("relation_id"), "relation_id", 100)
            row = connection.execute(
                "SELECT source_entity_id,target_entity_id,relation_type,properties_json,review_status "
                "FROM relations WHERE workspace_id=? AND branch_id=? AND relation_id=?",
                (workspace_id, branch_id, relation_id),
            ).fetchone()
            if not row:
                raise NotFoundError("Relationship does not exist in this branch")
            before = {
                "source_entity_id": row["source_entity_id"],
                "target_entity_id": row["target_entity_id"],
                "relation_type": row["relation_type"],
                "properties": json.loads(row["properties_json"]),
                "review_status": row["review_status"],
            }
            source_id = _required_text(payload.get("source_entity_id", row["source_entity_id"]), "source_entity_id", 100)
            target_id = _required_text(payload.get("target_entity_id", row["target_entity_id"]), "target_entity_id", 100)
            relation_type = _required_text(payload.get("relation_type", row["relation_type"]), "relation_type", 100)
            properties = payload.get("properties", json.loads(row["properties_json"]))
            if not isinstance(properties, dict):
                raise ValidationError("properties must be an object")
            endpoints = connection.execute(
                "SELECT entity_id FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id IN (?,?)",
                (workspace_id, branch_id, source_id, target_id),
            ).fetchall()
            if len({endpoint["entity_id"] for endpoint in endpoints}) != len({source_id, target_id}):
                raise NotFoundError("Relationship endpoint does not exist in this branch")
            properties_json = _json(properties)
            fields_changed = (
                source_id != row["source_entity_id"]
                or target_id != row["target_entity_id"]
                or relation_type != row["relation_type"]
                or properties_json != row["properties_json"]
            )
            next_status = row["review_status"]
            if fields_changed and next_status != "proposed":
                next_status = "proposed"
            after = {
                "source_entity_id": source_id,
                "target_entity_id": target_id,
                "relation_type": relation_type,
                "properties": json.loads(properties_json),
                "review_status": next_status,
            }
            if not fields_changed:
                return {"relation_id": relation_id, "before": before, "after": after}, "relation.updated", False
            connection.execute(
                "UPDATE relations SET source_entity_id=?,target_entity_id=?,relation_type=?,properties_json=?,review_status=? "
                "WHERE workspace_id=? AND branch_id=? AND relation_id=?",
                (source_id, target_id, relation_type, properties_json, next_status, workspace_id, branch_id, relation_id),
            )
            return {"relation_id": relation_id, "before": before, "after": after}, "relation.updated", True

        if command_type == "review_relation":
            relation_id = _required_text(payload.get("relation_id"), "relation_id", 100)
            status = payload.get("review_status")
            if status not in {"accepted", "rejected"}:
                raise ValidationError("review_status must be accepted or rejected")
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot review or accept relations")
            row = connection.execute(
                "SELECT review_status FROM relations WHERE workspace_id=? AND branch_id=? AND relation_id=?",
                (workspace_id, branch_id, relation_id),
            ).fetchone()
            if not row:
                raise NotFoundError("Relation does not exist in this branch")
            if row["review_status"] == status:
                return {"relation_id": relation_id, "before": status, "after": status}, "relation.reviewed", False
            result = connection.execute(
                "UPDATE relations SET review_status=? WHERE workspace_id=? AND branch_id=? AND relation_id=?",
                (status, workspace_id, branch_id, relation_id),
            )
            if result.rowcount != 1:
                raise NotFoundError("Relation does not exist in this branch")
            return {"relation_id": relation_id, "before": row["review_status"], "after": status}, "relation.reviewed", True

        if command_type == "add_claim":
            claim_id = _required_text(payload.get("claim_id") or str(uuid4()), "claim_id", 100)
            subject_id = _required_text(payload.get("subject_entity_id"), "subject_entity_id", 100)
            predicate = _required_text(payload.get("predicate"), "predicate", 200)
            object_value = _required_text(payload.get("object_value"), "object_value", 4000)
            epistemic = payload.get("epistemic_status", "unknown")
            status = payload.get("review_status", "proposed")
            visibility = payload.get("visibility", "public")
            narrative_order = payload.get("narrative_order", 0)
            if epistemic not in {"unknown", "believed", "known", "contested"}:
                raise ValidationError("invalid epistemic_status")
            if status not in {"proposed", "accepted", "rejected"}:
                raise ValidationError("invalid review_status")
            if visibility not in {"public", "actor_scoped", "author_only"}:
                raise ValidationError("invalid visibility")
            if not isinstance(narrative_order, int) or narrative_order < 0:
                raise ValidationError("narrative_order must be a non-negative integer")
            if actor.startswith("ai:") and status == "accepted":
                raise ValidationError("AI actors may propose claims but cannot accept them")
            evidence = payload.get("evidence", [])
            if not isinstance(evidence, list):
                raise ValidationError("evidence must be a list")
            for evidence_id in evidence:
                linked = connection.execute(
                    "SELECT 1 FROM evidence WHERE workspace_id=? AND branch_id=? AND evidence_id=?",
                    (workspace_id, branch_id, evidence_id),
                ).fetchone()
                if not linked:
                    raise ValidationError(f"Evidence {evidence_id!r} does not exist in this branch")
            connection.execute(
                "INSERT INTO claims(workspace_id,branch_id,claim_id,subject_entity_id,predicate,object_value,epistemic_status,review_status,visibility,narrative_order,evidence_json,created_revision) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, claim_id, subject_id, predicate, object_value, epistemic, status, visibility, narrative_order, _json(evidence), revision),
            )
            return {"claim_id": claim_id, "review_status": status, "epistemic_status": epistemic, "visibility": visibility}, "claim.created", True

        if command_type == "update_claim":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot directly correct canonical claims")
            claim_id = _required_text(payload.get("claim_id"), "claim_id", 100)
            row = connection.execute(
                "SELECT subject_entity_id,predicate,object_value,epistemic_status,review_status,visibility,"
                "narrative_order,evidence_json FROM claims WHERE workspace_id=? AND branch_id=? AND claim_id=?",
                (workspace_id, branch_id, claim_id),
            ).fetchone()
            if not row:
                raise NotFoundError("Claim does not exist in this branch")
            before = {
                "subject_entity_id": row["subject_entity_id"],
                "predicate": row["predicate"],
                "object_value": row["object_value"],
                "epistemic_status": row["epistemic_status"],
                "review_status": row["review_status"],
                "visibility": row["visibility"],
                "narrative_order": row["narrative_order"],
                "evidence": json.loads(row["evidence_json"]),
            }
            subject_id = _required_text(payload.get("subject_entity_id", row["subject_entity_id"]), "subject_entity_id", 100)
            subject = connection.execute(
                "SELECT 1 FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, subject_id),
            ).fetchone()
            if not subject:
                raise NotFoundError("Claim subject does not exist in this branch")
            predicate = _required_text(payload.get("predicate", row["predicate"]), "predicate", 200)
            object_value = _required_text(payload.get("object_value", row["object_value"]), "object_value", 4000)
            epistemic = payload.get("epistemic_status", row["epistemic_status"])
            visibility = payload.get("visibility", row["visibility"])
            narrative_order = payload.get("narrative_order", row["narrative_order"])
            if epistemic not in {"unknown", "believed", "known", "contested"}:
                raise ValidationError("invalid epistemic_status")
            if visibility not in {"public", "actor_scoped", "author_only"}:
                raise ValidationError("invalid visibility")
            if type(narrative_order) is not int or narrative_order < 0:
                raise ValidationError("narrative_order must be a non-negative integer")
            evidence = payload.get("evidence", json.loads(row["evidence_json"]))
            if not isinstance(evidence, list) or any(not isinstance(item, str) for item in evidence):
                raise ValidationError("evidence must be a list of evidence ids")
            if len(evidence) != len(set(evidence)):
                raise ValidationError("evidence ids must be unique")
            for evidence_id in evidence:
                linked = connection.execute(
                    "SELECT 1 FROM evidence WHERE workspace_id=? AND branch_id=? AND evidence_id=?",
                    (workspace_id, branch_id, evidence_id),
                ).fetchone()
                if not linked:
                    raise NotFoundError(f"Evidence {evidence_id!r} does not exist in this branch")
            semantic_fields = {
                "subject_entity_id": subject_id,
                "predicate": predicate,
                "object_value": object_value,
                "epistemic_status": epistemic,
                "visibility": visibility,
                "narrative_order": narrative_order,
                "evidence": evidence,
            }
            fields_changed = any(before[key] != value for key, value in semantic_fields.items())
            status = row["review_status"]
            if fields_changed and status != "proposed":
                status = "proposed"
            after = {**semantic_fields, "review_status": status}
            if not fields_changed:
                return {"claim_id": claim_id, "before": before, "after": after}, "claim.updated", False
            connection.execute(
                "UPDATE claims SET subject_entity_id=?,predicate=?,object_value=?,epistemic_status=?,review_status=?,"
                "visibility=?,narrative_order=?,evidence_json=? WHERE workspace_id=? AND branch_id=? AND claim_id=?",
                (subject_id, predicate, object_value, epistemic, status, visibility, narrative_order, _json(evidence),
                 workspace_id, branch_id, claim_id),
            )
            return {"claim_id": claim_id, "before": before, "after": after}, "claim.updated", True

        if command_type == "review_claim":
            claim_id = _required_text(payload.get("claim_id"), "claim_id", 100)
            status = payload.get("review_status")
            if status not in {"accepted", "rejected"}:
                raise ValidationError("review_status must be accepted or rejected")
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot review or accept claims")
            row = connection.execute(
                "SELECT review_status FROM claims WHERE workspace_id=? AND branch_id=? AND claim_id=?",
                (workspace_id, branch_id, claim_id),
            ).fetchone()
            if not row:
                raise NotFoundError("Claim does not exist in this branch")
            if row["review_status"] == status:
                return {"claim_id": claim_id, "before": status, "after": status}, "claim.reviewed", False
            result = connection.execute(
                "UPDATE claims SET review_status=? WHERE workspace_id=? AND branch_id=? AND claim_id=?",
                (status, workspace_id, branch_id, claim_id),
            )
            if result.rowcount != 1:
                raise NotFoundError("Claim does not exist in this branch")
            return {"claim_id": claim_id, "before": row["review_status"], "after": status}, "claim.reviewed", True

        if command_type == "create_rule":
            rule_id = _required_text(payload.get("rule_id") or str(uuid4()), "rule_id", 100)
            name = _required_text(payload.get("name"), "name", 200)
            description = payload.get("description", "")
            if not isinstance(description, str) or len(description) > 1000:
                raise ValidationError("description must be text of at most 1000 characters")
            mode = payload.get("rule_mode")
            if not isinstance(mode, str) or mode not in {"require", "forbid"}:
                raise ValidationError("rule_mode must be require or forbid")
            severity = payload.get("severity", "hard")
            if not isinstance(severity, str) or severity not in {"hard", "soft"}:
                raise ValidationError("severity must be hard or soft")
            subject_id = _required_text(payload.get("subject_entity_id"), "subject_entity_id", 100)
            predicate = _required_text(payload.get("predicate"), "predicate", 200)
            object_value = _required_text(payload.get("object_value"), "object_value", 4000)
            cardinality = payload.get("predicate_cardinality", "multiple")
            if not isinstance(cardinality, str) or cardinality not in {"single", "multiple"}:
                raise ValidationError("predicate_cardinality must be single or multiple")
            status = payload.get("review_status", "proposed")
            if not isinstance(status, str) or status not in {"proposed", "accepted", "rejected"}:
                raise ValidationError("invalid review_status")
            if actor.startswith("ai:") and status == "accepted":
                raise ValidationError("AI actors may propose rules but cannot accept them")
            subject = connection.execute(
                "SELECT 1 FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, subject_id),
            ).fetchone()
            if not subject:
                raise NotFoundError("Rule subject does not exist in this branch")
            connection.execute(
                "INSERT INTO rules(workspace_id,branch_id,rule_id,name,description,rule_mode,severity,"
                "subject_entity_id,predicate,object_value,predicate_cardinality,review_status,created_revision) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, rule_id, name, description.strip(), mode, severity,
                 subject_id, predicate, object_value, cardinality, status, revision),
            )
            return {"rule_id": rule_id, "review_status": status}, "rule.created", True

        if command_type == "review_rule":
            rule_id = _required_text(payload.get("rule_id"), "rule_id", 100)
            status = payload.get("review_status")
            if not isinstance(status, str) or status not in {"accepted", "rejected"}:
                raise ValidationError("review_status must be accepted or rejected")
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot review or accept rules")
            result = connection.execute(
                "UPDATE rules SET review_status=? WHERE workspace_id=? AND branch_id=? AND rule_id=?",
                (status, workspace_id, branch_id, rule_id),
            )
            if result.rowcount != 1:
                raise NotFoundError("Rule does not exist in this branch")
            return {"rule_id": rule_id, "review_status": status}, "rule.reviewed", True

        if command_type == "create_scenario":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot create scenarios directly")
            scenario_id = _required_text(payload.get("scenario_id") or str(uuid4()), "scenario_id", 100)
            title = _required_text(payload.get("title"), "title", 200)
            problem = _required_text(payload.get("problem"), "problem", 4000)
            raw_constraints = payload.get("constraints", [])
            if not isinstance(raw_constraints, list) or len(raw_constraints) > 20:
                raise ValidationError("constraints must be a list of at most 20 items")
            constraints = [_required_text(item, "constraint", 500) for item in raw_constraints]

            raw_options = payload.get("options")
            if not isinstance(raw_options, list) or not 2 <= len(raw_options) <= 3:
                raise ValidationError("A scenario must have two or three options")
            options = []
            option_ids: set[str] = set()
            for index, raw_option in enumerate(raw_options):
                if not isinstance(raw_option, dict):
                    raise ValidationError("Each scenario option must be an object")
                option_id = _required_text(raw_option.get("option_id") or str(uuid4()), "option_id", 100)
                label = _required_text(raw_option.get("label"), "option label", 200)
                description = raw_option.get("description", "")
                if not isinstance(description, str) or len(description.strip()) > 1000:
                    raise ValidationError("option description must be text of at most 1000 characters")
                if option_id in option_ids:
                    raise ValidationError("Scenario option ids must be unique")
                option_ids.add(option_id)
                options.append((option_id, label, description.strip(), index))

            claim_ids = payload.get("evidence_claim_ids", [])
            source_ids = payload.get("evidence_source_ids", [])
            if not isinstance(claim_ids, list) or len(claim_ids) > 100:
                raise ValidationError("evidence_claim_ids must be a list of at most 100 ids")
            if not isinstance(source_ids, list) or len(source_ids) > 100:
                raise ValidationError("evidence_source_ids must be a list of at most 100 ids")
            claim_ids = list(dict.fromkeys(_required_text(value, "claim_id", 100) for value in claim_ids))
            source_ids = list(dict.fromkeys(_required_text(value, "source_id", 100) for value in source_ids))
            for claim_id in claim_ids:
                exists = connection.execute(
                    "SELECT 1 FROM claims WHERE workspace_id=? AND branch_id=? AND claim_id=?",
                    (workspace_id, branch_id, claim_id),
                ).fetchone()
                if not exists:
                    raise NotFoundError("Scenario evidence claim does not exist in this branch")
            for source_id in source_ids:
                exists = connection.execute(
                    "SELECT 1 FROM sources WHERE workspace_id=? AND source_id=?",
                    (workspace_id, source_id),
                ).fetchone()
                if not exists:
                    raise NotFoundError("Scenario evidence source does not exist in this workspace")

            now = _now()
            connection.execute(
                "INSERT INTO scenarios(workspace_id,branch_id,scenario_id,title,problem,constraints_json,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, scenario_id, title, problem, _json(constraints), revision, now),
            )
            connection.executemany(
                "INSERT INTO scenario_options(workspace_id,branch_id,scenario_id,option_id,label,description,position,created_revision) "
                "VALUES(?,?,?,?,?,?,?,?)",
                [(workspace_id, branch_id, scenario_id, option_id, label, description, position, revision)
                 for option_id, label, description, position in options],
            )
            connection.executemany(
                "INSERT INTO scenario_claim_evidence(workspace_id,branch_id,scenario_id,claim_id,created_revision) VALUES(?,?,?,?,?)",
                [(workspace_id, branch_id, scenario_id, claim_id, revision) for claim_id in claim_ids],
            )
            connection.executemany(
                "INSERT INTO scenario_source_evidence(workspace_id,branch_id,scenario_id,source_id,created_revision) VALUES(?,?,?,?,?)",
                [(workspace_id, branch_id, scenario_id, source_id, revision) for source_id in source_ids],
            )
            return {
                "scenario_id": scenario_id,
                "option_ids": [option[0] for option in options],
                "evidence_claim_ids": claim_ids,
                "evidence_source_ids": source_ids,
            }, "scenario.created", True

        if command_type == "set_scenario_assumption":
            scenario_id = _required_text(payload.get("scenario_id"), "scenario_id", 100)
            option_id = _required_text(payload.get("option_id"), "option_id", 100)
            assumption_id = _required_text(payload.get("assumption_id") or str(uuid4()), "assumption_id", 100)
            subject_id = _required_text(payload.get("subject_entity_id"), "subject_entity_id", 100)
            predicate = _required_text(payload.get("predicate"), "predicate", 200)
            object_value = _required_text(payload.get("object_value"), "object_value", 4000)
            assumption_action = payload.get("assumption_action")
            cardinality = payload.get("predicate_cardinality")
            if not isinstance(assumption_action, str) or not isinstance(cardinality, str):
                raise ValidationError("assumption_action and predicate_cardinality must be text values")
            if (assumption_action, cardinality) not in {("add", "multiple"), ("replace", "single")}:
                raise ValidationError("Use add for a multiple-valued property or replace for a single-valued property")
            status = payload.get("review_status", "proposed" if actor.startswith("ai:") else "accepted")
            if not isinstance(status, str) or status not in {"proposed", "accepted"}:
                raise ValidationError("review_status must be proposed or accepted when setting an assumption")
            if actor.startswith("ai:") and status != "proposed":
                raise ValidationError("AI actors may propose assumptions but cannot accept them")
            expected_version = payload.get("expected_version")
            latest = connection.execute(
                "SELECT version FROM scenario_assumptions WHERE workspace_id=? AND branch_id=? AND scenario_id=? "
                "AND option_id=? AND assumption_id=? ORDER BY version DESC LIMIT 1",
                (workspace_id, branch_id, scenario_id, option_id, assumption_id),
            ).fetchone()
            if latest:
                if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != latest["version"]:
                    raise ConflictError(f"Expected assumption version {expected_version}; current version is {latest['version']}")
                version = latest["version"] + 1
                supersedes_version = latest["version"]
            else:
                if expected_version is not None:
                    raise NotFoundError("Scenario assumption does not exist at the requested version")
                version = 1
                supersedes_version = None
            option = connection.execute(
                "SELECT 1 FROM scenario_options WHERE workspace_id=? AND branch_id=? AND scenario_id=? AND option_id=?",
                (workspace_id, branch_id, scenario_id, option_id),
            ).fetchone()
            if not option:
                raise NotFoundError("Scenario option does not exist in this branch")
            entity = connection.execute(
                "SELECT 1 FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, subject_id),
            ).fetchone()
            if not entity:
                raise NotFoundError("Assumption subject does not exist in this branch")
            connection.execute(
                "INSERT INTO scenario_assumptions(workspace_id,branch_id,scenario_id,option_id,assumption_id,version,"
                "subject_entity_id,predicate,object_value,assumption_action,predicate_cardinality,review_status,"
                "supersedes_version,created_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, scenario_id, option_id, assumption_id, version, subject_id,
                 predicate, object_value, assumption_action, cardinality, status, supersedes_version, revision, _now()),
            )
            return {
                "scenario_id": scenario_id, "option_id": option_id, "assumption_id": assumption_id,
                "version": version, "review_status": status, "assumption_action": assumption_action,
            }, "scenario.assumption_set", True

        if command_type == "review_scenario_assumption":
            scenario_id = _required_text(payload.get("scenario_id"), "scenario_id", 100)
            option_id = _required_text(payload.get("option_id"), "option_id", 100)
            assumption_id = _required_text(payload.get("assumption_id"), "assumption_id", 100)
            expected_version = payload.get("expected_version")
            status = payload.get("review_status")
            if not isinstance(status, str) or status not in {"accepted", "rejected"}:
                raise ValidationError("review_status must be accepted or rejected")
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot review assumptions")
            latest = connection.execute(
                "SELECT * FROM scenario_assumptions WHERE workspace_id=? AND branch_id=? AND scenario_id=? "
                "AND option_id=? AND assumption_id=? ORDER BY version DESC LIMIT 1",
                (workspace_id, branch_id, scenario_id, option_id, assumption_id),
            ).fetchone()
            if not latest:
                raise NotFoundError("Scenario assumption does not exist in this branch")
            if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version != latest["version"]:
                raise ConflictError(f"Expected assumption version {expected_version}; current version is {latest['version']}")
            if latest["review_status"] == status:
                return {
                    "scenario_id": scenario_id, "option_id": option_id, "assumption_id": assumption_id,
                    "version": latest["version"], "review_status": status,
                }, "scenario.assumption_reviewed", False
            version = latest["version"] + 1
            connection.execute(
                "INSERT INTO scenario_assumptions(workspace_id,branch_id,scenario_id,option_id,assumption_id,version,"
                "subject_entity_id,predicate,object_value,assumption_action,predicate_cardinality,review_status,"
                "supersedes_version,created_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, scenario_id, option_id, assumption_id, version,
                 latest["subject_entity_id"], latest["predicate"], latest["object_value"],
                 latest["assumption_action"], latest["predicate_cardinality"], status, latest["version"],
                 revision, _now()),
            )
            return {
                "scenario_id": scenario_id, "option_id": option_id, "assumption_id": assumption_id,
                "version": version, "review_status": status,
            }, "scenario.assumption_reviewed", True

        if command_type == "add_belief":
            belief_id = _required_text(payload.get("belief_id") or str(uuid4()), "belief_id", 100)
            actor_id = _required_text(payload.get("actor_entity_id"), "actor_entity_id", 100)
            claim_id = _required_text(payload.get("claim_id"), "claim_id", 100)
            stance = payload.get("stance")
            awareness_order = payload.get("awareness_order", 0)
            if stance not in {"knows", "believes", "denies", "unaware"}:
                raise ValidationError("invalid actor belief stance")
            if not isinstance(awareness_order, int) or awareness_order < 0:
                raise ValidationError("awareness_order must be a non-negative integer")
            connection.execute(
                "INSERT INTO actor_beliefs(workspace_id,branch_id,belief_id,actor_entity_id,claim_id,stance,awareness_order,created_revision) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, belief_id, actor_id, claim_id, stance, awareness_order, revision),
            )
            return {"belief_id": belief_id, "actor_entity_id": actor_id, "claim_id": claim_id, "stance": stance}, "belief.created", True

        if command_type == "import_source":
            display_name = _required_text(payload.get("display_name"), "display_name", 500)
            content = payload.get("content")
            if not isinstance(content, str):
                raise ValidationError("content must be text")
            try:
                content_bytes = content.encode("utf-8")
            except UnicodeEncodeError as error:
                raise ValidationError("content must be valid UTF-8 text") from error
            if len(content_bytes) > 10 * 1024 * 1024:
                raise ValidationError("text sources are limited to 10 MiB")
            if not content.strip():
                raise ValidationError("text source content cannot be empty")
            if b"\x00" in content_bytes:
                raise ValidationError("text source contains binary data")
            requested_media_type = _required_text(payload.get("media_type", "text/plain"), "media_type", 200)
            media_type = requested_media_type.split(";", 1)[0].strip().lower()
            if media_type not in {"text/plain", "text/markdown"}:
                raise ValidationError("only plain text and Markdown sources are supported")
            digest = hashlib.sha256(content_bytes).hexdigest()
            old = connection.execute(
                "SELECT source_id,display_name FROM sources WHERE workspace_id=? AND content_sha256=?",
                (workspace_id, digest),
            ).fetchone()
            if old:
                return {"source_id": old["source_id"], "display_name": old["display_name"], "duplicate": True}, "source.duplicate", False
            source_id = _required_text(payload.get("source_id") or str(uuid4()), "source_id", 100)
            connection.execute(
                "INSERT INTO sources(workspace_id,source_id,display_name,media_type,content_sha256,content,created_at) VALUES(?,?,?,?,?,?,?)",
                (workspace_id, source_id, display_name, media_type, digest, content, _now()),
            )
            connection.execute(
                "INSERT INTO source_search(workspace_id,source_id,display_name,content) VALUES(?,?,?,?)",
                (workspace_id, source_id, display_name, content),
            )
            return {"source_id": source_id, "display_name": display_name, "duplicate": False}, "source.imported", True

        if command_type == "add_evidence":
            evidence_id = _required_text(payload.get("evidence_id") or str(uuid4()), "evidence_id", 100)
            source_id = _required_text(payload.get("source_id"), "source_id", 100)
            anchor = _required_text(payload.get("anchor"), "anchor", 1000)
            quote = _required_text(payload.get("quote"), "quote", 10000)
            source = connection.execute(
                "SELECT content FROM sources WHERE workspace_id=? AND source_id=?",
                (workspace_id, source_id),
            ).fetchone()
            if not source:
                raise NotFoundError("Evidence source does not exist in this workspace")
            if quote not in source["content"]:
                raise ValidationError("Evidence quote must be present in the imported source")
            fingerprint = hashlib.sha256((anchor + "\0" + quote).encode("utf-8")).hexdigest()
            connection.execute(
                "INSERT INTO evidence(workspace_id,branch_id,evidence_id,source_id,anchor,quote,context_fingerprint,created_revision) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, evidence_id, source_id, anchor, quote, fingerprint, revision),
            )
            entity_id = payload.get("entity_id")
            if entity_id is not None:
                entity_id = _required_text(entity_id, "entity_id", 100)
                entity = connection.execute(
                    "SELECT 1 FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                    (workspace_id, branch_id, entity_id),
                ).fetchone()
                if not entity:
                    raise NotFoundError("Evidence entity does not exist in this branch")
                connection.execute(
                    "INSERT INTO entity_evidence(workspace_id,branch_id,entity_id,evidence_id,created_revision) VALUES(?,?,?,?,?)",
                    (workspace_id, branch_id, entity_id, evidence_id, revision),
                )
            return {"evidence_id": evidence_id, "source_id": source_id}, "evidence.created", True

        if command_type == "record_extraction_batch":
            batch_id = _required_text(payload.get("batch_id"), "batch_id", 100)
            source_id = _required_text(payload.get("source_id"), "source_id", 100)
            source_sha256 = _required_text(payload.get("source_sha256"), "source_sha256", 64)
            model = _required_text(payload.get("model"), "model", 200)
            extractor_version = _required_text(payload.get("extractor_version"), "extractor_version", 100)
            prompt_version = _required_text(payload.get("prompt_version"), "prompt_version", 100)
            schema_version = payload.get("output_schema_version")
            if type(schema_version) is not int or schema_version < 1:
                raise ValidationError("output_schema_version must be a positive integer")
            source = connection.execute(
                "SELECT content,content_sha256 FROM sources WHERE workspace_id=? AND source_id=?",
                (workspace_id, source_id),
            ).fetchone()
            if not source:
                raise NotFoundError("Extraction source does not exist in this workspace")
            if source["content_sha256"] != source_sha256:
                raise ConflictError("The source content changed after extraction started")
            candidates = payload.get("candidates")
            if not isinstance(candidates, list) or len(candidates) > 80:
                raise ValidationError("candidates must be a list of at most 80 proposals")
            normalized_candidates = [
                _validated_extraction_candidate(candidate, source["content"])
                for candidate in candidates
            ]
            candidate_ids = [candidate[0] for candidate in normalized_candidates]
            if len(candidate_ids) != len(set(candidate_ids)):
                raise ValidationError("Extraction candidate ids must be unique")
            now = _now()
            connection.execute(
                "INSERT INTO extraction_batches(workspace_id,branch_id,batch_id,source_id,source_sha256,model,"
                "extractor_version,prompt_version,output_schema_version,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, batch_id, source_id, source_sha256, model,
                 extractor_version, prompt_version, schema_version, revision, now),
            )
            connection.executemany(
                "INSERT INTO extraction_candidates(workspace_id,branch_id,candidate_id,batch_id,kind,payload_json,"
                "review_status,created_revision) VALUES(?,?,?,?,?,?,'proposed',?)",
                [(workspace_id, branch_id, candidate_id, batch_id, kind, _json(data), revision)
                 for candidate_id, kind, data in normalized_candidates],
            )
            return {
                "batch_id": batch_id,
                "source_id": source_id,
                "candidate_count": len(normalized_candidates),
                "proposed_count": len(normalized_candidates),
            }, "extraction.batch_recorded", True

        if command_type == "review_extraction_candidate":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot review extraction candidates")
            candidate_id = _required_text(payload.get("candidate_id"), "candidate_id", 100)
            decision = payload.get("review_status")
            if not isinstance(decision, str) or decision not in {"accepted", "rejected"}:
                raise ValidationError("review_status must be accepted or rejected")
            candidate_row = connection.execute(
                "SELECT c.batch_id,c.kind,c.payload_json,c.review_status,b.source_id,b.source_sha256 "
                "FROM extraction_candidates c JOIN extraction_batches b ON b.workspace_id=c.workspace_id "
                "AND b.branch_id=c.branch_id AND b.batch_id=c.batch_id "
                "WHERE c.workspace_id=? AND c.branch_id=? AND c.candidate_id=?",
                (workspace_id, branch_id, candidate_id),
            ).fetchone()
            if not candidate_row:
                raise NotFoundError("Extraction candidate does not exist in this branch")
            if candidate_row["review_status"] != "proposed":
                raise ConflictError("Extraction candidate has already been reviewed")

            canonical_type = None
            canonical_id = None
            if decision == "accepted":
                candidate_data = json.loads(candidate_row["payload_json"])
                source = connection.execute(
                    "SELECT content,content_sha256 FROM sources WHERE workspace_id=? AND source_id=?",
                    (workspace_id, candidate_row["source_id"]),
                ).fetchone()
                if not source or source["content_sha256"] != candidate_row["source_sha256"]:
                    raise ConflictError("The source version linked to this candidate is unavailable")
                quote = candidate_data["quote"]
                start, end = candidate_data["source_start"], candidate_data["source_end"]
                if source["content"][start:end] != quote:
                    raise ConflictError("The source quote no longer matches its stored version")
                corrections = payload.get("corrections", {})
                if not isinstance(corrections, dict):
                    raise ValidationError("corrections must be an object")
                if candidate_row["kind"] == "entity":
                    label = _required_text(corrections.get("label", candidate_data["label"]), "label", 200)
                    entity_type = _required_text(corrections.get("entity_type", candidate_data["entity_type"]), "entity_type", 100)
                    labels = connection.execute(
                        "SELECT label FROM entities WHERE workspace_id=? AND branch_id=?",
                        (workspace_id, branch_id),
                    ).fetchall()
                    if any(row["label"].casefold() == label.casefold() for row in labels):
                        raise ConflictError("An entity with this label already exists on the branch")
                    entity_result, _, _ = self._apply(
                        connection, workspace_id, branch_id, revision, "create_entity",
                        {"entity_type": entity_type, "label": label, "properties": {}}, actor,
                    )
                    canonical_type = "entity"
                    canonical_id = entity_result["entity_id"]
                    self._apply(
                        connection, workspace_id, branch_id, revision, "add_evidence",
                        {"source_id": candidate_row["source_id"], "anchor": f"chars:{start}:{end}",
                         "quote": quote, "entity_id": canonical_id}, actor,
                    )
                else:
                    subject_id = _required_text(payload.get("subject_entity_id"), "subject_entity_id", 100)
                    predicate = _required_text(corrections.get("predicate", candidate_data["predicate"]), "predicate", 200)
                    object_value = _required_text(corrections.get("object_value", candidate_data["object_value"]), "object_value", 4000)
                    epistemic = payload.get("epistemic_status", "unknown")
                    visibility = payload.get("visibility", "public")
                    if not isinstance(epistemic, str) or epistemic not in {"unknown", "believed", "known", "contested"}:
                        raise ValidationError("epistemic_status must be unknown, believed, known, or contested")
                    if not isinstance(visibility, str) or visibility not in {"public", "actor_scoped", "author_only"}:
                        raise ValidationError("visibility must be public, actor_scoped, or author_only")
                    evidence_result, _, _ = self._apply(
                        connection, workspace_id, branch_id, revision, "add_evidence",
                        {"source_id": candidate_row["source_id"], "anchor": f"chars:{start}:{end}", "quote": quote}, actor,
                    )
                    claim_result, _, _ = self._apply(
                        connection, workspace_id, branch_id, revision, "add_claim",
                        {"subject_entity_id": subject_id, "predicate": predicate, "object_value": object_value,
                         "epistemic_status": epistemic, "visibility": visibility, "review_status": "accepted",
                         "evidence": [evidence_result["evidence_id"]]}, actor,
                    )
                    canonical_type = "claim"
                    canonical_id = claim_result["claim_id"]

            connection.execute(
                "UPDATE extraction_candidates SET review_status=?,canonical_record_type=?,canonical_record_id=?,reviewed_revision=? "
                "WHERE workspace_id=? AND branch_id=? AND candidate_id=?",
                (decision, canonical_type, canonical_id, revision, workspace_id, branch_id, candidate_id),
            )
            return {
                "candidate_id": candidate_id,
                "review_status": decision,
                "canonical_record_type": canonical_type,
                "canonical_record_id": canonical_id,
            }, f"extraction.candidate_{decision}", True

        if command_type in {"create_journal_event", "revise_journal_event"}:
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot create or revise personal journal accounts")
            fields = self._journal_event_fields(connection, workspace_id, payload)
            now = _now()
            if command_type == "create_journal_event":
                event_id = _required_text(payload.get("event_id") or str(uuid4()), "event_id", 100)
                version = 1
                supersedes_version = None
                event_type = "journal.event_created"
            else:
                event_id = _required_text(payload.get("event_id"), "event_id", 100)
                expected_version = payload.get("expected_event_version")
                if type(expected_version) is not int or expected_version < 1:
                    raise ValidationError("expected_event_version must be a positive integer")
                current = connection.execute(
                    "SELECT MAX(version) AS version FROM journal_events "
                    "WHERE workspace_id=? AND branch_id=? AND event_id=?",
                    (workspace_id, branch_id, event_id),
                ).fetchone()["version"]
                if current is None:
                    raise NotFoundError("Journal event does not exist in this branch")
                if current != expected_version:
                    raise ConflictError(f"Expected event version {expected_version}; current version is {current}")
                version = expected_version + 1
                supersedes_version = expected_version
                event_type = "journal.event_revised"

            connection.execute(
                "INSERT INTO journal_events(workspace_id,branch_id,event_id,version,title,details,participants_json,"
                "temporal_kind,occurred_from,occurred_to,time_note,source_id,source_quote,supersedes_version,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    workspace_id, branch_id, event_id, version, fields["title"], fields["details"],
                    fields["participants_json"], fields["temporal_kind"], fields["occurred_from"],
                    fields["occurred_to"], fields["time_note"], fields["source_id"],
                    fields["source_quote"], supersedes_version, revision, now,
                ),
            )
            return {
                "event_id": event_id,
                "version": version,
                "source_id": fields["source_id"],
            }, event_type, True

        if command_type == "import_story_world":
            if branch_id != "main" or actor.startswith("ai:"):
                raise ValidationError("Only a user can import a world into the main branch")
            package = validate_world_package(payload.get("package"))
            world_id = _required_text(payload.get("world_id"), "world_id", 100)
            if connection.execute("SELECT 1 FROM story_worlds WHERE workspace_id=? AND world_id=?", (workspace_id, world_id)).fetchone():
                raise ConflictError("The target world ID already exists; import as a duplicate with a new ID")
            versions = package["versions"]
            now = _now()
            connection.execute(
                "INSERT INTO story_worlds(workspace_id,world_id,name,latest_version,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (workspace_id, world_id, versions[-1]["name"], len(versions), now, now),
            )
            connection.executemany(
                "INSERT INTO story_world_versions(workspace_id,world_id,version,name,description,template_key,content_json,created_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                [(workspace_id, world_id, item["version"], item["name"], item["description"], item["template_key"],
                  _json(item["content"]), revision, now) for item in versions],
            )
            return {"world_id": world_id, "name": versions[-1]["name"], "version": len(versions),
                    "source": package["provenance"]}, "story.world_imported", True

        if command_type in {"create_story_world", "revise_story_world"}:
            if branch_id != "main":
                raise ValidationError("World library changes must be committed on the main workspace branch")
            if actor.startswith("ai:"):
                raise ValidationError("AI actors can propose world drafts but cannot publish world versions")
            description = payload.get("description", "")
            template_key = _required_text(payload.get("template_key", "blank"), "template_key", 60)
            if not isinstance(description, str) or len(description.strip()) > 4000:
                raise ValidationError("description must be text of at most 4000 characters")
            content = _validated_world_content(payload.get("content", {}))
            now = _now()
            if command_type == "create_story_world":
                world_id = _required_text(payload.get("world_id") or str(uuid4()), "world_id", 100)
                name = _required_text(payload.get("name"), "name", 200)
                connection.execute(
                    "INSERT INTO story_worlds(workspace_id,world_id,name,latest_version,created_at,updated_at) "
                    "VALUES(?,?,?,1,?,?)",
                    (workspace_id, world_id, name, now, now),
                )
                version = 1
                event_type = "story.world_created"
            else:
                world_id = _required_text(payload.get("world_id"), "world_id", 100)
                expected_version = payload.get("expected_world_version")
                if type(expected_version) is not int or expected_version < 1:
                    raise ValidationError("expected_world_version must be a positive integer")
                existing = connection.execute(
                    "SELECT name,latest_version FROM story_worlds WHERE workspace_id=? AND world_id=?",
                    (workspace_id, world_id),
                ).fetchone()
                if not existing:
                    raise NotFoundError("World does not exist in this workspace")
                if existing["latest_version"] != expected_version:
                    raise ConflictError(
                        f"Expected world version {expected_version}; current version is {existing['latest_version']}"
                    )
                version = expected_version + 1
                name = _required_text(payload.get("name", existing["name"]), "name", 200)
                connection.execute(
                    "UPDATE story_worlds SET name=?,latest_version=?,updated_at=? WHERE workspace_id=? AND world_id=?",
                    (name, version, now, workspace_id, world_id),
                )
                event_type = "story.world_revised"
            connection.execute(
                "INSERT INTO story_world_versions(workspace_id,world_id,version,name,description,template_key,content_json,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (workspace_id, world_id, version, name, description.strip(), template_key, _json(content), revision, now),
            )
            return {"world_id": world_id, "name": name, "version": version, "template_key": template_key}, event_type, True

        if command_type == "create_story_adventure":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot start adventures")
            parent = connection.execute(
                "SELECT parent_branch_id FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not parent or parent["parent_branch_id"] != "main":
                raise ValidationError("An adventure must start from an isolated snapshot of the main workspace branch")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            world_id = _required_text(payload.get("world_id"), "world_id", 100)
            world_version = payload.get("world_version")
            if type(world_version) is not int or world_version < 1:
                raise ValidationError("world_version must be a positive integer")
            world = connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, world_id, world_version),
            ).fetchone()
            if not world:
                raise NotFoundError("Pinned world version does not exist in this workspace")
            conversation_id = _required_text(payload.get("conversation_id"), "conversation_id", 100)
            actor_entity_id = _required_text(payload.get("actor_entity_id"), "actor_entity_id", 100)
            name = _required_text(payload.get("name"), "name", 200)
            actor_is_user_controlled = payload.get("actor_is_user_controlled", True)
            if not isinstance(actor_is_user_controlled, bool):
                raise ValidationError("actor_is_user_controlled must be a boolean")
            character = connection.execute(
                "SELECT entity_type FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, actor_entity_id),
            ).fetchone()
            if not character or character["entity_type"] not in {"character", "person"}:
                raise ValidationError("An adventure needs a character or person in its snapshot")
            world_content = json.loads(world["content_json"])
            stats = _validated_stats(world_content.get("stats", {
                "might": 0, "agility": 0, "insight": 0, "presence": 0,
            }))
            trackers = _validated_trackers(world_content.get("trackers", {
                "health": {"value": 10, "max": 10},
            }))
            location = world_content.get("starting_location", "")
            if not isinstance(location, str) or len(location.strip()) > 200:
                raise ValidationError("starting_location must be text of at most 200 characters")
            now = _now()
            connection.execute(
                "INSERT INTO story_conversations(workspace_id,branch_id,conversation_id,actor_entity_id,title,actor_is_user_controlled,created_revision,updated_revision,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, conversation_id, actor_entity_id, name, int(actor_is_user_controlled), revision, revision, now, now),
            )
            connection.execute(
                "INSERT INTO story_adventures(workspace_id,branch_id,adventure_id,world_id,world_version,conversation_id,name,actor_entity_id,status,created_revision,updated_revision,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?, 'active',?,?,?,?)",
                (workspace_id, branch_id, adventure_id, world_id, world_version, conversation_id, name, actor_entity_id, revision, revision, now, now),
            )
            connection.execute(
                "INSERT INTO rpg_sheets(workspace_id,branch_id,adventure_id,conversation_id,stats_json,trackers_json,current_location,created_revision,updated_revision) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, adventure_id, conversation_id, _json(stats), _json(trackers), location.strip(), revision, revision),
            )
            return {
                "adventure_id": adventure_id,
                "world_id": world_id,
                "world_version": world_version,
                "conversation_id": conversation_id,
                "actor_entity_id": actor_entity_id,
                "name": name,
            }, "story.adventure_created", True

        if command_type == "update_rpg_sheet":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot change canonical RPG state")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            sheet = connection.execute(
                "SELECT stats_json,trackers_json,current_location FROM rpg_sheets "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not sheet:
                raise NotFoundError("Adventure character sheet does not exist in this branch")
            stats = _validated_stats(payload["stats"]) if "stats" in payload else json.loads(sheet["stats_json"])
            trackers = _validated_trackers(payload["trackers"]) if "trackers" in payload else json.loads(sheet["trackers_json"])
            location = payload.get("current_location", sheet["current_location"])
            if not isinstance(location, str) or len(location.strip()) > 200:
                raise ValidationError("current_location must be text of at most 200 characters")
            connection.execute(
                "UPDATE rpg_sheets SET stats_json=?,trackers_json=?,current_location=?,updated_revision=? "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (_json(stats), _json(trackers), location.strip(), revision, workspace_id, branch_id, adventure_id),
            )
            connection.execute(
                "UPDATE story_adventures SET updated_revision=?,updated_at=? "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (revision, _now(), workspace_id, branch_id, adventure_id),
            )
            return {"adventure_id": adventure_id, "stats": stats, "trackers": trackers, "current_location": location.strip()}, "rpg.sheet_updated", True

        if command_type == "record_d20_check":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot roll or record player checks")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            stat_name = _required_text(payload.get("stat_name"), "stat_name", 40)
            die_roll, target = payload.get("die_roll"), payload.get("target")
            if type(die_roll) is not int or not 1 <= die_roll <= 20:
                raise ValidationError("die_roll must be an integer from 1 to 20")
            if type(target) is not int or not 1 <= target <= 100:
                raise ValidationError("target must be an integer from 1 to 100")
            adventure = connection.execute(
                "SELECT conversation_id,actor_entity_id FROM story_adventures "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            sheet = connection.execute(
                "SELECT stats_json FROM rpg_sheets WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or not sheet:
                raise NotFoundError("Adventure does not exist in this branch")
            stats = json.loads(sheet["stats_json"])
            canonical_stat = next((name for name in stats if name.casefold() == stat_name.casefold()), None)
            if canonical_stat is None:
                raise ValidationError("Choose a stat on this adventure's character sheet")
            modifier = stats[canonical_stat]
            total = die_roll + modifier
            outcome = "success" if total >= target else "failure"
            check_id = _required_text(payload.get("check_id") or str(uuid4()), "check_id", 100)
            connection.execute(
                "INSERT INTO rpg_checks(workspace_id,branch_id,check_id,adventure_id,conversation_id,actor_entity_id,stat_name,die_roll,modifier,total,target,outcome,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, check_id, adventure_id, adventure["conversation_id"], adventure["actor_entity_id"], canonical_stat, die_roll, modifier, total, target, outcome, revision, _now()),
            )
            return {"check_id": check_id, "adventure_id": adventure_id, "stat_name": canonical_stat, "die_roll": die_roll, "modifier": modifier, "total": total, "target": target, "outcome": outcome}, "rpg.check_recorded", True

        if command_type == "propose_rpg_state":
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            adventure = connection.execute(
                "SELECT conversation_id FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure:
                raise NotFoundError("Adventure does not exist in this branch")
            changes = _validated_rpg_changes(payload.get("changes"))
            for change in changes:
                if change["operation"] == "add_event_memory":
                    for known_actor_id in change["known_by"]:
                        if not connection.execute(
                            "SELECT 1 FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                            (workspace_id, branch_id, known_actor_id),
                        ).fetchone():
                            raise ValidationError("event memory known_by must reference characters in this branch")
            source_turn_id = payload.get("source_turn_id")
            if source_turn_id is not None:
                source_turn_id = _required_text(source_turn_id, "source_turn_id", 100)
                turn = connection.execute(
                    "SELECT COALESCE((SELECT e.status FROM story_turn_edits e WHERE e.workspace_id=t.workspace_id "
                    "AND e.branch_id=t.branch_id AND e.conversation_id=t.conversation_id AND e.turn_id=t.turn_id "
                    "ORDER BY e.version DESC LIMIT 1),'active') AS status FROM story_turns t "
                    "WHERE t.workspace_id=? AND t.branch_id=? AND t.conversation_id=? AND t.turn_id=? AND t.role='assistant'",
                    (workspace_id, branch_id, adventure["conversation_id"], source_turn_id),
                ).fetchone()
                if not turn or turn["status"] != "active":
                    raise ValidationError("source_turn_id must identify an active assistant turn in this adventure")
            proposal_id = _required_text(payload.get("proposal_id") or str(uuid4()), "proposal_id", 100)
            connection.execute(
                "INSERT INTO rpg_state_proposals(workspace_id,branch_id,proposal_id,adventure_id,conversation_id,source_turn_id,changes_json,review_status,created_revision,reviewed_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,'proposed',?,NULL,?)",
                (workspace_id, branch_id, proposal_id, adventure_id, adventure["conversation_id"], source_turn_id, _json(changes), revision, _now()),
            )
            return {"proposal_id": proposal_id, "adventure_id": adventure_id, "review_status": "proposed", "changes": changes}, "rpg.state_proposed", True

        if command_type == "review_rpg_state_proposal":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot review RPG state proposals")
            proposal_id = _required_text(payload.get("proposal_id"), "proposal_id", 100)
            decision = payload.get("review_status")
            if decision not in {"accepted", "rejected"}:
                raise ValidationError("review_status must be accepted or rejected")
            proposal = connection.execute(
                "SELECT adventure_id,conversation_id,source_turn_id,changes_json,review_status,created_revision FROM rpg_state_proposals "
                "WHERE workspace_id=? AND branch_id=? AND proposal_id=?",
                (workspace_id, branch_id, proposal_id),
            ).fetchone()
            if not proposal:
                raise NotFoundError("RPG state proposal does not exist in this branch")
            if proposal["review_status"] != "proposed":
                raise ConflictError("RPG state proposal has already been reviewed")
            changes = _validated_rpg_changes(payload.get("changes", json.loads(proposal["changes_json"]))) if decision == "accepted" else []
            if decision == "accepted":
                if proposal["source_turn_id"]:
                    source_edit = connection.execute(
                        "SELECT status,created_revision FROM story_turn_edits WHERE workspace_id=? AND branch_id=? "
                        "AND conversation_id=? AND turn_id=? ORDER BY version DESC LIMIT 1",
                        (workspace_id, branch_id, proposal["conversation_id"], proposal["source_turn_id"]),
                    ).fetchone()
                    if source_edit and (source_edit["status"] != "active" or source_edit["created_revision"] > proposal["created_revision"]):
                        raise ConflictError("RPG state proposal is stale because its source turn changed after it was proposed")
                sheet_changes = [change for change in changes if change["operation"] in {"tracker_delta", "set_location"}]
                sheet = None
                trackers: dict[str, Any] = {}
                location = ""
                if sheet_changes:
                    sheet = connection.execute(
                        "SELECT stats_json,trackers_json,current_location,updated_revision FROM rpg_sheets "
                        "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                        (workspace_id, branch_id, proposal["adventure_id"]),
                    ).fetchone()
                    if not sheet:
                        raise NotFoundError("Adventure character sheet does not exist in this branch")
                    if sheet["updated_revision"] > proposal["created_revision"]:
                        raise ConflictError("RPG state proposal is stale because the character sheet changed after it was proposed")
                    trackers = json.loads(sheet["trackers_json"])
                    location = sheet["current_location"]
                for change in changes:
                    if change["operation"] == "tracker_delta":
                        tracker = trackers.get(change["tracker_id"])
                        if not tracker:
                            raise ValidationError(f"Unknown tracker: {change['tracker_id']}")
                        value = tracker["value"] + change["delta"]
                        if not 0 <= value <= tracker["max"]:
                            raise ValidationError("Accepted tracker changes must keep the value within its limit")
                        tracker["value"] = value
                    elif change["operation"] == "set_location":
                        location = change["location"]
                        map_location = connection.execute(
                            "SELECT location_id FROM story_map_locations WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND name=? COLLATE NOCASE",
                            (workspace_id, branch_id, proposal["adventure_id"], location),
                        ).fetchone()
                        if map_location:
                            connection.execute(
                                "UPDATE story_map_locations SET status='approved',source_proposal_id=?,reviewed_revision=? "
                                "WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND location_id=?",
                                (proposal_id, revision, workspace_id, branch_id, proposal["adventure_id"], map_location["location_id"]),
                            )
                        else:
                            connection.execute(
                                "INSERT INTO story_map_locations(workspace_id,branch_id,adventure_id,location_id,name,status,source_proposal_id,created_revision,reviewed_revision,created_at) "
                                "VALUES(?,?,?,?,?,'approved',?,?,?,?)",
                                (workspace_id, branch_id, proposal["adventure_id"], str(uuid4()), location, proposal_id, revision, revision, _now()),
                            )
                    elif change["operation"] == "npc_profile":
                        profile = connection.execute(
                            "SELECT public_profile_json,review_status,updated_revision FROM story_npc_profiles "
                            "WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND npc_entity_id=?",
                            (workspace_id, branch_id, proposal["adventure_id"], change["npc_entity_id"]),
                        ).fetchone()
                        if not profile or profile["review_status"] != "accepted":
                            raise ValidationError("NPC simulation changes require an approved NPC profile")
                        if profile["updated_revision"] > proposal["created_revision"]:
                            raise ConflictError("NPC simulation proposal is stale because the profile changed after it was proposed")
                        public_profile = json.loads(profile["public_profile_json"])
                        public_profile.update(change["updates"])
                        connection.execute(
                            "UPDATE story_npc_profiles SET public_profile_json=?,updated_revision=?,updated_at=? "
                            "WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND npc_entity_id=?",
                            (_json(public_profile), revision, _now(), workspace_id, branch_id, proposal["adventure_id"], change["npc_entity_id"]),
                        )
                    elif change["operation"] == "add_event_memory":
                        source_turn_id = proposal["source_turn_id"]
                        narrative_order = 0
                        if source_turn_id:
                            source_turn = connection.execute(
                                "SELECT narrative_order FROM story_turns t WHERE t.workspace_id=? AND t.branch_id=? AND t.conversation_id=? AND t.turn_id=? "
                                "AND COALESCE((SELECT status FROM story_turn_edits e WHERE e.workspace_id=t.workspace_id AND e.branch_id=t.branch_id AND e.conversation_id=t.conversation_id AND e.turn_id=t.turn_id ORDER BY version DESC LIMIT 1),'active')='active'",
                                (workspace_id, branch_id, proposal["conversation_id"], source_turn_id),
                            ).fetchone()
                            if not source_turn:
                                raise ConflictError("Event memory proposal refers to a turn that is no longer active")
                            narrative_order = source_turn["narrative_order"]
                        connection.execute(
                            "INSERT INTO story_memories(workspace_id,branch_id,adventure_id,memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at) "
                            "VALUES(?,?,?,?,1,'event',?,?, 'accepted',?,?,NULL,?,?,?,?,?,?)",
                            (workspace_id, branch_id, proposal["adventure_id"], str(uuid4()), change["content"],
                             int(change["context_enabled"]), source_turn_id, narrative_order, change["importance"],
                             change["knowledge_scope"], _json(change["known_by"]), revision, revision, _now()),
                        )
                if sheet is not None:
                    connection.execute(
                        "UPDATE rpg_sheets SET trackers_json=?,current_location=?,updated_revision=? "
                        "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                        (_json(trackers), location, revision, workspace_id, branch_id, proposal["adventure_id"]),
                    )
            connection.execute(
                "UPDATE rpg_state_proposals SET review_status=?,reviewed_revision=? "
                "WHERE workspace_id=? AND branch_id=? AND proposal_id=?",
                (decision, revision, workspace_id, branch_id, proposal_id),
            )
            return {"proposal_id": proposal_id, "adventure_id": proposal["adventure_id"], "review_status": decision, "applied_changes": changes}, f"rpg.state_{decision}", True

        if command_type == "edit_story_turn":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot edit or remove saved story turns")
            conversation_id = _required_text(payload.get("conversation_id"), "conversation_id", 100)
            turn_id = _required_text(payload.get("turn_id"), "turn_id", 100)
            action = payload.get("action", "edit")
            if action not in {"edit", "delete"}:
                raise ValidationError("story turn action must be edit or delete")
            turn = connection.execute(
                "SELECT role,turn_order,content,provider,model,context_manifest_id,context_manifest_json,context_revision FROM story_turns WHERE workspace_id=? AND branch_id=? AND conversation_id=? AND turn_id=?",
                (workspace_id, branch_id, conversation_id, turn_id),
            ).fetchone()
            if not turn:
                raise NotFoundError("Story turn does not exist in this conversation")
            current = connection.execute(
                "SELECT content,status,version,provider,model,context_manifest_id,context_manifest_json,context_revision FROM story_turn_edits WHERE workspace_id=? AND branch_id=? AND conversation_id=? AND turn_id=? ORDER BY version DESC LIMIT 1",
                (workspace_id, branch_id, conversation_id, turn_id),
            ).fetchone()
            current_content = current["content"] if current else turn["content"]
            current_status = current["status"] if current else "active"
            if current_status != "active":
                raise ConflictError("Only an active story turn can be edited or deleted")
            content = current_content if action == "delete" else _required_text(payload.get("content"), "content", 20000)
            latest_fields = current or turn
            replacement_provider = payload.get("provider", latest_fields["provider"])
            replacement_model = payload.get("model", latest_fields["model"])
            replacement_manifest_id = payload.get("context_manifest_id", latest_fields["context_manifest_id"])
            replacement_manifest = payload.get("context_manifest", json.loads(latest_fields["context_manifest_json"]) if latest_fields["context_manifest_json"] else None)
            replacement_context_revision = payload.get("context_revision", latest_fields["context_revision"])
            if "provider" in payload:
                if action != "edit" or replacement_provider not in _ALLOWED_STORY_PROVIDERS:
                    raise ValidationError("Only supported story-provider retry results can replace generated turn metadata")
                replacement_model = _required_text(replacement_model, "model", 200)
                replacement_manifest_id = _required_text(replacement_manifest_id, "context_manifest_id", 100)
                if (not isinstance(replacement_manifest, dict) or replacement_manifest.get("manifest_id") != replacement_manifest_id or
                        replacement_manifest.get("base_revision") != replacement_context_revision or
                        replacement_manifest.get("workspace_id") != workspace_id or replacement_manifest.get("branch_id") != branch_id):
                    raise ValidationError("Replacement turn context manifest does not match its branch revision")
                if type(replacement_context_revision) is not int:
                    raise ValidationError("Replacement turn context revision must be an integer")
            targets: list[dict[str, Any]] = [{
                "turn_id": turn_id, "content": content, "status": "deleted" if action == "delete" else "active",
                "version": (current["version"] if current else 0) + 1,
                "provider": replacement_provider, "model": replacement_model,
                "context_manifest_id": replacement_manifest_id,
                "context_manifest_json": _json(replacement_manifest) if replacement_manifest else None,
                "context_revision": replacement_context_revision,
            }]
            raw_superseded = payload.get("superseded_turn_ids", [])
            if not isinstance(raw_superseded, list) or len(raw_superseded) > 500:
                raise ValidationError("superseded_turn_ids must be a list of at most 500 turns")
            # The stored transcript defines which downstream turns this edit invalidates.
            # Never rely on a client-supplied list to preserve conversation continuity.
            raw_superseded = [row["turn_id"] for row in connection.execute(
                "SELECT turn_id FROM story_turns WHERE workspace_id=? AND branch_id=? AND conversation_id=? AND turn_order>? ORDER BY turn_order",
                (workspace_id, branch_id, conversation_id, turn["turn_order"]),
            ).fetchall()]
            for superseded_id in raw_superseded:
                superseded_id = _required_text(superseded_id, "superseded turn id", 100)
                if superseded_id == turn_id:
                    continue
                later = connection.execute(
                    "SELECT t.content,t.provider,t.model,t.context_manifest_id,t.context_manifest_json,t.context_revision,"
                    "e.content AS edited_content,e.status AS edit_status,e.version AS edit_version,e.provider AS edit_provider,e.model AS edit_model,"
                    "e.context_manifest_id AS edit_manifest_id,e.context_manifest_json AS edit_manifest_json,e.context_revision AS edit_context_revision "
                    "FROM story_turns t LEFT JOIN story_turn_edits e ON e.workspace_id=t.workspace_id AND e.branch_id=t.branch_id "
                    "AND e.conversation_id=t.conversation_id AND e.turn_id=t.turn_id AND e.version=(SELECT MAX(x.version) FROM story_turn_edits x "
                    "WHERE x.workspace_id=t.workspace_id AND x.branch_id=t.branch_id AND x.conversation_id=t.conversation_id AND x.turn_id=t.turn_id) "
                    "WHERE t.workspace_id=? AND t.branch_id=? AND t.conversation_id=? AND t.turn_id=?",
                    (workspace_id, branch_id, conversation_id, superseded_id),
                ).fetchone()
                if not later:
                    raise ValidationError("A superseded turn must belong to the same conversation")
                status = later["edit_status"] or "active"
                if status == "active":
                    targets.append({
                        "turn_id": superseded_id, "content": later["edited_content"] or later["content"], "status": "superseded",
                        "version": (later["edit_version"] or 0) + 1,
                        "provider": later["edit_provider"] or later["provider"], "model": later["edit_model"] or later["model"],
                        "context_manifest_id": later["edit_manifest_id"] or later["context_manifest_id"],
                        "context_manifest_json": later["edit_manifest_json"] or later["context_manifest_json"],
                        "context_revision": later["edit_context_revision"] if later["edit_context_revision"] is not None else later["context_revision"],
                    })
            now = _now()
            connection.executemany(
                "INSERT INTO story_turn_edits(workspace_id,branch_id,conversation_id,turn_id,version,content,status,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [(workspace_id, branch_id, conversation_id, target["turn_id"], target["version"], target["content"], target["status"],
                  target["provider"], target["model"], target["context_manifest_id"], target["context_manifest_json"],
                  target["context_revision"], revision, now) for target in targets],
            )
            connection.execute(
                "UPDATE story_conversations SET updated_revision=?,updated_at=? WHERE workspace_id=? AND branch_id=? AND conversation_id=?",
                (revision, now, workspace_id, branch_id, conversation_id),
            )
            if turn["role"] == "assistant" and action == "edit":
                memory_text = content[:1000].rstrip()
                if len(content) > 1000:
                    memory_text += "…"
                connection.execute(
                    "INSERT INTO story_memories(workspace_id,branch_id,adventure_id,memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at) "
                    "SELECT a.workspace_id,a.branch_id,a.adventure_id,?,1,'event',?,1,'proposed',?,t.narrative_order,NULL,3,'actors',json_array(a.actor_entity_id),?,NULL,? "
                    "FROM story_adventures a JOIN story_turns t ON t.workspace_id=a.workspace_id AND t.branch_id=a.branch_id "
                    "AND t.conversation_id=a.conversation_id WHERE a.workspace_id=? AND a.branch_id=? AND t.turn_id=?",
                    (str(uuid4()), memory_text, turn_id, revision, now, workspace_id, branch_id, turn_id),
                )
            return {"conversation_id": conversation_id, "turn_id": turn_id, "action": action, "superseded_count": len(targets) - 1}, "story.turn_edited" if action == "edit" else "story.turn_deleted", True

        if command_type in {"create_story_memory", "revise_story_memory"}:
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            adventure = connection.execute(
                "SELECT conversation_id FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure:
                raise NotFoundError("Adventure does not exist in this branch")
            kind = payload.get("kind", "note")
            if kind not in {"note", "event", "situation"}:
                raise ValidationError("memory kind must be note, event, or situation")
            content = _required_text(payload.get("content"), "content", 4000)
            enabled = payload.get("context_enabled", True)
            if not isinstance(enabled, bool):
                raise ValidationError("context_enabled must be a boolean")
            source_turn_id = payload.get("source_turn_id")
            if source_turn_id is not None:
                source_turn_id = _required_text(source_turn_id, "source_turn_id", 100)
                source_turn = connection.execute(
                    "SELECT t.narrative_order,COALESCE((SELECT e.status FROM story_turn_edits e "
                    "WHERE e.workspace_id=t.workspace_id AND e.branch_id=t.branch_id AND e.conversation_id=t.conversation_id "
                    "AND e.turn_id=t.turn_id ORDER BY e.version DESC LIMIT 1),'active') AS status FROM story_turns t "
                    "WHERE t.workspace_id=? AND t.branch_id=? AND t.conversation_id=? AND t.turn_id=? AND t.role='assistant'",
                    (workspace_id, branch_id, adventure["conversation_id"], source_turn_id),
                ).fetchone()
                if not source_turn or source_turn["status"] != "active":
                    raise ValidationError("source_turn_id must identify an active assistant turn in this adventure")
                narrative_order = source_turn["narrative_order"]
            else:
                narrative_order = payload.get("narrative_order", 0)
            if type(narrative_order) is not int or narrative_order < 0:
                raise ValidationError("narrative_order must be a non-negative integer")
            previous = None
            memory_id = _required_text(payload.get("memory_id") or str(uuid4()), "memory_id", 100)
            if command_type == "create_story_memory":
                version, supersedes = 1, None
            else:
                expected_version = payload.get("expected_version")
                if type(expected_version) is not int or expected_version < 1:
                    raise ValidationError("expected_version must be a positive integer")
                previous = connection.execute(
                    "SELECT version,importance,knowledge_scope,known_by_json FROM story_memories "
                    "WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND memory_id=? ORDER BY version DESC LIMIT 1",
                    (workspace_id, branch_id, adventure_id, memory_id),
                ).fetchone()
                if not previous:
                    raise NotFoundError("Story memory does not exist in this adventure")
                if previous["version"] != expected_version:
                    raise ConflictError(f"Expected memory version {expected_version}; current version is {previous['version']}")
                version, supersedes = expected_version + 1, expected_version
            importance = payload.get("importance", previous["importance"] if previous else 3)
            knowledge_scope = payload.get("knowledge_scope", previous["knowledge_scope"] if previous else "shared")
            known_by = payload.get("known_by", json.loads(previous["known_by_json"]) if previous else [])
            review_status = payload.get("review_status", "accepted" if kind == "note" else "proposed")
            if review_status not in {"proposed", "accepted"}:
                raise ValidationError("new memories must be proposed or accepted")
            if actor.startswith("ai:") and review_status == "accepted":
                raise ValidationError("AI actors may only propose memories")
            if type(importance) is not int or not 1 <= importance <= 5:
                raise ValidationError("importance must be an integer from 1 to 5")
            if knowledge_scope not in {"shared", "actors", "author", "private"}:
                raise ValidationError("knowledge_scope is invalid")
            if not isinstance(known_by, list) or any(not isinstance(item, str) or not item.strip() for item in known_by):
                raise ValidationError("known_by must be an array of character IDs")
            known_by = list(dict.fromkeys(item.strip() for item in known_by))
            if (knowledge_scope == "actors") != bool(known_by):
                raise ValidationError("actor-scoped memories must name their characters")
            if knowledge_scope in {"author", "private"} and actor.startswith("ai:") and review_status == "accepted":
                raise ValidationError("AI actors cannot create accepted author-only or private memories")
            for known_actor_id in known_by:
                known_actor = connection.execute(
                    "SELECT 1 FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                    (workspace_id, branch_id, known_actor_id),
                ).fetchone()
                if not known_actor:
                    raise ValidationError("known_by must reference characters in this branch")
            now = _now()
            connection.execute(
                "INSERT INTO story_memories(workspace_id,branch_id,adventure_id,memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,NULL,?)",
                (workspace_id, branch_id, adventure_id, memory_id, version, kind, content, int(enabled), review_status,
                 source_turn_id, narrative_order, supersedes, importance, knowledge_scope, _json(known_by), revision, now),
            )
            return {"adventure_id": adventure_id, "memory_id": memory_id, "version": version, "kind": kind,
                    "importance": importance, "knowledge_scope": knowledge_scope, "known_by": known_by,
                    "review_status": review_status}, "story.memory_created" if version == 1 else "story.memory_revised", True

        if command_type == "review_story_memory":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot review memories")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            memory_id = _required_text(payload.get("memory_id"), "memory_id", 100)
            version = payload.get("version")
            decision = payload.get("review_status")
            if type(version) is not int or version < 1 or decision not in {"accepted", "rejected"}:
                raise ValidationError("Review requires a version and accepted/rejected status")
            if decision == "accepted":
                memory = connection.execute(
                    "SELECT m.source_turn_id,m.created_revision,a.conversation_id FROM story_memories m "
                    "JOIN story_adventures a ON a.workspace_id=m.workspace_id AND a.branch_id=m.branch_id AND a.adventure_id=m.adventure_id "
                    "WHERE m.workspace_id=? AND m.branch_id=? AND m.adventure_id=? AND m.memory_id=? AND m.version=?",
                    (workspace_id, branch_id, adventure_id, memory_id, version),
                ).fetchone()
                if memory and memory["source_turn_id"]:
                    source_edit = connection.execute(
                        "SELECT status,created_revision FROM story_turn_edits WHERE workspace_id=? AND branch_id=? "
                        "AND conversation_id=? AND turn_id=? ORDER BY version DESC LIMIT 1",
                        (workspace_id, branch_id, memory["conversation_id"], memory["source_turn_id"]),
                    ).fetchone()
                    if source_edit and (source_edit["status"] != "active" or source_edit["created_revision"] > memory["created_revision"]):
                        raise ConflictError("Story memory is stale because its source turn changed after it was proposed")
            result = connection.execute(
                "UPDATE story_memories SET review_status=?,reviewed_revision=? WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND memory_id=? AND version=? AND review_status='proposed'",
                (decision, revision, workspace_id, branch_id, adventure_id, memory_id, version),
            )
            if result.rowcount != 1:
                raise ConflictError("Only a pending memory can be reviewed")
            return {"adventure_id": adventure_id, "memory_id": memory_id, "version": version, "review_status": decision}, "story.memory_reviewed", True

        if command_type == "save_story_thread":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot change canonical open threads")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            thread_id = _required_text(payload.get("thread_id") or str(uuid4()), "thread_id", 100)
            title = _required_text(payload.get("title"), "title", 200)
            detail = payload.get("detail", "")
            status = payload.get("status", "open")
            if not isinstance(detail, str) or len(detail) > 2000 or status not in {"open", "closed"}:
                raise ValidationError("Thread detail or status is invalid")
            exists = connection.execute(
                "SELECT created_revision FROM story_threads WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND thread_id=?",
                (workspace_id, branch_id, adventure_id, thread_id),
            ).fetchone()
            now = _now()
            if exists:
                connection.execute(
                    "UPDATE story_threads SET title=?,detail=?,status=?,updated_revision=?,updated_at=? WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND thread_id=?",
                    (title, detail.strip(), status, revision, now, workspace_id, branch_id, adventure_id, thread_id),
                )
                created_revision = exists["created_revision"]
            else:
                connection.execute(
                    "INSERT INTO story_threads(workspace_id,branch_id,adventure_id,thread_id,title,detail,status,created_revision,updated_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?,?,?)",
                    (workspace_id, branch_id, adventure_id, thread_id, title, detail.strip(), status, revision, revision, now, now),
                )
                created_revision = revision
            return {"adventure_id": adventure_id, "thread_id": thread_id, "title": title, "status": status, "created_revision": created_revision}, "story.thread_saved", True

        if command_type == "update_story_npc":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot write NPC profiles")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            npc_entity_id = _required_text(payload.get("npc_entity_id"), "npc_entity_id", 100)
            entity = connection.execute(
                "SELECT entity_type FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, npc_entity_id),
            ).fetchone()
            if not entity or entity["entity_type"] not in {"character", "person"}:
                raise ValidationError("NPC must be a character or person in this adventure")
            adventure = connection.execute(
                "SELECT actor_entity_id FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or npc_entity_id == adventure["actor_entity_id"]:
                raise ValidationError("Choose an NPC entity other than the protagonist")
            aliases = payload.get("aliases", [])
            public_profile, private_profile = payload.get("public_profile", {}), payload.get("private_profile", {})
            status = payload.get("review_status", "proposed")
            if (not isinstance(aliases, list) or len(aliases) > 20 or
                    any(not isinstance(alias, str) or not alias.strip() or len(alias.strip()) > 100 for alias in aliases) or
                    not isinstance(public_profile, dict) or not isinstance(private_profile, dict) or
                    status not in {"proposed", "accepted", "rejected"}):
                raise ValidationError("NPC aliases, profiles, or review status are invalid")
            if len(_json(public_profile).encode("utf-8")) > 20000 or len(_json(private_profile).encode("utf-8")) > 20000:
                raise ValidationError("NPC profiles are limited to 20 KB each")
            old = connection.execute(
                "SELECT created_revision FROM story_npc_profiles WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND npc_entity_id=?",
                (workspace_id, branch_id, adventure_id, npc_entity_id),
            ).fetchone()
            now = _now()
            connection.execute(
                "INSERT INTO story_npc_profiles(workspace_id,branch_id,adventure_id,npc_entity_id,aliases_json,public_profile_json,private_profile_json,review_status,created_revision,updated_revision,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,branch_id,adventure_id,npc_entity_id) DO UPDATE SET "
                "aliases_json=excluded.aliases_json,public_profile_json=excluded.public_profile_json,private_profile_json=excluded.private_profile_json,review_status=excluded.review_status,updated_revision=excluded.updated_revision,updated_at=excluded.updated_at",
                (workspace_id, branch_id, adventure_id, npc_entity_id, _json([alias.strip() for alias in aliases]), _json(public_profile), _json(private_profile), status, old["created_revision"] if old else revision, revision, now, now),
            )
            return {"adventure_id": adventure_id, "npc_entity_id": npc_entity_id, "review_status": status}, "story.npc_profile_saved", True

        if command_type == "travel_to_location":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot move the player between locations")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            location = _required_text(payload.get("location"), "location", 200)
            adventure = connection.execute(
                "SELECT world_id,world_version FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure:
                raise NotFoundError("Adventure does not exist in this branch")
            world = connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, adventure["world_id"], adventure["world_version"]),
            ).fetchone()
            locations = json.loads(world["content_json"]).get("locations", []) if world else []
            custom = connection.execute(
                "SELECT 1 FROM story_map_locations WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND name=? COLLATE NOCASE AND status='approved'",
                (workspace_id, branch_id, adventure_id, location),
            ).fetchone()
            if (not isinstance(locations, list) or not any(isinstance(value, str) and value.casefold() == location.casefold() for value in locations)) and not custom:
                raise ValidationError("Travel is limited to locations in the pinned world version")
            connection.execute(
                "UPDATE rpg_sheets SET current_location=?,updated_revision=? WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (location, revision, workspace_id, branch_id, adventure_id),
            )
            connection.execute(
                "UPDATE story_adventures SET updated_revision=?,updated_at=? WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (revision, _now(), workspace_id, branch_id, adventure_id),
            )
            return {"adventure_id": adventure_id, "location": location}, "story.location_changed", True

        if command_type == "set_npc_simulation":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot enable NPC simulation")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            enabled = payload.get("enabled")
            if not isinstance(enabled, bool):
                raise ValidationError("enabled must be a boolean")
            result = connection.execute(
                "UPDATE story_adventures SET npc_simulation_enabled=?,updated_revision=?,updated_at=? "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (int(enabled), revision, _now(), workspace_id, branch_id, adventure_id),
            )
            if result.rowcount != 1:
                raise NotFoundError("Adventure does not exist in this branch")
            return {"adventure_id": adventure_id, "enabled": enabled}, "story.npc_simulation_setting_changed", True

        if command_type == "add_story_asset":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot attach or publish story images")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            target_kind = payload.get("target_kind")
            if target_kind not in {"character", "scene"}:
                raise ValidationError("target_kind must be character or scene")
            target_id = _required_text(payload.get("target_id"), "target_id", 100)
            display_name = _required_text(payload.get("display_name"), "display_name", 200)
            mime_type = payload.get("mime_type")
            if mime_type not in {"image/png", "image/jpeg", "image/webp"}:
                raise ValidationError("Only PNG, JPEG, and WebP images are supported")
            encoded = payload.get("data_base64")
            if not isinstance(encoded, str) or len(encoded) > 7_000_000:
                raise ValidationError("Image data is missing or exceeds the upload limit")
            try:
                data = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as error:
                raise ValidationError("Image data must be valid base64") from error
            if not data or len(data) > 5 * 1024 * 1024:
                raise ValidationError("Images are limited to 5 MiB")
            signature_ok = (mime_type == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n")) or (mime_type == "image/jpeg" and data.startswith(b"\xff\xd8\xff")) or (mime_type == "image/webp" and len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP")
            if not signature_ok:
                raise ValidationError("Image bytes do not match the declared file type")
            adventure = connection.execute(
                "SELECT conversation_id,actor_entity_id FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure:
                raise NotFoundError("Adventure does not exist in this branch")
            if target_kind == "character":
                found = connection.execute("SELECT 1 FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?", (workspace_id, branch_id, target_id)).fetchone()
            else:
                found = connection.execute("SELECT 1 FROM story_turns WHERE workspace_id=? AND branch_id=? AND conversation_id=? AND turn_id=? AND role='assistant'", (workspace_id, branch_id, adventure["conversation_id"], target_id)).fetchone()
            if not found:
                raise NotFoundError("Image target does not exist in this adventure")
            provenance = payload.get("provenance", {})
            if not isinstance(provenance, dict) or len(_json(provenance).encode("utf-8")) > 4000:
                raise ValidationError("Image provenance must be a small JSON object")
            asset_id = _required_text(payload.get("asset_id") or str(uuid4()), "asset_id", 100)
            connection.execute(
                "INSERT INTO story_assets(workspace_id,branch_id,adventure_id,asset_id,target_kind,target_id,display_name,mime_type,content,provenance_json,created_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, adventure_id, asset_id, target_kind, target_id, display_name, mime_type, data, _json(provenance), revision, _now()),
            )
            return {"adventure_id": adventure_id, "asset_id": asset_id, "target_kind": target_kind, "target_id": target_id, "display_name": display_name, "mime_type": mime_type}, "story.asset_added", True

        if command_type == "create_conversation":
            conversation_id = _required_text(payload.get("conversation_id") or str(uuid4()), "conversation_id", 100)
            actor_entity_id = _required_text(payload.get("actor_entity_id"), "actor_entity_id", 100)
            title = _required_text(payload.get("title"), "title", 200)
            actor_is_user_controlled = payload.get("actor_is_user_controlled", True)
            if not isinstance(actor_is_user_controlled, bool):
                raise ValidationError("actor_is_user_controlled must be a boolean")
            actor = connection.execute(
                "SELECT entity_type FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, actor_entity_id),
            ).fetchone()
            if not actor or actor["entity_type"] not in {"character", "person"}:
                raise ValidationError("A story conversation needs a character or person in this branch")
            now = _now()
            connection.execute(
                "INSERT INTO story_conversations(workspace_id,branch_id,conversation_id,actor_entity_id,title,actor_is_user_controlled,created_revision,updated_revision,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, conversation_id, actor_entity_id, title, int(actor_is_user_controlled), revision, revision, now, now),
            )
            return {"conversation_id": conversation_id, "actor_entity_id": actor_entity_id, "title": title}, "story.conversation_created", True

        if command_type == "append_story_turn":
            conversation_id = _required_text(payload.get("conversation_id"), "conversation_id", 100)
            user_content = _required_text(payload.get("user_content"), "user_content", 4000)
            assistant_content = _required_text(payload.get("assistant_content"), "assistant_content", 20000)
            provider = payload.get("provider")
            if provider not in _ALLOWED_STORY_PROVIDERS:
                raise ValidationError("The story turn uses an unsupported provider")
            model = _required_text(payload.get("model"), "model", 200)
            narrative_order = payload.get("narrative_order")
            if not isinstance(narrative_order, int) or narrative_order < 0:
                raise ValidationError("narrative_order must be a non-negative integer")
            context_revision = payload.get("context_revision")
            if not isinstance(context_revision, int) or context_revision != revision - 1:
                raise ValidationError("Story context revision must match the current branch head")
            context_manifest_id = _required_text(payload.get("context_manifest_id"), "context_manifest_id", 100)
            context_manifest = payload.get("context_manifest")
            if (
                not isinstance(context_manifest, dict)
                or context_manifest.get("manifest_id") != context_manifest_id
                or context_manifest.get("base_revision") != context_revision
                or context_manifest.get("workspace_id") != workspace_id
                or context_manifest.get("branch_id") != branch_id
                or not isinstance(context_manifest.get("actor"), dict)
                or not isinstance(context_manifest.get("included"), list)
                or not isinstance(context_manifest.get("excluded"), list)
            ):
                raise ValidationError("Story context manifest does not match its branch revision")
            conversation = connection.execute(
                "SELECT actor_entity_id FROM story_conversations WHERE workspace_id=? AND branch_id=? AND conversation_id=?",
                (workspace_id, branch_id, conversation_id),
            ).fetchone()
            if not conversation:
                raise NotFoundError("Story conversation does not exist in this branch")
            if context_manifest["actor"].get("entity_id") != conversation["actor_entity_id"]:
                raise ValidationError("Story context manifest does not match the conversation character")
            turn_order = connection.execute(
                "SELECT COALESCE(MAX(turn_order)+1,0) AS next_order FROM story_turns "
                "WHERE workspace_id=? AND branch_id=? AND conversation_id=?",
                (workspace_id, branch_id, conversation_id),
            ).fetchone()["next_order"]
            now = _now()
            user_turn_id, assistant_turn_id = str(uuid4()), str(uuid4())
            connection.executemany(
                "INSERT INTO story_turns(workspace_id,branch_id,conversation_id,turn_id,turn_order,role,narrative_order,content,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                    (workspace_id, branch_id, conversation_id, user_turn_id, turn_order, "user", narrative_order, user_content, None, None, None, None, None, revision, now),
                    (workspace_id, branch_id, conversation_id, assistant_turn_id, turn_order + 1, "assistant", narrative_order, assistant_content, provider, model, context_manifest_id, _json(context_manifest), context_revision, revision, now),
                ],
            )
            connection.execute(
                "UPDATE story_conversations SET updated_revision=?,updated_at=? "
                "WHERE workspace_id=? AND branch_id=? AND conversation_id=?",
                (revision, now, workspace_id, branch_id, conversation_id),
            )
            connection.execute(
                "UPDATE story_adventures SET completed_turns=completed_turns+1,updated_revision=?,updated_at=? "
                "WHERE workspace_id=? AND branch_id=? AND conversation_id=?",
                (revision, now, workspace_id, branch_id, conversation_id),
            )
            memory_text = assistant_content[:1000].rstrip()
            if len(assistant_content) > 1000:
                memory_text += "…"
            connection.execute(
                "INSERT INTO story_memories(workspace_id,branch_id,adventure_id,memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at) "
                "SELECT workspace_id,branch_id,adventure_id,?,1,'event',?,1,'proposed',?,?,NULL,3,'actors',json_array(actor_entity_id),?,NULL,? "
                "FROM story_adventures WHERE workspace_id=? AND branch_id=? AND conversation_id=?",
                (str(uuid4()), memory_text, assistant_turn_id, narrative_order, revision, now,
                 workspace_id, branch_id, conversation_id),
            )
            return {
                "conversation_id": conversation_id,
                "user_turn_id": user_turn_id,
                "assistant_turn_id": assistant_turn_id,
                "provider": provider,
                "model": model,
                "context_manifest_id": context_manifest_id,
                "context_revision": context_revision,
            }, "story.turn_recorded", True

        if command_type == "import_exchange":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot import or approve external exchanges")
            exchange = _validated_exchange_payload(payload, workspace_id, branch_id)
            if exchange["base_revision"] > revision - 1:
                raise ConflictError("Exchange is based on a future branch revision")
            existing = connection.execute(
                "SELECT exchange_id,transcript_id,context_manifest_id,base_revision,from_turn,to_turn,transcript_total_turns,transcript_hash,"
                "context_manifest_json,proposed_change_ids_json,created_revision "
                "FROM external_exchanges WHERE workspace_id=? AND branch_id=? AND exchange_id=?",
                (workspace_id, branch_id, exchange["exchange_id"]),
            ).fetchone()
            if existing:
                same_exchange = (
                    existing["transcript_hash"] == exchange["transcript_hash"]
                    and existing["transcript_id"] == exchange["transcript_id"]
                    and existing["context_manifest_id"] == exchange["context_manifest_id"]
                    and existing["base_revision"] == exchange["base_revision"]
                    and existing["from_turn"] == exchange["from_turn"]
                    and existing["to_turn"] == exchange["to_turn"]
                    and existing["transcript_total_turns"] == exchange["transcript_total_turns"]
                    and existing["context_manifest_json"] == _json(exchange["context_manifest"])
                    and existing["proposed_change_ids_json"] == _json(exchange["proposed_change_ids"])
                )
                if not same_exchange:
                    raise ConflictError("Exchange identity was already used with different content or context")
                return {
                    "exchange_id": existing["exchange_id"], "transcript_id": existing["transcript_id"], "duplicate": True,
                    "stale_context": existing["base_revision"] != existing["created_revision"] - 1
                    or existing["created_revision"] != revision - 1,
                }, "exchange.duplicate", False

            transcript_rows = connection.execute(
                "SELECT from_turn,to_turn,transcript_total_turns,turns_json FROM external_exchanges "
                "WHERE workspace_id=? AND branch_id=? AND transcript_id=?",
                (workspace_id, branch_id, exchange["transcript_id"]),
            ).fetchall()
            incoming_turns = {turn["turn_number"]: turn for turn in exchange["turns"]}
            for row in transcript_rows:
                if row["to_turn"] < exchange["from_turn"] or row["from_turn"] > exchange["to_turn"]:
                    continue
                saved_turns = {turn["turn_number"]: turn for turn in json.loads(row["turns_json"])}
                for turn_number in incoming_turns.keys() & saved_turns.keys():
                    if _json(incoming_turns[turn_number]) != _json(saved_turns[turn_number]):
                        raise ConflictError("Overlapping transcript turns conflict for this transcript identity")

            same_transcript = connection.execute(
                "SELECT exchange_id,base_revision,created_revision FROM external_exchanges "
                "WHERE workspace_id=? AND branch_id=? AND transcript_id=? AND transcript_hash=? "
                "AND transcript_total_turns=?",
                (workspace_id, branch_id, exchange["transcript_id"], exchange["transcript_hash"], exchange["transcript_total_turns"]),
            ).fetchone()
            if same_transcript:
                return {
                    "exchange_id": same_transcript["exchange_id"],
                    "transcript_id": exchange["transcript_id"],
                    "requested_exchange_id": exchange["exchange_id"],
                    "duplicate": True,
                    "stale_context": same_transcript["base_revision"] != same_transcript["created_revision"] - 1
                    or same_transcript["created_revision"] != revision - 1,
                }, "exchange.duplicate", False

            connection.execute(
                "INSERT INTO external_exchanges(workspace_id,branch_id,exchange_id,transcript_id,context_manifest_id,base_revision,"
                "from_turn,to_turn,transcript_total_turns,transcript_hash,context_manifest_json,turns_json,proposed_change_ids_json,"
                "created_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, exchange["exchange_id"], exchange["transcript_id"], exchange["context_manifest_id"],
                 exchange["base_revision"], exchange["from_turn"], exchange["to_turn"], exchange["transcript_total_turns"], exchange["transcript_hash"],
                 _json(exchange["context_manifest"]), _json(exchange["turns"]),
                 _json(exchange["proposed_change_ids"]), revision, _now()),
            )
            missing_turns = _missing_turn_ranges([
                (row["from_turn"], row["to_turn"]) for row in transcript_rows
            ] + [(exchange["from_turn"], exchange["to_turn"])],
                max([exchange["transcript_total_turns"]] + [row["transcript_total_turns"] for row in transcript_rows]),
            )
            return {
                "exchange_id": exchange["exchange_id"],
                "transcript_id": exchange["transcript_id"],
                "transcript_hash": exchange["transcript_hash"],
                "turn_count": len(exchange["turns"]),
                "proposed_change_ids": exchange["proposed_change_ids"],
                "duplicate": False,
                "stale_context": exchange["base_revision"] != revision - 1,
                "missing_turns": missing_turns,
            }, "exchange.imported", True

        raise ValidationError(f"Unsupported command type: {command_type}")

    def list_entities(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT entity_id,entity_type,label,properties_json,created_revision,updated_revision "
                "FROM entities WHERE workspace_id=? AND branch_id=? ORDER BY label COLLATE NOCASE,entity_id",
                (workspace_id, branch_id),
            ).fetchall()
        return [
            {"entity_id": row["entity_id"], "entity_type": row["entity_type"], "label": row["label"],
             "properties": json.loads(row["properties_json"]), "created_revision": row["created_revision"],
             "updated_revision": row["updated_revision"]}
            for row in rows
        ]

    def list_workspaces(self) -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT w.workspace_id,w.name,w.created_at,b.head_revision "
                "FROM workspaces w JOIN branches b ON b.workspace_id=w.workspace_id AND b.branch_id='main' "
                "ORDER BY w.created_at,w.workspace_id"
            ).fetchall()
        return [{"workspace_id": row["workspace_id"], "name": row["name"],
                 "created_at": row["created_at"], "main_revision": row["head_revision"]} for row in rows]

    def list_branches(self, workspace_id: str) -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT branch_id,parent_branch_id,parent_revision,base_revision,head_revision,created_at "
                "FROM branches WHERE workspace_id=? ORDER BY created_at,branch_id",
                (workspace_id,),
            ).fetchall()
        if not rows:
            raise NotFoundError("Workspace does not exist")
        return [{"branch_id": r["branch_id"], "parent_branch_id": r["parent_branch_id"],
                 "parent_revision": r["parent_revision"], "base_revision": r["base_revision"],
                 "head_revision": r["head_revision"], "created_at": r["created_at"]} for r in rows]

    def search_entities(self, workspace_id: str, branch_id: str, query: str, limit: int = 50) -> list[dict[str, Any]]:
        match = _fts_query(query)
        if not match:
            return []
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT e.entity_id,e.entity_type,e.label,e.properties_json,e.updated_revision "
                "FROM entity_search s JOIN entities e ON e.workspace_id=s.workspace_id AND e.branch_id=s.branch_id AND e.entity_id=s.entity_id "
                "WHERE entity_search MATCH ? AND s.workspace_id=? AND s.branch_id=? LIMIT ?",
                (match, workspace_id, branch_id, max(1, min(limit, 200))),
            ).fetchall()
        return [{"entity_id": r["entity_id"], "entity_type": r["entity_type"], "label": r["label"],
                 "properties": json.loads(r["properties_json"]), "updated_revision": r["updated_revision"]} for r in rows]

    def search_sources(self, workspace_id: str, query: str, limit: int = 20) -> list[dict[str, Any]]:
        match = _fts_query(query)
        if not match:
            return []
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT source_id,display_name,snippet(source_search,3,'[',']','…',12) AS excerpt "
                "FROM source_search WHERE source_search MATCH ? AND workspace_id=? LIMIT ?",
                (match, workspace_id, max(1, min(limit, 100))),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_sources(self, workspace_id: str) -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT source_id,display_name,media_type,created_at "
                "FROM sources WHERE workspace_id=? ORDER BY created_at,source_id",
                (workspace_id,),
            ).fetchall()
            exists = self.db.connection.execute(
                "SELECT 1 FROM workspaces WHERE workspace_id=?", (workspace_id,)
            ).fetchone()
        if not exists:
            raise NotFoundError("Workspace does not exist")
        return [dict(row) for row in rows]

    def list_extraction_batches(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        with self.db.lock:
            branch = self.db.connection.execute(
                "SELECT 1 FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not branch:
                raise NotFoundError("Branch does not exist in this workspace")
            batch_rows = self.db.connection.execute(
                "SELECT b.batch_id,b.source_id,s.display_name AS source_name,b.source_sha256,b.model,"
                "b.extractor_version,b.prompt_version,b.output_schema_version,b.created_revision,b.created_at "
                "FROM extraction_batches b JOIN sources s ON s.workspace_id=b.workspace_id AND s.source_id=b.source_id "
                "WHERE b.workspace_id=? AND b.branch_id=? ORDER BY b.created_revision DESC,b.batch_id",
                (workspace_id, branch_id),
            ).fetchall()
            candidate_rows = self.db.connection.execute(
                "SELECT candidate_id,batch_id,kind,payload_json,review_status,canonical_record_type,"
                "canonical_record_id,created_revision,reviewed_revision FROM extraction_candidates "
                "WHERE workspace_id=? AND branch_id=? ORDER BY created_revision,candidate_id",
                (workspace_id, branch_id),
            ).fetchall()
        candidates_by_batch: dict[str, list[dict[str, Any]]] = {}
        for row in candidate_rows:
            candidate = dict(row)
            candidate["payload"] = json.loads(candidate.pop("payload_json"))
            candidates_by_batch.setdefault(candidate.pop("batch_id"), []).append(candidate)
        batches = []
        for row in batch_rows:
            batch = dict(row)
            batch["candidates"] = candidates_by_batch.get(batch["batch_id"], [])
            batches.append(batch)
        return batches

    def evaluate_rules(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        with self.db.lock:
            branch = self.db.connection.execute(
                "SELECT 1 FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not branch:
                raise NotFoundError("Branch does not exist in this workspace")
            rule_rows = self.db.connection.execute(
                "SELECT r.rule_id,r.name,r.description,r.rule_mode,r.severity,r.subject_entity_id,"
                "e.label AS subject_label,r.predicate,r.object_value,r.predicate_cardinality,"
                "r.review_status,r.created_revision FROM rules r "
                "JOIN entities e ON e.workspace_id=r.workspace_id AND e.branch_id=r.branch_id "
                "AND e.entity_id=r.subject_entity_id WHERE r.workspace_id=? AND r.branch_id=? "
                "ORDER BY r.created_revision,r.rule_id",
                (workspace_id, branch_id),
            ).fetchall()
            claim_rows = self.db.connection.execute(
                "SELECT claim_id,subject_entity_id,predicate,object_value,epistemic_status,review_status,visibility "
                "FROM claims WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchall()
        claims = [dict(row) for row in claim_rows]
        return [
            {"rule": dict(row), "evaluation": evaluate_rule(dict(row), claims)}
            for row in rule_rows
        ]

    def scenario_evaluations(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        """Return each scenario with its options, assumption history, evidence, and rule outcomes."""
        with self.db.lock:
            branch = self.db.connection.execute(
                "SELECT 1 FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not branch:
                raise NotFoundError("Branch does not exist in this workspace")
            scenario_rows = self.db.connection.execute(
                "SELECT scenario_id,title,problem,constraints_json,created_revision,created_at "
                "FROM scenarios WHERE workspace_id=? AND branch_id=? ORDER BY created_revision,scenario_id",
                (workspace_id, branch_id),
            ).fetchall()
            option_rows = self.db.connection.execute(
                "SELECT scenario_id,option_id,label,description,position,created_revision "
                "FROM scenario_options WHERE workspace_id=? AND branch_id=? ORDER BY scenario_id,position",
                (workspace_id, branch_id),
            ).fetchall()
            claim_evidence_rows = self.db.connection.execute(
                "SELECT se.scenario_id,c.claim_id,c.subject_entity_id,e.label AS subject_label,c.predicate,"
                "c.object_value,c.epistemic_status,c.review_status,c.visibility "
                "FROM scenario_claim_evidence se JOIN claims c ON c.workspace_id=se.workspace_id "
                "AND c.branch_id=se.branch_id AND c.claim_id=se.claim_id JOIN entities e "
                "ON e.workspace_id=c.workspace_id AND e.branch_id=c.branch_id AND e.entity_id=c.subject_entity_id "
                "WHERE se.workspace_id=? AND se.branch_id=? ORDER BY se.scenario_id,c.claim_id",
                (workspace_id, branch_id),
            ).fetchall()
            source_evidence_rows = self.db.connection.execute(
                "SELECT se.scenario_id,s.source_id,s.display_name,s.media_type "
                "FROM scenario_source_evidence se JOIN sources s ON s.workspace_id=se.workspace_id "
                "AND s.source_id=se.source_id WHERE se.workspace_id=? AND se.branch_id=? "
                "ORDER BY se.scenario_id,s.display_name",
                (workspace_id, branch_id),
            ).fetchall()
            assumption_rows = self.db.connection.execute(
                "SELECT a.scenario_id,a.option_id,a.assumption_id,a.version,a.subject_entity_id,"
                "e.label AS subject_label,a.predicate,a.object_value,a.assumption_action,"
                "a.predicate_cardinality,a.review_status,a.supersedes_version,a.created_revision,a.created_at "
                "FROM scenario_assumptions a JOIN entities e ON e.workspace_id=a.workspace_id "
                "AND e.branch_id=a.branch_id AND e.entity_id=a.subject_entity_id "
                "WHERE a.workspace_id=? AND a.branch_id=? ORDER BY a.scenario_id,a.option_id,a.assumption_id,a.version",
                (workspace_id, branch_id),
            ).fetchall()
            rule_rows = self.db.connection.execute(
                "SELECT r.rule_id,r.name,r.description,r.rule_mode,r.severity,r.subject_entity_id,"
                "e.label AS subject_label,r.predicate,r.object_value,r.predicate_cardinality,"
                "r.review_status,r.created_revision FROM rules r JOIN entities e "
                "ON e.workspace_id=r.workspace_id AND e.branch_id=r.branch_id AND e.entity_id=r.subject_entity_id "
                "WHERE r.workspace_id=? AND r.branch_id=? ORDER BY r.created_revision,r.rule_id",
                (workspace_id, branch_id),
            ).fetchall()
            claim_rows = self.db.connection.execute(
                "SELECT claim_id,subject_entity_id,predicate,object_value,epistemic_status,review_status,visibility "
                "FROM claims WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchall()

        claims = [dict(row) for row in claim_rows]
        rule_records = [dict(row) for row in rule_rows]
        claim_evidence: dict[str, list[dict[str, Any]]] = {}
        for row in claim_evidence_rows:
            claim_evidence.setdefault(row["scenario_id"], []).append(dict(row))
        source_evidence: dict[str, list[dict[str, Any]]] = {}
        for row in source_evidence_rows:
            source_evidence.setdefault(row["scenario_id"], []).append(dict(row))
        assumptions_by_option: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in assumption_rows:
            assumptions_by_option.setdefault((row["scenario_id"], row["option_id"]), []).append(dict(row))
        options_by_scenario: dict[str, list[dict[str, Any]]] = {}
        for row in option_rows:
            option = dict(row)
            history = assumptions_by_option.get((option["scenario_id"], option["option_id"]), [])
            latest_by_id: dict[str, dict[str, Any]] = {}
            for assumption in history:
                previous = latest_by_id.get(assumption["assumption_id"])
                if previous is None or assumption["version"] > previous["version"]:
                    latest_by_id[assumption["assumption_id"]] = assumption
            current_assumptions = list(latest_by_id.values())
            option["assumptions"] = current_assumptions
            option["assumption_history"] = history
            option["rule_evaluations"] = [
                {"rule": rule, "evaluation": evaluate_rule(rule, claims, current_assumptions)}
                for rule in rule_records
            ]
            options_by_scenario.setdefault(option.pop("scenario_id"), []).append(option)

        scenarios = []
        for row in scenario_rows:
            scenario = dict(row)
            scenario["constraints"] = json.loads(scenario.pop("constraints_json"))
            scenario["evidence_claims"] = claim_evidence.get(scenario["scenario_id"], [])
            scenario["evidence_sources"] = source_evidence.get(scenario["scenario_id"], [])
            scenario["options"] = options_by_scenario.get(scenario["scenario_id"], [])
            scenarios.append(scenario)
        return scenarios

    def list_journal_events(
        self,
        workspace_id: str,
        branch_id: str = "main",
        from_date: str | None = None,
        to_date: str | None = None,
    ) -> list[dict[str, Any]]:
        from_date = _optional_iso_date(from_date, "from_date")
        to_date = _optional_iso_date(to_date, "to_date")
        if from_date and to_date and from_date > to_date:
            raise ValidationError("from_date cannot be after to_date")
        with self.db.lock:
            branch = self.db.connection.execute(
                "SELECT 1 FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not branch:
                raise NotFoundError("Branch does not exist in this workspace")
            rows = self.db.connection.execute(
                "SELECT e.event_id,e.version,e.title,e.details,e.participants_json,e.temporal_kind,"
                "e.occurred_from,e.occurred_to,e.time_note,e.source_id,s.display_name AS source_name,"
                "e.source_quote,e.supersedes_version,e.created_revision,e.created_at "
                "FROM journal_events e LEFT JOIN sources s ON s.workspace_id=e.workspace_id AND s.source_id=e.source_id "
                "WHERE e.workspace_id=? AND e.branch_id=? ORDER BY e.event_id,e.version",
                (workspace_id, branch_id),
            ).fetchall()

        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            item = dict(row)
            item["participants"] = json.loads(item.pop("participants_json"))
            grouped.setdefault(item["event_id"], []).append(item)

        events = []
        for versions in grouped.values():
            current = versions[-1]
            if from_date or to_date:
                if current["temporal_kind"] not in {"exact", "range"}:
                    continue
                event_end = current["occurred_to"] or current["occurred_from"]
                if from_date and event_end < from_date:
                    continue
                if to_date and current["occurred_from"] > to_date:
                    continue
            events.append({**current, "history": versions[:-1]})
        events.sort(key=lambda item: (
            item["occurred_from"] is None,
            item["occurred_from"] or "",
            item["created_revision"],
            item["event_id"],
        ))
        return events

    def get_source(self, workspace_id: str, source_id: str) -> dict[str, Any]:
        with self.db.lock:
            row = self.db.connection.execute(
                "SELECT source_id,display_name,media_type,content,content_sha256,created_at "
                "FROM sources WHERE workspace_id=? AND source_id=?",
                (workspace_id, source_id),
            ).fetchone()
        if not row:
            raise NotFoundError("Source does not exist in this workspace")
        return dict(row)

    def list_external_exchanges(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        with self.db.lock:
            branch = self.db.connection.execute(
                "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not branch:
                raise NotFoundError("Branch does not exist in this workspace")
            rows = self.db.connection.execute(
                "SELECT exchange_id,transcript_id,context_manifest_id,base_revision,from_turn,to_turn,transcript_hash,"
                "transcript_total_turns,context_manifest_json,turns_json,proposed_change_ids_json,created_revision,created_at "
                "FROM external_exchanges WHERE workspace_id=? AND branch_id=? "
                "ORDER BY created_revision DESC,exchange_id",
                (workspace_id, branch_id),
            ).fetchall()
        head_revision = int(branch["head_revision"])
        transcript_ranges: dict[str, list[tuple[int, int]]] = {}
        transcript_totals: dict[str, int] = {}
        for row in rows:
            transcript_ranges.setdefault(row["transcript_id"], []).append((row["from_turn"], row["to_turn"]))
            transcript_totals[row["transcript_id"]] = max(
                transcript_totals.get(row["transcript_id"], 0), row["transcript_total_turns"]
            )
        exchanges = []
        for row in rows:
            context_manifest = json.loads(row["context_manifest_json"])
            is_stale = (
                context_manifest.get("branch_id") != branch_id
                or row["base_revision"] != row["created_revision"] - 1
                or row["created_revision"] != head_revision
            )
            exchanges.append({
                "exchange_id": row["exchange_id"],
                "transcript_id": row["transcript_id"],
                "context_manifest_id": row["context_manifest_id"],
                "base_revision": row["base_revision"],
                "from_turn": row["from_turn"],
                "to_turn": row["to_turn"],
                "transcript_total_turns": row["transcript_total_turns"],
                "transcript_hash": row["transcript_hash"],
                "context_manifest": context_manifest,
                "turns": json.loads(row["turns_json"]),
                "proposed_change_ids": json.loads(row["proposed_change_ids_json"]),
                "created_revision": row["created_revision"],
                "created_at": row["created_at"],
                "stale_context": is_stale,
                "missing_turns": _missing_turn_ranges(
                    transcript_ranges[row["transcript_id"]], transcript_totals[row["transcript_id"]]
                ),
                "current_revision": head_revision,
            })
        return exchanges

    def revisions(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT r.revision,r.parent_revision,r.actor,r.reason,r.created_at,r.payload_json,"
                "a.event_type,a.payload_json AS result_json FROM revisions r "
                "LEFT JOIN audit_events a ON a.workspace_id=r.workspace_id AND a.branch_id=r.branch_id "
                "AND a.revision=r.revision WHERE r.workspace_id=? AND r.branch_id=? ORDER BY r.revision",
                (workspace_id, branch_id),
            ).fetchall()
        return [{"revision": r["revision"], "parent_revision": r["parent_revision"], "actor": r["actor"],
                 "reason": r["reason"], "created_at": r["created_at"], "event_type": r["event_type"],
                 "payload": json.loads(r["payload_json"]),
                 "result": json.loads(r["result_json"]) if r["result_json"] is not None else None} for r in rows]

    def current_revision(self, workspace_id: str, branch_id: str = "main") -> int:
        with self.db.lock:
            row = self.db.connection.execute(
                "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
        if not row:
            raise NotFoundError("Branch does not exist in this workspace")
        return int(row["head_revision"])

    def relations(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT relation_id,source_entity_id,target_entity_id,relation_type,properties_json,review_status,created_revision "
                "FROM relations WHERE workspace_id=? AND branch_id=? ORDER BY relation_id",
                (workspace_id, branch_id),
            ).fetchall()
        return [{"relation_id": r["relation_id"], "source_entity_id": r["source_entity_id"],
                 "target_entity_id": r["target_entity_id"], "relation_type": r["relation_type"],
                 "properties": json.loads(r["properties_json"]), "review_status": r["review_status"],
                 "created_revision": r["created_revision"]} for r in rows]

    def list_story_worlds(self, workspace_id: str) -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT w.world_id,v.name,w.latest_version,w.created_at,w.updated_at,"
                "v.description,v.template_key FROM story_worlds w JOIN story_world_versions v "
                "ON v.workspace_id=w.workspace_id AND v.world_id=w.world_id AND v.version=w.latest_version "
                "WHERE w.workspace_id=? ORDER BY w.updated_at DESC,w.name COLLATE NOCASE",
                (workspace_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def export_world_package(self, workspace_id: str, world_id: str) -> dict[str, Any]:
        world = self.get_story_world(workspace_id, world_id)
        return validate_world_package({
            "protocol": "lke.world.v1",
            "provenance": {"workspace_id": workspace_id, "world_id": world_id},
            "versions": [{key: item[key] for key in ("version", "name", "description", "template_key", "content")}
                         for item in reversed(world["versions"])],
        })

    def preview_world_package(self, workspace_id: str, package: Any) -> dict[str, Any]:
        self.current_revision(workspace_id, "main")
        clean = validate_world_package(package)
        with self.db.lock:
            collision = self.db.connection.execute(
                "SELECT 1 FROM story_worlds WHERE workspace_id=? AND world_id=?",
                (workspace_id, clean["provenance"]["world_id"]),
            ).fetchone() is not None
        return {"protocol": clean["protocol"], "provenance": clean["provenance"],
                "name": clean["versions"][-1]["name"], "versions": len(clean["versions"]),
                "source_id_conflict": collision, "import_mode": "duplicate"}

    def get_story_world(self, workspace_id: str, world_id: str) -> dict[str, Any]:
        with self.db.lock:
            world = self.db.connection.execute(
                "SELECT world_id,name,latest_version,created_at,updated_at FROM story_worlds "
                "WHERE workspace_id=? AND world_id=?",
                (workspace_id, world_id),
            ).fetchone()
            if not world:
                raise NotFoundError("World does not exist in this workspace")
            versions = self.db.connection.execute(
                "SELECT version,name,description,template_key,content_json,created_revision,created_at "
                "FROM story_world_versions WHERE workspace_id=? AND world_id=? ORDER BY version DESC",
                (workspace_id, world_id),
            ).fetchall()
        return {
            **dict(world),
            "versions": [
                {**dict(row), "content": json.loads(row["content_json"])}
                for row in versions
            ],
        }

    def list_story_adventures(self, workspace_id: str, branch_id: str | None = None) -> list[dict[str, Any]]:
        with self.db.lock:
            if branch_id is not None:
                branch = self.db.connection.execute(
                    "SELECT 1 FROM branches WHERE workspace_id=? AND branch_id=?",
                    (workspace_id, branch_id),
                ).fetchone()
                if not branch:
                    raise NotFoundError("Branch does not exist in this workspace")
            query = (
                "SELECT a.adventure_id,a.branch_id,b.parent_branch_id,a.world_id,v.name AS world_name,a.world_version,"
                "a.conversation_id,a.name,a.actor_entity_id,e.label AS actor_label,a.status,"
                "a.created_revision,a.updated_revision,a.created_at,a.updated_at,COUNT(t.turn_id) AS turn_count "
                "FROM story_adventures a JOIN story_world_versions v ON v.workspace_id=a.workspace_id AND v.world_id=a.world_id AND v.version=a.world_version "
                "JOIN branches b ON b.workspace_id=a.workspace_id AND b.branch_id=a.branch_id "
                "JOIN entities e ON e.workspace_id=a.workspace_id AND e.branch_id=a.branch_id AND e.entity_id=a.actor_entity_id "
                "LEFT JOIN story_turns t ON t.workspace_id=a.workspace_id AND t.branch_id=a.branch_id AND t.conversation_id=a.conversation_id "
                "WHERE a.workspace_id=?"
            )
            parameters: tuple[Any, ...] = (workspace_id,)
            if branch_id is not None:
                query += " AND a.branch_id=?"
                parameters += (branch_id,)
            rows = self.db.connection.execute(
                query + " GROUP BY a.workspace_id,a.branch_id,a.adventure_id ORDER BY a.updated_at DESC,a.adventure_id",
                parameters,
            ).fetchall()
        return [dict(row) for row in rows]

    def get_rpg_state(self, workspace_id: str, branch_id: str, adventure_id: str) -> dict[str, Any]:
        with self.db.lock:
            adventure = self.db.connection.execute(
                "SELECT adventure_id,world_id,world_version,conversation_id,name,actor_entity_id,status,updated_revision,completed_turns,npc_simulation_enabled "
                "FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure:
                raise NotFoundError("Adventure does not exist in this branch")
            sheet = self.db.connection.execute(
                "SELECT stats_json,trackers_json,current_location,created_revision,updated_revision "
                "FROM rpg_sheets WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            checks = self.db.connection.execute(
                "SELECT check_id,conversation_id,actor_entity_id,stat_name,die_roll,modifier,total,target,outcome,created_revision,created_at "
                "FROM rpg_checks WHERE workspace_id=? AND branch_id=? AND adventure_id=? "
                "ORDER BY created_revision DESC LIMIT 50",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
            proposals = self.db.connection.execute(
                "SELECT proposal_id,conversation_id,source_turn_id,changes_json,review_status,created_revision,reviewed_revision,created_at "
                "FROM rpg_state_proposals WHERE workspace_id=? AND branch_id=? AND adventure_id=? "
                "ORDER BY created_revision DESC",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
        return {
            "adventure": {**dict(adventure), "npc_simulation_enabled": bool(adventure["npc_simulation_enabled"])},
            "sheet": {
                **dict(sheet),
                "stats": json.loads(sheet["stats_json"]),
                "trackers": json.loads(sheet["trackers_json"]),
            } if sheet else None,
            "checks": [dict(row) for row in checks],
            "proposals": [
                {**dict(row), "changes": json.loads(row["changes_json"])}
                for row in proposals
            ],
        }

    def get_story_memories(self, workspace_id: str, branch_id: str, adventure_id: str) -> dict[str, Any]:
        with self.db.lock:
            adventure = self.db.connection.execute(
                "SELECT conversation_id FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure:
                raise NotFoundError("Adventure does not exist in this branch")
            rows = self.db.connection.execute(
                "SELECT memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at "
                "FROM story_memories WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY memory_id,version",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
            threads = self.db.connection.execute(
                "SELECT thread_id,title,detail,status,created_revision,updated_revision,created_at,updated_at FROM story_threads "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY status,title COLLATE NOCASE",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
        by_id: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            by_id.setdefault(row["memory_id"], []).append({
                **dict(row),
                "context_enabled": bool(row["context_enabled"]),
                "known_by": json.loads(row["known_by_json"]),
            })
        latest = [versions[-1] for versions in by_id.values()]
        return {
            "memories": sorted(latest, key=lambda item: (item["created_revision"], item["memory_id"]), reverse=True),
            "history": {memory_id: versions for memory_id, versions in by_id.items()},
            "threads": [dict(row) for row in threads],
            "conversation_id": adventure["conversation_id"],
        }

    def list_story_npcs(self, workspace_id: str, branch_id: str, adventure_id: str) -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT p.npc_entity_id,e.label,e.entity_type,p.aliases_json,p.public_profile_json,p.private_profile_json,"
                "p.review_status,p.created_revision,p.updated_revision,p.created_at,p.updated_at FROM story_npc_profiles p "
                "JOIN entities e ON e.workspace_id=p.workspace_id AND e.branch_id=p.branch_id AND e.entity_id=p.npc_entity_id "
                "WHERE p.workspace_id=? AND p.branch_id=? AND p.adventure_id=? ORDER BY e.label COLLATE NOCASE",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
        return [
            {**dict(row), "aliases": json.loads(row["aliases_json"]),
             "public_profile": json.loads(row["public_profile_json"]),
             "private_profile": json.loads(row["private_profile_json"])}
            for row in rows
        ]

    def list_story_assets(self, workspace_id: str, branch_id: str, adventure_id: str) -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT asset_id,target_kind,target_id,display_name,mime_type,provenance_json,created_revision,created_at,length(content) AS size_bytes "
                "FROM story_assets WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY created_revision,asset_id",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
        return [{**dict(row), "provenance": json.loads(row["provenance_json"])} for row in rows]

    def list_story_locations(self, workspace_id: str, branch_id: str, adventure_id: str) -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT location_id,name,status,source_proposal_id,created_revision,reviewed_revision,created_at "
                "FROM story_map_locations WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY name COLLATE NOCASE",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_story_asset(self, workspace_id: str, branch_id: str, adventure_id: str, asset_id: str) -> dict[str, Any]:
        with self.db.lock:
            row = self.db.connection.execute(
                "SELECT asset_id,target_kind,target_id,display_name,mime_type,content,provenance_json,created_revision,created_at "
                "FROM story_assets WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND asset_id=?",
                (workspace_id, branch_id, adventure_id, asset_id),
            ).fetchone()
        if not row:
            raise NotFoundError("Story image does not exist in this adventure")
        return {**dict(row), "provenance": json.loads(row["provenance_json"])}

    def list_claims(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT claim_id,subject_entity_id,predicate,object_value,epistemic_status,review_status,visibility,narrative_order,evidence_json,created_revision "
                "FROM claims WHERE workspace_id=? AND branch_id=? ORDER BY created_revision,claim_id",
                (workspace_id, branch_id),
            ).fetchall()
        return [{"claim_id": r["claim_id"], "subject_entity_id": r["subject_entity_id"], "predicate": r["predicate"],
                 "object_value": r["object_value"], "epistemic_status": r["epistemic_status"],
                 "review_status": r["review_status"], "visibility": r["visibility"],
                 "narrative_order": r["narrative_order"], "evidence": json.loads(r["evidence_json"]),
                 "created_revision": r["created_revision"]} for r in rows]

    def list_conversations(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        with self.db.lock:
            branch = self.db.connection.execute(
                "SELECT 1 FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not branch:
                raise NotFoundError("Branch does not exist in this workspace")
            rows = self.db.connection.execute(
                "SELECT c.conversation_id,c.actor_entity_id,e.label AS actor_label,c.title,"
                "c.actor_is_user_controlled,c.created_revision,c.updated_revision,c.created_at,c.updated_at,"
                "COUNT(t.turn_id) AS turn_count "
                "FROM story_conversations c JOIN entities e ON e.workspace_id=c.workspace_id "
                "AND e.branch_id=c.branch_id AND e.entity_id=c.actor_entity_id "
                "LEFT JOIN story_turns t ON t.workspace_id=c.workspace_id AND t.branch_id=c.branch_id "
                "AND t.conversation_id=c.conversation_id "
                "WHERE c.workspace_id=? AND c.branch_id=? "
                "GROUP BY c.workspace_id,c.branch_id,c.conversation_id "
                "ORDER BY c.updated_at DESC,c.conversation_id",
                (workspace_id, branch_id),
            ).fetchall()
        return [
            {
                "conversation_id": row["conversation_id"],
                "actor_entity_id": row["actor_entity_id"],
                "actor_label": row["actor_label"],
                "title": row["title"],
                "actor_is_user_controlled": bool(row["actor_is_user_controlled"]),
                "created_revision": row["created_revision"],
                "updated_revision": row["updated_revision"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "turn_count": row["turn_count"],
            }
            for row in rows
        ]

    def get_conversation(
        self, workspace_id: str, branch_id: str, conversation_id: str
    ) -> dict[str, Any]:
        with self.db.lock:
            row = self.db.connection.execute(
                "SELECT c.conversation_id,c.actor_entity_id,e.label AS actor_label,c.title,"
                "c.actor_is_user_controlled,c.created_revision,c.updated_revision,c.created_at,c.updated_at "
                "FROM story_conversations c JOIN entities e ON e.workspace_id=c.workspace_id "
                "AND e.branch_id=c.branch_id AND e.entity_id=c.actor_entity_id "
                "WHERE c.workspace_id=? AND c.branch_id=? AND c.conversation_id=?",
                (workspace_id, branch_id, conversation_id),
            ).fetchone()
            if not row:
                raise NotFoundError("Story conversation does not exist in this branch")
            turns = self.db.connection.execute(
                "SELECT turn_id,turn_order,role,narrative_order,content,provider,model,"
                "context_manifest_id,context_manifest_json,context_revision,created_revision,created_at "
                "FROM story_turns WHERE workspace_id=? AND branch_id=? AND conversation_id=? "
                "ORDER BY turn_order",
                (workspace_id, branch_id, conversation_id),
            ).fetchall()
            edit_rows = self.db.connection.execute(
                "SELECT turn_id,version,content,status,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at FROM story_turn_edits "
                "WHERE workspace_id=? AND branch_id=? AND conversation_id=? ORDER BY turn_id,version",
                (workspace_id, branch_id, conversation_id),
            ).fetchall()
        conversation = dict(row)
        conversation["actor_is_user_controlled"] = bool(conversation["actor_is_user_controlled"])
        conversation["turns"] = []
        edits_by_turn: dict[str, list[dict[str, Any]]] = {}
        for edit in edit_rows:
            edits_by_turn.setdefault(edit["turn_id"], []).append(dict(edit))
        for turn in turns:
            item = dict(turn)
            manifest_json = item.pop("context_manifest_json")
            item["context_manifest"] = json.loads(manifest_json) if manifest_json else None
            history = edits_by_turn.get(item["turn_id"], [])
            if history:
                item["content"] = history[-1]["content"]
                item["status"] = history[-1]["status"]
                for field in ("provider", "model", "context_manifest_id", "context_revision"):
                    if history[-1][field] is not None:
                        item[field] = history[-1][field]
                if history[-1]["context_manifest_json"] is not None:
                    item["context_manifest"] = json.loads(history[-1]["context_manifest_json"])
            else:
                item["status"] = "active"
            for edit in history:
                manifest_json = edit.pop("context_manifest_json")
                edit["context_manifest"] = json.loads(manifest_json) if manifest_json else None
            item["edit_history"] = history
            conversation["turns"].append(item)
        return conversation

