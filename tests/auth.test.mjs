import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AuthError, AuthService, AUTH_CONSTANTS, WindowsDpapiCredentialStore } from '../src/auth.mjs';
import { temporaryDatabase } from './helpers.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function signedIdentityToken({ privateKey, nonce, audience = 'issued-story-client', subject = 'acct-story-test', issuer = 'https://auth.openai.com' }) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'story-test-key', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: issuer, sub: subject, aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, nonce, email: 'story@example.invalid'
  })).toString('base64url');
  const input = `${header}.${claims}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

function makeCredentialStore(initial = null) {
  return {
    value: initial,
    read() { return this.value; },
    write(value) { this.value = structuredClone(value); },
    delete() { this.value = null; }
  };
}

test('Sign in with ChatGPT uses state, nonce, PKCE, exact loopback callback, and validates the signed identity', async (t) => {
  const { database } = await temporaryDatabase(t);
  const store = makeCredentialStore();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  Object.assign(publicJwk, { kid: 'story-test-key', alg: 'RS256', use: 'sig' });
  const calls = [];
  let nonce;
  const auth = new AuthService({
    dataDirectory: 'unused', database, credentialStore: store,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url) === AUTH_CONSTANTS.tokenEndpoint) {
        const form = new URLSearchParams(options.body);
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('client_id'), 'issued-story-client');
        assert.equal(form.get('resource'), AUTH_CONSTANTS.resource);
        assert.ok(form.get('code_verifier'));
        return response({
          access_token: 'test-access-secret', refresh_token: 'test-refresh-secret', id_token: signedIdentityToken({ privateKey, nonce }),
          token_type: 'Bearer', expires_in: 3600, scope: AUTH_CONSTANTS.requiredScopes.join(' ')
        });
      }
      if (String(url) === AUTH_CONSTANTS.oidcEndpoint) {
        return response({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/test-jwks', revocation_endpoint: 'https://auth.openai.com/test-revoke' });
      }
      if (String(url) === 'https://auth.openai.com/test-jwks') return response({ keys: [publicJwk] });
      throw new Error('Unexpected test endpoint.');
    }
  });

  const attempt = auth.beginSignIn('http://127.0.0.1:4389/auth/callback');
  const authorize = new URL(attempt.authorizationUrl);
  assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://127.0.0.1:4389/auth/callback');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorize.searchParams.get('code_challenge'));
  assert.equal(authorize.searchParams.get('ext_agent_host_id'), database.getSetting('oauth.host_id'));
  assert.equal(authorize.searchParams.get('agent_name_hint'), AUTH_CONSTANTS.appName);
  nonce = authorize.searchParams.get('nonce');
  const state = authorize.searchParams.get('state');
  const invalidCallback = `http://127.0.0.1:4389/auth/callback?code=bad&state=wrong&client_id=issued-story-client`;
  await assert.rejects(auth.handleCallback(invalidCallback), (error) => error instanceof AuthError && error.state === 'state_mismatch');
  assert.equal(calls.length, 0);

  const callback = `http://127.0.0.1:4389/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}&client_id=issued-story-client`;
  assert.equal((await auth.handleCallback(callback)).state, 'connected');
  assert.equal(store.value.accessToken, 'test-access-secret');
  assert.equal(store.value.refreshToken, 'test-refresh-secret');
  assert.equal(store.value.subject, 'acct-story-test');
  assert.equal((await auth.status()).state, 'connected');
  assert.equal(await auth.accessToken(), 'test-access-secret');
  assert.equal(database.getSetting('access_token'), null);
  assert.equal(calls.some((call) => call.options.redirect === 'error'), true);
});

test('missing ChatGPT-plan scope leaves authorization disconnected with a precise state', async (t) => {
  const { database } = await temporaryDatabase(t);
  const store = makeCredentialStore();
  const auth = new AuthService({
    dataDirectory: 'unused', database, credentialStore: store,
    fetchImpl: async (url) => String(url) === AUTH_CONSTANTS.tokenEndpoint
      ? response({ access_token: 'access', refresh_token: 'refresh', scope: 'openid profile', token_type: 'Bearer', expires_in: 3600 })
      : response({})
  });
  const attempt = auth.beginSignIn('http://127.0.0.1:4390/auth/callback');
  const url = new URL(attempt.authorizationUrl);
  const callback = `http://127.0.0.1:4390/auth/callback?code=code&state=${url.searchParams.get('state')}&client_id=issued-story-client`;
  await assert.rejects(auth.handleCallback(callback), (error) => error.state === 'scope_missing');
  auth.recordFailure(new AuthError('ChatGPT-plan authorization did not grant required scopes.', 'scope_missing'));
  assert.equal(store.value, null);
  assert.equal((await auth.status()).state, 'scope_missing');
  await assert.rejects(auth.accessToken(), /Sign in with ChatGPT/);
});

test('expired credentials refresh through the official token endpoint without a provider fallback', async (t) => {
  const { database } = await temporaryDatabase(t);
  const store = makeCredentialStore({
    accessToken: 'old-access-secret', refreshToken: 'old-refresh-secret', idToken: 'old-id',
    clientId: 'issued-story-client', subject: 'acct-story-test', scopes: AUTH_CONSTANTS.requiredScopes,
    expiresAt: Date.now() - 1000, email: 'story@example.invalid'
  });
  let requestBody;
  const auth = new AuthService({
    dataDirectory: 'unused', database, credentialStore: store,
    fetchImpl: async (url, options) => {
      assert.equal(String(url), AUTH_CONSTANTS.tokenEndpoint);
      requestBody = new URLSearchParams(options.body);
      return response({ access_token: 'rotated-access-secret', refresh_token: 'rotated-refresh-secret', token_type: 'Bearer', expires_in: 2400 });
    }
  });
  assert.equal(await auth.accessToken(), 'rotated-access-secret');
  assert.equal(requestBody.get('grant_type'), 'refresh_token');
  assert.equal(requestBody.get('client_id'), 'issued-story-client');
  assert.equal(requestBody.get('resource'), AUTH_CONSTANTS.resource);
  assert.equal(requestBody.get('refresh_token'), 'old-refresh-secret');
  assert.equal(store.value.refreshToken, 'rotated-refresh-secret');
  assert.equal(database.getSetting('OPENAI_API_KEY'), null);
});

test('Windows credential storage uses DPAPI when available and never writes plaintext tokens', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-dpapi-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credentials.dpapi');
  const store = new WindowsDpapiCredentialStore(file);
  if (process.platform === 'win32') {
    const credential = { accessToken: 'local-access-secret-example', refreshToken: 'local-refresh-secret-example' };
    store.write(credential);
    const [slot] = store.credentialFiles();
    assert.ok(slot);
    assert.equal(fs.readFileSync(slot, 'utf8').includes('local-access-secret-example'), false);
    assert.deepEqual(store.read(), credential);
    store.delete();
    assert.equal(fs.existsSync(file), false);
  } else {
    assert.throws(() => store.write({ accessToken: 'local-access-secret-example' }), /available only on Windows/);
  }
});
