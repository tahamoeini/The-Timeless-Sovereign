"""SQLite connection and versioned schema for the canonical LKE store."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from threading import RLock


SCHEMA_VERSION = 13


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
                self._apply_migration(1, _SCHEMA_V1 + _SEARCH_PROJECTION_SCHEMA)
                current = 1
            if current < 2:
                self._apply_migration(2, _SCHEMA_V2)
                current = 2
            if current < 3:
                self._apply_migration(3, _SCHEMA_V3)
                current = 3
            if current < 4:
                self._apply_migration(4, _SCHEMA_V4)
                current = 4
            if current < 5:
                self._apply_migration(5, _SCHEMA_V5)
                current = 5
            if current < 6:
                self._apply_migration(6, _SCHEMA_V6)
                current = 6
            if current < 7:
                self._apply_migration(7, _SCHEMA_V7)
                current = 7
            if current < 8:
                self._apply_migration(8, _SCHEMA_V8)
                current = 8
            if current < 9:
                self._apply_migration(9, _SCHEMA_V9)
                current = 9
            if current < 10:
                self._apply_migration(10, _SCHEMA_V10)
                current = 10
            if current < 11:
                self._apply_migration(11, _SCHEMA_V11)
                current = 11
            if current < 12:
                self._apply_migration(12, _SCHEMA_V12)
                current = 12
            if current < 13:
                self._apply_migration(13, _SCHEMA_V13)

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

    def rebuild_search_projections(self) -> dict[str, int]:
        """Recreate disposable FTS indexes from canonical entities and sources."""
        with self.lock:
            connection = self.connection
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("DROP TABLE IF EXISTS entity_search")
                connection.execute("DROP TABLE IF EXISTS source_search")
                connection.execute(_CREATE_ENTITY_SEARCH)
                connection.execute(_CREATE_SOURCE_SEARCH)
                connection.execute(
                    "INSERT INTO entity_search(workspace_id,branch_id,entity_id,label,properties) "
                    "SELECT workspace_id,branch_id,entity_id,label,properties_json FROM entities"
                )
                connection.execute(
                    "INSERT INTO source_search(workspace_id,source_id,display_name,content) "
                    "SELECT workspace_id,source_id,display_name,content FROM sources"
                )
                counts = {
                    "entities": connection.execute("SELECT COUNT(*) FROM entity_search").fetchone()[0],
                    "sources": connection.execute("SELECT COUNT(*) FROM source_search").fetchone()[0],
                }
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return counts


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
"""

_CREATE_ENTITY_SEARCH = """CREATE VIRTUAL TABLE entity_search USING fts5(
    workspace_id UNINDEXED, branch_id UNINDEXED, entity_id UNINDEXED,
    label, properties, tokenize='unicode61 remove_diacritics 2'
)"""

_CREATE_SOURCE_SEARCH = """CREATE VIRTUAL TABLE source_search USING fts5(
    workspace_id UNINDEXED, source_id UNINDEXED, display_name, content,
    tokenize='unicode61 remove_diacritics 2'
)"""

_SEARCH_PROJECTION_SCHEMA = f"{_CREATE_ENTITY_SEARCH};\n{_CREATE_SOURCE_SEARCH};\n"


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


_SCHEMA_V5 = """
CREATE TABLE scenarios (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    problem TEXT NOT NULL CHECK(length(trim(problem)) BETWEEN 1 AND 4000),
    constraints_json TEXT NOT NULL DEFAULT '[]',
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,scenario_id),
    FOREIGN KEY(workspace_id,branch_id)
        REFERENCES branches(workspace_id,branch_id) ON DELETE CASCADE
);
CREATE TABLE scenario_options (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 4),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    PRIMARY KEY(workspace_id,branch_id,scenario_id,option_id),
    UNIQUE(workspace_id,branch_id,scenario_id,position),
    FOREIGN KEY(workspace_id,branch_id,scenario_id)
        REFERENCES scenarios(workspace_id,branch_id,scenario_id) ON DELETE CASCADE
);
CREATE TABLE scenario_claim_evidence (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    PRIMARY KEY(workspace_id,branch_id,scenario_id,claim_id),
    FOREIGN KEY(workspace_id,branch_id,scenario_id)
        REFERENCES scenarios(workspace_id,branch_id,scenario_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,branch_id,claim_id)
        REFERENCES claims(workspace_id,branch_id,claim_id)
);
CREATE TABLE scenario_source_evidence (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    PRIMARY KEY(workspace_id,branch_id,scenario_id,source_id),
    FOREIGN KEY(workspace_id,branch_id,scenario_id)
        REFERENCES scenarios(workspace_id,branch_id,scenario_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,source_id)
        REFERENCES sources(workspace_id,source_id)
);
CREATE TABLE scenario_assumptions (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    assumption_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    subject_entity_id TEXT NOT NULL,
    predicate TEXT NOT NULL CHECK(length(trim(predicate)) BETWEEN 1 AND 200),
    object_value TEXT NOT NULL CHECK(length(trim(object_value)) BETWEEN 1 AND 4000),
    assumption_action TEXT NOT NULL CHECK(assumption_action IN ('add','replace')),
    predicate_cardinality TEXT NOT NULL CHECK(predicate_cardinality IN ('single','multiple')),
    review_status TEXT NOT NULL CHECK(review_status IN ('proposed','accepted','rejected')),
    supersedes_version INTEGER,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,scenario_id,option_id,assumption_id,version),
    CHECK((assumption_action='replace' AND predicate_cardinality='single') OR
          (assumption_action='add' AND predicate_cardinality='multiple')),
    CHECK(supersedes_version IS NULL OR supersedes_version=version-1),
    FOREIGN KEY(workspace_id,branch_id,scenario_id,option_id)
        REFERENCES scenario_options(workspace_id,branch_id,scenario_id,option_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,branch_id,subject_entity_id)
        REFERENCES entities(workspace_id,branch_id,entity_id),
    FOREIGN KEY(workspace_id,branch_id,scenario_id,option_id,assumption_id,supersedes_version)
        REFERENCES scenario_assumptions(workspace_id,branch_id,scenario_id,option_id,assumption_id,version)
);
CREATE INDEX scenario_assumptions_latest_idx
    ON scenario_assumptions(workspace_id,branch_id,scenario_id,option_id,assumption_id,version DESC);

CREATE TRIGGER scenarios_no_update BEFORE UPDATE ON scenarios
BEGIN SELECT RAISE(ABORT, 'scenarios are append-only'); END;
CREATE TRIGGER scenarios_no_delete BEFORE DELETE ON scenarios
BEGIN SELECT RAISE(ABORT, 'scenarios are append-only'); END;
CREATE TRIGGER scenario_options_no_update BEFORE UPDATE ON scenario_options
BEGIN SELECT RAISE(ABORT, 'scenario options are append-only'); END;
CREATE TRIGGER scenario_options_no_delete BEFORE DELETE ON scenario_options
BEGIN SELECT RAISE(ABORT, 'scenario options are append-only'); END;
CREATE TRIGGER scenario_claim_evidence_no_update BEFORE UPDATE ON scenario_claim_evidence
BEGIN SELECT RAISE(ABORT, 'scenario evidence is append-only'); END;
CREATE TRIGGER scenario_claim_evidence_no_delete BEFORE DELETE ON scenario_claim_evidence
BEGIN SELECT RAISE(ABORT, 'scenario evidence is append-only'); END;
CREATE TRIGGER scenario_source_evidence_no_update BEFORE UPDATE ON scenario_source_evidence
BEGIN SELECT RAISE(ABORT, 'scenario evidence is append-only'); END;
CREATE TRIGGER scenario_source_evidence_no_delete BEFORE DELETE ON scenario_source_evidence
BEGIN SELECT RAISE(ABORT, 'scenario evidence is append-only'); END;
CREATE TRIGGER scenario_assumptions_no_update BEFORE UPDATE ON scenario_assumptions
BEGIN SELECT RAISE(ABORT, 'scenario assumption versions are append-only'); END;
CREATE TRIGGER scenario_assumptions_no_delete BEFORE DELETE ON scenario_assumptions
BEGIN SELECT RAISE(ABORT, 'scenario assumption versions are append-only'); END;
"""


_SCHEMA_V6 = """
CREATE TABLE entity_evidence (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    PRIMARY KEY(workspace_id,branch_id,entity_id,evidence_id),
    FOREIGN KEY(workspace_id,branch_id,entity_id)
        REFERENCES entities(workspace_id,branch_id,entity_id),
    FOREIGN KEY(workspace_id,branch_id,evidence_id)
        REFERENCES evidence(workspace_id,branch_id,evidence_id)
);
CREATE TABLE extraction_batches (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    model TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    output_schema_version INTEGER NOT NULL CHECK(output_schema_version >= 1),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,batch_id),
    FOREIGN KEY(workspace_id,branch_id)
        REFERENCES branches(workspace_id,branch_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,source_id)
        REFERENCES sources(workspace_id,source_id)
);
CREATE INDEX extraction_batches_source_idx
    ON extraction_batches(workspace_id,branch_id,source_id,created_revision);
CREATE TABLE extraction_candidates (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('entity','claim')),
    payload_json TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK(review_status IN ('proposed','accepted','rejected')),
    canonical_record_type TEXT CHECK(canonical_record_type IN ('entity','claim')),
    canonical_record_id TEXT,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    reviewed_revision INTEGER,
    PRIMARY KEY(workspace_id,branch_id,candidate_id),
    CHECK((review_status='accepted' AND canonical_record_type IS NOT NULL AND canonical_record_id IS NOT NULL) OR
          (review_status!='accepted' AND canonical_record_type IS NULL AND canonical_record_id IS NULL)),
    FOREIGN KEY(workspace_id,branch_id,batch_id)
        REFERENCES extraction_batches(workspace_id,branch_id,batch_id) ON DELETE CASCADE
);
CREATE INDEX extraction_candidates_review_idx
    ON extraction_candidates(workspace_id,branch_id,batch_id,review_status,kind);
CREATE TRIGGER extraction_batches_no_update BEFORE UPDATE ON extraction_batches
BEGIN SELECT RAISE(ABORT, 'extraction batches are immutable'); END;
CREATE TRIGGER extraction_batches_no_delete BEFORE DELETE ON extraction_batches
BEGIN SELECT RAISE(ABORT, 'extraction batches are immutable'); END;
CREATE TRIGGER extraction_candidates_payload_immutable BEFORE UPDATE ON extraction_candidates
WHEN OLD.batch_id IS NOT NEW.batch_id OR OLD.kind IS NOT NEW.kind OR OLD.payload_json IS NOT NEW.payload_json OR
     OLD.created_revision IS NOT NEW.created_revision
BEGIN SELECT RAISE(ABORT, 'extraction candidate content is immutable'); END;
CREATE TRIGGER extraction_candidates_no_delete BEFORE DELETE ON extraction_candidates
BEGIN SELECT RAISE(ABORT, 'extraction candidates are immutable'); END;
CREATE TRIGGER entity_evidence_no_update BEFORE UPDATE ON entity_evidence
BEGIN SELECT RAISE(ABORT, 'entity evidence links are immutable'); END;
CREATE TRIGGER entity_evidence_no_delete BEFORE DELETE ON entity_evidence
BEGIN SELECT RAISE(ABORT, 'entity evidence links are immutable'); END;
"""


_SCHEMA_V7 = """
CREATE TABLE external_exchanges (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    exchange_id TEXT NOT NULL,
    transcript_id TEXT NOT NULL,
    context_manifest_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
    from_turn INTEGER NOT NULL CHECK(from_turn >= 0),
    to_turn INTEGER NOT NULL CHECK(to_turn >= from_turn),
    transcript_hash TEXT NOT NULL CHECK(length(transcript_hash)=71 AND transcript_hash LIKE 'sha256:%'),
    context_manifest_json TEXT NOT NULL,
    turns_json TEXT NOT NULL,
    proposed_change_ids_json TEXT NOT NULL,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,exchange_id),
    UNIQUE(workspace_id,branch_id,transcript_id,transcript_hash),
    FOREIGN KEY(workspace_id,branch_id)
        REFERENCES branches(workspace_id,branch_id) ON DELETE CASCADE
);
CREATE INDEX external_exchanges_created_idx
    ON external_exchanges(workspace_id,branch_id,created_revision DESC);
CREATE TRIGGER external_exchanges_no_update BEFORE UPDATE ON external_exchanges
BEGIN SELECT RAISE(ABORT, 'external exchanges are immutable'); END;
CREATE TRIGGER external_exchanges_no_delete BEFORE DELETE ON external_exchanges
BEGIN SELECT RAISE(ABORT, 'external exchanges are immutable'); END;
"""


_SCHEMA_V8 = """
DROP TRIGGER external_exchanges_no_update;
DROP TRIGGER external_exchanges_no_delete;
DROP INDEX external_exchanges_created_idx;
ALTER TABLE external_exchanges RENAME TO external_exchanges_v7;
CREATE TABLE external_exchanges (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    exchange_id TEXT NOT NULL,
    transcript_id TEXT NOT NULL,
    context_manifest_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
    from_turn INTEGER NOT NULL CHECK(from_turn >= 0),
    to_turn INTEGER NOT NULL CHECK(to_turn >= from_turn),
    transcript_total_turns INTEGER NOT NULL CHECK(transcript_total_turns >= to_turn),
    transcript_hash TEXT NOT NULL CHECK(length(transcript_hash)=71 AND transcript_hash LIKE 'sha256:%'),
    context_manifest_json TEXT NOT NULL,
    turns_json TEXT NOT NULL,
    proposed_change_ids_json TEXT NOT NULL,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,exchange_id),
    UNIQUE(workspace_id,branch_id,transcript_id,transcript_hash,transcript_total_turns),
    FOREIGN KEY(workspace_id,branch_id)
        REFERENCES branches(workspace_id,branch_id) ON DELETE CASCADE
);
INSERT INTO external_exchanges(
    workspace_id,branch_id,exchange_id,transcript_id,context_manifest_id,base_revision,
    from_turn,to_turn,transcript_total_turns,transcript_hash,context_manifest_json,turns_json,
    proposed_change_ids_json,created_revision,created_at
)
SELECT workspace_id,branch_id,exchange_id,transcript_id,context_manifest_id,base_revision,
       from_turn,to_turn,to_turn,transcript_hash,context_manifest_json,turns_json,
       proposed_change_ids_json,created_revision,created_at
FROM external_exchanges_v7;
DROP TABLE external_exchanges_v7;
CREATE INDEX external_exchanges_created_idx
    ON external_exchanges(workspace_id,branch_id,created_revision DESC);
CREATE TRIGGER external_exchanges_no_update BEFORE UPDATE ON external_exchanges
BEGIN SELECT RAISE(ABORT, 'external exchanges are immutable'); END;
CREATE TRIGGER external_exchanges_no_delete BEFORE DELETE ON external_exchanges
BEGIN SELECT RAISE(ABORT, 'external exchanges are immutable'); END;
"""


_SCHEMA_V9 = """
CREATE TABLE story_worlds (
    workspace_id TEXT NOT NULL,
    world_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
    latest_version INTEGER NOT NULL CHECK(latest_version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,world_id),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);
CREATE TABLE story_world_versions (
    workspace_id TEXT NOT NULL,
    world_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    description TEXT NOT NULL DEFAULT '',
    template_key TEXT NOT NULL DEFAULT 'blank',
    content_json TEXT NOT NULL CHECK(json_valid(content_json)),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,world_id,version),
    FOREIGN KEY(workspace_id,world_id)
        REFERENCES story_worlds(workspace_id,world_id) ON DELETE CASCADE
);
CREATE INDEX story_worlds_updated_idx ON story_worlds(workspace_id,updated_at DESC);
CREATE TRIGGER story_world_versions_no_update BEFORE UPDATE ON story_world_versions
BEGIN SELECT RAISE(ABORT, 'world versions are immutable'); END;
CREATE TRIGGER story_world_versions_no_delete BEFORE DELETE ON story_world_versions
BEGIN SELECT RAISE(ABORT, 'world versions are immutable'); END;

CREATE TABLE story_adventures (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    adventure_id TEXT NOT NULL,
    world_id TEXT NOT NULL,
    world_version INTEGER NOT NULL CHECK(world_version >= 1),
    conversation_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
    actor_entity_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','complete','paused')),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    updated_revision INTEGER NOT NULL CHECK(updated_revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,adventure_id),
    UNIQUE(workspace_id,branch_id,conversation_id),
    FOREIGN KEY(workspace_id,branch_id)
        REFERENCES branches(workspace_id,branch_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,world_id,world_version)
        REFERENCES story_world_versions(workspace_id,world_id,version),
    FOREIGN KEY(workspace_id,branch_id,conversation_id)
        REFERENCES story_conversations(workspace_id,branch_id,conversation_id),
    FOREIGN KEY(workspace_id,branch_id,actor_entity_id)
        REFERENCES entities(workspace_id,branch_id,entity_id)
);
CREATE INDEX story_adventures_library_idx
    ON story_adventures(workspace_id,updated_at DESC,adventure_id);

CREATE TABLE rpg_sheets (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    adventure_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    stats_json TEXT NOT NULL CHECK(json_valid(stats_json)),
    trackers_json TEXT NOT NULL CHECK(json_valid(trackers_json)),
    current_location TEXT NOT NULL DEFAULT '',
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    updated_revision INTEGER NOT NULL CHECK(updated_revision >= 0),
    PRIMARY KEY(workspace_id,branch_id,adventure_id),
    FOREIGN KEY(workspace_id,branch_id,adventure_id)
        REFERENCES story_adventures(workspace_id,branch_id,adventure_id) ON DELETE CASCADE
);

CREATE TABLE rpg_checks (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    adventure_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    actor_entity_id TEXT NOT NULL,
    stat_name TEXT NOT NULL,
    die_roll INTEGER NOT NULL CHECK(die_roll BETWEEN 1 AND 20),
    modifier INTEGER NOT NULL CHECK(modifier BETWEEN -20 AND 20),
    total INTEGER NOT NULL,
    target INTEGER NOT NULL CHECK(target BETWEEN 1 AND 100),
    outcome TEXT NOT NULL CHECK(outcome IN ('success','failure')),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,check_id),
    FOREIGN KEY(workspace_id,branch_id,adventure_id)
        REFERENCES story_adventures(workspace_id,branch_id,adventure_id) ON DELETE CASCADE
);
CREATE INDEX rpg_checks_adventure_idx
    ON rpg_checks(workspace_id,branch_id,adventure_id,created_revision DESC);
CREATE TRIGGER rpg_checks_no_update BEFORE UPDATE ON rpg_checks
BEGIN SELECT RAISE(ABORT, 'RPG check results are immutable'); END;
CREATE TRIGGER rpg_checks_no_delete BEFORE DELETE ON rpg_checks
BEGIN SELECT RAISE(ABORT, 'RPG check results are immutable'); END;

CREATE TABLE rpg_state_proposals (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    adventure_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    source_turn_id TEXT,
    changes_json TEXT NOT NULL CHECK(json_valid(changes_json)),
    review_status TEXT NOT NULL CHECK(review_status IN ('proposed','accepted','rejected')),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    reviewed_revision INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,proposal_id),
    FOREIGN KEY(workspace_id,branch_id,adventure_id)
        REFERENCES story_adventures(workspace_id,branch_id,adventure_id) ON DELETE CASCADE
);
CREATE INDEX rpg_state_proposals_review_idx
    ON rpg_state_proposals(workspace_id,branch_id,adventure_id,review_status,created_revision);
CREATE TRIGGER rpg_state_proposal_content_immutable BEFORE UPDATE ON rpg_state_proposals
WHEN OLD.adventure_id IS NOT NEW.adventure_id OR OLD.conversation_id IS NOT NEW.conversation_id OR
     OLD.source_turn_id IS NOT NEW.source_turn_id OR OLD.changes_json IS NOT NEW.changes_json OR
     OLD.created_revision IS NOT NEW.created_revision OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'state proposal content is immutable'); END;
CREATE TRIGGER rpg_state_proposals_no_delete BEFORE DELETE ON rpg_state_proposals
BEGIN SELECT RAISE(ABORT, 'state proposals are immutable'); END;
"""


_SCHEMA_V10 = """
DROP TRIGGER story_world_versions_no_update;
ALTER TABLE story_world_versions ADD COLUMN name TEXT NOT NULL DEFAULT 'World'
    CHECK(length(trim(name)) BETWEEN 1 AND 200);
UPDATE story_world_versions SET name=(
    SELECT name FROM story_worlds
    WHERE story_worlds.workspace_id=story_world_versions.workspace_id
      AND story_worlds.world_id=story_world_versions.world_id
);
CREATE TRIGGER story_world_versions_no_update BEFORE UPDATE ON story_world_versions
BEGIN SELECT RAISE(ABORT, 'world versions are immutable'); END;
"""


_SCHEMA_V11 = """
ALTER TABLE story_adventures ADD COLUMN completed_turns INTEGER NOT NULL DEFAULT 0
    CHECK(completed_turns >= 0);
ALTER TABLE story_adventures ADD COLUMN npc_simulation_enabled INTEGER NOT NULL DEFAULT 0
    CHECK(npc_simulation_enabled IN (0,1));
UPDATE story_adventures SET completed_turns=(
    SELECT COUNT(*) FROM story_turns
    WHERE story_turns.workspace_id=story_adventures.workspace_id
      AND story_turns.branch_id=story_adventures.branch_id
      AND story_turns.conversation_id=story_adventures.conversation_id
      AND story_turns.role='assistant'
);

CREATE TABLE story_turn_edits (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    content TEXT NOT NULL CHECK(length(trim(content)) > 0),
    status TEXT NOT NULL CHECK(status IN ('active','deleted','superseded')),
    provider TEXT,
    model TEXT,
    context_manifest_id TEXT,
    context_manifest_json TEXT,
    context_revision INTEGER,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,conversation_id,turn_id,version),
    FOREIGN KEY(workspace_id,branch_id,conversation_id,turn_id)
        REFERENCES story_turns(workspace_id,branch_id,conversation_id,turn_id) ON DELETE CASCADE
);
CREATE INDEX story_turn_edits_latest_idx
    ON story_turn_edits(workspace_id,branch_id,conversation_id,turn_id,version DESC);
CREATE TRIGGER story_turn_edits_content_immutable BEFORE UPDATE ON story_turn_edits
WHEN OLD.content IS NOT NEW.content OR OLD.status IS NOT NEW.status OR OLD.provider IS NOT NEW.provider OR
     OLD.model IS NOT NEW.model OR OLD.context_manifest_id IS NOT NEW.context_manifest_id OR
     OLD.context_manifest_json IS NOT NEW.context_manifest_json OR OLD.context_revision IS NOT NEW.context_revision OR
     OLD.created_revision IS NOT NEW.created_revision OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'story turn edit history is immutable'); END;
CREATE TRIGGER story_turn_edits_no_delete BEFORE DELETE ON story_turn_edits
BEGIN SELECT RAISE(ABORT, 'story turn edit history is immutable'); END;

CREATE TABLE story_memories (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    adventure_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    kind TEXT NOT NULL CHECK(kind IN ('note','event','situation')),
    content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 4000),
    context_enabled INTEGER NOT NULL DEFAULT 1 CHECK(context_enabled IN (0,1)),
    review_status TEXT NOT NULL CHECK(review_status IN ('proposed','accepted','rejected')),
    source_turn_id TEXT,
    narrative_order INTEGER NOT NULL DEFAULT 0 CHECK(narrative_order >= 0),
    supersedes_version INTEGER,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    reviewed_revision INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,adventure_id,memory_id,version),
    FOREIGN KEY(workspace_id,branch_id,adventure_id)
        REFERENCES story_adventures(workspace_id,branch_id,adventure_id) ON DELETE CASCADE
);
CREATE INDEX story_memories_latest_idx
    ON story_memories(workspace_id,branch_id,adventure_id,memory_id,version DESC);
CREATE TRIGGER story_memories_content_immutable BEFORE UPDATE ON story_memories
WHEN OLD.kind IS NOT NEW.kind OR OLD.content IS NOT NEW.content OR
     OLD.context_enabled IS NOT NEW.context_enabled OR OLD.source_turn_id IS NOT NEW.source_turn_id OR
     OLD.narrative_order IS NOT NEW.narrative_order OR OLD.supersedes_version IS NOT NEW.supersedes_version OR
     OLD.created_revision IS NOT NEW.created_revision OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'story memory versions are immutable'); END;
CREATE TRIGGER story_memories_no_delete BEFORE DELETE ON story_memories
BEGIN SELECT RAISE(ABORT, 'story memory history is immutable'); END;

CREATE TABLE story_threads (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    adventure_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    detail TEXT NOT NULL DEFAULT '' CHECK(length(detail) <= 2000),
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    updated_revision INTEGER NOT NULL CHECK(updated_revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,adventure_id,thread_id),
    FOREIGN KEY(workspace_id,branch_id,adventure_id)
        REFERENCES story_adventures(workspace_id,branch_id,adventure_id) ON DELETE CASCADE
);
CREATE INDEX story_threads_open_idx
    ON story_threads(workspace_id,branch_id,adventure_id,status,updated_revision DESC);

CREATE TABLE story_npc_profiles (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    adventure_id TEXT NOT NULL,
    npc_entity_id TEXT NOT NULL,
    aliases_json TEXT NOT NULL CHECK(json_valid(aliases_json)),
    public_profile_json TEXT NOT NULL CHECK(json_valid(public_profile_json)),
    private_profile_json TEXT NOT NULL CHECK(json_valid(private_profile_json)),
    review_status TEXT NOT NULL CHECK(review_status IN ('proposed','accepted','rejected')),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    updated_revision INTEGER NOT NULL CHECK(updated_revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,adventure_id,npc_entity_id),
    FOREIGN KEY(workspace_id,branch_id,adventure_id)
        REFERENCES story_adventures(workspace_id,branch_id,adventure_id) ON DELETE CASCADE,
    FOREIGN KEY(workspace_id,branch_id,npc_entity_id)
        REFERENCES entities(workspace_id,branch_id,entity_id)
);

CREATE TABLE story_assets (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    adventure_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK(target_kind IN ('character','scene')),
    target_id TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 200),
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
    content BLOB NOT NULL CHECK(length(content) BETWEEN 1 AND 5242880),
    provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,adventure_id,asset_id),
    FOREIGN KEY(workspace_id,branch_id,adventure_id)
        REFERENCES story_adventures(workspace_id,branch_id,adventure_id) ON DELETE CASCADE
);
CREATE INDEX story_assets_target_idx
    ON story_assets(workspace_id,branch_id,adventure_id,target_kind,target_id,created_revision DESC);
CREATE TRIGGER story_assets_no_update BEFORE UPDATE ON story_assets
BEGIN SELECT RAISE(ABORT, 'story assets are immutable'); END;
CREATE TRIGGER story_assets_no_delete BEFORE DELETE ON story_assets
BEGIN SELECT RAISE(ABORT, 'story assets are immutable'); END;
"""


_SCHEMA_V12 = """
CREATE TABLE story_map_locations (
    workspace_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    adventure_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
    status TEXT NOT NULL CHECK(status IN ('approved','rejected')),
    source_proposal_id TEXT,
    created_revision INTEGER NOT NULL CHECK(created_revision >= 0),
    reviewed_revision INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id,branch_id,adventure_id,location_id),
    UNIQUE(workspace_id,branch_id,adventure_id,name COLLATE NOCASE),
    FOREIGN KEY(workspace_id,branch_id,adventure_id)
        REFERENCES story_adventures(workspace_id,branch_id,adventure_id) ON DELETE CASCADE
);
CREATE INDEX story_map_locations_adventure_idx
    ON story_map_locations(workspace_id,branch_id,adventure_id,status,name COLLATE NOCASE);
"""


_SCHEMA_V13 = """
ALTER TABLE story_memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 3
    CHECK(importance BETWEEN 1 AND 5);
ALTER TABLE story_memories ADD COLUMN knowledge_scope TEXT NOT NULL DEFAULT 'shared'
    CHECK(knowledge_scope IN ('shared','actors','author','private'));
ALTER TABLE story_memories ADD COLUMN known_by_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(known_by_json));
DROP TRIGGER story_memories_content_immutable;
CREATE TRIGGER story_memories_content_immutable BEFORE UPDATE ON story_memories
WHEN OLD.kind IS NOT NEW.kind OR OLD.content IS NOT NEW.content OR
     OLD.context_enabled IS NOT NEW.context_enabled OR OLD.source_turn_id IS NOT NEW.source_turn_id OR
     OLD.narrative_order IS NOT NEW.narrative_order OR OLD.supersedes_version IS NOT NEW.supersedes_version OR
     OLD.importance IS NOT NEW.importance OR OLD.knowledge_scope IS NOT NEW.knowledge_scope OR
     OLD.known_by_json IS NOT NEW.known_by_json OR
     OLD.created_revision IS NOT NEW.created_revision OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'story memory versions are immutable'); END;
"""
