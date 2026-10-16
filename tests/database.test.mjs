import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('project export/import remaps branch cutoffs and preserves all source records and audit history', async (t) => {
  const fixture = await temporaryDatabase(t);
  const sourceDb = fixture.database;
  const projectData = sourceDb.createProject({ name: 'A Thousand Winters', instructions: 'Keep the narrator close to the protagonist.' });
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
