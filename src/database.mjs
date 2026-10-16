import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIGRATION_VERSION = 5;
const MAX_SEQUENCE = 9223372036854775807;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  memory_scope TEXT NOT NULL DEFAULT 'project' CHECK(memory_scope IN ('thread', 'project')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
  fork_message_id TEXT,
  fork_sequence INTEGER,
  fork_thread_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name, id)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  codex_thread_id TEXT,
  source_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  kind TEXT NOT NULL CHECK(kind IN ('story', 'command', 'note', 'status')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'streaming', 'failed', 'interrupted')),
  created_at TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS message_changes (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS message_changes_message_revision
  ON message_changes(message_id, revision);

CREATE TRIGGER IF NOT EXISTS messages_record_insert
AFTER INSERT ON messages
BEGIN
  INSERT INTO message_changes(message_id, created_at) VALUES(NEW.id, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS messages_record_update
AFTER UPDATE OF content, status ON messages
BEGIN
  INSERT INTO message_changes(message_id, created_at) VALUES(NEW.id, NEW.created_at);
END;

CREATE INDEX IF NOT EXISTS messages_project_branch_sequence
  ON messages(project_id, branch_id, sequence);
CREATE INDEX IF NOT EXISTS messages_thread_sequence
  ON messages(thread_id, sequence);

CREATE TABLE IF NOT EXISTS ledger_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK(item_type IN ('event', 'character', 'relationship', 'rule', 'possession', 'scene', 'thread', 'obligation', 'evidence', 'resource')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  origin TEXT NOT NULL CHECK(origin IN ('user_established', 'assistant_established', 'claim_or_rumor', 'hypothesis', 'user_correction')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  epistemic_status TEXT NOT NULL CHECK(epistemic_status IN ('current', 'uncertain', 'superseded', 'resolved', 'abandoned')),
  source_message_ids_json TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  supersedes_id TEXT REFERENCES ledger_items(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, branch_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS ledger_project_branch_type
  ON ledger_items(project_id, branch_id, item_type, epistemic_status);

CREATE TABLE IF NOT EXISTS ledger_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  ledger_item_id TEXT NOT NULL REFERENCES ledger_items(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'indexed', 'error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_jobs_status_created
  ON memory_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS meta_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_imports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_drafts (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_attempts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'streaming', 'complete', 'failed', 'interrupted')),
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function makeId() {
  return randomUUID();
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ftsReady(db) {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
        content,
        id UNINDEXED,
        project_id UNINDEXED,
        branch_id UNINDEXED,
        thread_id UNINDEXED,
        sequence UNINDEXED,
        tokenize='unicode61'
      );
    `);
    db.exec('DELETE FROM message_search;');
    db.exec(`
      INSERT INTO message_search(rowid, content, id, project_id, branch_id, thread_id, sequence)
      SELECT sequence, content, id, project_id, branch_id, thread_id, sequence FROM messages;
    `);
    return true;
  } catch {
    return false;
  }
}

function normalizeMessage(row) {
  return {
    id: row.id,
    sequence: row.sequence,
    projectId: row.project_id,
    branchId: row.branch_id,
    threadId: row.thread_id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    sourceMessageId: row.source_message_id ?? null
  };
}

function normalizeLedger(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    type: row.item_type,
    subject: row.subject,
    content: row.content,
    details: parseJson(row.details_json),
    origin: row.origin,
    confidence: row.confidence,
    status: row.epistemic_status,
    sourceMessageIds: parseJson(row.source_message_ids_json, []),
    sourceSequence: row.source_sequence,
    supersedesId: row.supersedes_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function openDatabase(dataDirectory) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const dbPath = path.join(dataDirectory, 'story-studio.db');
  const db = new DatabaseSync(dbPath);
  let transactionDepth = 0;
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(SCHEMA);
    let applied = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
    if (applied === 0) {
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)').run(now());
      applied = 1;
    }
    if (applied < 2) {
      const projectColumns = new Set(db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name));
      if (!projectColumns.has('memory_scope')) {
        db.exec("ALTER TABLE projects ADD COLUMN memory_scope TEXT NOT NULL DEFAULT 'project' CHECK(memory_scope IN ('thread', 'project'))");
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)').run(now());
      applied = 2;
    }
    if (applied < 3) {
      const archiveColumns = new Set(db.prepare('PRAGMA table_info(archive_imports)').all().map((column) => column.name));
      if (!archiveColumns.has('thread_id')) {
        db.exec('ALTER TABLE archive_imports ADD COLUMN thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE');
      }
      db.exec(`
        UPDATE archive_imports AS ai
        SET thread_id = (
          SELECT MIN(t.id) FROM threads AS t
          WHERE t.project_id = ai.project_id
            AND t.title = 'Imported · ' || substr(ai.file_name, 1, 70)
        )
        WHERE ai.thread_id IS NULL
          AND (
            SELECT COUNT(*) FROM threads AS t
            WHERE t.project_id = ai.project_id
              AND t.title = 'Imported · ' || substr(ai.file_name, 1, 70)
          ) = 1;
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(3, ?)').run(now());
      applied = 3;
    }
    if (applied < 4) {
      db.exec(`
        UPDATE messages AS assistant
        SET source_message_id = (
          SELECT user.id FROM messages AS user
          WHERE user.thread_id = assistant.thread_id
            AND user.role = 'user' AND user.kind = 'story'
            AND user.sequence < assistant.sequence
          ORDER BY user.sequence DESC LIMIT 1
        )
        WHERE assistant.role = 'assistant' AND assistant.kind = 'story' AND assistant.source_message_id IS NULL;
      `);
      db.prepare(`
        INSERT INTO message_changes(message_id, created_at)
        SELECT id, created_at FROM messages ORDER BY sequence
      `).run();
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(4, ?)').run(now());
      applied = 4;
    }
    if (applied < 5) {
      const attemptColumns = new Set(db.prepare('PRAGMA table_info(generation_attempts)').all().map((column) => column.name));
      if (!attemptColumns.has('diagnostics_json')) {
        db.exec("ALTER TABLE generation_attempts ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '{}'");
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(5, ?)').run(now());
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    db.close();
    throw error;
  }
  const hasFts = ftsReady(db);
  recoverInterruptedWork(db);

  return {
    db,
    dbPath,
    hasFts,
    close: () => db.close(),
    integrityCheck: () => db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check),
    createProject,
    getProject,
    listProjects,
    listBranches,
    updateProject,
    deleteProject,
    createThread,
    threadDeletionPlan,
    deleteThread,
    getThread,
    listThreads,
    setThreadPaused,
    setCodexThreadId,
    createBranch,
    getTranscript,
    getThreadRevision,
    getThreadMessagesAfter,
    getDraft,
    saveDraft,
    clearDraft,
    createGenerationAttempt,
    getGenerationAttempt,
    updateGenerationAttempt,
    addUserMessage,
    addCommandMessage,
    addAssistantMessage,
    appendMessageDelta,
    completeAssistantMessage,
    failAssistantMessage,
    addSystemActivity,
    getMessage,
    searchMessages,
    searchRelevantMessages,
    getLedgerItems,
    getEffectiveLedger,
    getLedgerItem,
    listLedgerHistory,
    appendLedgerItem,
    reviseLedgerItem,
    retconLedgerItem,
    updateLedgerItem,
    listMemoryJobs,
    getMemoryJobForMessage,
    markMemoryJobProcessing,
    markMemoryJobIndexed,
    commitMemoryJob,
    markMemoryJobError,
    markMemoryJobPending,
    retryMemoryJobs,
    memoryStatus,
    memoryStatusForThread,
    addMetaNote,
    listMetaNotes,
    addCheckpoint,
    listCheckpoints,
    importArchive,
    importArchiveAsProject,
    listArchiveImports,
    getProjectExport,
    importProject,
    getBackup,
    restoreBackup,
    getSetting,
    setSetting,
    addProjectHistory,
    listProjectHistory,
    createBackupFile
  };

  function transaction(callback) {
    const savepoint = `story_transaction_${transactionDepth}`;
    if (transactionDepth === 0) db.exec('BEGIN IMMEDIATE;');
    else db.exec(`SAVEPOINT ${savepoint};`);
    transactionDepth += 1;
    try {
      const value = callback();
      transactionDepth -= 1;
      if (transactionDepth === 0) db.exec('COMMIT;');
      else db.exec(`RELEASE SAVEPOINT ${savepoint};`);
      return value;
    } catch (error) {
      transactionDepth -= 1;
      if (transactionDepth === 0) db.exec('ROLLBACK;');
      else db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint};`);
      throw error;
    }
  }

  function insertMessage({ projectId, branchId, threadId, role, kind, content, status = 'complete', sourceMessageId = null, createdAt: sourceCreatedAt = null }) {
    const id = makeId();
    const createdAt = typeof sourceCreatedAt === 'string' && Number.isFinite(Date.parse(sourceCreatedAt)) ? sourceCreatedAt : now();
    db.prepare(`
      INSERT INTO messages(id, project_id, branch_id, thread_id, role, kind, content, status, created_at, source_message_id)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, branchId, threadId, role, kind, content, status, createdAt, sourceMessageId);
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    syncSearchIndex(row);
    db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(createdAt, threadId);
    return normalizeMessage(row);
  }

  function syncSearchIndex(message) {
    if (!hasFts) return;
    db.prepare('DELETE FROM message_search WHERE rowid = ?').run(message.sequence);
    db.prepare(`
      INSERT INTO message_search(rowid, content, id, project_id, branch_id, thread_id, sequence)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(message.sequence, message.content, message.id, message.project_id, message.branch_id, message.thread_id, message.sequence);
  }

  function createProject({ name, instructions = '', memoryScope = 'project' }) {
    const projectId = makeId();
    const branchId = makeId();
    const threadId = makeId();
    const timestamp = now();
    const safeName = String(name ?? '').trim();
    if (!safeName) throw new Error('Project name is required.');
    if (!['thread', 'project'].includes(memoryScope)) throw new Error('Memory scope must be conversation-local or shared across this project.');
    transaction(() => {
      db.prepare('INSERT INTO projects(id, name, instructions, memory_scope, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
        .run(projectId, safeName, String(instructions), memoryScope, timestamp, timestamp);
      db.prepare('INSERT INTO branches(id, project_id, name, created_at) VALUES(?, ?, ?, ?)')
        .run(branchId, projectId, 'Main', timestamp);
      db.prepare('INSERT INTO threads(id, project_id, branch_id, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
        .run(threadId, projectId, branchId, 'First scene', timestamp, timestamp);
    });
    return { project: getProject(projectId), branch: { id: branchId, name: 'Main', projectId }, thread: getThread(threadId) };
  }

  function getProject(projectId) {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      instructions: row.instructions,
      style: row.style,
      memoryScope: row.memory_scope === 'thread' ? 'thread' : 'project',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function listProjects() {
    return db.prepare(`
      SELECT p.*, COUNT(DISTINCT t.id) AS thread_count, COUNT(DISTINCT b.id) AS branch_count
      FROM projects p
      LEFT JOIN threads t ON t.project_id = p.id
      LEFT JOIN branches b ON b.project_id = p.id
      GROUP BY p.id ORDER BY p.updated_at DESC
    `).all().map((row) => ({
      ...getProject(row.id),
      threadCount: row.thread_count,
      branchCount: row.branch_count
    }));
  }

  function listBranches(projectId) {
    return db.prepare('SELECT * FROM branches WHERE project_id = ? ORDER BY created_at')
      .all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, name: row.name, parentBranchId: row.parent_branch_id,
        forkMessageId: row.fork_message_id, forkSequence: row.fork_sequence, forkThreadId: row.fork_thread_id, createdAt: row.created_at
      }));
  }

  function updateProject(projectId, values, sourceMessageId = null) {
    const previous = getProject(projectId);
    if (!previous) throw new Error('Project not found.');
    const nextName = values.name === undefined ? previous.name : String(values.name).trim();
    if (!nextName) throw new Error('Project name is required.');
    const nextInstructions = values.instructions === undefined ? previous.instructions : String(values.instructions);
    const nextStyle = values.style === undefined ? previous.style : String(values.style);
    const nextMemoryScope = values.memoryScope === undefined ? previous.memoryScope : String(values.memoryScope);
    if (!['thread', 'project'].includes(nextMemoryScope)) throw new Error('Memory scope must be conversation-local or shared across this project.');
    const updatedAt = now();
    transaction(() => {
      db.prepare('UPDATE projects SET name = ?, instructions = ?, style = ?, memory_scope = ?, updated_at = ? WHERE id = ?')
        .run(nextName, nextInstructions, nextStyle, nextMemoryScope, updatedAt, projectId);
      addProjectHistory(projectId, 'project_updated', previous, {
        id: projectId, name: nextName, instructions: nextInstructions, style: nextStyle, memoryScope: nextMemoryScope, updatedAt
      }, sourceMessageId);
    });
    return getProject(projectId);
  }

  function deleteProject(projectId) {
    const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!exists) return false;
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    return true;
  }

  function createThread(projectId, branchId, title = 'New thread', sourceThreadId = null) {
    const branch = db.prepare('SELECT project_id FROM branches WHERE id = ?').get(branchId);
    if (!branch || branch.project_id !== projectId) throw new Error('Branch does not belong to this project.');
    if (sourceThreadId) {
      const sourceThread = getThread(sourceThreadId);
      if (!sourceThread || sourceThread.projectId !== projectId) throw new Error('Source thread does not belong to this project.');
    }
    const id = makeId();
    const timestamp = now();
    db.prepare(`
      INSERT INTO threads(id, project_id, branch_id, title, source_thread_id, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, branchId, String(title).trim() || 'New thread', sourceThreadId, timestamp, timestamp);
    return getThread(id);
  }

  function getThread(threadId) {
    const row = db.prepare(`
      SELECT t.*, b.name AS branch_name, b.parent_branch_id, b.fork_message_id, b.fork_sequence,
             p.name AS project_name
      FROM threads t JOIN branches b ON b.id = t.branch_id JOIN projects p ON p.id = t.project_id
      WHERE t.id = ?
    `).get(threadId);
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      branchId: row.branch_id,
      branchName: row.branch_name,
      parentBranchId: row.parent_branch_id,
      forkMessageId: row.fork_message_id,
      forkSequence: row.fork_sequence,
      title: row.title,
      codexThreadId: row.codex_thread_id,
      sourceThreadId: row.source_thread_id,
      paused: Boolean(row.paused),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function listThreads(projectId, branchId = null) {
    const rows = branchId
      ? db.prepare('SELECT id FROM threads WHERE project_id = ? AND branch_id = ? ORDER BY updated_at DESC').all(projectId, branchId)
      : db.prepare('SELECT id FROM threads WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
    return rows.map(({ id }) => getThread(id));
  }

  function threadDeletionPlan(threadId) {
    const thread = getThread(threadId);
    if (!thread) return null;
    const branches = db.prepare('SELECT id, parent_branch_id, fork_thread_id FROM branches WHERE project_id = ?').all(thread.projectId);
    const branchIds = new Set(branches.filter((branch) => branch.fork_thread_id === threadId).map((branch) => branch.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const branch of branches) {
        if (branch.parent_branch_id && branchIds.has(branch.parent_branch_id) && !branchIds.has(branch.id)) {
          branchIds.add(branch.id);
          changed = true;
        }
      }
    }
    const threadIds = new Set([threadId]);
    if (branchIds.size) {
      const placeholders = [...branchIds].map(() => '?').join(', ');
      for (const row of db.prepare(`SELECT id FROM threads WHERE branch_id IN (${placeholders})`).all(...branchIds)) threadIds.add(row.id);
    }
    const ids = [...threadIds];
    const placeholders = ids.map(() => '?').join(', ');
    const messageCount = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE thread_id IN (${placeholders})`).get(...ids).count;
    const importedArchives = db.prepare(`SELECT COUNT(*) AS count FROM archive_imports WHERE thread_id IN (${placeholders})`).get(...ids).count;
    return {
      thread,
      threadIds: ids,
      branchIds: [...branchIds],
      removed: { conversations: ids.length, branches: branchIds.size, messages: messageCount, importedArchives }
    };
  }

  function deleteThread(threadId) {
    const plan = threadDeletionPlan(threadId);
    if (!plan) return null;
    const { threadIds, branchIds, thread, removed } = plan;
    const placeholders = threadIds.map(() => '?').join(', ');
    transaction(() => {
      const messages = db.prepare(`SELECT id, sequence FROM messages WHERE thread_id IN (${placeholders})`).all(...threadIds);
      const removedMessages = new Set(messages.map((message) => message.id));
      const sequenceById = new Map(messages.map((message) => [message.id, message.sequence]));
      const ledgerRows = db.prepare('SELECT * FROM ledger_items WHERE project_id = ?').all(thread.projectId);
      const removedLedgerIds = new Set();
      for (const row of ledgerRows) {
        const sources = parseJson(row.source_message_ids_json, []);
        if (!sources.some((sourceId) => removedMessages.has(sourceId))) continue;
        const remainingSources = sources.filter((sourceId) => !removedMessages.has(sourceId)).sort();
        if (!remainingSources.length) {
          removedLedgerIds.add(row.id);
          continue;
        }
        const remainingSequences = remainingSources.map((sourceId) => sequenceById.get(sourceId) ??
          db.prepare('SELECT sequence FROM messages WHERE id = ?').get(sourceId)?.sequence ?? 0);
        const sourceSequence = Math.max(...remainingSequences);
        let nextFingerprint = fingerprint({
          type: row.item_type,
          subject: row.subject,
          content: row.content,
          details: parseJson(row.details_json),
          origin: row.origin,
          confidence: row.confidence,
          status: row.epistemic_status,
          sourceMessageIds: remainingSources,
          supersedesId: row.supersedes_id ?? null
        });
        if (db.prepare('SELECT id FROM ledger_items WHERE project_id = ? AND branch_id = ? AND fingerprint = ? AND id <> ?')
          .get(row.project_id, row.branch_id, nextFingerprint, row.id)) {
          nextFingerprint = fingerprint({ retainedLedgerId: row.id, sourceMessageIds: remainingSources });
        }
        db.prepare('UPDATE ledger_items SET source_message_ids_json = ?, source_sequence = ?, fingerprint = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(remainingSources), sourceSequence, nextFingerprint, now(), row.id);
      }
      if (removedMessages.size) {
        const messagePlaceholders = [...removedMessages].map(() => '?').join(', ');
        db.prepare(`DELETE FROM ledger_history WHERE source_message_id IN (${messagePlaceholders})`).run(...removedMessages);
      }
      if (removedLedgerIds.size) {
        const ledgerPlaceholders = [...removedLedgerIds].map(() => '?').join(', ');
        db.prepare(`DELETE FROM ledger_items WHERE id IN (${ledgerPlaceholders})`).run(...removedLedgerIds);
      }
      db.prepare(`DELETE FROM meta_notes WHERE thread_id IN (${placeholders})`).run(...threadIds);
      db.prepare(`DELETE FROM checkpoints WHERE thread_id IN (${placeholders})`).run(...threadIds);
      db.prepare(`DELETE FROM threads WHERE id IN (${placeholders})`).run(...threadIds);
      if (branchIds.length) {
        const branchPlaceholders = branchIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM branches WHERE id IN (${branchPlaceholders})`).run(...branchIds);
      }
    });
    if (hasFts) ftsReady(db);
    return { deleted: thread.title, removed };
  }

  function setThreadPaused(threadId, paused) {
    const timestamp = now();
    const outcome = db.prepare('UPDATE threads SET paused = ?, updated_at = ? WHERE id = ?')
      .run(paused ? 1 : 0, timestamp, threadId);
    return outcome.changes > 0 ? getThread(threadId) : null;
  }

  function setCodexThreadId(threadId, codexThreadId) {
    const outcome = db.prepare('UPDATE threads SET codex_thread_id = ?, updated_at = ? WHERE id = ?')
      .run(codexThreadId, now(), threadId);
    return outcome.changes > 0 ? getThread(threadId) : null;
  }

  function createBranch(threadId, name) {
    const source = getThread(threadId);
    if (!source) throw new Error('Thread not found.');
    const branchName = String(name ?? '').trim();
    if (!branchName) throw new Error('Branch name is required.');
    const timeline = getTranscript(threadId);
    const forkMessage = timeline.at(-1) ?? null;
    const branchId = makeId();
    const newThreadId = makeId();
    const timestamp = now();
    const title = `${source.title} · ${branchName}`;
    transaction(() => {
      db.prepare(`
        INSERT INTO branches(id, project_id, name, parent_branch_id, fork_message_id, fork_sequence, fork_thread_id, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(branchId, source.projectId, branchName, source.branchId, forkMessage?.id ?? null, forkMessage?.sequence ?? 0, threadId, timestamp);
      db.prepare(`
        INSERT INTO threads(id, project_id, branch_id, title, source_thread_id, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(newThreadId, source.projectId, branchId, title, threadId, timestamp, timestamp);
    });
    return { branch: { id: branchId, projectId: source.projectId, name: branchName, parentBranchId: source.branchId }, thread: getThread(newThreadId) };
  }

  function getTranscript(threadId, seen = new Set()) {
    if (seen.has(threadId)) return [];
    seen.add(threadId);
    const thread = getThread(threadId);
    if (!thread) return [];
    let inherited = [];
    if (thread.sourceThreadId) {
      inherited = getTranscript(thread.sourceThreadId, seen);
      if (thread.parentBranchId) inherited = inherited.filter((message) => message.sequence <= (thread.forkSequence ?? 0));
      inherited = inherited.map((message) => ({ ...message, inherited: true }));
    }
    const local = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence').all(threadId).map(normalizeMessage);
    return [...inherited, ...local];
  }

  function getThreadRevision(threadId) {
    const visibleIds = getTranscript(threadId).map((message) => message.id);
    if (!visibleIds.length) return 0;
    const placeholders = visibleIds.map(() => '?').join(',');
    return db.prepare(`SELECT COALESCE(MAX(revision), 0) AS revision FROM message_changes WHERE message_id IN (${placeholders})`)
      .get(...visibleIds)?.revision ?? 0;
  }

  function getThreadMessagesAfter(threadId, revision = 0) {
    const after = Number.isSafeInteger(Number(revision)) ? Math.max(0, Number(revision)) : 0;
    const visibleIds = getTranscript(threadId).map((message) => message.id);
    if (!visibleIds.length) return [];
    const placeholders = visibleIds.map(() => '?').join(',');
    return db.prepare(`
      SELECT m.* FROM messages m
      WHERE m.id IN (${placeholders})
        AND EXISTS (SELECT 1 FROM message_changes c WHERE c.message_id = m.id AND c.revision > ?)
      ORDER BY m.sequence
    `).all(...visibleIds, after).map(normalizeMessage);
  }

  function getDraft(threadId) {
    const row = db.prepare('SELECT content, updated_at FROM conversation_drafts WHERE thread_id = ?').get(threadId);
    return row ? { content: row.content, updatedAt: row.updated_at } : { content: '', updatedAt: null };
  }

  function saveDraft(threadId, content) {
    if (!getThread(threadId)) throw new Error('Conversation not found.');
    const text = String(content ?? '');
    if (!text.trim()) return clearDraft(threadId);
    const updatedAt = now();
    db.prepare(`
      INSERT INTO conversation_drafts(thread_id, content, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(threadId, text, updatedAt);
    return { content: text, updatedAt };
  }

  function clearDraft(threadId) {
    db.prepare('DELETE FROM conversation_drafts WHERE thread_id = ?').run(threadId);
    return { content: '', updatedAt: null };
  }

  function createGenerationAttempt({ requestId, threadId, userMessageId }) {
    const prior = getGenerationAttempt(requestId);
    if (prior) {
      if (prior.threadId !== threadId || prior.userMessageId !== userMessageId) throw new Error('This retry request identifier is already in use.');
      return { attempt: prior, created: false };
    }
    const thread = getThread(threadId);
    const message = getMessage(userMessageId);
    if (!thread || !message || message.threadId !== threadId || message.role !== 'user' || message.kind !== 'story') {
      throw new Error('Choose a saved user story turn in this conversation to retry.');
    }
    const id = makeId();
    const timestamp = now();
    db.prepare(`
      INSERT INTO generation_attempts(id, request_id, thread_id, user_message_id, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, String(requestId), threadId, userMessageId, timestamp, timestamp);
    return { attempt: getGenerationAttempt(requestId), created: true };
  }

  function getGenerationAttempt(requestId) {
    const row = db.prepare('SELECT * FROM generation_attempts WHERE request_id = ?').get(String(requestId));
    return row ? {
      id: row.id, requestId: row.request_id, threadId: row.thread_id, userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id, status: row.status, diagnostics: parseJson(row.diagnostics_json, {}),
      createdAt: row.created_at, updatedAt: row.updated_at
    } : null;
  }

  function updateGenerationAttempt(attemptId, { assistantMessageId, status, diagnostics }) {
    const sets = [];
    const args = [];
    if (assistantMessageId !== undefined) { sets.push('assistant_message_id = ?'); args.push(assistantMessageId); }
    if (status !== undefined) {
      if (!['pending', 'streaming', 'complete', 'failed', 'interrupted'].includes(status)) throw new Error('Invalid generation attempt status.');
      sets.push('status = ?'); args.push(status);
    }
    if (diagnostics !== undefined) {
      if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
        throw new Error('Generation diagnostics must be an object.');
      }
      const serialized = JSON.stringify(diagnostics);
      if (serialized.length > 16_384) throw new Error('Generation diagnostics are too large.');
      sets.push('diagnostics_json = ?'); args.push(serialized);
    }
    if (!sets.length) return null;
    args.push(now(), attemptId);
    db.prepare(`UPDATE generation_attempts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args);
    return db.prepare('SELECT * FROM generation_attempts WHERE id = ?').get(attemptId) ?? null;
  }

  function addUserMessage(threadId, content, { allowPaused = false } = {}) {
    const thread = getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    if (thread.paused && !allowPaused) throw new Error('This thread is paused. Use /resume before continuing.');
    return transaction(() => {
      const message = insertMessage({
        projectId: thread.projectId,
        branchId: thread.branchId,
        threadId,
        role: 'user',
        kind: 'story',
        content: String(content),
        status: 'complete'
      });
      const timestamp = now();
      db.prepare(`
        INSERT INTO memory_jobs(id, project_id, branch_id, thread_id, message_id, status, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(makeId(), thread.projectId, thread.branchId, threadId, message.id, timestamp, timestamp);
      return message;
    });
  }

  function addCommandMessage(threadId, content) {
    const thread = getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    return insertMessage({
      projectId: thread.projectId,
      branchId: thread.branchId,
      threadId,
      role: 'user',
      kind: 'command',
      content: String(content),
      status: 'complete'
    });
  }

  function addAssistantMessage(threadId, userMessageId, attemptId = null) {
    const thread = getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    return transaction(() => {
      const message = insertMessage({
        projectId: thread.projectId,
        branchId: thread.branchId,
        threadId,
        role: 'assistant',
        kind: 'story',
        content: '',
        status: 'streaming',
        sourceMessageId: userMessageId
      });
      db.prepare('UPDATE memory_jobs SET assistant_message_id = ?, updated_at = ? WHERE message_id = ?')
        .run(message.id, now(), userMessageId);
      if (attemptId) updateGenerationAttempt(attemptId, { assistantMessageId: message.id, status: 'streaming' });
      return message;
    });
  }

  function appendMessageDelta(messageId, delta) {
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!message || message.role !== 'assistant' || message.status !== 'streaming') return null;
    db.prepare('UPDATE messages SET content = content || ? WHERE id = ?').run(String(delta), messageId);
    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    syncSearchIndex(updated);
    return normalizeMessage(updated);
  }

  function completeAssistantMessage(messageId, finalContent = null) {
    const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!existing || existing.role !== 'assistant' || existing.status !== 'streaming') return null;
    const content = finalContent === null ? existing.content : String(finalContent);
    db.prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?').run(content, 'complete', messageId);
    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    syncSearchIndex(updated);
    return normalizeMessage(updated);
  }

  function failAssistantMessage(messageId, status, messageText = null) {
    if (!['failed', 'interrupted'].includes(status)) throw new Error('Invalid assistant status.');
    const current = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!current || current.role !== 'assistant' || current.status !== 'streaming') return null;
    const content = current.content || String(messageText ?? '');
    db.prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?').run(content, status, messageId);
    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    syncSearchIndex(updated);
    return normalizeMessage(updated);
  }

  function addSystemActivity(threadId, content, kind = 'status') {
    const thread = getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    return insertMessage({
      projectId: thread.projectId,
      branchId: thread.branchId,
      threadId,
      role: 'system',
      kind,
      content: String(content),
      status: 'complete'
    });
  }

  function getMessage(messageId) {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    return row ? normalizeMessage(row) : null;
  }

  function branchLineage(projectId, branchId) {
    return db.prepare(`
      WITH RECURSIVE lineage(branch_id, cutoff_sequence, depth) AS (
        SELECT id, ?, 0 FROM branches WHERE id = ? AND project_id = ?
        UNION ALL
        SELECT b.parent_branch_id, b.fork_sequence, lineage.depth + 1
        FROM lineage JOIN branches b ON b.id = lineage.branch_id
        WHERE b.parent_branch_id IS NOT NULL
      )
      SELECT lineage.branch_id, lineage.cutoff_sequence, lineage.depth
      FROM lineage JOIN branches b ON b.id = lineage.branch_id
      WHERE b.project_id = ?
    `).all(MAX_SEQUENCE, branchId, projectId, projectId);
  }

  function searchMessages(projectId, branchId, query, limit = 40, { threadId = null } = {}) {
    const searchText = String(query ?? '').trim();
    if (!searchText) return [];
    const lineage = branchLineage(projectId, branchId);
    if (!lineage.length) return [];
    const scopes = lineage.map(({ branch_id, cutoff_sequence }) => ({ branchId: branch_id, maxSequence: cutoff_sequence ?? MAX_SEQUENCE }));
    const scopeSql = scopes.map(() => '(branch_id = ? AND sequence <= ?)').join(' OR ');
    const scopeArgs = scopes.flatMap((scope) => [scope.branchId, scope.maxSequence]);
    const threadFilter = threadId ? ' AND m.thread_id = ?' : '';
    const plainThreadFilter = threadId ? ' AND thread_id = ?' : '';
    const tokens = [...searchText.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => match[0]).filter(Boolean).slice(0, 10);
    let rows = [];
    if (hasFts && tokens.length) {
      const expression = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
      try {
        rows = db.prepare(`
          SELECT m.* FROM message_search s JOIN messages m ON m.sequence = s.rowid
          WHERE message_search MATCH ? AND m.project_id = ? AND (${scopeSql})${threadFilter}
          ORDER BY m.sequence DESC LIMIT ?
        `).all(expression, projectId, ...scopeArgs, ...(threadId ? [threadId] : []), limit);
      } catch {
        rows = [];
      }
    }
    if (!rows.length) {
      const escaped = searchText.replace(/[\\%_]/g, '\\$&');
      rows = db.prepare(`
        SELECT * FROM messages WHERE project_id = ? AND content LIKE ? ESCAPE '\\' AND (${scopeSql})${plainThreadFilter}
        ORDER BY sequence DESC LIMIT ?
      `).all(projectId, `%${escaped}%`, ...scopeArgs, ...(threadId ? [threadId] : []), limit);
    }
    return rows.map((row) => normalizeMessage(row));
  }

  function searchRelevantMessages(projectId, branchId, query, limit = 16, threadId = null) {
    const searchText = String(query ?? '').trim();
    if (!searchText) return [];
    const lineage = branchLineage(projectId, branchId);
    if (!lineage.length) return [];
    const scopeSql = lineage.map(() => '(branch_id = ? AND sequence <= ?)').join(' OR ');
    const scopeArgs = lineage.flatMap(({ branch_id, cutoff_sequence }) => [branch_id, cutoff_sequence ?? MAX_SEQUENCE]);
    const tokens = [...new Set([...searchText.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => match[0].toLocaleLowerCase()))].slice(0, 20);
    if (!tokens.length) return [];
    const conversationFilter = threadId ? ' AND thread_id = ?' : '';
    const rows = db.prepare(`SELECT * FROM messages WHERE project_id = ? AND kind = 'story' AND (${scopeSql})${conversationFilter}`)
      .all(projectId, ...scopeArgs, ...(threadId ? [threadId] : []));
    return rows.map((row) => {
      const content = row.content.toLocaleLowerCase();
      const score = tokens.reduce((total, token) => total + (content.includes(token) ? 1 : 0), 0) +
        (content.includes(searchText.toLocaleLowerCase()) ? tokens.length : 0);
      return { row, score };
    }).filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || right.row.sequence - left.row.sequence)
      .slice(0, Math.max(0, Number(limit) || 0)).map(({ row }) => normalizeMessage(row));
  }

  function getLedgerItems(projectId, branchId, options = {}) {
    const rows = db.prepare(`
      WITH RECURSIVE lineage(branch_id, cutoff_sequence, depth) AS (
        SELECT id, ?, 0 FROM branches WHERE id = ? AND project_id = ?
        UNION ALL
        SELECT b.parent_branch_id, b.fork_sequence, lineage.depth + 1
        FROM lineage JOIN branches b ON b.id = lineage.branch_id
        WHERE b.parent_branch_id IS NOT NULL
      )
      SELECT li.* FROM ledger_items li
      JOIN lineage ON lineage.branch_id = li.branch_id
      WHERE li.project_id = ? AND (lineage.depth = 0 OR li.source_sequence <= lineage.cutoff_sequence)
      ORDER BY li.source_sequence DESC, li.created_at DESC
    `).all(MAX_SEQUENCE, branchId, projectId, projectId).map(normalizeLedger);
    const superseded = new Set(rows.filter((item) => item.supersedesId).map((item) => item.supersedesId));
    const effectiveRows = rows.map((item) => {
      if (item.status !== 'superseded' || superseded.has(item.id)) return item;
      const previous = db.prepare("SELECT before_json FROM ledger_history WHERE ledger_item_id = ? AND action = 'superseded' ORDER BY created_at LIMIT 1")
        .get(item.id);
      const priorStatus = previous?.before_json ? parseJson(previous.before_json, {})?.status : null;
      return { ...item, status: ['current', 'uncertain', 'resolved', 'abandoned'].includes(priorStatus) ? priorStatus : 'current' };
    });
    if (options.includeSuperseded) return effectiveRows;
    return effectiveRows.filter((item) => item.status !== 'superseded' && !superseded.has(item.id));
  }

  function getEffectiveLedger(projectId, branchId) {
    return getLedgerItems(projectId, branchId).filter((item) => ['current', 'uncertain'].includes(item.status));
  }

  function getLedgerItem(projectId, branchId, ledgerItemId) {
    return getLedgerItems(projectId, branchId, { includeSuperseded: true }).find((item) => item.id === ledgerItemId) ?? null;
  }

  function listLedgerHistory(projectId, branchId, ledgerItemId = null) {
    const visibleIds = new Set(getLedgerItems(projectId, branchId, { includeSuperseded: true }).map((item) => item.id));
    const visibleMessageIds = new Set(getTranscriptIdsForBranch(projectId, branchId));
    if (ledgerItemId && !visibleIds.has(ledgerItemId)) return [];
    const query = ledgerItemId
      ? 'SELECT * FROM ledger_history WHERE project_id = ? AND ledger_item_id = ? ORDER BY created_at'
      : 'SELECT * FROM ledger_history WHERE project_id = ? ORDER BY created_at';
    const rows = ledgerItemId
      ? db.prepare(query).all(projectId, ledgerItemId)
      : db.prepare(query).all(projectId);
    return rows.filter((row) => visibleIds.has(row.ledger_item_id) && visibleMessageIds.has(row.source_message_id)).map((row) => ({
      id: row.id, projectId: row.project_id, branchId: row.branch_id, ledgerItemId: row.ledger_item_id,
      action: row.action, before: row.before_json ? parseJson(row.before_json, null) : null,
      after: parseJson(row.after_json), sourceMessageId: row.source_message_id, createdAt: row.created_at
    }));
  }

  function visibleSourceMessages(projectId, branchId, messageIds) {
    const idList = [...new Set(messageIds)];
    if (!idList.length) throw new Error('At least one source message is required.');
    const placeholders = idList.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM messages WHERE project_id = ? AND id IN (${placeholders})`).all(projectId, ...idList);
    if (rows.length !== idList.length) throw new Error('A source message was not found in this project.');
    const lineage = branchLineage(projectId, branchId);
    const inLineage = new Map(lineage.map((item) => [item.branch_id, item.cutoff_sequence ?? MAX_SEQUENCE]));
    for (const row of rows) {
      const cutoff = inLineage.get(row.branch_id);
      if (cutoff === undefined || row.sequence > cutoff) throw new Error('A source message is outside this branch timeline.');
    }
    return rows;
  }

  function getTranscriptIdsForBranch(projectId, branchId) {
    const scopes = branchLineage(projectId, branchId);
    if (!scopes.length) return [];
    const scopeSql = scopes.map(() => '(branch_id = ? AND sequence <= ?)').join(' OR ');
    const args = scopes.flatMap(({ branch_id, cutoff_sequence }) => [branch_id, cutoff_sequence ?? MAX_SEQUENCE]);
    const rows = db.prepare(`SELECT id FROM messages WHERE project_id = ? AND (${scopeSql})`).all(projectId, ...args);
    return rows.map((row) => row.id);
  }

  function insertLedgerItem(values) {
    const sourceRows = visibleSourceMessages(values.projectId, values.branchId, values.sourceMessageIds);
    const sortedSources = [...new Set(values.sourceMessageIds)].sort();
    const data = {
      type: values.type,
      subject: String(values.subject ?? '').trim(),
      content: String(values.content ?? '').trim(),
      details: values.details ?? {},
      origin: values.origin ?? 'user_established',
      confidence: Number(values.confidence ?? 1),
      status: values.status ?? 'current',
      sourceMessageIds: sortedSources,
      supersedesId: values.supersedesId ?? null
    };
    if (!data.subject || !data.content) throw new Error('Ledger subject and content are required.');
    if (!Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1) throw new Error('Confidence must be between 0 and 1.');
    if (['claim_or_rumor', 'hypothesis'].includes(data.origin) && data.status === 'current') data.status = 'uncertain';
    const sourceSequence = Math.max(...sourceRows.map((row) => row.sequence));
    const id = makeId();
    const timestamp = now();
    const hash = fingerprint({ ...data, sourceMessageIds: sortedSources });
    const result = db.prepare(`
      INSERT OR IGNORE INTO ledger_items(
        id, project_id, branch_id, item_type, subject, content, details_json, origin, confidence,
        epistemic_status, source_message_ids_json, source_sequence, supersedes_id, fingerprint, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, values.projectId, values.branchId, data.type, data.subject, data.content, JSON.stringify(data.details), data.origin,
      data.confidence, data.status, JSON.stringify(sortedSources), sourceSequence, data.supersedesId, hash, timestamp, timestamp);
    const actualId = result.changes ? id : db.prepare('SELECT id FROM ledger_items WHERE project_id = ? AND branch_id = ? AND fingerprint = ?').get(values.projectId, values.branchId, hash).id;
    return getLedgerItems(values.projectId, values.branchId, { includeSuperseded: true }).find((item) => item.id === actualId);
  }

  function appendLedgerItem(values) {
    return transaction(() => {
      const item = insertLedgerItem(values);
      const createdHistory = db.prepare("SELECT 1 FROM ledger_history WHERE ledger_item_id = ? AND action = 'created' LIMIT 1").get(item.id);
      if (values.sourceMessageIds?.length && !createdHistory) {
        const sourceMessageId = values.sourceMessageIds[0];
        db.prepare(`
          INSERT INTO ledger_history(id, project_id, branch_id, ledger_item_id, action, before_json, after_json, source_message_id, created_at)
          VALUES(?, ?, ?, ?, 'created', NULL, ?, ?, ?)
        `).run(makeId(), values.projectId, values.branchId, item.id, JSON.stringify(item), sourceMessageId, now());
      }
      return item;
    });
  }

  function retconLedgerItem(projectId, branchId, oldItemId, correction, sourceMessageId) {
    return reviseLedgerItem(projectId, branchId, oldItemId, { content: correction }, sourceMessageId);
  }

  function reviseLedgerItem(projectId, branchId, oldItemId, updates, sourceMessageId) {
    return transaction(() => {
      const oldItem = getLedgerItem(projectId, branchId, oldItemId);
      if (!oldItem) throw new Error('Fact not found in this project or branch.');
      const source = visibleSourceMessages(projectId, branchId, [sourceMessageId])[0];
      const before = JSON.stringify(oldItem);
      const item = insertLedgerItem({
        projectId,
        branchId,
        type: oldItem.type,
        subject: oldItem.subject,
        content: String(updates.content ?? oldItem.content),
        details: { ...oldItem.details, ...(updates.details ?? {}), correctionOf: oldItemId },
        origin: 'user_correction',
        confidence: 1,
        status: 'current',
        sourceMessageIds: [sourceMessageId],
        supersedesId: oldItemId
      });
      db.prepare(`
        INSERT INTO ledger_history(id, project_id, branch_id, ledger_item_id, action, before_json, after_json, source_message_id, created_at)
        VALUES(?, ?, ?, ?, 'retcon', ?, ?, ?, ?)
      `).run(makeId(), projectId, branchId, item.id, before, JSON.stringify(item), sourceMessageId, now());
      db.prepare(`
        INSERT INTO ledger_history(id, project_id, branch_id, ledger_item_id, action, before_json, after_json, source_message_id, created_at)
        VALUES(?, ?, ?, ?, 'correction_linked', ?, ?, ?, ?)
      `).run(makeId(), projectId, branchId, oldItemId, before, JSON.stringify({ ...oldItem, correctionId: item.id }), sourceMessageId, now());
      return { item, sourceSequence: source.sequence };
    });
  }

  function updateLedgerItem(projectId, branchId, oldItemId, patch, sourceMessageId) {
    return reviseLedgerItem(projectId, branchId, oldItemId, patch, sourceMessageId);
  }

  function listMemoryJobs(projectId = null, branchId = null, includeErrors = false) {
    const statuses = includeErrors ? "('pending', 'processing', 'error')" : "('pending', 'error')";
    const filters = [];
    const args = [];
    if (projectId) { filters.push('project_id = ?'); args.push(projectId); }
    if (branchId) { filters.push('branch_id = ?'); args.push(branchId); }
    const where = filters.length ? ` AND ${filters.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM memory_jobs WHERE status IN ${statuses}${where} ORDER BY created_at`).all(...args).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      branchId: row.branch_id,
      threadId: row.thread_id,
      messageId: row.message_id,
      assistantMessageId: row.assistant_message_id,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  function getMemoryJobForMessage(messageId) {
    const row = db.prepare('SELECT * FROM memory_jobs WHERE message_id = ?').get(messageId);
    if (!row) return null;
    return {
      id: row.id, projectId: row.project_id, branchId: row.branch_id, threadId: row.thread_id,
      messageId: row.message_id, assistantMessageId: row.assistant_message_id, status: row.status,
      attempts: row.attempts, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  function markMemoryJobProcessing(jobId) {
    db.prepare(`UPDATE memory_jobs SET status = 'processing', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), jobId);
  }

  function markMemoryJobIndexed(jobId) {
    db.prepare(`UPDATE memory_jobs SET status = 'indexed', error = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), jobId);
  }

  function commitMemoryJob(jobId, entries) {
    return transaction(() => {
      const job = db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(jobId);
      if (!job) throw new Error('Continuity job not found.');
      const items = entries.map((entry) => appendLedgerItem({
        projectId: job.project_id,
        branchId: job.branch_id,
        type: entry.type,
        subject: entry.subject,
        content: entry.content,
        details: entry.details,
        origin: entry.origin,
        confidence: entry.confidence,
        status: entry.status,
        sourceMessageIds: entry.sourceMessageIds
      }));
      markMemoryJobIndexed(jobId);
      return items;
    });
  }

  function markMemoryJobError(jobId, errorMessage) {
    db.prepare(`UPDATE memory_jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ?`)
      .run(String(errorMessage).slice(0, 500), now(), jobId);
  }

  function markMemoryJobPending(jobId) {
    db.prepare(`UPDATE memory_jobs SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), jobId);
  }

  function retryMemoryJobs(projectId = null) {
    let update;
    if (projectId) {
      update = db.prepare(`UPDATE memory_jobs SET status = 'pending', error = NULL, updated_at = ? WHERE project_id = ? AND status = 'error'`)
        .run(now(), projectId);
    } else {
      update = db.prepare(`UPDATE memory_jobs SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'error'`)
        .run(now());
    }
    const counts = { pending: 0, processing: 0, error: 0 };
    for (const job of listMemoryJobs(projectId, null, true)) counts[job.status] += 1;
    return { requeued: Number(update.changes), counts };
  }

  function memoryStatus(projectId, branchId) {
    const lineage = new Map(branchLineage(projectId, branchId)
      .map(({ branch_id, cutoff_sequence }) => [branch_id, cutoff_sequence ?? MAX_SEQUENCE]));
    const jobs = db.prepare(`
      SELECT j.*, m.sequence, m.id AS source_id, m.created_at AS source_created_at
      FROM memory_jobs j JOIN messages m ON m.id = j.message_id
      WHERE j.project_id = ? ORDER BY m.sequence
    `).all(projectId).filter((job) => lineage.has(job.branch_id) && job.sequence <= lineage.get(job.branch_id));
    return summarizeMemoryJobs(jobs);
  }

  function memoryStatusForThread(threadId) {
    const thread = getThread(threadId);
    if (!thread) return { state: 'current', counts: {}, lastIndexed: null, error: null };
    const jobs = db.prepare(`
      SELECT j.*, m.sequence, m.id AS source_id, m.created_at AS source_created_at
      FROM memory_jobs j JOIN messages m ON m.id = j.message_id
      WHERE j.thread_id = ? ORDER BY m.sequence
    `).all(threadId);
    return summarizeMemoryJobs(jobs);
  }

  function summarizeMemoryJobs(jobs) {
    const statusCounts = {};
    for (const job of jobs) statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1;
    const lastIndexedJob = [...jobs].reverse().find((job) => job.status === 'indexed');
    const lastIndexed = lastIndexedJob ? {
      id: lastIndexedJob.source_id,
      sequence: lastIndexedJob.sequence,
      created_at: lastIndexedJob.source_created_at
    } : null;
    const error = [...jobs].reverse().find((job) => job.status === 'error');
    if (statusCounts.processing) return { state: 'processing', counts: statusCounts, lastIndexed: lastIndexed ?? null, error: null };
    if (statusCounts.error) return { state: 'error', counts: statusCounts, lastIndexed, error: error?.error ?? null };
    if (statusCounts.pending) return { state: 'pending', counts: statusCounts, lastIndexed, error: null };
    return { state: 'current', counts: statusCounts, lastIndexed, error: null };
  }

  function addMetaNote(threadId, messageId, content) {
    const thread = getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    const id = makeId();
    db.prepare(`INSERT INTO meta_notes(id, project_id, branch_id, thread_id, message_id, content, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`)
      .run(id, thread.projectId, thread.branchId, threadId, messageId, String(content), now());
    return { id, projectId: thread.projectId, branchId: thread.branchId, threadId, messageId, content: String(content) };
  }

  function listMetaNotes(projectId, branchId, limit = 20) {
    return db.prepare('SELECT * FROM meta_notes WHERE project_id = ? AND branch_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(projectId, branchId, limit).reverse().map((row) => ({
        id: row.id, projectId: row.project_id, branchId: row.branch_id, threadId: row.thread_id,
        messageId: row.message_id, content: row.content, createdAt: row.created_at
      }));
  }

  function addCheckpoint(threadId, messageId, payload) {
    const thread = getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    const id = makeId();
    const createdAt = now();
    const serialized = JSON.stringify(payload);
    db.prepare(`INSERT INTO checkpoints(id, project_id, branch_id, thread_id, message_id, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`)
      .run(id, thread.projectId, thread.branchId, threadId, messageId, serialized, createdAt);
    return { id, projectId: thread.projectId, branchId: thread.branchId, threadId, messageId, payload, createdAt };
  }

  function listCheckpoints(projectId, branchId) {
    return db.prepare('SELECT * FROM checkpoints WHERE project_id = ? AND branch_id = ? ORDER BY created_at DESC')
      .all(projectId, branchId).map((row) => ({
        id: row.id, projectId: row.project_id, branchId: row.branch_id, threadId: row.thread_id,
        messageId: row.message_id, payload: parseJson(row.payload_json), createdAt: row.created_at
      }));
  }

  function writeArchiveContents(projectId, branchId, threadId, fileName, rawContent, parsedItems) {
    const sha256 = createHash('sha256').update(rawContent).digest('hex');
    db.prepare('INSERT INTO archive_imports(id, project_id, thread_id, file_name, source_sha256, raw_content, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(makeId(), projectId, threadId, String(fileName).slice(0, 200), sha256, rawContent, now());

    const isMessageList = parsedItems.every((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string');
    let importedTurns = 0;
    let importedMessages = 0;
    if (isMessageList) {
      let pendingUser = null;
      for (const item of parsedItems) {
        const message = insertMessage({
          projectId, branchId, threadId, role: item.role, kind: 'story', content: item.content, status: 'complete',
          sourceMessageId: item.role === 'assistant' ? pendingUser?.id ?? null : null,
          createdAt: item.createdAt
        });
        importedMessages += 1;
        if (item.role === 'user') {
          importedTurns += 1;
          pendingUser = message;
          db.prepare(`INSERT INTO memory_jobs(id, project_id, branch_id, thread_id, message_id, status, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, 'pending', ?, ?)`)
            .run(makeId(), projectId, branchId, threadId, message.id, now(), now());
        } else if (pendingUser) {
          db.prepare('UPDATE memory_jobs SET assistant_message_id = ?, updated_at = ? WHERE message_id = ?')
            .run(message.id, now(), pendingUser.id);
          pendingUser = null;
        }
      }
    } else {
      for (const turn of parsedItems) {
        const user = insertMessage({ projectId, branchId, threadId, role: 'user', kind: 'story', content: turn.user, status: 'complete' });
        db.prepare(`INSERT INTO memory_jobs(id, project_id, branch_id, thread_id, message_id, status, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(makeId(), projectId, branchId, threadId, user.id, now(), now());
        const assistant = insertMessage({ projectId, branchId, threadId, role: 'assistant', kind: 'story', content: turn.assistant, status: 'complete', sourceMessageId: user.id });
        db.prepare('UPDATE memory_jobs SET assistant_message_id = ?, updated_at = ? WHERE message_id = ?')
          .run(assistant.id, now(), user.id);
        importedTurns += 1;
        importedMessages += 2;
      }
    }
    db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now(), threadId);
    return { importedTurns, importedMessages, sourceSha256: sha256 };
  }

  function importArchive(projectId, fileName, rawContent, parsedItems) {
    const project = getProject(projectId);
    if (!project) throw new Error('Project not found.');
    const branch = db.prepare('SELECT id FROM branches WHERE project_id = ? AND parent_branch_id IS NULL ORDER BY created_at LIMIT 1').get(projectId);
    if (!branch) throw new Error('Main branch not found.');
    return transaction(() => {
      const thread = createThread(projectId, branch.id, `Imported · ${String(fileName).slice(0, 70)}`);
      const imported = writeArchiveContents(projectId, branch.id, thread.id, fileName, rawContent, parsedItems);
      return { thread, ...imported };
    });
  }

  function importArchiveAsProject(name, fileName, rawContent, parsedMessages) {
    const projectId = makeId();
    const branchId = makeId();
    const threadId = makeId();
    const timestamp = now();
    const projectName = String(name ?? '').trim();
    if (!projectName) throw new Error('Project name is required.');
    return transaction(() => {
      db.prepare('INSERT INTO projects(id, name, instructions, created_at, updated_at) VALUES(?, ?, ?, ?, ?)')
        .run(projectId, projectName, '', timestamp, timestamp);
      db.prepare('INSERT INTO branches(id, project_id, name, created_at) VALUES(?, ?, ?, ?)')
        .run(branchId, projectId, 'Main', timestamp);
      db.prepare('INSERT INTO threads(id, project_id, branch_id, title, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
        .run(threadId, projectId, branchId, `Imported · ${String(fileName).slice(0, 70)}`, timestamp, timestamp);
      const imported = writeArchiveContents(projectId, branchId, threadId, fileName, rawContent, parsedMessages);
      return { project: getProject(projectId), branch: { id: branchId, name: 'Main', projectId }, thread: getThread(threadId), ...imported };
    });
  }

  function listArchiveImports(projectId) {
    return db.prepare('SELECT id, project_id, file_name, source_sha256, length(raw_content) AS bytes, created_at FROM archive_imports WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId).map((row) => ({ id: row.id, projectId: row.project_id, fileName: row.file_name, sha256: row.source_sha256, bytes: row.bytes, createdAt: row.created_at }));
  }

  function projectRows(projectId) {
    if (!getProject(projectId)) return null;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    return {
      project: { ...getProject(projectId) },
      branches: db.prepare('SELECT * FROM branches WHERE project_id = ? ORDER BY created_at').all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, name: row.name, parentBranchId: row.parent_branch_id,
        forkMessageId: row.fork_message_id, forkSequence: row.fork_sequence, forkThreadId: row.fork_thread_id, createdAt: row.created_at
      })),
      threads: db.prepare('SELECT * FROM threads WHERE project_id = ? ORDER BY created_at').all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, branchId: row.branch_id, title: row.title,
        codexThreadId: row.codex_thread_id, sourceThreadId: row.source_thread_id, paused: Boolean(row.paused),
        createdAt: row.created_at, updatedAt: row.updated_at
      })),
      messages: db.prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY sequence').all(projectId).map((row) => ({
        id: row.id, sequence: row.sequence, projectId: row.project_id, branchId: row.branch_id, threadId: row.thread_id,
        role: row.role, kind: row.kind, content: row.content, status: row.status, createdAt: row.created_at,
        sourceMessageId: row.source_message_id
      })),
      ledgerItems: db.prepare('SELECT * FROM ledger_items WHERE project_id = ? ORDER BY created_at').all(projectId).map((row) => ({
        ...normalizeLedger(row), fingerprint: row.fingerprint
      })),
      ledgerHistory: db.prepare('SELECT * FROM ledger_history WHERE project_id = ? ORDER BY created_at').all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, branchId: row.branch_id, ledgerItemId: row.ledger_item_id,
        action: row.action, before: row.before_json ? parseJson(row.before_json, null) : null,
        after: parseJson(row.after_json), sourceMessageId: row.source_message_id, createdAt: row.created_at
      })),
      memoryJobs: db.prepare('SELECT * FROM memory_jobs WHERE project_id = ? ORDER BY created_at').all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, branchId: row.branch_id, threadId: row.thread_id,
        messageId: row.message_id, assistantMessageId: row.assistant_message_id, status: row.status,
        attempts: row.attempts, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at
      })),
      metaNotes: db.prepare('SELECT * FROM meta_notes WHERE project_id = ? ORDER BY created_at').all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, branchId: row.branch_id, threadId: row.thread_id,
        messageId: row.message_id, content: row.content, createdAt: row.created_at
      })),
      checkpoints: db.prepare('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at').all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, branchId: row.branch_id, threadId: row.thread_id,
        messageId: row.message_id, payload: parseJson(row.payload_json), createdAt: row.created_at
      })),
      archives: db.prepare('SELECT * FROM archive_imports WHERE project_id = ? ORDER BY created_at').all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, threadId: row.thread_id, fileName: row.file_name, sha256: row.source_sha256,
        rawContent: row.raw_content, createdAt: row.created_at
      })),
      projectHistory: db.prepare('SELECT * FROM project_history WHERE project_id = ? ORDER BY created_at').all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, action: row.action,
        before: row.before_json ? parseJson(row.before_json, null) : null,
        after: parseJson(row.after_json), sourceMessageId: row.source_message_id, createdAt: row.created_at
      }))
    };
  }

  function getProjectExport(projectId) {
    const data = projectRows(projectId);
    if (!data) return null;
    return { format: 'timeless-sovereign-project', version: 1, exportedAt: now(), data };
  }

  function importProject(document, options = {}) {
    if (document?.format !== 'timeless-sovereign-project' || document?.version !== 1 || !document.data?.project) {
      throw new Error('This file is not a supported story project export.');
    }
    const data = document.data;
    const preserveIds = Boolean(options.preserveIds);
    const id = (value) => preserveIds ? value : makeId();
    const projectId = id(data.project.id);
    if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('Project identifiers already exist in this database.');
    const branchMap = new Map(data.branches.map((row) => [row.id, id(row.id)]));
    const threadMap = new Map(data.threads.map((row) => [row.id, id(row.id)]));
    const messageMap = new Map(data.messages.map((row) => [row.id, id(row.id)]));
    const ledgerMap = new Map(data.ledgerItems.map((row) => [row.id, id(row.id)]));
    const mapValue = (map, value) => value == null ? null : map.get(value) ?? null;
    const importTime = now();
    transaction(() => {
      const memoryScope = data.project.memoryScope === 'thread' ? 'thread' : 'project';
      db.prepare('INSERT INTO projects(id, name, instructions, style, memory_scope, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(projectId, data.project.name, data.project.instructions ?? '', data.project.style ?? '', memoryScope, importTime, importTime);
      for (const row of data.branches) {
        db.prepare(`INSERT INTO branches(id, project_id, name, parent_branch_id, fork_message_id, fork_sequence, fork_thread_id, created_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(branchMap.get(row.id), projectId, row.name, mapValue(branchMap, row.parentBranchId), mapValue(messageMap, row.forkMessageId),
            row.forkSequence ?? null, mapValue(threadMap, row.forkThreadId), row.createdAt ?? importTime);
      }
      for (const row of data.threads) {
        db.prepare(`INSERT INTO threads(id, project_id, branch_id, title, codex_thread_id, source_thread_id, paused, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(threadMap.get(row.id), projectId, branchMap.get(row.branchId), row.title, preserveIds ? row.codexThreadId : null,
            mapValue(threadMap, row.sourceThreadId), row.paused ? 1 : 0, row.createdAt ?? importTime, row.updatedAt ?? importTime);
      }
      for (const row of data.messages) {
        db.prepare(`INSERT INTO messages(sequence, id, project_id, branch_id, thread_id, role, kind, content, status, created_at, source_message_id)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(preserveIds ? row.sequence : null, messageMap.get(row.id), projectId, branchMap.get(row.branchId), threadMap.get(row.threadId),
            row.role, row.kind, row.content, row.status, row.createdAt ?? importTime, mapValue(messageMap, row.sourceMessageId));
      }
      if (!preserveIds) {
        for (const row of data.branches) {
          const forkMessageId = mapValue(messageMap, row.forkMessageId);
          const forkSequence = forkMessageId
            ? db.prepare('SELECT sequence FROM messages WHERE id = ?').get(forkMessageId)?.sequence ?? 0
            : 0;
          db.prepare('UPDATE branches SET fork_sequence = ? WHERE id = ?').run(forkSequence, branchMap.get(row.id));
        }
      }
      for (const row of data.ledgerItems) {
        const sources = (row.sourceMessageIds ?? []).map((source) => mapValue(messageMap, source)).filter(Boolean);
        if (sources.length !== (row.sourceMessageIds ?? []).length) throw new Error('An exported ledger source could not be matched to a message.');
        const sourceSequence = Math.max(...sources.map((sourceId) => db.prepare('SELECT sequence FROM messages WHERE id = ?').get(sourceId).sequence));
        const newFingerprint = fingerprint({
          type: row.type, subject: row.subject, content: row.content, details: row.details ?? {}, origin: row.origin,
          confidence: row.confidence, status: row.status, sourceMessageIds: [...sources].sort(), supersedesId: mapValue(ledgerMap, row.supersedesId)
        });
        db.prepare(`INSERT INTO ledger_items(id, project_id, branch_id, item_type, subject, content, details_json, origin, confidence,
          epistemic_status, source_message_ids_json, source_sequence, supersedes_id, fingerprint, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(ledgerMap.get(row.id), projectId, branchMap.get(row.branchId), row.type, row.subject, row.content, JSON.stringify(row.details ?? {}),
            row.origin, row.confidence, row.status, JSON.stringify(sources), sourceSequence, mapValue(ledgerMap, row.supersedesId), newFingerprint,
            row.createdAt ?? importTime, row.updatedAt ?? importTime);
      }
      for (const row of data.ledgerHistory) {
        const remapSnapshot = (snapshot) => {
          if (!snapshot || typeof snapshot !== 'object') return snapshot;
          const sources = (snapshot.sourceMessageIds ?? []).map((source) => mapValue(messageMap, source)).filter(Boolean);
          const mappedSourceSequence = sources.length
            ? Math.max(...sources.map((sourceId) => db.prepare('SELECT sequence FROM messages WHERE id = ?').get(sourceId).sequence))
            : snapshot.sourceSequence;
          return {
            ...snapshot,
            id: mapValue(ledgerMap, snapshot.id) ?? snapshot.id,
            projectId,
            branchId: mapValue(branchMap, snapshot.branchId) ?? snapshot.branchId,
            sourceMessageIds: sources.length ? sources : snapshot.sourceMessageIds,
            sourceSequence: mappedSourceSequence,
            supersedesId: mapValue(ledgerMap, snapshot.supersedesId) ?? null
          };
        };
        db.prepare(`INSERT INTO ledger_history(id, project_id, branch_id, ledger_item_id, action, before_json, after_json, source_message_id, created_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id(row.id), projectId, branchMap.get(row.branchId), mapValue(ledgerMap, row.ledgerItemId), row.action,
            row.before ? JSON.stringify(remapSnapshot(row.before)) : null, JSON.stringify(remapSnapshot(row.after)), mapValue(messageMap, row.sourceMessageId), row.createdAt ?? importTime);
      }
      for (const row of data.memoryJobs) {
        db.prepare(`INSERT INTO memory_jobs(id, project_id, branch_id, thread_id, message_id, assistant_message_id, status, attempts, error, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id(row.id), projectId, branchMap.get(row.branchId), threadMap.get(row.threadId), mapValue(messageMap, row.messageId),
            mapValue(messageMap, row.assistantMessageId), preserveIds ? row.status : (row.status === 'indexed' ? 'pending' : row.status),
            row.attempts ?? 0, row.error ?? null, row.createdAt ?? importTime, row.updatedAt ?? importTime);
      }
      for (const row of data.metaNotes) {
        db.prepare('INSERT INTO meta_notes(id, project_id, branch_id, thread_id, message_id, content, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(id(row.id), projectId, branchMap.get(row.branchId), threadMap.get(row.threadId), mapValue(messageMap, row.messageId), row.content, row.createdAt ?? importTime);
      }
      for (const row of data.checkpoints) {
        db.prepare('INSERT INTO checkpoints(id, project_id, branch_id, thread_id, message_id, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(id(row.id), projectId, branchMap.get(row.branchId), threadMap.get(row.threadId), mapValue(messageMap, row.messageId), JSON.stringify(row.payload), row.createdAt ?? importTime);
      }
      for (const row of data.archives) {
        db.prepare('INSERT INTO archive_imports(id, project_id, thread_id, file_name, source_sha256, raw_content, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(id(row.id), projectId, mapValue(threadMap, row.threadId), row.fileName, row.sha256, row.rawContent, row.createdAt ?? importTime);
      }
      for (const row of data.projectHistory) {
        db.prepare('INSERT INTO project_history(id, project_id, action, before_json, after_json, source_message_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(id(row.id), projectId, row.action, row.before ? JSON.stringify(row.before) : null, JSON.stringify(row.after),
            mapValue(messageMap, row.sourceMessageId), row.createdAt ?? importTime);
      }
    });
    if (hasFts) ftsReady(db);
    return getProject(projectId);
  }

  function getBackup() {
    const projects = db.prepare('SELECT id FROM projects ORDER BY created_at').all().map(({ id }) => projectRows(id));
    const settings = db.prepare('SELECT key, value, updated_at AS updatedAt FROM app_settings ORDER BY key').all();
    const drafts = db.prepare('SELECT thread_id AS threadId, content, updated_at AS updatedAt FROM conversation_drafts ORDER BY thread_id').all();
    const generationAttempts = db.prepare(`SELECT id, request_id AS requestId, thread_id AS threadId,
      user_message_id AS userMessageId, assistant_message_id AS assistantMessageId, status,
      diagnostics_json AS diagnosticsJson, created_at AS createdAt, updated_at AS updatedAt
      FROM generation_attempts ORDER BY created_at`).all().map(({ diagnosticsJson, ...attempt }) => ({
      ...attempt,
      diagnostics: parseJson(diagnosticsJson, {})
    }));
    return { format: 'timeless-sovereign-backup', version: 1, createdAt: now(), projects, settings, drafts, generationAttempts };
  }

  function restoreBackup(document) {
    if (document?.format !== 'timeless-sovereign-backup' || document.version !== 1 || !Array.isArray(document.projects)) {
      throw new Error('This file is not a supported Story Studio backup.');
    }
    transaction(() => {
      db.exec(`
        DELETE FROM project_history; DELETE FROM ledger_history; DELETE FROM memory_jobs; DELETE FROM meta_notes;
        DELETE FROM checkpoints; DELETE FROM archive_imports; DELETE FROM ledger_items; DELETE FROM messages;
        DELETE FROM threads; DELETE FROM branches; DELETE FROM projects;
      `);
      for (const original of document.projects) {
        const data = structuredClone(original);
        data.messages = (data.messages ?? []).map((message) => ({
          ...message,
          status: message.status === 'streaming' ? 'interrupted' : message.status
        }));
        data.memoryJobs = (data.memoryJobs ?? []).map((job) => ({
          ...job,
          status: job.status === 'processing' ? 'pending' : job.status,
          error: job.status === 'processing' ? null : job.error
        }));
        importProject({ format: 'timeless-sovereign-project', version: 1, data }, { preserveIds: true });
      }
      for (const draft of document.drafts ?? []) {
        if (typeof draft?.threadId !== 'string' || typeof draft.content !== 'string' || !getThread(draft.threadId)) {
          throw new Error('The backup contains an invalid conversation draft.');
        }
        db.prepare('INSERT INTO conversation_drafts(thread_id, content, updated_at) VALUES(?, ?, ?)')
          .run(draft.threadId, draft.content, draft.updatedAt ?? now());
      }
      for (const attempt of document.generationAttempts ?? []) {
        const status = ['pending', 'streaming'].includes(attempt.status) ? 'interrupted' : attempt.status;
        if (!['interrupted', 'complete', 'failed'].includes(status) || typeof attempt?.requestId !== 'string' ||
            !getThread(attempt.threadId) || !getMessage(attempt.userMessageId)) {
          throw new Error('The backup contains an invalid generation attempt.');
        }
        const diagnostics = attempt.diagnostics ?? {};
        if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics) || JSON.stringify(diagnostics).length > 16_384) {
          throw new Error('The backup contains invalid generation diagnostics.');
        }
        db.prepare(`INSERT INTO generation_attempts(id, request_id, thread_id, user_message_id, assistant_message_id, status, diagnostics_json, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(attempt.id ?? makeId(), attempt.requestId, attempt.threadId, attempt.userMessageId,
            attempt.assistantMessageId && getMessage(attempt.assistantMessageId) ? attempt.assistantMessageId : null,
            status, JSON.stringify(diagnostics), attempt.createdAt ?? now(), attempt.updatedAt ?? now());
      }
      if (Array.isArray(document.settings)) {
        db.exec('DELETE FROM app_settings;');
        const insertSetting = db.prepare('INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, ?)');
        for (const setting of document.settings) {
          if (typeof setting?.key !== 'string' || typeof setting?.value !== 'string') throw new Error('The backup contains an invalid app setting.');
          insertSetting.run(setting.key, setting.value, setting.updatedAt ?? now());
        }
      }
    });
    if (hasFts) ftsReady(db);
    return listProjects();
  }

  function getSetting(key, fallback = null) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  function setSetting(key, value) {
    db.prepare(`INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, String(value), now());
  }

  function addProjectHistory(projectId, action, before, after, sourceMessageId = null) {
    db.prepare('INSERT INTO project_history(id, project_id, action, before_json, after_json, source_message_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(makeId(), projectId, action, before == null ? null : JSON.stringify(before), JSON.stringify(after), sourceMessageId, now());
  }

  function listProjectHistory(projectId) {
    return db.prepare('SELECT * FROM project_history WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId).map((row) => ({
        id: row.id, projectId: row.project_id, action: row.action,
        before: row.before_json ? parseJson(row.before_json, null) : null,
        after: parseJson(row.after_json), sourceMessageId: row.source_message_id, createdAt: row.created_at
      }));
  }

  function createBackupFile(destinationPath) {
    const resolvedPath = path.resolve(destinationPath);
    if (fs.existsSync(resolvedPath)) throw new Error('A backup already exists at the selected destination.');
    const escaped = resolvedPath.replaceAll("'", "''");
    try {
      db.exec('PRAGMA wal_checkpoint(FULL);');
      db.exec(`VACUUM INTO '${escaped}'`);
    } catch (error) {
      try { fs.rmSync(resolvedPath, { force: true }); } catch { /* preserve the original backup error */ }
      throw error;
    }
  }
}

export function validateBackupSnapshot(snapshotPath) {
  const sourcePath = path.resolve(snapshotPath);
  const validation = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const integrity = validation.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error('The selected SQLite backup failed its integrity check.');
    const tables = new Set(validation.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!['schema_migrations', 'projects', 'threads', 'messages'].every((name) => tables.has(name))) {
      throw new Error('The selected file is not a Story Studio SQLite backup.');
    }
    const version = validation.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? 0;
    if (version < 1 || version > MIGRATION_VERSION) throw new Error('The selected backup uses an unsupported Story Studio schema version.');
  } finally {
    validation.close();
  }
  return true;
}

export function readBackupSnapshot(snapshotPath) {
  const sourcePath = path.resolve(snapshotPath);
  validateBackupSnapshot(sourcePath);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-studio-backup-read-'));
  try {
    fs.copyFileSync(sourcePath, path.join(directory, 'story-studio.db'));
    const snapshot = openDatabase(directory);
    try {
      const integrity = snapshot.integrityCheck();
      if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error('The selected SQLite backup failed its integrity check.');
      return snapshot.getBackup();
    } finally {
      snapshot.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function recoverInterruptedWork(db) {
  const timestamp = now();
  db.prepare(`UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'`).run();
  db.prepare(`UPDATE memory_jobs SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'processing'`).run(timestamp);
}

