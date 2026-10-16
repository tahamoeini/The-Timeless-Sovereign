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

