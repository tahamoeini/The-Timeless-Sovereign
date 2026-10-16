import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, ...args] = process.argv.slice(2);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const git = (gitArgs) => execFileSync('git', gitArgs, {
  cwd: projectDirectory,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim();

function markerPath() {
  const identity = [projectDirectory, process.env.GIT_INDEX_FILE ?? '', process.env.GIT_DIR ?? ''].join('\n');
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), `story-studio-version-hook-${hash}.json`);
}

function prepareCommit(source) {
  const marker = markerPath();
  if (source === 'commit' || source === 'merge') {
    writeFileSync(marker, JSON.stringify({ source, createdAt: Date.now() }), 'utf8');
  } else {
    try { unlinkSync(marker); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function consumeSkippedCommit() {
  const marker = markerPath();
  try {
    const data = JSON.parse(readFileSync(marker, 'utf8'));
    unlinkSync(marker);
    return Date.now() - data.createdAt < 24 * 60 * 60 * 1000;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    try { unlinkSync(marker); } catch {}
    return false;
  }
}

function readVersion(source) {
  try {
    return JSON.parse(source).version;
  } catch {
    throw new Error('Could not read the version from package.json.');
  }
}

function getCommitBaseVersion(indexPackage) {
  const result = spawnSync('git', ['show', 'HEAD:package.json'], {
    cwd: projectDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status === 0) return readVersion(result.stdout);
  return indexPackage.version;
}

function classifyBump(message) {
  const header = message.split(/\r?\n/, 1)[0].trim();
  const conventional = /^([a-z][a-z0-9-]*)(?:\([^)\r\n]+\))?(!)?:\s+\S+/i.exec(header);
  const hasBreakingFooter = /^BREAKING(?: |-)CHANGE: \S/m.test(message);
  if (conventional?.[2] || hasBreakingFooter) return { level: 'major', type: conventional?.[1] ?? 'breaking change' };
  if (conventional?.[1].toLowerCase() === 'feat') return { level: 'minor', type: 'feat' };
  if (conventional?.[1].toLowerCase() === 'fix') return { level: 'patch', type: 'fix' };
  return { level: 'patch', type: conventional?.[1].toLowerCase() ?? 'unspecified' };
}

function bumpVersion(version, level) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version));
  if (!match) throw new Error(`package.json version "${version}" is not a supported semantic version.`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error('The package version exceeds the supported numeric range.');

  if (level === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === 'minor') {
    minor += 1;
    patch = 0;
  } else if (!match[4]) {
    patch += 1;
  }
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error('The next package version exceeds the supported numeric range.');
  return `${major}.${minor}.${patch}`;
}

function stageVersionBump(commitMessagePath) {
  const messagePath = path.isAbsolute(commitMessagePath)
    ? commitMessagePath
    : path.resolve(projectDirectory, commitMessagePath);
  const message = readFileSync(messagePath, 'utf8');
  const subject = message.split(/\r?\n/, 1)[0].trim();
  if (/^Merge\s/i.test(subject)) {
    console.log('Merge commit detected; package version was left unchanged.');
    return;
  }

  const unstagedPackageChanges = spawnSync('git', ['diff', '--quiet', '--', 'package.json'], {
    cwd: projectDirectory,
    stdio: 'ignore'
  });
  if (unstagedPackageChanges.status === 1) {
    throw new Error('package.json has unstaged edits. Stage those edits before committing so the version hook does not stage unrelated changes.');
  }
  if (unstagedPackageChanges.status !== 0) throw new Error('Could not check package.json for unstaged edits.');

  const indexPackageText = git(['show', ':package.json']);
  const indexPackage = JSON.parse(indexPackageText);
  const baseVersion = getCommitBaseVersion(indexPackage);
  if (indexPackage.version !== baseVersion) {
    console.log(`package.json already has version ${indexPackage.version} staged; leaving it unchanged to avoid a duplicate bump.`);
    return;
  }

  const { level, type } = classifyBump(message);
  const nextVersion = bumpVersion(indexPackage.version, level);
  indexPackage.version = nextVersion;

  const packageFile = path.join(projectDirectory, 'package.json');
  const original = readFileSync(packageFile, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = original.endsWith('\n');
  const serialized = JSON.stringify(indexPackage, null, 2).replace(/\n/g, newline);
  writeFileSync(packageFile, `${serialized}${finalNewline ? newline : ''}`, 'utf8');
  git(['add', '--', 'package.json']);
  console.log(`Bumped package.json from ${baseVersion} to ${nextVersion} (${type} → ${level}).`);
}

try {
  if (mode === 'prepare') {
    prepareCommit(args[1] ?? '');
  } else if (mode === 'commit') {
    if (consumeSkippedCommit()) {
      console.log('Amended or merge commit detected; no additional version bump was made.');
    } else if (!args[0]) {
      throw new Error('Git did not provide the commit message file.');
    } else {
      stageVersionBump(args[0]);
    }
  } else {
    throw new Error('Unknown version hook mode.');
  }
} catch (error) {
  console.error(`Version bump failed: ${error.message}`);
  process.exitCode = 1;
}
