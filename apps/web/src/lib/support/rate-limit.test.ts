// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs src/lib/support/rate-limit.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

const { isRateLimited, SUPPORT_RATE_LIMITS } = await import('./rate-limit.ts');

type Row = { ip_hash: string | null; email: string; source: string; created_at: string };

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

/** An in-memory support_tickets with the same filter semantics as the Supabase store. */
function fakeCounter(rows: Row[], opts: { fail?: boolean } = {}) {
  return {
    async count(filter: { ipHash?: string; email?: string; source?: string }, sinceIso: string) {
      if (opts.fail) return null;
      return rows.filter(
        (r) =>
          r.created_at >= sinceIso &&
          (filter.ipHash === undefined || r.ip_hash === filter.ipHash) &&
          (filter.email === undefined || r.email === filter.email) &&
          (filter.source === undefined || r.source === filter.source),
      ).length;
    },
  };
}

const row = (over: Partial<Row>): Row => ({
  ip_hash: 'ip-a',
  email: 'a@example.com',
  source: 'form_signed_out',
  created_at: minutesAgo(5),
  ...over,
});

const ask = (rows: Row[], over: Partial<{ ipHash: string | null; email: string; source: 'form_signed_in' | 'form_signed_out' }> = {}) =>
  isRateLimited(fakeCounter(rows), {
    ipHash: 'ip-a',
    email: 'a@example.com',
    source: 'form_signed_out',
    nowMs: NOW,
    ...over,
  });

test('the numbers are the documented ones', () => {
  assert.deepEqual({ ...SUPPORT_RATE_LIMITS }, {
    emailPerHour: 3,
    emailPerDay: 6,
    ipPerHour: 5,
    ipPerDay: 20,
    signedOutGlobalPerHour: 30,
  });
});

test('nothing on record: allowed', async () => {
  assert.equal(await ask([]), false);
});

test('per email: 2 in the hour allowed, the 3rd row blocks the next', async () => {
  const two = [row({ ip_hash: 'x1' }), row({ ip_hash: 'x2' })];
  assert.equal(await ask(two, { ipHash: 'fresh' }), false);
  assert.equal(await ask([...two, row({ ip_hash: 'x3' })], { ipHash: 'fresh' }), true);
});

test('per email per day: 6 spread over the day blocks; older than a day does not count', async () => {
  const spread = [90, 180, 300, 600, 900, 1200].map((m, i) => row({ ip_hash: `x${i}`, created_at: minutesAgo(m) }));
  assert.equal(await ask(spread, { ipHash: 'fresh' }), true);
  const old = spread.map((r) => ({ ...r, created_at: minutesAgo(25 * 60) }));
  assert.equal(await ask(old, { ipHash: 'fresh' }), false);
});

test('per IP: 5 in the hour from different addresses blocks', async () => {
  const five = [1, 2, 3, 4, 5].map((i) => row({ email: `p${i}@example.com` }));
  assert.equal(await ask(five.slice(0, 4), { email: 'new@example.com' }), false);
  assert.equal(await ask(five, { email: 'new@example.com' }), true);
});

test('per IP per day: 20 blocks', async () => {
  const many = Array.from({ length: 20 }, (_, i) => row({ email: `p${i}@example.com`, created_at: minutesAgo(70 + i * 30) }));
  assert.equal(await ask(many.slice(0, 19), { email: 'new@example.com' }), false);
  assert.equal(await ask(many, { email: 'new@example.com' }), true);
});

test('no IP: the IP limits are skipped, the email limits still apply', async () => {
  const five = [1, 2, 3, 4, 5].map((i) => row({ email: `p${i}@example.com`, ip_hash: null }));
  assert.equal(await ask(five, { ipHash: null, email: 'new@example.com' }), false);
  const three = [1, 2, 3].map(() => row({ ip_hash: null }));
  assert.equal(await ask(three, { ipHash: null }), true);
});

test('signed-out global hourly cap blocks rotation of IP and address', async () => {
  const rotated = Array.from({ length: 30 }, (_, i) => row({ ip_hash: `ip${i}`, email: `v${i}@example.com` }));
  assert.equal(await ask(rotated.slice(0, 29), { ipHash: 'fresh', email: 'new@example.com' }), false);
  assert.equal(await ask(rotated, { ipHash: 'fresh', email: 'new@example.com' }), true);
  // A signed-in member is not held back by anonymous traffic.
  assert.equal(await ask(rotated, { ipHash: 'fresh', email: 'new@example.com', source: 'form_signed_in' }), false);
});

test('a failing count fails open', async () => {
  const limited = await isRateLimited(fakeCounter([], { fail: true }), {
    ipHash: 'ip-a',
    email: 'a@example.com',
    source: 'form_signed_out',
    nowMs: NOW,
  });
  assert.equal(limited, false);
});
