import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseDunning, type DunningRow } from './dunning-stats.ts';
import { usdPerUnit } from '../analytics/fx.ts';

function row(over: Partial<DunningRow> = {}): DunningRow {
  return {
    template: 'dunning_1',
    category: 'transactional',
    stripe_customer_id: 'cus_synthetic',
    scope_key: 'in_A',
    send_after: '2026-09-01T00:00:00.000Z',
    sent_at: '2026-09-01T01:00:00.000Z',
    cancelled_at: null,
    cancel_reason: null,
    last_error: null,
    attempts: 0,
    recipient: 'someone@example.com',
    payload: { amountCents: 500, currency: 'usd', planId: 'personal' },
    ...over,
  };
}

/** One emailed sequence that then recovered. */
function recovered(scope: string, payload: DunningRow['payload']): DunningRow[] {
  return [
    row({ scope_key: scope, payload }),
    row({
      template: 'dunning_3',
      scope_key: scope,
      sent_at: null,
      cancelled_at: '2026-09-02T00:00:00.000Z',
      cancel_reason: 'payment_recovered',
      payload,
    }),
  ];
}

test('recovered cash in several currencies is converted to USD, not added as-is', () => {
  const eur = usdPerUnit('eur', '2026-09');
  assert.ok(eur !== null);
  const s = summariseDunning(
    [
      ...recovered('in_A', { amountCents: 500, currency: 'usd', planId: 'personal' }),
      ...recovered('in_B', { amountCents: 1000, currency: 'EUR', planId: 'personal' }),
      ...recovered('in_C', { amountCents: 700, currency: 'xts', planId: 'personal' }),
    ],
    new Date('2026-09-05T00:00:00.000Z'),
  );
  assert.equal(s.recovery.recoveredAfterEmail, 3);
  assert.equal(s.recovery.currency, 'usd');
  assert.equal(s.recovery.recoveredCents, Math.round(500 + 1000 * eur));
  assert.deepEqual(s.recovery.otherCurrencies, ['xts']);
});

test('an all-USD queue reports exactly the cents on the invoices', () => {
  const s = summariseDunning(
    [
      ...recovered('in_A', { amountCents: 500, currency: 'usd', planId: 'personal' }),
      ...recovered('in_B', { amountCents: 1500, currency: null, planId: 'personal' }),
    ],
    new Date('2026-09-05T00:00:00.000Z'),
  );
  assert.equal(s.recovery.recoveredCents, 2000);
  assert.equal(s.recovery.currency, 'usd');
  assert.deepEqual(s.recovery.otherCurrencies, []);
});
