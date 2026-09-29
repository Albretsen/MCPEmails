/**
 * Tests for Resend bounce/complaint suppression: the Svix signature check, which
 * events suppress, and that applying one is idempotent.
 *
 * No network. The store is in-memory and behaves like the real UPDATE ...
 * WHERE unsubscribed_at IS NULL.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/email/resend-webhook.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const { verifySvixSignature, signSvix, classifyResendEvent, applySuppression } = await import(
  '@/lib/email/resend-webhook'
);
type SuppressionStore = import('@/lib/email/resend-webhook').SuppressionStore;

const KEY = Buffer.from('a-test-signing-key-of-some-length').toString('base64');
const SECRET = `whsec_${KEY}`;
const NOW = 1_790_000_000;
const BODY = JSON.stringify({ type: 'email.complained', data: { to: ['a@example.test'] } });

function header(id: string, ts: string, body: string, secret = SECRET) {
  return `v1,${signSvix(secret, id, ts, body)}`;
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

test('signature: matches the Svix reference construction (base64 HMAC-SHA256 of id.ts.body)', () => {
  const expected = createHmac('sha256', Buffer.from(KEY, 'base64'))
    .update(`msg_1.${NOW}.${BODY}`)
    .digest('base64');
  assert.equal(signSvix(SECRET, 'msg_1', String(NOW), BODY), expected);
});

test('signature: a correct v1 signature verifies', () => {
  const r = verifySvixSignature({
    secret: SECRET,
    id: 'msg_1',
    timestamp: String(NOW),
    signature: header('msg_1', String(NOW), BODY),
    body: BODY,
    nowSeconds: NOW,
  });
  assert.deepEqual(r, { ok: true });
});

test('signature: any one of several space-separated signatures may match (secret rotation)', () => {
  const good = header('msg_1', String(NOW), BODY);
  const r = verifySvixSignature({
    secret: SECRET,
    id: 'msg_1',
    timestamp: String(NOW),
    signature: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${good}`,
    body: BODY,
    nowSeconds: NOW,
  });
  assert.equal(r.ok, true);
});

test('signature: missing headers are rejected', () => {
  for (const missing of ['id', 'timestamp', 'signature'] as const) {
    const input = {
      secret: SECRET,
      id: 'msg_1' as string | null,
      timestamp: String(NOW) as string | null,
      signature: header('msg_1', String(NOW), BODY) as string | null,
      body: BODY,
      nowSeconds: NOW,
    };
    input[missing] = null;
    assert.deepEqual(verifySvixSignature(input), { ok: false, reason: 'missing_headers' });
  }
});

test('signature: a tampered body, a different id, or a wrong secret does not verify', () => {
  const sig = header('msg_1', String(NOW), BODY);
  const base = { secret: SECRET, id: 'msg_1', timestamp: String(NOW), signature: sig, body: BODY, nowSeconds: NOW };
  assert.equal(verifySvixSignature({ ...base, body: BODY.replace('a@', 'b@') }).ok, false);
  assert.equal(verifySvixSignature({ ...base, id: 'msg_2' }).ok, false);
  const other = `whsec_${Buffer.from('another-key').toString('base64')}`;
  assert.equal(verifySvixSignature({ ...base, secret: other }).ok, false);
});

test('signature: non-v1 schemes are ignored', () => {
  const sig = signSvix(SECRET, 'msg_1', String(NOW), BODY);
  const r = verifySvixSignature({
    secret: SECRET,
    id: 'msg_1',
    timestamp: String(NOW),
    signature: `v1a,${sig}`,
    body: BODY,
    nowSeconds: NOW,
  });
  assert.deepEqual(r, { ok: false, reason: 'no_match' });
});

test('signature: a timestamp outside five minutes is rejected, inside is accepted', () => {
  const sign = (ts: number) => ({
    secret: SECRET,
    id: 'msg_1',
    timestamp: String(ts),
    signature: header('msg_1', String(ts), BODY),
    body: BODY,
    nowSeconds: NOW,
  });
  assert.equal(verifySvixSignature(sign(NOW - 299)).ok, true);
  assert.deepEqual(verifySvixSignature(sign(NOW - 301)), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verifySvixSignature(sign(NOW + 301)), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(
    verifySvixSignature({ ...sign(NOW), timestamp: 'soon' }),
    { ok: false, reason: 'bad_timestamp' },
  );
});

test('signature: an empty secret verifies nothing', () => {
  const r = verifySvixSignature({
    secret: 'whsec_',
    id: 'msg_1',
    timestamp: String(NOW),
    signature: 'v1,xyz',
    body: BODY,
    nowSeconds: NOW,
  });
  assert.deepEqual(r, { ok: false, reason: 'bad_secret' });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('classify: a complaint suppresses its recipients', () => {
  const c = classifyResendEvent({
    type: 'email.complained',
    data: { email_id: 'em_1', to: ['Owner@Example.test'] },
  });
  assert.deepEqual(c, { action: 'suppress', reason: 'complaint', recipients: ['Owner@Example.test'], emailId: 'em_1' });
});

test('classify: a Permanent bounce suppresses (including Resend-suppressed addresses)', () => {
  for (const subType of ['General', 'NoEmail', 'Suppressed']) {
    const c = classifyResendEvent({
      type: 'email.bounced',
      data: { email_id: 'em_2', to: ['gone@example.test'], bounce: { type: 'Permanent', subType } },
    });
    assert.equal(c.action, 'suppress');
    assert.equal(c.action === 'suppress' && c.reason, 'hard_bounce');
  }
});

test('classify: transient, undetermined or unlabelled bounces are ignored', () => {
  for (const bounce of [{ type: 'Transient' }, { type: 'Temporary' }, { type: 'Undetermined' }, {}, undefined]) {
    const c = classifyResendEvent({ type: 'email.bounced', data: { to: ['x@example.test'], bounce } });
    assert.equal(c.action, 'ignore');
  }
});

test('classify: other event types are ignored, not errors', () => {
  for (const type of ['email.sent', 'email.delivered', 'email.opened', 'email.delivery_delayed', 'contact.created']) {
    assert.equal(classifyResendEvent({ type, data: { to: ['x@example.test'] } }).action, 'ignore');
  }
  assert.equal(classifyResendEvent(null).action, 'ignore');
  assert.equal(classifyResendEvent({ type: 'email.complained' }).action, 'ignore');
});

test('classify: "Name <addr>" recipients are reduced to the address; junk is dropped', () => {
  const c = classifyResendEvent({
    type: 'email.complained',
    data: { to: ['Pat <pat@example.test>', 'not an address', 42] },
  });
  assert.equal(c.action === 'suppress' && c.recipients.join(','), 'pat@example.test');
});

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

class MemoryStore implements SuppressionStore {
  users = new Map<string, { email: string; unsubscribedAt: string | null }>();
  ledger: Array<{ userId: string; providerMessageId: string }> = [];
  writes = 0;
  async userIdsByEmail(addresses: string[]) {
    const wanted = new Set(addresses.flatMap((a) => [a, a.toLowerCase()]));
    return [...this.users].filter(([, u]) => wanted.has(u.email)).map(([id]) => id);
  }
  async userIdsByProviderMessageId(emailId: string) {
    return this.ledger.filter((r) => r.providerMessageId === emailId).map((r) => r.userId);
  }
  async suppress(ids: string[], at: Date) {
    let n = 0;
    for (const id of ids) {
      const u = this.users.get(id);
      if (u && !u.unsubscribedAt) {
        u.unsubscribedAt = at.toISOString();
        n += 1;
        this.writes += 1;
      }
    }
    return n;
  }
}

const AT = new Date('2026-09-29T12:00:00.000Z');

test('apply: sets the opt-out once; a replay changes nothing', async () => {
  const store = new MemoryStore();
  store.users.set('u1', { email: 'owner@example.test', unsubscribedAt: null });
  store.users.set('u2', { email: 'other@example.test', unsubscribedAt: null });
  const event = { action: 'suppress' as const, reason: 'complaint' as const, recipients: ['Owner@example.test'], emailId: null };

  const first = await applySuppression(store, event, AT);
  assert.deepEqual(first, { reason: 'complaint', matchedUsers: 1, newlySuppressed: 1 });
  assert.equal(store.users.get('u1')!.unsubscribedAt, AT.toISOString());
  assert.equal(store.users.get('u2')!.unsubscribedAt, null);

  const replay = await applySuppression(store, event, new Date(AT.getTime() + 60_000));
  assert.deepEqual(replay, { reason: 'complaint', matchedUsers: 1, newlySuppressed: 0 });
  assert.equal(store.users.get('u1')!.unsubscribedAt, AT.toISOString(), 'original timestamp kept');
  assert.equal(store.writes, 1);
});

test('apply: an already-unsubscribed user keeps their own timestamp', async () => {
  const store = new MemoryStore();
  store.users.set('u1', { email: 'owner@example.test', unsubscribedAt: '2026-09-01T00:00:00.000Z' });
  const out = await applySuppression(
    store,
    { action: 'suppress', reason: 'hard_bounce', recipients: ['owner@example.test'], emailId: null },
    AT,
  );
  assert.equal(out.newlySuppressed, 0);
  assert.equal(store.users.get('u1')!.unsubscribedAt, '2026-09-01T00:00:00.000Z');
});

test('apply: the ledger match reaches a user who changed address after the send', async () => {
  const store = new MemoryStore();
  store.users.set('u1', { email: 'new@example.test', unsubscribedAt: null });
  store.ledger.push({ userId: 'u1', providerMessageId: 'em_9' });
  const out = await applySuppression(
    store,
    { action: 'suppress', reason: 'complaint', recipients: ['old@example.test'], emailId: 'em_9' },
    AT,
  );
  assert.deepEqual(out, { reason: 'complaint', matchedUsers: 1, newlySuppressed: 1 });
});

test('apply: an unknown recipient is a no-op, not an error', async () => {
  const store = new MemoryStore();
  const out = await applySuppression(
    store,
    { action: 'suppress', reason: 'hard_bounce', recipients: ['nobody@example.test'], emailId: 'em_x' },
    AT,
  );
  assert.deepEqual(out, { reason: 'hard_bounce', matchedUsers: 0, newlySuppressed: 0 });
});

// ---------------------------------------------------------------------------
// The opt-out it writes is the one the paywall follow-up already honours
// ---------------------------------------------------------------------------

test('a suppressed owner stops the paywall follow-up (ineligibility -> unsubscribed)', async () => {
  const { ineligibility } = await import('@/lib/email/paywall-followup');
  const firstMs = Date.parse('2026-09-29T10:00:00.000Z');
  const reason = ineligibility(
    {
      workspaceId: 'ws1',
      firstPaywallAt: new Date(firstMs).toISOString(),
      paywallKind: 'inbox_cap',
      workspace: { ownerId: 'u1', plan: 'free', deletedAt: null },
      owner: {
        id: 'u1',
        email: 'owner@example.test',
        marketingConsentAt: '2026-09-29T09:00:00.000Z',
        unsubscribedAt: AT.toISOString(),
        unsubscribedCategories: [],
        unsubscribeToken: '11111111-2222-4333-8444-555555555555',
      },
      subscriptionStatus: null,
      unlimitedInboxes: false,
      internal: false,
      inboxCount: 1,
      ledger: [],
    },
    firstMs,
  );
  assert.equal(reason, 'unsubscribed');
});
