import { EventEmitter } from 'node:events';

export class JsonlRpcClient extends EventEmitter {
  constructor({ readable, writable, timeoutMs = 30_000, serverRequestHandler = null }) {
    super();
    this.readable = readable;
    this.writable = writable;
    this.timeoutMs = timeoutMs;
    this.serverRequestHandler = serverRequestHandler;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.readable.setEncoding?.('utf8');
    this.readable.on('data', (chunk) => this.consume(chunk));
    this.readable.on('end', () => this.close(new Error('Codex app-server closed its output stream.')));
    this.readable.on('error', (error) => this.close(error));
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('Codex app-server is not connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = undefined) {
    if (this.closed) throw new Error('Codex app-server is not connected.');
    const packet = params === undefined ? { method } : { method, params };
    this.write(packet);
  }

  write(packet) {
    const accepted = this.writable.write(`${JSON.stringify(packet)}\n`);
    if (!accepted) this.emit('backpressure');
  }

  consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 8_000_000 && !this.buffer.includes('\n')) {
      this.close(new Error('Codex app-server sent an oversized protocol message.'));
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  handleLine(line) {
    let packet;
    try {
      packet = JSON.parse(line);
    } catch {
      this.emit('protocolError', new Error('Codex app-server returned invalid JSON.'));
      return;
    }
    if (Object.hasOwn(packet, 'id') && (Object.hasOwn(packet, 'result') || Object.hasOwn(packet, 'error'))) {
      const pending = this.pending.get(packet.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(packet.id);
      if (packet.error) {
        const error = new Error(packet.error.message || `Codex app-server rejected ${pending.method}.`);
        error.code = packet.error.code;
        error.data = packet.error.data;
        pending.reject(error);
      } else {
        pending.resolve(packet.result);
      }
      return;
    }
    if (packet.method && Object.hasOwn(packet, 'id')) {
      this.handleServerRequest(packet);
      return;
    }
    if (packet.method) this.emit('notification', packet);
  }

  async handleServerRequest(packet) {
    try {
      const result = this.serverRequestHandler
        ? await this.serverRequestHandler(packet.method, packet.params ?? {})
        : null;
      if (result === null) {
        this.write({ id: packet.id, error: { code: -32601, message: 'This app does not support that app-server request.' } });
      } else {
        this.write({ id: packet.id, result });
      }
    } catch {
      this.write({ id: packet.id, error: { code: -32603, message: 'The app declined the unsupported app-server request.' } });
    }
  }

  close(reason = new Error('Codex app-server connection closed.')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.emit('close', reason);
  }
}
