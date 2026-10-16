import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextBundle } from '../src/context.mjs';
import { MemoryIndexer } from '../src/memory-indexer.mjs';
import { temporaryDatabase, sampleFact } from './helpers.mjs';

test('a fresh chat retrieves a specific old event with source IDs while another project stays isolated', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const first = db.createProject({ name: 'The Verdant Archive', instructions: 'Write close third-person fantasy.' });
  const second = db.createProject({ name: 'The Empty Moon', instructions: 'Science-fiction, no magic.' });
  const old = sampleFact(db, first.thread.id, {
    subject: 'The hidden atlas', content: 'Mira hid the star atlas beneath the chapel floorboards before the fire.'
  });
  const continuation = db.createThread(first.project.id, first.branch.id, 'A later conversation');
  const current = db.addUserMessage(continuation.id, 'What did Mira hide beneath the chapel floorboards?');
  const bundle = buildContextBundle(db, continuation.id, current);
  assert.match(bundle.text, /The hidden atlas/);
  assert.match(bundle.text, /Mira hid the star atlas beneath the chapel floorboards/);
  assert.match(bundle.text, new RegExp(old.message.id));
  assert.ok(bundle.sourceMessageIds.includes(old.message.id));
  assert.match(bundle.text, /Use this bundle as continuity evidence, not as an exhaustive transcript/);

  const otherThread = db.createThread(second.project.id, second.branch.id, 'Moon landing');
  const otherCurrent = db.addUserMessage(otherThread.id, current.content);
  const otherBundle = buildContextBundle(db, otherThread.id, otherCurrent);
  assert.doesNotMatch(otherBundle.text, /The hidden atlas|star atlas beneath the chapel floorboards/);
  assert.equal(otherBundle.sourceMessageIds.includes(old.message.id), false);
});

test('recent context keeps complete prior story messages and excludes a streaming reply', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Complete recent context' });
  for (let turn = 1; turn <= 6; turn += 1) {
    const user = db.addUserMessage(created.thread.id, `User marker ${turn}.`);
    const assistant = db.addAssistantMessage(created.thread.id, user.id);
    db.completeAssistantMessage(assistant.id, `Assistant marker ${turn}.`);
  }

  const current = db.addUserMessage(created.thread.id, 'Continue the scene.');
  const streaming = db.addAssistantMessage(created.thread.id, current.id);
  db.appendMessageDelta(streaming.id, 'Unfinished assistant marker.');
  const bundle = buildContextBundle(db, created.thread.id, current);
  const recentTurns = bundle.text.split('## Recent raw turns in this thread\n')[1].split('\n## Out-of-story notes')[0];

  assert.doesNotMatch(recentTurns, /User marker 1\.|Assistant marker 1\./);
  assert.match(recentTurns, /User marker 2\./);
  assert.match(recentTurns, /Assistant marker 6\./);
  assert.doesNotMatch(bundle.text, /Unfinished assistant marker/);
});

test('an empty branch context excludes later parent facts from canon, excerpts, and recent turns', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Empty branch context' });
  const alternate = db.createBranch(created.thread.id, 'No earlier scene');
  const laterParentMessage = db.addUserMessage(created.thread.id, 'Mira hid the silver bell in the cypress tree after the flood.');
  db.appendLedgerItem({
    projectId: created.project.id, branchId: created.branch.id, type: 'event', subject: 'The hidden bell',
    content: laterParentMessage.content, origin: 'user_established', confidence: 1, status: 'current', sourceMessageIds: [laterParentMessage.id]
  });
  const question = db.addUserMessage(alternate.thread.id, 'What happened to the silver bell?');
  const bundle = buildContextBundle(db, alternate.thread.id, question);

  assert.doesNotMatch(bundle.text, /cypress tree after the flood/);
  assert.equal(bundle.sourceMessageIds.includes(laterParentMessage.id), false);
  assert.equal(bundle.ledgerItemIds.length, 0);
  assert.deepEqual(db.getTranscript(alternate.thread.id).map((message) => message.id), [question.id]);
});

test('conversation-local memory stays within one chat while the default shares canon across project chats', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const project = db.createProject({ name: 'Memory scope' });
  const shared = sampleFact(db, project.thread.id, {
    subject: 'The first key', content: 'Mira hid the silver key inside the chapel bell.'
  });
  const continuation = db.createThread(project.project.id, project.branch.id, 'A later conversation');
  const sharedQuestion = db.addUserMessage(continuation.id, 'Where did Mira hide the silver key?');
  const sharedBundle = buildContextBundle(db, continuation.id, sharedQuestion);
  assert.match(sharedBundle.text, /Mira hid the silver key inside the chapel bell/);
  assert.equal(sharedBundle.memoryScope, 'project');

  db.updateProject(project.project.id, { memoryScope: 'thread' });
  const local = sampleFact(db, continuation.id, {
    subject: 'The local clue', content: 'Mira marked the west window with a red thread.'
  });
  const localQuestion = db.addUserMessage(continuation.id, 'What did Mira mark with red thread?');
  const localBundle = buildContextBundle(db, continuation.id, localQuestion);
  assert.match(localBundle.text, /Mira marked the west window with a red thread/);
  assert.match(localBundle.text, new RegExp(local.message.id));
  assert.doesNotMatch(localBundle.text, /silver key inside the chapel bell/);
  assert.equal(localBundle.memoryScope, 'thread');

  const alternate = db.createBranch(continuation.id, 'A separate local chat');
  const alternateQuestion = db.addUserMessage(alternate.thread.id, 'What happened in this conversation?');
  const alternateBundle = buildContextBundle(db, alternate.thread.id, alternateQuestion);
  assert.doesNotMatch(alternateBundle.text, /west window with a red thread/);
  assert.doesNotMatch(alternateBundle.text, new RegExp(local.message.id));
});

test('memory indexing marks failures retryable, validates citations, and does not duplicate ledger history', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Memory queue' });
  const user = db.addUserMessage(created.thread.id, 'The brass compass pointed due west, even underground.');
  const assistant = db.addAssistantMessage(created.thread.id, user.id);
  db.completeAssistantMessage(assistant.id, 'It pointed west through the stone beneath the old city.');

  const codex = {
    connected: true,
    getConnectionStatus() { return { state: this.connected ? 'connected' : 'disconnected' }; },
    async startThread(options) { assert.equal(options.ephemeral, true); this.requestedThread = options; return 'ephemeral-indexer'; },
    async streamTurn({ text, outputSchema }) {
      assert.match(text, new RegExp(user.id));
      assert.match(text, new RegExp(assistant.id));
      assert.equal(outputSchema.type, 'object');
      if (this.fail) throw new Error('Temporary app-server error.');
      return { text: JSON.stringify({ entries: [{
        type: 'rule', subject: 'Brass compass', content: 'The compass points due west even underground.',
        details: [{ key: 'limit', value: 'No exception was shown in the source messages.' }], origin: 'user_established', confidence: 0.93,
        status: 'current', sourceMessageIds: [user.id]
      }] }) };
    }
  };
  const indexer = new MemoryIndexer({ database: db, codex });
  codex.connected = false;
  assert.equal((await indexer.processMessage(user.id)).state, 'pending');
  assert.equal(db.getMemoryJobForMessage(user.id).status, 'pending');
  codex.connected = true;
  codex.fail = true;
  assert.equal((await indexer.processMessage(user.id)).state, 'error');
  assert.equal(db.memoryStatus(created.project.id, created.branch.id).state, 'error');
  db.retryMemoryJobs(created.project.id);
  assert.equal(db.getMemoryJobForMessage(user.id).status, 'pending');

  codex.fail = false;
  assert.deepEqual(await indexer.processMessage(user.id), { state: 'indexed', entries: 1 });
  assert.equal(db.getMemoryJobForMessage(user.id).status, 'indexed');
  assert.equal(db.getEffectiveLedger(created.project.id, created.branch.id).filter((item) => item.subject === 'Brass compass').length, 1);
  const historyCount = db.listLedgerHistory(created.project.id, created.branch.id).filter((entry) => entry.action === 'created').length;
  assert.deepEqual(await indexer.processMessage(user.id), { state: 'indexed' });
  assert.equal(db.listLedgerHistory(created.project.id, created.branch.id).filter((entry) => entry.action === 'created').length, historyCount);
  assert.deepEqual(db.integrityCheck(), ['ok']);
});

test('an indexing response cannot cite sources outside the submitted messages', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Citation guard' });
  const user = db.addUserMessage(created.thread.id, 'A red kite crossed the eastern ridge.');
  const codex = {
    getConnectionStatus: () => ({ state: 'connected' }),
    async startThread() { return 'temporary'; },
    async streamTurn() {
      return { text: JSON.stringify({ entries: [{
        type: 'event', subject: 'Invented source', content: 'The kite landed safely.', details: [],
        origin: 'user_established', confidence: 1, status: 'current', sourceMessageIds: ['not-a-saved-message']
      }] }) };
    }
  };
  const indexer = new MemoryIndexer({ database: db, codex });
  assert.equal((await indexer.processMessage(user.id)).state, 'error');
  assert.equal(db.getEffectiveLedger(created.project.id, created.branch.id).length, 0);
  assert.match(db.memoryStatus(created.project.id, created.branch.id).error, /outside the submitted source records/);
});

test('ledger changes and an indexed job commit atomically', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Atomic index result' });
  const message = db.addUserMessage(created.thread.id, 'The lantern keeps burning under rain.');
  const job = db.getMemoryJobForMessage(message.id);
  db.markMemoryJobProcessing(job.id);
  const valid = {
    type: 'event', subject: 'The lantern', content: 'The lantern burns under rain.', details: [],
    origin: 'user_established', confidence: 1, status: 'current', sourceMessageIds: [message.id]
  };
  const invalid = { ...valid, subject: 'Invalid source', sourceMessageIds: ['outside-this-project'] };
  assert.throws(() => db.commitMemoryJob(job.id, [valid, invalid]), /source message was not found/);
  assert.equal(db.getEffectiveLedger(created.project.id, created.branch.id).length, 0);
  assert.equal(db.getMemoryJobForMessage(message.id).status, 'processing');
  db.commitMemoryJob(job.id, [valid]);
  assert.equal(db.getEffectiveLedger(created.project.id, created.branch.id).length, 1);
  assert.equal(db.getMemoryJobForMessage(message.id).status, 'indexed');
});
