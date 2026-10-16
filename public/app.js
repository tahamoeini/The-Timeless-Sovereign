const state = {
  csrfToken: '',
  projects: [],
  project: null,
  branches: [],
  threads: [],
  branch: null,
  thread: null,
  payload: null,
  authorization: { state: 'not_signed_in', message: 'Not connected.' },
  database: null,
  appSettings: { theme: 'system', reasoningEffort: '' },
  selectedModel: '',
  models: [],
  modelsLoaded: false,
  transcriptRevision: 0,
  appVersion: '1.1.0',
  view: 'narrative',
  sendBusy: false,
  activeAbort: null,
  pollTimer: null,
  searchTimer: null,
  importMode: 'archive',
  editMode: null,
  toastTimer: null,
  mobileSidebar: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
    headers.set('X-CSRF-Token', state.csrfToken);
  }
  const response = await fetch(url, { ...options, headers, cache: 'no-store' });
  if (!response.ok) {
    let message = `The local request failed (${response.status}).`;
    try { message = (await response.json()).error ?? message; } catch { /* keep default */ }
    throw new Error(message);
  }
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return response.json();
  return response;
}

function jsonBody(value) { return JSON.stringify(value); }

function applyTheme(theme) {
  const selected = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  state.appSettings.theme = selected;
  document.documentElement.dataset.theme = selected;
}

function showToast(message, duration = 3800) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('visible'), duration);
}

function showNotice(title, message) {
  $('#noticeTitle').textContent = title;
  $('#noticeText').textContent = message;
  $('#noticeDialog').showModal();
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog?.open) dialog.close();
}

function savedSelection() {
  return {
    projectId: localStorage.getItem('tss.project') ?? '',
    branchId: localStorage.getItem('tss.branch') ?? '',
    threadId: localStorage.getItem('tss.thread') ?? ''
  };
}

function saveSelection() {
  if (state.project) localStorage.setItem('tss.project', state.project.id);
  if (state.branch) localStorage.setItem('tss.branch', state.branch.id);
  if (state.thread) localStorage.setItem('tss.thread', state.thread.id);
  localStorage.setItem('tss.view', state.view);
}

async function initialize() {
  state.view = localStorage.getItem('tss.view') === 'transcript' ? 'transcript' : 'narrative';
  setView(state.view);
  try {
    const bootstrap = await api('/api/bootstrap');
    state.csrfToken = bootstrap.csrfToken;
    state.projects = bootstrap.projects;
    state.authorization = bootstrap.authorization;
    state.database = bootstrap.database;
    state.appSettings = bootstrap.appSettings ?? { theme: 'system' };
    state.selectedModel = bootstrap.selectedModel ?? '';
    state.appVersion = bootstrap.appVersion ?? '1.1.0';
    applyTheme(state.appSettings.theme);
    renderProjectList();
    $('#dbLocationLabel').textContent = 'SQLite · local to this PC';
    const selected = savedSelection();
    const project = state.projects.find((item) => item.id === selected.projectId) ?? state.projects[0];
    if (project) {
      await openProject(project.id, selected.branchId, selected.threadId);
    } else {
      showEmptyState();
    }
    await refreshConnection();
    setInterval(() => { void refreshConnection(); }, 12000);
  } catch (error) {
    showEmptyState();
    $('#composerStatus').textContent = 'The local story database could not be opened.';
    showNotice('Story Studio could not open', error.message);
  }
}

function showEmptyState() {
  state.project = null;
  state.branch = null;
  state.thread = null;
  state.payload = null;
  $('#activeProjectLabel').textContent = 'Choose a story';
  $('#activeBranchLabel').textContent = 'Main branch';
  $('#threadTitle').textContent = 'Begin a story';
  $('#threadSubline').textContent = 'Create a project to preserve a story across sessions.';
  $('#messageList').replaceChildren();
  $('#messageList').hidden = true;
  $('#emptyState').hidden = false;
  $('#composerInput').disabled = true;
  $('#sendButton').disabled = true;
  $('#composerStatus').textContent = 'Create a project, then connect with ChatGPT to begin.';
  $('#continuityEmpty').hidden = false;
  $('#continuityContent').hidden = true;
  stopPolling();
  renderConnection();
}

async function openProject(projectId, preferredBranchId = '', preferredThreadId = '') {
  if (!projectId) return showEmptyState();
  const structure = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  state.project = structure.project;
  state.branches = structure.branches;
  const branch = structure.branches.find((item) => item.id === preferredBranchId) ??
    structure.branches.find((item) => !item.parentBranchId) ?? structure.branches[0];
  state.branch = branch;
  state.threads = structure.threads.filter((item) => item.branchId === branch.id);
  let thread = state.threads.find((item) => item.id === preferredThreadId);
  if (!thread && state.threads.length) thread = state.threads[0];
  if (!thread) {
    const created = await api(`/api/projects/${encodeURIComponent(projectId)}/threads`, {
      method: 'POST', body: jsonBody({ branchId: branch.id, title: 'First conversation' })
    });
    thread = created.thread;
    state.threads = [thread];
  }
  await openThread(thread.id, false);
}

async function selectBranch(branchId) {
  if (!state.project) return;
  const structure = await api(`/api/projects/${encodeURIComponent(state.project.id)}`);
  state.project = structure.project;
  state.branches = structure.branches;
  state.threads = structure.threads;
  const branch = structure.branches.find((item) => item.id === branchId);
  if (!branch) return;
  const thread = structure.threads.find((item) => item.branchId === branch.id);
  if (thread) return openThread(thread.id);
  const created = await api(`/api/projects/${encodeURIComponent(state.project.id)}/threads`, {
    method: 'POST', body: jsonBody({ branchId: branch.id, title: 'New conversation' })
  });
  return openThread(created.thread.id);
}

async function openThread(threadId, preserveBranch = false) {
  const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`);
  state.payload = payload;
  state.transcriptRevision = payload.transcriptRevision ?? payload.transcript?.at(-1)?.sequence ?? 0;
  state.thread = payload.thread;
  state.project = payload.project;
  state.branch = payload.branches.find((item) => item.id === payload.thread.branchId) ?? null;
  state.branches = payload.branches;
  state.threads = payload.threads;
  if (!preserveBranch) saveSelection();
  renderWorkspace();
  startPolling();
}

async function refreshCurrentThread({ keepScroll = true } = {}) {
  if (!state.thread) return;
  const list = $('#messageList');
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const payload = await api(`/api/threads/${encodeURIComponent(state.thread.id)}/snapshot?after=${encodeURIComponent(state.transcriptRevision)}`);
  const transcript = state.payload?.transcript ?? [];
  const byId = new Map(transcript.map((message) => [message.id, message]));
  for (const message of payload.delta ?? []) byId.set(message.id, message);
  const updatedTranscript = [...byId.values()].sort((left, right) => left.sequence - right.sequence);
  const transcriptChanged = updatedTranscript.length !== transcript.length || (payload.delta?.length ?? 0) > 0;
  state.transcriptRevision = payload.transcriptRevision ?? state.transcriptRevision;
  state.payload = { ...payload, transcript: updatedTranscript };
  state.thread = payload.thread;
  state.project = payload.project;
  state.branch = payload.branches.find((item) => item.id === payload.thread.branchId) ?? state.branch;
  state.branches = payload.branches;
  state.threads = payload.threads;
  renderWorkspace({ renderTranscript: transcriptChanged });
  if (keepScroll && wasNearBottom) list.scrollTop = list.scrollHeight;
}

function renderWorkspace({ renderTranscript: shouldRenderTranscript = true } = {}) {
  if (!state.project || !state.thread || !state.payload) return showEmptyState();
  $('#emptyState').hidden = true;
  $('#messageList').hidden = false;
  $('#composerInput').disabled = false;
  $('#sendButton').disabled = !$('#composerInput').value.trim() || state.sendBusy;
  $('#activeProjectLabel').textContent = state.project.name;
  $('#activeBranchLabel').textContent = state.branch?.name ?? 'Branch';
  $('#threadTitle').textContent = state.thread.title;
  $('#threadSubline').textContent = `${state.thread.branchName} · ${state.payload.transcript.filter((m) => m.kind === 'story').length} saved story messages${state.thread.paused ? ' · paused' : ''}`;
  $('#composerStatus').textContent = state.thread.paused
    ? 'This chat is paused. Use /resume to continue.'
    : state.authorization.state === 'connected'
      ? 'Your turn is saved before it is sent to Codex.'
      : 'Your message will be saved locally; connect with ChatGPT to generate a story response.';
  renderProjectList();
  renderBranchSelect();
  renderThreads();
  if (shouldRenderTranscript) renderTranscript();
  renderContinuity();
  renderConnection();
  setView(state.view);
}

function renderProjectList() {
  const root = $('#projectList');
  root.replaceChildren();
  if (!state.projects.length) {
    const empty = document.createElement('div');
    empty.className = 'compact-empty';
    empty.style.padding = '10px 8px';
    empty.textContent = 'No projects yet';
    root.append(empty);
    return;
  }
  for (const project of state.projects) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `project-item${state.project?.id === project.id ? ' active' : ''}`;
    button.title = `${project.name} · ${project.threadCount} conversations`;
    const glyph = document.createElement('span');
    glyph.className = 'project-glyph';
    glyph.textContent = '✧';
    const name = document.createElement('span');
    name.textContent = project.name;
    button.append(glyph, name);
    button.addEventListener('click', () => {
      $('#sidebar')?.classList.remove('mobile-open');
      void openProject(project.id);
    });
    root.append(button);
  }
}

function renderBranchSelect() {
  const select = $('#branchSelect');
  const previous = state.branch?.id;
  select.replaceChildren();
  for (const branch of state.branches) {
    const option = document.createElement('option');
    option.value = branch.id;
    option.textContent = `${branch.name}${branch.parentBranchId ? ' · alternate' : ' · main'}`;
    select.append(option);
  }
  select.value = previous ?? '';
  select.disabled = !state.project;
}

function renderThreads() {
  const root = $('#threadList');
  root.replaceChildren();
  for (const thread of state.threads) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `thread-item${thread.id === state.thread?.id ? ' active' : ''}`;
    const symbol = document.createElement('span');
    symbol.className = 'thread-symbol';
    symbol.textContent = thread.id === state.thread?.id ? '◉' : '○';
    const label = document.createElement('span');
    label.className = 'thread-name';
    label.textContent = thread.title;
    if (thread.paused) {
      const paused = document.createElement('span');
      paused.className = 'paused-chip';
      paused.textContent = 'paused';
      label.append(paused);
    }
    button.append(symbol, label);
    button.addEventListener('click', () => void openThread(thread.id));
    root.append(button);
  }
  if (!state.threads.length) {
    const empty = document.createElement('div');
    empty.className = 'compact-empty';
    empty.style.padding = '9px';
    empty.textContent = 'No conversations on this branch yet.';
    root.append(empty);
  }
}

function isRtl(text) {
  return /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u.test(String(text ?? ''));
}

function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function paragraphKind(text) {
  const value = text.trim();
  return /^(?:[“"‘']|—\s|–\s|[\p{L}][^:\n]{0,36}:\s*[“"‘'])/u.test(value) ? 'dialogue' : 'narration';
}

function renderNarrative(text, messageId) {
  const fragment = document.createDocumentFragment();
  const chunks = String(text).split(/\n{2,}/);
  for (const chunk of chunks) {
    const p = document.createElement('p');
    p.className = `message-text narrative-part ${paragraphKind(chunk)}`;
    p.dir = isRtl(chunk) ? 'rtl' : 'auto';
    p.textContent = chunk;
    fragment.append(p);
  }
  return fragment;
}

function makeMessageCard(message) {
  const card = document.createElement('article');
  const cardKind = message.kind === 'command' ? (message.role === 'user' ? 'command' : 'command-result') : message.kind;
  card.className = `message-card ${message.role}${message.kind === 'status' ? ' status' : ''}${message.kind === 'command' ? ' command' : ''}${message.status === 'failed' || message.status === 'interrupted' ? ' failed' : ''}${message.inherited ? ' inherited' : ''}`;
  card.dataset.messageId = message.id;
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const role = document.createElement('span');
  role.className = 'message-role';
  role.textContent = message.kind === 'command'
    ? (message.role === 'user' ? 'Command' : 'Command result')
    : message.kind === 'status' ? 'Story Studio' : message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Narrator' : 'Note';
  meta.append(role);
  const date = document.createElement('span');
  date.className = 'message-date';
  date.textContent = shortTime(message.createdAt);
  meta.append(date);
  if (message.status !== 'complete') {
    const status = document.createElement('span');
    status.className = 'message-status';
    status.textContent = message.status;
    meta.append(status);
  }
  const idButton = document.createElement('button');
  idButton.type = 'button';
  idButton.className = 'message-id';
  idButton.textContent = `#${message.id.slice(0, 8)}`;
  idButton.title = `Copy source message ID ${message.id}`;
  idButton.addEventListener('click', () => copyText(message.id));
  meta.append(idButton);
  const body = document.createElement('div');
  body.className = 'message-body';
  if (message.role === 'assistant' && message.kind === 'story' && state.view === 'narrative') {
    body.append(renderNarrative(message.content, message.id));
  } else {
    const content = document.createElement('div');
    content.className = 'message-text';
    content.dir = isRtl(message.content) ? 'rtl' : 'auto';
    content.textContent = message.content;
    body.append(content);
  }
  card.append(meta, body);
  return card;
}

function renderTranscript() {
  const list = $('#messageList');
  const previousBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
  const messages = state.payload?.transcript ?? [];
  const fragment = document.createDocumentFragment();
  for (const message of messages) fragment.append(makeMessageCard(message));
  if (!messages.length && state.thread) {
    const empty = document.createElement('div');
    empty.className = 'thread-empty';
    const title = document.createElement('strong');
    title.textContent = 'Start a new chapter';
    const hint = document.createElement('span');
    hint.textContent = 'Your messages will stay saved in this conversation.';
    empty.append(title, hint);
    fragment.append(empty);
  }
  list.replaceChildren(fragment);
  list.classList.toggle('transcript-view', state.view === 'transcript');
  if (previousBottom < 100) list.scrollTop = list.scrollHeight;
}

function updateSavedMessage(message) {
  const existing = $(`[data-message-id="${CSS.escape(message.id)}"]`, $('#messageList'));
  if (existing) existing.replaceWith(makeMessageCard(message));
  else {
    $('#emptyState').hidden = true;
    $('#messageList').hidden = false;
    $('#messageList').append(makeMessageCard(message));
  }
}

function updateStreamedMessage(messageId, fullText, status = 'streaming') {
  let card = $(`[data-message-id="${CSS.escape(messageId)}"]`, $('#messageList'));
  if (!card) {
    const fallback = { id: messageId, role: 'assistant', kind: 'story', content: fullText, status, createdAt: new Date().toISOString() };
    updateSavedMessage(fallback);
    return;
  }
  card.classList.toggle('failed', status === 'failed' || status === 'interrupted');
  const statusNode = $('.message-status', card);
  if (status !== 'complete') {
    if (statusNode) statusNode.textContent = status;
    else {
      const label = document.createElement('span');
      label.className = 'message-status';
      label.textContent = status;
      $('.message-meta', card).append(label);
    }
  }
  const body = $('.message-body', card);
  body.replaceChildren();
  if (state.view === 'narrative') body.append(renderNarrative(fullText, messageId));
  else {
    const content = document.createElement('div');
    content.className = 'message-text';
    content.dir = isRtl(fullText) ? 'rtl' : 'auto';
    content.textContent = fullText;
    body.append(content);
  }
  $('#messageList').scrollTop = $('#messageList').scrollHeight;
}

function sourceButton(messageId, label = 'source') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-link';
  button.textContent = `${label} · ${messageId.slice(0, 8)}`;
  button.title = `Open source message ${messageId}`;
  button.addEventListener('click', () => void openSource(messageId));
  return button;
}

async function openSource(messageId) {
  const local = state.payload?.transcript.find((message) => message.id === messageId);
  if (local) {
    const element = $(`[data-message-id="${CSS.escape(messageId)}"]`, $('#messageList'));
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.classList.add('source-highlight');
    setTimeout(() => element?.classList.remove('source-highlight'), 1300);
    return;
  }
  try {
    const source = await api(`/api/messages/${encodeURIComponent(messageId)}`);
    if (source.thread?.id) {
      await openThread(source.thread.id);
      setTimeout(() => {
        const element = $(`[data-message-id="${CSS.escape(messageId)}"]`, $('#messageList'));
        element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element?.classList.add('source-highlight');
      }, 40);
    }
  } catch (error) { showToast(error.message); }
}

function appendSourceLine(root, item) {
  if (!item.sourceMessageIds?.length) return;
  const line = document.createElement('div');
  line.className = 'source-line';
  item.sourceMessageIds.slice(0, 3).forEach((id, index) => {
    if (index) line.append(document.createTextNode(' · '));
    line.append(sourceButton(id, 'source'));
  });
  root.append(line);
}

function compactItem(item) {
  const root = document.createElement('div');
  root.className = 'compact-item';
  const title = document.createElement('strong');
  title.textContent = item.subject;
  const content = document.createElement('p');
  content.textContent = item.content;
  root.append(title, content);
  appendSourceLine(root, item);
  return root;
}

function renderCompactList(root, items, emptyText) {
  root.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'compact-empty';
    empty.textContent = emptyText;
    root.append(empty);
    return;
  }
  for (const item of items) root.append(compactItem(item));
}

function ledgerCard(item, allowCorrection = true) {
  const root = document.createElement('article');
  root.className = `ledger-item${item.status === 'uncertain' ? ' uncertain' : ''}`;
  const header = document.createElement('div');
  header.className = 'ledger-title-row';
  const title = document.createElement('strong');
  title.textContent = item.subject;
  const tag = document.createElement('span');
  tag.className = 'ledger-tag';
  tag.textContent = item.status === 'uncertain' ? 'uncertain' : item.type;
  header.append(title, tag);
  const content = document.createElement('p');
  content.textContent = item.content;
  const meta = document.createElement('div');
  meta.className = 'ledger-meta';
  const origin = document.createElement('span');
  origin.textContent = `${item.origin.replaceAll('_', ' ')} · ${Math.round(item.confidence * 100)}% confidence`;
  const type = document.createElement('span');
  type.textContent = item.type;
  meta.append(origin, type);
  root.append(header, content, meta);
  appendSourceLine(root, item);
  if (allowCorrection && item.status !== 'superseded') {
    const actions = document.createElement('div');
    actions.className = 'ledger-actions';
    const correction = document.createElement('button');
    correction.type = 'button';
    correction.textContent = 'Correct this record';
    correction.addEventListener('click', () => openRetcon(item));
    actions.append(correction);
    root.append(actions);
  }
  return root;
}

function renderContinuity() {
  const payload = state.payload;
  if (!payload) {
    $('#continuityEmpty').hidden = false;
    $('#continuityContent').hidden = true;
    $('#memoryBadge').dataset.state = 'current';
    $('#memoryBadgeText').textContent = 'Memory ready';
    return;
  }
  $('#continuityEmpty').hidden = true;
  $('#continuityContent').hidden = false;
  const memory = payload.memory;
  const memoryBadge = $('#memoryBadge');
  memoryBadge.dataset.state = memory.state;
  const indexed = memory.lastIndexed ? ` · through ${memory.lastIndexed.id.slice(0, 8)}` : '';
  $('#memoryBadgeText').textContent = `${memory.state === 'current' ? 'Memory current' : `Memory ${memory.state}`}${indexed}`;
  $('#retryMemory').hidden = memory.state !== 'error' && memory.state !== 'pending';

  const ledger = payload.ledger ?? [];
  const current = ledger.filter((item) => item.effective && ['current', 'uncertain'].includes(item.status));
  const scene = current.find((item) => item.type === 'scene');
  $('#sceneContent').textContent = scene?.content ?? 'No source-backed scene state has been recorded yet.';
  const details = $('#sceneDetails');
  details.replaceChildren();
  if (scene) {
    for (const [key, value] of Object.entries(scene.details ?? {})) {
      if (!value || key === 'correctionOf') continue;
      const pill = document.createElement('span');
      pill.className = 'detail-pill';
      pill.textContent = `${key}: ${Array.isArray(value) ? value.join(', ') : value}`;
      details.append(pill);
    }
    const line = $('#sceneSource');
    line.replaceChildren();
    appendSourceLine(line, scene);
  } else {
    $('#sceneSource').replaceChildren();
  }
  const sceneEdit = $('#editScene');
  sceneEdit.textContent = scene ? 'Edit' : 'Set scene';
  sceneEdit.disabled = !payload.thread;
  renderCompactList($('#characterList'), current.filter((item) => item.type === 'character'), 'No character profiles yet. Add one or describe a character in the story.');
  renderCompactList($('#ruleList'), current.filter((item) => item.type === 'rule'), 'No powers or rules have been recorded.');
  renderCompactList($('#openThreadList'), current.filter((item) => (item.type === 'thread' || item.type === 'obligation') && ['current', 'uncertain'].includes(item.status)), 'No unresolved threads or obligations.');

  const visible = ledger.filter((item) => item.status !== 'superseded');
  const recordsRoot = $('#ledgerList');
  recordsRoot.replaceChildren();
  const sorted = visible.sort((a, b) => b.sourceSequence - a.sourceSequence).slice(0, 35);
  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'compact-empty';
    empty.textContent = 'Canon records appear here with confidence and source-message links.';
    recordsRoot.append(empty);
  } else for (const item of sorted) recordsRoot.append(ledgerCard(item));

  const history = $('#historyList');
  history.replaceChildren();
  const superseded = ledger.filter((item) => item.status === 'superseded').sort((a, b) => b.sourceSequence - a.sourceSequence);
  for (const item of superseded.slice(0, 20)) history.append(ledgerCard(item, false));
  for (const entry of (payload.projectHistory ?? []).filter((item) => item.action === 'project_updated')) {
    const record = document.createElement('article');
    record.className = 'ledger-item';
    const title = document.createElement('strong');
    title.textContent = 'Project instructions or preferences updated';
    const body = document.createElement('p');
    body.textContent = `Recorded ${shortTime(entry.createdAt)}. Previous and new values remain in project history.`;
    record.append(title, body);
    if (entry.sourceMessageId) appendSourceLine(record, { sourceMessageIds: [entry.sourceMessageId] });
    history.append(record);
  }
  if (!superseded.length && !payload.projectHistory?.length) {
    const empty = document.createElement('div');
    empty.className = 'compact-empty';
    empty.textContent = 'No corrections recorded.';
    history.append(empty);
  }
}

function renderConnection() {
  const stateName = state.authorization?.state ?? 'not_signed_in';
  const connected = stateName === 'connected';
  const label = connected ? 'ChatGPT connected' : stateName === 'signing_in' ? 'Finish sign-in' : 'Connect ChatGPT';
  $('#connectionButton').dataset.state = connected ? 'connected' : stateName;
  $('#connectionLabel').textContent = label;
  $('#settingsConnectionState').textContent = connected ? 'ChatGPT connected' : stateName.replaceAll('_', ' ');
  $('#settingsConnectionMessage').textContent = state.authorization?.message ?? 'Sign in with ChatGPT to enable story generation. No API key billing fallback is available.';
  $('#settingsConnect').hidden = connected;
  $('#settingsDisconnect').hidden = !connected;
  if (!state.sendBusy && state.thread) {
    $('#composerStatus').textContent = state.thread.paused
      ? 'This chat is paused. Use /resume to continue.'
      : connected ? 'Your turn is saved before it is sent to Codex.' : 'Your message will be saved locally; connect with ChatGPT to generate a story response.';
  }
}

function setView(view) {
  state.view = view === 'transcript' ? 'transcript' : 'narrative';
  $('#narrativeView').classList.toggle('active', state.view === 'narrative');
  $('#transcriptView').classList.toggle('active', state.view === 'transcript');
  if (state.payload) renderTranscript();
  localStorage.setItem('tss.view', state.view);
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (state.thread && !state.sendBusy) void refreshCurrentThread().catch(() => {});
  }, 6500);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function refreshConnection() {
  try {
    const authorization = await api('/api/auth');
    if (authorization.state !== state.authorization.state || authorization.message !== state.authorization.message) {
      state.authorization = authorization;
      renderConnection();
      if (authorization.state === 'connected') {
        showToast('ChatGPT is connected. Your next turn will start the local Codex app-server.');
        if ($('#settingsDialog').open) void loadModels();
      }
    }
  } catch { /* keep the last known local connection state */ }
}

function toggleCommandPalette(force) {
  const palette = $('#commandPalette');
  palette.hidden = force === undefined ? !palette.hidden : !force;
}

async function parseSse(response, onEvent) {
  if (!response.ok) {
    let error = `The local request failed (${response.status}).`;
    try { error = (await response.json()).error ?? error; } catch { /* default */ }
    throw new Error(error);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
      const data = /^data:\s*(.+)$/m.exec(block)?.[1];
      if (event && data) {
        try { onEvent(event, JSON.parse(data)); } catch (error) { console.error('Story event could not be rendered.', error); }
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
}

async function submitMessage(content = $('#composerInput').value) {
  if (!state.thread || state.sendBusy || !content.trim()) return;
  state.sendBusy = true;
  $('#composerInput').disabled = true;
  $('#sendButton').disabled = true;
  $('#cancelTurn').hidden = content.startsWith('/');
  $('#composerStatus').textContent = content.startsWith('/') ? 'Saving command locally…' : 'Saving your turn, then building story context…';
  $('#turnNotice').hidden = true;
  if (content === $('#composerInput').value) $('#composerInput').value = '';
  let assistantId = null;
  try {
    const response = await fetch(`/api/threads/${encodeURIComponent(state.thread.id)}/send`, {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: jsonBody({ content })
    });
    await parseSse(response, (event, data) => {
      if (event === 'saved') {
        updateSavedMessage(data.message);
        state.threadSubline = state.thread?.title;
        $('#messageList').scrollTop = $('#messageList').scrollHeight;
      } else if (event === 'assistant-saved') {
        assistantId = data.message.id;
        updateSavedMessage(data.message);
        const count = data.sources?.length ?? 0;
        $('#turnNotice').textContent = `Retrieved ${count} source message${count === 1 ? '' : 's'} and ${data.ledgerItems?.length ?? 0} continuity record${(data.ledgerItems?.length ?? 0) === 1 ? '' : 's'} for this response.`;
        $('#turnNotice').hidden = false;
        $('#composerStatus').textContent = 'Codex is continuing the story…';
        $('#cancelTurn').hidden = false;
      } else if (event === 'delta') {
        updateStreamedMessage(data.messageId, data.fullText, 'streaming');
      } else if (event === 'complete') {
        updateStreamedMessage(data.message.id, data.message.content, 'complete');
        state.payload && (state.payload.memory = data.memory);
        $('#composerStatus').textContent = 'Reply saved. Continuity indexing is running in the background.';
      } else if (event === 'activity') {
        // Non-story protocol activity is intentionally not shown as narrative.
      } else if (event === 'failure') {
        if (data.activity) updateSavedMessage(data.activity);
        $('#composerStatus').textContent = data.message;
        $('#turnNotice').textContent = data.message;
        $('#turnNotice').hidden = false;
      }
    });
  } catch (error) {
    showToast(error.message, 5500);
    $('#composerStatus').textContent = 'Your saved conversation can be reloaded. Check the connection and retry.';
  } finally {
    state.sendBusy = false;
    $('#composerInput').disabled = !state.thread;
    $('#cancelTurn').hidden = true;
    $('#sendButton').disabled = !$('#composerInput').value.trim() || !state.thread;
    if (state.thread) await refreshCurrentThread().catch(() => {});
  }
}

function openProjectDialog() {
  $('#projectForm').reset();
  $('#projectDialog').showModal();
  $('#projectName').focus();
}

function openSettings() {
  const project = state.project;
  $('#settingsProjectName').value = project?.name ?? '';
  $('#settingsProjectInstructions').value = project?.instructions ?? '';
  $('#settingsProjectStyle').value = project?.style ?? '';
  $('#memoryScopeSelect').value = project?.memoryScope === 'thread' ? 'thread' : 'project';
  $('#themeSelect').value = state.appSettings.theme;
  state.modelsLoaded = false;
  $('#modelSelect').replaceChildren(new Option(state.selectedModel ? `${state.selectedModel} · connect to change` : 'Connect with ChatGPT to choose a model', state.selectedModel));
  $('#modelSelect').value = state.selectedModel;
  $('#modelSelect').disabled = true;
  $('#reasoningEffortSelect').disabled = true;
  $('#reasoningEffortSelect').replaceChildren(new Option('Connect to load model options', ''));
  $('#updateStatus').textContent = `Version ${state.appVersion} · updates checked manually`;
  $('#updateDownload').hidden = true;
  $('#updateDetails').hidden = true;
  for (const id of ['settingsProjectName', 'settingsProjectInstructions', 'settingsProjectStyle', 'saveSettings', 'exportProject', 'deleteProject']) {
    const element = document.getElementById(id);
    if (element) element.disabled = !project;
  }
  $('#settingsStorageLocation').textContent = state.database?.location
    ? `SQLite story data: ${state.database.location}. ChatGPT credentials are stored separately with Windows user protection.`
    : 'Story data is stored in a local SQLite database.';
  $('#integrityStatus').textContent = state.database?.integrity?.every((item) => item === 'ok')
    ? 'Database integrity check: OK'
    : 'Database integrity needs attention.';
  $('#settingsDialog').showModal();
  renderConnection();
  if (state.authorization.state === 'connected') void loadModels();
}

async function loadModels() {
  const select = $('#modelSelect');
  try {
    const { models, selectedModel, reasoningEffort } = await api('/api/models');
    select.replaceChildren();
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Use the Codex default';
    select.append(defaultOption);
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      select.append(option);
    }
    select.value = selectedModel ?? '';
    state.models = models;
    state.selectedModel = selectedModel ?? '';
    state.appSettings.reasoningEffort = reasoningEffort ?? '';
    state.modelsLoaded = true;
    select.disabled = false;
    renderReasoningOptions(state.appSettings.reasoningEffort);
  } catch (error) {
    if (error.message) showToast(error.message);
    select.replaceChildren(new Option('Codex model catalog unavailable', ''));
    select.disabled = true;
    $('#reasoningEffortSelect').replaceChildren(new Option('Model options unavailable', ''));
    $('#reasoningEffortSelect').disabled = true;
  }
}

function renderReasoningOptions(preferred = '') {
  const select = $('#reasoningEffortSelect');
  const selected = state.models.find((model) => model.id === $('#modelSelect').value) ?? state.models.find((model) => model.isDefault);
  select.replaceChildren();
  if (!selected) {
    select.append(new Option('No default model is available', ''));
    select.disabled = true;
    $('#reasoningEffortHelp').textContent = 'Connect with ChatGPT to load the current model catalog.';
    return;
  }
  const defaultEffort = selected.defaultReasoningEffort;
  select.append(new Option(defaultEffort ? `Use model default (${defaultEffort})` : 'Use model default', ''));
  for (const effort of selected.reasoning) select.append(new Option(effort, effort));
  select.value = selected.reasoning.includes(preferred) ? preferred : '';
  select.disabled = !selected.reasoning.length;
  $('#reasoningEffortHelp').textContent = preferred && !selected.reasoning.includes(preferred)
    ? `${selected.name} does not offer the saved level. Its model default will be used.`
    : 'Only levels advertised for the selected model are shown.';
}

function openImportDialog(mode) {
  state.importMode = mode;
  $('#importForm').reset();
  const projectMode = mode === 'project';
  $('#importTitle').textContent = projectMode ? 'Import a story project' : 'Import a chat archive';
  $('#importHelp').textContent = projectMode
    ? 'Import a Story Studio project export, or choose a ChatGPT conversation JSON to create a new project from its saved messages.'
    : 'Import a Markdown or ChatGPT JSON archive. The original file and saved messages are retained in the selected project.';
  $('#archiveProjectLabel').hidden = projectMode;
  $('#importFile').accept = projectMode ? '.json,application/json' : '.md,.json,text/markdown,text/plain,application/json';
  const select = $('#archiveProjectSelect');
  select.replaceChildren();
  for (const project of state.projects) {
    const option = new Option(project.name, project.id);
    if (project.id === state.project?.id) option.selected = true;
    select.append(option);
  }
  $('#importDialog').showModal();
}

function openEditDialog({ mode, title, help, fields, eyebrow = 'CONTINUITY' }) {
  state.editMode = mode;
  $('#editEyebrow').textContent = eyebrow;
  $('#editTitle').textContent = title;
  $('#editHelp').textContent = help;
  const root = $('#editFields');
  root.replaceChildren();
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = field.multiline ? document.createElement('textarea') : document.createElement('input');
    input.name = field.name;
    input.value = field.value ?? '';
    input.placeholder = field.placeholder ?? '';
    if (field.multiline) input.rows = field.rows ?? 3;
    label.append(input);
    root.append(label);
  }
  $('#editForm').showModal();
}

function openEditScene() {
  const scene = state.payload?.ledger.find((item) => item.type === 'scene' && item.effective);
  const details = scene?.details ?? {};
  openEditDialog({
    mode: 'scene', title: scene ? 'Update current scene' : 'Set current scene',
    help: 'This saves a source-linked canon update on the selected branch without advancing the story.',
    fields: [
      { name: 'location', label: 'Location', value: details.location ?? '' },
      { name: 'time', label: 'In-world date or time', value: details.time ?? '' },
      { name: 'participants', label: 'Participants', value: Array.isArray(details.participants) ? details.participants.join(', ') : details.participants ?? '' },
      { name: 'conditions', label: 'Active conditions', value: Array.isArray(details.conditions) ? details.conditions.join(', ') : details.conditions ?? '', multiline: true }
    ]
  });
}

function openAddCharacter(item = null) {
  const details = item?.details ?? {};
  const fields = [
    { name: 'name', label: 'Character name', value: item?.subject ?? '', placeholder: 'Character name' },
    { name: 'aliases', label: 'Aliases', value: Array.isArray(details.aliases) ? details.aliases.join(', ') : details.aliases ?? '', placeholder: 'Comma-separated, if any' },
    { name: 'role', label: 'Role', value: details.role ?? '' },
    { name: 'location', label: 'Current location', value: details.location ?? '' },
    { name: 'goals', label: 'Goals', value: details.goals ?? '', multiline: true },
    { name: 'condition', label: 'Current condition', value: details.condition ?? '' },
    { name: 'knowledge', label: 'What this character knows', value: details.knowledge ?? '', multiline: true },
    { name: 'injuries', label: 'Injuries', value: details.injuries ?? '' },
    { name: 'possessions', label: 'Possessions', value: details.possessions ?? '' },
    { name: 'relationships', label: 'Relationships', value: details.relationships ?? '', multiline: true },
    { name: 'secrets', label: 'Secrets or private information', value: details.secrets ?? '', multiline: true }
  ];
  openEditDialog({
    mode: item ? 'character-set' : 'character-add', title: item ? `Update ${item.subject}` : 'Add a character',
    help: 'This profile is a user-established continuity record. Character knowledge is tracked separately from objective events.', fields
  });
}

function openRetcon(item) {
  openEditDialog({
    mode: `retcon:${item.id}`, title: `Correct “${item.subject}”`,
    help: `The current record and its source will remain in the audit history. Your correction becomes a new source-linked record on the ${state.branch.name} branch.`,
    fields: [{ name: 'correction', label: 'Corrected canon', value: item.content, multiline: true, rows: 6 }], eyebrow: 'AUDITABLE CORRECTION'
  });
}

function quoteValue(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function submitEdit(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const mode = state.editMode;
  try {
    let command;
    if (mode === 'scene') {
      const fields = ['location', 'time', 'participants', 'conditions'].filter((key) => String(data[key] ?? '').trim());
      if (!fields.length) throw new Error('Enter at least one scene field.');
      command = `/scene set ${fields.map((key) => `${key}=${quoteValue(data[key])}`).join(' ')}`;
    } else if (mode === 'character-add' || mode === 'character-set') {
      const name = String(data.name ?? '').trim();
      if (!name) throw new Error('A character name is required.');
      const fields = Object.keys(data).filter((key) => key !== 'name' && String(data[key] ?? '').trim());
      if (mode === 'character-add' && !fields.length) throw new Error('Add at least one profile field.');
      command = `/character ${mode === 'character-add' ? 'add' : 'set'} ${quoteValue(name)} ${fields.map((key) => `${key}=${quoteValue(data[key])}`).join(' ')}`.trim();
    } else if (String(mode).startsWith('retcon:')) {
      const correction = String(data.correction ?? '').trim();
      if (!correction) throw new Error('Write the corrected continuity record.');
      await api(`/api/threads/${encodeURIComponent(state.thread.id)}/retcon`, {
        method: 'POST', body: jsonBody({ ledgerItemId: mode.slice(6), correction })
      });
      closeDialog('editDialog');
      await refreshCurrentThread();
      showToast('Correction saved with its source and audit history.');
      return;
    }
    closeDialog('editDialog');
    await submitMessage(command);
  } catch (error) { showToast(error.message, 5500); }
}

function openDeleteDialog() {
  if (!state.project) return;
  const threads = state.projects.find((item) => item.id === state.project.id)?.threadCount ?? state.threads.length;
  $('#deleteDescription').textContent = `This removes “${state.project.name}” and its ${threads} conversation${threads === 1 ? '' : 's'}, every branch and saved message, source-linked ledger records, correction history, checkpoints, and imported archives from the local database. Other projects and the ChatGPT connection are not removed.`;
  $('#deleteName').value = '';
  $('#deletePhrase').value = '';
  $('#deleteDialog').showModal();
}

async function runSearch() {
  clearTimeout(state.searchTimer);
  const query = $('#searchInput').value.trim();
  if (!query || !state.project || !state.branch) {
    $('#searchResults').innerHTML = '<div class="search-placeholder">Search the complete saved conversation on the selected branch.</div>';
    return;
  }
  try {
    const data = await api(`/api/search?projectId=${encodeURIComponent(state.project.id)}&branchId=${encodeURIComponent(state.branch.id)}&q=${encodeURIComponent(query)}`);
    const root = $('#searchResults');
    root.replaceChildren();
    if (!data.results.length) {
      const empty = document.createElement('div');
      empty.className = 'search-placeholder';
      empty.textContent = 'No saved messages matched that search.';
      root.append(empty);
    }
    for (const result of data.results) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      const head = document.createElement('div');
      head.className = 'search-result-head';
      const label = document.createElement('span');
      label.textContent = `${result.thread?.title ?? 'Conversation'} · ${result.role} · ${shortTime(result.createdAt)}`;
      const id = document.createElement('span');
      id.textContent = `#${result.id.slice(0, 8)}`;
      head.append(label, id);
      const body = document.createElement('div');
      body.className = 'search-result-body';
      const index = result.content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      const start = Math.max(0, index - 110);
      body.textContent = `${start ? '…' : ''}${result.content.slice(start, start + 380)}${result.content.length > start + 380 ? '…' : ''}`;
      body.dir = isRtl(body.textContent) ? 'rtl' : 'auto';
      button.append(head, body);
      button.addEventListener('click', async () => {
        closeDialog('searchDialog');
        await openThread(result.threadId);
        setTimeout(() => {
          const source = $(`[data-message-id="${CSS.escape(result.id)}"]`, $('#messageList'));
          source?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          source?.classList.add('source-highlight');
        }, 50);
      });
      root.append(button);
    }
  } catch (error) { showToast(error.message); }
}

async function downloadResponse(url, fallbackName) {
  const response = await api(url);
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

async function startSignIn() {
  try {
    const result = await api('/api/auth/start', { method: 'POST', body: jsonBody({}) });
    state.authorization = { state: result.state, message: result.message };
    renderConnection();
    showToast('Complete Sign in with ChatGPT in the browser window.');
  } catch (error) { showNotice('Sign-in could not start', error.message); }
}

async function submitImport(event) {
  event.preventDefault();
  const file = $('#importFile').files?.[0];
  if (!file) return showToast('Choose a file to import.');
  try {
    const content = await file.text();
    if (state.importMode === 'project') {
      const document = JSON.parse(content);
      const result = await api('/api/projects/import', {
        method: 'POST', body: jsonBody({ document, fileName: file.name, rawContent: content })
      });
      state.projects = await api('/api/bootstrap').then((data) => { state.csrfToken = data.csrfToken; state.projects = data.projects; return data.projects; });
      closeDialog('importDialog');
      renderProjectList();
      await openProject(result.project.id, '', result.thread?.id ?? '');
      showToast(result.archiveImported
        ? `Imported ${result.importedTurns} turns from ${file.name} into a new project.`
        : `Imported ${result.project.name}.`);
    } else {
      const projectId = $('#archiveProjectSelect').value;
      if (!projectId) throw new Error('Create a project before importing a chat archive.');
      const result = await api(`/api/projects/${encodeURIComponent(projectId)}/archive`, {
        method: 'POST', body: jsonBody({ fileName: file.name, content })
      });
      closeDialog('importDialog');
      await refreshProjects();
      await openProject(projectId, '', result.thread.id);
      showToast(`Imported ${result.importedTurns} saved turns. ${result.message}`);
    }
  } catch (error) { showNotice('Import could not be completed', error.message); }
}

async function refreshProjects() {
  const data = await api('/api/bootstrap');
  state.csrfToken = data.csrfToken;
  state.projects = data.projects;
  state.database = data.database;
  renderProjectList();
}

async function restoreBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const document = JSON.parse(await file.text());
      if (document.format !== 'timeless-sovereign-backup') throw new Error('Choose a complete Story Studio backup JSON file.');
      const confirmation = window.prompt(`This replaces all ${state.projects.length} local projects. The app first makes a recovery copy of the current SQLite database. Type RESTORE ALL to continue.`);
      if (confirmation !== 'RESTORE ALL') return;
      const result = await api('/api/backup/restore', { method: 'POST', body: jsonBody({ document, confirmation }) });
      state.projects = result.projects;
      await refreshProjects();
      if (state.projects.length) await openProject(state.projects[0].id);
      else showEmptyState();
      closeDialog('settingsDialog');
      showNotice('Backup restored', `All local story projects were restored. A pre-restore recovery database was saved at ${result.recoveryBackup}.`);
    } catch (error) { showNotice('Backup could not be restored', error.message); }
  }, { once: true });
  input.click();
}

async function retryMemory() {
  if (!state.project) return;
  try {
    await api('/api/memory/retry', { method: 'POST', body: jsonBody({ projectId: state.project.id }) });
    await refreshCurrentThread();
    showToast(state.authorization.state === 'connected'
      ? 'Pending memory records were queued for processing.'
      : 'Memory jobs are saved as pending. Connect with ChatGPT to process them.');
  } catch (error) { showToast(error.message); }
}

function commandClick(command) {
  $('#composerInput').value = command;
  $('#composerInput').focus();
  $('#sendButton').disabled = !state.thread;
  toggleCommandPalette(false);
}

async function createNewProject(event) {
  event.preventDefault();
  const name = $('#projectName').value.trim();
  if (!name) return;
  try {
    const result = await api('/api/projects', { method: 'POST', body: jsonBody({ name, instructions: $('#projectInstructions').value }) });
    closeDialog('projectDialog');
    await refreshProjects();
    await openProject(result.project.id, result.branch.id, result.thread.id);
    $('#composerInput').focus();
    showToast('Project created. Its story and canon are stored locally.');
  } catch (error) { showToast(error.message); }
}

async function createThread() {
  if (!state.project || !state.branch) return;
  const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const count = state.threads.length + 1;
  const title = count === 1 ? `Conversation · ${date}` : `Scene ${count} · ${date}`;
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/threads`, {
      method: 'POST', body: jsonBody({ branchId: state.branch.id, title })
    });
    await openThread(result.thread.id);
    $('#composerInput').focus();
    showToast('New chat created on this branch. Project canon remains available.');
  } catch (error) { showToast(error.message); }
}

async function createBranch() {
  if (!state.thread) return showToast('Open a conversation first.');
  const name = window.prompt('Name this alternate timeline. It begins at the current saved message.');
  if (!name?.trim()) return;
  try {
    const result = await api(`/api/threads/${encodeURIComponent(state.thread.id)}/branches`, { method: 'POST', body: jsonBody({ name }) });
    await openThread(result.thread.id);
    showToast(`Alternate branch “${result.branch.name}” created. Its events stay separate from the main timeline.`);
  } catch (error) { showToast(error.message); }
}

async function deleteProject(event) {
  event.preventDefault();
  if (!state.project) return;
  const deletedName = state.project.name;
  try {
    await api(`/api/projects/${encodeURIComponent(state.project.id)}`, {
      method: 'DELETE', body: jsonBody({ confirmName: $('#deleteName').value, confirmation: $('#deletePhrase').value })
    });
    closeDialog('deleteDialog');
    closeDialog('settingsDialog');
    await refreshProjects();
    if (state.projects.length) await openProject(state.projects[0].id);
    else showEmptyState();
    showToast(`Project ${deletedName} and its local story data were removed.`);
  } catch (error) { showNotice('Project was not deleted', error.message); }
}

async function saveSettings() {
  if (!state.project) return;
  try {
    const project = await api(`/api/projects/${encodeURIComponent(state.project.id)}`, {
      method: 'PATCH', body: jsonBody({
        name: $('#settingsProjectName').value,
        instructions: $('#settingsProjectInstructions').value,
        style: $('#settingsProjectStyle').value,
        memoryScope: $('#memoryScopeSelect').value
      })
    });
    state.project = project;
    if (state.modelsLoaded) {
      const model = await api('/api/settings/model', {
        method: 'PATCH',
        body: jsonBody({ model: $('#modelSelect').value, reasoningEffort: $('#reasoningEffortSelect').value })
      });
      state.selectedModel = model.selectedModel;
      state.appSettings.reasoningEffort = model.reasoningEffort;
    }
    await refreshProjects();
    await refreshCurrentThread();
    showToast('Project instructions, memory scope, style, and model preferences saved.');
  } catch (error) { showNotice('Settings were not saved', error.message); }
}

async function saveAppearance() {
  try {
    const result = await api('/api/settings/app', {
      method: 'PATCH', body: jsonBody({ theme: $('#themeSelect').value })
    });
    applyTheme(result.theme);
    showToast('Appearance saved in your local Story Studio database.');
  } catch (error) { showNotice('Appearance was not saved', error.message); }
}

async function checkForUpdates() {
  const button = $('#checkUpdates');
  const status = $('#updateStatus');
  button.disabled = true;
  status.textContent = 'Checking the public GitHub release feed…';
  $('#updateDownload').hidden = true;
  $('#updateDetails').hidden = true;
  try {
    const update = await api('/api/updates');
    status.textContent = update.state === 'update_available'
      ? `Version ${update.latestVersion} is available. Close Story Studio and run the installer to update; your story data stays in place.`
      : update.state === 'up_to_date'
        ? `Story Studio ${update.currentVersion} is up to date.`
        : update.message;
    if (update.updateAvailable && update.downloadUrl) {
      const link = $('#updateDownload');
      link.href = update.downloadUrl;
      link.hidden = false;
      if (update.notes) {
        $('#updateNotes').textContent = update.notes;
        $('#updateDigest').textContent = update.sha256 ? `Installer SHA-256: ${update.sha256}` : 'This release does not publish an installer SHA-256 digest.';
        $('#updateDetails').hidden = false;
      }
    }
  } catch (error) {
    status.textContent = `Update check failed: ${error.message}`;
  } finally { button.disabled = false; }
}

async function cancelCurrentTurn() {
  if (!state.thread) return;
  $('#cancelTurn').disabled = true;
  try {
    await api(`/api/threads/${encodeURIComponent(state.thread.id)}/cancel`, { method: 'POST', body: jsonBody({}) });
  } catch (error) { showToast(error.message); }
  finally { $('#cancelTurn').disabled = false; }
}

function copyText(value) {
  if (!navigator.clipboard) return showToast(value);
  navigator.clipboard.writeText(value).then(() => showToast('Source ID copied.')).catch(() => showToast(value));
}

function bindEvents() {
  $('#createProject').addEventListener('click', openProjectDialog);
  $('#emptyCreateProject').addEventListener('click', openProjectDialog);
  $('#projectForm').addEventListener('submit', createNewProject);
  $('#settingsOpen').addEventListener('click', openSettings);
  $('#connectionButton').addEventListener('click', () => state.authorization.state === 'connected' ? openSettings() : void startSignIn());
  $('#settingsConnect').addEventListener('click', () => void startSignIn());
  $('#settingsDisconnect').addEventListener('click', async () => {
    if (!window.confirm('Disconnect this ChatGPT authorization and remove the locally protected credentials? Your story projects will remain saved.')) return;
    try {
      const result = await api('/api/auth/signout', { method: 'POST', body: jsonBody({}) });
      state.authorization = result.authorization;
      renderConnection();
      showToast('ChatGPT was disconnected. Local story data remains saved.');
    } catch (error) { showToast(error.message); }
  });
  $('#narrativeView').addEventListener('click', () => setView('narrative'));
  $('#transcriptView').addEventListener('click', () => setView('transcript'));
  $('#composerInput').addEventListener('input', () => {
    $('#sendButton').disabled = !$('#composerInput').value.trim() || state.sendBusy || !state.thread;
    if ($('#composerInput').value === '/') toggleCommandPalette(true);
  });
  $('#composerInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#composerForm').requestSubmit();
    }
    if (event.key === 'Escape') toggleCommandPalette(false);
  });
  $('#composerForm').addEventListener('submit', (event) => { event.preventDefault(); void submitMessage(); });
  $('#cancelTurn').addEventListener('click', () => void cancelCurrentTurn());
  $('#commandToggle').addEventListener('click', () => toggleCommandPalette());
  $$('#commandPalette [data-command]').forEach((button) => button.addEventListener('click', () => commandClick(button.dataset.command)));
  $('#branchSelect').addEventListener('change', (event) => {
    void selectBranch(event.target.value).catch((error) => showToast(error.message));
  });
  $('#createThread').addEventListener('click', () => void createThread());
  $('#createBranch').addEventListener('click', () => void createBranch());
  $('#archiveImportButton').addEventListener('click', () => openImportDialog('archive'));
  $('#importProjectButton').addEventListener('click', () => openImportDialog('project'));
  $('#importForm').addEventListener('submit', submitImport);
  $('#refreshContinuity').addEventListener('click', () => void refreshCurrentThread().catch((error) => showToast(error.message)));
  $('#retryMemory').addEventListener('click', () => void retryMemory());
  $('#editScene').addEventListener('click', openEditScene);
  $('#addCharacter').addEventListener('click', () => openAddCharacter());
  $('#editForm').addEventListener('submit', submitEdit);
  $('#searchOpen').addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#searchResults').innerHTML = '<div class="search-placeholder">Search the complete saved conversation on the selected branch.</div>';
    $('#searchDialog').showModal();
    $('#searchInput').focus();
  });
  $('#searchInput').addEventListener('input', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => void runSearch(), 230); });
  $('#searchForm').addEventListener('submit', (event) => { event.preventDefault(); void runSearch(); });
  $('#saveSettings').addEventListener('click', () => void saveSettings());
  $('#saveAppearance').addEventListener('click', () => void saveAppearance());
  $('#modelSelect').addEventListener('change', () => renderReasoningOptions(state.appSettings.reasoningEffort));
  $('#checkUpdates').addEventListener('click', () => void checkForUpdates());
  $('#exportProject').addEventListener('click', async () => {
    try { await downloadResponse(`/api/projects/${encodeURIComponent(state.project.id)}/export`, 'story.story.json'); }
    catch (error) { showToast(error.message); }
  });
  $('#backupButton').addEventListener('click', async () => {
    try {
      const result = await api('/api/backup/snapshot', { method: 'POST', body: jsonBody({}) });
      showNotice('Local backup created', `A SQLite backup of all story projects was saved at ${result.path}.`);
    } catch (error) { showNotice('Backup could not be created', error.message); }
  });
  $('#restoreButton').addEventListener('click', () => void restoreBackup());
  $('#deleteProject').addEventListener('click', openDeleteDialog);
  $('#deleteForm').addEventListener('submit', deleteProject);
  $('#settingsForm').addEventListener('submit', (event) => event.preventDefault());
  $('#commandToggle').title = 'Open the app command palette';
  $('#mobileNav').addEventListener('click', () => {
    state.mobileSidebar = !state.mobileSidebar;
    $('#projectList').closest('.sidebar').classList.toggle('mobile-open', state.mobileSidebar);
  });
  $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.close)));
  for (const dialog of $$('dialog')) dialog.addEventListener('click', (event) => {
    if (event.target === dialog && dialog.id !== 'deleteDialog') dialog.close();
  });
  $('#downloadBackupButton').addEventListener('click', async () => {
    try { await downloadResponse('/api/backup', 'timeless-sovereign-backup.json'); }
    catch (error) { showToast(error.message); }
  });
}

bindEvents();
void initialize();
