// ---------------------------------------------------------------------------
// The inbox cap is the paywall now, so the guard in front of it is the single
// most consequential piece of backend logic in the 2026-08-19 repricing.
//
// Three properties are tested, and all three are ways a real person gets hurt
// if they break:
//   1. A grandfathered user is never capped. 176 accounts were promised this.
//   2. A new Free user is capped at exactly one inbox, not zero, not two.
//   3. A RECONNECT is not blocked. Free is one inbox, so a free user is AT the
//      cap from their first mailbox onward, and every credential refresh after
//      that arrives while currentCount >= maxInboxes. Getting this wrong locks
//      people out of the mailbox they already connected.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/plans/check-inbox-limit.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkInboxLimit,
  inboxExistsForEmail,
  inboxLimitErrorBody,
} from './check-inbox-limit.ts';

type EffectivePlanRow = { plan: string; comped_scale: boolean; unlimited_inboxes: boolean };

/**
 * A Supabase client stub with exactly the surface these two functions touch:
 * one `.rpc()` and a couple of chained `.from()` builders. Deliberately not a
 * mocking library; the shape being faked is small and reading it beats reading
 * a matcher DSL.
 */
function fakeSupabase(opts: {
  effectivePlan: EffectivePlanRow | null;
  inboxCount: number;
  /** Addresses that already have a live inbox in this workspace. */
  existingEmails?: string[];
}) {
  const existing = new Set(opts.existingEmails ?? []);
  return {
    rpc(name: string) {
      assert.equal(name, 'effective_workspace_plan');
      return Promise.resolve({ data: opts.effectivePlan ? [opts.effectivePlan] : [], error: null });
    },
    from(table: string) {
      assert.equal(table, 'inboxes');
      let email: string | null = null;
      const builder = {
        select: () => builder,
        eq: (column: string, value: string) => {
          if (column === 'email_address') email = value;
          return builder;
        },
        is: () => builder,
        maybeSingle: () => Promise.resolve({ data: email && existing.has(email) ? { id: 'inbox-1' } : null, error: null }),
        // The count query is awaited directly, without .maybeSingle().
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ count: opts.inboxCount, error: null }).then(resolve),
      };
      return builder;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const WORKSPACE = '00000000-0000-0000-0000-0000000000aa';

test('a grandfathered user is not capped, whatever their plan projects', async () => {
  const result = await checkInboxLimit(
    fakeSupabase({
      effectivePlan: { plan: 'free', comped_scale: false, unlimited_inboxes: true },
      inboxCount: 7,
    }),
    WORKSPACE,
  );

  assert.equal(result.atLimit, false);
  assert.equal(result.maxInboxes, null);
  assert.equal(result.unlimitedInboxes, true);
  assert.equal(result.currentCount, 7);
  assert.equal(result.plan, 'free');
  assert.equal(result.planName, 'Free');
});

test('a brand-new Free user gets exactly one inbox', async () => {
  const first = await checkInboxLimit(
    fakeSupabase({
      effectivePlan: { plan: 'free', comped_scale: false, unlimited_inboxes: false },
      inboxCount: 0,
    }),
    WORKSPACE,
  );
  assert.equal(first.atLimit, false, 'the first mailbox must be allowed');
  assert.equal(first.maxInboxes, 1);

  const second = await checkInboxLimit(
    fakeSupabase({
      effectivePlan: { plan: 'free', comped_scale: false, unlimited_inboxes: false },
      inboxCount: 1,
    }),
    WORKSPACE,
  );
  assert.equal(second.atLimit, true, 'the second mailbox must be refused');
  assert.equal(second.maxInboxes, 1);
  assert.equal(second.unlimitedInboxes, false);
});

test('a paid plan is uncapped without needing the grandfather', async () => {
  for (const plan of ['solo', 'pro']) {
    const result = await checkInboxLimit(
      fakeSupabase({
        effectivePlan: { plan, comped_scale: false, unlimited_inboxes: false },
        inboxCount: 40,
      }),
      WORKSPACE,
    );
    assert.equal(result.atLimit, false, `${plan} must not be capped`);
    assert.equal(result.maxInboxes, null);
  }
  const comped = await checkInboxLimit(
    fakeSupabase({
      effectivePlan: { plan: 'pro', comped_scale: true, unlimited_inboxes: false },
      inboxCount: 40,
    }),
    WORKSPACE,
  );
  assert.equal(comped.atLimit, false);
});

test('a missing effective-plan row falls back to Free rather than opening the gate', async () => {
  const result = await checkInboxLimit(
    fakeSupabase({ effectivePlan: null, inboxCount: 3 }),
    WORKSPACE,
  );
  assert.equal(result.plan, 'free');
  assert.equal(result.maxInboxes, 1);
  assert.equal(result.atLimit, true);
});

test('a reconnect of an address the workspace already has is recognised', async () => {
  // The connect routes only consult the cap when this returns false, which is
  // what keeps a credential refresh working for a Free user sitting at 1 of 1.
  const supabase = fakeSupabase({
    effectivePlan: { plan: 'free', comped_scale: false, unlimited_inboxes: false },
    inboxCount: 1,
    existingEmails: ['already@example.com'],
  });

  assert.equal(await inboxExistsForEmail(supabase, WORKSPACE, 'already@example.com'), true);
  assert.equal(await inboxExistsForEmail(supabase, WORKSPACE, 'brand-new@example.com'), false);

  // And the workspace really is at its cap, so the exemption is what is doing
  // the work rather than there happening to be room.
  const limit = await checkInboxLimit(supabase, WORKSPACE);
  assert.equal(limit.atLimit, true);
});

test('the 402 body is machine-readable and leaks no internal plan slug', async () => {
  const limit = await checkInboxLimit(
    fakeSupabase({
      effectivePlan: { plan: 'solo', comped_scale: false, unlimited_inboxes: false },
      inboxCount: 1,
    }),
    WORKSPACE,
  );
  // Force the capped shape through the Free path, which is the only one that
  // can actually reach the error body in production.
  const capped = await checkInboxLimit(
    fakeSupabase({
      effectivePlan: { plan: 'free', comped_scale: false, unlimited_inboxes: false },
      inboxCount: 1,
    }),
    WORKSPACE,
  );
  assert.equal(limit.atLimit, false);

  const body = inboxLimitErrorBody(capped);
  assert.equal(body.error_code, 'inbox_limit_reached');
  assert.equal(body.plan, 'free');
  assert.equal(body.plan_name, 'Free');
  assert.equal(body.current_count, 1);
  assert.equal(body.max_inboxes, 1);
  assert.equal(body.upgrade_url, '/pricing');

  // The old sentence read "Your solo plan allows ...", printing a database slug
  // at a customer. Nothing user-visible may contain an internal id again.
  for (const slug of ['solo', 'pro', 'free']) {
    assert.ok(!body.error.includes(slug), `error sentence leaks the internal slug "${slug}": ${body.error}`);
  }
});
