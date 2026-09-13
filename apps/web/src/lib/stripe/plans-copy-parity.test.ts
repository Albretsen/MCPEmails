import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FREE_ACTION_ALLOWANCE, FREE_ACTION_GRACE_DAYS, PLANS } from './plans.ts';

/**
 * The Free action allowance is quoted in three places that cannot import each
 * other: the SQL function that enforces it (c_free_cap / c_grace in
 * supabase/migrations/20260912200000_free_action_cap_150.sql), plans.ts (the
 * constants and the Free feature list), and the translated pricing page copy.
 * This file pins the last two to each other. The first is pinned by
 * scripts/verify-action-allowance.sql, run by hand before the edge deploy.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pricingPath = path.resolve(here, '../../../messages/en/pricing.json');

function readPricingCopy(): Record<string, unknown> {
  return JSON.parse(readFileSync(pricingPath, 'utf8')) as Record<string, unknown>;
}

function comparisonValue(copy: Record<string, unknown>, key: string): string | undefined {
  const comparison = copy.comparison as { values?: Record<string, unknown> } | undefined;
  const value = comparison?.values?.[key];
  return typeof value === 'string' ? value : undefined;
}

test('the Free feature list quotes the allowance from the constants', () => {
  const line = PLANS.free.features.find((feature) => /\bactions\b/i.test(feature));
  assert.ok(line, 'Free must list its action allowance');
  assert.ok(line.includes(String(FREE_ACTION_ALLOWANCE)), `${line} must quote ${FREE_ACTION_ALLOWANCE}`);
  assert.ok(line.includes(String(FREE_ACTION_GRACE_DAYS)), `${line} must quote the ${FREE_ACTION_GRACE_DAYS}-day grace`);
});

test('every locale states the allowance on the pricing page, with the same two numbers', () => {
  // The five pricing.json files are line-aligned and translated by hand, so a
  // translator can turn "150" into "100" in one language without anything else
  // noticing, and a copy edit can drop the row entirely. Both are the same
  // failure: the number a customer reads stops being the number that blocks
  // them. The row is required, not optional; Phase 4 shipped it on 2026-09-12.
  for (const locale of ['en', 'es', 'fr', 'nb', 'zh']) {
    const file = path.resolve(here, `../../../messages/${locale}/pricing.json`);
    const copy = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const value = comparisonValue(copy, 'actionsFree');
    assert.equal(
      typeof value,
      'string',
      `${locale}: pricing.json has no comparison.values.actionsFree`,
    );
    assert.ok(
      value!.includes(String(FREE_ACTION_ALLOWANCE)),
      `${locale}: "${value}" must quote ${FREE_ACTION_ALLOWANCE}`,
    );
    assert.ok(
      value!.includes(String(FREE_ACTION_GRACE_DAYS)),
      `${locale}: "${value}" must quote the ${FREE_ACTION_GRACE_DAYS}-day grace`,
    );
  }
});

test('no paid comparison value answers the actions row with a number', () => {
  // A paid ceiling is a silent abuse guard. "No monthly cap, fair use" is the
  // only answer a paid tier may give in that row; a figure there would sell a
  // limit and invite a customer to price-compare against it.
  const copy = readPricingCopy();
  const value = comparisonValue(copy, 'actionsPaid');
  assert.equal(typeof value, 'string', 'pricing.json has no comparison.values.actionsPaid');
  assert.ok(!/\d/.test(value!), `comparison.values.actionsPaid ("${value}") quotes a number`);
});
