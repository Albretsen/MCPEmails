import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSamlProvider,
  deleteSamlProvider,
  managementConfigFromEnv,
  SsoManagementError,
  updateSamlProvider,
} from './management-api.ts';
import { checkEntraMetadataUrl, samlServiceProviderValues } from './saml-values.ts';

// fetch is always a stub. The token below is a placeholder, not a credential.

const REF = 'abcdefghijklmnopqrst';
const TOKEN = 'sbp_placeholder_not_a_real_token';
const asEnv = (vars: Record<string, string | undefined>) => vars as unknown as NodeJS.ProcessEnv;
const ENV = asEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, SUPABASE_MANAGEMENT_API_TOKEN: TOKEN });
const PROVIDER = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const METADATA = 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/federationmetadata/2007-06/federationmetadata.xml?appid=11111111-1111-1111-1111-111111111111';

interface Seen { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown = {}): { fetchImpl: (url: string, init: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
    },
  };
}

test('config: token from the server env, project ref from the Supabase URL', () => {
  assert.deepEqual(managementConfigFromEnv(ENV), { token: TOKEN, projectRef: REF });
  assert.equal(managementConfigFromEnv({ ...ENV, SUPABASE_MANAGEMENT_API_TOKEN: '' }), null);
  assert.equal(managementConfigFromEnv({ ...ENV, NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test' }), null);
  assert.deepEqual(
    managementConfigFromEnv({ ...ENV, NEXT_PUBLIC_SUPABASE_URL: 'https://auth.example.test', SUPABASE_PROJECT_REF: REF }),
    { token: TOKEN, projectRef: REF },
  );
});

test('config: a NEXT_PUBLIC_ copy of the token is never read', () => {
  const env = asEnv({ NEXT_PUBLIC_SUPABASE_URL: ENV.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_MANAGEMENT_API_TOKEN: TOKEN });
  assert.equal(managementConfigFromEnv(env), null);
});

test('create: POSTs a SAML provider with the metadata URL and no domains, returns its id', async () => {
  const f = fakeFetch(201, { id: PROVIDER.toUpperCase() });
  const id = await createSamlProvider(METADATA, { fetchImpl: f.fetchImpl, env: ENV });
  assert.equal(id, PROVIDER);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].url, `https://api.supabase.com/v1/projects/${REF}/config/auth/sso/providers`);
  assert.equal(f.seen[0].init.method, 'POST');
  assert.equal((f.seen[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(String(f.seen[0].init.body));
  assert.equal(body.type, 'saml');
  assert.equal(body.metadata_url, METADATA);
  assert.equal('domains' in body, false, 'routing is ours: no Supabase-side domains');
  assert.ok(body.attribute_mapping.keys.email);
});

test('update and delete hit the provider id path', async () => {
  const put = fakeFetch(200, { id: PROVIDER });
  await updateSamlProvider(PROVIDER, METADATA, { fetchImpl: put.fetchImpl, env: ENV });
  assert.equal(put.seen[0].init.method, 'PUT');
  assert.ok(put.seen[0].url.endsWith(`/sso/providers/${PROVIDER}`));

  const del = fakeFetch(200);
  await deleteSamlProvider(PROVIDER, { fetchImpl: del.fetchImpl, env: ENV });
  assert.equal(del.seen[0].init.method, 'DELETE');

  const gone = fakeFetch(404);
  await deleteSamlProvider(PROVIDER, { fetchImpl: gone.fetchImpl, env: ENV }); // already gone: no throw
});

test('failures map to reasons, and no error ever carries the token', async () => {
  const cases: Array<[number, string]> = [[400, 'metadata_rejected'], [401, 'unauthorized'], [403, 'unauthorized'], [404, 'provider_missing'], [500, 'unavailable']];
  for (const [status, reason] of cases) {
    const f = fakeFetch(status, { message: `echo ${TOKEN}` });
    await assert.rejects(createSamlProvider(METADATA, { fetchImpl: f.fetchImpl, env: ENV }), (err: unknown) => {
      assert.ok(err instanceof SsoManagementError);
      assert.equal(err.reason, reason, String(status));
      assert.ok(!String(err.message).includes(TOKEN));
      assert.ok(!JSON.stringify(err).includes(TOKEN));
      return true;
    });
  }
  await assert.rejects(
    createSamlProvider(METADATA, { fetchImpl: async () => { throw new Error(`net ${TOKEN}`); }, env: ENV }),
    (err: unknown) => err instanceof SsoManagementError && err.reason === 'unavailable' && !err.message.includes(TOKEN),
  );
});

test('without a token nothing is sent', async () => {
  const f = fakeFetch(201, { id: PROVIDER });
  await assert.rejects(
    createSamlProvider(METADATA, { fetchImpl: f.fetchImpl, env: asEnv({ NEXT_PUBLIC_SUPABASE_URL: ENV.NEXT_PUBLIC_SUPABASE_URL }) }),
    (err: unknown) => err instanceof SsoManagementError && err.reason === 'not_configured',
  );
  assert.equal(f.seen.length, 0);
});

test('a create answer without a usable id is "unavailable"', async () => {
  const f = fakeFetch(201, { id: 'nope' });
  await assert.rejects(createSamlProvider(METADATA, { fetchImpl: f.fetchImpl, env: ENV }), (err: unknown) =>
    err instanceof SsoManagementError && err.reason === 'unavailable');
});

test('our SAML values are derived from the project URL', () => {
  assert.deepEqual(samlServiceProviderValues(`https://${REF}.supabase.co`), {
    entityId: `https://${REF}.supabase.co/auth/v1/sso/saml/metadata`,
    acsUrl: `https://${REF}.supabase.co/auth/v1/sso/saml/acs`,
    metadataUrl: `https://${REF}.supabase.co/auth/v1/sso/saml/metadata`,
  });
  assert.equal(samlServiceProviderValues(undefined), null);
  assert.equal(samlServiceProviderValues('http://db.example.test'), null);
});

test('only an https Entra federation metadata URL is accepted', () => {
  const ok = checkEntraMetadataUrl(`  ${METADATA}#frag `);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.url, METADATA);
  assert.equal(ok.ok && ok.host, 'login.microsoftonline.com');

  assert.deepEqual(checkEntraMetadataUrl(METADATA.replace('https:', 'http:')), { ok: false, reason: 'not_https' });
  assert.deepEqual(checkEntraMetadataUrl(METADATA.replace('login.microsoftonline.com', 'login.example.test')), { ok: false, reason: 'not_entra' });
  assert.deepEqual(checkEntraMetadataUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize'), { ok: false, reason: 'not_entra' });
  assert.deepEqual(checkEntraMetadataUrl(METADATA.replace('https://', 'https://user:pw@')), { ok: false, reason: 'invalid' });
  assert.deepEqual(checkEntraMetadataUrl('not a url'), { ok: false, reason: 'invalid' });
  assert.deepEqual(checkEntraMetadataUrl(42), { ok: false, reason: 'invalid' });
});
