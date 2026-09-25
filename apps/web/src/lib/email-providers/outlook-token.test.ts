import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Deterministic test key; the crypto module reads it lazily on first use.
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.OUTLOOK_CLIENT_ID = 'test-client';
process.env.OUTLOOK_CLIENT_SECRET = 'test-secret';
// The refresh path persists through the service-role client; its requests go
// through the same stubbed fetch below, routed by URL.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

const { decryptToken, encryptToken } = await import('@/lib/crypto');
const {
  buildRefreshedTokenUpdate,
  checkOutlookMailbox,
  exchangeOutlookCode,
  OutlookEmailMissingError,
  OutlookAuthError,
  probeOutlookMailboxAtConnect,
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

// ─── 401 on a valid token: refresh once, then "no mailbox" (live 2026-09-25) ─

type Route = { match: (url: string) => boolean; reply: () => Response };

/** Answer each request with the first unused route that matches its URL. */
function routeFetch(routes: Route[]): { urls: string[]; auth: (string | null)[] } {
  const urls: string[] = [];
  const auth: (string | null)[] = [];
  const pending = [...routes];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    urls.push(u);
    auth.push(new Headers(init?.headers).get('Authorization'));
    const i = pending.findIndex((r) => r.match(u));
    if (i === -1) throw new Error(`unexpected fetch: ${u}`);
    const [route] = pending.splice(i, 1);
    return route!.reply();
  }) as typeof fetch;
  return { urls, auth };
}

const PROBE = (u: string) => u.startsWith('https://graph.microsoft.com/v1.0/me/mailFolders/inbox');
const TOKEN = (u: string) => u.startsWith('https://login.microsoftonline.com/');
const DB = (u: string) => u.startsWith('https://db.test/');
const reply = (status: number, body?: unknown) => () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function storedInbox(): Parameters<typeof checkOutlookMailbox>[0] {
  return {
    id: 'inbox-1',
    oauth_access_token: encryptToken('stored-at'),
    oauth_refresh_token: encryptToken('stored-rt'),
    oauth_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  } as Parameters<typeof checkOutlookMailbox>[0];
}

test('connect-time probe: a 401 with an EMPTY body on a just-minted token is no mailbox', async () => {
  routeFetch([{ match: PROBE, reply: reply(401) }]);
  assert.equal(await probeOutlookMailboxAtConnect('fresh-at'), 'no_mailbox');
});

test('connect-time probe: a readable inbox is ok; a Graph outage is inconclusive, not a refusal', async () => {
  routeFetch([{ match: PROBE, reply: reply(200, { id: 'AAMk' }) }]);
  assert.equal(await probeOutlookMailboxAtConnect('fresh-at'), 'ok');
  routeFetch([{ match: PROBE, reply: reply(503, { error: { code: 'ServiceNotAvailable' } }) }]);
  assert.equal(await probeOutlookMailboxAtConnect('fresh-at'), 'inconclusive');
});

test('check: a 401 on a stored token refreshes ONCE and re-probes; success is ok', async () => {
  const { urls, auth } = routeFetch([
    { match: PROBE, reply: reply(401) },
    { match: TOKEN, reply: reply(200, { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }) },
    { match: DB, reply: reply(204) },
    { match: PROBE, reply: reply(200, { id: 'AAMk' }) },
  ]);
  assert.equal(await checkOutlookMailbox(storedInbox()), 'ok');
  assert.equal(urls.filter(TOKEN).length, 1);
  assert.deepEqual(auth.filter((_, i) => PROBE(urls[i]!)), ['Bearer stored-at', 'Bearer new-at']);
});

test('check: a 401 that survives the refresh is no mailbox, not reconnect', async () => {
  const { urls } = routeFetch([
    { match: PROBE, reply: reply(401) },
    { match: TOKEN, reply: reply(200, { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }) },
    { match: DB, reply: reply(204) },
    { match: PROBE, reply: reply(401) },
  ]);
  assert.equal(await checkOutlookMailbox(storedInbox()), 'no_mailbox');
  assert.equal(urls.filter(TOKEN).length, 1, 'exactly one forced refresh');
});

test('check: invalid_grant on the forced refresh is the reconnect case', async () => {
  routeFetch([
    { match: PROBE, reply: reply(401) },
    { match: TOKEN, reply: reply(400, { error: 'invalid_grant' }) },
    { match: DB, reply: reply(204) }, // markInboxErrored
  ]);
  await assert.rejects(checkOutlookMailbox(storedInbox()), (err: unknown) =>
    err instanceof OutlookAuthError && err.code === 'REFRESH_TOKEN_INVALID');
});
