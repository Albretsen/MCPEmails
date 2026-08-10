import assert from 'node:assert/strict';
import test from 'node:test';

import { PLANS, planDisplayName, resolvePlanLimits } from './plans.ts';

test('usage allowances and public names match the launch contract', () => {
  assert.equal(PLANS.free.name, 'Free');
  assert.equal(PLANS.solo.name, 'Agent');
  assert.equal(PLANS.pro.name, 'Scale');

  assert.equal(resolvePlanLimits('free').maxMonthlyToolCalls, 2_500);
  assert.equal(resolvePlanLimits('solo').maxMonthlyToolCalls, 50_000);
  assert.equal(resolvePlanLimits('pro').maxMonthlyToolCalls, 300_000);

  assert.equal(planDisplayName('solo'), 'Agent');
  assert.equal(planDisplayName('pro'), 'Scale');
});

test('a comped Scale entitlement overrides Stripe projection without changing its truth', () => {
  const compedFromFree = resolvePlanLimits('free', { compedScale: true });
  const compedFromAgent = resolvePlanLimits('solo', { compedScale: true });

  assert.equal(compedFromFree.maxMonthlyToolCalls, Infinity);
  assert.equal(compedFromAgent.maxMonthlyToolCalls, Infinity);
  assert.equal(compedFromFree.maxRequestsPerMinute, PLANS.pro.limits.maxRequestsPerMinute);
  assert.equal(compedFromFree.auditLogEnabled, true);

  // The Stripe/workspace projection remains an input, not a mutation made by
  // entitlement resolution. Webhook replays can safely continue to update it.
  assert.equal(resolvePlanLimits('free').maxMonthlyToolCalls, 2_500);
  assert.equal(resolvePlanLimits('solo').maxMonthlyToolCalls, 50_000);
});

test('unknown legacy plans safely use Free limits unless a comped entitlement applies', () => {
  assert.equal(resolvePlanLimits('unknown').maxMonthlyToolCalls, 2_500);
  assert.equal(resolvePlanLimits('unknown', { compedScale: true }).maxMonthlyToolCalls, Infinity);
});
