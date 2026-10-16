import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatHistory, parseChatHistoryJson, parseChatHistoryMarkdown } from '../src/archive.mjs';
import { temporaryDatabase } from './helpers.mjs';

test('Markdown chat archives are parsed into exact prompt/response turns while the original file is retained', async (t) => {
  const raw = `# My story\n\n## Prompt:\n10/15/2026, 9:14 AM\n\nPlease remember the brass key.\nIt has a crack shaped like a crescent.\n\n## Response:\n10/15/2026, 9:15 AM\n\nMara turned the key in the lock.\n\n## Prompt:\n10/15/2026, 9:18 AM\n\nContinue in Persian: سلام به خانه‌ی قدیمی.\n\n## Response:\n10/15/2026, 9:19 AM\n\nپاسخی آرام از تالار آمد.\n`;
  const turns = parseChatHistoryMarkdown(raw);
  assert.deepEqual(turns, [
    { user: 'Please remember the brass key.\nIt has a crack shaped like a crescent.', assistant: 'Mara turned the key in the lock.' },
    { user: 'Continue in Persian: سلام به خانه‌ی قدیمی.', assistant: 'پاسخی آرام از تالار آمد.' }
  ]);
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Archive import' });
  const imported = db.importArchive(created.project.id, 'history.md', raw, turns);
  const transcript = db.getTranscript(imported.thread.id);
  assert.equal(transcript.length, 4);
  assert.equal(transcript[0].content, turns[0].user);
  assert.equal(transcript[3].content, turns[1].assistant);
  assert.equal(db.listArchiveImports(created.project.id)[0].sha256.length, 64);
  assert.equal(db.getBackup().projects[0].archives[0].rawContent, raw);
  assert.equal(db.memoryStatus(created.project.id, created.branch.id).state, 'pending');
});

test('ChatGPT JSON archives preserve every message, timestamp, ordering, and original source file', async (t) => {
  const document = {
    metadata: { title: 'The Drowned Observatory' },
    messages: [
      { role: 'Prompt', say: '  Keep this exact prompt.\r\nSecond line.  ', time: '2026-10-16T13:00:00.000Z' },
      { role: 'Response', say: 'An answer with a pause…', time: '2026-10-16T13:00:11.000Z', model: 'fictional-model' },
      { role: 'Prompt', say: 'Continue: سلام.', time: '2026-10-16T13:01:00.000Z' },
      { role: 'Response', say: 'ادامه‌ی داستان.', time: '2026-10-16T13:01:12.000Z', model: 'fictional-model' }
    ]
  };
  const raw = JSON.stringify(document, null, 2);
  const records = parseChatHistoryJson(document);
  assert.deepEqual(parseChatHistory(raw), records);
  assert.equal(records[0].content, document.messages[0].say);
  assert.equal(records[0].createdAt, document.messages[0].time);

  const { database: db } = await temporaryDatabase(t);
  const imported = db.importArchiveAsProject('The Drowned Observatory', 'chat-export.json', raw, records);
  const transcript = db.getTranscript(imported.thread.id);
  assert.equal(transcript.length, document.messages.length);
  assert.deepEqual(transcript.map(({ role, content, createdAt }) => ({ role, content, createdAt })), records.map((record) => ({
    role: record.role, content: record.content, createdAt: record.createdAt
  })));
  assert.equal(transcript[1].sourceMessageId, transcript[0].id);
  assert.equal(transcript[3].sourceMessageId, transcript[2].id);
  assert.equal(imported.importedTurns, 2);
  assert.equal(imported.importedMessages, 4);
  assert.equal(db.getBackup().projects[0].archives[0].rawContent, raw);
  assert.equal(db.listMemoryJobs(imported.project.id, imported.branch.id).length, 2);
  assert.equal(db.memoryStatus(imported.project.id, imported.branch.id).state, 'pending');
});
