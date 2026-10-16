const COMMANDS = new Set(['meta', 'pause', 'resume', 'recap', 'status', 'character', 'retcon', 'scene', 'style', 'checkpoint']);
const CHARACTER_FIELDS = new Set(['aliases', 'role', 'location', 'goals', 'condition', 'knowledge', 'injuries', 'possessions', 'relationships', 'secrets']);
const SCENE_FIELDS = new Set(['location', 'time', 'participants', 'conditions']);

function parseCommand(content) {
  if (!String(content).startsWith('/')) return null;
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(String(content).trim());
  if (!match) return { name: '', args: '', raw: String(content), malformed: true };
  return { name: match[1].toLowerCase(), args: match[2] ?? '', raw: String(content) };
}

function tokenize(input) {
  const parts = String(input).match(/(?:[^\s="']+=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/g) ?? [];
  return parts.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1).replace(/\\([\\"'])/g, '$1');
    }
    return part;
  });
}

function assignments(tokens, allowed) {
  const values = {};
  for (const token of tokens) {
    const equals = token.indexOf('=');
    if (equals < 1) throw new Error(`Use field=value for each setting. Invalid value: ${token}`);
    const key = token.slice(0, equals).toLowerCase();
    let value = token.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\([\\"'])/g, '$1');
    }
    if (!allowed.has(key)) throw new Error(`Unknown field "${key}". Available fields: ${[...allowed].join(', ')}.`);
    if (!value) throw new Error(`The value for "${key}" cannot be empty.`);
    values[key] = value;
  }
  if (!Object.keys(values).length) throw new Error('Add at least one field=value setting.');
  return values;
}

function formatEntry(item) {
  return `• ${item.subject}: ${item.content}\n  ${item.origin} · ${item.status} · confidence ${item.confidence}\n  Sources: ${item.sourceMessageIds.join(', ') || 'none'} (record ${item.id})`;
}

function threadLabel(thread) {
  return `${thread.title} · ${thread.branchName}${thread.paused ? ' · paused' : ''}`;
}

export class CommandProcessor {
  constructor(database) {
    this.database = database;
  }

  isCommand(content) {
    return parseCommand(content) !== null;
  }

  process(threadId, content) {
    const parsed = parseCommand(content);
    if (!parsed) return null;
    const userMessage = this.database.addCommandMessage(threadId, content);
    const thread = this.database.getThread(threadId);
    if (parsed.malformed || !COMMANDS.has(parsed.name)) {
      const output = parsed.malformed
        ? 'Command format is incomplete. Start with a command name, for example /status.'
        : `Unknown command: /${parsed.name || '?'}. Available commands: ${[...COMMANDS].map((name) => `/${name}`).join(', ')}.`;
      return this.finish(threadId, userMessage, output);
    }

    try {
      const output = this[`command_${parsed.name}`](thread, userMessage, parsed.args, parsed.raw);
      return this.finish(threadId, userMessage, output);
    } catch (error) {
      return this.finish(threadId, userMessage, `${error.message}\n\n${this.usage(parsed.name)}`);
    }
  }

  finish(threadId, userMessage, output) {
    const activity = this.database.addSystemActivity(threadId, output, 'command');
    return { handled: true, userMessage, activity, output };
  }

  command_meta(thread, userMessage, args) {
    const note = String(args).trim();
    if (!note) throw new Error('Add the out-of-story note you want the next response to follow.');
    this.database.addMetaNote(thread.id, userMessage.id, note);
    const scope = this.database.getProject(thread.projectId).memoryScope;
    return `Meta note saved ${scope === 'thread' ? 'to this conversation' : 'for this project branch'}. It will be included in the next story response.\nSource message: ${userMessage.id}`;
  }

  command_pause(thread, _userMessage, args) {
    this.requireNoArgs(args, '/pause');
    this.database.setThreadPaused(thread.id, true);
    return `Paused ${threadLabel(thread)}. Use /resume before continuing the scene.`;
  }

  command_resume(thread, _userMessage, args) {
    this.requireNoArgs(args, '/resume');
    this.database.setThreadPaused(thread.id, false);
    return `Resumed ${thread.title} on the ${thread.branchName} branch.`;
  }

  command_status(thread, _userMessage, args) {
    this.requireNoArgs(args, '/status');
    const ledger = this.visibleLedger(thread);
    const memory = this.visibleMemoryStatus(thread);
    const scene = ledger.find((item) => item.type === 'scene');
    const characters = ledger.filter((item) => item.type === 'character');
    const openThreads = ledger.filter((item) => item.type === 'thread' && ['current', 'uncertain'].includes(item.status));
    const powers = ledger.filter((item) => item.type === 'rule');
    return [
      `Project: ${thread.projectName}`,
      `Thread: ${thread.title}`,
      `Branch: ${thread.branchName}${thread.paused ? ' (paused)' : ''}`,
      `Memory scope: ${this.memoryScope(thread) === 'thread' ? 'this conversation' : 'all chats in this project'}`,
      `Memory: ${memory.state}${memory.lastIndexed ? ` · last indexed source ${memory.lastIndexed.id}` : ''}${memory.error ? ` · ${memory.error}` : ''}`,
      `Scene: ${scene ? `${scene.content} [${scene.sourceMessageIds.join(', ')}]` : 'not recorded'}`,
      `Characters: ${characters.length ? characters.map((item) => item.subject).join(', ') : 'none recorded'}`,
      `Active powers and rules: ${powers.length ? powers.map((item) => item.subject).join(', ') : 'none recorded'}`,
      `Open threads: ${openThreads.length ? openThreads.map((item) => item.subject).join(', ') : 'none recorded'}`
    ].join('\n');
  }

  command_recap(thread, _userMessage, args) {
    this.requireNoArgs(args, '/recap');
    const ledger = this.visibleLedger(thread);
    const certain = ledger.filter((item) => item.status === 'current');
    const uncertain = ledger.filter((item) => item.status === 'uncertain');
    const recent = this.database.getTranscript(thread.id)
      .filter((message) => message.kind === 'story' && (this.memoryScope(thread) === 'project' || message.threadId === thread.id))
      .slice(-6);
    const sections = ['Source-backed recap (no scene advancement):'];
    if (certain.length) sections.push(`\nCurrent canon:\n${certain.slice(0, 30).map(formatEntry).join('\n')}`);
    else sections.push('\nNo durable canon records have been indexed yet.');
    if (uncertain.length) sections.push(`\nUncertain claims or hypotheses:\n${uncertain.slice(0, 20).map(formatEntry).join('\n')}`);
    if (recent.length) sections.push(`\nRecent raw turns:\n${recent.map((message) => {
      const excerpt = message.content.length > 900 ? `${message.content.slice(0, 900)}… [excerpt]` : message.content;
      return `- ${message.role} [message:${message.id}]: ${excerpt}`;
    }).join('\n')}`);
    return sections.join('\n');
  }

  command_character(thread, userMessage, args) {
    const tokens = tokenize(args);
    const action = (tokens[0] ?? '').toLowerCase();
    if (action === 'add') {
      const name = tokens[1];
      if (!name) throw new Error('A character name is required.');
      const values = assignments(tokens.slice(2), CHARACTER_FIELDS);
      const details = { ...values };
      const current = this.findCharacter(thread, name);
      const content = `Character profile for ${name}.`;
      const item = current
        ? this.database.updateLedgerItem(thread.projectId, thread.branchId, current.id, { content, details }, userMessage.id).item
        : this.database.appendLedgerItem({
          projectId: thread.projectId, branchId: thread.branchId, type: 'character', subject: name, content,
          details, origin: 'user_established', confidence: 1, status: 'current', sourceMessageIds: [userMessage.id]
        });
      return `${current ? 'Updated' : 'Added'} character profile for ${name}.\n${formatEntry(item)}`;
    }
    if (action === 'set') {
      const name = tokens[1];
      if (!name) throw new Error('A character name is required.');
      const current = this.findCharacter(thread, name);
      if (!current) throw new Error(`No character named "${name}" is recorded in this branch.`);
      const values = assignments(tokens.slice(2), CHARACTER_FIELDS);
      const item = this.database.updateLedgerItem(thread.projectId, thread.branchId, current.id, {
        content: current.content,
        details: { ...current.details, ...values }
      }, userMessage.id).item;
      return `Updated character profile for ${name}.\n${formatEntry(item)}`;
    }
    const name = action === 'show' ? tokens.slice(1).join(' ') : tokens.join(' ');
    if (!name) throw new Error('A character name is required.');
    const character = this.findCharacter(thread, name);
    if (!character) return `No character named "${name}" is recorded in this branch.`;
    return `Character profile · ${character.subject}\n${formatEntry(character)}\nDetails: ${JSON.stringify(character.details)}`;
  }

  command_retcon(thread, userMessage, _args, raw) {
    const match = /^\/retcon\s+(\S+)\s+--\s+([\s\S]+)$/i.exec(raw.trim());
    if (!match) throw new Error('A ledger record ID and correction are required.');
    const correction = match[2].trim();
    if (!correction) throw new Error('The correction text cannot be empty.');
    if (!this.visibleLedger(thread, { includeSuperseded: true }).some((item) => item.id === match[1])) {
      throw new Error('That continuity record is outside this conversation’s memory scope or branch timeline.');
    }
    const result = this.database.retconLedgerItem(thread.projectId, thread.branchId, match[1], correction, userMessage.id);
    return `Correction recorded. The earlier record remains in the audit history and is superseded on this branch.\nEarlier record: ${match[1]}\nNew record: ${result.item.id}\nSource message: ${userMessage.id}`;
  }

  command_scene(thread, userMessage, args) {
    const tokens = tokenize(args);
    const action = (tokens[0] ?? 'show').toLowerCase();
    const current = this.visibleLedger(thread).find((item) => item.type === 'scene');
    if (action === 'show') {
      if (tokens.length > 1) throw new Error('/scene show does not take additional arguments.');
      return current ? `Current scene\n${formatEntry(current)}\nDetails: ${JSON.stringify(current.details)}` : 'No current scene has been recorded.';
    }
    if (action !== 'set') throw new Error(`Unknown scene action "${action}".`);
    const values = assignments(tokens.slice(1), SCENE_FIELDS);
    const summary = Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('; ');
    const item = current
      ? this.database.updateLedgerItem(thread.projectId, thread.branchId, current.id, { content: summary, details: { ...current.details, ...values } }, userMessage.id).item
      : this.database.appendLedgerItem({
        projectId: thread.projectId, branchId: thread.branchId, type: 'scene', subject: 'Current scene', content: summary,
        details: values, origin: 'user_established', confidence: 1, status: 'current', sourceMessageIds: [userMessage.id]
      });
    return `Current scene updated for the ${thread.branchName} branch.\n${formatEntry(item)}`;
  }

  command_style(thread, userMessage, args) {
    const style = String(args).trim();
    const project = this.database.getProject(thread.projectId);
    if (!style) return `Current project style preferences:\n${project.style || '(none)'}`;
    this.database.updateProject(thread.projectId, { style }, userMessage.id);
    return `Project style preferences updated.\n${style}`;
  }

  command_checkpoint(thread, userMessage, args) {
    this.requireNoArgs(args, '/checkpoint');
    const project = this.database.getProject(thread.projectId);
    const ledger = this.visibleLedger(thread);
    const payload = {
      format: 'timeless-sovereign-checkpoint',
      version: 1,
      createdAt: new Date().toISOString(),
      project: { name: project.name, instructions: project.instructions, preferences: { style: project.style, memoryScope: project.memoryScope } },
      branch: { id: thread.branchId, name: thread.branchName, parentBranchId: thread.parentBranchId, forkMessageId: thread.forkMessageId },
      currentScene: ledger.find((item) => item.type === 'scene') ?? null,
      canon: ledger.filter((item) => item.status === 'current'),
      characters: ledger.filter((item) => item.type === 'character'),
      knowledgeBoundaries: ledger.filter((item) => item.type === 'claim_or_rumor' || item.type === 'hypothesis' || item.origin === 'claim_or_rumor' || item.origin === 'hypothesis'),
      openThreads: ledger.filter((item) => item.type === 'thread' && ['current', 'uncertain'].includes(item.status)),
      unresolvedObligations: ledger.filter((item) => item.type === 'obligation' && ['current', 'uncertain'].includes(item.status)),
      unknowns: ledger.filter((item) => item.status === 'uncertain').map((item) => ({ subject: item.subject, content: item.content, sources: item.sourceMessageIds })),
      sourceMessageIds: [...new Set(ledger.flatMap((item) => item.sourceMessageIds))],
      memoryStatus: this.visibleMemoryStatus(thread)
    };
    this.database.addCheckpoint(thread.id, userMessage.id, payload);
    return `Checkpoint created · ${payload.createdAt}\nCopy or export this portable record:\n\n${JSON.stringify(payload, null, 2)}`;
  }

  findCharacter(thread, name) {
    const key = String(name).toLocaleLowerCase();
    return this.visibleLedger(thread)
      .find((item) => item.type === 'character' && (item.subject.toLocaleLowerCase() === key ||
        (Array.isArray(item.details.aliases) ? item.details.aliases : String(item.details.aliases ?? '').split(/[,|]/))
          .some((alias) => String(alias).trim().toLocaleLowerCase() === key))) ?? null;
  }

  memoryScope(thread) {
    return this.database.getProject(thread.projectId)?.memoryScope === 'thread' ? 'thread' : 'project';
  }

  visibleLedger(thread, { includeSuperseded = false } = {}) {
    const rows = includeSuperseded
      ? this.database.getLedgerItems(thread.projectId, thread.branchId, { includeSuperseded: true })
      : this.database.getEffectiveLedger(thread.projectId, thread.branchId);
    if (this.memoryScope(thread) === 'project') return rows;
    return rows.filter((item) => item.sourceMessageIds.length > 0 && item.sourceMessageIds.every((id) =>
      this.database.getMessage(id)?.threadId === thread.id
    ));
  }

  visibleMemoryStatus(thread) {
    return this.memoryScope(thread) === 'thread'
      ? this.database.memoryStatusForThread(thread.id)
      : this.database.memoryStatus(thread.projectId, thread.branchId);
  }

  requireNoArgs(args, command) {
    if (String(args).trim()) throw new Error(`${command} does not take arguments.`);
  }

  usage(command) {
    const usage = {
      meta: '/meta <out-of-story note>',
      pause: '/pause',
      resume: '/resume',
      recap: '/recap',
      status: '/status',
      character: '/character show <name> | /character add <name> field=value... | /character set <name> field=value...',
      retcon: '/retcon <ledger-record-id> -- <correction>',
      scene: '/scene show | /scene set location=value time=value participants=value conditions=value',
      style: '/style <project-wide style preferences>',
      checkpoint: '/checkpoint'
    };
    return `Usage: ${usage[command] ?? `/${command}`}`;
  }
}

export { parseCommand };

