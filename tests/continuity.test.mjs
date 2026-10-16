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
  assert.match(bundle.text, /Do not claim that a character knows or witnessed something unless a source-linked record establishes it/);

  const otherThread = db.createThread(second.project.id, second.branch.id, 'Moon landing');
  const otherCurrent = db.addUserMessage(otherThread.id, current.content);
  const otherBundle = buildContextBundle(db, otherThread.id, otherCurrent);
  assert.doesNotMatch(otherBundle.text, /The hidden atlas|star atlas beneath the chapel floorboards/);
  assert.equal(otherBundle.sourceMessageIds.includes(old.message.id), false);
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
        details: { limit: 'No exception was shown in the source messages.' }, origin: 'user_established', confidence: 0.93,
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
        type: 'event', subject: 'Invented source', content: 'The kite landed safely.', details: {},
        origin: 'user_established', confidence: 1, status: 'current', sourceMessageIds: ['not-a-saved-message']
      }] }) };
    }
  };
  const indexer = new MemoryIndexer({ database: db, codex });
  assert.equal((await indexer.processMessage(user.id)).state, 'error');
  assert.equal(db.getEffectiveLedger(created.project.id, created.branch.id).length, 0);
  assert.match(db.memoryStatus(created.project.id, created.branch.id).error, /outside the submitted source records/);
});
