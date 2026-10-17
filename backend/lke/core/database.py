"""SQLite connection and versioned schema for the canonical LKE store."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from threading import RLock


SCHEMA_VERSION = 1


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
        """Create v1 atomically; refuse unknown newer schemas."""
        with self.lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
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
                if current == 0:
                    self.connection.executescript(
                        "BEGIN IMMEDIATE;\n"
                        + _SCHEMA_V1
                        + "\nINSERT INTO schema_migrations(version, applied_at) VALUES(1, "
                        "strftime('%Y-%m-%dT%H:%M:%fZ','now'));\nCOMMIT;"
                    )
                else:
                    self.connection.commit()
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
