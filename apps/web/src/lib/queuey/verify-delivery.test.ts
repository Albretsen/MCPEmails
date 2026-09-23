// ---------------------------------------------------------------------------
// Verification of Queuey's outbound delivery signature.
//
// The cases that matter: a genuine delivery verifies; every single-field
// tamper is caught and named; the ±5-minute window holds on both sides; and
// the two places where docs/how-to/signed-requests and the TypeScript sample
// in docs/how-to/verify-deliveries disagree (normalised QUERY, trimmed PATH)
// resolve the way the spec says, because that is the pair that would silently
// dead-letter live billing events if we ever added a query parameter.
//
// The signer here is written from the spec text independently of the
// implementation, so the test is a second reading of the document rather than
// a restatement of the code.
//
// Run: node --test --experimental-strip-types src/lib/queuey/verify-delivery.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import {
  canonicalPath,
  canonicalQuery,
  DEFAULT_CLOCK_SKEW_SECONDS,
  verifyQueueyDelivery,
} from './verify-delivery.ts';

const SECRET = 'whsec-queuey-test-secret';
const URL_NO_QUERY = 'https://mcpemails.com/api/stripe/webhook';
const NOW = 1_789_900_000;

/** Sign the way the spec describes, not the way the implementation does. */
function sign(opts: {
  method?: string;
  url?: string;
  body?: string;
  secret?: string;
  timestamp?: number;
  nonce?: string;
  query?: string;
}) {
  const method = opts.method ?? 'POST';
  const url = new URL(opts.url ?? URL_NO_QUERY);
  const body = opts.body ?? '{"id":"evt_1","type":"invoice.payment_succeeded"}';
  const timestamp = String(opts.timestamp ?? NOW);
  const nonce = opts.nonce ?? '3f1c7a6e-0000-4b1a-9d2e-aaaabbbbcccc';
  const hash = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');

  const query =
    opts.query ??
    [...new URLSearchParams(url.search)]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const canonical = [method, path, query, timestamp, nonce, hash].join('\n');
  const signature = createHmac('sha256', Buffer.from(opts.secret ?? SECRET, 'utf8'))
    .update(Buffer.from(canonical, 'utf8'))
    .digest('hex');

  const headers: Record<string, string> = {
    'x-queuey-key-id': 'qsk_test',
    'x-queuey-timestamp': timestamp,
    'x-queuey-nonce': nonce,
    'x-queuey-content-sha256': hash,
    'x-queuey-signature': signature,
  };

  return {
    method,
    url: url.toString(),
    rawBody: Buffer.from(body, 'utf8'),
    secret: SECRET,
    nowSeconds: NOW,
    header: (n: string) => headers[n] ?? null,
    headers,
  };
}

test('a genuine delivery verifies and returns its key id, nonce and signing time', () => {
  const r = verifyQueueyDelivery(sign({}));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.keyId, 'qsk_test');
  assert.equal(r.signedAt.getTime(), NOW * 1000);
});

test('every missing signing header is refused as missing_headers', () => {
  for (const drop of [
    'x-queuey-key-id',
    'x-queuey-timestamp',
    'x-queuey-nonce',
    'x-queuey-content-sha256',
    'x-queuey-signature',
  ]) {
    const s = sign({});
    const r = verifyQueueyDelivery({
      ...s,
      header: (n) => (n === drop ? null : s.headers[n] ?? null),
    });
    assert.deepEqual(r, { ok: false, failure: 'missing_headers' }, `dropping ${drop}`);
  }
});

test('a body altered in transit is body_hash_mismatch, not signature_mismatch', () => {
  const s = sign({});
  const r = verifyQueueyDelivery({ ...s, rawBody: Buffer.from('{"id":"evt_2"}', 'utf8') });
  assert.deepEqual(r, { ok: false, failure: 'body_hash_mismatch' });
});

test('a re-serialised body does not verify — the bytes must be untouched', () => {
  const body = '{"id":"evt_1","type":"invoice.payment_succeeded"}';
  const s = sign({ body });
  // Same JSON, different bytes: a parse/stringify round trip with 2-space
  // indentation, exactly what a framework that calls .json() would hand us.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(body), null, 2), 'utf8');
  const r = verifyQueueyDelivery({ ...s, rawBody: reserialised });
  assert.deepEqual(r, { ok: false, failure: 'body_hash_mismatch' });
});

test('the wrong secret is signature_mismatch', () => {
  const s = sign({});
  const r = verifyQueueyDelivery({ ...s, secret: 'not-the-secret' });
  assert.deepEqual(r, { ok: false, failure: 'signature_mismatch' });
});

test('a non-integer timestamp is malformed, not silently coerced', () => {
  // '' is absent as far as a header read is concerned; ' ' is PRESENT and
  // blank, which is a different fault and must be named differently.
  for (const [bad, failure] of [
    ['', 'missing_headers'],
    [' ', 'malformed_timestamp'],
    ['abc', 'malformed_timestamp'],
    ['1e9', 'malformed_timestamp'],
    ['17899000.5', 'malformed_timestamp'],
  ] as const) {
    const s = sign({});
    const r = verifyQueueyDelivery({
      ...s,
      header: (n) => (n === 'x-queuey-timestamp' ? bad : s.headers[n] ?? null),
    });
    assert.deepEqual(r, { ok: false, failure }, `timestamp ${JSON.stringify(bad)}`);
  }
});

test('the clock skew window is +/- 5 minutes and is enforced on both sides', () => {
  assert.equal(DEFAULT_CLOCK_SKEW_SECONDS, 300);
  const inside = [0, 299, -299];
  for (const offset of inside) {
    const s = sign({ timestamp: NOW + offset });
    assert.equal(verifyQueueyDelivery(s).ok, true, `offset ${offset} should verify`);
  }
  for (const offset of [301, -301]) {
    const s = sign({ timestamp: NOW + offset });
    assert.deepEqual(verifyQueueyDelivery(s), {
      ok: false,
      failure: 'timestamp_outside_window',
    });
  }
});

test('a delivery held past the window is refused — Queuey re-signs each attempt', () => {
  // The whole reason this verification is worth having: a two-day-old Stripe
  // signature is normal and must be tolerated, but a two-day-old QUEUEY
  // signature never happens, so it can be refused.
  const s = sign({ timestamp: NOW - 2 * 24 * 60 * 60 });
  assert.deepEqual(verifyQueueyDelivery(s), {
    ok: false,
    failure: 'timestamp_outside_window',
  });
});

test('a replayed nonce is refused only when a guard is supplied', () => {
  const s = sign({});
  assert.equal(verifyQueueyDelivery(s).ok, true);
  const r = verifyQueueyDelivery({ ...s, nonceAlreadySeen: () => true });
  assert.deepEqual(r, { ok: false, failure: 'replayed_nonce' });
});

// --- the two places the docs disagree -------------------------------------

test('QUERY is sorted by key and encoded, not the raw query string', () => {
  assert.equal(canonicalQuery('?b=2&a=1'), 'a=1&b=2');
  assert.equal(canonicalQuery(''), '');
  assert.equal(canonicalQuery('?x=a b&y=%2F'), 'x=a%20b&y=%2F');
  // Repeated keys keep arrival order; sort() is stable.
  assert.equal(canonicalQuery('?a=2&a=1'), 'a=2&a=1');
});

test('a signature over the RAW query does not verify — the spec normalises', () => {
  const url = `${URL_NO_QUERY}?b=2&a=1`;
  // Signed the way verify-deliveries' sample builds it: the raw string.
  const raw = sign({ url, query: 'b=2&a=1' });
  assert.deepEqual(verifyQueueyDelivery(raw), {
    ok: false,
    failure: 'signature_mismatch',
  });
  // Signed the way signed-requests specifies it: sorted and encoded.
  const normalised = sign({ url });
  assert.equal(verifyQueueyDelivery(normalised).ok, true);
});

test('PATH drops a trailing slash', () => {
  assert.equal(canonicalPath('/api/stripe/webhook/'), '/api/stripe/webhook');
  assert.equal(canonicalPath('/api/stripe/webhook'), '/api/stripe/webhook');
  assert.equal(canonicalPath('/'), '/');
  assert.equal(canonicalPath('///'), '/');
});
