/**
 * The to-do list is the one panel on /admin/growth a reader is invited to act
 * on without checking the numbers underneath it, so the rules get tests for
 * both directions: that a real condition produces a line, and that a quiet
 * week produces none.
 *
 * The blocked-check tests matter as much as the firing ones. A rule whose data
 * failed must be counted as blocked rather than silently passing, or a Stripe
 * outage turns "money at risk" into "nothing to do".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENTION_CHECK_COUNT,
  ATTENTION_THRESHOLDS,
  attentionReport,
  type AttentionInput,
} from './growth-attention.ts';
import type { RevenueSummary } from './revenue-math.ts';

const NOW = Date.parse('2026-09-03T12:00:00Z');

const revenue: RevenueSummary = {
  currency: 'usd',
  mrrMinor: 3500,
  arrMinor: 42000,
  payingCustomers: 6,
  compedCustomers: 1,
  arpaMinor: 583,
  atRiskMinor: 0,
  atRiskCustomers: 0,
  leavingMinor: 0,
  leavingCustomers: 0,
  newMrrMinor: 500,
  newCustomers: 1,
  churnedMrrMinor: 0,
  churnedCustomers: 0,
  netNewMrrMinor: 500,
  byPlan: [],
  internalCustomers: 1,
  otherCurrencies: [],
};

/** A week where nothing is wrong. Every rule below mutates a copy of this. */
function calm(): AttentionInput {
  return {
    revenue: { ...revenue },
    checkout: {
      pricingViewed: 40,
      checkoutStarted: 8,
      checkoutCompleted: 6,
      abandoned: 2,
      checkoutFailed: 0,
      portalOpened: 3,
      internalExcluded: 4,
      lastCompletedAt: '2026-09-01T09:00:00Z',
    },
    cash: {
      currency: 'usd',
      allTimeMinor: 25000,
      last30Minor: 4800,
      months: [],
      charges: 9,
      since: '2026-08-15T00:00:00Z',
      truncated: false,
      mode: 'live',
    },
    gmail: {
      used: 70,
      cap: 100,
      remaining: 30,
      percent: 70,
      ratePerMonth: 5.5,
      projectedExhaustion: '2026-11',
      level: 'ok',
    },
    pressure: {
      capped_workspaces: 120,
      at_ceiling: 59,
      at_ceiling_activated: 4,
      capped_activated: 40,
      grandfathered_workspaces: 151,
      grandfathered_over_free: 30,
      comped_workspaces: 1,
      paid_workspaces: 6,
    },
    lifecycle: {
      value_activated: 169,
      one_and_done: 40,
      at_risk: 20,
      active_7d: 115,
      active_28d: 150,
    },
    health: { level: 'ok', reason: 'All good.', monitor: { openIncidents: 0 } },
    incidents: [],
    errors: [{ tool_name: 'email_read', error_code: 'auth_failed', failures: 10, calls: 5000 }],
    windowDays: 28,
  };
}

test('a calm week produces no items and still reports every check as run', () => {
  const report = attentionReport(calm(), NOW);
  assert.deepEqual(report.items, []);
  assert.equal(report.checksRun, ATTENTION_CHECK_COUNT);
  assert.equal(report.checksBlocked, 0);
});

test('a failed read blocks its rules rather than passing them', () => {
  const input = calm();
  input.revenue = null;
  input.cash = null;
  const report = attentionReport(input, NOW);
  // Stripe mode, at risk, leaving, churn and the floors rule all need one of
  // the two, and none of them may report "nothing to do".
  assert.equal(report.checksBlocked, 5);
  assert.equal(report.checksRun, ATTENTION_CHECK_COUNT - 5);
  assert.deepEqual(report.items, []);
});

test('test-mode Stripe is an item, because it invalidates the numbers above it', () => {
  const input = calm();
  input.cash = { ...input.cash!, mode: 'test' };
  const report = attentionReport(input, NOW);
  const item = report.items.find((entry) => entry.id === 'stripe-mode');
  assert.ok(item);
  assert.equal(item.severity, 'act');
});

test('money at risk names the amount and the count, never a rate', () => {
  const input = calm();
  input.revenue = { ...revenue, atRiskMinor: 1500, atRiskCustomers: 2 };
  const item = attentionReport(input, NOW).items.find((entry) => entry.id === 'mrr-at-risk');
  assert.ok(item);
  assert.match(item.title, /\$15/);
  assert.match(item.population, /2 live subscription/);
  assert.doesNotMatch(item.title, /%/);
});

test('churn only fires when it actually beat new business', () => {
  const input = calm();
  input.revenue = { ...revenue, churnedMrrMinor: 400, churnedCustomers: 1, newMrrMinor: 500, newCustomers: 1 };
  assert.equal(attentionReport(input, NOW).items.some((entry) => entry.id === 'churn-outran-new'), false);

  input.revenue = { ...revenue, churnedMrrMinor: 900, churnedCustomers: 2, newMrrMinor: 500, newCustomers: 1 };
  const item = attentionReport(input, NOW).items.find((entry) => entry.id === 'churn-outran-new');
  assert.ok(item);
  // Both figures, so a reader can tell a bad month from a busy one.
  assert.match(item.title, /\$9/);
  assert.match(item.title, /\$5/);
});

test('the inbox ceiling counts only workspaces that already used a mailbox', () => {
  const input = calm();
  // Plenty standing at the ceiling, but almost none of them ever read a
  // message: that is a population that left, not a thwarted customer.
  input.pressure = { ...input.pressure!, at_ceiling: 90, at_ceiling_activated: 2 };
  assert.equal(attentionReport(input, NOW).items.some((entry) => entry.id === 'inbox-ceiling'), false);

  input.pressure = { ...input.pressure!, at_ceiling_activated: ATTENTION_THRESHOLDS.ceilingActivated };
  const item = attentionReport(input, NOW).items.find((entry) => entry.id === 'inbox-ceiling');
  assert.ok(item);
  assert.match(item.population, /never be charged/);
});

test('one-and-done is not computed at all below its minimum denominator', () => {
  const input = calm();
  // 8 of 10 is 80%, well past the share threshold, and still says nothing.
  input.lifecycle = { value_activated: 10, one_and_done: 8, at_risk: 1, active_7d: 2, active_28d: 3 };
  assert.equal(attentionReport(input, NOW).items.some((entry) => entry.id === 'one-and-done'), false);

  input.lifecycle = { value_activated: 100, one_and_done: 60, at_risk: 10, active_7d: 20, active_28d: 30 };
  assert.ok(attentionReport(input, NOW).items.find((entry) => entry.id === 'one-and-done'));
});

test('error concentration needs a real volume of failures, not just a share', () => {
  const input = calm();
  // 100% of failures, three of them. Says nothing.
  input.errors = [{ tool_name: 'draft', error_code: 'x', failures: 3, calls: 900 }];
  assert.equal(attentionReport(input, NOW).items.some((entry) => entry.id === 'error-concentration'), false);

  input.errors = [
    { tool_name: 'email_compose', error_code: 'smtp_auth', failures: 80, calls: 900 },
    { tool_name: 'email_read', error_code: null, failures: 40, calls: 9000 },
  ];
  const item = attentionReport(input, NOW).items.find((entry) => entry.id === 'error-concentration');
  assert.ok(item);
  assert.match(item.title, /email_compose/);
});

test('a quiet sales stretch is dated from the last completed checkout', () => {
  const input = calm();
  input.checkout = { ...input.checkout!, lastCompletedAt: '2026-07-01T09:00:00Z' };
  const item = attentionReport(input, NOW).items.find((entry) => entry.id === 'quiet-sale');
  assert.ok(item);
  assert.match(item.title, /64 days/);
});

test('items sort act before watch and keep declaration order within a severity', () => {
  const input = calm();
  input.cash = { ...input.cash!, mode: 'test', truncated: true };
  input.revenue = { ...revenue, atRiskMinor: 1500, atRiskCustomers: 2 };
  input.gmail = { ...input.gmail!, level: 'warn' };
  const ids = attentionReport(input, NOW).items.map((entry) => entry.id);
  assert.deepEqual(ids, ['stripe-mode', 'mrr-at-risk', 'gmail-cap', 'figures-are-floors']);
});
