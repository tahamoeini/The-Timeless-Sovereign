const MAX_SEARCH_RESULTS = 8;
const MAX_RECENT_TURNS = 10;
const MAX_SOURCE_EXCERPT = 7_000;

function cleanText(value) {
  return String(value ?? '').trim();
}

function termsFor(text) {
  return [...new Set((String(text ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []))].slice(0, 32);
}

function relevanceScore(item, terms) {
  const haystack = `${item.subject} ${item.content} ${JSON.stringify(item.details)}`.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function excerpt(text, terms) {
  const raw = String(text ?? '');
  if (raw.length <= MAX_SOURCE_EXCERPT) return { text: raw, isExcerpt: false };
  const lowered = raw.toLocaleLowerCase();
  const firstIndex = terms.map((term) => lowered.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstIndex - Math.floor(MAX_SOURCE_EXCERPT / 3));
  const end = Math.min(raw.length, start + MAX_SOURCE_EXCERPT);
  return { text: `${start ? '[Earlier source text omitted] ' : ''}${raw.slice(start, end)}${end < raw.length ? ' [Later source text omitted]' : ''}`, isExcerpt: true };
}

function formatSource(message, terms) {
  const body = excerpt(message.content, terms);
  const timestamp = message.createdAt ? new Date(message.createdAt).toISOString() : 'unknown time';
  return `### Source ${message.id} · ${message.role} · ${timestamp}${message.inherited ? ' · inherited at branch point' : ''}${body.isExcerpt ? ' · exact excerpt' : ''}\n${body.text}`;
}

function formatLedger(item) {
  const sourceIds = item.sourceMessageIds.map((id) => `message:${id}`).join(', ');
  const details = Object.keys(item.details ?? {}).length ? `\nDetails: ${JSON.stringify(item.details)}` : '';
  return `- [${item.type}; ${item.origin}; confidence ${item.confidence}; ${item.status}] ${item.subject}: ${item.content}${details}\n  Sources: ${sourceIds || 'none'}`;
}

export function buildContextBundle(database, threadId, currentMessage) {
  const thread = database.getThread(threadId);
  if (!thread) throw new Error('Thread not found.');
  const project = database.getProject(thread.projectId);
  const terms = termsFor(currentMessage.content);
  const ledger = database.getEffectiveLedger(thread.projectId, thread.branchId);
  const ordered = ledger
    .map((item) => ({ item, score: relevanceScore(item, terms) }))
    .sort((a, b) => b.score - a.score || b.item.sourceSequence - a.item.sourceSequence);

  const sceneItems = ledger.filter((item) => item.type === 'scene').slice(0, 3);
  const characters = ledger.filter((item) => item.type === 'character').slice(0, 20);
  const rules = ledger.filter((item) => item.type === 'rule').slice(0, 20);
  const openThreads = ledger.filter((item) => item.type === 'thread' && ['current', 'uncertain'].includes(item.status)).slice(0, 20);
  const relevant = ordered.filter(({ score }) => score > 0).slice(0, 20).map(({ item }) => item);
  const relevantIds = new Set([...sceneItems, ...characters, ...rules, ...openThreads, ...relevant].map((item) => item.id));
  const selectedLedger = ledger.filter((item) => relevantIds.has(item.id));
  const searchHits = database.searchMessages(thread.projectId, thread.branchId, currentMessage.content, MAX_SEARCH_RESULTS)
    .filter((message) => message.kind === 'story' && message.id !== currentMessage.id);
  const transcript = database.getTranscript(threadId)
    .filter((message) => message.kind === 'story' && message.role !== 'system' && message.id !== currentMessage.id)
    .slice(-MAX_RECENT_TURNS);

  const sources = new Map();
  for (const message of searchHits) sources.set(message.id, message);
  for (const item of selectedLedger) {
    for (const sourceId of item.sourceMessageIds) {
      if (!sources.has(sourceId)) {
        const message = database.getMessage(sourceId);
        if (message) sources.set(sourceId, message);
      }
    }
  }
  const retrievedSources = [...sources.values()].slice(0, 16);
  const metaNotes = database.listMetaNotes(thread.projectId, thread.branchId, 12);
  const memory = database.memoryStatus(thread.projectId, thread.branchId);
  const currentScene = sceneItems[0] ?? null;

  const sections = [
    '# Story context bundle',
    'This is a fiction-only conversation. Do not inspect files, run commands, invoke tools, or switch to coding work. Treat this bundle as the authoritative continuity context for this turn. Do not claim that a character knows or witnessed something unless a source-linked record establishes it. If retrieved history does not support a detail, say you are uncertain or ask the user.',
    `\n## Project: ${project.name}\nProject instructions:\n${cleanText(project.instructions) || '(none)'}\nStyle preferences:\n${cleanText(project.style) || '(none)'}`,
    `\n## Branch and thread\nBranch: ${thread.branchName} (${thread.branchId})\nThread: ${thread.title} (${thread.id})\nIndex state: ${memory.state}${memory.lastIndexed ? ` · last indexed source ${memory.lastIndexed.id}` : ''}`,
    `\n## Latest scene state\n${currentScene ? formatLedger(currentScene) : 'No source-backed scene state is recorded yet.'}`,
    `\n## Relevant canon and knowledge boundaries\n${selectedLedger.length ? selectedLedger.map(formatLedger).join('\n') : 'No relevant ledger entries were retrieved.'}`,
    `\n## Retrieved source messages\n${retrievedSources.length ? retrievedSources.map((message) => formatSource(message, terms)).join('\n\n') : 'No matching historical source message was found. Do not invent an earlier event.'}`,
    `\n## Recent raw turns in this thread\n${transcript.length ? transcript.map((message) => formatSource(message, terms)).join('\n\n') : 'This thread has no earlier story turns.'}`,
    `\n## Out-of-story notes\n${metaNotes.length ? metaNotes.map((note) => `- ${note.content} [source message:${note.messageId}]`).join('\n') : '(none)'}`,
    `\n## Current user message\nSource message ID: ${currentMessage.id}\n${currentMessage.content}`
  ];
  return {
    text: sections.join('\n'),
    sourceMessageIds: retrievedSources.map((message) => message.id),
    ledgerItemIds: selectedLedger.map((item) => item.id),
    memoryState: memory.state,
    currentScene
  };
}

export function buildLedgerExtractionPrompt(messages) {
  const validIds = messages.map((message) => message.id);
  const sourceText = messages.map((message) =>
    `SOURCE ${message.id} (${message.role}):\n${message.content}`
  ).join('\n\n');
  return {
    validIds,
    text: `Extract only concrete, continuity-relevant information stated in these saved story messages. Do not infer unstated events, promises, motives, power limits, or knowledge. Keep character claims and rumors separate from objective facts. Plans and promises are not completed events. If the messages establish nothing durable, return an empty entries array. Every entry must cite one or more exact source message IDs from this input.\n\n${sourceText}`
  };
}

export const LEDGER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['event', 'character', 'relationship', 'rule', 'possession', 'scene', 'thread', 'obligation', 'evidence', 'resource'] },
          subject: { type: 'string' },
          content: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
          origin: { type: 'string', enum: ['user_established', 'assistant_established', 'claim_or_rumor', 'hypothesis'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          status: { type: 'string', enum: ['current', 'uncertain', 'resolved', 'abandoned'] },
          sourceMessageIds: { type: 'array', items: { type: 'string' }, minItems: 1 }
        },
        required: ['type', 'subject', 'content', 'details', 'origin', 'confidence', 'status', 'sourceMessageIds'],
        additionalProperties: false
      }
    }
  },
  required: ['entries'],
  additionalProperties: false
};

