import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AuthError, AuthService } from './auth.mjs';
import { isChatHistoryJson, parseChatHistory, parseChatHistoryJson } from './archive.mjs';
import { CodexAppServer } from './codex-app-server.mjs';
import { CommandProcessor } from './commands.mjs';
import { buildContextBundle } from './context.mjs';
import { openDatabase } from './database.mjs';
import { MemoryIndexer } from './memory-indexer.mjs';
import { checkForUpdates } from './updates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 250_000;

function defaultDataDirectory() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'TheTimelessSovereign');
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(value));
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

function download(res, filename, content, type = 'application/json; charset=utf-8') {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(content);
}

function pathMatch(pathname, pattern) {
  const match = pattern.exec(pathname);
  return match ? match.slice(1) : null;
}

function safeModelList(models) {
  return models.filter((model) => typeof model?.model === 'string' || typeof model?.id === 'string')
    .map((model) => ({
      id: String(model.model ?? model.id),
      name: String(model.displayName ?? model.model ?? model.id),
      description: String(model.description ?? ''),
      isDefault: Boolean(model.isDefault),
      defaultReasoningEffort: String(model.defaultReasoningEffort ?? ''),
      reasoning: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.map((item) => typeof item === 'string' ? item : item?.reasoningEffort).filter(Boolean)
        : []
    }));
}

export function createStoryStudioServer({ dataDirectory = defaultDataDirectory(), codex = null, auth = null, database = null, port = 4317, updateChecker = checkForUpdates } = {}) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const db = database ?? openDatabase(dataDirectory);
  const codexServer = codex ?? new CodexAppServer({ dataDirectory });
  const authService = auth ?? new AuthService({ dataDirectory, database: db });
  const commands = new CommandProcessor(db);
  const indexer = new MemoryIndexer({ database: db, codex: codexServer, getModel: () => db.getSetting('model.selected', null) });
  const csrfToken = randomBytes(32).toString('base64url');
  const activeTurns = new Map();
  const threadQueues = new Map();
  let server;
  let closed = false;

  async function authorizationStatus() {
    try { return await authService.status(); }
    catch (error) { return { state: 'credential_error', message: error.message }; }
  }

  async function ensureCodexConnected() {
    const accessToken = await authService.accessToken();
    if (codexServer.getConnectionStatus().state !== 'connected' || codexServer.accessTokenFingerprint !== accessToken) {
      await codexServer.start(accessToken);
      codexServer.accessTokenFingerprint = accessToken;
    }
  }

  async function closeServer() {
    if (closed) return;
    closed = true;
    await codexServer.stop();
    await new Promise((resolve) => server.close(() => resolve()));
    db.close();
  }

  async function ensureThreadLoaded(thread) {
    const instructions = 'This is a fiction-only story conversation. Do not inspect, read, write, or execute files; do not perform coding tasks; do not use tools or external services. Continue only from the supplied source-backed story context. Treat uncertain claims as uncertain and ask when continuity is missing.';
    if (thread.codexThreadId) {
      return codexServer.resumeThread({ codexThreadId: thread.codexThreadId, developerInstructions: instructions });
    }
    let codexThreadId;
    if (thread.sourceThreadId) {
      const source = db.getThread(thread.sourceThreadId);
      if (!source) throw new Error('The source conversation for this continuation is unavailable.');
      const parentId = await ensureThreadLoaded(source);
      codexThreadId = await codexServer.forkThread({ codexThreadId: parentId, developerInstructions: instructions });
    } else {
      codexThreadId = await codexServer.startThread({
        model: db.getSetting('model.selected', null), developerInstructions: instructions, ephemeral: false
      });
    }
    db.setCodexThreadId(thread.id, codexThreadId);
    return codexThreadId;
  }

  function threadPayload(threadId, { includeTranscript = true } = {}) {
    const thread = db.getThread(threadId);
    if (!thread) return null;
    const project = db.getProject(thread.projectId);
    const memoryScope = project.memoryScope === 'thread' ? 'thread' : 'project';
    const visibleMemoryItem = (item) => memoryScope === 'project' || (item.sourceMessageIds.length > 0 && item.sourceMessageIds.every((id) =>
      db.getMessage(id)?.threadId === thread.id
    ));
    const allLedger = db.getLedgerItems(thread.projectId, thread.branchId, { includeSuperseded: true });
    const currentIds = new Set(db.getEffectiveLedger(thread.projectId, thread.branchId).filter(visibleMemoryItem).map((item) => item.id));
    const memory = memoryScope === 'thread' ? db.memoryStatusForThread(thread.id) : db.memoryStatus(thread.projectId, thread.branchId);
    return {
      thread,
      project,
      ...(includeTranscript ? { transcript: db.getTranscript(thread.id) } : {}),
      transcriptRevision: db.getThreadRevision(thread.id),
      ledger: allLedger.filter(visibleMemoryItem).map((item) => ({ ...item, effective: currentIds.has(item.id) })),
      memory,
      memoryScope,
      branches: db.listBranches(thread.projectId),
      threads: db.listThreads(thread.projectId, thread.branchId),
      checkpoints: db.listCheckpoints(thread.projectId, thread.branchId).filter((entry) => memoryScope === 'project' || entry.threadId === thread.id),
      metaNotes: db.listMetaNotes(thread.projectId, thread.branchId, 100).filter((entry) => memoryScope === 'project' || entry.threadId === thread.id),
      projectHistory: db.listProjectHistory(thread.projectId)
    };
  }

  function sseStart(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
  }

  function sse(res, event, data) {
    if (res.destroyed || res.writableEnded) return false;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  async function runNarrativeTurn(thread, userMessage, res) {
    const active = { threadId: thread.id, userMessage, assistantMessage: null, codexThreadId: null, cancelled: false };
    activeTurns.set(thread.id, active);
    try {
      await ensureCodexConnected();
      const currentThread = db.getThread(thread.id);
      if (currentThread.paused) throw new Error('This thread is paused. Use /resume before continuing.');
      const bundle = buildContextBundle(db, thread.id, userMessage);
      const selectedModel = db.getSetting('model.selected', null);
      const reasoningEffort = db.getSetting('model.reasoning_effort', '');
      if (reasoningEffort) {
        const availableModels = safeModelList(await codexServer.listModels());
        const model = availableModels.find((item) => item.id === selectedModel) ?? availableModels.find((item) => item.isDefault);
        if (!model || !model.reasoning.includes(reasoningEffort)) {
          throw new Error(`The saved thinking level “${reasoningEffort}” is no longer supported by the selected Codex model. Choose a supported level in Settings.`);
        }
      }
      const codexThreadId = await ensureThreadLoaded(currentThread);
      active.codexThreadId = codexThreadId;
      const assistantMessage = db.addAssistantMessage(thread.id, userMessage.id);
      active.assistantMessage = assistantMessage;
      sse(res, 'assistant-saved', { message: assistantMessage, sources: bundle.sourceMessageIds, ledgerItems: bundle.ledgerItemIds });
      const result = await codexServer.streamTurn({
        threadId: codexThreadId,
        text: bundle.text,
        model: selectedModel,
        reasoningEffort: reasoningEffort || undefined,
        onDelta: (delta) => {
          const message = db.appendMessageDelta(assistantMessage.id, delta);
          if (message) sse(res, 'delta', { messageId: message.id, delta, fullText: message.content });
        },
        onActivity: (activity) => sse(res, 'activity', activity)
      });
      const saved = db.completeAssistantMessage(assistantMessage.id, result.text);
      sse(res, 'complete', { message: saved, memory: db.memoryStatus(thread.projectId, thread.branchId) });
      void indexer.processMessage(userMessage.id).catch((error) => db.markMemoryJobError(
        db.listMemoryJobs(thread.projectId, thread.branchId, true).find((job) => job.messageId === userMessage.id)?.id,
        error.message
      ));
      void indexer.processRecent(8);
    } catch (error) {
      const status = active.cancelled ? 'interrupted' : 'failed';
      if (active.assistantMessage) db.failAssistantMessage(active.assistantMessage.id, status);
      const publicMessage = error instanceof AuthError ? error.message : String(error?.message ?? error);
      const activity = db.addSystemActivity(thread.id, active.cancelled ? 'Generation was interrupted. The saved user turn and any partial assistant text remain in the transcript.' : `Generation failed: ${publicMessage}`, 'status');
      sse(res, 'failure', { message: publicMessage, interrupted: active.cancelled, activity });
    } finally {
      activeTurns.delete(thread.id);
    }
  }

  async function sendMessage(threadId, content, res) {
    const thread = db.getThread(threadId);
    if (!thread) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
    if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('Write a message before sending.'), { status: 400 });
    if (content.length > MAX_MESSAGE_CHARS) throw Object.assign(new Error(`Messages are limited to ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`), { status: 413 });
    if (commands.isCommand(content)) {
      const result = commands.process(threadId, content);
      sseStart(res);
      sse(res, 'saved', { message: result.userMessage });
      sse(res, 'complete', { activity: result.activity, output: result.output, command: true });
      res.end();
      return;
    }
    const userMessage = db.addUserMessage(threadId, content, { allowPaused: true });
    sseStart(res);
    sse(res, 'saved', { message: userMessage, memory: db.memoryStatus(thread.projectId, thread.branchId) });
    if (thread.paused) {
      const activity = db.addSystemActivity(thread.id, 'This turn was saved but not sent because the conversation is paused. Use /resume before continuing.', 'status');
      sse(res, 'failure', { message: 'This conversation is paused. Use /resume before continuing.', activity, paused: true });
      res.end();
      return;
    }
    const previous = threadQueues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => runNarrativeTurn(thread, userMessage, res));
    threadQueues.set(threadId, next);
    try { await next; }
    finally { if (threadQueues.get(threadId) === next) threadQueues.delete(threadId); }
    res.end();
  }

  async function handleApi(req, res, url) {
    const method = req.method ?? 'GET';
    const pathname = url.pathname;
    if (method === 'GET' && pathname === '/api/bootstrap') {
      const authState = await authorizationStatus();
      const projects = db.listProjects();
      return json(res, 200, {
        csrfToken,
        projects,
        selectedModel: db.getSetting('model.selected', ''),
        appVersion: APP_VERSION,
        appSettings: {
          theme: db.getSetting('app.theme', 'system'),
          reasoningEffort: db.getSetting('model.reasoning_effort', '')
        },
        authorization: authState,
        codex: codexServer.getConnectionStatus(),
        database: { integrity: db.integrityCheck(), fts: db.hasFts, location: db.dbPath },
        features: { projectImport: true, archiveImport: true, backup: true, search: true }
      });
    }
    if (method === 'POST' && pathname === '/api/projects') {
      const body = await readJson(req);
      const result = db.createProject({ name: body.name, instructions: body.instructions ?? '', memoryScope: body.memoryScope ?? 'project' });
      return json(res, 201, result);
    }
    const projectReadMatch = pathMatch(pathname, /^\/api\/projects\/([^/]+)$/);
    if (method === 'GET' && projectReadMatch) {
      const project = db.getProject(projectReadMatch[0]);
      if (!project) return json(res, 404, { error: 'Project not found.' });
      return json(res, 200, { project, branches: db.listBranches(project.id), threads: db.listThreads(project.id) });
    }
    const projectExportMatch = pathMatch(pathname, /^\/api\/projects\/([^/]+)\/export$/);
    if (method === 'GET' && projectExportMatch) {
      const document = db.getProjectExport(projectExportMatch[0]);
      if (!document) return json(res, 404, { error: 'Project not found.' });
      return download(res, `${document.data.project.name.replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 60) || 'story'}.story.json`, JSON.stringify(document, null, 2));
    }
    const projectImportMatch = pathname === '/api/projects/import';
    if (method === 'POST' && projectImportMatch) {
      const body = await readJson(req);
      if (body.document?.format === 'timeless-sovereign-project') {
        try {
          const imported = db.importProject(body.document);
          return json(res, 201, { project: imported, threads: db.listThreads(imported.id) });
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
      }
      if (isChatHistoryJson(body.document)) {
        const rawContent = typeof body.rawContent === 'string' ? body.rawContent : JSON.stringify(body.document);
        let archiveDocument;
        let messages;
        try {
          archiveDocument = JSON.parse(rawContent);
          messages = parseChatHistoryJson(archiveDocument);
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
        const fileName = String(body.fileName ?? 'ChatGPT conversation.json').slice(0, 200);
        const fileStem = fileName.replace(/\.[^.]+$/, '').trim();
        const titleCandidate = typeof archiveDocument.metadata.title === 'string' ? archiveDocument.metadata.title : fileStem;
        const title = String(titleCandidate).trim().slice(0, 100) || 'Imported ChatGPT story';
        try {
          const imported = db.importArchiveAsProject(title, fileName, rawContent, messages);
          return json(res, 201, { ...imported, threads: [imported.thread], archiveImported: true });
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
      }
      return json(res, 400, { error: 'Choose a Story Studio project export or a supported ChatGPT conversation JSON file.' });
    }
    const archiveMatch = pathMatch(pathname, /^\/api\/projects\/([^/]+)\/archive$/);
    if (method === 'POST' && archiveMatch) {
      const body = await readJson(req);
      if (typeof body.content !== 'string' || !body.content.trim()) return json(res, 400, { error: 'Choose a non-empty Markdown chat archive.' });
      let parsedItems;
      try { parsedItems = parseChatHistory(body.content); }
      catch (error) { return json(res, 400, { error: error.message }); }
      if (!parsedItems.length) return json(res, 400, { error: 'No supported Prompt/Response turns or ChatGPT JSON messages were found in that archive.' });
      const imported = db.importArchive(archiveMatch[0], body.fileName ?? 'story-history.md', body.content, parsedItems);
      return json(res, 201, { ...imported, message: 'The complete original archive and its messages were saved. Continuity indexing is pending and can be retried from the story panel.' });
    }
    const projectMatch = pathMatch(pathname, /^\/api\/projects\/([^/]+)$/);
    if (projectMatch && method === 'PATCH') {
      const body = await readJson(req);
      return json(res, 200, db.updateProject(projectMatch[0], body));
    }
    if (projectMatch && method === 'DELETE') {
      const body = await readJson(req);
      const project = db.getProject(projectMatch[0]);
      if (!project) return json(res, 404, { error: 'Project not found.' });
      if (body.confirmName !== project.name || body.confirmation !== 'DELETE PROJECT') {
        return json(res, 400, { error: 'Type the exact project name and DELETE PROJECT to remove its data.' });
      }
      if ([...activeTurns.values()].some((turn) => db.getThread(turn.threadId)?.projectId === project.id)) {
        return json(res, 409, { error: 'A story turn is active in this project. Wait for it to finish before deleting.' });
      }
      const counts = { threads: db.listThreads(project.id).length, branches: db.listBranches(project.id).length };
      db.deleteProject(project.id);
      return json(res, 200, { deleted: project.name, removed: counts });
    }
    const projectThreadsMatch = pathMatch(pathname, /^\/api\/projects\/([^/]+)\/threads$/);
    if (method === 'POST' && projectThreadsMatch) {
      const body = await readJson(req);
      const branch = db.listBranches(projectThreadsMatch[0]).find((entry) => entry.id === body.branchId);
      if (!branch) return json(res, 400, { error: 'Select a branch in this project.' });
      const thread = db.createThread(projectThreadsMatch[0], branch.id, body.title ?? 'New scene', body.sourceThreadId ?? null);
      return json(res, 201, { thread });
    }
    const threadGetMatch = pathMatch(pathname, /^\/api\/threads\/([^/]+)$/);
    if (threadGetMatch && method === 'GET') {
      const result = threadPayload(threadGetMatch[0]);
      return result ? json(res, 200, result) : json(res, 404, { error: 'Conversation not found.' });
    }
    const threadSnapshotMatch = pathMatch(pathname, /^\/api\/threads\/([^/]+)\/snapshot$/);
    if (threadSnapshotMatch && method === 'GET') {
      const result = threadPayload(threadSnapshotMatch[0], { includeTranscript: false });
      if (!result) return json(res, 404, { error: 'Conversation not found.' });
      const after = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) return json(res, 400, { error: 'Message cursor must be a non-negative integer.' });
      result.delta = db.getThreadMessagesAfter(threadSnapshotMatch[0], after);
      return json(res, 200, result);
    }
    const messageGetMatch = pathMatch(pathname, /^\/api\/messages\/([^/]+)$/);
    if (messageGetMatch && method === 'GET') {
      const message = db.getMessage(messageGetMatch[0]);
      if (!message) return json(res, 404, { error: 'Source message not found.' });
      return json(res, 200, { message, thread: db.getThread(message.threadId) });
    }
    const branchMatch = pathMatch(pathname, /^\/api\/threads\/([^/]+)\/branches$/);
    if (branchMatch && method === 'POST') {
      const body = await readJson(req);
      return json(res, 201, db.createBranch(branchMatch[0], body.name));
    }
    const sendMatch = pathMatch(pathname, /^\/api\/threads\/([^/]+)\/send$/);
    if (sendMatch && method === 'POST') {
      const body = await readJson(req);
      return sendMessage(sendMatch[0], body.content, res);
    }
    const cancelMatch = pathMatch(pathname, /^\/api\/threads\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const active = activeTurns.get(cancelMatch[0]);
      if (!active) return json(res, 200, { interrupted: false, message: 'No active story turn.' });
      active.cancelled = true;
      if (active.codexThreadId) await codexServer.interrupt(active.codexThreadId);
      return json(res, 200, { interrupted: true });
    }
    const retconMatch = pathMatch(pathname, /^\/api\/threads\/([^/]+)\/retcon$/);
    if (retconMatch && method === 'POST') {
      const body = await readJson(req);
      const thread = db.getThread(retconMatch[0]);
      if (!thread) return json(res, 404, { error: 'Conversation not found.' });
      if (typeof body.correction !== 'string' || !body.correction.trim()) return json(res, 400, { error: 'Write the corrected continuity record.' });
      const commandText = `/retcon ${String(body.ledgerItemId ?? '')} -- ${body.correction}`;
      const result = commands.process(thread.id, commandText);
      return json(res, 200, { ...result, continuity: threadPayload(thread.id).ledger });
    }
    if (method === 'GET' && pathname === '/api/search') {
      const projectId = url.searchParams.get('projectId');
      const branchId = url.searchParams.get('branchId');
      const query = url.searchParams.get('q') ?? '';
      const project = db.getProject(projectId);
      if (!project) return json(res, 404, { error: 'Project not found.' });
      const branch = db.listBranches(projectId).find((item) => item.id === branchId);
      if (!branch) return json(res, 400, { error: 'Select a branch in this project.' });
      const results = db.searchMessages(projectId, branchId, query, 60).map((message) => ({ ...message, thread: db.getThread(message.threadId) }));
      return json(res, 200, { query, results });
    }
    if (method === 'POST' && pathname === '/api/memory/retry') {
      const body = await readJson(req);
      const jobs = indexer.retry(body.projectId ?? null);
      const authState = await authorizationStatus();
      if (authState.state === 'connected' || authState.state === 'token_expired') {
        await ensureCodexConnected();
        void indexer.processRecent(30);
      }
      return json(res, 200, { jobs });
    }
    if (method === 'GET' && pathname === '/api/models') {
      await ensureCodexConnected();
      const models = safeModelList(await codexServer.listModels());
      return json(res, 200, {
        models,
        selectedModel: db.getSetting('model.selected', ''),
        reasoningEffort: db.getSetting('model.reasoning_effort', '')
      });
    }
    if (method === 'PATCH' && pathname === '/api/settings/app') {
      const body = await readJson(req);
      const theme = String(body.theme ?? '');
      if (!['system', 'light', 'dark'].includes(theme)) return json(res, 400, { error: 'Choose system, light, or dark appearance.' });
      db.setSetting('app.theme', theme);
      return json(res, 200, { theme });
    }
    if (method === 'GET' && pathname === '/api/updates') {
      try {
        return json(res, 200, await updateChecker({ currentVersion: APP_VERSION }));
      } catch (error) {
        return json(res, 502, { error: error.message || 'The update check failed.' });
      }
    }
    if (method === 'PATCH' && pathname === '/api/settings/model') {
      const body = await readJson(req);
      const model = String(body.model ?? '').trim();
      const reasoningEffort = body.reasoningEffort === undefined
        ? db.getSetting('model.reasoning_effort', '')
        : String(body.reasoningEffort ?? '').trim();
      let available = [];
      if (model || reasoningEffort) {
        await ensureCodexConnected();
        available = safeModelList(await codexServer.listModels());
        if (model && !available.some((entry) => entry.id === model)) return json(res, 400, { error: 'Select a model from the Codex catalog.' });
      }
      const effectiveModel = available.find((entry) => entry.id === model) ?? available.find((entry) => entry.isDefault);
      if (reasoningEffort && !effectiveModel?.reasoning.includes(reasoningEffort)) {
        return json(res, 400, { error: 'Choose a thinking level supported by the selected Codex model.' });
      }
      db.setSetting('model.selected', model);
      db.setSetting('model.reasoning_effort', reasoningEffort);
      return json(res, 200, { selectedModel: model, reasoningEffort });
    }
    if (method === 'POST' && pathname === '/api/app/shutdown') {
      if (activeTurns.size) return json(res, 409, { error: 'Wait for the active story response to finish before installing an update.' });
      json(res, 200, { stopping: true });
      const shutdownTimer = setTimeout(() => { void closeServer(); }, 150);
      shutdownTimer.unref?.();
      return;
    }
    if (method === 'GET' && pathname === '/api/auth') return json(res, 200, await authorizationStatus());
    if (method === 'POST' && pathname === '/api/auth/start') {
      const address = server.address();
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const attempt = authService.beginSignIn(redirectUri);
      const opened = authService.openBrowser(attempt.authorizationUrl);
      return json(res, 200, { state: 'signing_in', message: opened ? 'Complete Sign in with ChatGPT in your browser.' : 'The browser could not be opened automatically. Check local app settings.' });
    }
    if (method === 'POST' && pathname === '/api/auth/signout') {
      await codexServer.stop();
      delete codexServer.accessTokenFingerprint;
      const result = await authService.signOut();
      return json(res, 200, { ...result, authorization: await authorizationStatus(), codex: codexServer.getConnectionStatus() });
    }
    if (method === 'GET' && pathname === '/api/backup') {
      const backup = db.getBackup();
      return download(res, `timeless-sovereign-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2));
    }
    if (method === 'POST' && pathname === '/api/backup/restore') {
      const body = await readJson(req);
      if (body.confirmation !== 'RESTORE ALL') return json(res, 400, { error: 'Type RESTORE ALL to replace every local story project with this backup.' });
      await codexServer.stop();
      delete codexServer.accessTokenFingerprint;
      const beforePath = path.join(dataDirectory, 'backups', `before-restore-${Date.now()}.db`);
      fs.mkdirSync(path.dirname(beforePath), { recursive: true });
      db.createBackupFile(beforePath);
      const projects = db.restoreBackup(body.document);
      return json(res, 200, { projects, recoveryBackup: beforePath });
    }
    if (method === 'POST' && pathname === '/api/backup/snapshot') {
      const directory = path.join(dataDirectory, 'backups');
      fs.mkdirSync(directory, { recursive: true });
      const filename = `story-studio-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
      const fullPath = path.join(directory, filename);
      db.createBackupFile(fullPath);
      return json(res, 201, { filename, path: fullPath });
    }
    if (method === 'GET' && pathname === '/api/integrity') {
      return json(res, 200, { integrity: db.integrityCheck(), fts: db.hasFts, database: db.dbPath });
    }
    return json(res, 404, { error: 'That local app route was not found.' });
  }

  server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const address = server.address();
    const expectedHost = `127.0.0.1:${address?.port}`;
    const remote = req.socket.remoteAddress ?? '';
    if (req.headers.host !== expectedHost || !(remote === '127.0.0.1' || remote === '::ffff:127.0.0.1' || remote === '::1')) {
      return json(res, 403, { error: 'This app accepts connections only through its local 127.0.0.1 address.' });
    }
    let url;
    try { url = new URL(req.url ?? '/', `http://${expectedHost}`); }
    catch { return json(res, 400, { error: 'Invalid local request URL.' }); }
    if (url.pathname === '/auth/callback' && req.method === 'GET') {
      try {
        await authService.handleCallback(url.href);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('<!doctype html><meta charset="utf-8"><title>Connected</title><main style="font:16px system-ui;max-width:38rem;margin:4rem auto"><h1>Connected to ChatGPT</h1><p>Sign in completed. Return to The Timeless Sovereign Story Studio.</p><a href="/">Open Story Studio</a></main>');
      } catch (error) {
        if (typeof authService.recordFailure === 'function') authService.recordFailure(error);
        res.writeHead(error instanceof AuthError ? 400 : 500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Sign-in status</title><main style="font:16px system-ui;max-width:38rem;margin:4rem auto"><h1>Sign-in did not complete</h1><p>${htmlEscape(error.message)}</p><a href="/">Return to Story Studio</a></main>`);
      }
    }
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) {
        const origin = req.headers.origin;
        const expectedOrigin = `http://${expectedHost}`;
        if (origin !== expectedOrigin || req.headers['x-csrf-token'] !== csrfToken) {
          return json(res, 403, { error: 'Local request verification failed. Reload Story Studio and try again.' });
        }
      }
      try { await handleApi(req, res, url); }
      catch (error) {
        const status = Number.isInteger(error.status) ? error.status : error instanceof AuthError ? 400 : 500;
        return json(res, status, { error: String(error.message ?? 'The local request failed.').slice(0, 1000) });
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
    const files = new Map([
      ['/', ['index.html', 'text/html; charset=utf-8']],
      ['/index.html', ['index.html', 'text/html; charset=utf-8']],
      ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
      ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
    ]);
    const file = files.get(url.pathname);
    if (!file) return json(res, 404, { error: 'Page not found.' });
    const fullPath = path.join(PUBLIC_DIR, file[0]);
    if (!fs.existsSync(fullPath)) return json(res, 503, { error: 'Story Studio interface files are missing. Run the setup instructions.' });
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(fullPath));
  });

  return {
    server,
    database: db,
    auth: authService,
    codex: codexServer,
    indexer,
    async listen() {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, '127.0.0.1');
      });
      return server.address();
    },
    async close() { await closeServer(); }
  };
}

export async function startStoryStudio() {
  const port = Number.parseInt(process.env.STORY_STUDIO_PORT ?? '4317', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('STORY_STUDIO_PORT must be between 0 and 65535.');
  const app = createStoryStudioServer({ port, dataDirectory: process.env.STORY_STUDIO_DATA_DIR || defaultDataDirectory() });
  const address = await app.listen();
  const url = `http://127.0.0.1:${address.port}/`;
  process.stdout.write(`The Timeless Sovereign Story Studio is available at ${url}\n`);
  if (process.env.STORY_STUDIO_OPEN_BROWSER !== '0') app.auth.openBrowser(url);
  const close = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startStoryStudio().catch((error) => {
    process.stderr.write(`Story Studio could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
