"""Translate MNO RPG Engine exports into Lorethra's portable story packages.

The converter never executes imported rules, formulas, prompts, or scripts. Raw
source data is retained as user-authored story material for round-trip recovery.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from typing import Any

from lke.core.errors import ValidationError


MAX_SOURCE_BYTES = 10_000_000
_MNO_ROLES = {"narrator", "npc", "action", "check", "thought", "meta"}


def _source_size(source: Any) -> None:
    if not isinstance(source, dict):
        raise ValidationError("MNO export must be a JSON object")
    try:
        if len(json.dumps(source, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_SOURCE_BYTES:
            raise ValidationError("MNO export is limited to 10 MB")
    except (TypeError, ValueError, RecursionError) as error:
        raise ValidationError("MNO export must contain valid JSON") from error


def _clean_text(value: Any, field: str, limit: int, *, required: bool = False) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or len(value.strip()) > limit or (required and not value.strip()):
        raise ValidationError(f"{field} must be text of at most {limit} characters")
    return value.strip()


def _stable_id(prefix: str, value: Any) -> str:
    digest = hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:28]
    return f"{prefix}_{digest}"


def _timestamp(value: Any, fallback: str) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        try:
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except (OverflowError, OSError, ValueError):
            pass
    if isinstance(value, str) and value.strip() and len(value) <= 80:
        return value.strip()
    return fallback


def _date_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _identifier(value: Any, field: str) -> str:
    text = _clean_text(value, field, 100, required=True)
    normalized = re.sub(r"[^A-Za-z0-9_-]+", "_", text).strip("_")
    return normalized[:70] or _stable_id("mno", text)


def _stat_modifier(score: Any, average: Any = 10, step: Any = 1) -> int:
    if type(score) is not int or not 0 <= score <= 100:
        raise ValidationError("MNO character stat scores must be integers between 0 and 100")
    if type(average) is not int or not 0 <= average <= 100 or type(step) is not int or not 0 <= step <= 10:
        raise ValidationError("MNO stat conversion settings are invalid")
    return max(-10, min(10, math.floor((score - average) / 2) * step))


def _tracker_key(value: Any) -> str:
    label = _clean_text(value, "tracker key", 60, required=True).casefold()
    key = re.sub(r"[^a-z0-9_-]+", "_", label).strip("_")
    return key[:60] or "tracker"


def _numeric_trackers(definitions: Any, values: Any) -> tuple[dict[str, dict[str, int]], dict[str, str]]:
    if not isinstance(definitions, list) or len(definitions) > 30:
        raise ValidationError("MNO tracker definitions must be an array of at most 30 items")
    if not isinstance(values, dict):
        values = {}
    result: dict[str, dict[str, int]] = {}
    text_values: dict[str, str] = {}
    for definition in definitions:
        if not isinstance(definition, dict):
            continue
        key = _tracker_key(definition.get("key", definition.get("label", "tracker")))
        raw = values.get(key, definition.get("start"))
        if definition.get("type") == "text":
            if isinstance(raw, str):
                text_values[key] = raw[:2000]
            continue
        if type(raw) is not int or raw < 0:
            continue
        maximum = values.get(f"{key}.max", definition.get("max"))
        if type(maximum) is not int or maximum < raw:
            maximum = max(100, raw)
        maximum = min(maximum, 100_000)
        result[key] = {"value": min(raw, maximum), "max": maximum}
    return result, text_values


def _data_image(value: Any) -> tuple[str, str] | None:
    if not isinstance(value, str) or not value:
        return None
    match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)", value)
    if not match:
        raise ValidationError("MNO portraits must be embedded PNG, JPEG, or WebP data images")
    data = "".join(match.group(2).split())
    try:
        decoded = base64.b64decode(data, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValidationError("MNO portrait contains invalid base64 data") from error
    if not 1 <= len(decoded) <= 5_242_880:
        raise ValidationError("Each imported MNO portrait must be between 1 byte and 5 MB")
    return match.group(1), data


def convert_mno_world(source: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return an LKE world package and a concise import preview."""
    _source_size(source)
    if source.get("format") != "mno-world" or type(source.get("version")) is not int or source["version"] != 1:
        raise ValidationError("Only MNO .mno-world version 1 files are supported")
    meta = source.get("meta")
    if not isinstance(meta, dict):
        raise ValidationError("MNO world metadata is missing")
    name = _clean_text(meta.get("name"), "world name", 200, required=True)
    description = _clean_text(meta.get("description", ""), "world description", 4000)
    source_id = _identifier(meta.get("id"), "world id")
    stats = source.get("stats") if isinstance(source.get("stats"), dict) else {}
    definitions = stats.get("defs", [])
    if not isinstance(definitions, list) or not 1 <= len(definitions) <= 20:
        raise ValidationError("MNO world must define between 1 and 20 character stats")
    stat_modifiers: dict[str, int] = {}
    for definition in definitions:
        if not isinstance(definition, dict):
            raise ValidationError("MNO stat definitions must be objects")
        key = _tracker_key(definition.get("key"))
        if key in stat_modifiers:
            raise ValidationError("MNO stat keys must be unique")
        stat_modifiers[key] = _stat_modifier(definition.get("start", 10), stats.get("averageThreshold", 10), stats.get("modStep", 1))

    tracker_definitions = source.get("trackers", [])
    world_trackers, text_trackers = _numeric_trackers(tracker_definitions, {})
    location = next((value for key, value in text_trackers.items() if key in {"location", "current_location"}), "")
    lorebook = source.get("lorebook", [])
    if not isinstance(lorebook, list) or len(lorebook) > 1000:
        raise ValidationError("MNO lorebook must contain at most 1000 entries")
    npcs = source.get("npcs", [])
    if not isinstance(npcs, list) or len(npcs) > 500:
        raise ValidationError("MNO world NPC templates must be an array of at most 500 profiles")
    content = {
        "starting_location": location,
        "stats": stat_modifiers,
        "trackers": world_trackers,
        "text_trackers": text_trackers,
        "public_lore": description,
        "locations": [],
        "mno_source": source,
        "mno_import": {
            "format": "mno-world",
            "version": 1,
            "narrative_vibe": source.get("narrativeVibe", ""),
            "stat_definitions": definitions,
            "npc_tracker_definitions": source.get("npcTrackers", []),
            "conversion": "Lorethra d20 modifiers use floor((score - averageThreshold) / 2) * modStep, clamped to -10..10. The MNO formula is preserved but never executed.",
        },
    }
    package = {
        "protocol": "lke.world.v1",
        "provenance": {"workspace_id": "mno-import", "world_id": source_id},
        "versions": [{
            "version": 1, "name": name, "description": description,
            "template_key": "mno-import", "content": content,
        }],
    }
    preview = {
        "source_format": "mno-world",
        "content_warning": "This world is tagged NSFW by its source." if meta.get("nsfw") is True else None,
        "stat_count": len(definitions), "tracker_count": len(tracker_definitions),
        "lore_entry_count": len(lorebook), "npc_template_count": len(npcs),
        "conversion_notes": [
            "MNO formulas and instructions are preserved as text; no imported formula or script is executed.",
            "Imported world lore is narrator reference. It does not automatically become a character's knowledge.",
            "Text trackers and all original settings remain in the preserved MNO source; Lorethra initializes numeric RPG trackers only.",
        ],
    }
    return package, preview


def _memory_content(memory: Any) -> tuple[str, str] | None:
    if isinstance(memory, str):
        return "Memory", _clean_text(memory, "memory", 4000)
    if not isinstance(memory, dict):
        return None
    title = _clean_text(memory.get("title", memory.get("name", "Memory")), "memory title", 200) or "Memory"
    content = next((memory[key] for key in ("content", "text", "summary", "description", "detail") if isinstance(memory.get(key), str)), "")
    content = _clean_text(content, "memory content", 4000)
    return (title, content) if content else None


def convert_mno_adventure(source: Any, world_package: dict[str, Any], filename: str | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Translate an MNO adventure against the already imported matching world."""
    _source_size(source)
    if type(source.get("version")) is not int or source["version"] != 2:
        raise ValidationError("Only MNO .mno-adv version 2 files are supported")
    source_world_id = _clean_text(source.get("worldId"), "MNO worldId", 100, required=True)
    if not isinstance(world_package, dict) or world_package.get("protocol") not in {"lke.world.v1", "lke.world.v2"}:
        raise ValidationError("Import the matching MNO world before this adventure")
    world_id = world_package.get("provenance", {}).get("world_id")
    source_world = next((version for version in reversed(world_package.get("versions", []))
                         if isinstance(version.get("content"), dict)
                         and version["content"].get("mno_source", {}).get("meta", {}).get("id") == source_world_id), None)
    if source_world is None:
        raise ValidationError("The adventure worldId does not match an imported MNO world in this workspace")
    world_version = source_world["version"]

    character = source.get("character")
    if not isinstance(character, dict):
        raise ValidationError("MNO adventure protagonist is missing")
    character_name = _clean_text(character.get("name"), "protagonist name", 200, required=True)
    source_adventure_id = _identifier(source.get("id", source.get("name", "adventure")), "adventure id")
    actor_id = _stable_id("mno_hero", f"{source_adventure_id}:{character_name}")
    profile_keys = ("age", "gender", "race", "appearance", "job", "persona", "extra", "background")
    hero_profile = {key: _clean_text(character.get(key, ""), f"protagonist {key}", 4000) for key in profile_keys if character.get(key)}
    raw_scores = character.get("stats", {})
    world_stats = source_world["content"].get("mno_import", {}).get("stat_definitions", [])
    stat_settings = source_world["content"].get("mno_source", {}).get("stats", {})
    average, step = stat_settings.get("averageThreshold", 10), stat_settings.get("modStep", 1)
    if not isinstance(raw_scores, dict) or not 1 <= len(raw_scores) <= 20:
        raise ValidationError("MNO protagonist must have between 1 and 20 numeric stats")
    lke_stats = { _tracker_key(key): _stat_modifier(score, average, step) for key, score in raw_scores.items() }
    tracker_definitions = source_world["content"].get("mno_source", {}).get("trackers", [])
    latest_trackers: dict[str, Any] = source.get("initialTrackers", {})
    messages = source.get("messages", [])
    if not isinstance(messages, list) or len(messages) > 10_000:
        raise ValidationError("MNO transcript must contain at most 10000 messages")
    for message in messages:
        if isinstance(message, dict) and isinstance(message.get("afterTrackers"), dict):
            latest_trackers = message["afterTrackers"]
    trackers, text_trackers = _numeric_trackers(tracker_definitions, latest_trackers)
    current_location = _clean_text(latest_trackers.get("location", ""), "current location", 200)
    goal = _clean_text(latest_trackers.get("quest", ""), "current goal", 2000)
    now = _date_now()
    first_timestamp = _timestamp(messages[0].get("ts") if messages and isinstance(messages[0], dict) else None, now)
    final_timestamp = _timestamp(messages[-1].get("ts") if messages and isinstance(messages[-1], dict) else None, now)

    entities = [{
        "entity_id": actor_id, "entity_type": "character", "label": character_name,
        "properties": {
            "role": "protagonist", "character_profile": hero_profile,
            "mno_import": {"format": "mno-adv", "source_id": source.get("id"), "stat_scores": raw_scores,
                           "text_trackers": text_trackers,
                           "stat_conversion": "floor((score - averageThreshold) / 2) * modStep, clamped to -10..10"},
        },
    }]
    npcs: list[dict[str, Any]] = []
    assets: list[dict[str, Any]] = []

    def add_portrait(target_id: str, label: str, image_value: Any, role: str) -> None:
        image = _data_image(image_value)
        if image is None:
            return
        mime_type, encoded = image
        assets.append({
            "asset_id": _stable_id("mno_portrait", target_id), "target_kind": "character", "target_id": target_id,
            "display_name": f"{label} portrait", "mime_type": mime_type, "data_base64": encoded,
            "provenance": {"origin": "mno_import", "source_role": role}, "created_at": first_timestamp,
        })

    add_portrait(actor_id, character_name, character.get("portrait"), "protagonist")

    raw_npcs = source.get("npcs", {})
    if not isinstance(raw_npcs, dict) or len(raw_npcs) > 500:
        raise ValidationError("MNO adventure NPC collection is invalid")
    for npc_key, npc in raw_npcs.items():
        if not isinstance(npc, dict):
            continue
        npc_name = _clean_text(npc.get("name", npc_key), "NPC name", 200, required=True)
        npc_id = _stable_id("mno_npc", f"{source_adventure_id}:{npc_key}:{npc_name}")
        details = npc.get("details", {}) if isinstance(npc.get("details"), dict) else {}
        public_profile = {
            key: _clean_text(details.get(key, ""), f"NPC {key}", 4000)
            for key in ("age", "gender", "race", "appearance", "job", "persona", "extra")
            if details.get(key)
        }
        private_profile = {
            "notes": _clean_text(details.get("secrets", ""), "NPC private notes", 4000),
            "trackers": npc.get("trackers", {}) if isinstance(npc.get("trackers", {}), dict) else {},
            "life": {key: npc[key] for key in ("lifeGoal", "lifeWhere", "lifeHistory", "lifeTick", "firstSeenTurn", "lastSeenTurn", "appearanceCount", "importance", "pinned", "cast") if key in npc},
            "source_details": {key: details[key] for key in ("secrets",) if key in details},
        }
        entities.append({"entity_id": npc_id, "entity_type": "character", "label": npc_name,
                         "properties": {"role": "npc", "mno_import": {"format": "mno-adv", "source_key": npc_key}}})
        npcs.append({"npc_entity_id": npc_id, "aliases": [], "public_profile": public_profile,
                     "private_profile": private_profile, "review_status": "accepted",
                     "created_at": first_timestamp, "updated_at": final_timestamp})
        add_portrait(npc_id, npc_name, npc.get("portrait"), "npc")

    clean_turns: list[dict[str, Any]] = []
    action_count = 0
    turn_ids: list[str] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise ValidationError("MNO transcript messages must be objects")
        source_role = message.get("role")
        if source_role not in _MNO_ROLES:
            raise ValidationError("MNO transcript contains an unsupported message role")
        content = _clean_text(message.get("text", ""), "transcript message", 200_000, required=True)
        role = "user" if source_role == "action" else "assistant"
        if role == "user":
            action_count += 1
        turn_id = _stable_id("mno_turn", f"{source_adventure_id}:{index}")
        turn_ids.append(turn_id)
        meta: dict[str, Any] = {
            "source_format": "mno-adv", "source_role": source_role,
            "speaker": _clean_text(message.get("name", ""), "message speaker", 200) or None,
            "source_timestamp": _timestamp(message.get("ts"), now),
            "context_excluded": source_role in {"thought", "meta"},
        }
        if isinstance(message.get("afterTrackers"), dict):
            meta["tracker_snapshot"] = message["afterTrackers"]
        for key in ("kind", "travelRegion", "travelBearing"):
            if isinstance(message.get(key), (str, int, float, bool)):
                meta[key] = message[key]
        clean_turns.append({
            "turn_id": turn_id, "turn_order": index, "role": role,
            "narrative_order": index + 1, "content": content, "provider": None, "model": None,
            "metadata": meta, "created_at": _timestamp(message.get("ts"), now),
        })

    locations: list[dict[str, Any]] = []
    map_data = source.get("map", {})
    if not isinstance(map_data, dict):
        map_data = {}
    pois = map_data.get("pois", [])
    if not isinstance(pois, list) or len(pois) > 1000:
        raise ValidationError("MNO map must contain at most 1000 places")
    for index, poi in enumerate(pois):
        if not isinstance(poi, dict):
            continue
        name = _clean_text(poi.get("name"), "map place name", 200, required=True)
        x, y = poi.get("dx"), poi.get("dy")
        locations.append({
            "location_id": _stable_id("mno_place", f"{source_adventure_id}:{index}:{name}"),
            "name": name, "status": "approved", "source_proposal_id": None,
            "location_type": _clean_text(poi.get("type", "place"), "map place type", 80) or "place",
            "description": _clean_text(poi.get("desc", ""), "map place description", 1000),
            "icon": _clean_text(poi.get("icon", ""), "map place icon", 40),
            "x": x if type(x) in (int, float) and abs(x) <= 1_000_000 else None,
            "y": y if type(y) in (int, float) and abs(y) <= 1_000_000 else None,
            "created_at": first_timestamp,
        })

    memories: list[dict[str, Any]] = []
    raw_memories = source.get("memories", {})
    if isinstance(raw_memories, dict):
        for source_kind, memory_kind, status, scope in (
            ("manual", "note", "accepted", "author"),
            ("auto", "event", "proposed", "shared"),
        ):
            values = raw_memories.get(source_kind, [])
            if not isinstance(values, list):
                continue
            for index, raw_memory in enumerate(values[:500]):
                memory = _memory_content(raw_memory)
                if memory is None:
                    continue
                memory_title, content = memory
                memories.append({
                    "memory_id": _stable_id("mno_memory", f"{source_adventure_id}:{source_kind}:{index}:{memory_title}"),
                    "version": 1, "kind": memory_kind, "content": content,
                    "context_enabled": source_kind == "manual", "review_status": status,
                    "source_turn_id": None, "narrative_order": len(clean_turns), "supersedes_version": None,
                    "importance": 3, "knowledge_scope": scope, "known_by": [], "created_at": final_timestamp,
                })
    latest_situation = _clean_text(source.get("latestSituation", ""), "latest situation", 4000)
    if latest_situation:
        memories.append({
            "memory_id": _stable_id("mno_situation", source_adventure_id), "version": 1, "kind": "situation",
            "content": latest_situation, "context_enabled": True, "review_status": "proposed",
            "source_turn_id": None, "narrative_order": len(clean_turns), "supersedes_version": None,
            "importance": 3, "knowledge_scope": "author", "known_by": [], "created_at": final_timestamp,
        })
    threads: list[dict[str, Any]] = []
    if goal and goal.casefold() not in {"none", "none chosen", "—"}:
        threads.append({
            "thread_id": _stable_id("mno_goal", source_adventure_id), "title": "Current goal", "detail": goal,
            "status": "open", "created_at": first_timestamp, "updated_at": final_timestamp,
        })
    raw_threads = source.get("openThreads", [])
    if isinstance(raw_threads, list):
        for index, thread in enumerate(raw_threads[:500]):
            parsed = _memory_content(thread)
            if parsed is None:
                continue
            thread_title, detail = parsed
            threads.append({"thread_id": _stable_id("mno_thread", f"{source_adventure_id}:{index}:{thread_title}"),
                            "title": thread_title, "detail": detail[:2000], "status": "open",
                            "created_at": final_timestamp, "updated_at": final_timestamp})

    hero = map_data.get("hero", {}) if isinstance(map_data.get("hero", {}), dict) else {}
    map_x, map_y = hero.get("x"), hero.get("y")
    if type(map_x) not in (int, float) or abs(map_x) > 1_000_000:
        map_x = None
    if type(map_y) not in (int, float) or abs(map_y) > 1_000_000:
        map_y = None
    world_name = _clean_text(source.get("worldName", source_world["name"]), "world name", 200) or source_world["name"]
    adventure_name = _clean_text(source.get("name", "Adventure"), "adventure name", 200, required=True)
    world_versions = world_package["versions"]
    package = {
        "protocol": "lke.adventure.v1",
        "provenance": {"workspace_id": "mno-import", "branch_id": "mno", "adventure_id": source_adventure_id,
                       "exported_at": now},
        "world": world_package,
        "context_manifests_included": False,
        "adventure": {
            "name": adventure_name, "world_version": world_version, "status": "active",
            "completed_turns": action_count, "npc_simulation_enabled": False,
            "actor_entity_id": actor_id, "entities": entities,
            "conversation": {"title": adventure_name, "actor_is_user_controlled": True},
            "sheet": {"stats": lke_stats, "trackers": trackers, "current_location": current_location,
                      "map_region": _clean_text(map_data.get("loc", world_name), "map region", 200) or world_name,
                      "map_x": map_x, "map_y": map_y,
                      "map_scale": _clean_text(map_data.get("scale", "regional"), "map scale", 40) or "regional"},
            "turns": clean_turns, "turn_edits": [], "checks": [], "proposals": [],
            "memories": memories, "threads": threads, "npcs": npcs, "assets": assets, "locations": locations,
            "source_archive": {"format": "mno-adv", "version": 2, "filename": filename, "data": source},
        },
    }
    preview = {
        "source_format": "mno-adv", "world_name": world_name, "message_count": len(clean_turns),
        "action_count": action_count, "npc_count": len(npcs), "image_count": len(assets),
        "map_location_count": len(locations), "memory_count": len(memories),
        "context_excluded_message_count": sum(bool(turn["metadata"]["context_excluded"]) for turn in clean_turns),
        "conversion_notes": [
            "MNO narrator, NPC, action, check, thought, and meta messages are retained with source-role and timestamp metadata; imported check prose is not converted into a verified die roll.",
            "MNO inner-thought and meta messages remain in the transcript archive but are excluded from future model context.",
            "NPC secrets, relationship trackers, and off-screen life history are kept in author-only profile data.",
            "Base stat scores use Lorethra's explicit d20 conversion and their original scores remain preserved; this is not a claim about MNO's own formula.",
            "The source adventure is retained locally for faithful export and recovery. It is never included in generation context.",
        ],
    }
    return package, preview
