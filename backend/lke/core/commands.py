"""Validated, revisioned writes to the canonical knowledge store."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import date, datetime, timezone
from typing import Any
from uuid import uuid4

from .database import Database
from .errors import ConflictError, IdempotencyConflictError, NotFoundError, ValidationError
from ..reasoning import evaluate_rule


_ALLOWED_COMMANDS = {
    "create_entity", "update_entity", "add_relation", "review_relation", "add_claim",
    "review_claim", "add_belief", "import_source", "add_evidence",
    "create_conversation", "append_story_turn", "create_journal_event", "revise_journal_event",
    "create_rule", "review_rule",
}
_SEARCH_TOKEN = re.compile(r'"([^"\s]+)"|([^\s]+)')


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _required_text(value: Any, field: str, limit: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValidationError(f"{field} must be non-empty text of at most {limit} characters")
    return value.strip()


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
    return hashlib.sha256(_json(stable_request).encode("utf-8")).hexdigest()


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
                connection.execute(
                    "INSERT INTO branches(workspace_id,branch_id,parent_branch_id,parent_revision,base_revision,head_revision,created_at) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (workspace_id, branch_id, parent_branch_id, expected_revision, expected_revision, expected_revision, now),
                )
                for table, columns in (
                    ("entities", "entity_id,entity_type,label,properties_json,created_revision,updated_revision"),
                    ("relations", "relation_id,source_entity_id,target_entity_id,relation_type,properties_json,review_status,created_revision"),
                    ("claims", "claim_id,subject_entity_id,predicate,object_value,epistemic_status,review_status,visibility,narrative_order,evidence_json,created_revision"),
                    ("rules", "rule_id,name,description,rule_mode,severity,subject_entity_id,predicate,object_value,predicate_cardinality,review_status,created_revision"),
                    ("actor_beliefs", "belief_id,actor_entity_id,claim_id,stance,awareness_order,created_revision"),
                    ("story_conversations", "conversation_id,actor_entity_id,title,actor_is_user_controlled,created_revision,updated_revision,created_at,updated_at"),
                    ("story_turns", "conversation_id,turn_id,turn_order,role,narrative_order,content,provider,model,context_manifest_id,context_manifest_json,context_revision,created_revision,created_at"),
                    ("journal_events", "event_id,version,title,details,participants_json,temporal_kind,occurred_from,occurred_to,time_note,source_id,source_quote,supersedes_version,created_revision,created_at"),
                    ("evidence", "evidence_id,source_id,anchor,quote,context_fingerprint,created_revision"),
                ):
                    ordering = " ORDER BY event_id,version" if table == "journal_events" else ""
                    connection.execute(
                        f"INSERT INTO {table}(workspace_id,branch_id,{columns}) "
                        f"SELECT workspace_id,?,{columns} FROM {table} WHERE workspace_id=? AND branch_id=?{ordering}",
                        (branch_id, workspace_id, parent_branch_id),
                    )
                connection.execute(
                    "INSERT INTO entity_search(workspace_id,branch_id,entity_id,label,properties) "
                    "SELECT workspace_id,?,entity_id,label,properties FROM entity_search "
                    "WHERE workspace_id=? AND branch_id=?",
                    (branch_id, workspace_id, parent_branch_id),
                )
                connection.execute(
                    "INSERT INTO revisions(workspace_id,branch_id,revision,command_id,parent_revision,actor,reason,created_at,payload_json) "
                    "VALUES(?,?,?,?,?,?, ?, ?, ?)",
                    (workspace_id, branch_id, expected_revision, command_id, expected_revision, actor, reason, now, _json(envelope)),
                )
                connection.execute(
                    "INSERT INTO audit_events(event_id,workspace_id,branch_id,revision,command_id,event_type,actor,reason,payload_json,created_at) "
                    "VALUES(?,?,?,?,?,'branch.created',?,?,?,?)",
                    (str(uuid4()), workspace_id, branch_id, expected_revision, command_id, actor, reason, _json(envelope), now),
                )
                connection.execute(
                    "INSERT INTO projection_outbox(outbox_id,workspace_id,branch_id,revision,projection,created_at) "
                    "VALUES(?,?,?,?, 'all', ?)",
                    (str(uuid4()), workspace_id, branch_id, expected_revision, now),
                )
                result = {"workspace_id": workspace_id, "branch_id": branch_id, "parent_branch_id": parent_branch_id, "revision": expected_revision}
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
            entity_id = _required_text(payload.get("entity_id"), "entity_id", 100)
            row = connection.execute(
                "SELECT label,properties_json FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, entity_id),
            ).fetchone()
            if not row:
                raise NotFoundError("Entity does not exist in this branch")
            label = _required_text(payload.get("label", row["label"]), "label")
            properties = payload.get("properties", json.loads(row["properties_json"]))
            if not isinstance(properties, dict):
                raise ValidationError("properties must be an object")
            properties_json = _json(properties)
            connection.execute(
                "UPDATE entities SET label=?,properties_json=?,updated_revision=? "
                "WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (label, properties_json, revision, workspace_id, branch_id, entity_id),
            )
            connection.execute(
                "DELETE FROM entity_search WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, entity_id),
            )
            connection.execute(
                "INSERT INTO entity_search(workspace_id,branch_id,entity_id,label,properties) VALUES(?,?,?,?,?)",
                (workspace_id, branch_id, entity_id, label, properties_json),
            )
            return {"entity_id": entity_id, "label": label}, "entity.updated", True

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

        if command_type == "review_relation":
            relation_id = _required_text(payload.get("relation_id"), "relation_id", 100)
            status = payload.get("review_status")
            if status not in {"accepted", "rejected"}:
                raise ValidationError("review_status must be accepted or rejected")
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot review or accept relations")
            result = connection.execute(
                "UPDATE relations SET review_status=? WHERE workspace_id=? AND branch_id=? AND relation_id=?",
                (status, workspace_id, branch_id, relation_id),
            )
            if result.rowcount != 1:
                raise NotFoundError("Relation does not exist in this branch")
            return {"relation_id": relation_id, "review_status": status}, "relation.reviewed", True

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

        if command_type == "review_claim":
            claim_id = _required_text(payload.get("claim_id"), "claim_id", 100)
            status = payload.get("review_status")
            if status not in {"accepted", "rejected"}:
                raise ValidationError("review_status must be accepted or rejected")
            if actor.startswith("ai:"):
                raise ValidationError("AI actors cannot review or accept claims")
            result = connection.execute(
                "UPDATE claims SET review_status=? WHERE workspace_id=? AND branch_id=? AND claim_id=?",
                (status, workspace_id, branch_id, claim_id),
            )
            if result.rowcount != 1:
                raise NotFoundError("Claim does not exist in this branch")
            return {"claim_id": claim_id, "review_status": status}, "claim.reviewed", True

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
            return {"evidence_id": evidence_id, "source_id": source_id}, "evidence.created", True

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
            if provider != "ollama":
                raise ValidationError("Only the local Ollama provider can record generated story turns")
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
            return {
                "conversation_id": conversation_id,
                "user_turn_id": user_turn_id,
                "assistant_turn_id": assistant_turn_id,
                "provider": provider,
                "model": model,
                "context_manifest_id": context_manifest_id,
                "context_revision": context_revision,
            }, "story.turn_recorded", True

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
                "SELECT claim_id,subject_entity_id,predicate,object_value,epistemic_status,review_status "
                "FROM claims WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchall()
        claims = [dict(row) for row in claim_rows]
        return [
            {"rule": dict(row), "evaluation": evaluate_rule(dict(row), claims)}
            for row in rule_rows
        ]

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
                "SELECT source_id,display_name,media_type,content,created_at "
                "FROM sources WHERE workspace_id=? AND source_id=?",
                (workspace_id, source_id),
            ).fetchone()
        if not row:
            raise NotFoundError("Source does not exist in this workspace")
        return dict(row)

    def revisions(self, workspace_id: str, branch_id: str = "main") -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.connection.execute(
                "SELECT revision,parent_revision,actor,reason,created_at,payload_json "
                "FROM revisions WHERE workspace_id=? AND branch_id=? ORDER BY revision",
                (workspace_id, branch_id),
            ).fetchall()
        return [{"revision": r["revision"], "parent_revision": r["parent_revision"], "actor": r["actor"],
                 "reason": r["reason"], "created_at": r["created_at"], "payload": json.loads(r["payload_json"])} for r in rows]

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
        conversation = dict(row)
        conversation["actor_is_user_controlled"] = bool(conversation["actor_is_user_controlled"])
        conversation["turns"] = []
        for turn in turns:
            item = dict(turn)
            manifest_json = item.pop("context_manifest_json")
            item["context_manifest"] = json.loads(manifest_json) if manifest_json else None
            conversation["turns"].append(item)
        return conversation

