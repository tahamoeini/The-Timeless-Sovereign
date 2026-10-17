"""SQLite connection and versioned schema for the canonical LKE store."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from threading import RLock


SCHEMA_VERSION = 4


class Database:
    """A single-process SQLite store with explicit transaction boundaries."""

    def __init__(self, path: str | Path = "lke.sqlite3") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(
            self.path,
            isolation_level=None,
            check_same_thread=False,
            timeout=10,
        )
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA busy_timeout = 10000")
        if self.path != ":memory:":
            self.connection.execute("PRAGMA journal_mode = WAL")
            self.connection.execute("PRAGMA synchronous = FULL")
        self.lock = RLock()
        self.migrate()

    def migrate(self) -> None:
        """Apply each schema migration atomically; refuse unknown newer schemas."""
        with self.lock:
            self.connection.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            row = self.connection.execute(
                "SELECT MAX(version) AS version FROM schema_migrations"
            ).fetchone()
            current = row["version"] or 0
            if current > SCHEMA_VERSION:
                raise RuntimeError(
                    f"Database schema {current} is newer than supported {SCHEMA_VERSION}"
                )
            if current < 1:
                self._apply_migration(1, _SCHEMA_V1)
                current = 1
            if current < 2:
                self._apply_migration(2, _SCHEMA_V2)
                current = 2
            if current < 3:
                self._apply_migration(3, _SCHEMA_V3)
                current = 3
            if current < 4:
                self._apply_migration(4, _SCHEMA_V4)

    def _apply_migration(self, version: int, schema: str) -> None:
        try:
            self.connection.executescript(
                "BEGIN IMMEDIATE;\n"
                + schema
                + f"\nINSERT INTO schema_migrations(version, applied_at) VALUES({version}, "
                "strftime('%Y-%m-%dT%H:%M:%fZ','now'));\nCOMMIT;"
            )
        except BaseException:
            self.connection.rollback()
            raise

    def close(self) -> None:
        with self.lock:
            self.connection.close()


_SCHEMA_V1 = """
CREATE TABLE workspaces (
    workspace_id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL
);
CREATE TABLE branches (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    parent_branch_id TEXT,
    parent_revision INTEGER,
    base_revision INTEGER NOT NULL DEFAULT 0 CHECK(base_revision >= 0),
    head_revision INTEGER NOT NULL DEFAULT 0 CHECK(head_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, branch_id),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id, parent_branch_id)
        REFERENCES branches(workspace_id, branch_id)
);
CREATE TABLE revisions (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    command_id TEXT NOT NULL,
    parent_revision INTEGER,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(workspace_id, branch_id, revision),
    FOREIGN KEY(workspace_id, branch_id)
        REFERENCES branches(workspace_id, branch_id) ON DELETE CASCADE
);
CREATE TABLE commands (
    workspace_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, idempotency_key),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);
CREATE TABLE entities (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 500),
    properties_json TEXT NOT NULL,
    created_revision INTEGER NOT NULL,
    updated_revision INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, branch_id, entity_id),
    FOREIGN KEY(workspace_id, branch_id)
        REFERENCES branches(workspace_id, branch_id) ON DELETE CASCADE
);
CREATE TABLE relations (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    relation_id TEXT NOT NULL,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    properties_json TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK(review_status IN ('proposed','accepted','rejected')),
    created_revision INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, branch_id, relation_id),
    FOREIGN KEY(workspace_id, branch_id, source_entity_id)
        REFERENCES entities(workspace_id, branch_id, entity_id),
    FOREIGN KEY(workspace_id, branch_id, target_entity_id)
        REFERENCES entities(workspace_id, branch_id, entity_id)
);
CREATE TABLE claims (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    subject_entity_id TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object_value TEXT NOT NULL,
    epistemic_status TEXT NOT NULL CHECK(epistemic_status IN ('unknown','believed','known','contested')),
    review_status TEXT NOT NULL CHECK(review_status IN ('proposed','accepted','rejected')),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','actor_scoped','author_only')),
    narrative_order INTEGER NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL,
    created_revision INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, branch_id, claim_id),
    FOREIGN KEY(workspace_id, branch_id, subject_entity_id)
        REFERENCES entities(workspace_id, branch_id, entity_id)
);
CREATE TABLE actor_beliefs (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    belief_id TEXT NOT NULL,
    actor_entity_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    stance TEXT NOT NULL CHECK(stance IN ('knows','believes','denies','unaware')),
    awareness_order INTEGER NOT NULL DEFAULT 0,
    created_revision INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,belief_id),
    FOREIGN KEY(workspace_id,branch_id,actor_entity_id)
        REFERENCES entities(workspace_id,branch_id,entity_id),
    FOREIGN KEY(workspace_id,branch_id,claim_id)
        REFERENCES claims(workspace_id,branch_id,claim_id)
);
CREATE TABLE sources (
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, source_id),
    UNIQUE(workspace_id, content_sha256),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);
CREATE TABLE evidence (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    anchor TEXT NOT NULL,
    quote TEXT NOT NULL,
    context_fingerprint TEXT NOT NULL,
    created_revision INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, branch_id, evidence_id),
    FOREIGN KEY(workspace_id, branch_id)
        REFERENCES branches(workspace_id, branch_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id, source_id)
        REFERENCES sources(workspace_id, source_id)
);
CREATE TABLE audit_events (
    event_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    command_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(workspace_id, branch_id, revision)
        REFERENCES revisions(workspace_id, branch_id, revision)
);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TABLE projection_outbox (
    outbox_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    projection TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY(workspace_id, branch_id, revision)
        REFERENCES revisions(workspace_id, branch_id, revision)
);
CREATE VIRTUAL TABLE entity_search USING fts5(
    workspace_id UNINDEXED, branch_id UNINDEXED, entity_id UNINDEXED,
    label, properties, tokenize='unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE source_search USING fts5(
    workspace_id UNINDEXED, source_id UNINDEXED, display_name, content,
    tokenize='unicode61 remove_diacritics 2'
);
"""


_SCHEMA_V2 = """
CREATE TABLE story_conversations (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    actor_entity_id TEXT NOT NULL,
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    actor_is_user_controlled INTEGER NOT NULL DEFAULT 1 CHECK(actor_is_user_controlled IN (0,1)),
    created_revision INTEGER NOT NULL,
    updated_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,conversation_id),
    FOREIGN KEY(workspace_id,branch_id)
        REFERENCES branches(workspace_id,branch_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,branch_id,actor_entity_id)
        REFERENCES entities(workspace_id,branch_id,entity_id)
);
CREATE TABLE story_turns (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    turn_order INTEGER NOT NULL CHECK(turn_order >= 0),
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    narrative_order INTEGER NOT NULL CHECK(narrative_order >= 0),
    content TEXT NOT NULL CHECK(length(trim(content)) > 0),
    provider TEXT,
    model TEXT,
    context_manifest_id TEXT,
    context_manifest_json TEXT,
    context_revision INTEGER,
    created_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,conversation_id,turn_id),
    UNIQUE(workspace_id,branch_id,conversation_id,turn_order),
    FOREIGN KEY(workspace_id,branch_id,conversation_id)
        REFERENCES story_conversations(workspace_id,branch_id,conversation_id) ON DELETE CASCADE
);
CREATE INDEX story_turns_order_idx
    ON story_turns(workspace_id,branch_id,conversation_id,turn_order);
"""


_SCHEMA_V3 = """
CREATE TABLE journal_events (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    details TEXT NOT NULL DEFAULT '',
    participants_json TEXT NOT NULL DEFAULT '[]',
    temporal_kind TEXT NOT NULL CHECK(temporal_kind IN ('exact','range','relative','unknown')),
    occurred_from TEXT,
    occurred_to TEXT,
    time_note TEXT NOT NULL DEFAULT '',
    source_id TEXT,
    source_quote TEXT,
    supersedes_version INTEGER,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,event_id,version),
    CHECK(
        (temporal_kind='exact' AND occurred_from IS NOT NULL AND occurred_to IS NULL) OR
        (temporal_kind='range' AND occurred_from IS NOT NULL AND occurred_to IS NOT NULL AND occurred_from <= occurred_to) OR
        (temporal_kind IN ('relative','unknown') AND occurred_from IS NULL AND occurred_to IS NULL)
    ),
    CHECK(supersedes_version IS NULL OR supersedes_version=version-1),
    CHECK(source_id IS NOT NULL OR source_quote IS NULL),
    FOREIGN KEY(workspace_id,branch_id)
        REFERENCES branches(workspace_id,branch_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,source_id)
        REFERENCES sources(workspace_id,source_id),
    FOREIGN KEY(workspace_id,branch_id,event_id,supersedes_version)
        REFERENCES journal_events(workspace_id,branch_id,event_id,version)
);
CREATE INDEX journal_events_timeline_idx
    ON journal_events(workspace_id,branch_id,occurred_from,event_id,version);
CREATE TRIGGER journal_events_no_update BEFORE UPDATE ON journal_events
BEGIN SELECT RAISE(ABORT, 'journal event versions are append-only'); END;
CREATE TRIGGER journal_events_no_delete BEFORE DELETE ON journal_events
BEGIN SELECT RAISE(ABORT, 'journal event versions are append-only'); END;
"""


_SCHEMA_V4 = """
CREATE TABLE rules (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '',
    rule_mode TEXT NOT NULL CHECK(rule_mode IN ('require','forbid')),
    severity TEXT NOT NULL CHECK(severity IN ('hard','soft')),
    subject_entity_id TEXT NOT NULL,
    predicate TEXT NOT NULL CHECK(length(trim(predicate)) BETWEEN 1 AND 200),
    object_value TEXT NOT NULL CHECK(length(trim(object_value)) BETWEEN 1 AND 4000),
    predicate_cardinality TEXT NOT NULL CHECK(predicate_cardinality IN ('single','multiple')),
    review_status TEXT NOT NULL CHECK(review_status IN ('proposed','accepted','rejected')),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    PRIMARY KEY(workspace_id,branch_id,rule_id),
    FOREIGN KEY(workspace_id,branch_id)
        REFERENCES branches(workspace_id,branch_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,branch_id,subject_entity_id)
        REFERENCES entities(workspace_id,branch_id,entity_id)
);
CREATE INDEX rules_branch_review_idx
    ON rules(workspace_id,branch_id,review_status,severity);
"""
