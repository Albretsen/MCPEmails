import test from 'node:test';
import assert from 'node:assert/strict';
import { csvField, rewardsCsv, shortId, REWARD_CSV_COLUMNS, fetchAllRewards } from './admin-referrals.ts';

test('csvField quotes commas, quotes and line breaks, and defuses formulas', () => {
  assert.equal(csvField(null), '');
  assert.equal(csvField(1500), '1500');
  assert.equal(csvField('-1500'), '-1500');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvField('@cmd'), "'@cmd");
});

test('rewardsCsv: header, one line per row, decimal amount', () => {
  const csv = rewardsCsv([
    {
      id: 'rw-1', referral_id: 'ref-1', side: 'referrer', kind: 'stripe_credit', amount_cents: 900, currency: 'usd',
      stripe_customer_id: 'cus_1', stripe_balance_txn_id: 'cbtxn_1', entitlement_until: null, issued_at: '2026-11-20T10:15:00Z',
    },
    {
      id: 'rw-2', referral_id: 'ref-2', side: 'referrer', kind: 'personal_month', amount_cents: null, currency: 'usd',
      stripe_customer_id: null, stripe_balance_txn_id: null, entitlement_until: '2026-12-20T00:00:00Z', issued_at: '2026-11-21T10:15:00Z',
    },
  ]);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], REWARD_CSV_COLUMNS.join(','));
  assert.equal(lines[1], '2026-11-20T10:15:00Z,rw-1,ref-1,referrer,stripe_credit,900,9.00,usd,cus_1,cbtxn_1,');
  assert.equal(lines[2], '2026-11-21T10:15:00Z,rw-2,ref-2,referrer,personal_month,,,usd,,,2026-12-20T00:00:00Z');
});

test('shortId keeps eight characters', () => {
  assert.equal(shortId('12345678-aaaa-bbbb'), '12345678');
  assert.equal(shortId(null), '');
});

test('fetchAllRewards pages past the 1000-row cap under a total order', async () => {
  const total = 2345;
  const calls: Array<[number, number]> = [];
  const orders: string[] = [];
  const db = {
    from() {
      const chain = {
        select() { return chain; },
        order(col: string) { orders.push(col); return chain; },
        range(from: number, to: number) {
          calls.push([from, to]);
          const n = Math.max(0, Math.min(to, total - 1) - from + 1);
          return Promise.resolve({ data: Array.from({ length: n }, (_, i) => ({ id: String(from + i) })), error: null });
        },
      };
      return chain;
    },
  };
  const rows = await fetchAllRewards(db as never);
  assert.equal(rows.length, total);
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.deepEqual(orders.slice(0, 2), ['issued_at', 'id']);
});
