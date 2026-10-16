import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AuthError } from '../src/auth.mjs';
import { createStoryStudioServer } from '../src/server.mjs';

function decodeSse(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => ({
    event: /^event:\s*(.+)$/m.exec(block)?.[1],
    data: JSON.parse(/^data:\s*(.+)$/m.exec(block)?.[1] ?? '{}')
  }));
}

async function invoke(app, method, url, body, { origin, csrfToken, host } = {}) {
  const address = app.server.address();
  const requestBody = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(requestBody);
  req.method = method;
  req.url = url;
  req.headers = {
    host: host ?? `127.0.0.1:${address.port}`,
    ...(origin ? { origin } : {}),
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' })
  };
  req.socket = { remoteAddress: '127.0.0.1' };
  const response = new EventEmitter();
  response.headers = {};
  response.chunks = [];
  response.statusCode = 200;
  response.destroyed = false;
  response.writableEnded = false;
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = value; };
  response.writeHead = (status, headers = {}) => {
    response.statusCode = status;
    for (const [name, value] of Object.entries(headers)) response.headers[name.toLowerCase()] = value;
    return response;
  };
  response.flushHeaders = () => {};
  response.write = (value) => { response.chunks.push(Buffer.from(value)); return true; };
  response.end = (value) => {
    if (value !== undefined) response.chunks.push(Buffer.from(value));
    response.writableEnded = true;
    return response;
  };
  const listener = app.server.listeners('request')[0];
  await listener(req, response);
  return { status: response.statusCode, headers: response.headers, body: Buffer.concat(response.chunks).toString('utf8') };
}

test('local app persists a disconnected user turn, rejects cross-origin writes, and keeps commands out of story generation', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-http-test-'));
  const calls = { accessToken: 0, starts: 0 };
  const auth = {
    async status() { return { state: 'not_signed_in', message: 'Not connected. Sign in with ChatGPT to enable story generation.' }; },
    async accessToken() { calls.accessToken += 1; throw new AuthError('Sign in with ChatGPT to connect the story backend.', 'not_signed_in'); },
    beginSignIn() { return { authorizationUrl: 'https://auth.openai.com/fake' }; },
    openBrowser() { return false; },
    async signOut() { return { revoked: false }; }
  };
  const codex = {
    getConnectionStatus() { return { state: 'disconnected', message: 'No local app-server connection.' }; },
    async stop() {},
    async start() { calls.starts += 1; throw new Error('No test provider should start.'); }
  };
  const app = createStoryStudioServer({ dataDirectory, port: 0, auth, codex });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });
  const initial = await invoke(app, 'GET', '/api/bootstrap');
  const bootstrap = JSON.parse(initial.body);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers['content-security-policy'].includes("default-src 'self'"), true);
  assert.equal(bootstrap.authorization.state, 'not_signed_in');
  assert.equal(bootstrap.database.integrity[0], 'ok');

  const wrongOrigin = await invoke(app, 'POST', '/api/projects', { name: 'Blocked project' }, { origin: 'http://evil.invalid', csrfToken: bootstrap.csrfToken });
  assert.equal(wrongOrigin.status, 403);
  const createdResponse = await invoke(app, 'POST', '/api/projects', { name: 'Saved locally', instructions: 'A story with an exact record.' }, { origin: base, csrfToken: bootstrap.csrfToken });
  const created = JSON.parse(createdResponse.body);
  assert.equal(createdResponse.status, 201);

  const rawMessage = 'I open the iron gate and hear the old bell answer from under the river.';
  const storyResponse = await invoke(app, 'POST', `/api/threads/${created.thread.id}/send`, { content: rawMessage }, { origin: base, csrfToken: bootstrap.csrfToken });
  const storyEvents = decodeSse(storyResponse.body);
  assert.equal(storyResponse.status, 200);
  assert.equal(storyEvents[0].event, 'saved');
  assert.equal(storyEvents[0].data.message.content, rawMessage);
  assert.equal(storyEvents.at(-1).event, 'failure');
  assert.match(storyEvents.at(-1).data.message, /Sign in with ChatGPT/);
  const threadResponse = await invoke(app, 'GET', `/api/threads/${created.thread.id}`);
  const thread = JSON.parse(threadResponse.body);
  assert.equal(thread.transcript.find((message) => message.role === 'user').content, rawMessage);
  assert.equal(thread.memory.state, 'pending');
  assert.equal(thread.transcript.filter((message) => message.role === 'assistant').length, 1);
  assert.equal(thread.transcript.find((message) => message.role === 'assistant').status, 'failed');
  assert.equal(calls.starts, 0);
  assert.equal(calls.accessToken, 1);

  const retryRequest = { userMessageId: storyEvents[0].data.message.id, clientRequestId: 'retry-once-001' };
  const retry = await invoke(app, 'POST', `/api/threads/${created.thread.id}/retry`, retryRequest, { origin: base, csrfToken: bootstrap.csrfToken });
  const retryEvents = decodeSse(retry.body);
  assert.equal(retry.status, 200);
  assert.equal(retryEvents[0].event, 'retry-started');
  assert.equal(retryEvents.at(-1).event, 'failure');
  const afterRetry = app.database.getTranscript(created.thread.id).filter((message) => message.role === 'assistant');
  assert.equal(afterRetry.length, 2);
  assert.notEqual(afterRetry[0].id, afterRetry[1].id);
  assert.equal(afterRetry[0].status, 'failed');
  const retryAgain = await invoke(app, 'POST', `/api/threads/${created.thread.id}/retry`, retryRequest, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(decodeSse(retryAgain.body).at(-1).event, 'retry-existing');
  const otherUser = app.database.addUserMessage(created.thread.id, 'Another failed turn.');
  const reusedKey = await invoke(app, 'POST', `/api/threads/${created.thread.id}/retry`, {
    userMessageId: otherUser.id, clientRequestId: 'retry-once-001'
  }, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(reusedKey.status, 409);

  const command = await invoke(app, 'POST', `/api/threads/${created.thread.id}/send`, { content: '/status' }, { origin: base, csrfToken: bootstrap.csrfToken });
  const commandEvents = decodeSse(command.body);
  assert.equal(commandEvents.some((entry) => entry.event === 'failure'), false);
  assert.equal(calls.accessToken, 2);
  assert.equal(commandEvents.at(-1).event, 'command-complete');
  assert.ok(commandEvents.at(-1).data.activity);

  const pause = await invoke(app, 'POST', `/api/threads/${created.thread.id}/send`, { content: '/pause' }, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(decodeSse(pause.body).at(-1).event, 'command-complete');
  const pausedTurn = await invoke(app, 'POST', `/api/threads/${created.thread.id}/send`, { content: 'This typed turn must remain saved while paused.' }, { origin: base, csrfToken: bootstrap.csrfToken });
  const pausedEvents = decodeSse(pausedTurn.body);
  assert.equal(pausedEvents[0].event, 'saved');
  assert.equal(pausedEvents.at(-1).data.paused, true);
  assert.equal(calls.accessToken, 2);

  const exported = await invoke(app, 'GET', '/api/backup');
  const backup = JSON.parse(exported.body);
  assert.equal(backup.format, 'timeless-sovereign-backup');
  const tamper = await invoke(app, 'DELETE', `/api/projects/${created.project.id}`, { confirmName: 'Saved locally', confirmation: 'wrong' }, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(tamper.status, 400);
  const stillThere = await invoke(app, 'GET', `/api/projects/${created.project.id}`);
  assert.equal(JSON.parse(stillThere.body).project.name, 'Saved locally');
});

test('appearance preferences persist in SQLite across a server restart and update status is local API data', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-settings-test-'));
  const updateChecker = async ({ currentVersion }) => ({
    state: 'update_available', currentVersion, latestVersion: '1.3.0', updateAvailable: true,
    downloadUrl: 'https://github.com/tahamoeini/The-Timeless-Sovereign/releases/download/v1.3.0/The-Timeless-Sovereign-Setup-1.3.0.exe'
  });
  let app = createStoryStudioServer({ dataDirectory, port: 0, updateChecker });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const initial = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  assert.equal(initial.appSettings.theme, 'system');
  assert.equal(initial.appVersion, '1.5.0');
  const firstBackups = JSON.parse((await invoke(app, 'GET', '/api/backups')).body).backups.filter((backup) => backup.kind === 'automatic');
  assert.equal(firstBackups.length, 1);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const saved = await invoke(app, 'PATCH', '/api/settings/app', { theme: 'dark' }, { origin: base, csrfToken: initial.csrfToken });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.body), { theme: 'dark' });
  const invalid = await invoke(app, 'PATCH', '/api/settings/app', { theme: 'sepia' }, { origin: base, csrfToken: initial.csrfToken });
  assert.equal(invalid.status, 400);

  await app.close();
  app = createStoryStudioServer({ dataDirectory, port: 0, updateChecker });
  await app.listen();
  const restored = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  assert.equal(restored.appSettings.theme, 'dark');
  const restartedBackups = JSON.parse((await invoke(app, 'GET', '/api/backups')).body).backups.filter((backup) => backup.kind === 'automatic');
  assert.equal(restartedBackups.length, 1);
  assert.equal(restartedBackups[0].createdAt, firstBackups[0].createdAt);
  const update = await invoke(app, 'GET', '/api/updates');
  assert.equal(update.status, 200);
  assert.equal(JSON.parse(update.body).latestVersion, '1.3.0');
});

test('thread snapshot polling returns only new messages instead of retransmitting the full transcript', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-snapshot-test-'));
  const app = createStoryStudioServer({ dataDirectory, port: 0 });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const created = app.database.createProject({ name: 'Large transcript' });
  const archived = app.database.addUserMessage(created.thread.id, 'A'.repeat(180_000));
  const full = await invoke(app, 'GET', `/api/threads/${created.thread.id}`);
  const initial = JSON.parse(full.body);
  const snapshot = await invoke(app, 'GET', `/api/threads/${created.thread.id}/snapshot?after=${initial.transcriptRevision}&cursorVersion=${initial.cursorVersion}`);
  const unchanged = JSON.parse(snapshot.body);
  assert.equal(Object.hasOwn(unchanged, 'transcript'), false);
  assert.deepEqual(unchanged.delta, []);
  assert.ok(snapshot.body.length < full.body.length / 20);

  const next = app.database.addUserMessage(created.thread.id, 'A newly saved continuation.');
  const changed = JSON.parse((await invoke(app, 'GET', `/api/threads/${created.thread.id}/snapshot?after=${initial.transcriptRevision}&cursorVersion=${initial.cursorVersion}`)).body);
  assert.deepEqual(changed.delta.map((message) => message.id), [next.id]);
  assert.equal(changed.delta[0].content, 'A newly saved continuation.');

  const assistant = app.database.addAssistantMessage(created.thread.id, next.id);
  const beforeStreaming = JSON.parse((await invoke(app, 'GET', `/api/threads/${created.thread.id}`)).body);
  app.database.appendMessageDelta(assistant.id, 'A partial reply.');
  const streaming = JSON.parse((await invoke(app, 'GET', `/api/threads/${created.thread.id}/snapshot?after=${beforeStreaming.transcriptRevision}&cursorVersion=${beforeStreaming.cursorVersion}`)).body);
  assert.equal(streaming.delta.find((message) => message.id === assistant.id).content, 'A partial reply.');
  assert.equal(streaming.delta.find((message) => message.id === assistant.id).status, 'streaming');
  app.database.completeAssistantMessage(assistant.id, 'The final reply.');
  const completed = JSON.parse((await invoke(app, 'GET', `/api/threads/${created.thread.id}/snapshot?after=${beforeStreaming.transcriptRevision}&cursorVersion=${beforeStreaming.cursorVersion}`)).body);
  assert.equal(completed.delta.find((message) => message.id === assistant.id).content, 'The final reply.');
  assert.equal(completed.delta.find((message) => message.id === assistant.id).status, 'complete');
});

test('data-directory lock prevents a second database opener and releases cleanly on shutdown', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-lock-test-'));
  const app = createStoryStudioServer({ dataDirectory, port: 0 });
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  assert.throws(() => createStoryStudioServer({ dataDirectory, port: 0 }), /already in use/i);
  assert.equal(await fs.stat(path.join(dataDirectory, '.story-studio.lock')).then(() => true), true);
  await app.close();
  await assert.rejects(fs.stat(path.join(dataDirectory, '.story-studio.lock')), { code: 'ENOENT' });
  const reopened = createStoryStudioServer({ dataDirectory, port: 0 });
  await reopened.listen();
  await reopened.close();
});

test('drafts, project exports, and local SQLite snapshots survive download and restore workflows', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-backup-http-test-'));
  const app = createStoryStudioServer({ dataDirectory, port: 0 });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  const created = app.database.createProject({ name: 'Draft export story' });
  const savedMessage = app.database.addUserMessage(created.thread.id, 'This saved line belongs in the snapshot.');
  const draftText = 'A paragraph in progress, saved without sending it.';
  const savedDraft = await invoke(app, 'POST', `/api/threads/${created.thread.id}/draft`, { content: draftText }, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(savedDraft.status, 200);
  assert.equal(JSON.parse(savedDraft.body).content, draftText);

  const projectDownload = await invoke(app, 'GET', `/api/projects/${created.project.id}/export`);
  assert.match(projectDownload.headers['content-disposition'], /attachment; filename=/);
  assert.equal(JSON.parse(projectDownload.body).format, 'timeless-sovereign-project');
  const fullDownload = await invoke(app, 'GET', '/api/backup');
  assert.equal(JSON.parse(fullDownload.body).drafts[0].content, draftText);

  const snapshotResponse = await invoke(app, 'POST', '/api/backup/snapshot', {}, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(snapshotResponse.status, 201);
  const snapshot = JSON.parse(snapshotResponse.body);
  const priorSnapshot = JSON.parse((await invoke(app, 'GET', `/api/threads/${created.thread.id}`)).body);
  const newProject = app.database.createProject({ name: 'Remove me on restore' });
  assert.ok(app.database.getProject(newProject.project.id));

  const restored = await invoke(app, 'POST', `/api/backups/${snapshot.id}/restore`, { confirmation: 'RESTORE ALL' }, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(restored.status, 200);
  assert.deepEqual(app.database.listProjects().map((project) => project.name), ['Draft export story']);
  assert.equal(app.database.getDraft(created.thread.id).content, draftText);
  const resetSnapshot = JSON.parse((await invoke(app, 'GET', `/api/threads/${created.thread.id}/snapshot?after=${priorSnapshot.transcriptRevision}&cursorVersion=${priorSnapshot.cursorVersion}`)).body);
  assert.equal(resetSnapshot.resetRequired, true);
  assert.deepEqual(resetSnapshot.delta.map((message) => message.id), [savedMessage.id]);
  const backups = JSON.parse((await invoke(app, 'GET', '/api/backups')).body);
  assert.ok(backups.backups.some((backup) => backup.id === snapshot.id && backup.kind === 'manual'));
  assert.ok(backups.backups.some((backup) => backup.id === JSON.parse(restored.body).recoveryBackupId && backup.kind === 'pre-restore'));
  assert.equal(backups.status.latestAutomatic?.kind, 'automatic');
});

test('invalid local SQLite snapshots leave current projects untouched', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-invalid-snapshot-test-'));
  const app = createStoryStudioServer({ dataDirectory, port: 0 });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  const created = app.database.createProject({ name: 'Keep after invalid restore' });
  const snapshotResponse = await invoke(app, 'POST', '/api/backup/snapshot', {}, { origin: base, csrfToken: bootstrap.csrfToken });
  const snapshot = JSON.parse(snapshotResponse.body);
  await fs.writeFile(path.join(dataDirectory, 'backups', `${snapshot.id}.db`), 'not a SQLite database');

  const restore = await invoke(app, 'POST', `/api/backups/${snapshot.id}/restore`, { confirmation: 'RESTORE ALL' }, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(restore.status, 400);
  assert.match(JSON.parse(restore.body).error, /SQLite|database|backup/i);
  assert.equal(app.database.getProject(created.project.id).name, 'Keep after invalid restore');
  assert.deepEqual(app.database.integrityCheck(), ['ok']);
});

test('automatic backup retention keeps the latest 14 valid SQLite snapshots', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-retention-test-'));
  let app = createStoryStudioServer({ dataDirectory, port: 0 });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });
  const directory = path.join(dataDirectory, 'backups');
  for (let daysAgo = 1; daysAgo <= 15; daysAgo += 1) {
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const id = `auto-${date.toISOString().slice(0, 10)}`;
    const destination = path.join(directory, `${id}.db`);
    app.database.createBackupFile(destination);
    await fs.utimes(destination, date, date);
  }
  await app.close();

  app = createStoryStudioServer({ dataDirectory, port: 0 });
  await app.listen();
  const automatic = JSON.parse((await invoke(app, 'GET', '/api/backups')).body).backups.filter((backup) => backup.kind === 'automatic');
  assert.equal(automatic.length, 14);
  assert.equal(automatic[0].id, `auto-${new Date().toISOString().slice(0, 10)}`);
  assert.ok(automatic.every((backup) => backup.size > 0));
});

test('backup write failures appear in local status and manual snapshot errors are actionable', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-backup-error-test-'));
  await fs.writeFile(path.join(dataDirectory, 'backups'), 'not a directory');
  const app = createStoryStudioServer({ dataDirectory, port: 0 });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });
  const bootstrap = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  assert.match(bootstrap.backupStatus.error, /mkdir|already exists/i);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const failed = await invoke(app, 'POST', '/api/backup/snapshot', {}, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(failed.status, 500);
  assert.match(JSON.parse(failed.body).error, /local backup could not be created/i);
});

test('restore stops active indexing, drains it, and returns its saved job to pending', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-restore-barrier-test-'));
  let connection = 'connected';
  let rejectIndexing = null;
  let signalIndexerStarted;
  const indexerStarted = new Promise((resolve) => { signalIndexerStarted = resolve; });
  const codex = {
    getConnectionStatus() { return { state: connection, message: 'Test app-server.' }; },
    async start() { connection = 'connected'; },
    async stop() {
      connection = 'disconnected';
      if (rejectIndexing) {
        const reject = rejectIndexing;
        rejectIndexing = null;
        reject(new Error('Codex app-server stopped.'));
      }
    },
    async startThread() { return 'indexing-thread'; },
    async streamTurn({ outputSchema }) {
      assert.ok(outputSchema);
      signalIndexerStarted();
      return new Promise((resolve, reject) => { rejectIndexing = reject; });
    }
  };
  const auth = {
    async status() { return { state: 'connected', message: 'Connected.' }; },
    async accessToken() { return 'test-access-token'; },
    async signOut() { return { revoked: false }; }
  };
  const app = createStoryStudioServer({ dataDirectory, port: 0, auth, codex });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });
  const bootstrap = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const created = app.database.createProject({ name: 'Restore barrier' });
  const source = app.database.addUserMessage(created.thread.id, 'A saved source awaiting indexing.');
  const backup = app.database.getBackup();

  const indexing = await invoke(app, 'POST', '/api/memory/retry', { projectId: created.project.id }, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(indexing.status, 200);
  await indexerStarted;
  assert.equal(app.indexer.hasActiveJobs(), true);

  const restored = await invoke(app, 'POST', '/api/backup/restore', { confirmation: 'RESTORE ALL', document: backup }, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(restored.status, 200);
  assert.equal(app.indexer.hasActiveJobs(), false);
  assert.equal(app.database.getMemoryJobForMessage(source.id).status, 'pending');
  assert.ok(JSON.parse(restored.body).recoveryBackupId.startsWith('pre-restore-'));
});

test('model thinking preferences follow the Codex model catalog and reach turn/start', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-reasoning-test-'));
  let connection = 'disconnected';
  const capturedEfforts = [];
  const model = {
    id: 'gpt-story-test', model: 'gpt-story-test', displayName: 'Story Test', isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }]
  };
  const auth = {
    async status() { return { state: 'connected', message: 'Connected.' }; },
    async accessToken() { return 'test-access-token'; },
    async signOut() { return { revoked: false }; }
  };
  const codex = {
    getConnectionStatus() { return { state: connection, message: 'Test app-server.' }; },
    async start() { connection = 'connected'; },
    async stop() { connection = 'disconnected'; },
    async listModels() { return [model]; },
    async startThread({ ephemeral }) {
      assert.equal(ephemeral, true);
      return `ephemeral-story-${capturedEfforts.length + 1}`;
    },
    async streamTurn({ reasoningEffort, outputSchema, onDelta }) {
      if (outputSchema) return { text: JSON.stringify({ entries: [] }) };
      capturedEfforts.push(reasoningEffort);
      onDelta?.('The door opened.');
      return { text: 'The door opened.' };
    }
  };
  const app = createStoryStudioServer({ dataDirectory, port: 0, auth, codex });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const bootstrap = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const saved = await invoke(app, 'PATCH', '/api/settings/model', { model: model.id, reasoningEffort: 'high' }, {
    origin: base, csrfToken: bootstrap.csrfToken
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.body), { selectedModel: model.id, reasoningEffort: 'high' });
  const invalid = await invoke(app, 'PATCH', '/api/settings/model', { model: model.id, reasoningEffort: 'ultra' }, {
    origin: base, csrfToken: bootstrap.csrfToken
  });
  assert.equal(invalid.status, 400);

  const created = app.database.createProject({ name: 'Reasoning choice' });
  const turn = await invoke(app, 'POST', `/api/threads/${created.thread.id}/send`, { content: 'Continue the scene.' }, {
    origin: base, csrfToken: bootstrap.csrfToken
  });
  assert.equal(decodeSse(turn.body).at(-1).event, 'complete');
  assert.deepEqual(capturedEfforts, ['high']);
  assert.equal(app.database.getSetting('model.reasoning_effort'), 'high');
});

test('the installer can stop the loopback app through its origin-checked local endpoint', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-update-shutdown-test-'));
  const app = createStoryStudioServer({ dataDirectory, port: 0 });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const bootstrap = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const stopped = await invoke(app, 'POST', '/api/app/shutdown', {}, { origin: base, csrfToken: bootstrap.csrfToken });
  assert.equal(stopped.status, 200);
  assert.deepEqual(JSON.parse(stopped.body), { stopping: true });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(app.server.listening, false);
});

test('retry reconnects Codex and resumes pending continuity jobs after restart', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-memory-retry-test-'));
  const calls = { starts: 0, indexThreads: 0, indexTurns: 0 };
  let codexState = 'disconnected';
  const auth = {
    async status() { return { state: 'connected', message: 'Connected with ChatGPT-plan authorization.' }; },
    async accessToken() { return 'test-access-token'; },
    async signOut() { return { revoked: false }; }
  };
  const codex = {
    getConnectionStatus() { return { state: codexState, message: 'Local test app-server.' }; },
    async start(token) { assert.equal(token, 'test-access-token'); calls.starts += 1; codexState = 'connected'; },
    async stop() { codexState = 'disconnected'; },
    async startThread(options) { assert.equal(options.ephemeral, true); calls.indexThreads += 1; return 'indexer-thread'; },
    async streamTurn() { calls.indexTurns += 1; return { text: JSON.stringify({ entries: [] }) }; }
  };
  const app = createStoryStudioServer({ dataDirectory, port: 0, auth, codex });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const created = app.database.createProject({ name: 'Pending after restart' });
  const source = app.database.addUserMessage(created.thread.id, 'A blue moth landed on the map.');
  const bootstrap = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  const retried = await invoke(app, 'POST', '/api/memory/retry', { projectId: created.project.id }, {
    origin: `http://127.0.0.1:${app.server.address().port}`, csrfToken: bootstrap.csrfToken
  });
  assert.equal(retried.status, 200);
  assert.equal(calls.starts, 1);
  for (let attempt = 0; attempt < 50 && app.database.getMemoryJobForMessage(source.id).status !== 'indexed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(app.database.getMemoryJobForMessage(source.id).status, 'indexed');
  assert.equal(calls.indexThreads, 1);
  assert.equal(calls.indexTurns, 1);
});

test('project import accepts a ChatGPT JSON conversation as a new project and preserves the raw export', async (t) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-chatgpt-import-test-'));
  const auth = {
    async status() { return { state: 'not_signed_in', message: 'Not connected.' }; },
    async signOut() { return { revoked: false }; }
  };
  const codex = {
    getConnectionStatus() { return { state: 'disconnected', message: 'Not connected.' }; },
    async stop() {}
  };
  const app = createStoryStudioServer({ dataDirectory, port: 0, auth, codex });
  await app.listen();
  t.after(async () => {
    await app.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const document = { metadata: { title: 'Archive as project' }, messages: [
    { role: 'Prompt', say: 'An exact opening prompt.\r\n' , time: '2026-10-16T12:00:00.000Z' },
    { role: 'Response', say: 'A reply with exact spacing.  ', time: '2026-10-16T12:00:01.000Z' }
  ] };
  const rawContent = JSON.stringify(document, null, 2);
  const bootstrap = JSON.parse((await invoke(app, 'GET', '/api/bootstrap')).body);
  const result = await invoke(app, 'POST', '/api/projects/import', {
    document, rawContent, fileName: 'ChatGPT-My-Story.json'
  }, {
    origin: `http://127.0.0.1:${app.server.address().port}`, csrfToken: bootstrap.csrfToken
  });
  assert.equal(result.status, 201);
  const imported = JSON.parse(result.body);
  assert.equal(imported.archiveImported, true);
  assert.equal(imported.project.name, 'Archive as project');
  assert.equal(imported.importedTurns, 1);
  const thread = JSON.parse((await invoke(app, 'GET', `/api/threads/${imported.thread.id}`)).body);
  assert.deepEqual(thread.transcript.map((message) => message.content), document.messages.map((message) => message.say));
  assert.equal(app.database.getBackup().projects[0].archives[0].rawContent, rawContent);

  const invalid = await invoke(app, 'POST', '/api/projects/import', { document: { metadata: {}, messages: [] } }, {
    origin: `http://127.0.0.1:${app.server.address().port}`, csrfToken: bootstrap.csrfToken
  });
  assert.equal(invalid.status, 400);
});
