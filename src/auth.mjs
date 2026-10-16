import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AUTHORIZE_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const OIDC_ENDPOINT = 'https://auth.openai.com/.well-known/openid-configuration';
const RESOURCE = 'https://api.openai.com/v1';
const REQUIRED_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const APP_NAME = 'The Timeless Sovereign Story Studio';

export class AuthError extends Error {
  constructor(message, state = 'error') {
    super(message);
    this.name = 'AuthError';
    this.state = state;
  }
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function parseJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new AuthError('The identity token is malformed.', 'identity_error');
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      claims: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], 'base64url')
    };
  } catch {
    throw new AuthError('The identity token could not be decoded.', 'identity_error');
  }
}

function scopesFrom(value) {
  return [...new Set(String(value ?? '').split(/\s+/).filter(Boolean))];
}

function requireScopes(scopes) {
  const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new AuthError(`ChatGPT-plan authorization did not grant required scopes: ${missing.join(', ')}.`, 'scope_missing');
}

function safeTokenError(response, body) {
  const code = body?.error ?? `http_${response.status}`;
  if (code === 'invalid_grant') return 'The authorization code or refresh token is no longer valid. Start a new ChatGPT sign-in.';
  if (response.status === 401 || response.status === 403) return 'ChatGPT-plan authorization was denied. No API-key billing fallback is enabled.';
  return `OpenAI authorization could not be completed (${code}).`;
}

async function readResponseJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return body;
}

export class WindowsDpapiCredentialStore {
  constructor(filePath, spawnSyncImpl = execFileSync) {
    this.filePath = filePath;
    this.spawnSyncImpl = spawnSyncImpl;
  }

  read() {
    const script = this.dpapiScript(`
$encrypted = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($encrypted)
$plain = [StoryStudioDpapi]::Unprotect($cipher)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`);
    const candidates = this.credentialFiles();
    if (!candidates.length) return null;
    let lastError = null;
    for (const filename of candidates) {
      try {
        const encrypted = fs.readFileSync(filename, 'utf8');
        return JSON.parse(this.runPowerShell(script, encrypted));
      } catch (error) { lastError = error; }
    }
    throw new Error(lastError instanceof Error ? 'The protected ChatGPT credential record is unreadable.' : 'The protected ChatGPT credential record is unreadable.');
  }

  write(credential) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const plain = JSON.stringify(credential);
    const script = this.dpapiScript(`
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [StoryStudioDpapi]::Protect($bytes)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`);
    const encrypted = this.runPowerShell(script, plain);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const slotPath = `${this.filePath}.${Date.now()}-${randomUUID()}.slot`;
    fs.writeFileSync(slotPath, encrypted, { encoding: 'utf8', flag: 'wx' });
    let recovered;
    try { recovered = this.read(); }
    catch (error) {
      fs.rmSync(slotPath, { force: true });
      throw error;
    }
    if (recovered?.accessToken !== credential.accessToken || recovered?.refreshToken !== credential.refreshToken) {
      fs.rmSync(slotPath, { force: true });
      throw new Error('Windows could not verify the protected ChatGPT credential record.');
    }
    for (const filename of this.credentialFiles()) {
      if (filename !== slotPath) {
        try { fs.rmSync(filename, { force: true }); } catch { /* Retain an older encrypted slot if cleanup is unavailable. */ }
      }
    }
  }

  delete() {
    for (const filename of this.credentialFiles()) fs.rmSync(filename, { force: true });
  }

  credentialFiles() {
    const directory = path.dirname(this.filePath);
    if (!fs.existsSync(directory)) return [];
    const baseName = path.basename(this.filePath);
    const slots = fs.readdirSync(directory)
      .filter((name) => name.startsWith(`${baseName}.`) && name.endsWith('.slot'))
      .map((name) => path.join(directory, name));
    if (fs.existsSync(this.filePath)) slots.push(this.filePath);
    return slots.sort((first, second) => {
      const firstTime = fs.statSync(first).mtimeMs;
      const secondTime = fs.statSync(second).mtimeMs;
      return secondTime - firstTime;
    });
  }

  runPowerShell(script, input) {
    if (process.platform !== 'win32') throw new Error('Windows DPAPI credential storage is available only on Windows.');
    try {
      return this.spawnSyncImpl('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
      ], { input, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
    } catch {
      throw new Error('Windows could not protect or unlock the local ChatGPT credentials.');
    }
  }

  dpapiScript(body) {
    return `
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class StoryStudioDpapi {
  [StructLayout(LayoutKind.Sequential)]
  private struct DataBlob { public int Size; public IntPtr Data; }

  [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CryptProtectData(ref DataBlob input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

  [DllImport("crypt32.dll", SetLastError = true)]
  private static extern bool CryptUnprotectData(ref DataBlob input, out IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr LocalFree(IntPtr memory);

  public static byte[] Protect(byte[] value) { return Transform(value, true); }
  public static byte[] Unprotect(byte[] value) { return Transform(value, false); }

  private static byte[] Transform(byte[] value, bool protect) {
    GCHandle pinned = GCHandle.Alloc(value, GCHandleType.Pinned);
    DataBlob input = new DataBlob { Size = value.Length, Data = pinned.AddrOfPinnedObject() };
    DataBlob output = new DataBlob();
    IntPtr description = IntPtr.Zero;
    try {
      bool success = protect
        ? CryptProtectData(ref input, "The Timeless Sovereign Story Studio", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out output)
        : CryptUnprotectData(ref input, out description, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out output);
      if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] result = new byte[output.Size];
      Marshal.Copy(output.Data, result, 0, output.Size);
      return result;
    } finally {
      if (output.Data != IntPtr.Zero) LocalFree(output.Data);
      if (description != IntPtr.Zero) LocalFree(description);
      pinned.Free();
    }
  }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
${body.trim()}
`;
  }
}

export class AuthService {
  constructor({ dataDirectory, database, credentialStore = null, fetchImpl = fetch, clock = () => Date.now(), browserOpener = null }) {
    this.database = database;
    this.credentialStore = credentialStore ?? new WindowsDpapiCredentialStore(path.join(dataDirectory, 'credentials.dpapi'));
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.browserOpener = browserOpener;
    this.pendingAttempt = null;
    this.state = 'not_signed_in';
    this.stateMessage = 'Not connected. Sign in with ChatGPT to enable story generation.';
    this.refreshPromise = null;
    this.oidc = null;
    this.jwks = null;
    this.jwksFetchedAt = 0;
    this.hostId = this.database.getSetting('oauth.host_id');
    if (!this.hostId) {
      this.hostId = `urn:uuid:${randomUUID()}`;
      this.database.setSetting('oauth.host_id', this.hostId);
    }
  }

  async status() {
    if (this.pendingAttempt) return { state: 'signing_in', message: 'Complete Sign in with ChatGPT in your browser.' };
    try {
      const credential = this.credentialStore.read();
      if (!credential) return { state: this.state, message: this.stateMessage };
      requireScopes(credential.scopes ?? []);
      if (credential.expiresAt <= this.clock()) return { state: 'token_expired', message: 'ChatGPT authorization expired. Reconnect to refresh it.' };
      return { state: 'connected', message: 'Connected with ChatGPT-plan authorization.' };
    } catch (error) {
      if (error instanceof AuthError) return { state: error.state, message: error.message };
      return { state: 'credential_error', message: error.message };
    }
  }

  recordFailure(error) {
    this.state = error instanceof AuthError ? error.state : 'authorization_error';
    this.stateMessage = String(error?.message ?? 'ChatGPT authorization could not be completed.');
    this.pendingAttempt = null;
  }

  beginSignIn(redirectUri) {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirectUri)) {
      throw new AuthError('The sign-in callback must use the exact local 127.0.0.1 callback URI.', 'callback_error');
    }
    let previousCredential = null;
    try { previousCredential = this.credentialStore.read(); } catch { /* Show the storage issue in status; allow fresh sign-in. */ }
    const savedClientId = this.database.getSetting('oauth.client_id');
    const isRegistration = !savedClientId;
    const clientId = isRegistration ? 'dynamic_agent_client' : savedClientId;
    const state = randomSecret();
    const nonce = randomSecret();
    const verifier = randomSecret(48);
    const challenge = encodeBase64Url(createHash('sha256').update(verifier).digest());
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: REQUIRED_SCOPES.join(' '),
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      ext_agent_host_id: this.hostId
    });
    if (isRegistration) query.set('agent_name_hint', APP_NAME);
    if (previousCredential?.idToken) query.set('id_token_hint', previousCredential.idToken);
    if (previousCredential?.email) query.set('login_hint', previousCredential.email);
    this.pendingAttempt = {
      state,
      nonce,
      verifier,
      redirectUri,
      clientId,
      isRegistration,
      expectedSubject: previousCredential?.subject ?? null
    };
    this.state = 'signing_in';
    this.stateMessage = 'Complete Sign in with ChatGPT in your browser.';
    return { authorizationUrl: `${AUTHORIZE_ENDPOINT}?${query}`, redirectUri };
  }

  openBrowser(url) {
    if (this.browserOpener) return this.browserOpener(url);
    if (process.platform !== 'win32') return false;
    const { spawn } = process.getBuiltinModule('node:child_process');
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.unref();
    return true;
  }

  async handleCallback(callbackUrl) {
    const attempt = this.pendingAttempt;
    if (!attempt) throw new AuthError('There is no active ChatGPT sign-in attempt. Start a new sign-in.', 'callback_error');
    let url;
    try { url = new URL(callbackUrl, attempt.redirectUri); } catch { throw new AuthError('The sign-in callback URL is invalid.', 'callback_error'); }
    if (url.origin + url.pathname !== new URL(attempt.redirectUri).origin + '/auth/callback') {
      throw new AuthError('The sign-in callback URI did not match the active attempt.', 'callback_error');
    }
    const returnedState = url.searchParams.get('state') ?? '';
    if (!returnedState || !sameSecret(returnedState, attempt.state)) {
      throw new AuthError('The sign-in state check failed. Start a new sign-in.', 'state_mismatch');
    }
    this.pendingAttempt = null;
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      const denied = oauthError === 'access_denied';
      this.state = denied ? 'authorization_denied' : 'authorization_error';
      this.stateMessage = denied
        ? 'ChatGPT authorization was denied. The app remains disconnected.'
        : `ChatGPT authorization returned ${oauthError}. The app remains disconnected.`;
      throw new AuthError(this.stateMessage, this.state);
    }
    const code = url.searchParams.get('code');
    if (!code) throw new AuthError('The sign-in callback did not include an authorization code.', 'callback_error');
    const callbackClientId = url.searchParams.get('client_id');
    let clientId = attempt.clientId;
    if (attempt.isRegistration) {
      if (!callbackClientId || callbackClientId === 'dynamic_agent_client') {
        throw new AuthError('OpenAI did not return the issued client ID; registration is incomplete.', 'registration_incomplete');
      }
      clientId = callbackClientId;
      this.database.setSetting('oauth.client_id', clientId);
    } else if (callbackClientId && callbackClientId !== attempt.clientId) {
      throw new AuthError('The callback client ID did not match the selected ChatGPT registration.', 'client_mismatch');
    }

    const tokenResponse = await this.exchangeCode({ clientId, code, verifier: attempt.verifier, redirectUri: attempt.redirectUri });
    const scopes = scopesFrom(tokenResponse.scope ?? url.searchParams.get('scope'));
    requireScopes(scopes);
    const identity = await this.verifyIdentityToken(tokenResponse.id_token, { clientId, nonce: attempt.nonce });
    if (attempt.expectedSubject && identity.subject !== attempt.expectedSubject) {
      throw new AuthError('The returned ChatGPT account did not match the selected account. Existing credentials were kept.', 'account_mismatch');
    }
    if (!tokenResponse.access_token || !tokenResponse.refresh_token) {
      throw new AuthError('The authorization response did not include renewable ChatGPT-plan credentials.', 'credential_error');
    }
    if (String(tokenResponse.token_type ?? '').toLowerCase() !== 'bearer') {
      throw new AuthError('OpenAI returned an unsupported token type.', 'credential_error');
    }
    const expiresIn = Number(tokenResponse.expires_in ?? 3600);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new AuthError('OpenAI returned an invalid token lifetime.', 'credential_error');
    const credential = {
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      clientId,
      hostId: this.hostId,
      idToken: tokenResponse.id_token,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      tokenType: tokenResponse.token_type ?? 'Bearer',
      scopes,
      expiresAt: this.clock() + expiresIn * 1000,
      savedAt: new Date(this.clock()).toISOString()
    };
    this.credentialStore.write(credential);
    this.state = 'connected';
    this.stateMessage = 'Connected with ChatGPT-plan authorization.';
    return { state: this.state, message: this.stateMessage };
  }

  async accessToken() {
    if (this.refreshPromise) return this.refreshPromise;
    const credential = this.credentialStore.read();
    if (!credential) throw new AuthError('Sign in with ChatGPT to connect the story backend.', 'not_signed_in');
    requireScopes(credential.scopes ?? []);
    if (credential.expiresAt > this.clock() + 90_000) return credential.accessToken;
    this.refreshPromise = this.refreshCredential(credential);
    try {
      const refreshed = await this.refreshPromise;
      return refreshed.accessToken;
    } finally {
      this.refreshPromise = null;
    }
  }

  async refreshCredential(credential) {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
      resource: RESOURCE
    });
    let response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        redirect: 'error'
      });
    } catch {
      this.state = 'refresh_error';
      this.stateMessage = 'ChatGPT authorization could not be refreshed. Reconnect when online.';
      throw new AuthError(this.stateMessage, this.state);
    }
    const tokenResponse = await readResponseJson(response);
    if (!response.ok) {
      this.state = 'refresh_error';
      this.stateMessage = safeTokenError(response, tokenResponse);
      throw new AuthError(this.stateMessage, this.state);
    }
    const scopes = scopesFrom(tokenResponse.scope ?? credential.scopes.join(' '));
    requireScopes(scopes);
    const idToken = tokenResponse.id_token ?? credential.idToken;
    if (tokenResponse.id_token) {
      const identity = await this.verifyIdentityToken(tokenResponse.id_token, { clientId: credential.clientId });
      if (identity.subject !== credential.subject) throw new AuthError('Refreshed authorization returned a different ChatGPT identity.', 'account_mismatch');
    }
    if (!tokenResponse.access_token || !tokenResponse.refresh_token) {
      throw new AuthError('ChatGPT refresh did not return replacement credentials.', 'credential_error');
    }
    const expiresIn = Number(tokenResponse.expires_in ?? 3600);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new AuthError('OpenAI returned an invalid token lifetime.', 'credential_error');
    const refreshed = {
      ...credential,
      idToken,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      scopes,
      expiresAt: this.clock() + expiresIn * 1000,
      savedAt: new Date(this.clock()).toISOString()
    };
    this.credentialStore.write(refreshed);
    this.state = 'connected';
    this.stateMessage = 'Connected with ChatGPT-plan authorization.';
    return refreshed;
  }

  async signOut() {
    let credential = null;
    try { credential = this.credentialStore.read(); } catch { /* Local removal still works if DPAPI cannot unlock the record. */ }
    let revoked = false;
    if (credential?.refreshToken && credential?.clientId) {
      try {
        const metadata = await this.loadOidcMetadata();
        const response = await this.fetchImpl(metadata.revocation_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: credential.refreshToken, token_type_hint: 'refresh_token', client_id: credential.clientId }),
          redirect: 'error'
        });
        revoked = response.status === 200;
      } catch {
        revoked = false;
      }
    }
    this.credentialStore.delete();
    this.state = 'not_signed_in';
    this.stateMessage = 'Not connected. Sign in with ChatGPT to enable story generation.';
    return { revoked };
  }

  async exchangeCode({ clientId, code, verifier, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE
    });
    let response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error'
      });
    } catch {
      throw new AuthError('The ChatGPT token exchange could not reach OpenAI.', 'token_exchange_error');
    }
    const tokenResponse = await readResponseJson(response);
    if (!response.ok) throw new AuthError(safeTokenError(response, tokenResponse), response.status === 403 ? 'authorization_denied' : 'token_exchange_error');
    return tokenResponse;
  }

  async loadOidcMetadata() {
    if (this.oidc) return this.oidc;
    const response = await this.fetchImpl(OIDC_ENDPOINT, { redirect: 'error' });
    if (!response.ok) throw new AuthError('OpenID configuration could not be loaded.', 'identity_error');
    const metadata = await response.json();
    if (metadata.issuer !== 'https://auth.openai.com' || !metadata.jwks_uri || !metadata.revocation_endpoint) {
      throw new AuthError('OpenAI returned unexpected OpenID configuration.', 'identity_error');
    }
    const keysUrl = new URL(metadata.jwks_uri);
    const revokeUrl = new URL(metadata.revocation_endpoint);
    if (keysUrl.protocol !== 'https:' || keysUrl.hostname !== 'auth.openai.com' ||
        revokeUrl.protocol !== 'https:' || revokeUrl.hostname !== 'auth.openai.com') {
      throw new AuthError('OpenAI returned an unexpected signing-key endpoint.', 'identity_error');
    }
    this.oidc = metadata;
    return metadata;
  }

  async verifyIdentityToken(token, { clientId, nonce = null }) {
    if (!token) throw new AuthError('The authorization response did not include an identity token.', 'identity_error');
    const parsed = parseJwt(token);
    const { header, claims, signingInput, signature } = parsed;
    if (!['RS256', 'ES256'].includes(header.alg) || !header.kid) {
      throw new AuthError('The identity token uses an unsupported signing method.', 'identity_error');
    }
    const keys = await this.loadJwks();
    const jwk = keys.find((candidate) => candidate.kid === header.kid && (!candidate.alg || candidate.alg === header.alg) && (!candidate.use || candidate.use === 'sig'));
    if (!jwk) throw new AuthError('The identity token signing key was not recognized.', 'identity_error');
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    const validSignature = header.alg === 'RS256'
      ? verify('RSA-SHA256', Buffer.from(signingInput), publicKey, signature)
      : verify('sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    if (!validSignature) throw new AuthError('The identity token signature is invalid.', 'identity_error');
    const metadata = await this.loadOidcMetadata();
    if (claims.iss !== metadata.issuer) throw new AuthError('The identity token issuer did not match OpenAI.', 'identity_error');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(clientId) || (claims.azp && claims.azp !== clientId) || (audiences.length > 1 && claims.azp !== clientId)) {
      throw new AuthError('The identity token audience did not match this app registration.', 'identity_error');
    }
    if (Number(claims.exp) * 1000 <= this.clock()) throw new AuthError('The identity token has expired.', 'identity_error');
    if (!claims.sub) throw new AuthError('The identity token did not include an account subject.', 'identity_error');
    if (nonce && claims.nonce !== nonce) throw new AuthError('The identity token nonce did not match the active sign-in.', 'identity_error');
    return { issuer: claims.iss, subject: claims.sub, email: claims.email ?? null };
  }

  async loadJwks() {
    if (this.jwks && this.clock() - this.jwksFetchedAt < 3_600_000) return this.jwks;
    const metadata = await this.loadOidcMetadata();
    const response = await this.fetchImpl(metadata.jwks_uri, { redirect: 'error' });
    if (!response.ok) throw new AuthError('OpenAI signing keys could not be loaded.', 'identity_error');
    const body = await response.json();
    if (!Array.isArray(body.keys)) throw new AuthError('OpenAI signing keys were malformed.', 'identity_error');
    this.jwks = body.keys;
    this.jwksFetchedAt = this.clock();
    return this.jwks;
  }
}

function sameSecret(first, second) {
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const AUTH_CONSTANTS = {
  authorizeEndpoint: AUTHORIZE_ENDPOINT,
  tokenEndpoint: TOKEN_ENDPOINT,
  oidcEndpoint: OIDC_ENDPOINT,
  resource: RESOURCE,
  requiredScopes: REQUIRED_SCOPES,
  appName: APP_NAME
};

