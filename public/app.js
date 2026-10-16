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
  cursorVersion: 2,
  appVersion: '1.3.1',
  view: 'narrative',
  sendingThreads: new Set(),
  pollTimer: null,
  searchTimer: null,
  searchRequestSequence: 0,
  draftTimer: null,
  navigationSequence: 0,
  snapshotSequence: 0,
  contextInspector: null,
  backupStatus: null,
  importMode: 'archive',
  editMode: null,
  toastTimer: null,
  mobileSidebar: false,
  pendingDeleteChat: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const markdownEditors = new WeakMap();
let markdownEditorSequence = 0;

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

async function saveDraftNow(threadId = state.thread?.id) {
  clearTimeout(state.draftTimer);
  state.draftTimer = null;
  if (!threadId) return true;
  const content = threadId === state.thread?.id ? $('#composerInput').value : state.payload?.draft?.content ?? '';
  try {
    const draft = await api(`/api/threads/${encodeURIComponent(threadId)}/draft`, {
      method: 'POST', body: jsonBody({ content })
    });
    if (state.thread?.id === threadId && state.payload) state.payload.draft = draft;
    return true;
  } catch (error) {
    showToast(`Draft could not be saved: ${error.message}`, 5500);
    return false;
  }
}

function scheduleDraftSave() {
  clearTimeout(state.draftTimer);
  const threadId = state.thread?.id;
  if (!threadId) return;
  state.draftTimer = setTimeout(() => {
    if (state.thread?.id === threadId) void saveDraftNow(threadId);
  }, 450);
}

async function clearDraftAfterAcknowledgement(threadId) {
  try {
    await api(`/api/threads/${encodeURIComponent(threadId)}/draft`, { method: 'DELETE' });
    if (state.thread?.id === threadId && state.payload) state.payload.draft = { content: '', updatedAt: null };
  } catch (error) {
    showToast(`The saved message is safe, but its draft could not be cleared: ${error.message}`, 5500);
  }
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
    state.backupStatus = bootstrap.backupStatus ?? null;
    state.appSettings = bootstrap.appSettings ?? { theme: 'system' };
    state.selectedModel = bootstrap.selectedModel ?? '';
    state.appVersion = bootstrap.appVersion ?? '1.3.1';
    applyTheme(state.appSettings.theme);
    renderBackupStatus(state.backupStatus);
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
  state.navigationSequence += 1;
  clearTimeout(state.draftTimer);
  state.draftTimer = null;
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
  setTextareaValue($('#composerInput'), '');
  $('#sendButton').disabled = true;
  $('#composerStatus').textContent = 'Create a project, then connect with ChatGPT to begin.';
  $('#continuityEmpty').hidden = false;
  $('#continuityContent').hidden = true;
  stopPolling();
  renderConnection();
}

async function openProject(projectId, preferredBranchId = '', preferredThreadId = '') {
  if (!projectId) return showEmptyState();
  const navigation = ++state.navigationSequence;
  if (state.thread && !(await saveDraftNow(state.thread.id))) return;
  const structure = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  if (navigation !== state.navigationSequence) return;
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
  await openThread(thread.id, false, navigation);
}

async function selectBranch(branchId) {
  if (!state.project) return;
  const navigation = ++state.navigationSequence;
  if (state.thread && !(await saveDraftNow(state.thread.id))) return;
  const structure = await api(`/api/projects/${encodeURIComponent(state.project.id)}`);
  if (navigation !== state.navigationSequence) return;
  state.project = structure.project;
  state.branches = structure.branches;
  state.threads = structure.threads;
  const branch = structure.branches.find((item) => item.id === branchId);
  if (!branch) return;
  const thread = structure.threads.find((item) => item.branchId === branch.id);
  if (thread) return openThread(thread.id, false, navigation);
  const created = await api(`/api/projects/${encodeURIComponent(state.project.id)}/threads`, {
    method: 'POST', body: jsonBody({ branchId: branch.id, title: 'New conversation' })
  });
  return openThread(created.thread.id, false, navigation);
}

async function openThread(threadId, preserveBranch = false, navigation = ++state.navigationSequence) {
  if (state.thread && state.thread.id !== threadId && !(await saveDraftNow(state.thread.id))) return;
  if (navigation !== state.navigationSequence) return;
  stopPolling();
  const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`);
  if (navigation !== state.navigationSequence) return;
  state.payload = payload;
  state.transcriptRevision = payload.transcriptRevision ?? 0;
  state.cursorVersion = payload.cursorVersion ?? 0;
  state.thread = payload.thread;
  state.project = payload.project;
  state.branch = payload.branches.find((item) => item.id === payload.thread.branchId) ?? null;
  state.branches = payload.branches;
  state.threads = payload.threads;
  state.contextInspector = null;
  $('#turnNotice').hidden = true;
  $('#inspectContextButton').hidden = true;
  setTextareaValue($('#composerInput'), payload.draft?.content ?? '');
  if (!preserveBranch) saveSelection();
  renderWorkspace();
  startPolling();
}

async function refreshCurrentThread({ keepScroll = true } = {}) {
  if (!state.thread) return;
  const threadId = state.thread.id;
  const requestSequence = ++state.snapshotSequence;
  const revision = state.transcriptRevision;
  const cursorVersion = state.cursorVersion;
  const list = $('#messageList');
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const payload = await api(`/api/threads/${encodeURIComponent(threadId)}/snapshot?after=${encodeURIComponent(revision)}&cursorVersion=${encodeURIComponent(cursorVersion)}`);
  if (state.thread?.id !== threadId || requestSequence !== state.snapshotSequence) return;
  const transcript = state.payload?.transcript ?? [];
  const byId = new Map((payload.resetRequired ? [] : transcript).map((message) => [message.id, message]));
  for (const message of payload.delta ?? []) byId.set(message.id, message);
  const updatedTranscript = [...byId.values()].sort((left, right) => left.sequence - right.sequence);
  const transcriptChanged = updatedTranscript.length !== transcript.length || (payload.delta?.length ?? 0) > 0;
  state.transcriptRevision = payload.transcriptRevision ?? state.transcriptRevision;
  state.cursorVersion = payload.cursorVersion ?? state.cursorVersion;
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
  const sending = state.sendingThreads.has(state.thread.id);
  $('#composerInput').disabled = sending;
  $('#sendButton').disabled = !$('#composerInput').value.trim() || sending;
  $('#cancelTurn').hidden = !sending;
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
    const row = document.createElement('div');
    row.className = 'thread-row';
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
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'thread-delete-button';
    remove.textContent = '×';
    remove.title = `Delete ${thread.title}`;
    remove.setAttribute('aria-label', `Delete conversation ${thread.title}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      void openDeleteChatDialog(thread);
    });
    row.append(button, remove);
    root.append(row);
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

function appendInlineMarkdown(root, text) {
  const pattern = /(`+)([^`]+?)\1|\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)(?:\s+"([^"]*)")?\)|(\*\*|__)(\S(?:[\s\S]*?\S)?)\6|(~~)(\S(?:[\s\S]*?\S)?)\8|(\*|_)(\S(?:[\s\S]*?\S)?)\10/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) root.append(document.createTextNode(text.slice(cursor, match.index)));
    let element;
    if (match[1]) {
      element = document.createElement('code');
      element.dir = 'ltr';
      element.textContent = match[2];
    } else if (match[3]) {
      let url;
      try { url = new URL(match[4], window.location.href); } catch { url = null; }
      if (!url || !['http:', 'https:', 'mailto:'].includes(url.protocol)) {
        root.append(document.createTextNode(match[0]));
        cursor = match.index + match[0].length;
        continue;
      }
      element = document.createElement('a');
      element.href = url.href;
      if (url.protocol !== 'mailto:') {
        element.target = '_blank';
        element.rel = 'noopener noreferrer';
      }
      if (match[5]) element.title = match[5];
      appendInlineMarkdown(element, match[3]);
    } else {
      const content = match[7] ?? match[9] ?? match[11];
      element = document.createElement(match[6] ? 'strong' : match[8] ? 'del' : 'em');
      appendInlineMarkdown(element, content);
    }
    root.append(element);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) root.append(document.createTextNode(text.slice(cursor)));
}

function markdownListMarker(line) {
  const match = /^ {0,3}([-+*]|\d+[.)])\s+(.*)$/.exec(line);
  return match ? { ordered: /^\d/.test(match[1]), marker: match[1], content: match[2] } : null;
}

function markdownDirection(text, forceRtl = false) {
  return forceRtl || isRtl(text) ? 'rtl' : 'auto';
}

function isMarkdownBlockStart(line) {
  return /^ {0,3}(?:#{1,6}\s|>|`{3,}|~{3,})/.test(line) ||
    /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line) || Boolean(markdownListMarker(line));
}

function appendMarkdownBlocks(root, lines, { narrative = false, forceRtl = false } = {}) {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const codeLines = [];
      index += 1;
      const closePattern = fence[1][0] === '`' ? /^ {0,3}`{3,}\s*$/ : /^ {0,3}~{3,}\s*$/;
      while (index < lines.length && !closePattern.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.dir = 'ltr';
      code.textContent = codeLines.join('\n');
      pre.append(code);
      root.append(pre);
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      element.dir = markdownDirection(heading[2], forceRtl);
      appendInlineMarkdown(element, heading[2]);
      root.append(element);
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      root.append(document.createElement('hr'));
      index += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^ {0,3}>\s?/, ''));
        index += 1;
      }
      const quote = document.createElement('blockquote');
      quote.dir = markdownDirection(quoteLines.join('\n'), forceRtl);
      appendMarkdownBlocks(quote, quoteLines, { narrative, forceRtl });
      root.append(quote);
      continue;
    }

    const firstMarker = markdownListMarker(line);
    if (firstMarker) {
      const list = document.createElement(firstMarker.ordered ? 'ol' : 'ul');
      if (firstMarker.ordered && Number.parseInt(firstMarker.marker, 10) > 1) list.start = Number.parseInt(firstMarker.marker, 10);
      while (index < lines.length) {
        const marker = markdownListMarker(lines[index]);
        if (!marker || marker.ordered !== firstMarker.ordered) break;
        const item = document.createElement('li');
        item.dir = markdownDirection(marker.content, forceRtl);
        appendInlineMarkdown(item, marker.content);
        list.append(item);
        index += 1;
      }
      root.append(list);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) paragraphLines.push(lines[index++]);
    const content = paragraphLines.join('\n');
    const paragraph = document.createElement('p');
    paragraph.className = `markdown-paragraph${narrative ? ` narrative-part ${paragraphKind(content)}` : ''}`;
    paragraph.dir = markdownDirection(content, forceRtl);
    paragraphLines.forEach((paragraphLine, lineIndex) => {
      if (lineIndex) paragraph.append(document.createElement('br'));
      appendInlineMarkdown(paragraph, paragraphLine);
    });
    root.append(paragraph);
  }
}

function renderMarkdown(text, { narrative = false, message = false, forceRtl = false } = {}) {
  const root = document.createElement('div');
  root.className = message ? 'message-text markdown-content' : 'markdown-content';
  root.dir = markdownDirection(text, forceRtl);
  appendMarkdownBlocks(root, String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), { narrative, forceRtl });
  return root;
}

function setMarkdownEditorContent(editor, value) {
  const rendered = renderMarkdown(value, { forceRtl: true });
  editor.replaceChildren(...rendered.childNodes);
  editor.classList.toggle('is-empty', !serializeMarkdownEditor(editor).trim());
}

function markdownInlineText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\u00a0/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  const content = [...node.childNodes].map(markdownInlineText).join('');
  if (tag === 'strong' || tag === 'b') return `**${content}**`;
  if (tag === 'em' || tag === 'i') return `*${content}*`;
  if (tag === 'del' || tag === 's' || tag === 'strike') return `~~${content}~~`;
  if (tag === 'code') {
    const ticks = '`'.repeat(Math.max(1, ...[...content.matchAll(/`+/g)].map((match) => match[0].length + 1)));
    return `${ticks}${content}${ticks}`;
  }
  if (tag === 'a') {
    try {
      const url = new URL(node.getAttribute('href'), window.location.href);
      if (['http:', 'https:', 'mailto:'].includes(url.protocol)) return `[${content}](${url.href})`;
    } catch { /* Ignore invalid pasted or edited links. */ }
  }
  return content;
}

function markdownListText(list, depth = 0) {
  const ordered = list.tagName.toLowerCase() === 'ol';
  let number = Number.parseInt(list.getAttribute('start') || '1', 10);
  const indent = '  '.repeat(depth);
  const lines = [];
  for (const item of [...list.children].filter((child) => child.tagName?.toLowerCase() === 'li')) {
    const marker = ordered ? `${number++}.` : '-';
    const inline = [...item.childNodes].filter((child) => !['ul', 'ol'].includes(child.nodeName.toLowerCase())).map(markdownInlineText).join('');
    lines.push(`${indent}${marker}${inline ? ` ${inline}` : ' '}`);
    for (const nested of [...item.children].filter((child) => ['ul', 'ol'].includes(child.tagName.toLowerCase()))) {
      lines.push(markdownListText(nested, depth + 1));
    }
  }
  return lines.join('\n');
}

function markdownBlockText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\u00a0/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  if (tag === 'ul' || tag === 'ol') return markdownListText(node);
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${[...node.childNodes].map(markdownInlineText).join('')}`;
  if (tag === 'blockquote') {
    const quote = markdownBlocksText([...node.childNodes]);
    return (quote || '').split('\n').map((line) => `>${line ? ` ${line}` : ' '}`).join('\n');
  }
  if (tag === 'pre') {
    const code = node.querySelector('code')?.textContent ?? node.textContent;
    const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((match) => match[0].length + 1)));
    return `${fence}\n${code}\n${fence}`;
  }
  if (tag === 'hr') return '---';
  if (tag === 'div' && [...node.children].some((child) => /^(?:p|div|h[1-6]|ul|ol|blockquote|pre|hr)$/.test(child.tagName.toLowerCase()))) {
    return markdownBlocksText([...node.childNodes]);
  }
  if (tag === 'p' || tag === 'div') return [...node.childNodes].map(markdownInlineText).join('');
  return [...node.childNodes].map(markdownInlineText).join('');
}

function markdownBlocksText(nodes) {
  return nodes.map(markdownBlockText).join('\n\n');
}

function serializeMarkdownEditor(editor) {
  return markdownBlocksText([...editor.childNodes]);
}

function setMarkdownCaret(element, offset = 0) {
  const selection = window.getSelection();
  if (!selection) return;
  let caretNode = element.firstChild;
  if (!caretNode || caretNode.nodeType !== Node.TEXT_NODE) {
    caretNode = document.createTextNode('');
    element.insertBefore(caretNode, element.firstChild);
  }
  const range = document.createRange();
  range.setStart(caretNode, Math.min(offset, caretNode.textContent.length));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusMarkdownField(textarea) {
  const editor = markdownEditors.get(textarea)?.editor;
  if (!editor) return textarea.focus();
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function formatMarkdownAtCaret(editor) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return false;
  const textNode = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer : null;
  if (!textNode || textNode.parentElement?.closest('code, pre')) return false;
  const before = textNode.data.slice(0, range.startOffset);
  const patterns = [
    { expression: /\*\*(\S(?:[\s\S]*?\S)?)\*\*$/u, tag: 'strong' },
    { expression: /__(\S(?:[\s\S]*?\S)?)__$/u, tag: 'strong' },
    { expression: /~~(\S(?:[\s\S]*?\S)?)~~$/u, tag: 'del' },
    { expression: /`([^`\n]+)`$/u, tag: 'code' },
    { expression: /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)$/u, tag: 'a' },
    { expression: /\*(\S(?:[\s\S]*?\S)?)\*$/u, tag: 'em' },
    { expression: /_(\S(?:[\s\S]*?\S)?)_$/u, tag: 'em' }
  ];
  for (const { expression, tag } of patterns) {
    const match = expression.exec(before);
    if (!match) continue;
    const start = range.startOffset - match[0].length;
    const replacement = document.createElement(tag);
    if (tag === 'a') {
      let url;
      try { url = new URL(match[2], window.location.href); } catch { url = null; }
      if (!url || !['http:', 'https:', 'mailto:'].includes(url.protocol)) continue;
      replacement.textContent = match[1];
      replacement.href = url.href;
      if (url.protocol !== 'mailto:') {
        replacement.target = '_blank';
        replacement.rel = 'noopener noreferrer';
      }
    } else replacement.textContent = match[1];
    const replaceRange = document.createRange();
    replaceRange.setStart(textNode, start);
    replaceRange.setEnd(textNode, range.startOffset);
    replaceRange.deleteContents();
    replaceRange.insertNode(replacement);
    const after = document.createRange();
    after.setStartAfter(replacement);
    after.collapse(true);
    selection.removeAllRanges();
    selection.addRange(after);
    return true;
  }
  return false;
}

function markdownMarkerForSpace(editor) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const cursor = selection.getRangeAt(0);
  if (!editor.contains(cursor.startContainer)) return null;
  let top = cursor.startContainer.nodeType === Node.ELEMENT_NODE ? cursor.startContainer : cursor.startContainer.parentElement;
  while (top?.parentElement && top.parentElement !== editor) top = top.parentElement;
  if (!top || top.parentElement !== editor || top.nodeType === Node.ELEMENT_NODE && top.closest('li, blockquote')) return null;
  const fullText = top.textContent ?? '';
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(top);
  try { prefixRange.setEnd(cursor.startContainer, cursor.startOffset); } catch { return null; }
  const before = prefixRange.toString();
  if (!before || before !== fullText) return null;
  const match = /^(?:([-+*])|(\d+[.)])|(#{1,6})|>|(-{3,}|\*{3,}))$/.exec(before);
  if (!match) return null;
  return { top, marker: before, unordered: Boolean(match[1]), ordered: match[2], heading: match[3]?.length, quote: before === '>', rule: Boolean(match[4]) };
}

function convertMarkdownMarker(editor) {
  const parsed = markdownMarkerForSpace(editor);
  if (!parsed) return false;
  const { top, ordered, heading, quote, rule } = parsed;
  let target;
  if (rule) {
    target = document.createElement('p');
    target.append(document.createElement('br'));
    top.parentNode.insertBefore(document.createElement('hr'), top);
    top.parentNode.insertBefore(target, top);
  } else if (parsed.unordered || ordered) {
    target = document.createElement(parsed.unordered ? 'ul' : 'ol');
    if (ordered) target.start = Number.parseInt(ordered, 10);
    const item = document.createElement('li');
    target.append(item);
    top.parentNode.insertBefore(target, top);
    target = item;
  } else if (heading) {
    target = document.createElement(`h${heading}`);
    top.parentNode.insertBefore(target, top);
  } else if (quote) {
    target = document.createElement('blockquote');
    top.parentNode.insertBefore(target, top);
  }
  if (!target) return false;
  top.remove();
  if (target.tagName === 'P' && target.firstChild?.tagName === 'BR') target.replaceChildren();
  setMarkdownCaret(target);
  return true;
}

function commitMarkdownEditor(textarea, editor, { rehydrate = false } = {}) {
  let value = serializeMarkdownEditor(editor);
  if (textarea.maxLength >= 0 && value.length > textarea.maxLength) {
    value = value.slice(0, textarea.maxLength);
    textarea.value = value;
    setMarkdownEditorContent(editor, value);
    setMarkdownCaret(editor);
  } else {
    textarea.value = value;
    editor.classList.toggle('is-empty', !value.trim());
  }
  if (rehydrate) setMarkdownEditorContent(editor, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function bindMarkdownField(field) {
  field.dir = 'rtl';
  if (field.localName !== 'textarea' || markdownEditors.has(field)) return;
  const editor = document.createElement('div');
  editor.className = 'markdown-editor markdown-content';
  editor.id = `${field.id || `markdownEditor${++markdownEditorSequence}`}Editor`;
  editor.dir = 'rtl';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('contenteditable', String(!field.disabled));
  editor.setAttribute('spellcheck', 'true');
  editor.dataset.placeholder = field.placeholder || '';
  editor.tabIndex = field.disabled ? -1 : 0;

  const wrappingLabel = field.closest('label');
  const labels = field.id ? [...document.querySelectorAll('label[for]')].filter((label) => label.htmlFor === field.id) : [];
  const labelText = wrappingLabel?.textContent ?? labels[0]?.textContent ?? field.getAttribute('aria-label') ?? field.placeholder;
  if (labelText) editor.setAttribute('aria-label', labelText.trim());
  for (const label of labels) label.htmlFor = editor.id;
  if (wrappingLabel) {
    wrappingLabel.htmlFor = editor.id;
    field.remove();
    wrappingLabel.insertAdjacentElement('afterend', editor);
    editor.insertAdjacentElement('afterend', field);
  } else {
    field.insertAdjacentElement('beforebegin', editor);
  }
  field.classList.add('markdown-source');
  field.setAttribute('aria-hidden', 'true');
  field.tabIndex = -1;
  setMarkdownEditorContent(editor, field.value);
  editor.addEventListener('input', (event) => {
    if (!event.isComposing) formatMarkdownAtCaret(editor);
    commitMarkdownEditor(field, editor);
  });
  editor.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (text === undefined) return;
    event.preventDefault();
    if (!document.execCommand('insertText', false, text)) {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    }
  });
  editor.addEventListener('keydown', (event) => {
    if (event.key === ' ' && !event.shiftKey && !event.isComposing && convertMarkdownMarker(editor)) {
      event.preventDefault();
      commitMarkdownEditor(field, editor);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (['b', 'i'].includes(event.key.toLowerCase()) || event.key.toLowerCase() === 'x' && event.shiftKey)) {
      event.preventDefault();
      const command = event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : 'strikeThrough';
      document.execCommand(command);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'formatText' }));
      return;
    }
    if (event.key !== 'Enter' || field.id !== 'composerInput' || event.isComposing) {
      if (event.key === 'Escape' && field.id === 'composerInput') toggleCommandPalette(false);
      return;
    }
    const selection = window.getSelection();
    const current = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    const inListItem = Boolean(current?.closest('li'));
    if (!event.shiftKey && (event.ctrlKey || event.metaKey || !inListItem)) {
      event.preventDefault();
      $('#composerForm').requestSubmit();
    }
  });
  const observer = new MutationObserver(() => {
    editor.contentEditable = String(!field.disabled);
    editor.setAttribute('aria-disabled', String(field.disabled));
    editor.tabIndex = field.disabled ? -1 : 0;
  });
  observer.observe(field, { attributes: true, attributeFilter: ['disabled'] });
  markdownEditors.set(field, { editor, observer });
  field.form?.addEventListener('reset', () => setTimeout(() => setMarkdownEditorContent(editor, field.value), 0));
}

function prepareMarkdownFields(root = document) {
  const selector = 'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select';
  $$(selector, root).forEach(bindMarkdownField);
}

function setTextareaValue(textarea, value) {
  textarea.value = value;
  const binding = markdownEditors.get(textarea);
  if (binding) setMarkdownEditorContent(binding.editor, value);
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

function makeMessageCard(message) {
  const card = document.createElement('article');
  const cardKind = message.kind === 'command' ? (message.role === 'user' ? 'command' : 'command-result') : message.kind;
  card.className = `message-card ${message.role}${message.kind === 'status' ? ' status' : ''}${message.kind === 'command' ? ' command' : ''}${message.status === 'failed' || message.status === 'interrupted' ? ' failed' : ''}${message.inherited ? ' inherited' : ''}`;
  card.dataset.messageId = message.id;
  if (message.sourceMessageId) card.dataset.sourceMessageId = message.sourceMessageId;
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
  const narrative = message.role === 'assistant' && message.kind === 'story' && state.view === 'narrative';
  body.append(renderMarkdown(message.content, { narrative, message: true }));
  card.append(meta, body);
  if (message.role === 'assistant' && ['failed', 'interrupted'].includes(message.status) && message.sourceMessageId) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry-turn-button';
    retry.textContent = 'Retry this reply';
    retry.addEventListener('click', () => void retryTurn(message.sourceMessageId));
    card.append(retry);
  }
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
  if (status === 'complete') statusNode?.remove();
  else {
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
  body.append(renderMarkdown(fullText, { narrative: state.view === 'narrative', message: true }));
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
  const content = document.createElement('div');
  content.className = 'continuity-markdown';
  content.append(renderMarkdown(item.content));
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
  const content = document.createElement('div');
  content.className = 'continuity-markdown';
  content.append(renderMarkdown(item.content));
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
  const memoryCounts = memory.counts ?? {};
  const failedCount = Number(memoryCounts.error ?? 0);
  const pendingCount = Number(memoryCounts.pending ?? 0);
  const processingCount = Number(memoryCounts.processing ?? 0);
  const errorLabel = failedCount ? ` · ${failedCount} failed` : '';
  $('#memoryBadgeText').textContent = `${memory.state === 'current' ? 'Memory current' : `Memory ${memory.state}`}${errorLabel}${indexed}`;
  const memoryNotice = $('#memoryNotice');
  memoryNotice.hidden = memory.state === 'current';
  memoryNotice.dataset.state = memory.state;
  if (memory.state === 'error') {
    memoryNotice.textContent = `${failedCount} continuity ${failedCount === 1 ? 'record needs' : 'records need'} attention; ${pendingCount} are waiting. ${memory.error || 'Indexing did not finish.'} Your saved messages are safe. Retry memory processing when ready.`;
  } else if (memory.state === 'processing') {
    memoryNotice.textContent = `Continuity indexing is working on ${processingCount} ${processingCount === 1 ? 'record' : 'records'}; ${pendingCount} are waiting. Your saved messages remain available.`;
  } else if (memory.state === 'pending') {
    memoryNotice.textContent = `${pendingCount} continuity ${pendingCount === 1 ? 'record is' : 'records are'} saved and waiting to be indexed. Your messages are safe.`;
  } else {
    memoryNotice.textContent = '';
  }
  $('#retryMemory').hidden = memory.state !== 'error' && memory.state !== 'pending';

  const ledger = payload.ledger ?? [];
  const current = ledger.filter((item) => item.effective && ['current', 'uncertain'].includes(item.status));
  const scene = current.find((item) => item.type === 'scene');
  $('#sceneContent').replaceChildren(renderMarkdown(scene?.content ?? 'No source-backed scene state has been recorded yet.'));
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
  if (state.thread && !state.sendingThreads.has(state.thread.id)) {
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
    if (state.thread) void refreshCurrentThread().catch(() => {});
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

async function streamGeneration({ threadId, url, body, submittedContent = null, clearComposerOnAck = false }) {
  if (state.sendingThreads.has(threadId)) return;
  state.sendingThreads.add(threadId);
  const current = () => state.thread?.id === threadId;
  if (current()) {
    state.contextInspector = null;
    $('#composerInput').disabled = true;
    $('#sendButton').disabled = true;
    $('#cancelTurn').hidden = String(submittedContent ?? '').startsWith('/');
    $('#composerStatus').textContent = String(submittedContent ?? '').startsWith('/') ? 'Saving command locally…' : 'Saving your turn, then building story context…';
    $('#turnNotice').hidden = true;
    $('#inspectContextButton').hidden = true;
  }
  let acknowledged = false;
  try {
    const response = await fetch(url, {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: jsonBody(body)
    });
    await parseSse(response, (event, data) => {
      if (event === 'saved') {
        acknowledged = true;
        if (clearComposerOnAck && current() && $('#composerInput').value === submittedContent) setTextareaValue($('#composerInput'), '');
        if (clearComposerOnAck) void clearDraftAfterAcknowledgement(threadId);
        if (current()) {
          state.snapshotSequence += 1;
          updateSavedMessage(data.message);
          $('#messageList').scrollTop = $('#messageList').scrollHeight;
          $('#sendButton').disabled = !$('#composerInput').value.trim();
        }
      } else if (event === 'assistant-saved') {
        if (current()) {
          state.snapshotSequence += 1;
          state.contextInspector = data.inspector ?? null;
          updateSavedMessage(data.message);
          const count = data.sources?.length ?? 0;
          $('#turnNoticeText').textContent = `Retrieved ${count} source message${count === 1 ? '' : 's'} and ${data.ledgerItems?.length ?? 0} continuity record${(data.ledgerItems?.length ?? 0) === 1 ? '' : 's'} for this response.`;
          $('#turnNotice').hidden = false;
          $('#inspectContextButton').hidden = !state.contextInspector;
          $('#composerStatus').textContent = 'Codex is continuing the story…';
          $('#cancelTurn').hidden = false;
        }
      } else if (event === 'retry-started') {
        if (current()) $('#composerStatus').textContent = 'Retrying the saved user turn…';
      } else if (event === 'retry-existing') {
        if (current()) {
          void refreshCurrentThread();
          showToast(`This retry request already exists (${data.attempt.status}).`);
        }
      } else if (event === 'delta') {
        if (current()) {
          state.snapshotSequence += 1;
          updateStreamedMessage(data.messageId, data.fullText, 'streaming');
        }
      } else if (event === 'complete') {
        if (data.message && current()) {
          state.snapshotSequence += 1;
          updateSavedMessage(data.message);
          state.payload && (state.payload.memory = data.memory);
          $('#composerStatus').textContent = 'Reply saved. Continuity indexing is running in the background.';
        }
      } else if (event === 'command-complete') {
        if (current()) {
          if (data.activity) updateSavedMessage(data.activity);
          $('#composerStatus').textContent = 'Command completed locally.';
          if (data.output) showToast(data.output, 6000);
        }
      } else if (event === 'activity') {
        // Non-story protocol activity is intentionally not shown as narrative.
      } else if (event === 'failure') {
        if (current()) {
          if (data.activity) updateSavedMessage(data.activity);
          $('#composerStatus').textContent = data.message;
          $('#turnNoticeText').textContent = data.message;
          $('#turnNotice').hidden = false;
          $('#inspectContextButton').hidden = !state.contextInspector;
        }
      }
    });
  } catch (error) {
    if (current()) {
      showToast(error.message, 5500);
      $('#composerStatus').textContent = 'Your saved conversation can be reloaded. Check the connection and retry.';
      if (!acknowledged && clearComposerOnAck && !$('#composerInput').value) setTextareaValue($('#composerInput'), submittedContent);
    }
  } finally {
    state.sendingThreads.delete(threadId);
    if (current()) {
      $('#composerInput').disabled = false;
      $('#cancelTurn').hidden = true;
      $('#sendButton').disabled = !$('#composerInput').value.trim();
      await refreshCurrentThread().catch(() => {});
    }
  }
}

async function submitMessage(content = $('#composerInput').value) {
  const threadId = state.thread?.id;
  if (!threadId || state.sendingThreads.has(threadId) || !content.trim()) return;
  const clearComposerOnAck = content === $('#composerInput').value;
  return streamGeneration({
    threadId,
    url: `/api/threads/${encodeURIComponent(threadId)}/send`,
    body: { content },
    submittedContent: content,
    clearComposerOnAck
  });
}

async function retryTurn(userMessageId) {
  const threadId = state.thread?.id;
  if (!threadId || state.sendingThreads.has(threadId)) return;
  return streamGeneration({
    threadId,
    url: `/api/threads/${encodeURIComponent(threadId)}/retry`,
    body: { userMessageId, clientRequestId: crypto.randomUUID() }
  });
}

function openContextInspector() {
  const inspector = state.contextInspector;
  if (!inspector) return;
  const memory = inspector.memory ?? {};
  const counts = memory.counts ?? {};
  const lag = Number(counts.pending ?? 0) + Number(counts.processing ?? 0) + Number(counts.error ?? 0);
  const last = memory.lastIndexed?.id ? ` Last indexed source: ${memory.lastIndexed.id}.` : ' No messages have completed indexing yet.';
  $('#contextMemoryStatus').textContent = `Indexing state: ${memory.state ?? 'unknown'}; ${lag} record${lag === 1 ? '' : 's'} pending, processing, or failed.${last}`;

  const canonRoot = $('#contextCanon');
  canonRoot.replaceChildren();
  for (const item of inspector.canon ?? []) {
    const entry = document.createElement('div');
    entry.className = 'context-entry';
    const heading = document.createElement('strong');
    heading.textContent = `${item.type} · ${item.subject} · ${item.status}`;
    const sources = document.createElement('small');
    sources.textContent = `Sources: ${(item.sourceMessageIds ?? []).join(', ') || 'none'}`;
    entry.append(heading, renderMarkdown(item.content), sources);
    canonRoot.append(entry);
  }
  if (!canonRoot.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'search-placeholder';
    empty.textContent = 'No continuity records were selected for this reply.';
    canonRoot.append(empty);
  }

  const sourcesRoot = $('#contextSources');
  sourcesRoot.replaceChildren();
  for (const source of inspector.sources ?? []) {
    const entry = document.createElement('div');
    entry.className = 'context-entry';
    const heading = document.createElement('strong');
    heading.textContent = `${source.role} · ${source.id}`;
    entry.append(heading, renderMarkdown(source.excerpt, { message: true }));
    sourcesRoot.append(entry);
  }
  if (!sourcesRoot.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'search-placeholder';
    empty.textContent = 'No source excerpts were selected for this reply.';
    sourcesRoot.append(empty);
  }
  $('#contextDialog').showModal();
}

function openProjectDialog() {
  $('#projectForm').reset();
  $('#projectDialog').showModal();
  $('#projectName').focus();
}

function openSettings() {
  const project = state.project;
  $('#settingsProjectName').value = project?.name ?? '';
  setTextareaValue($('#settingsProjectInstructions'), project?.instructions ?? '');
  setTextareaValue($('#settingsProjectStyle'), project?.style ?? '');
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
  void refreshBackupStatus().catch(() => {});
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
    ? 'Choose a Story Studio .story.json project export to restore a complete project, or a ChatGPT conversation JSON to create a new project from its saved messages.'
    : 'Import a Markdown or ChatGPT JSON archive. The original file and saved messages are retained in the selected project.';
  $('#archiveProjectLabel').hidden = projectMode;
  $('#importFile').accept = projectMode ? '.story.json,.json,application/json' : '.md,.json,text/markdown,text/plain,application/json';
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
    bindMarkdownField(input);
  }
  $('#editDialog').showModal();
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

async function openDeleteChatDialog(thread) {
  try {
    const payload = thread.id === state.thread?.id ? state.payload : await api(`/api/threads/${encodeURIComponent(thread.id)}`);
    const impact = payload?.deletionImpact ?? { conversations: 1, branches: 0, messages: 0, importedArchives: 0 };
    const dependent = Math.max(0, impact.conversations - 1);
    const parts = [
      `${impact.messages} saved message${impact.messages === 1 ? '' : 's'}`,
      `${impact.branches} alternate branch${impact.branches === 1 ? '' : 'es'}`,
      `${dependent} dependent conversation${dependent === 1 ? '' : 's'}`,
      `${impact.importedArchives} linked archive${impact.importedArchives === 1 ? '' : 's'}`
    ];
    $('#deleteChatDescription').textContent = `This permanently removes “${thread.title}” and ${parts.join(', ')} from this PC. Source-linked continuity records supported by other saved messages remain; records that rely only on deleted messages are removed. The project and unrelated chats stay. This cannot be undone.`;
    $('#deleteChatName').value = '';
    $('#deleteChatPhrase').value = '';
    state.pendingDeleteChat = { id: thread.id, title: thread.title, projectId: thread.projectId, branchId: thread.branchId };
    $('#deleteChatDialog').showModal();
  } catch (error) { showNotice('Conversation details could not be loaded', error.message); }
}

async function deleteChat(event) {
  event.preventDefault();
  const target = state.pendingDeleteChat;
  if (!target) return;
  try {
    const result = await api(`/api/threads/${encodeURIComponent(target.id)}`, {
      method: 'DELETE',
      body: jsonBody({ confirmTitle: $('#deleteChatName').value, confirmation: $('#deleteChatPhrase').value })
    });
    closeDialog('deleteChatDialog');
    state.pendingDeleteChat = null;
    await refreshProjects();
    await openProject(target.projectId, target.branchId);
    showToast(`Deleted “${result.deleted}” and ${result.removed.messages} saved messages.`);
  } catch (error) { showNotice('Conversation was not deleted', error.message); }
}

async function runSearch() {
  clearTimeout(state.searchTimer);
  const query = $('#searchInput').value.trim();
  if (!query || !state.project || !state.branch) {
    $('#searchResults').innerHTML = '<div class="search-placeholder">Search the complete saved conversation on the selected branch.</div>';
    return;
  }
  const threadId = state.thread?.id;
  const requestSequence = ++state.searchRequestSequence;
  try {
    const data = await api(`/api/search?projectId=${encodeURIComponent(state.project.id)}&branchId=${encodeURIComponent(state.branch.id)}&threadId=${encodeURIComponent(threadId ?? '')}&q=${encodeURIComponent(query)}`);
    if (requestSequence !== state.searchRequestSequence || state.thread?.id !== threadId) return;
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
      body.append(renderMarkdown(`${start ? '…' : ''}${result.content.slice(start, start + 380)}${result.content.length > start + 380 ? '…' : ''}`));
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
  const response = await fetch(url, { method: 'GET', cache: 'no-store' });
  if (!response.ok) {
    let message = `The download failed (${response.status}).`;
    try { message = (await response.json()).error ?? message; } catch { /* keep the download error */ }
    throw new Error(message);
  }
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
  state.appSettings = data.appSettings ?? state.appSettings;
  state.selectedModel = data.selectedModel ?? state.selectedModel;
  state.backupStatus = data.backupStatus ?? state.backupStatus;
  applyTheme(state.appSettings.theme);
  renderBackupStatus(state.backupStatus);
  renderProjectList();
}

function renderBackupStatus(status) {
  state.backupStatus = status;
  const node = $('#backupStatusText');
  if (!node) return;
  if (status?.error) {
    node.textContent = `Automatic backup failed: ${status.error} Check available disk space, then create a local snapshot to retry.`;
  } else if (status?.latest) {
    const date = new Date(status.latest.createdAt);
    node.textContent = `Latest successful backup: ${date.toLocaleString()} · ${status.latest.kind} snapshot.`;
  } else {
    node.textContent = 'No successful backup is recorded yet. Story Studio will create one automatically while it runs.';
  }
}

async function refreshBackupStatus() {
  const result = await api('/api/backups');
  renderBackupStatus(result.status);
  return result;
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
      state.thread = null;
      state.project = null;
      state.payload = null;
      await refreshProjects();
      if (state.projects.length) await openProject(state.projects[0].id);
      else showEmptyState();
      closeDialog('settingsDialog');
      showNotice('Backup restored', `All local story projects were restored. A pre-restore recovery snapshot is available as ${result.recoveryBackupId}.`);
    } catch (error) { showNotice('Backup could not be restored', error.message); }
  }, { once: true });
  input.click();
}

async function openLocalBackupDialog() {
  try {
    const data = await api('/api/backups');
    const select = $('#localBackupSelect');
    select.replaceChildren();
    $('#localBackupConfirmation').value = '';
    for (const backup of data.backups) {
      const date = new Date(backup.createdAt).toLocaleString();
      const size = `${(backup.size / (1024 * 1024)).toFixed(1)} MB`;
      select.append(new Option(`${backup.kind} · ${date} · ${size}`, backup.id));
    }
    const status = $('#localBackupListStatus');
    status.textContent = data.backups.length
      ? `Latest successful backup: ${data.status.latest?.kind ?? 'local'} · ${data.status.latest ? new Date(data.status.latest.createdAt).toLocaleString() : ''}.`
      : 'No local SQLite snapshots are available yet. Create one from Settings & data.';
    $('#localBackupForm').querySelector('button[type="submit"]').disabled = !data.backups.length;
    $('#localBackupDialog').showModal();
  } catch (error) { showNotice('Local backups could not be listed', error.message); }
}

async function restoreLocalSnapshot() {
  const id = $('#localBackupSelect').value;
  if (!id) return showToast('Choose a local SQLite snapshot.');
  const confirmation = $('#localBackupConfirmation').value;
  if (confirmation !== 'RESTORE ALL') {
    $('#localBackupConfirmation').focus();
    return showToast('Type RESTORE ALL to replace your local projects.');
  }
  try {
    const result = await api(`/api/backups/${encodeURIComponent(id)}/restore`, {
      method: 'POST', body: jsonBody({ confirmation })
    });
    state.thread = null;
    state.project = null;
    state.payload = null;
    closeDialog('localBackupDialog');
    closeDialog('settingsDialog');
    await refreshProjects();
    if (state.projects.length) await openProject(state.projects[0].id);
    else showEmptyState();
    showNotice('Snapshot restored', `The selected SQLite snapshot was restored. A pre-restore recovery snapshot is available as ${result.recoveryBackupId}.`);
  } catch (error) { showNotice('Snapshot could not be restored', error.message); }
}

async function retryMemory() {
  if (!state.project) return;
  try {
    const result = await api('/api/memory/retry', { method: 'POST', body: jsonBody({ projectId: state.project.id }) });
    await refreshCurrentThread();
    showToast(result.message ?? 'Memory status refreshed.');
  } catch (error) { showToast(error.message); }
}

function commandClick(command) {
  setTextareaValue($('#composerInput'), command);
  focusMarkdownField($('#composerInput'));
  $('#sendButton').disabled = !state.thread || state.sendingThreads.has(state.thread.id);
  scheduleDraftSave();
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
    focusMarkdownField($('#composerInput'));
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
    focusMarkdownField($('#composerInput'));
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
    showToast('Stop requested. The saved user message and any partial reply will remain in the transcript.');
  } catch (error) { showToast(error.message); }
  finally { $('#cancelTurn').disabled = false; }
}

async function emergencyStopApp() {
  const button = $('#emergencyStopButton');
  button.disabled = true;
  button.textContent = 'Stopping…';
  try {
    await api('/api/app/shutdown', { method: 'POST', body: jsonBody({ emergency: true }) });
    $('#composerStatus').textContent = 'Story Studio has been stopped. Active replies were interrupted; saved text remains in the local database.';
    showNotice('Story Studio is stopping', 'All running story replies are being interrupted. Saved user messages and any partial assistant text remain in the local database. Close this browser tab after the app stops.');
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Stop app';
    showNotice('Story Studio could not be stopped', error.message);
  }
}

function copyText(value) {
  if (!navigator.clipboard) return showToast(value);
  navigator.clipboard.writeText(value).then(() => showToast('Source ID copied.')).catch(() => showToast(value));
}

function bindEvents() {
  prepareMarkdownFields();
  $('#createProject').addEventListener('click', openProjectDialog);
  $('#emptyCreateProject').addEventListener('click', openProjectDialog);
  $('#emptyImportProject').addEventListener('click', () => openImportDialog('project'));
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
    $('#sendButton').disabled = !$('#composerInput').value.trim() || !state.thread || state.sendingThreads.has(state.thread.id);
    scheduleDraftSave();
    if ($('#composerInput').value === '/') toggleCommandPalette(true);
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
  $('#inspectContextButton').addEventListener('click', openContextInspector);
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
      await refreshBackupStatus();
      showNotice('Local snapshot created', `A SQLite snapshot of all story projects is ready (${result.id}).`);
    } catch (error) { showNotice('Backup could not be created', error.message); }
  });
  $('#restoreLocalBackupButton').addEventListener('click', () => void openLocalBackupDialog());
  $('#localBackupForm').addEventListener('submit', (event) => { event.preventDefault(); void restoreLocalSnapshot(); });
  $('#restoreButton').addEventListener('click', () => void restoreBackup());
  $('#deleteProject').addEventListener('click', openDeleteDialog);
  $('#deleteForm').addEventListener('submit', deleteProject);
  $('#deleteChatForm').addEventListener('submit', deleteChat);
  $('#emergencyStopButton').addEventListener('click', () => void emergencyStopApp());
  $('#settingsForm').addEventListener('submit', (event) => event.preventDefault());
  $('#commandToggle').title = 'Open the app command palette';
  window.addEventListener('pagehide', () => { void saveDraftNow(); });
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
