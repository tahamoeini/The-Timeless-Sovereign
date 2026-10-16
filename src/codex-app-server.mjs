import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { JsonlRpcClient } from './jsonl-rpc.mjs';

const CLIENT_INFO = {
  name: 'timeless-sovereign-story-studio',
  title: 'The Timeless Sovereign Story Studio',
  version: '1.0.0'
};

const DISABLED_FEATURES = [
  'apps', 'browser_annotation_api', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'code_mode', 'code_mode_host', 'code_mode_only', 'code_mode_prewarm',
  'computer_use', 'deferred_executor', 'enable_mcp_apps', 'executor_capability_discovery',
  'goals', 'hooks', 'image_generation', 'in_app_browser', 'in_app_local_automation', 'memories', 'multi_agent',
  'multi_agent_v2', 'plugins', 'remote_plugin', 'request_permissions_tool',
  'shell_snapshot', 'shell_tool', 'skill_search', 'sleep_tool', 'standalone_web_search',
  'skill_mcp_dependency_install', 'tool_suggest', 'unified_exec', 'view_image'
];

const SAFE_ITEM_TYPES = new Set(['agentMessage', 'userMessage', 'reasoning', 'contextCompaction']);
const APPROVAL_REQUESTS = new Set([
  'commandExecution/requestApproval',
  'execCommand/requestApproval',
  'fileChange/requestApproval',
  'applyPatch/requestApproval'
]);

function resolveCodexExecutable({ env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const configuredPath = env.CODEX_EXECUTABLE;
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  let lookup;
  try { lookup = spawnSyncImpl('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true }); }
  catch { lookup = null; }
  if (lookup?.status === 0) {
    const candidate = String(lookup.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line && fs.existsSync(line));
    if (candidate) return candidate;
  }

  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    const installRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(installRoot)) {
      const candidates = [];
      const directInstall = path.join(installRoot, 'codex.exe');
      if (fs.existsSync(directInstall) && fs.statSync(directInstall).isFile()) candidates.push(directInstall);
      for (const entry of fs.readdirSync(installRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(installRoot, entry.name, 'codex.exe');
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) candidates.push(candidate);
      }
      candidates.sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);
      if (candidates.length) return candidates[0];
    }
  }
  return null;
}

function safeEnvironment(accessToken, dataDirectory) {
  const safeNames = [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'PROGRAMDATA', 'PROCESSOR_ARCHITECTURE'
  ];
  const environment = Object.fromEntries(safeNames.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const tempDirectory = path.join(dataDirectory, 'temp');
  fs.mkdirSync(tempDirectory, { recursive: true });
  environment.TEMP = tempDirectory;
  environment.TMP = tempDirectory;
  environment.CODEX_HOME = path.join(dataDirectory, 'codex-home');
  environment.ACCESS_TOKEN = accessToken;
  return environment;
}

export class CodexAppServer extends EventEmitter {
  constructor({ dataDirectory, executable = resolveCodexExecutable(), spawnProcess = spawn }) {
    super();
    this.dataDirectory = dataDirectory;
    this.executable = executable;
    this.spawnProcess = spawnProcess;
    this.process = null;
    this.rpc = null;
    this.status = 'disconnected';
    this.lastError = null;
    this.activeTurns = new Map();
    this.loadedThreads = new Map();
    this.stderrTail = [];
    this.version = null;
  }

  getConnectionStatus() {
    if (!this.executable) return { state: 'codex_missing', message: 'Codex app-server executable was not found.' };
    if (this.status === 'connected') return { state: 'connected', message: 'Connected to Codex app-server.' };
    if (this.status === 'connecting') return { state: 'connecting', message: 'Connecting to Codex app-server.' };
    return { state: this.status, message: this.lastError || 'Codex app-server is not connected.' };
  }

  async start(accessToken) {
    if (!this.executable) throw new Error('Codex app-server executable was not found. Install Codex CLI or set CODEX_EXECUTABLE.');
    if (!accessToken) throw new Error('ChatGPT-plan authorization is not available. Sign in with ChatGPT first.');
    if (this.status === 'connected') await this.stop();
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    const codexHome = path.join(this.dataDirectory, 'codex-home');
    const workingDirectory = path.join(this.dataDirectory, 'empty-workspace');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(workingDirectory, { recursive: true });

    const args = [
      'app-server', '--listen', 'stdio://', '--strict-config',
      ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      '-c', 'model_provider="openai_chatgpt_plan"',
      '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
      '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
      '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
      '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
      '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
      '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
      '-c', 'web_search="disabled"',
      '-c', 'mcp_servers={}',
      '-c', 'project_doc_max_bytes=0',
      '-c', 'analytics.enabled=false'
    ];

    this.status = 'connecting';
    this.lastError = null;
    this.loadedThreads.clear();
    const child = this.spawnProcess(this.executable, args, {
      cwd: workingDirectory,
      env: safeEnvironment(accessToken, this.dataDirectory),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
    this.process = child;
    this.rpc = new JsonlRpcClient({
      readable: child.stdout,
      writable: child.stdin,
      timeoutMs: 30_000,
      serverRequestHandler: (method) => this.handleServerRequest(method)
    });
    this.rpc.on('notification', (notification) => this.handleNotification(notification));
    this.rpc.on('close', (error) => this.handleExit(error));
    this.rpc.on('protocolError', (error) => this.failConnection(error));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.collectStderr(chunk));
    child.on('error', (error) => this.failConnection(error));
    child.on('exit', (code, signal) => this.handleExit(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'}).`)));

    try {
      await this.rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false } });
      this.rpc.notify('initialized');
      this.status = 'connected';
      this.emit('status', this.getConnectionStatus());
      return this.getConnectionStatus();
    } catch (error) {
      await this.stop();
      const message = this.publicError(error);
      this.status = error?.code === 401 || error?.code === 403 || /unauthori[sz]ed|invalid token|token expired|bearer \[redacted\].*rejected/i.test(message)
        ? 'authorization_error'
        : 'error';
      this.lastError = message;
      this.emit('status', this.getConnectionStatus());
      throw new Error(message);
    }
  }

  async startThread({ model, developerInstructions, ephemeral = false }) {
    this.requireConnected();
    const workspace = path.join(this.dataDirectory, 'empty-workspace');
    const response = await this.rpc.request('thread/start', {
      model: model || undefined,
      modelProvider: 'openai_chatgpt_plan',
      cwd: workspace,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      ephemeral,
      developerInstructions
    });
    this.loadedThreads.set(response.thread.id, { ephemeral });
    return response.thread.id;
  }

  async resumeThread({ codexThreadId, developerInstructions }) {
    this.requireConnected();
    if (this.loadedThreads.has(codexThreadId)) return codexThreadId;
    const workspace = path.join(this.dataDirectory, 'empty-workspace');
    const response = await this.rpc.request('thread/resume', {
      threadId: codexThreadId,
      excludeTurns: true,
      cwd: workspace,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      developerInstructions
    });
    this.loadedThreads.set(response.thread.id, { ephemeral: false });
    return response.thread.id;
  }

  async forkThread({ codexThreadId, developerInstructions }) {
    this.requireConnected();
    await this.resumeThread({ codexThreadId, developerInstructions });
    const workspace = path.join(this.dataDirectory, 'empty-workspace');
    const response = await this.rpc.request('thread/fork', {
      threadId: codexThreadId,
      cwd: workspace,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      ephemeral: false,
      developerInstructions
    });
    this.loadedThreads.set(response.thread.id, { ephemeral: false });
    return response.thread.id;
  }

  async listModels() {
    this.requireConnected();
    const response = await this.rpc.request('model/list', { limit: 100, includeHidden: false });
    return response.data ?? [];
  }

  async streamTurn({ threadId, text, model, outputSchema, onDelta = () => {}, onActivity = () => {} }) {
    this.requireConnected();
    if (this.activeTurns.has(threadId)) throw new Error('A Codex turn is already running for this thread.');
    const record = {
      threadId,
      turnId: null,
      buffered: [],
      text: '',
      blocked: false,
      onDelta,
      onActivity,
      resolve: null,
      reject: null,
      completion: null
    };
    record.completion = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    this.activeTurns.set(threadId, record);
    try {
      const response = await this.rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        model: model || undefined,
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        cwd: path.join(this.dataDirectory, 'empty-workspace'),
        outputSchema
      });
      record.turnId = response.turn.id;
      for (const notification of record.buffered.splice(0)) this.processTurnNotification(record, notification);
      return await record.completion;
    } catch (error) {
      this.activeTurns.delete(threadId);
      throw new Error(this.publicError(error));
    }
  }

  async interrupt(threadId) {
    const record = this.activeTurns.get(threadId);
    if (!record?.turnId || !this.rpc || this.rpc.closed) return false;
    await this.rpc.request('turn/interrupt', { threadId, turnId: record.turnId });
    return true;
  }

  async stop() {
    const child = this.process;
    this.process = null;
    this.rpc?.close(new Error('Codex app-server stopped.'));
    this.rpc = null;
    this.loadedThreads.clear();
    if (!child || child.exitCode !== null) {
      this.status = 'disconnected';
      return;
    }
    child.stdin.end();
    const stopTimer = setTimeout(() => child.kill(), 1500);
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref?.();
    });
    clearTimeout(stopTimer);
    if (child.exitCode === null) child.kill();
    this.status = 'disconnected';
    this.emit('status', this.getConnectionStatus());
  }

  requireConnected() {
    if (this.status !== 'connected' || !this.rpc || this.rpc.closed) throw new Error('Codex app-server is not connected. Sign in with ChatGPT and reconnect.');
  }

  async handleServerRequest(method) {
    if (APPROVAL_REQUESTS.has(method)) return { decision: 'decline' };
    return null;
  }

  handleNotification(notification) {
    const params = notification.params ?? {};
    const record = this.activeTurns.get(params.threadId);
    if (!record) return;
    if (record.turnId === null) {
      record.buffered.push(notification);
      return;
    }
    this.processTurnNotification(record, notification);
  }

  processTurnNotification(record, notification) {
    const { method, params = {} } = notification;
    const notificationTurnId = params.turnId ?? params.turn?.id;
    if (notificationTurnId && notificationTurnId !== record.turnId) return;
    if (method === 'item/agentMessage/delta') {
      const delta = String(params.delta ?? '');
      record.text += delta;
      record.onDelta(delta);
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const type = params.item?.type;
      if (type && !SAFE_ITEM_TYPES.has(type)) {
        this.blockUnexpectedTool(record, `Codex requested a non-chat capability (${type}).`);
        return;
      }
      if (type) record.onActivity({ type });
      return;
    }
    if (method === 'turn/completed') {
      if (record.blocked) return;
      const turn = params.turn;
      if (turn?.status !== 'completed') {
        const error = new Error(turn?.error?.message || `Codex turn ended with status ${turn?.status ?? 'unknown'}.`);
        this.finishTurn(record, error);
        return;
      }
      const finalItem = [...(turn.items ?? [])].reverse().find((item) => item.type === 'agentMessage' && typeof item.text === 'string');
      const finalText = finalItem?.text ?? record.text;
      for (const item of turn.items ?? []) {
        if (item.type && !SAFE_ITEM_TYPES.has(item.type)) {
          this.blockUnexpectedTool(record, `Codex returned a non-chat capability (${item.type}).`);
          return;
        }
      }
      this.finishTurn(record, null, finalText);
      return;
    }
    if (method === 'error' || method === 'turn/error') {
      this.finishTurn(record, new Error(params.message ?? 'Codex turn failed.'));
    }
  }

  blockUnexpectedTool(record, reason) {
    if (record.blocked) return;
    record.blocked = true;
    this.interrupt(record.threadId).catch(() => {});
    this.finishTurn(record, new Error(`${reason} The turn was stopped because this app only allows story chat.`));
  }

  finishTurn(record, error, text = undefined) {
    if (this.activeTurns.get(record.threadId) !== record) return;
    this.activeTurns.delete(record.threadId);
    if (error) record.reject(new Error(this.publicError(error)));
    else record.resolve({ text: String(text ?? ''), turnId: record.turnId });
  }

  collectStderr(chunk) {
    const clean = String(chunk)
      .replace(/(ACCESS_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)=\S+/gi, '$1=[redacted]')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    this.stderrTail.push(...clean);
    this.stderrTail = this.stderrTail.slice(-20);
  }

  publicError(error) {
    const message = String(error?.message ?? error ?? 'Unknown Codex error.')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/(ACCESS_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)=\S+/gi, '$1=[redacted]');
    if (/401|unauthori[sz]ed|invalid.*token|expired.*token|bearer.*rejected/i.test(message)) {
      return 'ChatGPT-plan authorization was rejected or expired. Reconnect with ChatGPT; API-key billing is not used.';
    }
    return message.slice(0, 500);
  }

  failConnection(error) {
    if (this.status === 'disconnected') return;
    this.status = 'error';
    this.lastError = this.publicError(error);
    this.emit('status', this.getConnectionStatus());
    for (const record of this.activeTurns.values()) this.finishTurn(record, error);
  }

  handleExit(error) {
    if (this.status === 'disconnected') return;
    this.status = 'error';
    this.lastError = this.publicError(error);
    this.emit('status', this.getConnectionStatus());
    for (const record of this.activeTurns.values()) this.finishTurn(record, error);
    this.rpc?.close(error);
  }
}

export { resolveCodexExecutable, DISABLED_FEATURES, SAFE_ITEM_TYPES };
