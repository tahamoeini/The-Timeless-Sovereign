import test from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdates } from '../src/updates.mjs';

const installerName = 'The-Timeless-Sovereign-Setup-1.2.0.exe';
const digest = `sha256:${'a'.repeat(64)}`;

function release(overrides = {}) {
  return {
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.0',
    html_url: 'https://github.com/tahamoeini/The-Timeless-Sovereign/releases/tag/v1.2.0',
    published_at: '2026-10-16T00:00:00Z',
    body: 'A new story view.',
    assets: [{
      name: installerName,
      browser_download_url: `https://github.com/tahamoeini/The-Timeless-Sovereign/releases/download/v1.2.0/${installerName}`,
      digest
    }],
    ...overrides
  };
}

function response(status, data) {
  return { status, ok: status >= 200 && status < 300, async json() { return data; } };
}

test('checks the public release metadata and returns a trusted Windows installer link', async () => {
  let request;
  const result = await checkForUpdates({
    currentVersion: '1.1.0',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return response(200, release());
    }
  });

  assert.equal(request.url, 'https://api.github.com/repos/tahamoeini/The-Timeless-Sovereign/releases/latest');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(result.state, 'update_available');
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.downloadUrl.endsWith(installerName), true);
  assert.equal(result.sha256, 'a'.repeat(64));
  assert.equal(result.notes, 'A new story view.');
});

test('reports no public release and does not attempt to download an asset', async () => {
  const result = await checkForUpdates({ currentVersion: '1.1.0', fetchImpl: async () => response(404, {}) });
  assert.equal(result.state, 'not_published');
  assert.equal(result.updateAvailable, undefined);
});

test('rejects an installer URL that leaves the project release host', async () => {
  await assert.rejects(checkForUpdates({
    currentVersion: '1.1.0',
    fetchImpl: async () => response(200, release({ assets: [{
      name: installerName,
      browser_download_url: `https://updates.example/${installerName}`,
      digest
    }] }))
  }), /did not come from this project's GitHub releases/);
});

test('rejects update endpoints other than the official HTTPS release endpoint', async () => {
  await assert.rejects(checkForUpdates({
    currentVersion: '1.1.0', endpoint: 'http://127.0.0.1/release', fetchImpl: async () => response(200, release())
  }), /official HTTPS GitHub releases endpoint/);
});

test('reports the installed release as current when versions match', async () => {
  const result = await checkForUpdates({ currentVersion: '1.2.0', fetchImpl: async () => response(200, release()) });
  assert.equal(result.state, 'up_to_date');
  assert.equal(result.updateAvailable, false);
});
