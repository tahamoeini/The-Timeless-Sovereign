import { appendFileSync, closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const [serverPath, logPath] = process.argv.slice(2);

if (!serverPath || !logPath) {
  process.stderr.write('The Windows launcher requires a server path and a startup log path.\n');
  process.exit(2);
}

try {
  appendFileSync(logPath, `\r\n[${new Date().toISOString()}] Starting Story Studio.\r\n`, 'utf8');
  const logDescriptor = openSync(logPath, 'a');
  let serverProcess;

  try {
    serverProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath], {
      cwd: path.resolve(path.dirname(serverPath), '..'),
      detached: true,
      env: process.env,
      stdio: ['ignore', logDescriptor, logDescriptor],
      windowsHide: true
    });
  } finally {
    closeSync(logDescriptor);
  }

  serverProcess.once('error', (error) => {
    appendFileSync(logPath, `Failed to start the server process: ${error.stack ?? error}\r\n`, 'utf8');
    process.exitCode = 1;
  });
  serverProcess.once('spawn', () => {
    appendFileSync(logPath, `Server process started with PID ${serverProcess.pid}.\r\n`, 'utf8');
    serverProcess.unref();
  });
} catch (error) {
  try {
    appendFileSync(logPath, `Windows launcher failed: ${error.stack ?? error}\r\n`, 'utf8');
  } catch {
    process.stderr.write(`Windows launcher failed: ${error.message}\n`);
  }
  process.exitCode = 1;
}
