"""Validated, revisioned writes to the canonical knowledge store."""

from __future__ import annotations

import hashlib
import copy
import json
import re
import sqlite3
import base64
import binascii
import io
import warnings
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
    "create_story_world", "revise_story_world", "import_story_world", "duplicate_story_world", "set_story_world_archived",
    "create_story_adventure", "set_story_adventure_library_state", "update_rpg_sheet",
    "record_d20_check", "record_rpg_mechanic_check", "update_story_skills", "award_story_experience",
    "set_story_ability_active", "propose_rpg_state", "review_rpg_state_proposal",
    "edit_story_turn", "create_story_memory", "revise_story_memory", "review_story_memory",
    "save_story_thread", "update_story_npc", "create_story_npc", "travel_to_location", "add_story_asset",
    "set_npc_simulation",
    "create_rule", "review_rule", "create_scenario", "set_scenario_assumption",
    "review_scenario_assumption", "record_extraction_batch", "review_extraction_candidate",
    "import_exchange", "import_story_adventure", "promote_branch",
}
_SEARCH_TOKEN = re.compile(r'"([^"\s]+)"|([^\s]+)')


_ALLOWED_STORY_PROVIDERS = {"ollama", "openai", "claude", "codex", "huggingface", "huggingface_local"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _package_json_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, dict):
        if (isinstance(value.get("content"), bytes)
                and {"asset_id", "target_kind"} <= set(value)):
            wire_value = {key: item for key, item in value.items() if key != "content"}
            wire_value["data_base64"] = base64.b64encode(value["content"]).decode("ascii")
            return {key: _package_json_value(item) for key, item in wire_value.items()}
        return {key: _package_json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_package_json_value(item) for item in value]
    return value


def _package_payload_bytes(package: dict[str, Any]) -> bytes:
    payload = {key: value for key, value in package.items() if key != "manifest"}
    try:
        return json.dumps(_package_json_value(payload), ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as error:
        raise ValidationError("Package must contain valid, bounded JSON data") from error


def _package_size_bytes(package: dict[str, Any]) -> int:
    try:
        return len(json.dumps(_package_json_value(package), ensure_ascii=False, sort_keys=True,
                              separators=(",", ":"), allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError, RecursionError) as error:
        raise ValidationError("Package must contain valid, bounded JSON data") from error


def _package_asset_checksums(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    checksums = []
    for asset in assets:
        content = asset.get("content")
        if not isinstance(content, bytes):
            try:
                content = base64.b64decode(asset["data_base64"], validate=True)
            except (KeyError, ValueError, binascii.Error) as error:
                raise ValidationError("Package asset data must be valid base64") from error
        checksums.append({"asset_id": asset["asset_id"], "sha256": hashlib.sha256(content).hexdigest(),
                          "size_bytes": len(content)})
    return sorted(checksums, key=lambda item: item["asset_id"])


def _new_package_manifest(package: dict[str, Any], assets: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"version": 1, "algorithm": "sha256",
            "payload_sha256": hashlib.sha256(_package_payload_bytes(package)).hexdigest(),
            "assets": _package_asset_checksums(assets or [])}


def _validated_package_manifest(package: dict[str, Any]) -> dict[str, Any]:
    manifest = _package_object(package.get("manifest"),
                               {"version", "algorithm", "payload_sha256", "assets"}, "Package manifest")
    if (type(manifest["version"]) is not int or manifest["version"] != 1
            or manifest["algorithm"] != "sha256"
            or not isinstance(manifest["payload_sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", manifest["payload_sha256"])):
        raise ValidationError("Package manifest version or payload checksum is invalid")
    if hashlib.sha256(_package_payload_bytes(package)).hexdigest() != manifest["payload_sha256"]:
        raise ValidationError("Package payload checksum does not match its contents")
    if not isinstance(manifest["assets"], list) or len(manifest["assets"]) > 500:
        raise ValidationError("Package asset manifest must contain at most 500 checksums")
    for asset in manifest["assets"]:
        _package_object(asset, {"asset_id", "sha256", "size_bytes"}, "Package asset checksum")
        _required_text(asset["asset_id"], "manifest asset_id", 100)
        if (not isinstance(asset["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", asset["sha256"])
                or type(asset["size_bytes"]) is not int or not 1 <= asset["size_bytes"] <= 5_242_880):
            raise ValidationError("Package asset checksum or size is invalid")
    return manifest


def _require_package_asset_checksums(manifest: dict[str, Any], assets: list[dict[str, Any]]) -> None:
    if manifest["assets"] != _package_asset_checksums(assets):
        raise ValidationError("Package asset checksums do not match the decoded assets")


def _required_text(value: Any, field: str, limit: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValidationError(f"{field} must be non-empty text of at most {limit} characters")
    return value.strip()


_CHARACTER_PROFILE_FIELD_LIMITS = {
    "concept": 200,
    "background": 4_000,
    "personality": 500,
    "goal": 400,
    "voice": 500,
    "age": 4_000,
    "gender": 4_000,
    "race": 4_000,
    "appearance": 4_000,
    "job": 4_000,
    "persona": 4_000,
    "extra": 4_000,
}


def _validated_entity_properties(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError("properties must be an object")
    properties = dict(value)
    if "character_profile" in properties:
        profile = properties["character_profile"]
        if not isinstance(profile, dict):
            raise ValidationError("character_profile must be an object")
        unknown_fields = set(profile) - set(_CHARACTER_PROFILE_FIELD_LIMITS)
        if unknown_fields:
            raise ValidationError("character_profile contains unsupported fields")
        clean_profile: dict[str, str] = {}
        for field, limit in _CHARACTER_PROFILE_FIELD_LIMITS.items():
            if field not in profile:
                continue
            text = profile[field]
            if not isinstance(text, str):
                raise ValidationError(f"character_profile.{field} must be text")
            text = text.strip()
            if len(text) > limit:
                raise ValidationError(f"character_profile.{field} is limited to {limit} characters")
            if text:
                clean_profile[field] = text
        if sum(len(text) for text in clean_profile.values()) > 34_000:
            raise ValidationError("character_profile text is limited to 34,000 characters total")
        if clean_profile:
            properties["character_profile"] = clean_profile
        else:
            properties.pop("character_profile")
    try:
        _json(properties)
    except (TypeError, ValueError, RecursionError) as error:
        raise ValidationError("properties must contain JSON-compatible data") from error
    return properties


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
    if stable_request["command_type"] == "record_rpg_mechanic_check":
        stable_payload = dict(stable_request["payload"])
        stable_payload.pop("dice_rolls", None)
        stable_payload.pop("check_id", None)
        stable_request["payload"] = stable_payload
    if stable_request["command_type"] == "record_extraction_batch":
        stable_payload = dict(stable_request["payload"])
        stable_payload.pop("candidates", None)
        stable_request["payload"] = stable_payload
    return hashlib.sha256(_json(stable_request).encode("utf-8")).hexdigest()


def _validated_world_content(value: Any, *, max_bytes: int | None = None, label: str = "world content") -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{label} must be an object")
    if max_bytes is None:
        source_archive = value.get("mno_source")
        if isinstance(source_archive, dict) and source_archive.get("format") == "mno-world" and source_archive.get("version") == 1:
            max_bytes = 1_500_000
        else:
            max_bytes = 200_000 if value.get("cover_image") is not None else 100_000
    try:
        serialized = _json(value)
        if len(serialized.encode("utf-8")) > max_bytes:
            raise ValidationError(f"{label} is limited to {max_bytes / 1_000_000:g} MB")
    except (TypeError, ValueError, RecursionError) as error:
        raise ValidationError(f"{label} must contain JSON-compatible values") from error

    credential_fields = {
        "apikey", "openaiapikey", "authorization", "bearertoken", "accesstoken",
        "refreshtoken", "clientsecret", "clientpassword", "password", "passwd",
        "credential", "credentials", "providersecret", "secretkey",
    }

    def reject_credentials(node: Any) -> None:
        if isinstance(node, dict):
            for key, nested in node.items():
                normalized = re.sub(r"[^a-z0-9]", "", str(key).casefold())
                if normalized in credential_fields:
                    raise ValidationError("world content cannot contain provider credentials")
                reject_credentials(nested)
        elif isinstance(node, list):
            for nested in node:
                reject_credentials(nested)

    reject_credentials(value)
    cover = value.get("cover_image")
    if cover is not None:
        if not isinstance(cover, dict) or set(cover) != {"mime_type", "data_base64", "alt_text"}:
            raise ValidationError("cover_image must include mime_type, data_base64, and alt_text")
        mime_type = cover.get("mime_type")
        if not isinstance(mime_type, str) or mime_type not in {"image/jpeg", "image/png", "image/webp"}:
            raise ValidationError("World covers must be JPEG, PNG, or WebP images")
        alt_text = cover.get("alt_text")
        if not isinstance(alt_text, str) or len(alt_text.strip()) > 300:
            raise ValidationError("World cover alt_text must be text of at most 300 characters")
        try:
            content = base64.b64decode(_required_text(cover.get("data_base64"), "world cover data", 100_000), validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValidationError("World cover data must be valid base64") from error
        if not 1 <= len(content) <= 65_536:
            raise ValidationError("World cover images are limited to 64 KiB")
        _validate_image_content(mime_type, content)
    return value


def _validated_story_opening_scene(content: dict[str, Any]) -> dict[str, str] | None:
    """Validate the optional public scene seed pinned to a reusable world version."""
    if "opening_scene" not in content:
        return None
    raw = content["opening_scene"]
    if not isinstance(raw, dict) or set(raw) != {"situation", "hook"}:
        raise ValidationError("opening_scene must define a situation and an immediate hook")
    return {
        "situation": _required_text(raw["situation"], "opening scene situation", 4000),
        "hook": _required_text(raw["hook"], "opening scene hook", 2000),
    }


def _validated_story_world_locations(content: dict[str, Any]) -> None:
    """Check authored world location names and the optional starting-place reference."""
    starting_location = content.get("starting_location", "")
    if not isinstance(starting_location, str) or len(starting_location.strip()) > 200:
        raise ValidationError("starting_location must be text of at most 200 characters")
    starting_location = starting_location.strip()
    if "locations" not in content:
        if "starting_location" in content:
            content["starting_location"] = starting_location
        return
    raw = content["locations"]
    if not isinstance(raw, list) or len(raw) > 100:
        raise ValidationError("World locations must be an array of at most 100 names")
    locations = [_required_text(item, "world location", 150) for item in raw]
    location_keys = {item.casefold() for item in locations}
    if len(location_keys) != len(locations):
        raise ValidationError("World location names must be unique regardless of letter case")
    content["locations"] = locations
    if starting_location and locations and starting_location.casefold() not in location_keys:
        raise ValidationError("starting_location must match one of the world locations")
    if starting_location and locations:
        starting_location = next(item for item in locations if item.casefold() == starting_location.casefold())
    if "starting_location" in content:
        content["starting_location"] = starting_location


_DEFAULT_STORY_STATS = {"might": 0, "agility": 0, "insight": 0, "presence": 0}


def _story_stat_baselines(content: dict[str, Any]) -> dict[str, int]:
    stats = _validated_stats(content.get("stats", _DEFAULT_STORY_STATS))
    if len({name.casefold() for name in stats}) != len(stats):
        raise ValidationError("World stat names must be unique regardless of letter case")
    return stats


def _validated_story_character_creation(content: dict[str, Any]) -> dict[str, Any] | None:
    """Validate an optional, world-pinned point-buy contract for character attributes."""
    if "character_creation" not in content:
        return None
    raw = content.get("character_creation")
    if not isinstance(raw, dict) or set(raw) != {
        "point_budget", "allow_unspent_points", "allow_below_baseline", "stats",
    }:
        raise ValidationError("character_creation must define a point budget, optional rules, and stat bounds")
    point_budget = raw["point_budget"]
    allow_unspent = raw["allow_unspent_points"]
    allow_below_baseline = raw["allow_below_baseline"]
    if type(point_budget) is not int or not 0 <= point_budget <= 200:
        raise ValidationError("character creation point_budget must be an integer from 0 to 200")
    if not isinstance(allow_unspent, bool) or not isinstance(allow_below_baseline, bool):
        raise ValidationError("character creation optional rules must be booleans")
    baselines = _story_stat_baselines(content)
    if len({key.casefold() for key in baselines}) != len(baselines):
        raise ValidationError("World stat names must be unique regardless of letter case")
    definitions = raw["stats"]
    if not isinstance(definitions, dict) or set(definitions) != set(baselines):
        raise ValidationError("Character creation rules must define every world stat exactly once")
    clean_definitions: dict[str, dict[str, Any]] = {}
    for key, definition in definitions.items():
        if not isinstance(definition, dict) or set(definition) != {"label", "minimum", "maximum", "point_cost"}:
            raise ValidationError(f"Character creation rule for {key} has unsupported or missing fields")
        label = _required_text(definition["label"], "stat label", 80)
        minimum, maximum, point_cost = definition["minimum"], definition["maximum"], definition["point_cost"]
        if any(type(value) is not int for value in (minimum, maximum, point_cost)):
            raise ValidationError("Stat bounds and point costs must be whole numbers")
        if not -10 <= minimum <= baselines[key] <= maximum <= 10:
            raise ValidationError(f"Stat bounds for {key} must contain its baseline and stay within -10 to 10")
        if not allow_below_baseline and minimum != baselines[key]:
            raise ValidationError(f"Stat minimum for {key} must equal its baseline unless below-baseline allocation is enabled")
        if not 1 <= point_cost <= 20:
            raise ValidationError("Each stat point_cost must be an integer from 1 to 20")
        clean_definitions[key] = {
            "label": label, "minimum": minimum, "maximum": maximum, "point_cost": point_cost,
        }
    return {
        "point_budget": point_budget,
        "allow_unspent_points": allow_unspent,
        "allow_below_baseline": allow_below_baseline,
        "stats": clean_definitions,
    }


def _validated_story_character_allocation(content: dict[str, Any], allocation: Any = None) -> dict[str, int]:
    baselines = _story_stat_baselines(content)
    rules = _validated_story_character_creation(content)
    if allocation is None:
        allocated = baselines
    else:
        allocated = _validated_stats(allocation)
    if set(allocated) != set(baselines):
        raise ValidationError("Character allocation must include every world stat and no extra stats")
    if rules is None:
        return allocated
    spent = 0
    for key, value in allocated.items():
        definition = rules["stats"][key]
        if not definition["minimum"] <= value <= definition["maximum"]:
            raise ValidationError(f"Allocated {key} must stay within its world-defined minimum and maximum")
        if not rules["allow_below_baseline"] and value < baselines[key]:
            raise ValidationError(f"Allocated {key} cannot be lower than its baseline")
        spent += (value - baselines[key]) * definition["point_cost"]
    if spent > rules["point_budget"]:
        raise ValidationError("Character allocation spends more points than this world provides")
    if not rules["allow_unspent_points"] and spent != rules["point_budget"]:
        raise ValidationError("Spend all character creation points or enable the world's unspent-points rule")
    return allocated


def _validated_story_current_stats(content: dict[str, Any], value: Any) -> dict[str, int]:
    stats = _validated_stats(value)
    rules = _validated_story_character_creation(content)
    baselines = _story_stat_baselines(content)
    if set(stats) != set(baselines):
        raise ValidationError("Character stats must match the pinned world version")
    if rules and any(not rules["stats"][name]["minimum"] <= score <= rules["stats"][name]["maximum"]
                     for name, score in stats.items()):
        raise ValidationError("Character stats exceed the pinned world version's stat bounds")
    return stats


def _validated_story_ability_definitions(content: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate pinned exceptional-ability definitions without inventing mechanics."""
    if "abilities" not in content:
        return []
    raw = content["abilities"]
    fields = {
        "ability_id", "name", "description", "category", "source", "activation", "deactivation",
        "effects", "costs", "cooldown_turns", "duration", "range", "magic_interactions",
        "demonstrated_capabilities", "confirmed_limitations", "unresolved_aspects",
    }
    if not isinstance(raw, list) or len(raw) > 50:
        raise ValidationError("World abilities must be an array of at most 50 definitions")
    abilities: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    text_lists = (
        "effects", "magic_interactions", "demonstrated_capabilities", "confirmed_limitations",
        "unresolved_aspects",
    )
    for item in raw:
        if not isinstance(item, dict) or set(item) != fields:
            raise ValidationError("Exceptional ability definition contains unsupported or missing fields")
        ability_id = _required_text(item["ability_id"], "ability_id", 100)
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,99}", ability_id):
            raise ValidationError("ability_id must use lowercase letters, numbers, dots, underscores, or hyphens")
        if ability_id in identifiers:
            raise ValidationError("Ability IDs must be unique in a world version")
        identifiers.add(ability_id)
        clean: dict[str, Any] = {
            "ability_id": ability_id,
            "name": _required_text(item["name"], "ability name", 120),
            "description": _required_text(item["description"], "ability description", 4000),
            "category": _required_text(item["category"], "ability category", 100),
            "source": _required_text(item["source"], "ability source", 100),
            "activation": _required_text(item["activation"], "ability activation", 1000),
            "deactivation": _required_text(item["deactivation"], "ability deactivation", 1000),
        }
        for key in text_lists:
            values = item[key]
            if not isinstance(values, list) or len(values) > 20:
                raise ValidationError(f"{key} must be an array of at most 20 text entries")
            clean[key] = [_required_text(value, key, 1000) for value in values]
        costs = item["costs"]
        if not isinstance(costs, list) or len(costs) > 10:
            raise ValidationError("Ability activation costs must be an array of at most 10 resources")
        clean_costs: list[dict[str, Any]] = []
        resources: set[str] = set()
        for cost in costs:
            if not isinstance(cost, dict) or set(cost) != {"resource", "amount"}:
                raise ValidationError("Each ability cost must define a resource and amount")
            resource = _required_text(cost["resource"], "ability cost resource", 60)
            amount = cost["amount"]
            if type(amount) is not int or not 1 <= amount <= 100_000:
                raise ValidationError("Ability activation costs must be positive whole numbers")
            if resource.casefold() in resources:
                raise ValidationError("Ability activation costs must not repeat a resource")
            resources.add(resource.casefold())
            clean_costs.append({"resource": resource, "amount": amount})
        clean["costs"] = clean_costs
        cooldown = item["cooldown_turns"]
        if cooldown is not None and (type(cooldown) is not int or not 0 <= cooldown <= 1_000_000):
            raise ValidationError("cooldown_turns must be null or a whole number from 0 to 1000000")
        clean["cooldown_turns"] = cooldown
        for key in ("duration", "range"):
            clean[key] = None if item[key] is None else _required_text(item[key], f"ability {key}", 200)
        abilities.append(clean)
    return abilities


def _initial_story_ability_states(content: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"ability_id": item["ability_id"], "is_active": False, "activation_count": 0, "ready_after_turn": 0}
        for item in _validated_story_ability_definitions(content)
    ]


def _validated_story_ability_states(content: dict[str, Any], value: Any = None) -> list[dict[str, Any]]:
    definitions = _validated_story_ability_definitions(content)
    states = _initial_story_ability_states(content) if value is None else value
    if not isinstance(states, list) or len(states) != len(definitions):
        raise ValidationError("Ability state must include exactly the abilities defined by the pinned world")
    definitions_by_id = {item["ability_id"] for item in definitions}
    clean: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in states:
        if not isinstance(item, dict) or set(item) != {"ability_id", "is_active", "activation_count", "ready_after_turn"}:
            raise ValidationError("Ability state contains unsupported or missing fields")
        ability_id = _required_text(item["ability_id"], "ability_id", 100)
        if ability_id not in definitions_by_id or ability_id in seen:
            raise ValidationError("Ability state must reference each pinned ability exactly once")
        active, activation_count, ready_after_turn = item["is_active"], item["activation_count"], item["ready_after_turn"]
        if not isinstance(active, bool) or type(activation_count) is not int or activation_count < 0:
            raise ValidationError("Ability active state and activation count are invalid")
        if type(ready_after_turn) is not int or ready_after_turn < 0:
            raise ValidationError("Ability cooldown turn must be a non-negative integer")
        seen.add(ability_id)
        clean.append({"ability_id": ability_id, "is_active": active,
                      "activation_count": activation_count, "ready_after_turn": ready_after_turn})
    clean.sort(key=lambda item: item["ability_id"])
    return clean


def _validated_story_mechanics(content: dict[str, Any]) -> dict[str, Any]:
    """Return a bounded, world-pinned mechanics profile without evaluating user formulas."""
    defaults: dict[str, Any] = {
        "mode": "d20",
        "dice": {"count": 1, "sides": 20, "resolution": "sum", "success_threshold": None,
                 "include_attribute": True},
        "difficulties": [
            {"difficulty_id": "easy", "label": "Easy", "target": 8},
            {"difficulty_id": "standard", "label": "Standard", "target": 12},
            {"difficulty_id": "hard", "label": "Hard", "target": 16},
            {"difficulty_id": "very-hard", "label": "Very hard", "target": 20},
        ],
        "encounter_types": [
            {"encounter_type": "combat", "label": "Combat"},
            {"encounter_type": "social", "label": "Social"},
            {"encounter_type": "exploration", "label": "Exploration"},
            {"encounter_type": "other", "label": "Other"},
        ],
        "skills": [],
        "experience": {"mode": "manual", "starting_xp": 0, "per_completed_turn": 0,
                        "allow_manual_awards": True, "maximum_xp": 1_000_000},
    }
    raw = content.get("game_mechanics")
    if raw is None:
        return defaults
    fields = {"mode", "dice", "difficulties", "encounter_types", "skills", "experience"}
    if not isinstance(raw, dict) or not set(raw) <= fields:
        raise ValidationError("game_mechanics must be an object with supported mechanics fields")
    profile = {**defaults, **raw}
    mode = profile["mode"]
    if not isinstance(mode, str) or mode not in {"d20", "custom_dice", "narrative_only", "hybrid"}:
        raise ValidationError("game_mechanics.mode must be d20, custom_dice, narrative_only, or hybrid")
    dice = profile["dice"]
    dice_fields = {"count", "sides", "resolution", "success_threshold", "include_attribute"}
    if not isinstance(dice, dict) or set(dice) != dice_fields:
        raise ValidationError("game_mechanics.dice contains unsupported or missing fields")
    count, sides, resolution = dice["count"], dice["sides"], dice["resolution"]
    threshold, include_attribute = dice["success_threshold"], dice["include_attribute"]
    if type(count) is not int or not 1 <= count <= 20:
        raise ValidationError("game_mechanics dice count must be from 1 to 20")
    if type(sides) is not int or not 2 <= sides <= 100:
        raise ValidationError("game_mechanics die sides must be from 2 to 100")
    if not isinstance(resolution, str) or resolution not in {"sum", "highest", "success_count"}:
        raise ValidationError("game_mechanics resolution must be sum, highest, or success_count")
    if resolution == "success_count":
        if type(threshold) is not int or not 1 <= threshold <= sides:
            raise ValidationError("success_count needs a success_threshold within the die range")
    elif threshold is not None:
        raise ValidationError("success_threshold is only valid for success_count resolution")
    if not isinstance(include_attribute, bool):
        raise ValidationError("game_mechanics.include_attribute must be a boolean")
    if mode == "d20" and (count, sides, resolution, threshold, include_attribute) != (1, 20, "sum", None, True):
        raise ValidationError("d20 mode requires one d20 plus its selected attribute")
    clean_dice = {"count": count, "sides": sides, "resolution": resolution,
                  "success_threshold": threshold, "include_attribute": include_attribute}

    raw_difficulties = profile["difficulties"]
    if not isinstance(raw_difficulties, list) or not 1 <= len(raw_difficulties) <= 20:
        raise ValidationError("game_mechanics needs between 1 and 20 difficulty rules")
    difficulties = []
    difficulty_ids: set[str] = set()
    for item in raw_difficulties:
        if not isinstance(item, dict) or set(item) != {"difficulty_id", "label", "target"}:
            raise ValidationError("Each difficulty must define an ID, label, and target")
        difficulty_id = _required_text(item["difficulty_id"], "difficulty_id", 60)
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,59}", difficulty_id) or difficulty_id in difficulty_ids:
            raise ValidationError("Difficulty IDs must be unique lowercase identifiers")
        target = item["target"]
        if type(target) is not int or not 1 <= target <= 2000:
            raise ValidationError("Difficulty targets must be whole numbers from 1 to 2000")
        difficulty_ids.add(difficulty_id)
        difficulties.append({"difficulty_id": difficulty_id,
                             "label": _required_text(item["label"], "difficulty label", 80),
                             "target": target})

    raw_encounters = profile["encounter_types"]
    if not isinstance(raw_encounters, list) or not 1 <= len(raw_encounters) <= 20:
        raise ValidationError("game_mechanics needs between 1 and 20 encounter types")
    encounter_types = []
    encounter_ids: set[str] = set()
    for item in raw_encounters:
        if not isinstance(item, dict) or set(item) != {"encounter_type", "label"}:
            raise ValidationError("Each encounter type must define an identifier and label")
        encounter_id = _required_text(item["encounter_type"], "encounter_type", 80)
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,79}", encounter_id) or encounter_id in encounter_ids:
            raise ValidationError("Encounter type IDs must be unique lowercase identifiers")
        encounter_ids.add(encounter_id)
        encounter_types.append({"encounter_type": encounter_id,
                                "label": _required_text(item["label"], "encounter label", 100)})

    raw_skills = profile["skills"]
    if not isinstance(raw_skills, list) or len(raw_skills) > 100:
        raise ValidationError("game_mechanics.skills must contain at most 100 skills")
    stats = _story_stat_baselines(content)
    skills = []
    skill_ids: set[str] = set()
    for item in raw_skills:
        skill_fields = {"skill_id", "label", "attribute", "starting_rank", "max_rank", "rank_bonus"}
        if not isinstance(item, dict) or set(item) != skill_fields:
            raise ValidationError("Each skill must define an ID, label, attribute, starting rank, maximum rank, and rank bonus")
        skill_id = _required_text(item["skill_id"], "skill_id", 80)
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,79}", skill_id) or skill_id in skill_ids:
            raise ValidationError("Skill IDs must be unique lowercase identifiers")
        attribute = item["attribute"]
        if attribute is not None:
            if not isinstance(attribute, str):
                raise ValidationError("Skill attribute must reference a world stat or be null")
            attribute = next((key for key in stats if key.casefold() == attribute.casefold()), None)
            if attribute is None:
                raise ValidationError("Skill attribute must reference a stat in the same world version")
        starting_rank, max_rank, rank_bonus = item["starting_rank"], item["max_rank"], item["rank_bonus"]
        if any(type(value) is not int for value in (starting_rank, max_rank, rank_bonus)) \
                or not 0 <= starting_rank <= max_rank <= 20 or not 0 <= rank_bonus <= 100:
            raise ValidationError("Skill ranks must be bounded whole numbers and rank_bonus must be 0 to 100")
        skill_ids.add(skill_id)
        skills.append({"skill_id": skill_id, "label": _required_text(item["label"], "skill label", 100),
                       "attribute": attribute, "starting_rank": starting_rank,
                       "max_rank": max_rank, "rank_bonus": rank_bonus})

    experience = profile["experience"]
    experience_fields = {"mode", "starting_xp", "per_completed_turn", "allow_manual_awards", "maximum_xp"}
    if not isinstance(experience, dict) or set(experience) != experience_fields:
        raise ValidationError("game_mechanics.experience contains unsupported or missing fields")
    xp_mode, starting_xp = experience["mode"], experience["starting_xp"]
    auto_xp, manual_awards, maximum_xp = (experience["per_completed_turn"],
                                           experience["allow_manual_awards"], experience["maximum_xp"])
    if not isinstance(xp_mode, str) or xp_mode not in {"manual", "automatic", "hybrid"}:
        raise ValidationError("Experience mode must be manual, automatic, or hybrid")
    if any(type(value) is not int for value in (starting_xp, auto_xp, maximum_xp)) \
            or not 0 <= starting_xp <= maximum_xp <= 1_000_000_000 or not 0 <= auto_xp <= 1_000_000:
        raise ValidationError("Experience values exceed their non-negative bounds")
    if not isinstance(manual_awards, bool):
        raise ValidationError("allow_manual_awards must be a boolean")
    if (xp_mode == "manual" and (auto_xp != 0 or not manual_awards) \
            or xp_mode == "automatic" and (auto_xp <= 0 or manual_awards) \
            or xp_mode == "hybrid" and (auto_xp <= 0 or not manual_awards)):
        raise ValidationError("Experience mode must match its explicit automatic and manual award rules")
    return {"mode": mode, "dice": clean_dice, "difficulties": difficulties,
            "encounter_types": encounter_types, "skills": skills,
            "experience": {"mode": xp_mode, "starting_xp": starting_xp,
                           "per_completed_turn": auto_xp, "allow_manual_awards": manual_awards,
                           "maximum_xp": maximum_xp}}


def _initial_story_skill_ranks(content: dict[str, Any]) -> dict[str, int]:
    return {item["skill_id"]: item["starting_rank"]
            for item in _validated_story_mechanics(content)["skills"]}


def _validated_story_skill_ranks(content: dict[str, Any], value: Any = None) -> dict[str, int]:
    skills = _validated_story_mechanics(content)["skills"]
    ranks = _initial_story_skill_ranks(content) if value is None else value
    if not isinstance(ranks, dict) or set(ranks) != {item["skill_id"] for item in skills}:
        raise ValidationError("Character skills must match the skills in the pinned world version")
    definitions = {item["skill_id"]: item for item in skills}
    clean: dict[str, int] = {}
    for skill_id, rank in ranks.items():
        if type(rank) is not int or not 0 <= rank <= definitions[skill_id]["max_rank"]:
            raise ValidationError("Character skill rank exceeds its pinned world rule")
        clean[skill_id] = rank
    return clean


def _validated_experience_state(value: Any = None) -> dict[str, int]:
    state = {"manual_awards": 0} if value is None else value
    if not isinstance(state, dict) or set(state) != {"manual_awards"}:
        raise ValidationError("Experience state contains unsupported or missing fields")
    awards = state["manual_awards"]
    if type(awards) is not int or not 0 <= awards <= 1_000_000_000:
        raise ValidationError("Manual experience awards must be a bounded non-negative integer")
    return {"manual_awards": awards}


def _story_experience_summary(
    mechanics: dict[str, Any], state: dict[str, int], completed_turns: int,
) -> dict[str, int | str]:
    rules = mechanics["experience"]
    automatic = min(
        rules["maximum_xp"] - rules["starting_xp"],
        completed_turns * rules["per_completed_turn"],
    )
    total = min(rules["maximum_xp"], rules["starting_xp"] + automatic + state["manual_awards"])
    return {
        "mode": rules["mode"], "starting_xp": rules["starting_xp"],
        "automatic_xp": automatic, "manual_awards": state["manual_awards"],
        "total_xp": total, "maximum_xp": rules["maximum_xp"],
        "per_completed_turn": rules["per_completed_turn"], "completed_turns": completed_turns,
    }


def _resolve_story_mechanics_check(
    mechanics: dict[str, Any], stats: dict[str, int], skill_ranks: dict[str, int], payload: dict[str, Any],
) -> dict[str, Any]:
    if mechanics["mode"] == "narrative_only":
        raise ValidationError("This world uses narrative-only resolution and does not permit dice checks")
    encounter_type = _required_text(payload.get("encounter_type"), "encounter_type", 80)
    if encounter_type not in {item["encounter_type"] for item in mechanics["encounter_types"]}:
        raise ValidationError("Encounter type is not defined by this adventure's pinned world version")
    difficulty_id = _required_text(payload.get("difficulty_id"), "difficulty_id", 60)
    difficulty = next((item for item in mechanics["difficulties"] if item["difficulty_id"] == difficulty_id), None)
    if difficulty is None:
        raise ValidationError("Difficulty is not defined by this adventure's pinned world version")

    requested_stat = payload.get("stat_name")
    if requested_stat is not None and not isinstance(requested_stat, str):
        raise ValidationError("stat_name must be a character stat or null")
    canonical_stat = next((name for name in stats if requested_stat and name.casefold() == requested_stat.casefold()), None)
    if requested_stat and canonical_stat is None:
        raise ValidationError("Choose a stat on this adventure's character sheet")
    skill_id = payload.get("skill_id")
    skill = None
    skill_rank = 0
    skill_bonus = 0
    if skill_id is not None:
        skill_id = _required_text(skill_id, "skill_id", 80)
        skill = next((item for item in mechanics["skills"] if item["skill_id"] == skill_id), None)
        if skill is None:
            raise ValidationError("Skill is not defined by this adventure's pinned world version")
        skill_rank = skill_ranks[skill_id]
        skill_bonus = skill_rank * skill["rank_bonus"]
        if skill["attribute"]:
            if canonical_stat and canonical_stat != skill["attribute"]:
                raise ValidationError("Selected stat conflicts with the skill's pinned governing attribute")
            canonical_stat = skill["attribute"]

    dice_rules = mechanics["dice"]
    rolls = payload.get("dice_rolls")
    if not isinstance(rolls, list) or len(rolls) != dice_rules["count"]:
        raise ValidationError("Dice results must match the pinned dice count")
    if any(type(roll) is not int or not 1 <= roll <= dice_rules["sides"] for roll in rolls):
        raise ValidationError("Dice results must fall within the pinned die range")
    if dice_rules["resolution"] == "sum":
        dice_total = sum(rolls)
    elif dice_rules["resolution"] == "highest":
        dice_total = max(rolls)
    else:
        dice_total = sum(roll >= dice_rules["success_threshold"] for roll in rolls)

    attribute_modifier = stats[canonical_stat] if canonical_stat and dice_rules["include_attribute"] else 0
    if dice_rules["include_attribute"] and not canonical_stat and not skill:
        raise ValidationError("Choose a stat or skill for this check")
    modifier = attribute_modifier + skill_bonus
    total = dice_total + modifier
    target = difficulty["target"]
    return {
        "encounter_type": encounter_type, "difficulty_id": difficulty_id,
        "stat_name": canonical_stat or "", "skill_id": skill_id,
        "dice_rolls": rolls, "resolution": dice_rules["resolution"],
        "modifier": modifier, "total": total, "target": target,
        "outcome": "success" if total >= target else "failure",
        "rules": {
            "mode": mechanics["mode"], "dice": dice_rules, "difficulty": difficulty,
            "encounter_type": next(item for item in mechanics["encounter_types"]
                                    if item["encounter_type"] == encounter_type),
            "stat_name": canonical_stat or "", "stat_value": stats.get(canonical_stat, 0),
            "attribute_modifier": attribute_modifier, "skill_id": skill_id,
            "skill_definition": skill, "skill_rank": skill_rank, "skill_bonus": skill_bonus,
        },
    }


def _validated_story_mechanic_check(check: Any, mechanics: dict[str, Any]) -> dict[str, Any]:
    fields = {"check_id", "encounter_type", "stat_name", "skill_id", "dice_rolls", "resolution",
              "modifier", "total", "target", "difficulty_id", "outcome", "rules", "created_at"}
    if not isinstance(check, dict) or set(check) != fields:
        raise ValidationError("Mechanic check contains unsupported or missing fields")
    check_id = _required_text(check["check_id"], "check_id", 100)
    payload = {
        "encounter_type": check["encounter_type"], "difficulty_id": check["difficulty_id"],
        "stat_name": check["stat_name"] or None, "skill_id": check["skill_id"],
        "dice_rolls": check["dice_rolls"],
    }
    rules = check["rules"]
    rule_fields = {"mode", "dice", "difficulty", "encounter_type", "stat_name", "stat_value",
                   "attribute_modifier", "skill_id", "skill_definition", "skill_rank", "skill_bonus"}
    if not isinstance(rules, dict) or set(rules) != rule_fields:
        raise ValidationError("Mechanic check rules snapshot contains unsupported or missing fields")
    if rules["mode"] != mechanics["mode"] or rules["dice"] != mechanics["dice"]:
        raise ValidationError("Mechanic check dice rules do not match the pinned world version")
    expected_difficulty = next((item for item in mechanics["difficulties"]
                                if item["difficulty_id"] == check["difficulty_id"]), None)
    expected_encounter = next((item for item in mechanics["encounter_types"]
                               if item["encounter_type"] == check["encounter_type"]), None)
    if rules["difficulty"] != expected_difficulty or rules["encounter_type"] != expected_encounter:
        raise ValidationError("Mechanic check target or encounter rules do not match the pinned world version")

    if not isinstance(rules["stat_name"], str) or type(rules["stat_value"]) is not int:
        raise ValidationError("Mechanic check stat snapshot is invalid")
    stats = {rules["stat_name"]: rules["stat_value"]} if rules["stat_name"] else {}
    if ((stats and not -10 <= rules["stat_value"] <= 10) or (not stats and rules["stat_value"] != 0)
            or any(type(rules[field]) is not int for field in ("attribute_modifier", "skill_rank", "skill_bonus"))):
        raise ValidationError("Mechanic check stat snapshot is invalid")
    skill_ranks: dict[str, int] = {}
    if rules["skill_id"] is not None:
        skill_id = _required_text(rules["skill_id"], "skill_id", 80)
        definition = next((item for item in mechanics["skills"] if item["skill_id"] == skill_id), None)
        rank = rules["skill_rank"]
        if (definition is None or rules["skill_definition"] != definition or type(rank) is not int
                or not 0 <= rank <= definition["max_rank"]):
            raise ValidationError("Mechanic check skill snapshot is invalid")
        skill_ranks[skill_id] = rank
    elif rules["skill_definition"] is not None or rules["skill_rank"] != 0:
        raise ValidationError("Mechanic check has an unexpected skill snapshot")
    expected = _resolve_story_mechanics_check(mechanics, stats, skill_ranks, payload)
    if (rules != expected["rules"] or check["resolution"] != expected["resolution"]
            or check["modifier"] != expected["modifier"] or check["total"] != expected["total"]
            or check["target"] != expected["target"] or check["outcome"] != expected["outcome"]):
        raise ValidationError("Mechanic check math does not match its recorded rules snapshot")
    return {
        "check_id": check_id, "encounter_type": expected["encounter_type"],
        "stat_name": expected["stat_name"], "skill_id": expected["skill_id"],
        "dice_rolls": expected["dice_rolls"], "resolution": expected["resolution"],
        "modifier": expected["modifier"], "total": expected["total"],
        "target": expected["target"], "difficulty_id": expected["difficulty_id"],
        "outcome": expected["outcome"], "rules": expected["rules"],
        "created_at": _package_time(check["created_at"], "mechanic check created_at"),
    }


def _validated_import_archive(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"format", "version", "filename", "data"}:
        raise ValidationError("Adventure source archive has an unsupported shape")
    if value["format"] != "mno-adv" or type(value["version"]) is not int or value["version"] != 2:
        raise ValidationError("Unsupported preserved source archive format")
    filename = value["filename"]
    if filename is not None and (not isinstance(filename, str) or len(filename) > 255 or any(char in filename for char in ("/", "\\", "\x00"))):
        raise ValidationError("Source archive filename is invalid")
    source = value["data"]
    if not isinstance(source, dict):
        raise ValidationError("Source archive data must be a JSON object")
    try:
        if len(_json(source).encode("utf-8")) > 10_000_000:
            raise ValidationError("Adventure source archive is limited to 10 MB")
    except (TypeError, ValueError, RecursionError) as error:
        raise ValidationError("Source archive must contain valid JSON") from error
    _validated_world_content(source, max_bytes=10_000_000, label="Adventure source archive")
    return {"format": "mno-adv", "version": 2, "filename": filename, "data": source}


def validate_world_package(package: Any) -> dict[str, Any]:
    """Validate a portable world package and upcast the legacy v1 format."""
    if not isinstance(package, dict):
        raise ValidationError("Unsupported world package format or version")
    protocol = package.get("protocol")
    legacy = protocol == "lke.world.v1"
    if protocol not in {"lke.world.v1", "lke.world.v2"}:
        raise ValidationError("Unsupported world package format or version")
    expected_fields = {"protocol", "provenance", "versions"} | (set() if legacy else {"manifest"})
    if set(package) != expected_fields:
        raise ValidationError("World package contains unsupported fields")
    if _package_size_bytes(package) > 2_000_000:
        raise ValidationError("World package is limited to 2 MB")
    manifest = None if legacy else _validated_package_manifest(package)
    if manifest and manifest["assets"]:
        raise ValidationError("World package manifest cannot contain adventure assets")
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
        content = _validated_world_content(item.get("content"))
        opening_scene = _validated_story_opening_scene(content)
        if opening_scene is not None:
            content["opening_scene"] = opening_scene
        _validated_story_world_locations(content)
        _validated_story_character_creation(content)
        _validated_story_ability_definitions(content)
        _validated_story_mechanics(content)
        clean.append({
            "version": number,
            "name": _required_text(item.get("name"), "world name", 200),
            "description": description.strip(),
            "template_key": _required_text(item.get("template_key"), "template_key", 60),
            "content": content,
        })
    canonical = {"protocol": "lke.world.v2",
                 "provenance": {"workspace_id": source_workspace, "world_id": source_world},
                 "versions": clean}
    canonical["manifest"] = _new_package_manifest(canonical)
    return canonical


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


def _package_choice(value: Any, choices: set[str], field: str) -> str:
    if not isinstance(value, str) or value not in choices:
        raise ValidationError(f"{field} is unsupported")
    return value


def _validate_image_content(mime_type: str, content: bytes) -> None:
    """Fully decode a bounded static image before it enters the canonical store."""
    from PIL import Image

    expected_format = {
        "image/png": "PNG",
        "image/jpeg": "JPEG",
        "image/webp": "WEBP",
    }.get(mime_type)
    if not expected_format:
        raise ValidationError("Only PNG, JPEG, and WebP images are supported")
    max_pixels = 20_000_000
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content), formats=[expected_format]) as image:
                if image.format != expected_format:
                    raise ValidationError("Story image bytes do not match the declared file type")
                width, height = image.size
                if width < 1 or height < 1 or width * height > max_pixels:
                    raise ValidationError("Story images may not exceed 20 million pixels")
                if getattr(image, "is_animated", False) or getattr(image, "n_frames", 1) != 1:
                    raise ValidationError("Animated story images are not supported")
                image.verify()
            with Image.open(io.BytesIO(content), formats=[expected_format]) as image:
                if image.size != (width, height):
                    raise ValidationError("Story image dimensions are inconsistent")
                image.load()
    except ValidationError:
        raise
    except Exception as error:
        raise ValidationError("Story image must be complete and decodable as its declared file type") from error


def validate_adventure_package(package: Any) -> dict[str, Any]:
    """Validate an adventure package, migrating legacy v1 data into checksummed v2."""
    if not isinstance(package, dict):
        raise ValidationError("Adventure package contains unsupported or missing fields")
    protocol = package.get("protocol")
    legacy = protocol == "lke.adventure.v1"
    if protocol not in {"lke.adventure.v1", "lke.adventure.v2"}:
        raise ValidationError("Unsupported adventure package format or version")
    root_fields = {"protocol", "provenance", "world", "context_manifests_included", "adventure"}
    if not legacy:
        root_fields.add("manifest")
    root = _package_object(package, root_fields, "Adventure package")
    if _package_size_bytes(root) > 10_000_000:
        raise ValidationError("Adventure package is limited to 10 MB")
    manifest = None if legacy else _validated_package_manifest(root)
    if root["context_manifests_included"] is not False:
        raise ValidationError("Adventure packages must omit historical context manifests")

    provenance = _package_object(root["provenance"], {"workspace_id", "branch_id", "adventure_id", "exported_at"}, "Adventure provenance")
    clean_provenance = {
        "workspace_id": _required_text(provenance["workspace_id"], "source workspace_id", 100),
        "branch_id": _required_text(provenance["branch_id"], "source branch_id", 100),
        "adventure_id": _required_text(provenance["adventure_id"], "source adventure_id", 100),
        "exported_at": _package_time(provenance["exported_at"], "exported_at"),
    }


    world = validate_world_package(root["world"])
    adventure_fields = {"name", "world_version", "status", "completed_turns", "npc_simulation_enabled", "actor_entity_id", "entities",
                        "conversation", "sheet", "turns", "turn_edits", "checks", "proposals", "memories", "threads",
                        "npcs", "assets", "locations"}
    adventure = root["adventure"]
    optional_adventure_fields = {"source_archive", "mechanic_checks"}
    if not isinstance(adventure, dict) or not adventure_fields <= set(adventure) <= adventure_fields | optional_adventure_fields:
        raise ValidationError("Adventure data contains unsupported or missing fields")
    source_archive = _validated_import_archive(adventure.get("source_archive"))
    name = _required_text(adventure["name"], "adventure name", 200)
    world_version = adventure["world_version"]
    if type(world_version) is not int or not 1 <= world_version <= len(world["versions"]):
        raise ValidationError("Adventure world_version must reference a packaged world version")
    status = _package_choice(adventure["status"], {"active", "complete", "paused"}, "Adventure status")
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
        entity_type = _required_text(entity["entity_type"], "entity_type", 100)
        properties = _validated_entity_properties(entity["properties"])
        if "character_profile" in properties and entity_type not in {"character", "person"}:
            raise ValidationError("character_profile must belong to a character")
        clean_entities.append({
            "entity_id": entity_id,
            "entity_type": entity_type,
            "label": _required_text(entity["label"], "entity label", 200),
            "properties": _validated_world_content(properties),
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
    sheet_fields = {"stats", "trackers", "current_location"}
    map_fields = {"map_region", "map_x", "map_y", "map_scale"}
    sheet = adventure["sheet"]
    optional_sheet_fields = map_fields | {"ability_states", "skill_ranks", "experience"}
    if not isinstance(sheet, dict) or not sheet_fields <= set(sheet) <= sheet_fields | optional_sheet_fields:
        raise ValidationError("Character sheet contains unsupported or missing fields")
    pinned_world_content = world["versions"][world_version - 1]["content"]
    map_region = sheet.get("map_region", "")
    map_scale = sheet.get("map_scale", "regional")
    map_x, map_y = sheet.get("map_x"), sheet.get("map_y")
    if not isinstance(map_region, str) or len(map_region) > 200:
        raise ValidationError("map_region must be text of at most 200 characters")
    if not isinstance(map_scale, str) or not map_scale.strip() or len(map_scale) > 40:
        raise ValidationError("map_scale must be non-empty text of at most 40 characters")
    for coordinate in (map_x, map_y):
        if coordinate is not None and (type(coordinate) not in (int, float) or abs(coordinate) > 1_000_000):
            raise ValidationError("Map coordinates must be numbers between -1000000 and 1000000")
    clean_sheet = {
        "stats": _validated_story_current_stats(pinned_world_content, sheet["stats"]),
        "trackers": _validated_trackers(sheet["trackers"]),
        "current_location": sheet["current_location"],
        "ability_states": _validated_story_ability_states(pinned_world_content, sheet.get("ability_states")),
        "skill_ranks": _validated_story_skill_ranks(pinned_world_content, sheet.get("skill_ranks")),
        "experience": _validated_experience_state(sheet.get("experience")),
        "map_region": map_region,
        "map_x": map_x,
        "map_y": map_y,
        "map_scale": map_scale.strip(),
    }
    if not isinstance(clean_sheet["current_location"], str) or len(clean_sheet["current_location"]) > 200:
        raise ValidationError("current_location must be text of at most 200 characters")

    turn_fields = {"turn_id", "turn_order", "role", "narrative_order", "content", "provider", "model", "created_at"}
    turns = adventure["turns"]
    if not isinstance(turns, list) or len(turns) > 10_000:
        raise ValidationError("turns must be an array of at most 10000 records")
    clean_turns: list[dict[str, Any]] = []
    turn_ids: set[str] = set()
    turn_orders: set[int] = set()
    for turn in turns:
        if not isinstance(turn, dict) or set(turn) not in (turn_fields, turn_fields | {"metadata"}):
            raise ValidationError("Turn record contains unsupported or missing fields")
        turn_id = _required_text(turn["turn_id"], "turn_id", 100)
        order, narrative_order = turn["turn_order"], turn["narrative_order"]
        if turn_id in turn_ids or type(order) is not int or order < 0 or order in turn_orders:
            raise ValidationError("Turn IDs and non-negative turn_order values must be unique")
        role = _package_choice(turn["role"], {"user", "assistant"}, "Turn role")
        if type(narrative_order) is not int or narrative_order < 0:
            raise ValidationError("Turn role and narrative order are invalid")
        content = _required_text(turn["content"], "turn content", 200_000)
        provider = _package_optional_text(turn["provider"], "provider", 100)
        model = _package_optional_text(turn["model"], "model", 200)
        metadata = turn.get("metadata")
        if metadata is not None:
            if not isinstance(metadata, dict) or len(_json(metadata).encode("utf-8")) > 20_000:
                raise ValidationError("Turn metadata must be an object of at most 20 KB")
            _validated_world_content(metadata)
            if source_archive is None or metadata.get("source_format") != "mno-adv":
                raise ValidationError("Imported turn metadata requires a preserved MNO adventure source")
            source_role = metadata.get("source_role")
            if source_role not in {"narrator", "npc", "action", "check", "thought", "meta"}:
                raise ValidationError("Imported MNO turn has an unsupported source role")
            if (role == "user") != (source_role == "action"):
                raise ValidationError("Imported MNO role does not match the transcript turn role")
            if metadata.get("context_excluded") is not (source_role in {"thought", "meta"}):
                raise ValidationError("Imported inner thoughts and meta turns must stay out of model context")
        if role == "user" and (provider is not None or model is not None):
            raise ValidationError("User turns cannot contain provider metadata")
        if role == "assistant" and not (
            provider is None and model is None
        ) and (provider not in _ALLOWED_STORY_PROVIDERS or model is None):
            raise ValidationError("Assistant turns need supported provider metadata")
        clean_turns.append({
            "turn_id": turn_id, "turn_order": order, "role": role,
            "narrative_order": narrative_order, "content": content,
            "provider": provider,
            "model": model,
            "metadata": metadata,
            "created_at": _package_time(turn["created_at"], "turn created_at"),
        })
        turn_ids.add(turn_id)
        turn_orders.add(order)
    clean_turns.sort(key=lambda turn: turn["turn_order"])
    if turn_orders and turn_orders != set(range(len(turn_orders))):
        raise ValidationError("turn_order values must be contiguous and start at zero")
    if completed_turns != sum(turn["role"] == "user" for turn in clean_turns):
        raise ValidationError("completed_turns must match the saved player turns")

    edits = _package_list(adventure["turn_edits"], {"turn_id", "version", "content", "status", "provider", "model", "created_at"}, "turn_edits")
    clean_edits: list[dict[str, Any]] = []
    edit_versions: dict[str, list[int]] = {}
    for edit in edits:
        turn_id, version = _required_text(edit["turn_id"], "edited turn_id", 100), edit["version"]
        edit_status = _package_choice(edit["status"], {"active", "deleted", "superseded"}, "Turn edit status")
        if turn_id not in turn_ids or type(version) is not int or version < 1:
            raise ValidationError("Turn edit references an invalid turn, version, or status")
        clean_edits.append({
            "turn_id": turn_id, "version": version,
            "content": _required_text(edit["content"], "edited turn content", 200_000),
            "status": edit_status, "provider": _package_optional_text(edit["provider"], "provider", 100),
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

    raw_mechanic_checks = adventure.get("mechanic_checks", [])
    if not isinstance(raw_mechanic_checks, list) or len(raw_mechanic_checks) > 10_000:
        raise ValidationError("mechanic_checks must be an array of at most 10000 records")
    mechanics = _validated_story_mechanics(pinned_world_content)
    if clean_checks and "game_mechanics" in pinned_world_content and (
        mechanics["mode"] not in {"d20", "hybrid"}
        or mechanics["dice"] != {"count": 1, "sides": 20, "resolution": "sum",
                                 "success_threshold": None, "include_attribute": True}
    ):
        raise ValidationError("Legacy d20 results do not match this adventure's pinned mechanics")
    clean_mechanic_checks = []
    mechanic_check_ids: set[str] = set()
    for check in raw_mechanic_checks:
        clean_check = _validated_story_mechanic_check(check, mechanics)
        if clean_check["check_id"] in check_ids or clean_check["check_id"] in mechanic_check_ids:
            raise ValidationError("Mechanic check IDs must be unique across an adventure")
        mechanic_check_ids.add(clean_check["check_id"])
        clean_mechanic_checks.append(clean_check)

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
        proposal_status = _package_choice(proposal["review_status"], {"proposed", "accepted", "rejected"}, "Proposal review status")
        if proposal_id in proposal_ids:
            raise ValidationError("Proposal ID or review status is invalid")
        clean_changes = _validated_rpg_changes(proposal["changes"])
        for change in clean_changes:
            if change["operation"] == "npc_profile" and change["npc_entity_id"] not in entity_ids:
                raise ValidationError("NPC proposal references an entity missing from the package")
            if change["operation"] == "add_event_memory" and not set(change["known_by"]) <= entity_ids:
                raise ValidationError("Memory proposal references a character missing from the package")
        clean_proposals.append({"proposal_id": proposal_id, "source_turn_id": source_turn,
                                "changes": clean_changes, "review_status": proposal_status,
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
        if not isinstance(known_by, list) or any(
            not isinstance(item, str) or item not in entity_ids
            or next(entity for entity in clean_entities if entity["entity_id"] == item)["entity_type"] not in {"character", "person"}
            for item in known_by
        ):
            raise ValidationError("Memory knowledge holders must reference packaged characters")
        if type(version) is not int or version < 1 or type(memory["narrative_order"]) is not int or memory["narrative_order"] < 0:
            raise ValidationError("Memory version and narrative order must be non-negative integers")
        memory_kind = _package_choice(memory["kind"], {"note", "event", "situation"}, "Memory type")
        memory_status = _package_choice(memory["review_status"], {"proposed", "accepted", "rejected"}, "Memory review status")
        if not isinstance(memory["context_enabled"], bool) or type(memory["importance"]) is not int or not 1 <= memory["importance"] <= 5:
            raise ValidationError("Memory context setting or importance is invalid")
        knowledge_scope = _package_choice(memory["knowledge_scope"], {"shared", "actors", "author", "private"}, "Memory knowledge scope")
        if (knowledge_scope == "actors") != bool(known_by):
            raise ValidationError("Actor-scoped memory must name its knowledge holders")
        supersedes = memory["supersedes_version"]
        if supersedes is not None and (type(supersedes) is not int or supersedes < 1 or supersedes >= version):
            raise ValidationError("Memory supersession reference is invalid")
        clean_memories.append({"memory_id": memory_id, "version": version, "kind": memory_kind,
                               "content": _required_text(memory["content"], "memory content", 4000),
                               "context_enabled": memory["context_enabled"], "review_status": memory_status,
                               "source_turn_id": source_turn, "narrative_order": memory["narrative_order"],
                               "supersedes_version": supersedes, "importance": memory["importance"],
                               "knowledge_scope": knowledge_scope, "known_by": list(dict.fromkeys(known_by)),
                               "created_at": _package_time(memory["created_at"], "memory created_at")})
        memory_versions.setdefault(memory_id, []).append(version)
    for versions in memory_versions.values():
        if sorted(versions) != list(range(1, len(versions) + 1)):
            raise ValidationError("Memory versions must be contiguous and start at one")

    threads = _package_list(adventure["threads"], {"thread_id", "title", "detail", "status", "created_at", "updated_at"}, "threads")
    clean_threads: list[dict[str, Any]] = []
    thread_ids: set[str] = set()
    for thread in threads:
        thread_id = _required_text(thread["thread_id"], "thread_id", 100)
        thread_status = _package_choice(thread["status"], {"open", "closed"}, "Thread status")
        if thread_id in thread_ids:
            raise ValidationError("Thread IDs must be unique")
        detail = thread["detail"]
        if not isinstance(detail, str) or len(detail) > 2000:
            raise ValidationError("Thread detail is limited to 2000 characters")
        clean_threads.append({"thread_id": thread_id,
                              "title": _required_text(thread["title"], "thread title", 200), "detail": detail,
                              "status": thread_status, "created_at": _package_time(thread["created_at"], "thread created_at"),
                              "updated_at": _package_time(thread["updated_at"], "thread updated_at")})
        thread_ids.add(thread_id)

    npcs = _package_list(adventure["npcs"], {"npc_entity_id", "aliases", "public_profile", "private_profile", "review_status", "created_at", "updated_at"}, "npcs", 500)
    clean_npcs: list[dict[str, Any]] = []
    npc_ids: set[str] = set()
    for npc in npcs:
        npc_id = _required_text(npc["npc_entity_id"], "npc_entity_id", 100)
        aliases = npc["aliases"]
        npc_entity = next((entity for entity in clean_entities if entity["entity_id"] == npc_id), None)
        if (
            not npc_entity or npc_entity["entity_type"] not in {"character", "person"}
            or npc_id == actor_entity_id or npc_id in npc_ids
        ):
            raise ValidationError("NPC profile must reference a separate packaged character")
        if not isinstance(aliases, list) or len(aliases) > 50:
            raise ValidationError("NPC aliases must be an array of at most 50 names")
        clean_aliases = [_required_text(alias, "NPC alias", 100) for alias in aliases]
        npc_status = _package_choice(npc["review_status"], {"proposed", "accepted", "rejected"}, "NPC review status")
        clean_npcs.append({"npc_entity_id": npc_id, "aliases": clean_aliases,
                           "public_profile": _validated_world_content(npc["public_profile"]),
                           "private_profile": _validated_world_content(npc["private_profile"]),
                           "review_status": npc_status,
                           "created_at": _package_time(npc["created_at"], "NPC created_at"),
                           "updated_at": _package_time(npc["updated_at"], "NPC updated_at")})
        npc_ids.add(npc_id)

    assets = _package_list(adventure["assets"], {"asset_id", "target_kind", "target_id", "display_name", "mime_type", "data_base64", "provenance", "created_at"}, "assets", 500)
    clean_assets: list[dict[str, Any]] = []
    asset_ids: set[str] = set()
    for asset in assets:
        asset_id = _required_text(asset["asset_id"], "asset_id", 100)
        target_kind = _package_choice(asset["target_kind"], {"character", "scene"}, "Story asset target")
        mime_type = _package_choice(asset["mime_type"], {"image/png", "image/jpeg", "image/webp"}, "Story asset media type")
        if asset_id in asset_ids:
            raise ValidationError("Story asset IDs must be unique")
        target_id = _required_text(asset["target_id"], "asset target_id", 100)
        if target_kind == "character" and target_id not in entity_ids:
            raise ValidationError("Character asset target is missing from the package")
        try:
            content = base64.b64decode(_required_text(asset["data_base64"], "asset data", 7_000_000), validate=True)
        except (ValueError, binascii.Error) as error:
            raise ValidationError("Story asset data must be valid base64") from error
        if not 1 <= len(content) <= 5_242_880:
            raise ValidationError("Each story asset must contain between 1 byte and 5 MB")
        _validate_image_content(mime_type, content)
        if target_kind == "scene" and not any(
            turn["turn_id"] == target_id and turn["role"] == "assistant" for turn in clean_turns
        ):
            raise ValidationError("Scene asset target must be an assistant turn in the adventure")
        clean_assets.append({"asset_id": asset_id,
                             "target_kind": target_kind,
                             "target_id": target_id,
                             "display_name": _required_text(asset["display_name"], "asset display_name", 200),
                             "mime_type": mime_type, "content": content,
                             "provenance": _validated_world_content(asset["provenance"]),
                             "created_at": _package_time(asset["created_at"], "asset created_at")})
        asset_ids.add(asset_id)

    location_fields = {"location_id", "name", "status", "source_proposal_id", "created_at"}
    extended_location_fields = location_fields | {"location_type", "description", "icon", "x", "y"}
    locations = adventure["locations"]
    if not isinstance(locations, list) or len(locations) > 1000:
        raise ValidationError("locations must be an array of at most 1000 records")
    clean_locations: list[dict[str, Any]] = []
    location_names: set[str] = set()
    location_ids: set[str] = set()
    for location in locations:
        if not isinstance(location, dict) or set(location) not in (location_fields, extended_location_fields):
            raise ValidationError("Map location contains unsupported or missing fields")
        location_id = _required_text(location["location_id"], "location_id", 100)
        clean_name = _required_text(location["name"], "location name", 200)
        name_key = clean_name.casefold()
        location_status = _package_choice(location["status"], {"approved", "rejected"}, "Map location status")
        source_proposal_id = location["source_proposal_id"]
        if source_proposal_id is not None:
            source_proposal_id = _required_text(source_proposal_id, "source_proposal_id", 100)
            if source_proposal_id not in proposal_ids:
                raise ValidationError("Map location proposal reference is missing")
        if name_key in location_names or location_id in location_ids:
            raise ValidationError("Map locations must have unique names and supported statuses")
        location_type = location.get("location_type", "place")
        description = location.get("description", "")
        icon = location.get("icon", "")
        x, y = location.get("x"), location.get("y")
        if not isinstance(location_type, str) or not location_type.strip() or len(location_type) > 80:
            raise ValidationError("Map location type must be non-empty text of at most 80 characters")
        if not isinstance(description, str) or len(description) > 1000:
            raise ValidationError("Map location description is limited to 1000 characters")
        if not isinstance(icon, str) or len(icon) > 40:
            raise ValidationError("Map location icon is limited to 40 characters")
        for coordinate in (x, y):
            if coordinate is not None and (type(coordinate) not in (int, float) or abs(coordinate) > 1_000_000):
                raise ValidationError("Map coordinates must be numbers between -1000000 and 1000000")
        clean_locations.append({"location_id": location_id,
                                "name": clean_name,
                                "status": location_status, "source_proposal_id": source_proposal_id,
                                "location_type": location_type.strip(), "description": description,
                                "icon": icon, "x": x, "y": y,
                                "created_at": _package_time(location["created_at"], "location created_at")})
        location_names.add(name_key)
        location_ids.add(location_id)

    canonical = {
        "protocol": "lke.adventure.v2", "provenance": clean_provenance, "world": world,
        "context_manifests_included": False,
        "adventure": {"name": name, "world_version": world_version, "status": status, "completed_turns": completed_turns,
                      "npc_simulation_enabled": adventure["npc_simulation_enabled"],
                      "actor_entity_id": actor_entity_id, "entities": clean_entities,
                      "conversation": clean_conversation, "sheet": clean_sheet,
                      "turns": clean_turns, "turn_edits": clean_edits, "checks": clean_checks,
                      "mechanic_checks": clean_mechanic_checks,
                      "proposals": clean_proposals, "memories": clean_memories, "threads": clean_threads,
                      "npcs": clean_npcs, "assets": clean_assets, "locations": clean_locations,
                      "source_archive": source_archive},
    }
    if manifest is not None:
        _require_package_asset_checksums(manifest, clean_assets)
    canonical["manifest"] = _new_package_manifest(canonical, clean_assets)
    return canonical


_EXPORT_SELECTION_KEYS = {
    "turn_ids", "check_ids", "mechanic_check_ids", "proposal_ids", "memory_ids", "thread_ids",
    "npc_entity_ids", "asset_ids", "location_ids",
}


def _public_world_export(package: dict[str, Any]) -> dict[str, Any]:
    """Keep deliberately public world fields; opaque/import archives are not public lore."""
    public = copy.deepcopy(package)
    public["protocol"] = "lke.world.v1"
    public.pop("manifest", None)
    public["provenance"] = {"workspace_id": "public-export", "world_id": "world"}
    for version in public["versions"]:
        content = version["content"]
        visible = {
            key: content[key] for key in
            ("starting_location", "stats", "character_creation", "abilities", "game_mechanics", "trackers", "locations", "public_lore", "opening_scene", "cover_image") if key in content
        }
        import_metadata = content.get("mno_import")
        if isinstance(import_metadata, dict):
            allowed = {"format", "version", "stat_definitions", "npc_tracker_definitions", "conversion"}
            visible["mno_import"] = {key: value for key, value in import_metadata.items() if key in allowed}
        version["content"] = visible
    return validate_world_package(public)


def _shareable_adventure_export(package: dict[str, Any]) -> dict[str, Any]:
    shareable = copy.deepcopy(package)
    shareable["protocol"] = "lke.adventure.v1"
    shareable.pop("manifest", None)
    shareable["provenance"] = {
        "workspace_id": "shareable-export", "branch_id": "shareable",
        "adventure_id": "adventure", "exported_at": package["provenance"]["exported_at"],
    }
    shareable["world"] = _public_world_export(shareable["world"])
    adventure = shareable["adventure"]
    adventure["source_archive"] = None
    safe_npcs = [npc for npc in adventure["npcs"] if npc["review_status"] == "accepted"]
    npc_ids = {npc["npc_entity_id"] for npc in safe_npcs}
    for npc in safe_npcs:
        npc["private_profile"] = {}

    kept_turns = []
    for turn in adventure["turns"]:
        metadata = turn.get("metadata")
        if isinstance(metadata, dict) and metadata.get("context_excluded") is True:
            continue
        safe_turn = {key: value for key, value in turn.items() if key != "metadata"}
        safe_turn["provider"] = None
        safe_turn["model"] = None
        kept_turns.append(safe_turn)
    turn_ids = {turn["turn_id"] for turn in kept_turns}
    for order, turn in enumerate(kept_turns):
        turn["turn_order"] = order
    adventure["turns"] = kept_turns
    adventure["completed_turns"] = sum(turn["role"] == "user" for turn in kept_turns)
    adventure["turn_edits"] = [edit for edit in adventure["turn_edits"] if edit["turn_id"] in turn_ids]

    proposals = []
    retained_proposal_ids = set()
    for proposal in adventure["proposals"]:
        if proposal["review_status"] != "accepted":
            continue
        if proposal["source_turn_id"] and proposal["source_turn_id"] not in turn_ids:
            continue
        changes = []
        for change in proposal["changes"]:
            if change["operation"] == "add_event_memory":
                if change.get("knowledge_scope") != "shared":
                    continue
                change = {**change, "known_by": [item for item in change.get("known_by", [])
                                                   if item == adventure["actor_entity_id"] or item in npc_ids]}
            elif change["operation"] == "npc_profile" and change["npc_entity_id"] not in npc_ids:
                continue
            changes.append(change)
        if changes:
            proposals.append({**proposal, "changes": changes})
            retained_proposal_ids.add(proposal["proposal_id"])
    adventure["proposals"] = proposals
    adventure["memories"] = [
        memory for memory in adventure["memories"]
        if memory["review_status"] == "accepted" and memory["knowledge_scope"] == "shared"
        and (memory["source_turn_id"] is None or memory["source_turn_id"] in turn_ids)
    ]
    adventure["threads"] = []
    adventure["npcs"] = safe_npcs
    for entity in adventure["entities"]:
        properties = entity.get("properties")
        entity["properties"] = {"role": properties["role"]} if isinstance(properties, dict) and isinstance(properties.get("role"), str) else {}
    entity_ids = {adventure["actor_entity_id"], *npc_ids}
    entity_ids.update(actor for memory in adventure["memories"] for actor in memory["known_by"])
    for proposal in proposals:
        for change in proposal["changes"]:
            if change["operation"] == "npc_profile":
                entity_ids.add(change["npc_entity_id"])
            elif change["operation"] == "add_event_memory":
                entity_ids.update(change.get("known_by", []))

    safe_assets = []
    for index, asset in enumerate(adventure["assets"], start=1):
        if asset["target_kind"] == "scene" and asset["target_id"] not in turn_ids:
            continue
        if asset["target_kind"] == "character" and asset["target_id"] not in entity_ids:
            continue
        safe_assets.append({
            **asset,
            "asset_id": f"asset-{index}",
            "display_name": "Character reference image" if asset["target_kind"] == "character" else "Scene image",
            "provenance": {"origin": "redacted_export"},
        })
    adventure["assets"] = safe_assets
    adventure["locations"] = [
        {**location, "source_proposal_id": location["source_proposal_id"]
         if location["source_proposal_id"] in retained_proposal_ids else None}
        for location in adventure["locations"]
    ]
    adventure["entities"] = [entity for entity in adventure["entities"] if entity["entity_id"] in entity_ids]
    entity_map = {
        entity_id: f"character-{index}"
        for index, entity_id in enumerate(
            [adventure["actor_entity_id"]] + [entity["entity_id"] for entity in adventure["entities"]
                                                if entity["entity_id"] != adventure["actor_entity_id"]],
            start=1,
        )
    }
    turn_map = {turn["turn_id"]: f"turn-{index}" for index, turn in enumerate(adventure["turns"], start=1)}
    proposal_map = {proposal["proposal_id"]: f"proposal-{index}"
                    for index, proposal in enumerate(adventure["proposals"], start=1)}
    memory_map = {memory["memory_id"]: f"memory-{index}"
                  for index, memory in enumerate(adventure["memories"], start=1)}
    for entity in adventure["entities"]:
        entity["entity_id"] = entity_map[entity["entity_id"]]
    adventure["actor_entity_id"] = entity_map[adventure["actor_entity_id"]]
    for npc in adventure["npcs"]:
        npc["npc_entity_id"] = entity_map[npc["npc_entity_id"]]
    for turn in adventure["turns"]:
        turn["turn_id"] = turn_map[turn["turn_id"]]
    for edit in adventure["turn_edits"]:
        edit["turn_id"] = turn_map[edit["turn_id"]]
        edit["provider"] = None
        edit["model"] = None
    for proposal in adventure["proposals"]:
        old_proposal_id = proposal["proposal_id"]
        proposal["proposal_id"] = proposal_map[old_proposal_id]
        if proposal["source_turn_id"]:
            proposal["source_turn_id"] = turn_map[proposal["source_turn_id"]]
        for change in proposal["changes"]:
            if change["operation"] == "npc_profile":
                change["npc_entity_id"] = entity_map[change["npc_entity_id"]]
            elif change["operation"] == "add_event_memory":
                change["known_by"] = [entity_map[entity_id] for entity_id in change.get("known_by", [])
                                      if entity_id in entity_map]
    for memory in adventure["memories"]:
        memory["memory_id"] = memory_map[memory["memory_id"]]
        memory["known_by"] = [entity_map[entity_id] for entity_id in memory["known_by"] if entity_id in entity_map]
        if memory["source_turn_id"]:
            memory["source_turn_id"] = turn_map[memory["source_turn_id"]]
    for asset in adventure["assets"]:
        if asset["target_kind"] == "scene":
            asset["target_id"] = turn_map[asset["target_id"]]
        else:
            asset["target_id"] = entity_map[asset["target_id"]]
    for index, location in enumerate(adventure["locations"], start=1):
        location["location_id"] = f"location-{index}"
        if location["source_proposal_id"]:
            location["source_proposal_id"] = proposal_map[location["source_proposal_id"]]
    for index, check in enumerate(adventure["checks"], start=1):
        check["check_id"] = f"check-{index}"
    for index, check in enumerate(adventure["mechanic_checks"], start=1):
        check["check_id"] = f"mechanic-check-{index}"
    return validate_adventure_package(shareable)


def _selected_adventure_export(package: dict[str, Any], selection: Any) -> dict[str, Any]:
    if not isinstance(selection, dict) or not selection or not set(selection) <= _EXPORT_SELECTION_KEYS:
        raise ValidationError("Selected-content export needs one or more supported record ID lists")
    selected_ids: dict[str, set[str]] = {}
    for key in _EXPORT_SELECTION_KEYS:
        values = selection.get(key, [])
        if not isinstance(values, list) or len(values) > 10_000 or any(not isinstance(value, str) for value in values):
            raise ValidationError(f"{key} must be a list of record IDs")
        if len(values) != len(set(values)):
            raise ValidationError(f"{key} must not contain duplicate IDs")
        selected_ids[key] = set(values)

    selected = copy.deepcopy(package)
    selected["protocol"] = "lke.adventure.v1"
    selected.pop("manifest", None)
    selected["world"] = _public_world_export(selected["world"])
    adventure = selected["adventure"]
    table_keys = {
        "turn_ids": ("turns", "turn_id"), "check_ids": ("checks", "check_id"),
        "mechanic_check_ids": ("mechanic_checks", "check_id"),
        "proposal_ids": ("proposals", "proposal_id"), "memory_ids": ("memories", "memory_id"),
        "thread_ids": ("threads", "thread_id"), "npc_entity_ids": ("npcs", "npc_entity_id"),
        "asset_ids": ("assets", "asset_id"), "location_ids": ("locations", "location_id"),
    }
    for selection_key, (record_key, id_key) in table_keys.items():
        available = {row[id_key] for row in adventure[record_key]}
        unknown = selected_ids[selection_key] - available
        if unknown:
            raise ValidationError(f"{selection_key} contains an unknown record ID")
        adventure[record_key] = [row for row in adventure[record_key] if row[id_key] in selected_ids[selection_key]]

    retained_turn_ids = {turn["turn_id"] for turn in adventure["turns"]}
    for order, turn in enumerate(adventure["turns"]):
        turn["turn_order"] = order
        turn.pop("metadata", None)
    adventure["completed_turns"] = sum(turn["role"] == "user" for turn in adventure["turns"])
    adventure["turn_edits"] = [edit for edit in adventure["turn_edits"] if edit["turn_id"] in retained_turn_ids]
    adventure["proposals"] = [proposal for proposal in adventure["proposals"]
                               if proposal["source_turn_id"] is None or proposal["source_turn_id"] in retained_turn_ids]
    retained_proposal_ids = {proposal["proposal_id"] for proposal in adventure["proposals"]}
    adventure["memories"] = [memory for memory in adventure["memories"]
                              if memory["source_turn_id"] is None or memory["source_turn_id"] in retained_turn_ids]
    adventure["locations"] = [
        {**location, "source_proposal_id": location["source_proposal_id"]
         if location["source_proposal_id"] in retained_proposal_ids else None}
        for location in adventure["locations"]
    ]
    adventure["assets"] = [asset for asset in adventure["assets"]
                            if (asset["target_kind"] != "scene" or asset["target_id"] in retained_turn_ids)]
    adventure["source_archive"] = None
    for entity in adventure["entities"]:
        properties = entity.get("properties")
        entity["properties"] = {"role": properties["role"]} if isinstance(properties, dict) and isinstance(properties.get("role"), str) else {}
    entity_ids = {adventure["actor_entity_id"]}
    entity_ids.update(npc["npc_entity_id"] for npc in adventure["npcs"])
    entity_ids.update(asset["target_id"] for asset in adventure["assets"] if asset["target_kind"] == "character")
    entity_ids.update(actor for memory in adventure["memories"] for actor in memory["known_by"])
    for proposal in adventure["proposals"]:
        for change in proposal["changes"]:
            if change["operation"] == "npc_profile":
                entity_ids.add(change["npc_entity_id"])
            elif change["operation"] == "add_event_memory":
                entity_ids.update(change.get("known_by", []))
    adventure["entities"] = [entity for entity in adventure["entities"] if entity["entity_id"] in entity_ids]
    return validate_adventure_package(selected)


def _encode_adventure_assets(package: dict[str, Any]) -> dict[str, Any]:
    for asset in package["adventure"]["assets"]:
        content = asset.pop("content", None)
        if isinstance(content, bytes):
            asset["data_base64"] = base64.b64encode(content).decode("ascii")
    return package


def _adventure_export_report(package: dict[str, Any], mode: str) -> dict[str, Any]:
    adventure = package["adventure"]
    private_npc_profiles = sum(bool(npc["private_profile"]) for npc in adventure["npcs"])
    private_memories = sum(memory["knowledge_scope"] != "shared" for memory in adventure["memories"])
    unpublished_memories = sum(memory["review_status"] != "accepted" for memory in adventure["memories"])
    context_excluded_turns = sum(
        isinstance(turn.get("metadata"), dict) and turn["metadata"].get("context_excluded") is True
        for turn in adventure["turns"]
    )
    has_private_archive = adventure.get("source_archive") is not None
    unclassified_threads = len(adventure["threads"])
    entity_profiles = sum(
        bool(entity.get("properties")) and bool(set(entity.get("properties", {})) - {"role"})
        for entity in adventure["entities"]
    )
    requires_confirmation = mode in {"full_private_archive", "selected_content"} and bool(
        private_npc_profiles or private_memories or unpublished_memories or context_excluded_turns
        or has_private_archive or unclassified_threads or entity_profiles
    )
    counts = {"turns": len(adventure["turns"]), "checks": len(adventure["checks"]),
              "mechanic_checks": len(adventure["mechanic_checks"]), "npcs": len(adventure["npcs"]),
              "memories": len(adventure["memories"]), "threads": len(adventure["threads"]),
              "images": len(adventure["assets"]), "map_locations": len(adventure["locations"])}
    return {
        "mode": mode, "included": counts,
        "sensitive": {"private_npc_profiles": private_npc_profiles, "private_memories": private_memories,
                      "unpublished_memories": unpublished_memories,
                      "context_excluded_turns": context_excluded_turns,
                      "preserved_source_archive": has_private_archive,
                      "unclassified_threads": unclassified_threads,
                      "entity_profiles": entity_profiles},
        "requires_private_confirmation": requires_confirmation,
    }


def _world_export_report(package: dict[str, Any], mode: str) -> dict[str, Any]:
    visible_fields = {"starting_location", "stats", "character_creation", "abilities", "game_mechanics", "trackers", "locations", "public_lore", "opening_scene", "cover_image"}
    visible_import_fields = {"format", "version", "stat_definitions", "npc_tracker_definitions", "conversion"}
    unclassified = []
    for version in package["versions"]:
        content = version["content"]
        hidden_fields = sorted(set(content) - visible_fields - {"mno_import"})
        import_metadata = content.get("mno_import")
        if isinstance(import_metadata, dict):
            hidden_fields.extend(
                f"mno_import.{key}" for key in sorted(set(import_metadata) - visible_import_fields)
            )
        if hidden_fields:
            unclassified.append({"version": version["version"], "fields": hidden_fields})
    private = bool(unclassified)
    return {
        "mode": mode,
        "included": {"world_versions": len(package["versions"]),
                     "world_fields_per_version": sorted({key for version in package["versions"] for key in version["content"]})},
        "sensitive": {"unclassified_content_by_version": unclassified},
        "requires_private_confirmation": mode == "full_private_archive" and private,
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
            if not isinstance(knowledge_scope, str) or knowledge_scope not in {"shared", "actors"}:
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


def _import_adventure_records(
    connection: sqlite3.Connection,
    *,
    workspace_id: str,
    branch_id: str,
    revision: int,
    adventure_id: str,
    conversation_id: str,
    world_id: str,
    world_version: int,
    package: dict[str, Any],
    adventure_name: str | None = None,
) -> dict[str, Any]:
    clean = validate_adventure_package(package)
    data = clean["adventure"]
    if adventure_name is not None:
        adventure_name = _required_text(adventure_name, "name", 200)
    if branch_id != adventure_id:
        raise ValidationError("Imported adventure_id must match its isolated branch_id")
    if type(world_version) is not int or world_version != data["world_version"]:
        raise ValidationError("Imported adventure must retain its pinned world version")

    source_world = clean["world"]["versions"][world_version - 1]
    target_world = connection.execute(
        "SELECT v.name,v.description,v.template_key,v.content_json FROM story_world_versions v "
        "WHERE v.workspace_id=? AND v.world_id=? AND v.version=?",
        (workspace_id, world_id, world_version),
    ).fetchone()
    if not target_world:
        raise NotFoundError("Target world version does not exist in this workspace")
    if (
        target_world["name"] != source_world["name"]
        or target_world["description"] != source_world["description"]
        or target_world["template_key"] != source_world["template_key"]
        or json.loads(target_world["content_json"]) != source_world["content"]
    ):
        raise ConflictError("Target world version does not match the adventure package")

    entity_map: dict[str, str] = {}
    imported_entities = 0
    for entity in data["entities"]:
        original_id = entity["entity_id"]
        existing = connection.execute(
            "SELECT entity_type,label,properties_json FROM entities "
            "WHERE workspace_id=? AND branch_id=? AND entity_id=?",
            (workspace_id, branch_id, original_id),
        ).fetchone()
        if existing and (
            existing["entity_type"] != entity["entity_type"]
            or existing["label"] != entity["label"]
            or json.loads(existing["properties_json"]) != entity["properties"]
        ):
            prefix = original_id[:60]
            imported_id = f"{prefix}_copy_{uuid4().hex[:12]}"
            while connection.execute(
                "SELECT 1 FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, imported_id),
            ).fetchone():
                imported_id = f"{prefix}_copy_{uuid4().hex[:12]}"
            entity_map[original_id] = imported_id
            original_id = imported_id
        else:
            entity_map[original_id] = original_id
        if existing and original_id == entity["entity_id"]:
            continue
        properties_json = _json(entity["properties"])
        connection.execute(
            "INSERT INTO entities(workspace_id,branch_id,entity_id,entity_type,label,properties_json,created_revision,updated_revision) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (workspace_id, branch_id, original_id, entity["entity_type"], entity["label"], properties_json, revision, revision),
        )
        connection.execute(
            "INSERT INTO entity_search(workspace_id,branch_id,entity_id,label,properties) VALUES(?,?,?,?,?)",
            (workspace_id, branch_id, original_id, entity["label"], properties_json),
        )
        imported_entities += 1

    actor_entity_id = entity_map[data["actor_entity_id"]]
    now = _now()
    conversation = data["conversation"]
    connection.execute(
        "INSERT INTO story_conversations(workspace_id,branch_id,conversation_id,actor_entity_id,title,actor_is_user_controlled,created_revision,updated_revision,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (workspace_id, branch_id, conversation_id, actor_entity_id,
         adventure_name if adventure_name is not None else conversation["title"],
         int(conversation["actor_is_user_controlled"]), revision, revision, now, now),
    )
    connection.execute(
        "INSERT INTO story_adventures(workspace_id,branch_id,adventure_id,world_id,world_version,conversation_id,name,actor_entity_id,status,created_revision,updated_revision,created_at,updated_at,completed_turns,npc_simulation_enabled,source_archive_json) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (workspace_id, branch_id, adventure_id, world_id, world_version, conversation_id,
         adventure_name if adventure_name is not None else data["name"],
         actor_entity_id, data["status"], revision, revision, now, now, data["completed_turns"],
         int(data["npc_simulation_enabled"]),
         _json(data["source_archive"]) if data["source_archive"] is not None else None),
    )
    sheet = data["sheet"]
    connection.execute(
        "INSERT INTO rpg_sheets(workspace_id,branch_id,adventure_id,conversation_id,stats_json,trackers_json,current_location,created_revision,updated_revision,map_region,map_x,map_y,map_scale,abilities_json,skills_json,experience_json) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (workspace_id, branch_id, adventure_id, conversation_id, _json(sheet["stats"]), _json(sheet["trackers"]),
         sheet["current_location"], revision, revision, sheet["map_region"], sheet["map_x"],
          sheet["map_y"], sheet["map_scale"], _json(sheet["ability_states"]),
          _json(sheet["skill_ranks"]), _json(sheet["experience"])),
    )

    connection.executemany(
        "INSERT INTO story_turns(workspace_id,branch_id,conversation_id,turn_id,turn_order,role,narrative_order,content,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at,metadata_json) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?)",
        [(workspace_id, branch_id, conversation_id, turn["turn_id"], turn["turn_order"], turn["role"],
          turn["narrative_order"], turn["content"], turn["provider"], turn["model"], revision,
          turn["created_at"], _json(turn["metadata"]) if turn["metadata"] is not None else None)
         for turn in data["turns"]],
    )
    connection.executemany(
        "INSERT INTO story_turn_edits(workspace_id,branch_id,conversation_id,turn_id,version,content,status,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)",
        [(workspace_id, branch_id, conversation_id, edit["turn_id"], edit["version"], edit["content"],
          edit["status"], edit["provider"], edit["model"], revision, edit["created_at"])
         for edit in data["turn_edits"]],
    )

    connection.executemany(
        "INSERT INTO rpg_checks(workspace_id,branch_id,check_id,adventure_id,conversation_id,actor_entity_id,stat_name,die_roll,modifier,total,target,outcome,created_revision,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(workspace_id, branch_id, check["check_id"], adventure_id, conversation_id, actor_entity_id,
          check["stat_name"], check["die_roll"], check["modifier"], check["total"], check["target"],
          check["outcome"], revision, check["created_at"]) for check in data["checks"]],
    )
    connection.executemany(
        "INSERT INTO rpg_mechanic_checks(workspace_id,branch_id,check_id,adventure_id,conversation_id,actor_entity_id,encounter_type,stat_name,skill_id,dice_json,resolution,modifier,total,target,difficulty_id,outcome,rules_json,created_revision,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(workspace_id, branch_id, check["check_id"], adventure_id, conversation_id, actor_entity_id,
          check["encounter_type"], check["stat_name"], check["skill_id"], _json(check["dice_rolls"]),
          check["resolution"], check["modifier"], check["total"], check["target"], check["difficulty_id"],
          check["outcome"], _json(check["rules"]), revision, check["created_at"])
         for check in data["mechanic_checks"]],
    )

    for proposal in data["proposals"]:
        changes = []
        for change in proposal["changes"]:
            remapped = dict(change)
            if remapped["operation"] == "npc_profile":
                remapped["npc_entity_id"] = entity_map[remapped["npc_entity_id"]]
            elif remapped["operation"] == "add_event_memory":
                remapped["known_by"] = [entity_map[item] for item in remapped["known_by"]]
            changes.append(remapped)
        connection.execute(
            "INSERT INTO rpg_state_proposals(workspace_id,branch_id,proposal_id,adventure_id,conversation_id,source_turn_id,changes_json,review_status,created_revision,reviewed_revision,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (workspace_id, branch_id, proposal["proposal_id"], adventure_id, conversation_id,
             proposal["source_turn_id"], _json(changes), proposal["review_status"], revision,
             revision if proposal["review_status"] != "proposed" else None, proposal["created_at"]),
        )

    connection.executemany(
        "INSERT INTO story_memories(workspace_id,branch_id,adventure_id,memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(workspace_id, branch_id, adventure_id, memory["memory_id"], memory["version"], memory["kind"],
          memory["content"], int(memory["context_enabled"]), memory["review_status"], memory["source_turn_id"],
          memory["narrative_order"], memory["supersedes_version"], memory["importance"], memory["knowledge_scope"],
          _json([entity_map[item] for item in memory["known_by"]]), revision,
          revision if memory["review_status"] != "proposed" else None, memory["created_at"])
         for memory in data["memories"]],
    )
    connection.executemany(
        "INSERT INTO story_threads(workspace_id,branch_id,adventure_id,thread_id,title,detail,status,created_revision,updated_revision,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [(workspace_id, branch_id, adventure_id, thread["thread_id"], thread["title"], thread["detail"],
          thread["status"], revision, revision, thread["created_at"], thread["updated_at"])
         for thread in data["threads"]],
    )
    connection.executemany(
        "INSERT INTO story_npc_profiles(workspace_id,branch_id,adventure_id,npc_entity_id,aliases_json,public_profile_json,private_profile_json,review_status,created_revision,updated_revision,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        [(workspace_id, branch_id, adventure_id, entity_map[npc["npc_entity_id"]], _json(npc["aliases"]),
          _json(npc["public_profile"]), _json(npc["private_profile"]), npc["review_status"], revision, revision,
          npc["created_at"], npc["updated_at"]) for npc in data["npcs"]],
    )
    connection.executemany(
        "INSERT INTO story_assets(workspace_id,branch_id,adventure_id,asset_id,target_kind,target_id,display_name,mime_type,content,provenance_json,created_revision,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        [(workspace_id, branch_id, adventure_id, asset["asset_id"], asset["target_kind"],
          entity_map.get(asset["target_id"], asset["target_id"]), asset["display_name"], asset["mime_type"],
          asset["content"], _json(asset["provenance"]), revision, asset["created_at"])
         for asset in data["assets"]],
    )
    connection.executemany(
        "INSERT INTO story_map_locations(workspace_id,branch_id,adventure_id,location_id,name,status,source_proposal_id,created_revision,reviewed_revision,created_at,location_type,description,icon,x,y) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(workspace_id, branch_id, adventure_id, location["location_id"], location["name"], location["status"],
          location["source_proposal_id"], revision, revision, location["created_at"], location["location_type"],
          location["description"], location["icon"], location["x"], location["y"])
         for location in data["locations"]],
    )

    return {
        "adventure_id": adventure_id,
        "conversation_id": conversation_id,
        "world_id": world_id,
        "world_version": world_version,
        "actor_entity_id": actor_entity_id,
        "entities_imported": imported_entities,
        "entity_id_map": entity_map,
        "turns_imported": len(data["turns"]),
        "source": clean["provenance"],
    }


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
    ("story_turns", "conversation_id,turn_id,turn_order,role,narrative_order,content,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at,metadata_json"),
    ("story_adventures", "adventure_id,world_id,world_version,conversation_id,name,actor_entity_id,status,created_revision,updated_revision,created_at,updated_at,completed_turns,npc_simulation_enabled,source_archive_json,archived_at"),
    ("rpg_sheets", "adventure_id,conversation_id,stats_json,trackers_json,current_location,created_revision,updated_revision,map_region,map_x,map_y,map_scale,abilities_json,skills_json,experience_json"),
    ("story_turn_edits", "conversation_id,turn_id,version,content,status,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at"),
    ("story_memories", "adventure_id,memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at"),
    ("story_threads", "adventure_id,thread_id,title,detail,status,created_revision,updated_revision,created_at,updated_at"),
    ("story_npc_profiles", "adventure_id,npc_entity_id,aliases_json,public_profile_json,private_profile_json,review_status,created_revision,updated_revision,created_at,updated_at"),
    ("story_assets", "adventure_id,asset_id,target_kind,target_id,display_name,mime_type,content,provenance_json,created_revision,created_at"),
    ("story_map_locations", "adventure_id,location_id,name,status,source_proposal_id,created_revision,reviewed_revision,created_at,location_type,description,icon,x,y"),
    ("rpg_checks", "check_id,adventure_id,conversation_id,actor_entity_id,stat_name,die_roll,modifier,total,target,outcome,created_revision,created_at"),
    ("rpg_mechanic_checks", "check_id,adventure_id,conversation_id,actor_entity_id,encounter_type,stat_name,skill_id,dice_json,resolution,modifier,total,target,difficulty_id,outcome,rules_json,created_revision,created_at"),
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
        ("story_turns", "conversation_id,turn_id,turn_order,role,narrative_order,content,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at,metadata_json", None, (), ("created_revision",), "conversation_id,turn_id"),
        ("story_adventures", "adventure_id,world_id,world_version,conversation_id,name,actor_entity_id,status,created_revision,updated_revision,created_at,updated_at,completed_turns,npc_simulation_enabled,source_archive_json,archived_at", "adventure_id", ("world_id", "world_version", "conversation_id", "name", "actor_entity_id", "status", "updated_revision", "updated_at", "completed_turns", "npc_simulation_enabled", "source_archive_json", "archived_at"), ("created_revision", "updated_revision"), "adventure_id"),
        ("rpg_sheets", "adventure_id,conversation_id,stats_json,trackers_json,current_location,created_revision,updated_revision,map_region,map_x,map_y,map_scale,abilities_json,skills_json,experience_json", "adventure_id", ("conversation_id", "stats_json", "trackers_json", "current_location", "updated_revision", "map_region", "map_x", "map_y", "map_scale", "abilities_json", "skills_json", "experience_json"), ("created_revision", "updated_revision"), "adventure_id"),
        ("story_turn_edits", "conversation_id,turn_id,version,content,status,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at", None, (), ("created_revision",), "conversation_id,turn_id,version"),
        ("story_memories", "adventure_id,memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_revision,reviewed_revision,created_at", "adventure_id,memory_id,version", ("review_status", "reviewed_revision"), ("created_revision", "reviewed_revision"), "adventure_id,memory_id,version"),
        ("story_threads", "adventure_id,thread_id,title,detail,status,created_revision,updated_revision,created_at,updated_at", "adventure_id,thread_id", ("title", "detail", "status", "updated_revision", "updated_at"), ("created_revision", "updated_revision"), "adventure_id,thread_id"),
        ("story_npc_profiles", "adventure_id,npc_entity_id,aliases_json,public_profile_json,private_profile_json,review_status,created_revision,updated_revision,created_at,updated_at", "adventure_id,npc_entity_id", ("aliases_json", "public_profile_json", "private_profile_json", "review_status", "updated_revision", "updated_at"), ("created_revision", "updated_revision"), "adventure_id,npc_entity_id"),
        ("story_assets", "adventure_id,asset_id,target_kind,target_id,display_name,mime_type,content,provenance_json,created_revision,created_at", None, (), ("created_revision",), "adventure_id,asset_id"),
        ("story_map_locations", "adventure_id,location_id,name,status,source_proposal_id,created_revision,reviewed_revision,created_at,location_type,description,icon,x,y", "adventure_id,location_id", ("name", "status", "source_proposal_id", "reviewed_revision", "location_type", "description", "icon", "x", "y"), ("created_revision", "reviewed_revision"), "adventure_id,location_id"),
        ("rpg_checks", "check_id,adventure_id,conversation_id,actor_entity_id,stat_name,die_roll,modifier,total,target,outcome,created_revision,created_at", None, (), ("created_revision",), "check_id"),
        ("rpg_mechanic_checks", "check_id,adventure_id,conversation_id,actor_entity_id,encounter_type,stat_name,skill_id,dice_json,resolution,modifier,total,target,difficulty_id,outcome,rules_json,created_revision,created_at", None, (), ("created_revision",), "check_id"),
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
            properties = _validated_entity_properties(payload.get("properties", {}))
            if "character_profile" in properties and entity_type not in {"character", "person"}:
                raise ValidationError("character_profile must belong to a character")
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
            properties = _validated_entity_properties(
                payload.get("properties", json.loads(row["properties_json"]))
            )
            if "character_profile" in properties and entity_type not in {"character", "person"}:
                raise ValidationError("character_profile must belong to a character")
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

        if command_type == "set_story_world_archived":
            if branch_id != "main" or actor.startswith("ai:"):
                raise ValidationError("Only a user can archive or restore a world in the main library")
            world_id = _required_text(payload.get("world_id"), "world_id", 100)
            archived = payload.get("archived")
            if not isinstance(archived, bool):
                raise ValidationError("archived must be a boolean")
            current = connection.execute(
                "SELECT archived_at FROM story_worlds WHERE workspace_id=? AND world_id=?",
                (workspace_id, world_id),
            ).fetchone()
            if not current:
                raise NotFoundError("World does not exist in this workspace")
            if bool(current["archived_at"]) == archived:
                return {"world_id": world_id, "archived": archived}, \
                    "story.world_archived" if archived else "story.world_restored", False
            now = _now()
            connection.execute(
                "UPDATE story_worlds SET archived_at=?,updated_at=? WHERE workspace_id=? AND world_id=?",
                (now if archived else None, now, workspace_id, world_id),
            )
            return {"world_id": world_id, "archived": archived}, \
                "story.world_archived" if archived else "story.world_restored", True

        if command_type == "duplicate_story_world":
            if branch_id != "main" or actor.startswith("ai:"):
                raise ValidationError("Only a user can duplicate a world in the main library")
            source_world_id = _required_text(payload.get("source_world_id"), "source_world_id", 100)
            world_id = _required_text(payload.get("world_id"), "world_id", 100)
            name = _required_text(payload.get("name"), "name", 200)
            if connection.execute(
                "SELECT 1 FROM story_worlds WHERE workspace_id=? AND world_id=?",
                (workspace_id, world_id),
            ).fetchone():
                raise ConflictError("The target world ID already exists")
            source = connection.execute(
                "SELECT latest_version FROM story_worlds WHERE workspace_id=? AND world_id=?",
                (workspace_id, source_world_id),
            ).fetchone()
            if not source:
                raise NotFoundError("Source world does not exist in this workspace")
            versions = connection.execute(
                "SELECT version,name,description,template_key,content_json FROM story_world_versions "
                "WHERE workspace_id=? AND world_id=? ORDER BY version",
                (workspace_id, source_world_id),
            ).fetchall()
            if not versions or len(versions) != source["latest_version"]:
                raise ConflictError("The source world version history is incomplete")
            now = _now()
            connection.execute(
                "INSERT INTO story_worlds(workspace_id,world_id,name,latest_version,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?)",
                (workspace_id, world_id, name, len(versions), now, now),
            )
            connection.executemany(
                "INSERT INTO story_world_versions(workspace_id,world_id,version,name,description,template_key,content_json,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                [(workspace_id, world_id, version["version"],
                  name if version["version"] == len(versions) else version["name"],
                  version["description"], version["template_key"], version["content_json"], revision, now)
                 for version in versions],
            )
            return {"world_id": world_id, "source_world_id": source_world_id,
                    "name": name, "version": len(versions)}, "story.world_duplicated", True

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
            opening_scene = _validated_story_opening_scene(content)
            if opening_scene is not None:
                content["opening_scene"] = opening_scene
            _validated_story_world_locations(content)
            _validated_story_character_creation(content)
            _validated_story_ability_definitions(content)
            _validated_story_mechanics(content)
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

        if command_type == "set_story_adventure_library_state":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot rename, change status, or archive adventures")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            parent = connection.execute(
                "SELECT parent_branch_id FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not parent or parent["parent_branch_id"] != "main":
                raise ValidationError("Adventure library changes must be made on an isolated adventure branch")
            adventure = connection.execute(
                "SELECT name,status,archived_at,conversation_id FROM story_adventures "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure:
                raise NotFoundError("Adventure does not exist in this branch")
            name = _required_text(payload.get("name", adventure["name"]), "name", 200)
            status = payload.get("status", adventure["status"])
            if not isinstance(status, str) or status not in {"active", "complete", "paused"}:
                raise ValidationError("Adventure status must be active, paused, or complete")
            archived = payload.get("archived", bool(adventure["archived_at"]))
            if not isinstance(archived, bool):
                raise ValidationError("archived must be a boolean")
            if name == adventure["name"] and status == adventure["status"] \
                    and archived == bool(adventure["archived_at"]):
                return {"adventure_id": adventure_id, "name": name, "status": status,
                        "archived": archived}, "story.adventure_library_updated", False
            now = _now()
            connection.execute(
                "UPDATE story_adventures SET name=?,status=?,archived_at=?,updated_revision=?,updated_at=? "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (name, status, (adventure["archived_at"] or now) if archived else None,
                 revision, now, workspace_id, branch_id, adventure_id),
            )
            if name != adventure["name"]:
                connection.execute(
                    "UPDATE story_conversations SET title=?,updated_revision=?,updated_at=? "
                    "WHERE workspace_id=? AND branch_id=? AND conversation_id=?",
                    (name, revision, now, workspace_id, branch_id, adventure["conversation_id"]),
                )
            event_type = "story.adventure_archived" if archived and not adventure["archived_at"] \
                else "story.adventure_restored" if not archived and adventure["archived_at"] \
                else "story.adventure_library_updated"
            return {"adventure_id": adventure_id, "name": name, "status": status,
                    "archived": archived}, event_type, True

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
                "SELECT v.content_json,w.archived_at FROM story_world_versions v "
                "JOIN story_worlds w ON w.workspace_id=v.workspace_id AND w.world_id=v.world_id "
                "WHERE v.workspace_id=? AND v.world_id=? AND v.version=?",
                (workspace_id, world_id, world_version),
            ).fetchone()
            if not world:
                raise NotFoundError("Pinned world version does not exist in this workspace")
            if world["archived_at"] is not None:
                raise ValidationError("Restore this world before starting a new adventure from it")
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
            stats = _validated_story_character_allocation(world_content, payload.get("stats"))
            skill_ranks = _initial_story_skill_ranks(world_content)
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
                "INSERT INTO rpg_sheets(workspace_id,branch_id,adventure_id,conversation_id,stats_json,trackers_json,current_location,created_revision,updated_revision,abilities_json,skills_json,experience_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, adventure_id, conversation_id, _json(stats), _json(trackers),
                 location.strip(), revision, revision, _json(_initial_story_ability_states(world_content)),
                 _json(skill_ranks), _json({"manual_awards": 0})),
            )
            return {
                "adventure_id": adventure_id,
                "world_id": world_id,
                "world_version": world_version,
                "conversation_id": conversation_id,
                "actor_entity_id": actor_entity_id,
                "name": name,
            }, "story.adventure_created", True

        if command_type == "set_story_ability_active":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot activate or deactivate character abilities")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            ability_id = _required_text(payload.get("ability_id"), "ability_id", 100)
            active = payload.get("active")
            if not isinstance(active, bool):
                raise ValidationError("Ability active state must be a boolean")
            adventure = connection.execute(
                "SELECT world_id,world_version,completed_turns FROM story_adventures "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            sheet = connection.execute(
                "SELECT trackers_json,abilities_json FROM rpg_sheets "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or not sheet:
                raise NotFoundError("Adventure character sheet does not exist in this branch")
            world = connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, adventure["world_id"], adventure["world_version"]),
            ).fetchone()
            if not world:
                raise NotFoundError("Pinned ability definitions do not exist in this workspace")
            content = json.loads(world["content_json"])
            definitions = _validated_story_ability_definitions(content)
            ability = next((item for item in definitions if item["ability_id"] == ability_id), None)
            if not ability:
                raise NotFoundError("Ability is not defined by this adventure's pinned world version")
            states = _validated_story_ability_states(content, json.loads(sheet["abilities_json"]))
            state = next(item for item in states if item["ability_id"] == ability_id)
            if state["is_active"] == active:
                return {"adventure_id": adventure_id, "ability_id": ability_id, "is_active": active}, \
                    "story.ability_activated" if active else "story.ability_deactivated", False

            trackers = json.loads(sheet["trackers_json"])
            if active:
                if adventure["completed_turns"] < state["ready_after_turn"]:
                    raise ValidationError("This ability is still within its explicitly defined cooldown")
                for cost in ability["costs"]:
                    tracker_name = next((name for name in trackers if name.casefold() == cost["resource"].casefold()), None)
                    if tracker_name is None:
                        raise ValidationError(f"Ability cost resource {cost['resource']} is not a character tracker")
                    tracker = trackers[tracker_name]
                    if tracker["value"] < cost["amount"]:
                        raise ValidationError(f"Activating {ability['name']} needs {cost['amount']} {tracker_name}")
                for cost in ability["costs"]:
                    tracker_name = next(name for name in trackers if name.casefold() == cost["resource"].casefold())
                    trackers[tracker_name]["value"] -= cost["amount"]
                state["activation_count"] += 1
                state["ready_after_turn"] = adventure["completed_turns"] + (ability["cooldown_turns"] or 0)
            state["is_active"] = active
            connection.execute(
                "UPDATE rpg_sheets SET trackers_json=?,abilities_json=?,updated_revision=? "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (_json(trackers), _json(states), revision, workspace_id, branch_id, adventure_id),
            )
            return {"adventure_id": adventure_id, "ability_id": ability_id, "is_active": active}, \
                "story.ability_activated" if active else "story.ability_deactivated", True

        if command_type == "import_story_adventure":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot import adventures")
            parent = connection.execute(
                "SELECT parent_branch_id FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not parent or parent["parent_branch_id"] != "main":
                raise ValidationError("An imported adventure must use a new isolated snapshot of the main branch")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            conversation_id = _required_text(payload.get("conversation_id"), "conversation_id", 100)
            world_id = _required_text(payload.get("world_id"), "world_id", 100)
            world_version = payload.get("world_version")
            if branch_id != adventure_id:
                raise ValidationError("Imported adventure_id must match its branch_id")
            if connection.execute(
                "SELECT 1 FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone():
                raise ConflictError("Adventure already exists in this branch")
            imported = _import_adventure_records(
                connection,
                workspace_id=workspace_id,
                branch_id=branch_id,
                revision=revision,
                adventure_id=adventure_id,
                conversation_id=conversation_id,
                world_id=world_id,
                world_version=world_version,
                package=payload.get("package"),
                adventure_name=payload.get("name"),
            )
            return imported, "story.adventure_imported", True

        if command_type == "update_rpg_sheet":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot change canonical RPG state")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            adventure = connection.execute(
                "SELECT world_id,world_version FROM story_adventures "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            sheet = connection.execute(
                "SELECT stats_json,trackers_json,current_location FROM rpg_sheets "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or not sheet:
                raise NotFoundError("Adventure character sheet does not exist in this branch")
            world = connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, adventure["world_id"], adventure["world_version"]),
            ).fetchone()
            if not world:
                raise NotFoundError("Pinned stat definitions do not exist in this workspace")
            content = json.loads(world["content_json"])
            stats = _validated_story_current_stats(content, payload["stats"]) if "stats" in payload else json.loads(sheet["stats_json"])
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

        if command_type == "update_story_skills":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot change canonical character skills")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            adventure = connection.execute(
                "SELECT world_id,world_version FROM story_adventures "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            sheet = connection.execute(
                "SELECT skills_json FROM rpg_sheets WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or not sheet:
                raise NotFoundError("Adventure character sheet does not exist in this branch")
            world = connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, adventure["world_id"], adventure["world_version"]),
            ).fetchone()
            if not world:
                raise NotFoundError("Pinned skill definitions do not exist in this workspace")
            content = json.loads(world["content_json"])
            ranks = _validated_story_skill_ranks(content, payload.get("skill_ranks"))
            connection.execute(
                "UPDATE rpg_sheets SET skills_json=?,updated_revision=? "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (_json(ranks), revision, workspace_id, branch_id, adventure_id),
            )
            return {"adventure_id": adventure_id, "skill_ranks": ranks}, "rpg.skills_updated", True

        if command_type == "award_story_experience":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot award canonical character experience")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            amount = payload.get("amount")
            if type(amount) is not int or not 1 <= amount <= 1_000_000:
                raise ValidationError("Experience award must be a positive whole number no greater than 1000000")
            adventure = connection.execute(
                "SELECT world_id,world_version,completed_turns FROM story_adventures "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            sheet = connection.execute(
                "SELECT experience_json FROM rpg_sheets WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or not sheet:
                raise NotFoundError("Adventure character sheet does not exist in this branch")
            world = connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, adventure["world_id"], adventure["world_version"]),
            ).fetchone()
            if not world:
                raise NotFoundError("Pinned experience rules do not exist in this workspace")
            mechanics = _validated_story_mechanics(json.loads(world["content_json"]))
            rules = mechanics["experience"]
            if not rules["allow_manual_awards"]:
                raise ValidationError("This adventure's pinned rules do not allow manual experience awards")
            state = _validated_experience_state(json.loads(sheet["experience_json"]))
            current = _story_experience_summary(mechanics, state, adventure["completed_turns"])
            available = rules["maximum_xp"] - current["total_xp"]
            if available <= 0:
                raise ValidationError("Character has reached the pinned maximum experience")
            if amount > available:
                raise ValidationError(f"This award exceeds the remaining experience capacity of {available}")
            granted = amount
            state["manual_awards"] += granted
            connection.execute(
                "UPDATE rpg_sheets SET experience_json=?,updated_revision=? "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (_json(state), revision, workspace_id, branch_id, adventure_id),
            )
            return {"adventure_id": adventure_id, "awarded": granted,
                    "experience": _story_experience_summary(mechanics, state, adventure["completed_turns"])}, \
                "rpg.experience_awarded", True

        if command_type == "record_rpg_mechanic_check":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot roll or record player checks")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            adventure = connection.execute(
                "SELECT conversation_id,actor_entity_id,world_id,world_version FROM story_adventures "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            sheet = connection.execute(
                "SELECT stats_json,skills_json FROM rpg_sheets "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or not sheet:
                raise NotFoundError("Adventure does not exist in this branch")
            world = connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, adventure["world_id"], adventure["world_version"]),
            ).fetchone()
            if not world:
                raise NotFoundError("Pinned game mechanics do not exist in this workspace")
            content = json.loads(world["content_json"])
            mechanics = _validated_story_mechanics(content)
            check = _resolve_story_mechanics_check(
                mechanics, json.loads(sheet["stats_json"]),
                _validated_story_skill_ranks(content, json.loads(sheet["skills_json"])), payload,
            )
            check_id = _required_text(payload.get("check_id") or str(uuid4()), "check_id", 100)
            created_at = _now()
            connection.execute(
                "INSERT INTO rpg_mechanic_checks(workspace_id,branch_id,check_id,adventure_id,conversation_id,actor_entity_id,encounter_type,stat_name,skill_id,dice_json,resolution,modifier,total,target,difficulty_id,outcome,rules_json,created_revision,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, check_id, adventure_id, adventure["conversation_id"],
                 adventure["actor_entity_id"], check["encounter_type"], check["stat_name"],
                 check["skill_id"], _json(check["dice_rolls"]), check["resolution"], check["modifier"],
                 check["total"], check["target"], check["difficulty_id"], check["outcome"],
                 _json(check["rules"]), revision, created_at),
            )
            return {**check, "check_id": check_id, "adventure_id": adventure_id,
                    "created_revision": revision, "created_at": created_at}, "rpg.mechanic_check_recorded", True

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
                "SELECT conversation_id,actor_entity_id,world_id,world_version FROM story_adventures "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            sheet = connection.execute(
                "SELECT stats_json FROM rpg_sheets WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or not sheet:
                raise NotFoundError("Adventure does not exist in this branch")
            world = connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, adventure["world_id"], adventure["world_version"]),
            ).fetchone()
            if world and "game_mechanics" in json.loads(world["content_json"]):
                raise ValidationError("Use the pinned world's mechanics check workflow for this adventure")
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
                map_x = None
                map_y = None
                if sheet_changes:
                    sheet = connection.execute(
                        "SELECT stats_json,trackers_json,current_location,updated_revision,map_x,map_y FROM rpg_sheets "
                        "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                        (workspace_id, branch_id, proposal["adventure_id"]),
                    ).fetchone()
                    if not sheet:
                        raise NotFoundError("Adventure character sheet does not exist in this branch")
                    if sheet["updated_revision"] > proposal["created_revision"]:
                        raise ConflictError("RPG state proposal is stale because the character sheet changed after it was proposed")
                    trackers = json.loads(sheet["trackers_json"])
                    location = sheet["current_location"]
                    map_x, map_y = sheet["map_x"], sheet["map_y"]
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
                            "SELECT location_id,x,y FROM story_map_locations WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND name=? COLLATE NOCASE",
                            (workspace_id, branch_id, proposal["adventure_id"], location),
                        ).fetchone()
                        if map_location:
                            map_x, map_y = map_location["x"], map_location["y"]
                            connection.execute(
                                "UPDATE story_map_locations SET status='approved',source_proposal_id=?,reviewed_revision=? "
                                "WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND location_id=?",
                                (proposal_id, revision, workspace_id, branch_id, proposal["adventure_id"], map_location["location_id"]),
                            )
                        else:
                            map_x, map_y = None, None
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
                        "UPDATE rpg_sheets SET trackers_json=?,current_location=?,map_x=?,map_y=?,updated_revision=? "
                        "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                        (_json(trackers), location, map_x, map_y, revision, workspace_id, branch_id, proposal["adventure_id"]),
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
            adventure = connection.execute(
                "SELECT adventure_id FROM story_adventures WHERE workspace_id=? AND branch_id=? AND conversation_id=?",
                (workspace_id, branch_id, conversation_id),
            ).fetchone()
            reconstruction = (
                self._rebuild_rpg_sheet(
                    connection,
                    workspace_id=workspace_id,
                    branch_id=branch_id,
                    adventure_id=adventure["adventure_id"],
                    as_of_revision=revision,
                )
                if adventure else None
            )
            return {
                "conversation_id": conversation_id,
                "turn_id": turn_id,
                "action": action,
                "superseded_count": len(targets) - 1,
                "state_reconstruction": reconstruction,
            }, "story.turn_edited" if action == "edit" else "story.turn_deleted", True

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

        if command_type == "create_story_npc":
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot create canonical NPC identities")
            adventure_id = _required_text(payload.get("adventure_id"), "adventure_id", 100)
            npc_entity_id = _required_text(payload.get("npc_entity_id"), "npc_entity_id", 100)
            label = _required_text(payload.get("label"), "NPC name", 200)
            adventure = connection.execute(
                "SELECT actor_entity_id FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or npc_entity_id == adventure["actor_entity_id"]:
                raise ValidationError("Choose an active adventure and an NPC identity separate from its protagonist")
            if connection.execute(
                "SELECT 1 FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, npc_entity_id),
            ).fetchone():
                raise ConflictError("The NPC identity already exists in this branch")
            aliases = payload.get("aliases", [])
            public_profile = payload.get("public_profile", {})
            private_profile = payload.get("private_profile", {})
            status = payload.get("review_status", "proposed")
            if (not isinstance(aliases, list) or len(aliases) > 20 or
                    any(not isinstance(alias, str) or not alias.strip() or len(alias.strip()) > 100 for alias in aliases) or
                    not isinstance(public_profile, dict) or not isinstance(private_profile, dict) or
                    status not in {"proposed", "accepted", "rejected"}):
                raise ValidationError("NPC aliases, profiles, or review status are invalid")
            if len(_json(public_profile).encode("utf-8")) > 20_000 or len(_json(private_profile).encode("utf-8")) > 20_000:
                raise ValidationError("NPC profiles are limited to 20 KB each")
            now = _now()
            properties_json = _json({"role": "non_player_character"})
            connection.execute(
                "INSERT INTO entities(workspace_id,branch_id,entity_id,entity_type,label,properties_json,created_revision,updated_revision) "
                "VALUES(?,?,?,'character',?,?,?,?)",
                (workspace_id, branch_id, npc_entity_id, label, properties_json, revision, revision),
            )
            connection.execute(
                "INSERT INTO entity_search(workspace_id,branch_id,entity_id,label,properties) VALUES(?,?,?,?,?)",
                (workspace_id, branch_id, npc_entity_id, label, properties_json),
            )
            connection.execute(
                "INSERT INTO story_npc_profiles(workspace_id,branch_id,adventure_id,npc_entity_id,aliases_json,public_profile_json,private_profile_json,review_status,created_revision,updated_revision,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (workspace_id, branch_id, adventure_id, npc_entity_id, _json([alias.strip() for alias in aliases]),
                 _json(public_profile), _json(private_profile), status, revision, revision, now, now),
            )
            return {"adventure_id": adventure_id, "npc_entity_id": npc_entity_id, "label": label,
                    "review_status": status}, "story.npc_created", True

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
                "SELECT x,y FROM story_map_locations WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND name=? COLLATE NOCASE AND status='approved'",
                (workspace_id, branch_id, adventure_id, location),
            ).fetchone()
            if (not isinstance(locations, list) or not any(isinstance(value, str) and value.casefold() == location.casefold() for value in locations)) and not custom:
                raise ValidationError("Travel is limited to locations in the pinned world version")
            connection.execute(
                "UPDATE rpg_sheets SET current_location=?,map_x=?,map_y=?,updated_revision=? WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (location, custom["x"] if custom else None, custom["y"] if custom else None,
                 revision, workspace_id, branch_id, adventure_id),
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
            _validate_image_content(mime_type, data)
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

    def preview_story_turn_edit(
        self,
        workspace_id: str,
        branch_id: str,
        adventure_id: str,
        conversation_id: str,
        turn_id: str,
        action: str = "edit",
    ) -> dict[str, Any]:
        if action not in {"edit", "delete"}:
            raise ValidationError("story turn action must be edit or delete")
        with self.db.lock:
            connection = self.db.connection
            adventure = connection.execute(
                "SELECT conversation_id FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure or adventure["conversation_id"] != conversation_id:
                raise NotFoundError("Adventure does not contain this conversation")
            turn = connection.execute(
                "SELECT turn_order FROM story_turns WHERE workspace_id=? AND branch_id=? AND conversation_id=? AND turn_id=?",
                (workspace_id, branch_id, conversation_id, turn_id),
            ).fetchone()
            if not turn:
                raise NotFoundError("Story turn does not exist in this conversation")
            current_edit = connection.execute(
                "SELECT status FROM story_turn_edits WHERE workspace_id=? AND branch_id=? AND conversation_id=? AND turn_id=? "
                "ORDER BY version DESC LIMIT 1",
                (workspace_id, branch_id, conversation_id, turn_id),
            ).fetchone()
            if current_edit and current_edit["status"] != "active":
                raise ConflictError("Only an active story turn can be edited or deleted")
            affected_turns = [row["turn_id"] for row in connection.execute(
                "SELECT t.turn_id FROM story_turns t WHERE t.workspace_id=? AND t.branch_id=? AND t.conversation_id=? AND t.turn_order>=? "
                "AND COALESCE((SELECT e.status FROM story_turn_edits e WHERE e.workspace_id=t.workspace_id AND e.branch_id=t.branch_id "
                "AND e.conversation_id=t.conversation_id AND e.turn_id=t.turn_id ORDER BY e.version DESC LIMIT 1),'active')='active'",
                (workspace_id, branch_id, conversation_id, turn["turn_order"]),
            ).fetchall()]
            head = connection.execute(
                "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not head:
                raise NotFoundError("Branch does not exist in this workspace")
            current = self._rebuild_rpg_sheet(
                connection, workspace_id=workspace_id, branch_id=branch_id,
                adventure_id=adventure_id, as_of_revision=head["head_revision"], persist=False,
            )
            projected = self._rebuild_rpg_sheet(
                connection, workspace_id=workspace_id, branch_id=branch_id,
                adventure_id=adventure_id, as_of_revision=head["head_revision"],
                force_invalidated_turn_ids=set(affected_turns), persist=False,
            )

        invalidated = []
        for proposal in projected.get("invalidated_proposals", []):
            effects = []
            for change in proposal["changes"]:
                if change["operation"] == "tracker_delta":
                    delta = change["delta"]
                    effects.append(f"{change['tracker_id']}: {delta:+d}")
                elif change["operation"] == "set_location":
                    effects.append(f"Location: {change['location']}")
                elif change["operation"] == "npc_profile":
                    effects.append("NPC profile update")
                elif change["operation"] == "add_event_memory":
                    effects.append("Event memory")
            invalidated.append({
                "proposal_id": proposal["proposal_id"],
                "source_turn_id": proposal["source_turn_id"],
                "effects": effects,
            })
        before = current.get("after")
        after = projected.get("after")
        changed_fields = (
            [key for key in after if after[key] != before[key]]
            if isinstance(before, dict) and isinstance(after, dict) else []
        )
        return {
            "adventure_id": adventure_id,
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            "action": action,
            "turns_to_replace_or_hide": len(affected_turns),
            "state_reconstructed": bool(projected.get("reconstructed")),
            "changed_fields": changed_fields,
            "changed_npc_profiles": projected.get("changed_npc_profiles", []),
            "before": before,
            "after": after,
            "invalidated_proposals": invalidated,
        }

    def _rebuild_rpg_sheet(
        self,
        connection: sqlite3.Connection,
        *,
        workspace_id: str,
        branch_id: str,
        adventure_id: str,
        as_of_revision: int,
        force_invalidated_turn_ids: set[str] | None = None,
        persist: bool = True,
    ) -> dict[str, Any]:
        forced_turns = force_invalidated_turn_ids or set()

        def source_is_current(
            scope_branch: str,
            conversation_id: str,
            source_turn_id: str,
            proposal_revision: int,
            cutoff: int,
        ) -> bool:
            if scope_branch == branch_id and source_turn_id in forced_turns:
                return False
            turn = connection.execute(
                "SELECT 1 FROM story_turns WHERE workspace_id=? AND branch_id=? AND conversation_id=? AND turn_id=?",
                (workspace_id, scope_branch, conversation_id, source_turn_id),
            ).fetchone()
            if not turn:
                return False
            branches_to_check = [(scope_branch, cutoff)]
            if scope_branch != branch_id:
                branches_to_check.append((branch_id, as_of_revision))
            for edit_branch, edit_cutoff in branches_to_check:
                edit = connection.execute(
                    "SELECT status,created_revision FROM story_turn_edits WHERE workspace_id=? AND branch_id=? "
                    "AND conversation_id=? AND turn_id=? AND created_revision<=? ORDER BY version DESC LIMIT 1",
                    (workspace_id, edit_branch, conversation_id, source_turn_id, edit_cutoff),
                ).fetchone()
                if edit and (edit["status"] != "active" or edit["created_revision"] > proposal_revision):
                    return False
            return True

        def map_coordinates(
            scope_branch: str,
            location_name: str,
            cutoff: int,
        ) -> tuple[float | None, float | None]:
            location = connection.execute(
                "SELECT x,y,source_proposal_id FROM story_map_locations WHERE workspace_id=? AND branch_id=? "
                "AND adventure_id=? AND name=? COLLATE NOCASE AND status='approved' AND created_revision<=? "
                "ORDER BY created_revision DESC LIMIT 1",
                (workspace_id, scope_branch, adventure_id, location_name, cutoff),
            ).fetchone()
            if not location:
                return None, None
            proposal_id = location["source_proposal_id"]
            if proposal_id:
                proposal = connection.execute(
                    "SELECT conversation_id,source_turn_id,created_revision,reviewed_revision,review_status "
                    "FROM rpg_state_proposals WHERE workspace_id=? AND branch_id=? AND proposal_id=?",
                    (workspace_id, scope_branch, proposal_id),
                ).fetchone()
                if not proposal or proposal["review_status"] != "accepted" or proposal["reviewed_revision"] is None or proposal["reviewed_revision"] > cutoff:
                    return None, None
                if proposal["source_turn_id"] and not source_is_current(
                    scope_branch, proposal["conversation_id"], proposal["source_turn_id"],
                    proposal["created_revision"], cutoff,
                ):
                    return None, None
            return location["x"], location["y"]

        def initial_sheet(
            envelope: dict[str, Any], scope_branch: str, record_revision: int,
        ) -> tuple[dict[str, Any] | None, int | None]:
            command_type = envelope.get("command_type")
            payload = envelope.get("payload")
            if not isinstance(payload, dict) or payload.get("adventure_id") != adventure_id:
                return None, None
            if command_type == "import_story_adventure":
                imported = payload.get("package", {}).get("adventure", {})
                imported_sheet = imported.get("sheet") if isinstance(imported, dict) else None
                if not isinstance(imported_sheet, dict):
                    return None, None
                packaged_world = payload.get("package", {}).get("world", {})
                packaged_version = imported.get("world_version", 1)
                packaged_versions = packaged_world.get("versions", []) if isinstance(packaged_world, dict) else []
                imported_content = packaged_versions[packaged_version - 1].get("content", {}) \
                    if type(packaged_version) is int and 1 <= packaged_version <= len(packaged_versions) else {}
                ability_definitions = _validated_story_ability_definitions(imported_content)
                ability_states = _validated_story_ability_states(imported_content, imported_sheet.get("ability_states"))
                skill_ranks = _validated_story_skill_ranks(imported_content, imported_sheet.get("skill_ranks"))
                experience = _validated_experience_state(imported_sheet.get("experience"))
                import_audit = connection.execute(
                    "SELECT payload_json FROM audit_events WHERE workspace_id=? AND branch_id=? AND revision=? "
                    "AND event_type='story.adventure_imported'",
                    (workspace_id, scope_branch, record_revision),
                ).fetchone()
                entity_id_map = {}
                if import_audit:
                    try:
                        entity_id_map = json.loads(import_audit["payload_json"]).get("entity_id_map", {})
                    except (TypeError, ValueError, AttributeError):
                        entity_id_map = {}
                imported_npcs = imported.get("npcs", [])
                return ({
                    "stats": imported_sheet.get("stats", {}),
                    "trackers": imported_sheet.get("trackers", {}),
                    "completed_turns": imported.get("completed_turns", 0),
                    "current_location": imported_sheet.get("current_location", ""),
                    "map_region": imported_sheet.get("map_region", ""),
                    "map_x": imported_sheet.get("map_x"),
                    "map_y": imported_sheet.get("map_y"),
                    "map_scale": imported_sheet.get("map_scale", "regional"),
                    "ability_states": ability_states,
                    "skill_ranks": skill_ranks,
                    "experience": experience,
                    "ability_definitions": {item["ability_id"]: item for item in ability_definitions},
                    "npcs": {
                        entity_id_map.get(npc.get("npc_entity_id"), npc.get("npc_entity_id")): {
                            "aliases": npc.get("aliases", []),
                            "public_profile": npc.get("public_profile", {}),
                            "private_profile": npc.get("private_profile", {}),
                            "review_status": npc.get("review_status", "proposed"),
                        }
                        for npc in imported_npcs if isinstance(npc, dict) and npc.get("npc_entity_id")
                    },
                }, None)
            if command_type != "create_story_adventure":
                return None, None
            world = connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, payload.get("world_id"), payload.get("world_version")),
            ).fetchone()
            if not world:
                return None, None
            content = json.loads(world["content_json"])
            ability_definitions = _validated_story_ability_definitions(content)
            return ({
                "stats": _validated_story_character_allocation(
                    content, payload.get("stats"),
                ),
                "completed_turns": 0,
                "trackers": _validated_trackers(content.get("trackers", {
                    "health": {"value": 10, "max": 10},
                })),
                "current_location": content.get("starting_location", ""),
                "map_region": "",
                "map_x": None,
                "map_y": None,
                "map_scale": "regional",
                "ability_states": _initial_story_ability_states(content),
                "skill_ranks": _initial_story_skill_ranks(content),
                "experience": {"manual_awards": 0},
                "ability_definitions": {item["ability_id"]: item for item in ability_definitions},
                "npcs": {},
            }, None)

        def rebuild(
            scope_branch: str,
            cutoff: int,
            visited: set[str],
        ) -> tuple[dict[str, Any] | None, int | None]:
            if scope_branch in visited:
                return None, None
            visited.add(scope_branch)
            branch = connection.execute(
                "SELECT parent_branch_id,parent_revision,base_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, scope_branch),
            ).fetchone()
            if not branch:
                return None, None

            state = None
            start_revision = None
            parent_id, parent_revision = branch["parent_branch_id"], branch["parent_revision"]
            parent_adventure = None
            if parent_id and parent_revision is not None:
                parent_adventure = connection.execute(
                    "SELECT created_revision FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                    (workspace_id, parent_id, adventure_id),
                ).fetchone()
            if parent_adventure and parent_adventure["created_revision"] <= parent_revision:
                state, _ = rebuild(parent_id, parent_revision, visited)
                start_revision = branch["base_revision"]
            else:
                history = connection.execute(
                    "SELECT revision,payload_json FROM revisions WHERE workspace_id=? AND branch_id=? AND revision<=? ORDER BY revision",
                    (workspace_id, scope_branch, cutoff),
                ).fetchall()
                for row in history:
                    try:
                        envelope = json.loads(row["payload_json"])
                    except (TypeError, ValueError):
                        continue
                    state, _ = initial_sheet(envelope, scope_branch, row["revision"])
                    if state is not None:
                        start_revision = row["revision"]
                        break

            if state is None or start_revision is None:
                return None, None

            history = connection.execute(
                "SELECT revision,payload_json FROM revisions WHERE workspace_id=? AND branch_id=? "
                "AND revision>? AND revision<=? ORDER BY revision",
                (workspace_id, scope_branch, start_revision, cutoff),
            ).fetchall()
            for row in history:
                try:
                    envelope = json.loads(row["payload_json"])
                    payload = envelope.get("payload", {})
                except (TypeError, ValueError, AttributeError):
                    continue
                if not isinstance(payload, dict):
                    continue
                command_type = envelope.get("command_type")
                if command_type == "append_story_turn":
                    conversation = connection.execute(
                        "SELECT conversation_id FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                        (workspace_id, scope_branch, adventure_id),
                    ).fetchone()
                    if conversation and payload.get("conversation_id") == conversation["conversation_id"]:
                        state["completed_turns"] += 1
                    continue
                if command_type in {"create_story_npc", "update_story_npc"} and payload.get("adventure_id") == adventure_id:
                    npc_id = payload.get("npc_entity_id")
                    if isinstance(npc_id, str):
                        state["npcs"][npc_id] = {
                            "aliases": payload.get("aliases", []),
                            "public_profile": payload.get("public_profile", {}),
                            "private_profile": payload.get("private_profile", {}),
                            "review_status": payload.get("review_status", "proposed"),
                        }
                    continue
                if command_type == "set_story_ability_active" and payload.get("adventure_id") == adventure_id:
                    ability_id = payload.get("ability_id")
                    active = payload.get("active")
                    runtime = next((item for item in state["ability_states"] if item["ability_id"] == ability_id), None)
                    definition = state["ability_definitions"].get(ability_id)
                    if runtime is None or definition is None or not isinstance(active, bool):
                        continue
                    if runtime["is_active"] == active:
                        continue
                    if active:
                        for cost in definition["costs"]:
                            tracker_name = next((name for name in state["trackers"]
                                                 if name.casefold() == cost["resource"].casefold()), None)
                            if tracker_name is not None:
                                state["trackers"][tracker_name]["value"] = max(
                                    0, state["trackers"][tracker_name]["value"] - cost["amount"],
                                )
                        runtime["activation_count"] += 1
                        runtime["ready_after_turn"] = state["completed_turns"] + (definition["cooldown_turns"] or 0)
                    runtime["is_active"] = active
                    continue
                if command_type == "update_rpg_sheet" and payload.get("adventure_id") == adventure_id:
                    if "stats" in payload:
                        state["stats"] = payload["stats"]
                    if "trackers" in payload:
                        state["trackers"] = payload["trackers"]
                    if "current_location" in payload:
                        new_location = payload["current_location"]
                        if new_location != state["current_location"]:
                            state["map_x"], state["map_y"] = map_coordinates(
                                scope_branch, new_location, cutoff
                            )
                        state["current_location"] = new_location
                    continue

                if command_type == "update_story_skills" and payload.get("adventure_id") == adventure_id:
                    try:
                        state["skill_ranks"] = payload["skill_ranks"]
                    except (KeyError, TypeError):
                        continue
                    continue

                if command_type == "award_story_experience" and payload.get("adventure_id") == adventure_id:
                    amount = payload.get("amount")
                    if type(amount) is int and amount > 0:
                        state["experience"]["manual_awards"] += amount
                    continue

                if command_type == "travel_to_location" and payload.get("adventure_id") == adventure_id:
                    location = payload.get("location")
                    if isinstance(location, str):
                        state["current_location"] = location
                        state["map_x"], state["map_y"] = map_coordinates(
                            scope_branch, location, cutoff
                        )
                    continue

                if command_type != "review_rpg_state_proposal" or payload.get("review_status") != "accepted":
                    continue
                proposal = connection.execute(
                    "SELECT adventure_id,conversation_id,source_turn_id,changes_json,created_revision,reviewed_revision,review_status "
                    "FROM rpg_state_proposals WHERE workspace_id=? AND branch_id=? AND proposal_id=?",
                    (workspace_id, scope_branch, payload.get("proposal_id")),
                ).fetchone()
                if not proposal or proposal["adventure_id"] != adventure_id or proposal["created_revision"] > row["revision"]:
                    continue
                if proposal["review_status"] != "accepted" or proposal["reviewed_revision"] is None or proposal["reviewed_revision"] > cutoff:
                    continue
                source_turn_id = proposal["source_turn_id"]
                if source_turn_id and not source_is_current(
                    scope_branch, proposal["conversation_id"], source_turn_id,
                    proposal["created_revision"], cutoff,
                ):
                    continue
                changes = payload.get("changes", json.loads(proposal["changes_json"]))
                for change in _validated_rpg_changes(changes):
                    if change["operation"] == "tracker_delta":
                        tracker = state["trackers"].get(change["tracker_id"])
                        if tracker:
                            value = tracker["value"] + change["delta"]
                            if 0 <= value <= tracker["max"]:
                                tracker["value"] = value
                    elif change["operation"] == "set_location":
                        state["current_location"] = change["location"]
                        state["map_x"], state["map_y"] = map_coordinates(
                            scope_branch, change["location"], cutoff
                        )
                    elif change["operation"] == "npc_profile":
                        npc = state["npcs"].get(change["npc_entity_id"])
                        if npc and npc["review_status"] == "accepted":
                            npc["public_profile"].update(change["updates"])
            return state, start_revision

        sheet = connection.execute(
            "SELECT stats_json,trackers_json,current_location,map_region,map_x,map_y,map_scale,abilities_json,skills_json,experience_json "
            "FROM rpg_sheets WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
            (workspace_id, branch_id, adventure_id),
        ).fetchone()
        if not sheet:
            return {"reconstructed": False, "reason": "character_sheet_unavailable"}
        before = {
            "stats": json.loads(sheet["stats_json"]),
            "trackers": json.loads(sheet["trackers_json"]),
            "abilities": json.loads(sheet["abilities_json"]),
            "skills": json.loads(sheet["skills_json"]),
            "experience": json.loads(sheet["experience_json"]),
            "current_location": sheet["current_location"],
            "map_region": sheet["map_region"],
            "map_x": sheet["map_x"],
            "map_y": sheet["map_y"],
            "map_scale": sheet["map_scale"],
        }
        before_npcs = {
            row["npc_entity_id"]: {
                "aliases": json.loads(row["aliases_json"]),
                "public_profile": json.loads(row["public_profile_json"]),
                "private_profile": json.loads(row["private_profile_json"]),
                "review_status": row["review_status"],
            }
            for row in connection.execute(
                "SELECT npc_entity_id,aliases_json,public_profile_json,private_profile_json,review_status "
                "FROM story_npc_profiles WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
        }
        after, _ = rebuild(branch_id, as_of_revision, set())
        if after is None:
            return {"reconstructed": False, "reason": "historical_state_snapshot_unavailable"}
        after_values = {
            "stats": after["stats"], "trackers": after["trackers"],
            "current_location": after["current_location"], "map_region": after["map_region"],
            "map_x": after["map_x"], "map_y": after["map_y"], "map_scale": after["map_scale"],
            "abilities": after["ability_states"],
            "skills": after["skill_ranks"],
            "experience": after["experience"],
            "completed_turns": after["completed_turns"],
        }

        invalidated = []
        for proposal in connection.execute(
            "SELECT proposal_id,conversation_id,source_turn_id,created_revision,changes_json "
            "FROM rpg_state_proposals WHERE workspace_id=? AND branch_id=? AND adventure_id=? "
            "AND review_status='accepted' AND reviewed_revision<=? AND source_turn_id IS NOT NULL",
            (workspace_id, branch_id, adventure_id, as_of_revision),
        ).fetchall():
            if not source_is_current(
                branch_id, proposal["conversation_id"], proposal["source_turn_id"],
                proposal["created_revision"], as_of_revision,
            ):
                invalidated.append({
                    "proposal_id": proposal["proposal_id"],
                    "source_turn_id": proposal["source_turn_id"],
                    "changes": json.loads(proposal["changes_json"]),
                })

        changed_fields = [key for key in before if after_values.get(key) != before[key]]
        changed_npcs = [npc_id for npc_id, profile in after["npcs"].items()
                        if before_npcs.get(npc_id) != profile]
        if changed_npcs:
            changed_fields.append("npc_profiles")
        if persist:
            connection.execute(
                "UPDATE rpg_sheets SET stats_json=?,trackers_json=?,current_location=?,map_region=?,map_x=?,map_y=?,map_scale=?,abilities_json=?,skills_json=?,experience_json=?,updated_revision=? "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (_json(after_values["stats"]), _json(after_values["trackers"]), after_values["current_location"],
                 after_values["map_region"], after_values["map_x"], after_values["map_y"], after_values["map_scale"],
                  _json(after_values["abilities"]), _json(after_values["skills"]), _json(after_values["experience"]),
                 as_of_revision, workspace_id, branch_id, adventure_id),
            )
            for npc_id in changed_npcs:
                profile = after["npcs"][npc_id]
                connection.execute(
                    "UPDATE story_npc_profiles SET aliases_json=?,public_profile_json=?,private_profile_json=?,review_status=?,updated_revision=?,updated_at=? "
                    "WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND npc_entity_id=?",
                    (_json(profile["aliases"]), _json(profile["public_profile"]),
                     _json(profile["private_profile"]), profile["review_status"], as_of_revision, _now(),
                     workspace_id, branch_id, adventure_id, npc_id),
                )
            connection.execute(
                "UPDATE story_adventures SET updated_revision=?,updated_at=? "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (as_of_revision, _now(), workspace_id, branch_id, adventure_id),
            )
        return {
            "reconstructed": True,
            "changed_fields": changed_fields,
            "invalidated_proposals": invalidated,
            "before": before,
            "after": after_values,
            "changed_npc_profiles": changed_npcs,
        }

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
                "SELECT w.world_id,v.name,w.latest_version,w.created_at,w.updated_at,w.archived_at,"
                "v.description,v.template_key FROM story_worlds w JOIN story_world_versions v "
                "ON v.workspace_id=w.workspace_id AND v.world_id=w.world_id AND v.version=w.latest_version "
                "WHERE w.workspace_id=? ORDER BY w.updated_at DESC,w.name COLLATE NOCASE",
                (workspace_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _export_world_package_full(self, workspace_id: str, world_id: str) -> dict[str, Any]:
        world = self.get_story_world(workspace_id, world_id)
        return validate_world_package({
            "protocol": "lke.world.v1",
            "provenance": {"workspace_id": workspace_id, "world_id": world_id},
            "versions": [{key: item[key] for key in ("version", "name", "description", "template_key", "content")}
                         for item in reversed(world["versions"])],
        })

    def export_world_package(
        self,
        workspace_id: str,
        world_id: str,
        *,
        export_mode: str = "full_private_archive",
        confirm_private: bool = False,
    ) -> dict[str, Any]:
        if export_mode not in {"full_private_archive", "public_world"}:
            raise ValidationError("World exports support full private archive or public world")
        if not isinstance(confirm_private, bool):
            raise ValidationError("confirm_private must be a boolean")
        package = self._export_world_package_full(workspace_id, world_id)
        if export_mode == "public_world":
            return _public_world_export(package)
        report = _world_export_report(package, export_mode)
        if report["requires_private_confirmation"] and not confirm_private:
            raise ValidationError("Full world archive contains unclassified content; preview and explicitly confirm")
        return package

    def preview_world_export(self, workspace_id: str, world_id: str, export_mode: str) -> dict[str, Any]:
        if export_mode not in {"full_private_archive", "public_world"}:
            raise ValidationError("World exports support full private archive or public world")
        package = self._export_world_package_full(workspace_id, world_id)
        return _world_export_report(package, export_mode)

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

    def export_story_adventure_package(
        self,
        workspace_id: str,
        branch_id: str,
        adventure_id: str,
        *,
        export_mode: str = "shareable_adventure",
        confirm_private: bool = False,
        selection: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if export_mode not in {"full_private_archive", "shareable_adventure", "public_world", "selected_content"}:
            raise ValidationError("Choose a supported adventure export mode")
        if not isinstance(confirm_private, bool):
            raise ValidationError("confirm_private must be a boolean")
        with self.db.lock:
            adventure = self.db.connection.execute(
                "SELECT adventure_id,world_id,world_version,conversation_id,name,actor_entity_id,status,completed_turns,npc_simulation_enabled,source_archive_json "
                "FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure:
                raise NotFoundError("Adventure does not exist in this branch")
            conversation = self.db.connection.execute(
                "SELECT title,actor_is_user_controlled FROM story_conversations "
                "WHERE workspace_id=? AND branch_id=? AND conversation_id=?",
                (workspace_id, branch_id, adventure["conversation_id"]),
            ).fetchone()
            sheet = self.db.connection.execute(
                "SELECT stats_json,trackers_json,current_location,map_region,map_x,map_y,map_scale,abilities_json,skills_json,experience_json FROM rpg_sheets "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not conversation or not sheet:
                raise ValidationError("Adventure is missing its conversation or character sheet")
            turns = self.db.connection.execute(
                "SELECT turn_id,turn_order,role,narrative_order,content,provider,model,created_at,metadata_json "
                "FROM story_turns WHERE workspace_id=? AND branch_id=? AND conversation_id=? ORDER BY turn_order",
                (workspace_id, branch_id, adventure["conversation_id"]),
            ).fetchall()
            edits = self.db.connection.execute(
                "SELECT turn_id,version,content,status,provider,model,created_at FROM story_turn_edits "
                "WHERE workspace_id=? AND branch_id=? AND conversation_id=? ORDER BY turn_id,version",
                (workspace_id, branch_id, adventure["conversation_id"]),
            ).fetchall()
            checks = self.db.connection.execute(
                "SELECT check_id,stat_name,die_roll,modifier,total,target,outcome,created_at FROM rpg_checks "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY created_revision,check_id",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
            mechanic_checks = self.db.connection.execute(
                "SELECT check_id,encounter_type,stat_name,skill_id,dice_json,resolution,modifier,total,target,difficulty_id,outcome,rules_json,created_at "
                "FROM rpg_mechanic_checks WHERE workspace_id=? AND branch_id=? AND adventure_id=? "
                "ORDER BY created_revision,check_id",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
            proposal_rows = self.db.connection.execute(
                "SELECT proposal_id,source_turn_id,changes_json,review_status,created_at FROM rpg_state_proposals "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY created_revision,proposal_id",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
            memory_rows = self.db.connection.execute(
                "SELECT memory_id,version,kind,content,context_enabled,review_status,source_turn_id,narrative_order,supersedes_version,importance,knowledge_scope,known_by_json,created_at "
                "FROM story_memories WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY memory_id,version",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
            threads = self.db.connection.execute(
                "SELECT thread_id,title,detail,status,created_at,updated_at FROM story_threads "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY thread_id",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
            npc_rows = self.db.connection.execute(
                "SELECT npc_entity_id,aliases_json,public_profile_json,private_profile_json,review_status,created_at,updated_at "
                "FROM story_npc_profiles WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY npc_entity_id",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
            asset_rows = self.db.connection.execute(
                "SELECT asset_id,target_kind,target_id,display_name,mime_type,content,provenance_json,created_at "
                "FROM story_assets WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY asset_id",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()
            locations = self.db.connection.execute(
                "SELECT location_id,name,status,source_proposal_id,created_at,location_type,description,icon,x,y FROM story_map_locations "
                "WHERE workspace_id=? AND branch_id=? AND adventure_id=? ORDER BY location_id",
                (workspace_id, branch_id, adventure_id),
            ).fetchall()

            proposal_data = [
                {"proposal_id": row["proposal_id"], "source_turn_id": row["source_turn_id"],
                 "changes": json.loads(row["changes_json"]), "review_status": row["review_status"],
                 "created_at": row["created_at"]}
                for row in proposal_rows
            ]
            memory_data = [
                {"memory_id": row["memory_id"], "version": row["version"], "kind": row["kind"],
                 "content": row["content"], "context_enabled": bool(row["context_enabled"]),
                 "review_status": row["review_status"], "source_turn_id": row["source_turn_id"],
                 "narrative_order": row["narrative_order"], "supersedes_version": row["supersedes_version"],
                 "importance": row["importance"], "knowledge_scope": row["knowledge_scope"],
                 "known_by": json.loads(row["known_by_json"]), "created_at": row["created_at"]}
                for row in memory_rows
            ]
            npc_data = [
                {"npc_entity_id": row["npc_entity_id"], "aliases": json.loads(row["aliases_json"]),
                 "public_profile": json.loads(row["public_profile_json"]),
                 "private_profile": json.loads(row["private_profile_json"]),
                 "review_status": row["review_status"], "created_at": row["created_at"],
                 "updated_at": row["updated_at"]}
                for row in npc_rows
            ]
            asset_data = [
                {"asset_id": row["asset_id"], "target_kind": row["target_kind"],
                 "target_id": row["target_id"], "display_name": row["display_name"],
                 "mime_type": row["mime_type"], "data_base64": base64.b64encode(row["content"]).decode("ascii"),
                 "provenance": json.loads(row["provenance_json"]), "created_at": row["created_at"]}
                for row in asset_rows
            ]

            entity_ids = {adventure["actor_entity_id"]}
            entity_ids.update(npc["npc_entity_id"] for npc in npc_data)
            for proposal in proposal_data:
                for change in proposal["changes"]:
                    if change.get("operation") == "npc_profile":
                        entity_ids.add(change["npc_entity_id"])
                    elif change.get("operation") == "add_event_memory":
                        entity_ids.update(change.get("known_by", []))
            for memory in memory_data:
                entity_ids.update(memory["known_by"])
            entity_ids.update(
                asset["target_id"] for asset in asset_data if asset["target_kind"] == "character"
            )
            entity_rows = self.db.connection.execute(
                "SELECT entity_id,entity_type,label,properties_json FROM entities "
                "WHERE workspace_id=? AND branch_id=? ORDER BY entity_id",
                (workspace_id, branch_id),
            ).fetchall()
            entities = [
                {"entity_id": row["entity_id"], "entity_type": row["entity_type"], "label": row["label"],
                 "properties": json.loads(row["properties_json"])}
                for row in entity_rows if row["entity_id"] in entity_ids
            ]
            if {entity["entity_id"] for entity in entities} != entity_ids:
                raise ValidationError("Adventure records reference a character that is missing from this branch")

            package_adventure = {
                "name": adventure["name"], "world_version": adventure["world_version"],
                "status": adventure["status"], "completed_turns": adventure["completed_turns"],
                "npc_simulation_enabled": bool(adventure["npc_simulation_enabled"]),
                "actor_entity_id": adventure["actor_entity_id"], "entities": entities,
                "conversation": {"title": conversation["title"],
                                 "actor_is_user_controlled": bool(conversation["actor_is_user_controlled"])},
                "sheet": {"stats": json.loads(sheet["stats_json"]), "trackers": json.loads(sheet["trackers_json"]),
                          "current_location": sheet["current_location"], "map_region": sheet["map_region"],
                          "map_x": sheet["map_x"], "map_y": sheet["map_y"], "map_scale": sheet["map_scale"],
                           "ability_states": json.loads(sheet["abilities_json"]),
                           "skill_ranks": json.loads(sheet["skills_json"]),
                           "experience": json.loads(sheet["experience_json"])},
                "turns": [{**{key: row[key] for key in ("turn_id", "turn_order", "role", "narrative_order", "content", "provider", "model", "created_at")},
                           "metadata": json.loads(row["metadata_json"]) if row["metadata_json"] else None}
                          for row in turns], "turn_edits": [dict(row) for row in edits],
                "checks": [dict(row) for row in checks],
                "mechanic_checks": [
                    {**{key: row[key] for key in ("check_id", "encounter_type", "stat_name", "skill_id", "resolution", "modifier", "total", "target", "difficulty_id", "outcome", "created_at")},
                     "dice_rolls": json.loads(row["dice_json"]), "rules": json.loads(row["rules_json"])}
                    for row in mechanic_checks
                ],
                "proposals": proposal_data,
                "memories": memory_data, "threads": [dict(row) for row in threads],
                "npcs": npc_data, "assets": asset_data, "locations": [dict(row) for row in locations],
                "source_archive": json.loads(adventure["source_archive_json"]) if adventure["source_archive_json"] else None,
            }
            source_world_id = adventure["world_id"]
            source_adventure_id = adventure["adventure_id"]

        package = {
            "protocol": "lke.adventure.v1",
            "provenance": {"workspace_id": workspace_id, "branch_id": branch_id,
                           "adventure_id": source_adventure_id, "exported_at": _now()},
            "world": self.export_world_package(
                workspace_id, source_world_id, export_mode="full_private_archive", confirm_private=True,
            ),
            "context_manifests_included": False,
            "adventure": package_adventure,
        }
        clean = validate_adventure_package(package)
        for asset in clean["adventure"]["assets"]:
            asset["data_base64"] = base64.b64encode(asset.pop("content")).decode("ascii")
        if export_mode == "public_world":
            return _public_world_export(clean["world"])
        if export_mode == "shareable_adventure":
            return _encode_adventure_assets(_shareable_adventure_export(clean))
        if export_mode == "selected_content":
            selected = _selected_adventure_export(clean, selection)
            report = _adventure_export_report(selected, export_mode)
            if report["requires_private_confirmation"] and not confirm_private:
                raise ValidationError("Selected content contains private records; preview and explicitly confirm")
            return _encode_adventure_assets(selected)
        report = _adventure_export_report(clean, export_mode)
        if report["requires_private_confirmation"] and not confirm_private:
            raise ValidationError("Full private archive contains private records; preview and explicitly confirm")
        return clean

    def preview_story_adventure_export(
        self,
        workspace_id: str,
        branch_id: str,
        adventure_id: str,
        export_mode: str,
        selection: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raw = self.export_story_adventure_package(
            workspace_id, branch_id, adventure_id,
            export_mode="full_private_archive", confirm_private=True,
        )
        if export_mode == "full_private_archive":
            return _adventure_export_report(raw, export_mode)
        if export_mode == "shareable_adventure":
            output = _shareable_adventure_export(raw)
            report = _adventure_export_report(raw, export_mode)
            report["included"] = _adventure_export_report(output, export_mode)["included"]
            return report
        if export_mode == "public_world":
            output = _public_world_export(raw["world"])
            return {"mode": export_mode, "included": {"world_versions": len(output["versions"]),
                    "world_fields_per_version": sorted({key for version in output["versions"] for key in version["content"]})},
                    "excluded": {"source_archives_and_unclassified_content": True},
                    "requires_private_confirmation": False}
        if export_mode == "selected_content":
            output = _selected_adventure_export(raw, selection)
            return _adventure_export_report(output, export_mode)
        raise ValidationError("Choose a supported adventure export mode")

    def preview_story_adventure_package(self, workspace_id: str, package: Any) -> dict[str, Any]:
        self.current_revision(workspace_id, "main")
        clean = validate_adventure_package(package)
        source_world_id = clean["world"]["provenance"]["world_id"]
        matching_world_id: str | None = None
        source_id_conflict = False
        with self.db.lock:
            source_exists = self.db.connection.execute(
                "SELECT 1 FROM story_worlds WHERE workspace_id=? AND world_id=?",
                (workspace_id, source_world_id),
            ).fetchone()
            source_id_conflict = source_exists is not None
        for world_row in self.list_story_worlds(workspace_id):
            existing = self._export_world_package_full(workspace_id, world_row["world_id"])
            if existing["versions"] == clean["world"]["versions"]:
                matching_world_id = world_row["world_id"]
                break

        with self.db.lock:
            entity_conflicts = []
            for entity in clean["adventure"]["entities"]:
                existing = self.db.connection.execute(
                    "SELECT entity_type,label,properties_json FROM entities WHERE workspace_id=? AND branch_id='main' AND entity_id=?",
                    (workspace_id, entity["entity_id"]),
                ).fetchone()
                if existing and (
                    existing["entity_type"] != entity["entity_type"]
                    or existing["label"] != entity["label"]
                    or json.loads(existing["properties_json"]) != entity["properties"]
                ):
                    entity_conflicts.append({"entity_id": entity["entity_id"], "label": entity["label"],
                                             "existing_label": existing["label"]})

        data = clean["adventure"]
        return {
            "protocol": clean["protocol"], "provenance": clean["provenance"],
            "name": data["name"], "world_version": data["world_version"],
            "turns": len(data["turns"]), "memories": len(data["memories"]),
            "characters": len(data["entities"]), "images": len(data["assets"]),
            "source_world_id_conflict": source_id_conflict,
            "matching_world_id": matching_world_id,
            "world_import_required": matching_world_id is None,
            "entity_id_conflicts": entity_conflicts,
            "context_manifests_included": False,
            "import_mode": "duplicate",
        }

    def import_story_adventure_bundle(
        self,
        *,
        workspace_id: str,
        expected_revision: int,
        idempotency_key: str,
        adventure_id: str,
        package: Any,
        adventure_name: str | None = None,
    ) -> dict[str, Any]:
        """Import a packaged world and adventure as one recoverable database operation."""
        clean = validate_adventure_package(package)
        key = _required_text(idempotency_key, "idempotency_key", 200)
        adventure_id = _required_text(adventure_id, "adventure_id", 100)
        if adventure_name is not None:
            adventure_name = _required_text(adventure_name, "name", 200)
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValidationError("expected_revision must be a non-negative integer")

        branch_id = adventure_id
        reason = "Import a reviewed adventure as an isolated duplicate"
        request = {
            "workspace_id": workspace_id,
            "branch_id": branch_id,
            "command_type": "import_story_adventure_bundle",
            "expected_revision": expected_revision,
            "payload": {
                "adventure_id": adventure_id,
                "package": package,
                **({"name": adventure_name} if adventure_name is not None else {}),
            },
            "actor": "user",
            "reason": reason,
        }
        request_hash = _command_request_hash(request)
        digest = hashlib.sha256(f"{workspace_id}:{key}".encode("utf-8")).hexdigest()
        world_id = "world_import_" + digest[:20]
        conversation_id = "conversation_" + digest[:20]

        with self.db.lock:
            connection = self.db.connection
            connection.execute("BEGIN IMMEDIATE")
            try:
                prior = connection.execute(
                    "SELECT request_hash,result_json FROM commands WHERE workspace_id=? AND idempotency_key=?",
                    (workspace_id, key),
                ).fetchone()
                if prior:
                    if prior["request_hash"] != request_hash:
                        raise IdempotencyConflictError("Idempotency key was already used for another command")
                    connection.commit()
                    return {**json.loads(prior["result_json"]), "idempotent_replay": True}

                main = connection.execute(
                    "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id='main'",
                    (workspace_id,),
                ).fetchone()
                if not main:
                    raise NotFoundError("Workspace main branch does not exist")
                if main["head_revision"] != expected_revision:
                    raise ConflictError(
                        f"Expected revision {expected_revision}; current revision is {main['head_revision']}"
                    )
                if connection.execute(
                    "SELECT 1 FROM branches WHERE workspace_id=? AND branch_id=?",
                    (workspace_id, branch_id),
                ).fetchone():
                    raise ConflictError("Adventure branch already exists; import as a new duplicate")

                matching_world_id = None
                for row in connection.execute(
                    "SELECT world_id FROM story_worlds WHERE workspace_id=? ORDER BY world_id",
                    (workspace_id,),
                ).fetchall():
                    existing = self._export_world_package_full(workspace_id, row["world_id"])
                    if existing["versions"] == clean["world"]["versions"]:
                        matching_world_id = row["world_id"]
                        break

                world_imported = matching_world_id is None
                if matching_world_id:
                    world_id = matching_world_id
                else:
                    occupied_world = connection.execute(
                        "SELECT 1 FROM story_worlds WHERE workspace_id=? AND world_id=?",
                        (workspace_id, world_id),
                    ).fetchone()
                    if occupied_world:
                        existing = self._export_world_package_full(workspace_id, world_id)
                        if existing["versions"] != clean["world"]["versions"]:
                            raise ConflictError("The deterministic imported world ID belongs to different content")
                        world_imported = False
                    else:
                        world_command_id, world_now = str(uuid4()), _now()
                        world_key = f"adventure-bundle:{digest[:32]}:world"
                        world_payload = {"world_id": world_id, "package": clean["world"]}
                        world_request = {
                            "workspace_id": workspace_id,
                            "branch_id": "main",
                            "command_type": "import_story_world",
                            "expected_revision": expected_revision,
                            "payload": world_payload,
                            "actor": "user",
                            "reason": "Import the world packaged with a reviewed adventure",
                        }
                        world_hash = _command_request_hash(world_request)
                        world_result, world_event, world_changed = self._apply(
                            connection, workspace_id, "main", expected_revision + 1,
                            "import_story_world", world_payload, "user",
                        )
                        if not world_changed:
                            raise ValidationError("World package import did not produce a canonical change")
                        world_revision = expected_revision + 1
                        world_result.update({
                            "revision": world_revision,
                            "workspace_id": workspace_id,
                            "branch_id": "main",
                            "command_id": world_command_id,
                        })
                        connection.execute(
                            "INSERT INTO revisions(workspace_id,branch_id,revision,command_id,parent_revision,actor,reason,created_at,payload_json) "
                            "VALUES(?,?,?,?,?,?,?,?,?)",
                            (workspace_id, "main", world_revision, world_command_id, expected_revision,
                             "user", world_request["reason"], world_now, _json(world_request)),
                        )
                        connection.execute(
                            "UPDATE branches SET head_revision=? WHERE workspace_id=? AND branch_id='main'",
                            (world_revision, workspace_id),
                        )
                        connection.execute(
                            "INSERT INTO audit_events(event_id,workspace_id,branch_id,revision,command_id,event_type,actor,reason,payload_json,created_at) "
                            "VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (str(uuid4()), workspace_id, "main", world_revision, world_command_id,
                             world_event, "user", world_request["reason"], _json(world_result), world_now),
                        )
                        connection.execute(
                            "INSERT INTO projection_outbox(outbox_id,workspace_id,branch_id,revision,projection,created_at) "
                            "VALUES(?,?,?,?, 'all', ?)",
                            (str(uuid4()), workspace_id, "main", world_revision, world_now),
                        )
                        connection.execute(
                            "INSERT INTO commands(workspace_id,idempotency_key,request_hash,branch_id,result_json,created_at) "
                            "VALUES(?,?,?,?,?,?)",
                            (workspace_id, world_key, world_hash, "main", _json(world_result), world_now),
                        )

                parent_revision = expected_revision + (1 if world_imported else 0)
                snapshot_key = f"adventure-bundle:{digest[:32]}:snapshot"
                snapshot_envelope = {
                    "operation": "create_branch",
                    "workspace_id": workspace_id,
                    "parent_branch_id": "main",
                    "branch_id": branch_id,
                    "expected_revision": parent_revision,
                    "actor": "user",
                    "reason": "Create isolated adventure import snapshot",
                }
                snapshot_command_id, snapshot_now = str(uuid4()), _now()
                _snapshot_branch(
                    connection,
                    workspace_id=workspace_id,
                    parent_branch_id="main",
                    branch_id=branch_id,
                    revision=parent_revision,
                    actor="user",
                    reason=snapshot_envelope["reason"],
                    command_id=snapshot_command_id,
                    idempotency_key=snapshot_key,
                    request_hash=hashlib.sha256(_json(snapshot_envelope).encode("utf-8")).hexdigest(),
                    envelope=snapshot_envelope,
                    created_at=snapshot_now,
                )

                imported_revision = parent_revision + 1
                import_command_id, import_now = str(uuid4()), _now()
                import_payload = {
                    "adventure_id": adventure_id,
                    "conversation_id": conversation_id,
                    "world_id": world_id,
                    "world_version": clean["adventure"]["world_version"],
                    "package": package,
                    **({"name": adventure_name} if adventure_name is not None else {}),
                }
                import_request = {
                    "workspace_id": workspace_id,
                    "branch_id": branch_id,
                    "command_type": "import_story_adventure",
                    "expected_revision": parent_revision,
                    "payload": import_payload,
                    "actor": "user",
                    "reason": reason,
                }
                import_hash = _command_request_hash(import_request)
                imported, import_event, import_changed = self._apply(
                    connection, workspace_id, branch_id, imported_revision,
                    "import_story_adventure", import_payload, "user",
                )
                if not import_changed:
                    raise ValidationError("Adventure package import did not produce a canonical change")
                imported.update({
                    "revision": imported_revision,
                    "workspace_id": workspace_id,
                    "branch_id": branch_id,
                    "command_id": import_command_id,
                })
                connection.execute(
                    "INSERT INTO revisions(workspace_id,branch_id,revision,command_id,parent_revision,actor,reason,created_at,payload_json) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (workspace_id, branch_id, imported_revision, import_command_id, parent_revision,
                     "user", reason, import_now, _json(import_request)),
                )
                connection.execute(
                    "UPDATE branches SET head_revision=? WHERE workspace_id=? AND branch_id=?",
                    (imported_revision, workspace_id, branch_id),
                )
                connection.execute(
                    "INSERT INTO audit_events(event_id,workspace_id,branch_id,revision,command_id,event_type,actor,reason,payload_json,created_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (str(uuid4()), workspace_id, branch_id, imported_revision, import_command_id,
                     import_event, "user", reason, _json(imported), import_now),
                )
                connection.execute(
                    "INSERT INTO projection_outbox(outbox_id,workspace_id,branch_id,revision,projection,created_at) "
                    "VALUES(?,?,?,?, 'all', ?)",
                    (str(uuid4()), workspace_id, branch_id, imported_revision, import_now),
                )
                import_key = f"adventure-bundle:{digest[:32]}:import"
                connection.execute(
                    "INSERT INTO commands(workspace_id,idempotency_key,request_hash,branch_id,result_json,created_at) "
                    "VALUES(?,?,?,?,?,?)",
                    (workspace_id, import_key, import_hash, branch_id, _json(imported), import_now),
                )

                imported["world_imported"] = world_imported
                connection.execute(
                    "INSERT INTO commands(workspace_id,idempotency_key,request_hash,branch_id,result_json,created_at) "
                    "VALUES(?,?,?,?,?,?)",
                    (workspace_id, key, request_hash, branch_id, _json(imported), import_now),
                )
                connection.commit()
                return {**imported, "idempotent_replay": False}
            except (ConflictError, IdempotencyConflictError, NotFoundError, ValidationError):
                connection.rollback()
                raise
            except sqlite3.IntegrityError as error:
                connection.rollback()
                raise ConflictError("Adventure import conflicts with existing canonical records") from error
            except BaseException:
                connection.rollback()
                raise

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

    def validate_story_character_allocation(
        self,
        workspace_id: str,
        world_id: str,
        world_version: int,
        allocation: Any = None,
    ) -> dict[str, int]:
        """Preflight a character sheet against the exact world version being pinned."""
        world = self.get_story_world(workspace_id, world_id)
        version = next((item for item in world["versions"] if item["version"] == world_version), None)
        if version is None:
            raise NotFoundError("Pinned world version does not exist in this workspace")
        return _validated_story_character_allocation(version["content"], allocation)

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
                "a.conversation_id,a.name,a.actor_entity_id,e.label AS actor_label,a.status,a.archived_at,"
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

    def get_rpg_state(
        self, workspace_id: str, branch_id: str, adventure_id: str, *, as_of_revision: int | None = None,
    ) -> dict[str, Any]:
        with self.db.lock:
            historical_sheet = None
            if as_of_revision is not None:
                if type(as_of_revision) is not int or as_of_revision < 0:
                    raise ValidationError("as_of_revision must be a non-negative integer")
                branch = self.db.connection.execute(
                    "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                    (workspace_id, branch_id),
                ).fetchone()
                if not branch:
                    raise NotFoundError("Branch does not exist in this workspace")
                if as_of_revision > branch["head_revision"]:
                    raise ConflictError("Requested RPG snapshot is newer than the branch head")
            adventure = self.db.connection.execute(
                "SELECT adventure_id,world_id,world_version,conversation_id,name,actor_entity_id,status,created_revision,updated_revision,completed_turns,npc_simulation_enabled "
                "FROM story_adventures WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            if not adventure:
                raise NotFoundError("Adventure does not exist in this branch")
            if as_of_revision is not None:
                if as_of_revision < adventure["created_revision"]:
                    raise NotFoundError("Adventure does not exist at the requested revision")
                reconstruction = self._rebuild_rpg_sheet(
                    self.db.connection, workspace_id=workspace_id, branch_id=branch_id,
                    adventure_id=adventure_id, as_of_revision=as_of_revision, persist=False,
                )
                if not reconstruction.get("reconstructed"):
                    raise ValidationError("RPG state could not be reconstructed at the requested revision")
                historical_sheet = reconstruction["after"]
            sheet = self.db.connection.execute(
                "SELECT stats_json,trackers_json,current_location,created_revision,updated_revision,map_region,map_x,map_y,map_scale,abilities_json,skills_json,experience_json "
                "FROM rpg_sheets WHERE workspace_id=? AND branch_id=? AND adventure_id=?",
                (workspace_id, branch_id, adventure_id),
            ).fetchone()
            world = self.db.connection.execute(
                "SELECT content_json FROM story_world_versions WHERE workspace_id=? AND world_id=? AND version=?",
                (workspace_id, adventure["world_id"], adventure["world_version"]),
            ).fetchone()
            if not world:
                raise NotFoundError("Pinned ability definitions do not exist in this workspace")
            world_content = json.loads(world["content_json"])
            ability_definitions = _validated_story_ability_definitions(world_content)
            mechanics = _validated_story_mechanics(world_content)
            check_query = (
                "SELECT check_id,conversation_id,actor_entity_id,stat_name,die_roll,modifier,total,target,outcome,created_revision,created_at "
                "FROM rpg_checks WHERE workspace_id=? AND branch_id=? AND adventure_id=?"
            )
            check_parameters: tuple[Any, ...] = (workspace_id, branch_id, adventure_id)
            if as_of_revision is not None:
                check_query += " AND created_revision<=?"
                check_parameters += (as_of_revision,)
            checks = self.db.connection.execute(
                check_query + " ORDER BY created_revision DESC LIMIT 50", check_parameters,
            ).fetchall()
            mechanic_check_query = (
                "SELECT check_id,conversation_id,actor_entity_id,encounter_type,stat_name,skill_id,dice_json,resolution,modifier,total,target,difficulty_id,outcome,rules_json,created_revision,created_at "
                "FROM rpg_mechanic_checks WHERE workspace_id=? AND branch_id=? AND adventure_id=?"
            )
            if as_of_revision is not None:
                mechanic_check_query += " AND created_revision<=?"
            mechanic_checks = self.db.connection.execute(
                mechanic_check_query + " ORDER BY created_revision DESC LIMIT 50", check_parameters,
            ).fetchall()
            proposal_query = (
                "SELECT proposal_id,conversation_id,source_turn_id,changes_json,review_status,created_revision,reviewed_revision,created_at "
                "FROM rpg_state_proposals WHERE workspace_id=? AND branch_id=? AND adventure_id=?"
            )
            proposal_parameters: tuple[Any, ...] = (workspace_id, branch_id, adventure_id)
            if as_of_revision is not None:
                proposal_query += " AND created_revision<=?"
                proposal_parameters += (as_of_revision,)
            proposal_rows = self.db.connection.execute(
                proposal_query + " ORDER BY created_revision DESC", proposal_parameters,
            ).fetchall()
            proposals = []
            for row in proposal_rows:
                proposal = dict(row)
                if (as_of_revision is not None and proposal["reviewed_revision"] is not None
                        and proposal["reviewed_revision"] > as_of_revision):
                    proposal["review_status"] = "proposed"
                    proposal["reviewed_revision"] = None
                proposals.append(proposal)
        sheet_data = dict(sheet) if sheet else None
        if historical_sheet is not None and sheet_data is not None:
            for field in ("stats", "trackers", "current_location", "map_region", "map_x", "map_y", "map_scale", "skills", "experience"):
                sheet_data[field] = historical_sheet[field]
            sheet_data["abilities"] = historical_sheet["abilities"]
            adventure_data = {**dict(adventure), "completed_turns": historical_sheet["completed_turns"]}
            ability_states = _validated_story_ability_states(world_content, historical_sheet["abilities"])
        else:
            ability_states = _validated_story_ability_states(world_content, json.loads(sheet["abilities_json"])) if sheet else []
            if sheet_data is not None:
                sheet_data["abilities"] = ability_states
                sheet_data["skills"] = _validated_story_skill_ranks(world_content, json.loads(sheet["skills_json"]))
                sheet_data["experience"] = _validated_experience_state(json.loads(sheet["experience_json"]))
            adventure_data = dict(adventure)
        ability_states_by_id = {item["ability_id"]: item for item in ability_states}
        abilities = [
            {**definition, **ability_states_by_id[definition["ability_id"]]}
            for definition in ability_definitions
        ]
        if sheet_data is not None:
            sheet_data["experience"] = _story_experience_summary(
                mechanics, sheet_data["experience"], adventure_data["completed_turns"],
            )
        return {
            "adventure": {**adventure_data, "npc_simulation_enabled": bool(adventure["npc_simulation_enabled"])},
            "sheet": {
                **sheet_data,
                "stats": historical_sheet["stats"] if historical_sheet is not None else json.loads(sheet["stats_json"]),
                "trackers": historical_sheet["trackers"] if historical_sheet is not None else json.loads(sheet["trackers_json"]),
                "skills": historical_sheet["skills"] if historical_sheet is not None else json.loads(sheet["skills_json"]),
                "abilities": abilities,
                "ability_states": ability_states,
            } if sheet else None,
            "mechanics": mechanics,
            "checks": [dict(row) for row in checks],
            "mechanic_checks": [
                {**dict(row), "dice": json.loads(row["dice_json"]), "rules": json.loads(row["rules_json"])}
                for row in mechanic_checks
            ],
            "proposals": [
                {**row, "changes": json.loads(row["changes_json"])}
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

    def list_story_locations(
        self,
        workspace_id: str,
        branch_id: str,
        adventure_id: str,
        as_of_revision: int | None = None,
    ) -> list[dict[str, Any]]:
        with self.db.lock:
            connection = self.db.connection
            head = connection.execute(
                "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not head:
                raise NotFoundError("Branch does not exist in this workspace")
            cutoff = head["head_revision"] if as_of_revision is None else as_of_revision
            rows = connection.execute(
                "SELECT location_id,name,status,source_proposal_id,created_revision,reviewed_revision,created_at,location_type,description,icon,x,y "
                "FROM story_map_locations WHERE workspace_id=? AND branch_id=? AND adventure_id=? AND created_revision<=? ORDER BY name COLLATE NOCASE",
                (workspace_id, branch_id, adventure_id, cutoff),
            ).fetchall()
            result = []
            for row in rows:
                location = dict(row)
                location["effective_status"] = row["status"]
                proposal_id = row["source_proposal_id"]
                if row["status"] == "approved" and proposal_id:
                    proposal = connection.execute(
                        "SELECT conversation_id,source_turn_id,created_revision,reviewed_revision,review_status "
                        "FROM rpg_state_proposals WHERE workspace_id=? AND branch_id=? AND proposal_id=?",
                        (workspace_id, branch_id, proposal_id),
                    ).fetchone()
                    if (
                        not proposal
                        or proposal["review_status"] != "accepted"
                        or proposal["reviewed_revision"] is None
                        or proposal["reviewed_revision"] > cutoff
                    ):
                        location["effective_status"] = "superseded"
                    elif proposal["source_turn_id"]:
                        source = connection.execute(
                            "SELECT t.turn_id,COALESCE((SELECT e.status FROM story_turn_edits e "
                            "WHERE e.workspace_id=t.workspace_id AND e.branch_id=t.branch_id "
                            "AND e.conversation_id=t.conversation_id AND e.turn_id=t.turn_id "
                            "AND e.created_revision<=? ORDER BY e.version DESC LIMIT 1),'active') AS status, "
                            "(SELECT e.created_revision FROM story_turn_edits e "
                            "WHERE e.workspace_id=t.workspace_id AND e.branch_id=t.branch_id "
                            "AND e.conversation_id=t.conversation_id AND e.turn_id=t.turn_id "
                            "AND e.created_revision<=? ORDER BY e.version DESC LIMIT 1) AS edit_revision "
                            "FROM story_turns t WHERE t.workspace_id=? AND t.branch_id=? "
                            "AND t.conversation_id=? AND t.turn_id=?",
                            (cutoff, cutoff, workspace_id, branch_id, proposal["conversation_id"], proposal["source_turn_id"]),
                        ).fetchone()
                        if (
                            not source
                            or source["status"] != "active"
                            or (source["edit_revision"] is not None
                                and source["edit_revision"] > proposal["created_revision"])
                        ):
                            location["effective_status"] = "superseded"
                result.append(location)
        return result

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
                "context_manifest_id,context_manifest_json,context_revision,created_revision,created_at,metadata_json "
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
            metadata_json = item.pop("metadata_json")
            item["metadata"] = json.loads(metadata_json) if metadata_json else None
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

