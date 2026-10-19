import test from 'node:test';
import assert from 'node:assert/strict';
import { isSsoUser, ssoProviderIdOf, ssoRouteForEmail, type SsoLookupRpc } from './sign-in.ts';

// Only reserved example domains.

const PROVIDER = '550ed000-0000-0000-0000-0000000000a1';

function fakeRpc(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const rpc: SsoLookupRpc = (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve(result);
  };
  return { rpc, calls };
}

test('a verified, active domain routes to its provider', async () => {
  const { rpc, calls } = fakeRpc({ data: PROVIDER.toUpperCase(), error: null });
  const route = await ssoRouteForEmail(rpc, ' Person@Company-SSO.Example ');
  assert.deepEqual(route, { sso: true, domain: 'company-sso.example', providerId: PROVIDER });
  assert.deepEqual(calls, [{ fn: 'sso_provider_for_domain', args: { p_domain: 'company-sso.example' } }]);
});

test('unknown, unverified and disabled domains all read as not configured', async () => {
  // The RPC returns NULL for each of them; the caller cannot tell them apart.
  const { rpc } = fakeRpc({ data: null, error: null });
  assert.deepEqual(await ssoRouteForEmail(rpc, 'person@company-sso.example'), { sso: false, reason: 'not_configured' });
});

test('a malformed provider id is not a route', async () => {
  const { rpc } = fakeRpc({ data: 'not-a-uuid', error: null });
  assert.deepEqual(await ssoRouteForEmail(rpc, 'person@company-sso.example'), { sso: false, reason: 'not_configured' });
});

test('consumer and invalid addresses never reach the database', async () => {
  const { rpc, calls } = fakeRpc({ data: PROVIDER, error: null });
  assert.deepEqual(await ssoRouteForEmail(rpc, 'person@gmail.com'), { sso: false, reason: 'consumer_domain' });
  assert.deepEqual(await ssoRouteForEmail(rpc, 'not an email'), { sso: false, reason: 'invalid_email' });
  assert.deepEqual(await ssoRouteForEmail(rpc, undefined), { sso: false, reason: 'invalid_email' });
  assert.equal(calls.length, 0);
});

test('a failed lookup throws instead of reading as "no SSO"', async () => {
  const { rpc } = fakeRpc({ data: null, error: { message: 'connection reset' } });
  await assert.rejects(ssoRouteForEmail(rpc, 'person@company-sso.example'), /connection reset/);
});

test('an SSO user is recognised from app_metadata.provider', () => {
  const user = { app_metadata: { provider: `sso:${PROVIDER}` } };
  assert.equal(ssoProviderIdOf(user), PROVIDER);
  assert.equal(isSsoUser(user), true);
  assert.equal(ssoProviderIdOf({ app_metadata: { provider: `sso:${PROVIDER.toUpperCase()}` } }), PROVIDER);
});

test('every other user is not an SSO user', () => {
  for (const user of [
    { app_metadata: { provider: 'email' } },
    { app_metadata: { provider: 'azure' } },
    { app_metadata: { provider: 'sso:' } },
    { app_metadata: { provider: 'sso:not-a-uuid' } },
    { app_metadata: { provider: 42 } },
    { app_metadata: null },
    {},
    null,
    undefined,
  ]) {
    assert.equal(isSsoUser(user), false, JSON.stringify(user));
  }
});
