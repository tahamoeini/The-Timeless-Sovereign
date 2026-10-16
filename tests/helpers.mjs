import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database.mjs';

export async function temporaryDatabase(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'timeless-story-test-'));
  let database = openDatabase(directory);
  t.after(async () => {
    try { database?.close(); } catch { /* it may already be closed for a restart check */ }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get database() { return database; },
    reopen() {
      database?.close();
      database = openDatabase(directory);
      return database;
    }
  };
}

export function sampleFact(database, threadId, { subject = 'Mira', content = 'Mira entered the northern archive at dusk.', origin = 'user_established' } = {}) {
  const message = database.addUserMessage(threadId, content);
  const item = database.appendLedgerItem({
    projectId: message.projectId,
    branchId: message.branchId,
    type: 'event',
    subject,
    content,
    origin,
    confidence: 1,
    status: 'current',
    sourceMessageIds: [message.id]
  });
  return { message, item };
}
