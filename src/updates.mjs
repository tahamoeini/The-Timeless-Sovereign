const RELEASES_API_URL = 'https://api.github.com/repos/tahamoeini/The-Timeless-Sovereign/releases/latest';
const RELEASE_PAGE_PREFIX = 'https://github.com/tahamoeini/The-Timeless-Sovereign/releases/';
const INSTALLER_NAME = /^The-Timeless-Sovereign-Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.exe$/;

function parseVersion(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('The release version is not a valid semantic version.');
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function trustedReleaseUrl(value, prefix, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.href.startsWith(prefix)) {
    throw new Error(`The release ${label} did not come from this project's GitHub releases.`);
  }
  return url.href;
}

export async function checkForUpdates({ currentVersion, fetchImpl = fetch, endpoint = RELEASES_API_URL } = {}) {
  if (!parseVersion(currentVersion)) throw new Error('The installed app version is not valid.');
  const apiUrl = new URL(endpoint);
  if (apiUrl.protocol !== 'https:' || apiUrl.hostname !== 'api.github.com' || apiUrl.pathname !== '/repos/tahamoeini/The-Timeless-Sovereign/releases/latest') {
    throw new Error('The update service must use the official HTTPS GitHub releases endpoint.');
  }

  const response = await fetchImpl(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'The-Timeless-Sovereign-Story-Studio'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (response.status === 404) {
    return { state: 'not_published', currentVersion, message: 'No public Story Studio release is available yet.' };
  }
  if (!response.ok) throw new Error(`GitHub could not check for updates (HTTP ${response.status}).`);

  const release = await response.json();
  if (release?.draft || release?.prerelease) return { state: 'not_published', currentVersion, message: 'No public stable Story Studio release is available yet.' };
  const latestVersion = String(release?.tag_name ?? '').replace(/^v/, '');
  if (!parseVersion(latestVersion)) throw new Error('The latest GitHub release has an invalid version tag.');
  const releaseUrl = trustedReleaseUrl(release.html_url, RELEASE_PAGE_PREFIX, 'page URL');
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => INSTALLER_NAME.test(String(item.name ?? '')) && String(item.name).includes(latestVersion))
    : null;
  if (!asset) throw new Error(`Release ${latestVersion} does not include the Windows installer.`);
  const downloadUrl = trustedReleaseUrl(asset.browser_download_url, `${RELEASE_PAGE_PREFIX}download/`, 'installer URL');
  const digest = /^sha256:[0-9a-f]{64}$/i.test(String(asset.digest ?? '')) ? asset.digest.slice(7).toLowerCase() : null;
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

  return {
    state: updateAvailable ? 'update_available' : 'up_to_date',
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseUrl,
    downloadUrl,
    sha256: digest,
    publishedAt: String(release.published_at ?? ''),
    notes: String(release.body ?? '').slice(0, 8000),
    message: updateAvailable ? `Version ${latestVersion} is available.` : 'You are using the latest version.'
  };
}

export { RELEASES_API_URL };
