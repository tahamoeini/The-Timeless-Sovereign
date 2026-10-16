import { chmodSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: projectDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  }).trim();
}

try {
  const repositoryRoot = git(['rev-parse', '--show-toplevel']);
  const hooksPath = path.resolve(repositoryRoot, '.githooks');
  const configuredPath = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (configuredPath.status === 0) {
    const currentPath = path.resolve(repositoryRoot, configuredPath.stdout.trim());
    if (currentPath !== hooksPath) {
      throw new Error(`Git already uses another hooks folder: ${configuredPath.stdout.trim()}. Remove or combine it before enabling Story Studio's hooks.`);
    }
  } else if (configuredPath.status !== 1) {
    throw new Error(configuredPath.stderr.trim() || 'Could not read the current Git hooks setting.');
  }

  for (const hookName of ['commit-msg', 'prepare-commit-msg']) {
    const hookPath = path.join(hooksPath, hookName);
    if (!existsSync(hookPath)) throw new Error(`Required hook file is missing: ${hookPath}`);
    if (process.platform !== 'win32') chmodSync(hookPath, 0o755);
  }

  git(['config', '--local', 'core.hooksPath', '.githooks']);
  console.log('Story Studio commit versioning is enabled for this repository.');
  console.log('feat bumps minor, fix and other commits bump patch, and breaking changes bump major.');
} catch (error) {
  console.error(`Could not enable Story Studio Git hooks: ${error.message}`);
  process.exitCode = 1;
}
