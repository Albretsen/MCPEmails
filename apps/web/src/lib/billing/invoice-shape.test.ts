// ---------------------------------------------------------------------------
// invoiceLinePriceId: the plan an invoice is for.
//
// A renewal or a checkout invoice resolves to its first non-add-on line, as it
// always has. An in-place upgrade invoice (always_invoice proration) leads
// with the CREDIT for the old plan, so the charged line must win.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/billing/invoice-shape.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_MONTHLY = 'price_founder_month';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_YEARLY = 'price_founder_year';

const { invoiceLinePriceId, invoiceLinePriceIds, invoiceSubscriptionId } = await import(
  './invoice-shape.ts'
);

type Line = { price: string; amount: number; proration?: boolean; shape?: 'pricing' | 'price' | 'plan' };

function invoice(lines: Line[], extra: Record<string, unknown> = {}) {
  return {
    id: 'in_1',
    lines: {
      data: lines.map(({ price, amount, proration, shape = 'pricing' }) => ({
        amount,
        ...(proration ? { proration: true } : {}),
        ...(shape === 'pricing'
          ? { pricing: { price_details: { price } } }
          : shape === 'price'
            ? { price: { id: price } }
            : { plan: { id: price } }),
      })),
    },
    ...extra,
  } as never;
}

test('a renewal invoice resolves to its plan line, as before', () => {
  assert.equal(invoiceLinePriceId(invoice([{ price: 'price_solo_month', amount: 1500 }])), 'price_solo_month');
});

test('a Business renewal with the add-on resolves to the plan, not the add-on', () => {
  assert.equal(
    invoiceLinePriceId(
      invoice([
        { price: 'price_addon_month', amount: 600 },
        { price: 'price_founder_month', amount: 2900 },
      ]),
    ),
    'price_founder_month',
  );
});

test('an upgrade invoice: the debit for the new plan wins over the credit for the old', () => {
  const upgrade = invoice([
    // Unused time on Pro, credited back.
    { price: 'price_solo_month', amount: -1041, proration: true },
    // Remaining time on founder Business, charged.
    { price: 'price_founder_month', amount: 2013, proration: true },
    // The add-on: a credit and a debit of its own.
    { price: 'price_addon_month', amount: -150, proration: true },
    { price: 'price_addon_month', amount: 300, proration: true },
  ]);
  assert.equal(invoiceLinePriceId(upgrade), 'price_founder_month');
});

test('the same on an older API shape (line.price, line.plan)', () => {
  for (const shape of ['price', 'plan'] as const) {
    const upgrade = invoice([
      { price: 'price_solo_month', amount: -1041, proration: true, shape },
      { price: 'price_founder_year', amount: 25000, proration: true, shape },
    ]);
    assert.equal(invoiceLinePriceId(upgrade), 'price_founder_year');
  }
});

test('a zero-amount invoice still resolves to its first plan line', () => {
  assert.equal(
    invoiceLinePriceId(
      invoice([
        { price: 'price_addon_month', amount: 0 },
        { price: 'price_personal_month', amount: 0 },
      ]),
    ),
    'price_personal_month',
  );
});

test('only the add-on: the add-on, as before; no lines: null', () => {
  assert.equal(invoiceLinePriceId(invoice([{ price: 'price_addon_month', amount: 300 }])), 'price_addon_month');
  assert.equal(invoiceLinePriceId(invoice([])), null);
});

test('every line price, credits included, and the subscription id in both shapes', () => {
  const upgrade = invoice(
    [
      { price: 'price_solo_month', amount: -1041 },
      { price: 'price_founder_month', amount: 2013 },
    ],
    { parent: { subscription_details: { subscription: 'sub_1' } } },
  );
  assert.deepEqual(invoiceLinePriceIds(upgrade), ['price_solo_month', 'price_founder_month']);
  assert.equal(invoiceSubscriptionId(upgrade), 'sub_1');
  assert.equal(invoiceSubscriptionId(invoice([], { subscription: { id: 'sub_2' } })), 'sub_2');
  assert.equal(invoiceSubscriptionId(invoice([])), null);
});
