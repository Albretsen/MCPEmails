// ---------------------------------------------------------------------------
// The web half of webhooks: the signature (pinned to the same known vector as
// supabase/functions/client-api/tests/webhook-signature.test.ts), secret
// generation, URL validation with the SSRF guard, and the test-ping sender
// (pinned address, no redirects, timeout). No network: the resolver and the
// request are injected.
//
// Run: npm run test:webhooks
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateWebhookSecret, hmacSha256Hex, newEventId, signatureHeader, verifySignature } from './sign.ts';
import { parseWebhookUrl, validateWebhookUrl } from './url.ts';
import { postWebhook } from './send.ts';

const SECRET = `whsec_${'5a'.repeat(32)}`;
const T = 1761300000;
const BODY = '{"id":"evt_0123456789abcdef0123456789abcdef","type":"ping"}';
const EXPECTED = 'c32330190696c5030a0e27c1d1a00fbee30675fcc3d122f460ab9171266fe03f';

test('known vector, identical to the edge test', () => {
  assert.equal(hmacSha256Hex(SECRET, `${T}.${BODY}`), EXPECTED);
  assert.equal(signatureHeader(SECRET, T + 0.7, BODY), `t=${T},v1=${EXPECTED}`);
  assert.ok(verifySignature(`t=${T},v1=${EXPECTED}`, SECRET, BODY, T + 299));
  assert.ok(!verifySignature(`t=${T},v1=${EXPECTED}`, SECRET, BODY, T + 301));
  assert.ok(!verifySignature(`t=${T},v1=${EXPECTED}`, SECRET, `${BODY} `, T));
});

test('a member sees a webhook URL as scheme and host only', async () => {
  const { maskWebhookUrl, coveredInboxCount } = await import('./access.ts');
  assert.equal(maskWebhookUrl('https://hooks.example.com:8443/in/tok_123?k=s'), 'https://hooks.example.com:8443/…');
  assert.equal(maskWebhookUrl('https://hooks.example.com/'), 'https://hooks.example.com/');
  assert.equal(coveredInboxCount(['a', 'b', 'c'], [{ inbox_ids: ['a'], disabled_at: null }, { inbox_ids: ['b', 'x'], disabled_at: null }]), 2);
  assert.equal(coveredInboxCount(['a', 'b', 'c'], [{ inbox_ids: null, disabled_at: '2026-10-01' }, { inbox_ids: ['a'], disabled_at: null }]), 1);
  assert.equal(coveredInboxCount(['a', 'b', 'c'], [{ inbox_ids: null, disabled_at: null }]), 3);
});

test('Pro and Business sell webhooks; scoped keys are not sold as a paid feature (they are on every plan)', async () => {
  const { PLANS } = await import('../stripe/plans.ts');
  assert.ok(PLANS.solo.features.includes('Webhooks for new mail'));
  assert.ok(PLANS.pro.features.includes('Webhooks for new mail'));
  for (const plan of [PLANS.free, PLANS.personal]) assert.ok(!plan.features.some((f) => /webhook/i.test(f)));
  for (const plan of [PLANS.solo, PLANS.pro]) assert.ok(!plan.features.some((f) => /scoped/i.test(f)));
  assert.equal(PLANS.solo.limits.webhooksEnabled && PLANS.pro.limits.webhooksEnabled, true);
  assert.equal(PLANS.free.limits.webhooksEnabled || PLANS.personal.limits.webhooksEnabled, false);
});

test('secrets are whsec_ + 64 hex with a 12-character prefix; event ids are evt_ + 32 hex', () => {
  const a = generateWebhookSecret();
  assert.match(a.secret, /^whsec_[0-9a-f]{64}$/);
  assert.equal(a.prefix, a.secret.slice(0, 12));
  assert.notEqual(a.secret, generateWebhookSecret().secret);
  assert.match(newEventId(), /^evt_[0-9a-f]{32}$/);
});

test('URL rules: https, 443 or 8443, no credentials, no fragment', () => {
  const code = (raw: unknown) => {
    const r = parseWebhookUrl(raw);
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(code('https://hooks.example.com/x'), 'ok');
  assert.equal(code(' https://hooks.example.com:8443/x '), 'ok');
  assert.equal(code('http://hooks.example.com/x'), 'url_not_https');
  assert.equal(code('https://hooks.example.com:444/x'), 'port_not_allowed');
  assert.equal(code('https://a:b@hooks.example.com/x'), 'url_credentials');
  assert.equal(code('https://hooks.example.com/x#y'), 'url_invalid');
  assert.equal(code(null), 'url_invalid');
});

test('the SSRF guard: private literals in any encoding, and names that resolve inward, are refused', async () => {
  const lookup = (address: string) => async () => [{ address, family: 4 }];
  for (const url of ['https://127.0.0.1/', 'https://0x7f000001/', 'https://169.254.169.254/', 'https://[fe80::1]/', 'https://100.64.1.1/']) {
    const v = await validateWebhookUrl(url, { lookup: lookup('93.184.216.34') });
    assert.equal(v.ok ? 'ok' : v.code, 'host_not_allowed', url);
  }
  const rebound = await validateWebhookUrl('https://hooks.example.com/', { lookup: lookup('10.0.0.7') });
  assert.equal(rebound.ok ? 'ok' : rebound.code, 'host_not_allowed');
  const fine = await validateWebhookUrl('https://hooks.example.com/', { lookup: lookup('93.184.216.34') });
  assert.ok(fine.ok && fine.address === '93.184.216.34');
});

test('postWebhook dials the approved address, reports a redirect as its status, and maps timeouts', async () => {
  const seen: Array<{ address: string; host: string; port: number; path: string }> = [];
  const ok = await postWebhook({
    url: 'https://hooks.example.com:8443/in?a=1',
    headers: { 'MCPEmails-Event-Id': 'evt_x\r\nInjected: 1' },
    body: '{}',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (target, headers) => {
      seen.push(target);
      assert.equal(headers['MCPEmails-Event-Id'], 'evt_xInjected: 1', 'CR and LF are stripped');
      return 302;
    },
  });
  assert.deepEqual(ok, { kind: 'response', status: 302 });
  assert.equal(seen[0].address, '93.184.216.34');
  assert.equal(seen[0].host, 'hooks.example.com');
  assert.equal(seen[0].port, 8443);
  assert.equal(seen[0].path, '/in?a=1');

  const blocked = await postWebhook({ url: 'https://hooks.example.com/', headers: {}, body: '{}', lookup: async () => [{ address: '192.168.1.1', family: 4 }], request: async () => 200 });
  assert.deepEqual(blocked, { kind: 'error', code: 'host_not_allowed' });

  const slow = await postWebhook({ url: 'https://93.184.216.34/', headers: {}, body: '{}', request: async () => { throw new Error('webhook_deadline'); } });
  assert.deepEqual(slow, { kind: 'error', code: 'timeout' });
  const refused = await postWebhook({ url: 'https://93.184.216.34/', headers: {}, body: '{}', request: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(refused, { kind: 'error', code: 'connect_failed' });
});
