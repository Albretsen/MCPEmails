import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Deterministic test key; the crypto module reads it lazily on first use.
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.OUTLOOK_CLIENT_ID = 'test-client';
process.env.OUTLOOK_CLIENT_SECRET = 'test-secret';

const { decryptToken } = await import('@/lib/crypto');
const {
  buildRefreshedTokenUpdate,
  exchangeOutlookCode,
  OutlookEmailMissingError,
  refreshOutlookAccessToken,
  verifyOutlookAccess,
} = await import('./outlook.ts');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OUTLOOK_TENANT_ID;
});

function stubFetch(status: number, body: unknown): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

// ─── refresh-token rotation ──────────────────────────────────────────────────

test('refresh returns the rotated refresh token Microsoft hands back', async () => {
  stubFetch(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3599 });
  const result = await refreshOutlookAccessToken('rt-1');
  assert.deepEqual(result, { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3599 });
});

test('refresh with no refresh_token in the response reports null, not the old one', async () => {
  stubFetch(200, { access_token: 'at-2', expires_in: 3599 });
  const result = await refreshOutlookAccessToken('rt-1');
  assert.equal(result.refreshToken, null);
});

test('the refreshed-token update persists the rotated refresh token, encrypted', () => {
  // Regression guard: every refresh path used to write only the access token,
  // so the ORIGINAL refresh token stayed in the row and died 90 days after
  // connect however active the inbox was.
  const now = new Date('2026-09-25T12:00:00Z');
  const update = buildRefreshedTokenUpdate(
    { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3600 },
    now,
  );
  assert.ok(update.oauth_refresh_token, 'rotated refresh token must be written');
  assert.notEqual(update.oauth_refresh_token, 'rt-2', 'never stored in plaintext');
  assert.equal(decryptToken(update.oauth_refresh_token!), 'rt-2');
  assert.equal(decryptToken(update.oauth_access_token), 'at-2');
  assert.equal(update.oauth_token_expires_at, '2026-09-25T13:00:00.000Z');
});

test('the update leaves the stored refresh token alone when none was returned', () => {
  const update = buildRefreshedTokenUpdate({ accessToken: 'at-2', refreshToken: null, expiresIn: 3600 });
  assert.equal('oauth_refresh_token' in update, false);
});

test('refresh maps invalid_grant to a reconnect error', async () => {
  stubFetch(400, { error: 'invalid_grant', error_description: 'AADSTS70008: expired' });
  await assert.rejects(refreshOutlookAccessToken('rt-1'), { name: 'OutlookAuthError', code: 'REFRESH_TOKEN_INVALID' });
});

test('a non-JSON 5xx from the token endpoint is an ordinary failure, not a reconnect', async () => {
  stubFetch(502, '<html>Bad gateway</html>');
  await assert.rejects(refreshOutlookAccessToken('rt-1'), (err: Error) => err.name === 'Error');
});

test('refresh uses OUTLOOK_TENANT_ID, default common', async () => {
  const a = stubFetch(200, { access_token: 'x', expires_in: 1 });
  await refreshOutlookAccessToken('rt');
  assert.equal(a.calls[0]!.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  process.env.OUTLOOK_TENANT_ID = 'contoso.onmicrosoft.com';
  const b = stubFetch(200, { access_token: 'x', expires_in: 1 });
  await refreshOutlookAccessToken('rt');
  assert.equal(b.calls[0]!.url, 'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token');
});

// ─── verify probe ────────────────────────────────────────────────────────────

test('the live check probes the mailbox, not /me (User.Read is not granted)', async () => {
  const { calls } = stubFetch(200, { id: 'AAMk' });
  assert.equal(await verifyOutlookAccess('at'), 'ok');
  assert.equal(calls[0]!.url, 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id');
});

test('401 from the probe means reconnect', async () => {
  stubFetch(401, { error: { code: 'InvalidAuthenticationToken' } });
  assert.equal(await verifyOutlookAccess('at'), 'unauthorized');
});

test('403 from the probe is forbidden, not reconnect', async () => {
  stubFetch(403, { error: { code: 'ErrorAccessDenied' } });
  assert.equal(await verifyOutlookAccess('at'), 'forbidden');
});

test('MailboxNotEnabledForRESTAPI is a missing mailbox even on a 401', async () => {
  stubFetch(401, { error: { code: 'MailboxNotEnabledForRESTAPI' } });
  assert.equal(await verifyOutlookAccess('at'), 'no_mailbox');
});

test('a 5xx from the probe is thrown as inconclusive', async () => {
  stubFetch(503, { error: { code: 'ServiceNotAvailable' } });
  await assert.rejects(verifyOutlookAccess('at'));
});

// ─── code exchange: email selection ──────────────────────────────────────────

test('code exchange prefers the email claim over the UPN and lowercases it', async () => {
  stubFetch(200, {
    access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer',
    scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send',
    id_token: idToken({ email: 'Jane.Doe@Contoso.com', preferred_username: 'jdoe@contoso.onmicrosoft.com' }),
  });
  const tokens = await exchangeOutlookCode('code', 'https://mcpemails.com/auth/outlook/callback');
  assert.equal(tokens.email, 'jane.doe@contoso.com');
  assert.equal(tokens.scope, 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send');
});

test('code exchange with no usable address fails with a dedicated error', async () => {
  stubFetch(200, {
    access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer',
    id_token: idToken({ preferred_username: 'not-an-address' }),
  });
  await assert.rejects(
    exchangeOutlookCode('code', 'https://mcpemails.com/auth/outlook/callback'),
    OutlookEmailMissingError,
  );
});
