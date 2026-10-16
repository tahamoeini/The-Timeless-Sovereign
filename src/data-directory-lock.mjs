import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function acquireDataDirectoryLock(dataDirectory) {
  const resolvedDirectory = fs.realpathSync(dataDirectory);
  const lockPath = path.join(resolvedDirectory, '.story-studio.lock');
  const token = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, contents, 'utf8');
      return () => {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (current.token === token && current.pid === process.pid) fs.unlinkSync(lockPath);
        } catch { /* another owner or cleanup already removed it */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
      catch {
        throw new Error('The Story Studio data directory is locked or has an unreadable lock file. Close the other app instance before continuing.');
      }
      if (processIsRunning(Number(existing.pid))) {
        throw new Error('The Story Studio data directory is already in use by another app instance. Close it before launching this one.');
      }
      try { fs.unlinkSync(lockPath); }
      catch {
        throw new Error('The Story Studio data directory is locked. Close the other app instance before continuing.');
      }
    }
  }
  throw new Error('The Story Studio data directory could not be locked. Close the other app instance before continuing.');
}
