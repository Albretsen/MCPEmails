// ---------------------------------------------------------------------------
// The Stripe webhook, end to end through POST, for the 2026-09-29 Personal
// repricing ($5 / $48 -> $9 / $86.40, new customers only).
//
// Every Personal subscriber before that day keeps billing on the retired
// prices. Their renewals arrive as `customer.subscription.updated` carrying the
// OLD price id; new customers' arrive carrying the NEW one. Both must land on
// `plan = 'personal'` in `user_billing` and on every owned workspace. An
// unmapped price does not revoke access (the route keeps the current plan), but
// it is still wrong: the revenue board labels it "Other", a later plan change
// gets no direction, and the lifecycle emails lose the plan. So this pins the
// mapping at the route, not only at `getPlanByStripePriceId`.
//
// Only the I/O is stubbed: the Stripe client (signature check), the service-role
// Supabase client (recording writes), and `next/server`, whose `after()` is
// where the purchase email would be sent (never, for a subscription update). The price
// resolution, the ledger, the staleness guard and applyUserPlan all run for real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/webhook/route.personal-reprice.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Before anything under test is imported: plans.ts reads price ids at load.
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_personal_reprice_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'off';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_500';
process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_4800';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_8640';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Write = { table: string; op: 'upsert' | 'update'; values: Record<string, unknown> };
const writes: Write[] = [];

/**
 * A chainable stand-in for the service-role client. Every builder method
 * returns the builder; awaiting it resolves to an empty success. The ledger
 * insert is the one read that must return a row, or the route treats the event
 * as a duplicate and does nothing.
 */
function fakeServiceClient() {
  return {
    from(table: string) {
      let inserted = false;
      const result = () =>
        table === 'stripe_webhook_events' && inserted
          ? { data: { event_id: 'evt' }, error: null }
          : { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const name of ['select', 'eq', 'neq', 'gt', 'is', 'limit', 'delete', 'order', 'in']) {
        builder[name] = () => builder;
      }
      builder.insert = () => {
        inserted = true;
        return builder;
      };
      builder.upsert = (values: Record<string, unknown>) => {
        writes.push({ table, op: 'upsert', values });
        return builder;
      };
      builder.update = (values: Record<string, unknown>) => {
        writes.push({ table, op: 'update', values });
        return builder;
      };
      builder.maybeSingle = async () => result();
      builder.single = async () => result();
      builder.then = (resolve: (value: unknown) => unknown) => resolve(result());
      return builder;
    },
  };
}

nodeMock.module('@/lib/supabase/service', {
  namedExports: { createServiceRoleClient: fakeServiceClient },
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      webhooks: {
        // The signature itself is Stripe's code, not ours; the event is the input.
        constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')),
      },
    },
  },
});

// Plain Node cannot resolve `next/server` (the package has no ESM exports map
// for it outside the Next toolchain). The route uses two things from it.
nodeMock.module('next/server', {
  namedExports: {
    // Imported by the route for its type only, but ESM checks the binding.
    NextRequest: Request,
    NextResponse: {
      json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
    },
    after: () => undefined,
  },
});

const { POST } = await import('./route.ts');

let eventSeq = 0;

/** Deliver one `customer.subscription.updated` on `priceId` and return the writes. */
async function deliverRenewal(priceId: string) {
  writes.length = 0;
  eventSeq += 1;
  const event = {
    id: `evt_personal_reprice_${eventSeq}`,
    type: 'customer.subscription.updated',
    created: 1_790_000_000 + eventSeq,
    data: {
      object: {
        id: 'sub_personal_reprice',
        customer: 'cus_personal_reprice',
        status: 'active',
        metadata: { user_id: '00000000-0000-0000-0000-00000000c0de' },
        cancel_at_period_end: false,
        cancel_at: null,
        canceled_at: null,
        items: {
          data: [
            {
              price: { id: priceId },
              current_period_start: 1_790_000_000,
              current_period_end: 1_792_600_000,
            },
          ],
        },
      },
    },
  };
  const request = new Request('https://mcpemails.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=stub' },
    body: JSON.stringify(event),
  });
  // The route types its argument as NextRequest but only reads the Request API.
  const response = await POST(request as unknown as Parameters<typeof POST>[0]);
  return { status: response.status, writes: [...writes] };
}

function planWrites(result: { writes: Write[] }) {
  const billing = result.writes.find((w) => w.table === 'user_billing' && w.op === 'upsert');
  const workspace = result.writes.find((w) => w.table === 'workspaces' && w.op === 'update');
  return { billing: billing?.values, workspace: workspace?.values };
}

for (const [label, priceId] of [
  ['retired $5 monthly', 'price_personal_500'],
  ['retired $48 yearly', 'price_personal_4800'],
  ['new $9 monthly', 'price_personal_900'],
  ['new $86.40 yearly', 'price_personal_8640'],
] as const) {
  test(`a renewal on the ${label} Personal price keeps the customer on Personal`, async () => {
    const result = await deliverRenewal(priceId);
    assert.equal(result.status, 200);
    const { billing, workspace } = planWrites(result);
    assert.equal(billing?.plan, 'personal', 'user_billing.plan');
    assert.equal(billing?.subscription_status, 'active');
    assert.equal(workspace?.plan, 'personal', 'every owned workspace is projected to Personal');
  });
}

test('an unknown price still leaves the plan untouched rather than guessing', async () => {
  // The control: this is what a renewal on an UNMAPPED retired price would
  // look like. No plan is written anywhere, which is safe but blind.
  const result = await deliverRenewal('price_nobody_configured');
  assert.equal(result.status, 200);
  const { billing, workspace } = planWrites(result);
  assert.ok(billing, 'linkage and status are still synced');
  assert.equal('plan' in billing!, false, 'an unmapped price must not write a plan');
  assert.equal(workspace && 'plan' in workspace, false);
});
