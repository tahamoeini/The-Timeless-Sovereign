import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.mjs';
import { temporaryDatabase, sampleFact } from './helpers.mjs';

test('raw messages survive database reopen byte-for-byte and remain searchable', async (t) => {
  const fixture = await temporaryDatabase(t);
  const { project, thread } = fixture.database.createProject({ name: 'Archive Test' });
  const rawUser = '  “Keep the door open,” Mira whispered.\r\n\r\nA second paragraph. 🜂  ';
  const user = fixture.database.addUserMessage(thread.id, rawUser);
  const assistant = fixture.database.addAssistantMessage(thread.id, user.id);
  fixture.database.appendMessageDelta(assistant.id, 'The corridor answered.\n');
  fixture.database.appendMessageDelta(assistant.id, 'No one else had heard it.');
  fixture.database.completeAssistantMessage(assistant.id);
  const originalUser = fixture.database.getMessage(user.id);
  const originalAssistant = fixture.database.getMessage(assistant.id);

  const reopened = fixture.reopen();
  const transcript = reopened.getTranscript(thread.id);
  assert.deepEqual(transcript.map((message) => message.id), [user.id, assistant.id]);
  assert.equal(reopened.getMessage(user.id).content, originalUser.content);
  assert.equal(reopened.getMessage(user.id).content, rawUser);
  assert.equal(reopened.getMessage(assistant.id).content, originalAssistant.content);
  assert.equal(reopened.getMessage(assistant.id).status, 'complete');
  assert.equal(reopened.searchMessages(project.id, thread.branchId, 'corridor answered')[0].id, assistant.id);
  assert.deepEqual(reopened.integrityCheck(), ['ok']);
});

test('project search isolation and branch lineage prevent later main events leaking into an alternate timeline', async (t) => {
  const fixture = await temporaryDatabase(t);
  const db = fixture.database;
  const first = db.createProject({ name: 'Silver Coast' });
  const second = db.createProject({ name: 'Red Desert' });
  const { message, item } = sampleFact(db, first.thread.id, {
    subject: 'The sealed letter',
    content: 'Mira hid the silver letter beneath the chapel floorboards.'
  });
  const branch = db.createBranch(first.thread.id, 'The letter was burned');
  const branchMessage = db.addUserMessage(branch.thread.id, 'In this version, Mira destroys the letter before dawn.');
  db.retconLedgerItem(first.project.id, branch.branch.id, item.id, 'Mira destroyed the letter before dawn.', branchMessage.id);
  const laterMain = db.addUserMessage(first.thread.id, 'After the branch point, the silver letter was delivered to the harbor.');
  db.appendLedgerItem({
    projectId: first.project.id, branchId: first.branch.id, type: 'event', subject: 'Letter delivered',
    content: laterMain.content, origin: 'user_established', confidence: 1, status: 'current', sourceMessageIds: [laterMain.id]
  });

  assert.deepEqual(db.searchMessages(first.project.id, second.branch.id, 'silver letter'), []);
  assert.equal(db.searchMessages(first.project.id, first.branch.id, 'silver letter').some((row) => row.id === laterMain.id), true);
  assert.equal(db.searchMessages(first.project.id, branch.branch.id, 'silver letter').some((row) => row.id === laterMain.id), false);
  assert.equal(db.getEffectiveLedger(first.project.id, branch.branch.id).some((row) => row.id === item.id), false);
  assert.equal(db.getEffectiveLedger(first.project.id, branch.branch.id).some((row) => row.subject === 'Letter delivered'), false);
  assert.equal(db.getEffectiveLedger(first.project.id, first.branch.id).some((row) => row.id === item.id), true);
  assert.equal(db.getMessage(message.id).content, 'Mira hid the silver letter beneath the chapel floorboards.');
  assert.ok(db.listLedgerHistory(first.project.id, branch.branch.id).some((row) => row.action === 'retcon'));
  assert.equal(db.memoryStatus(first.project.id, branch.branch.id).state, 'pending');
});

test('empty and nested forks keep later parent messages outside transcript, ledger, and search', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Quiet fork' });
  const emptyFork = db.createBranch(created.thread.id, 'Silence');
  const later = db.addUserMessage(created.thread.id, 'A bell rings beyond the river.');
  db.appendLedgerItem({
    projectId: created.project.id, branchId: created.branch.id, type: 'event', subject: 'The bell',
    content: later.content, origin: 'user_established', confidence: 1, status: 'current', sourceMessageIds: [later.id]
  });
  const nested = db.createBranch(emptyFork.thread.id, 'Deeper silence');
  assert.deepEqual(db.getTranscript(emptyFork.thread.id), []);
  assert.deepEqual(db.getTranscript(nested.thread.id), []);
  assert.deepEqual(db.getEffectiveLedger(created.project.id, emptyFork.branch.id), []);
  assert.deepEqual(db.searchMessages(created.project.id, emptyFork.branch.id, 'bell river'), []);
  assert.deepEqual(db.searchMessages(created.project.id, nested.branch.id, 'bell river'), []);
});

test('canon corrections remain append-only and resolve within each fork boundary', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Append-only corrections' });
  const fact = sampleFact(db, created.thread.id, { subject: 'The gate', content: 'The gate is sealed.' });
  const beforeCorrection = db.createBranch(created.thread.id, 'Before correction');

  const correctionSource = db.addUserMessage(created.thread.id, 'The gate was open all along.');
  const firstCorrection = db.retconLedgerItem(created.project.id, created.branch.id, fact.item.id, 'The gate was open all along.', correctionSource.id).item;
  assert.ok(db.getEffectiveLedger(created.project.id, beforeCorrection.branch.id).some((item) => item.id === fact.item.id && item.status === 'current'));
  assert.ok(!db.getEffectiveLedger(created.project.id, beforeCorrection.branch.id).some((item) => item.id === firstCorrection.id));

  const afterFirstCorrection = db.createBranch(created.thread.id, 'After first correction');
  const secondSource = db.addUserMessage(created.thread.id, 'The gate opened at sunrise.');
  const secondCorrection = db.retconLedgerItem(created.project.id, created.branch.id, firstCorrection.id, 'The gate opened at sunrise.', secondSource.id).item;
  assert.ok(db.getEffectiveLedger(created.project.id, afterFirstCorrection.branch.id).some((item) => item.id === firstCorrection.id));
  assert.ok(!db.getEffectiveLedger(created.project.id, afterFirstCorrection.branch.id).some((item) => item.id === secondCorrection.id));
  assert.ok(db.getEffectiveLedger(created.project.id, created.branch.id).some((item) => item.id === secondCorrection.id));
  assert.ok(!db.listLedgerHistory(created.project.id, afterFirstCorrection.branch.id).some((entry) => entry.sourceMessageId === secondSource.id));
  assert.equal(db.getLedgerItem(created.project.id, created.branch.id, fact.item.id).status, 'current');
});

test('branch-scoped search applies visibility before its limit', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Search cutoffs' });
  const visible = db.addUserMessage(created.thread.id, 'The silver compass marks the hidden ford.');
  const branch = db.createBranch(created.thread.id, 'Before the later flood');
  for (let index = 0; index < 120; index += 1) {
    db.addUserMessage(created.thread.id, `Later event ${index} repeats the search phrase hidden ford.`);
  }
  const result = db.searchMessages(created.project.id, branch.branch.id, 'hidden ford', 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, visible.id);
  assert.equal(db.searchRelevantMessages(created.project.id, branch.branch.id, 'silver hidden ford', 3)[0].id, visible.id);
});

test('project export/import remaps branch cutoffs and preserves all source records and audit history', async (t) => {
  const fixture = await temporaryDatabase(t);
  const sourceDb = fixture.database;
  const projectData = sourceDb.createProject({ name: 'A Thousand Winters', instructions: 'Keep the narrator close to the protagonist.', memoryScope: 'thread' });
  const { message, item } = sampleFact(sourceDb, projectData.thread.id, { subject: 'Neris', content: 'Neris found a bronze key in the watchtower.' });
  const assistant = sourceDb.addAssistantMessage(projectData.thread.id, message.id);
  sourceDb.completeAssistantMessage(assistant.id, 'The old watchtower rang in the wind.');
  sourceDb.markMemoryJobError(sourceDb.listMemoryJobs(projectData.project.id, projectData.branch.id, true)[0].id, 'Temporary index failure.');
  const branchData = sourceDb.createBranch(projectData.thread.id, 'The key is counterfeit');
  const branchTurn = sourceDb.addUserMessage(branchData.thread.id, 'The key crumbles into ash.');
  sourceDb.retconLedgerItem(projectData.project.id, branchData.branch.id, item.id, 'Neris found a counterfeit bronze key that crumbled into ash.', branchTurn.id);
  const postFork = sourceDb.addUserMessage(projectData.thread.id, 'Neris used the real key to open the observatory.');
  sourceDb.appendLedgerItem({
    projectId: projectData.project.id, branchId: projectData.branch.id, type: 'event', subject: 'The observatory',
    content: postFork.content, origin: 'user_established', confidence: 1, status: 'current', sourceMessageIds: [postFork.id]
  });
  sourceDb.importArchive(projectData.project.id, 'original.md', 'complete original archive', [{ user: 'A raw archive question', assistant: 'An answer from the archive.' }]);
  const exportDocument = sourceDb.getProjectExport(projectData.project.id);

  const imported = sourceDb.importProject(exportDocument);
  assert.equal(sourceDb.getProject(imported.id).memoryScope, 'thread');
  const importedBranches = sourceDb.listBranches(imported.id);
  const importedAlt = importedBranches.find((branch) => branch.name === branchData.branch.name);
  const importedThread = sourceDb.listThreads(imported.id).find((thread) => thread.branchId === importedAlt.id);
  const importedArchiveThread = sourceDb.listThreads(imported.id).find((thread) => thread.title.startsWith('Imported · original.md'));
  const inheritedSource = sourceDb.searchMessages(imported.id, importedAlt.id, 'watchtower', 20);
  assert.ok(inheritedSource.some((row) => row.content === 'Neris found a bronze key in the watchtower.'));
  assert.equal(inheritedSource.some((row) => row.content.includes('observatory')), false);
  assert.equal(sourceDb.getEffectiveLedger(imported.id, importedAlt.id).some((row) => row.subject === 'The observatory'), false);
  assert.equal(sourceDb.getEffectiveLedger(imported.id, importedAlt.id).some((row) => row.content.includes('crumbled into ash')), true);
  assert.ok(importedArchiveThread);
  assert.ok(sourceDb.getTranscript(importedArchiveThread.id).some((row) => row.content === 'A raw archive question'));
  assert.equal(sourceDb.listArchiveImports(imported.id)[0].bytes, 'complete original archive'.length);
  assert.ok(sourceDb.listLedgerHistory(imported.id, importedAlt.id).some((row) => row.action === 'retcon'));
  assert.equal(sourceDb.listMemoryJobs(imported.id).some((job) => job.status === 'pending'), true);

  const backupPath = path.join(fixture.directory, 'snapshot.sqlite');
  sourceDb.createBackupFile(backupPath);
  assert.equal(fs.statSync(backupPath).size > 0, true);
  const backupDocument = sourceDb.getBackup();
  const restoredFixture = await temporaryDatabase(t);
  const restoredDb = restoredFixture.database;
  restoredDb.restoreBackup(backupDocument);
  assert.deepEqual(restoredDb.integrityCheck(), ['ok']);
  assert.ok(restoredDb.getTranscript(importedThread.id).some((row) => row.content === 'Neris found a bronze key in the watchtower.'));
  assert.ok(restoredDb.listLedgerHistory(imported.id, importedAlt.id).some((row) => row.action === 'retcon'));
});

test('database migration adds the project memory scope to an existing version-one database', async (t) => {
  const fixture = await temporaryDatabase(t);
  fixture.database.close();
  const databasePath = path.join(fixture.directory, 'story-studio.db');
  fs.rmSync(databasePath, { force: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES(1, '2026-10-01T00:00:00.000Z');
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
      style TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO projects(id, name, instructions, style, created_at, updated_at)
      VALUES('legacy-project', 'Legacy', '', '', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  `);
  legacy.close();

  const migrated = openDatabase(fixture.directory);
  try {
    assert.equal(migrated.getProject('legacy-project').memoryScope, 'project');
    assert.equal(migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
    assert.deepEqual(migrated.integrityCheck(), ['ok']);
  } finally {
    migrated.close();
  }
});

test('fresh databases start at the current schema and remain current on reopen', async (t) => {
  const fixture = await temporaryDatabase(t);
  const db = fixture.database;
  const created = db.createProject({ name: 'Current schema' });
  const firstVersion = db.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
  assert.equal(firstVersion, 5);
  assert.deepEqual(db.getDraft(created.thread.id), { content: '', updatedAt: null });
  const reopened = fixture.reopen();
  assert.equal(reopened.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, firstVersion);
  assert.equal(reopened.getProject(created.project.id).name, 'Current schema');
  assert.deepEqual(reopened.integrityCheck(), ['ok']);
});

test('version-four generation records gain diagnostics without losing retry history', async (t) => {
  const fixture = await temporaryDatabase(t);
  fixture.database.close();
  const databasePath = path.join(fixture.directory, 'story-studio.db');
  fs.rmSync(databasePath, { force: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES(4, '2026-10-01T00:00:00.000Z');
    CREATE TABLE generation_attempts (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL, assistant_message_id TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO generation_attempts(id, request_id, thread_id, user_message_id, status, created_at, updated_at)
      VALUES('attempt-1', 'request-1', 'thread-1', 'message-1', 'failed', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  `);
  legacy.close();

  const migrated = openDatabase(fixture.directory);
  try {
    assert.equal(migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
    const columns = migrated.db.prepare('PRAGMA table_info(generation_attempts)').all().map((column) => column.name);
    assert.ok(columns.includes('diagnostics_json'));
    assert.equal(migrated.db.prepare('SELECT diagnostics_json FROM generation_attempts WHERE id = ?').get('attempt-1').diagnostics_json, '{}');
  } finally {
    migrated.close();
  }
});

test('version-two migration maps only unambiguous archive threads and keeps archive contents', async (t) => {
  const fixture = await temporaryDatabase(t);
  fixture.database.close();
  const databasePath = path.join(fixture.directory, 'story-studio.db');
  fs.rmSync(databasePath, { force: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES(2, '2026-10-01T00:00:00.000Z');
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
      style TEXT NOT NULL DEFAULT '', memory_scope TEXT NOT NULL DEFAULT 'project',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO projects(id, name, instructions, style, memory_scope, created_at, updated_at)
      VALUES('legacy-project', 'Legacy', '', '', 'project', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    CREATE TABLE branches (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, created_at TEXT);
    INSERT INTO branches VALUES('legacy-branch', 'legacy-project', 'Main', '2026-10-01T00:00:00.000Z');
    CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT, branch_id TEXT, title TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO threads VALUES('unique-thread', 'legacy-project', 'legacy-branch', 'Imported · unique.md', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO threads VALUES('ambiguous-a', 'legacy-project', 'legacy-branch', 'Imported · ambiguous.md', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO threads VALUES('ambiguous-b', 'legacy-project', 'legacy-branch', 'Imported · ambiguous.md', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    CREATE TABLE archive_imports (
      id TEXT PRIMARY KEY, project_id TEXT, file_name TEXT, source_sha256 TEXT, raw_content TEXT, created_at TEXT
    );
    INSERT INTO archive_imports VALUES('archive-1', 'legacy-project', 'unique.md', 'hash-1', 'preserve unique', '2026-10-01T00:00:00.000Z');
    INSERT INTO archive_imports VALUES('archive-2', 'legacy-project', 'ambiguous.md', 'hash-2', 'preserve ambiguous', '2026-10-01T00:00:00.000Z');
  `);
  legacy.close();

  const migrated = openDatabase(fixture.directory);
  try {
    const rows = migrated.db.prepare('SELECT id, thread_id, raw_content FROM archive_imports ORDER BY id').all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { id: 'archive-1', thread_id: 'unique-thread', raw_content: 'preserve unique' },
      { id: 'archive-2', thread_id: null, raw_content: 'preserve ambiguous' }
    ]);
    assert.equal(migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
    assert.deepEqual(migrated.integrityCheck(), ['ok']);
  } finally { migrated.close(); }
});

test('already-current databases preserve archive links and do not rerun migrations', async (t) => {
  const fixture = await temporaryDatabase(t);
  const created = fixture.database.createProject({ name: 'Preserve imports' });
  const imported = fixture.database.importArchive(created.project.id, 'kept.md', 'raw archive', [{ user: 'Question', assistant: 'Answer' }]);
  const archive = fixture.database.db.prepare('SELECT id, thread_id, raw_content FROM archive_imports').get();
  fixture.reopen();
  assert.equal(fixture.database.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
  assert.deepEqual(fixture.database.db.prepare('SELECT id, thread_id, raw_content FROM archive_imports').get(), archive);
  assert.equal(fixture.database.listArchiveImports(created.project.id).length, 1);
  assert.equal(imported.importedTurns, 1);
});

test('backup restore preserves drafts and retry history while normalizing interrupted work', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Backup recovery' });
  const user = db.addUserMessage(created.thread.id, 'The unsent draft should survive restore.');
  const attempt = db.createGenerationAttempt({ requestId: 'retry-before-restore', threadId: created.thread.id, userMessageId: user.id }).attempt;
  const diagnostics = {
    model: 'gpt-test', reasoningEffort: 'high', contextSha256: 'a'.repeat(64), contextChars: 1234,
    sourceMessageIds: [user.id], recentMessageIds: [], ledgerItemIds: [], voiceExampleCount: 1,
    projectGuidanceSha256: 'b'.repeat(64)
  };
  db.updateGenerationAttempt(attempt.id, { diagnostics });
  const assistant = db.addAssistantMessage(created.thread.id, user.id, attempt.id);
  db.appendMessageDelta(assistant.id, 'A partial reply');
  db.markMemoryJobProcessing(db.getMemoryJobForMessage(user.id).id);
  db.saveDraft(created.thread.id, 'The next scene starts here.');

  const backup = db.getBackup();
  assert.equal(backup.drafts[0].content, 'The next scene starts here.');
  assert.equal(backup.generationAttempts[0].status, 'streaming');
  assert.deepEqual(backup.generationAttempts[0].diagnostics, diagnostics);
  db.createProject({ name: 'Changes after snapshot' });
  db.restoreBackup(backup);

  assert.deepEqual(db.listProjects().map((project) => project.name), ['Backup recovery']);
  assert.equal(db.getDraft(created.thread.id).content, 'The next scene starts here.');
  assert.equal(db.getMessage(assistant.id).status, 'interrupted');
  assert.equal(db.getMessage(assistant.id).content, 'A partial reply');
  assert.equal(db.getMemoryJobForMessage(user.id).status, 'pending');
  assert.equal(db.getGenerationAttempt(attempt.requestId).status, 'interrupted');
  assert.deepEqual(db.getGenerationAttempt(attempt.requestId).diagnostics, diagnostics);
  assert.deepEqual(db.integrityCheck(), ['ok']);
});

test('invalid backup restore rolls back project deletion and imports', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Must remain after rollback' });
  const invalid = db.getBackup();
  invalid.settings.push({ key: 'app.theme', value: { invalid: true } });

  assert.throws(() => db.restoreBackup(invalid), /invalid app setting/i);
  assert.deepEqual(db.listProjects().map((project) => project.name), ['Must remain after rollback']);
  assert.equal(db.getProject(created.project.id).name, 'Must remain after rollback');
  assert.deepEqual(db.integrityCheck(), ['ok']);
});

test('startup recovery marks partial generation interrupted and memory processing pending', async (t) => {
  const fixture = await temporaryDatabase(t);
  const created = fixture.database.createProject({ name: 'Recovery' });
  const user = fixture.database.addUserMessage(created.thread.id, 'Wait for the answer.');
  const assistant = fixture.database.addAssistantMessage(created.thread.id, user.id);
  fixture.database.appendMessageDelta(assistant.id, 'The first streamed words.');
  const job = fixture.database.listMemoryJobs(created.project.id, created.branch.id, true)[0];
  fixture.database.markMemoryJobProcessing(job.id);
  const recovered = fixture.reopen();
  assert.equal(recovered.getMessage(assistant.id).status, 'interrupted');
  assert.equal(recovered.listMemoryJobs(created.project.id, created.branch.id, true)[0].status, 'pending');
  assert.equal(recovered.getMessage(assistant.id).content, 'The first streamed words.');
});
