import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchWorkspaceActionAllowance, isPublicCap, shapeActionAllowance, type AllowanceRow } from './allowance.ts';

const SEPT = '2026-09-01T00:00:00+00:00';
const OCT = '2026-10-01T00:00:00+00:00';

function row(overrides: Partial<AllowanceRow> = {}): AllowanceRow {
  return {
    plan: 'free',
    owner_id: '00000000-0000-0000-0000-000000000001',
    exempt: false,
    exempt_reason: null,
    cap: 150,
    period_start: '2026-09-19T14:32:00+00:00',
    period_end: OCT,
    grace_ends_at: '2026-09-19T14:32:00+00:00',
    in_grace: false,
    used: 42,
    remaining: 108,
    ...overrides,
  };
}

test('a metered Free workspace shows its cap, remaining and reset', () => {
  const shaped = shapeActionAllowance(row());
  assert.deepEqual(shaped, {
    plan: 'free',
    exempt: false,
    exempt_reason: null,
    in_grace: false,
    grace_ends_at: '2026-09-19T14:32:00+00:00',
    monthly: {
      used: 42,
      cap: 150,
      remaining: 108,
      period_start: '2026-09-19T14:32:00+00:00',
      resets_at: OCT,
    },
  });
});

test('a Free workspace in its grace week keeps the cap visible and says so', () => {
  // The tile needs the cap to say "150" and the grace end to say "until";
  // enforcement is off, but the number the customer is about to meet is not
  // a secret.
  const shaped = shapeActionAllowance(row({ in_grace: true, used: 0, remaining: 150 }));
  assert.equal(shaped.in_grace, true);
  assert.equal(shaped.grace_ends_at, '2026-09-19T14:32:00+00:00');
  assert.equal(shaped.monthly.cap, 150);
  assert.equal(shaped.monthly.used, 0);
});

test('a paid plan never exposes its silent ceiling, not even by subtraction', () => {
  for (const plan of ['personal', 'solo', 'pro', 'enterprise']) {
    const shaped = shapeActionAllowance(
      row({ plan, cap: 25_000, remaining: 24_958, grace_ends_at: null, period_start: SEPT }),
    );
    assert.equal(shaped.plan, plan);
    assert.equal(shaped.monthly.cap, null, `${plan} cap must be hidden`);
    assert.equal(shaped.monthly.remaining, null, `${plan} remaining must be hidden`);
    assert.equal(shaped.monthly.used, 42, 'the count itself is still reported');
    assert.equal(shaped.in_grace, false);
    assert.equal(shaped.grace_ends_at, null);
  }
});

test('an exempt workspace reports the month and no cap, whatever the plan', () => {
  for (const reason of ['early_member', 'comped', 'exemption'] as const) {
    const shaped = shapeActionAllowance(
      row({ exempt: true, exempt_reason: reason, cap: null, remaining: null, grace_ends_at: null, in_grace: false, period_start: SEPT }),
    );
    assert.equal(shaped.exempt, true);
    assert.equal(shaped.exempt_reason, reason);
    assert.equal(shaped.monthly.cap, null);
    assert.equal(shaped.monthly.remaining, null);
    assert.equal(shaped.monthly.period_start, SEPT);
    assert.equal(shaped.monthly.resets_at, OCT);
  }
});

test('an exempt row with an unrecognised reason is still exempt, with reason null', () => {
  // The SQL contract lists three reasons. A fourth added later must not turn
  // into an "early member" badge by accident, nor into a metered bar.
  const shaped = shapeActionAllowance(row({ exempt: true, exempt_reason: 'something_new', cap: null, remaining: null }));
  assert.equal(shaped.exempt, true);
  assert.equal(shaped.exempt_reason, null);
  assert.equal(shaped.monthly.cap, null);
});

test('a non-exempt row never carries an exempt_reason', () => {
  const shaped = shapeActionAllowance(row({ exempt: false, exempt_reason: 'early_member' }));
  assert.equal(shaped.exempt_reason, null);
});

test('remaining is clamped at zero once the cap is used up', () => {
  const shaped = shapeActionAllowance(row({ used: 163, remaining: 0 }));
  assert.equal(shaped.monthly.used, 163);
  assert.equal(shaped.monthly.remaining, 0);
});

test('isPublicCap is true only for a metered Free workspace', () => {
  assert.equal(isPublicCap({ plan: 'free', exempt: false, cap: 150 }), true);
  assert.equal(isPublicCap({ plan: 'free', exempt: true, cap: null }), false);
  assert.equal(isPublicCap({ plan: 'personal', exempt: false, cap: 25_000 }), false);
  assert.equal(isPublicCap({ plan: 'free', exempt: false, cap: null }), false);
});

test('the fetcher returns the shaped row, and null on error or no row', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const fake = (result: { data: AllowanceRow[] | null; error: { message: string } | null }) =>
    ({
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push([fn, args]);
        return Promise.resolve(result);
      },
    }) as unknown as Parameters<typeof fetchWorkspaceActionAllowance>[0];

  const ok = await fetchWorkspaceActionAllowance(fake({ data: [row()], error: null }), 'ws-1');
  assert.equal(ok?.monthly.cap, 150);
  assert.deepEqual(calls[0], ['workspace_action_allowance', { p_workspace_id: 'ws-1' }]);

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await fetchWorkspaceActionAllowance(fake({ data: null, error: { message: 'boom' } }), 'ws-1'), null);
    assert.equal(await fetchWorkspaceActionAllowance(fake({ data: [], error: null }), 'ws-unknown'), null);
  } finally {
    console.error = originalError;
  }
});
