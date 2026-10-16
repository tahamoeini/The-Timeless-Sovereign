export function parseChatHistoryMarkdown(rawContent) {
  const source = String(rawContent ?? '');
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let current = null;

  const finish = () => {
    if (!current) return;
    const body = current.lines.join('\n').replace(/^\s+|\s+$/g, '');
    if (body) blocks.push({ role: current.role, body });
    current = null;
  };

  for (const line of lines) {
    const heading = /^##\s+(Prompt|Response):\s*$/i.exec(line.trim());
    if (heading) {
      finish();
      current = { role: heading[1].toLowerCase() === 'prompt' ? 'user' : 'assistant', lines: [], skipTimestamp: true };
      continue;
    }
    if (!current) continue;
    if (current.skipTimestamp) {
      if (!line.trim()) continue;
      if (/^\d{1,2}\/\d{1,2}\/\d{4},?\s+\d{1,2}:\d{2}/.test(line.trim())) {
        current.skipTimestamp = false;
        continue;
      }
      current.skipTimestamp = false;
    }
    current.lines.push(line);
  }
  finish();

  const turns = [];
  let pendingUser = null;
  for (const block of blocks) {
    if (block.role === 'user') {
      if (pendingUser) turns.push({ user: pendingUser, assistant: '' });
      pendingUser = block.body;
      continue;
    }
    if (pendingUser) {
      turns.push({ user: pendingUser, assistant: block.body });
      pendingUser = null;
    } else if (turns.length) {
      turns.at(-1).assistant += `\n\n${block.body}`;
    }
  }
  if (pendingUser) turns.push({ user: pendingUser, assistant: '' });
  return turns;
}

export function isChatHistoryJson(document) {
  return Boolean(document && typeof document === 'object' && !Array.isArray(document) &&
    document.metadata && typeof document.metadata === 'object' && Array.isArray(document.messages));
}

export function parseChatHistoryJson(documentOrText) {
  let document = documentOrText;
  if (typeof documentOrText === 'string') {
    try { document = JSON.parse(documentOrText); }
    catch { throw new Error('This JSON file could not be parsed as a ChatGPT chat archive.'); }
  }
  if (!isChatHistoryJson(document)) throw new Error('This JSON file is not a supported ChatGPT chat archive.');
  if (!document.messages.length) throw new Error('The ChatGPT chat archive has no messages.');

  return document.messages.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`The ChatGPT chat archive has an invalid message at position ${index + 1}.`);
    }
    const sourceRole = String(entry?.role ?? '').trim().toLowerCase();
    const role = ['prompt', 'user'].includes(sourceRole) ? 'user'
      : ['response', 'assistant'].includes(sourceRole) ? 'assistant'
        : null;
    if (!role) throw new Error(`The ChatGPT chat archive contains an unsupported role at message ${index + 1}.`);
    if (typeof entry.say !== 'string') throw new Error(`The ChatGPT chat archive has no text for message ${index + 1}.`);
    const createdAt = typeof entry.time === 'string' && Number.isFinite(Date.parse(entry.time)) ? entry.time : null;
    return { role, content: entry.say, createdAt };
  });
}

export function parseChatHistory(rawContent) {
  const source = String(rawContent ?? '');
  if (source.trimStart().startsWith('{')) {
    try {
      const document = JSON.parse(source);
      if (isChatHistoryJson(document)) return parseChatHistoryJson(document);
    } catch (error) {
      if (error instanceof Error && /ChatGPT chat archive/.test(error.message)) throw error;
    }
  }
  return parseChatHistoryMarkdown(source);
}

