import { buildLedgerExtractionPrompt, LEDGER_OUTPUT_SCHEMA } from './context.mjs';

const VALID_TYPES = new Set(['event', 'character', 'relationship', 'rule', 'possession', 'scene', 'thread', 'obligation', 'evidence', 'resource']);
const VALID_ORIGINS = new Set(['user_established', 'assistant_established', 'claim_or_rumor', 'hypothesis']);
const VALID_STATUSES = new Set(['current', 'uncertain', 'resolved', 'abandoned']);

function parseStructuredOutput(text) {
  const raw = String(text ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  try {
    return JSON.parse(fenced ? fenced[1] : raw);
  } catch {
    throw new Error('Continuity indexing did not return valid structured data.');
  }
}

function normalizeDetails(details) {
  if (!Array.isArray(details)) throw new Error('Continuity indexing returned details in an unsupported format.');
  const normalized = Object.create(null);
  for (const detail of details) {
    const key = String(detail?.key ?? '').trim();
    const value = String(detail?.value ?? '').trim();
    if (['__proto__', 'constructor', 'prototype'].includes(key.toLowerCase())) {
      continue;
    }
    if (!key || !value) continue;
    normalized[key] = normalized[key] ? `${normalized[key]}, ${value}` : value;
  }
  return normalized;
}

function validateEntries(payload, messages) {
  if (!payload || !Array.isArray(payload.entries)) throw new Error('Continuity indexing returned no entries array.');
  const allowedIds = new Set(messages.map((message) => message.id));
  return payload.entries.map((entry) => {
    if (!VALID_TYPES.has(entry.type) || !VALID_ORIGINS.has(entry.origin) || !VALID_STATUSES.has(entry.status)) {
      throw new Error('Continuity indexing returned an unsupported record type or certainty label.');
    }
    if (!String(entry.subject ?? '').trim() || !String(entry.content ?? '').trim() || !Array.isArray(entry.sourceMessageIds) || !entry.sourceMessageIds.length) {
      throw new Error('Continuity indexing returned an incomplete record.');
    }
    if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
      throw new Error('Continuity indexing returned an invalid confidence value.');
    }
    if (entry.sourceMessageIds.some((id) => !allowedIds.has(id))) {
      throw new Error('Continuity indexing cited a message outside the submitted source records.');
    }
    const citedRoles = new Set(messages.filter((message) => entry.sourceMessageIds.includes(message.id)).map((message) => message.role));
    if (entry.origin === 'user_established' && !citedRoles.has('user')) {
      throw new Error('A user-established fact must cite a user message.');
    }
    if (entry.origin === 'assistant_established' && !citedRoles.has('assistant')) {
      throw new Error('An assistant-established fact must cite an assistant message.');
    }
    return {
      type: entry.type,
      subject: String(entry.subject).trim(),
      content: String(entry.content).trim(),
      details: normalizeDetails(entry.details),
      origin: entry.origin,
      confidence: entry.confidence,
      status: entry.status,
      sourceMessageIds: [...new Set(entry.sourceMessageIds)]
    };
  });
}

export class MemoryIndexer {
  constructor({ database, codex, getModel = () => null, developerInstructions }) {
    this.database = database;
    this.codex = codex;
    this.getModel = getModel;
    this.developerInstructions = developerInstructions ?? 'You are a conservative continuity indexer. Use only the supplied source messages. Never create an event from a plan, promise, rumor, or hypothesis. Cite exact source IDs. Return only the requested JSON schema.';
    this.running = new Set();
    this.pendingRuns = new Map();
    this.paused = false;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  hasActiveJobs() {
    return this.running.size > 0;
  }

  async processMessage(messageId) {
    if (this.paused) return { state: 'pending', message: 'Continuity indexing is paused for recovery.' };
    if (this.running.has(messageId)) return { state: 'processing' };
    const job = this.database.getMemoryJobForMessage(messageId);
    if (!job) return { state: 'missing' };
    if (job.status === 'indexed') return { state: 'indexed' };
    if (!this.codex.getConnectionStatus || this.codex.getConnectionStatus().state !== 'connected') {
      return { state: 'pending', message: 'Memory indexing will retry after Codex reconnects.' };
    }
    this.running.add(messageId);
    try {
      this.database.markMemoryJobProcessing(job.id);
      const userMessage = this.database.getMessage(job.messageId);
      const assistantMessage = job.assistantMessageId ? this.database.getMessage(job.assistantMessageId) : null;
      const messages = [userMessage, assistantMessage].filter((message) => message && message.content);
      const request = buildLedgerExtractionPrompt(messages);
      const indexerThreadId = await this.codex.startThread({
        model: this.getModel(),
        developerInstructions: this.developerInstructions,
        ephemeral: true
      });
      const response = await this.codex.streamTurn({
        threadId: indexerThreadId,
        text: request.text,
        model: this.getModel(),
        outputSchema: LEDGER_OUTPUT_SCHEMA
      });
      const entries = validateEntries(parseStructuredOutput(response.text), messages);
      this.database.commitMemoryJob(job.id, entries);
      return { state: 'indexed', entries: entries.length };
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/Codex app-server stopped\./i.test(message)) {
        this.database.markMemoryJobPending(job.id);
        return { state: 'pending', message: 'Memory indexing will resume after the Codex connection is available.' };
      }
      this.database.markMemoryJobError(job.id, message);
      return { state: 'error', error: message };
    } finally {
      this.running.delete(messageId);
    }
  }

  async processRecent(limit = 8) {
    if (this.paused) return [];
    const jobs = this.database.listMemoryJobs(null, null, false)
      .filter((job) => (job.status === 'pending' || job.status === 'error') && !this.running.has(job.messageId))
      .slice(0, Math.max(1, limit));
    const results = [];
    for (const job of jobs) results.push({ messageId: job.messageId, ...await this.processMessage(job.messageId) });
    return results;
  }

  processPending(projectId = null) {
    if (this.paused) return Promise.resolve([]);
    const key = projectId ?? '*';
    const existing = this.pendingRuns.get(key);
    if (existing) return existing;
    let task;
    task = this.processPendingJobs(projectId).finally(() => {
      if (this.pendingRuns.get(key) === task) this.pendingRuns.delete(key);
    });
    this.pendingRuns.set(key, task);
    return task;
  }

  async processPendingJobs(projectId) {
    if (this.paused) return [];
    const jobs = this.database.listMemoryJobs(projectId, null, false)
      .filter((job) => (job.status === 'pending' || job.status === 'error') && !this.running.has(job.messageId));
    const results = [];
    for (const job of jobs) results.push({ messageId: job.messageId, ...await this.processMessage(job.messageId) });
    return results;
  }

  retry(projectId = null) {
    return this.database.retryMemoryJobs(projectId);
  }
}

