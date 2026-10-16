import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer, DISABLED_FEATURES, resolveCodexExecutable } from '../src/codex-app-server.mjs';

class FakeAppServerChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.mode = 'success';
    this.threadCount = 0;
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk) => this.consume(chunk));
    this.stdin.on('finish', () => {
      this.exitCode = 0;
      this.emit('exit', 0, null);
    });
  }

  consume(chunk) {
    this.input = (this.input ?? '') + chunk;
    let newline = this.input.indexOf('\n');
    while (newline >= 0) {
      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      const packet = JSON.parse(line);
      this.handle(packet);
      newline = this.input.indexOf('\n');
    }
  }

  reply(packet) { this.stdout.write(`${JSON.stringify(packet)}\n`); }

  handle(packet) {
    if (!packet.method || !Object.hasOwn(packet, 'id')) return;
    if (packet.method === 'initialize') {
      if (this.mode === 'unauthorized-init') {
        this.reply({ id: packet.id, error: { code: 401, message: 'Bearer fake-secret-token was rejected.' } });
      } else this.reply({ id: packet.id, result: { userAgent: 'Codex app-server test fixture' } });
      return;
    }
    if (packet.method === 'thread/start') {
      this.lastThreadStart = packet.params;
      this.threadCount += 1;
      this.reply({ id: packet.id, result: { thread: { id: `codex-thread-${this.threadCount}` } } });
      return;
    }
    if (packet.method === 'thread/resume') {
      this.lastThreadResume = packet.params;
      this.reply({ id: packet.id, result: { thread: { id: packet.params.threadId } } });
      return;
    }
    if (packet.method === 'thread/fork') {
      this.lastThreadFork = packet.params;
      this.threadCount += 1;
      this.reply({ id: packet.id, result: { thread: { id: `codex-thread-${this.threadCount}` } } });
      return;
    }
    if (packet.method === 'model/list') {
      this.reply({ id: packet.id, result: { data: [{ id: 'gpt-story-test', model: 'gpt-story-test', displayName: 'Story Test' }] } });
      return;
    }
    if (packet.method === 'turn/interrupt') {
      this.reply({ id: packet.id, result: {} });
      return;
    }
    if (packet.method === 'turn/start') {
      const threadId = packet.params.threadId;
      this.lastTurnStart = packet.params;
      this.reply({ id: packet.id, result: { turn: { id: 'test-turn-1' } } });
      setImmediate(() => {
        if (this.mode === 'tool') {
          this.reply({ method: 'item/started', params: { threadId, turnId: 'test-turn-1', item: { type: 'commandExecution' } } });
          return;
        }
        if (this.mode === 'failed-turn') {
          this.reply({ method: 'turn/completed', params: { threadId, turn: { id: 'test-turn-1', status: 'failed', error: { message: 'Temporary model failure.' }, items: [] } } });
          return;
        }
        if (this.mode === 'error-notification') {
          this.reply({ method: 'error', params: { threadId, turnId: 'test-turn-1', error: { message: 'This model is unavailable for this account.' }, willRetry: false } });
          return;
        }
        if (this.mode === 'retryable-error') {
          this.reply({ method: 'error', params: { threadId, turnId: 'test-turn-1', error: { message: 'Temporary connection issue.' }, willRetry: true } });
          this.reply({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'test-turn-1', delta: 'Recovered after retry.' } });
          this.reply({ method: 'turn/completed', params: { threadId, turn: { id: 'test-turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'Recovered after retry.' }] } } });
          return;
        }
        this.reply({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'test-turn-1', delta: 'The lantern burned ' } });
        this.reply({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'test-turn-1', delta: 'blue at midnight.' } });
        this.reply({ method: 'turn/completed', params: { threadId, turn: { id: 'test-turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'The lantern burned blue at midnight.' }] } } });
      });
    }
  }

  kill() {
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

async function makeServer(t) {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-server-test-'));
  t.after(async () => fs.rm(dataDirectory, { recursive: true, force: true }));
  let child;
  let options;
  const app = new CodexAppServer({
    dataDirectory,
    executable: 'codex-test.exe',
    spawnProcess: (_executable, args, spawnOptions) => {
      options = { args, ...spawnOptions };
      child = new FakeAppServerChild();
      return child;
    }
  });
  await app.start('fake-local-access-token');
  return { app, dataDirectory, get child() { return child; }, get options() { return options; } };
}

test('Codex discovery finds the standard Windows per-user app-server installation', async (t) => {
  const localAppData = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-install-test-'));
  t.after(async () => fs.rm(localAppData, { recursive: true, force: true }));
  const executable = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'build-hash', 'codex.exe');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, 'test executable placeholder');

  const resolved = resolveCodexExecutable({
    env: { LOCALAPPDATA: localAppData },
    spawnSyncImpl: () => ({ status: 1, stdout: '' })
  });
  assert.equal(resolved, executable);
});

test('local app-server lifecycle uses read-only chat threads, ephemeral indexing threads, streaming, and interruption', async (t) => {
  const fixture = await makeServer(t);
  const { app, child, options, dataDirectory } = fixture;
  assert.equal(options.cwd, path.join(dataDirectory, 'empty-workspace'));
  assert.equal(options.shell, false);
  assert.equal(options.env.CODEX_HOME, path.join(dataDirectory, 'codex-home'));
  assert.equal(options.env.ACCESS_TOKEN, 'fake-local-access-token');
  assert.equal('OPENAI_API_KEY' in options.env, false);
  assert.equal('CODEX_API_KEY' in options.env, false);
  assert.ok(DISABLED_FEATURES.includes('shell_tool'));
  assert.ok(DISABLED_FEATURES.includes('unified_exec'));
  assert.ok(options.args.includes('--strict-config'));

  const persistentId = await app.startThread({ model: 'gpt-story-test', developerInstructions: 'Fiction only.', ephemeral: false });
  assert.equal(persistentId, 'codex-thread-1');
  assert.equal(child.lastThreadStart.ephemeral, false);
  assert.equal(child.lastThreadStart.sandbox, 'read-only');
  assert.equal(child.lastThreadStart.cwd, path.join(dataDirectory, 'empty-workspace'));
  await app.resumeThread({ codexThreadId: persistentId, developerInstructions: 'Fiction only.' });
  assert.equal(child.lastThreadResume, undefined);
  const branchId = await app.forkThread({ codexThreadId: persistentId, developerInstructions: 'Fiction only.' });
  assert.equal(branchId, 'codex-thread-2');
  assert.equal(child.lastThreadFork.sandbox, 'read-only');

  const deltas = [];
  const result = await app.streamTurn({ threadId: persistentId, text: 'Source-backed context.', reasoningEffort: 'high', onDelta: (delta) => deltas.push(delta) });
  assert.equal(result.text, 'The lantern burned blue at midnight.');
  assert.deepEqual(deltas, ['The lantern burned ', 'blue at midnight.']);
  assert.deepEqual(child.lastTurnStart.input, [{ type: 'text', text: 'Source-backed context.' }]);
  assert.deepEqual(child.lastTurnStart.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(child.lastTurnStart.effort, 'high');
  assert.equal(child.lastTurnStart.cwd, path.join(dataDirectory, 'empty-workspace'));

  const ephemeralId = await app.startThread({ developerInstructions: 'Index saved messages only.', ephemeral: true });
  assert.equal(ephemeralId, 'codex-thread-3');
  assert.equal(child.lastThreadStart.ephemeral, true);
  await app.stop();
  assert.equal(app.getConnectionStatus().state, 'disconnected');
});

test('app-server failures and any non-chat item fail closed without presenting it as a story reply', async (t) => {
  const fixture = await makeServer(t);
  const { app, child } = fixture;
  const threadId = await app.startThread({ developerInstructions: 'Fiction only.' });
  child.mode = 'failed-turn';
  await assert.rejects(app.streamTurn({ threadId, text: 'continue' }), /Temporary model failure/);
  child.mode = 'tool';
  await assert.rejects(app.streamTurn({ threadId, text: 'continue' }), /only allows story chat/);
  child.mode = 'error-notification';
  await assert.rejects(app.streamTurn({ threadId, text: 'continue' }), /model is unavailable for this account/);
  child.mode = 'retryable-error';
  const activities = [];
  const retried = await app.streamTurn({ threadId, text: 'continue', onActivity: (activity) => activities.push(activity) });
  assert.equal(retried.text, 'Recovered after retry.');
  assert.equal(activities.some((activity) => activity.type === 'retrying'), true);
  await app.stop();

  const unauthorizedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-unauthorized-test-'));
  t.after(async () => fs.rm(unauthorizedDirectory, { recursive: true, force: true }));
  let unauthorizedChild;
  const unauthorized = new CodexAppServer({
    dataDirectory: unauthorizedDirectory,
    executable: 'codex-test.exe',
    spawnProcess: () => {
      unauthorizedChild = new FakeAppServerChild();
      unauthorizedChild.mode = 'unauthorized-init';
      return unauthorizedChild;
    }
  });
  await assert.rejects(unauthorized.start('fake-token'), /ChatGPT-plan authorization was rejected or expired/);
  assert.equal(unauthorized.getConnectionStatus().state, 'authorization_error');
  assert.doesNotMatch(unauthorized.getConnectionStatus().message, /fake-secret-token/);
});
