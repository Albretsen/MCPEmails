import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWANCE_WARN_RATIO,
  allowanceProgress,
  allowanceTileState,
  allowanceTone,
  showUsageCapBanner,
} from './allowance-view.mjs';

const OCT = '2026-10-01T00:00:00+00:00';

function free(used, extra = {}) {
  return {
    plan: 'free',
    exempt: false,
    exempt_reason: null,
    in_grace: false,
    grace_ends_at: '2026-09-19T14:32:00+00:00',
    monthly: { used, cap: 150, remaining: Math.max(0, 150 - used), period_start: '2026-09-19T14:32:00+00:00', resets_at: OCT },
    ...extra,
  };
}

test('the three Free states and the paid fallback are told apart', () => {
  assert.equal(allowanceTileState(free(0, { in_grace: true })), 'grace');
  assert.equal(allowanceTileState(free(42)), 'counting');
  assert.equal(
    allowanceTileState({ ...free(42), exempt: true, exempt_reason: 'early_member', monthly: { ...free(42).monthly, cap: null, remaining: null } }),
    'exempt',
  );
  for (const plan of ['personal', 'solo', 'pro', 'enterprise']) {
    assert.equal(allowanceTileState({ ...free(42), plan, monthly: { ...free(42).monthly, cap: null, remaining: null } }), 'plain', plan);
  }
});

test('no allowance at all renders the plain count, never a bar', () => {
  // The RPC failed or the workspace row is missing: the page must still
  // render, and it renders what it rendered before the allowance existed.
  for (const missing of [null, undefined]) {
    assert.equal(allowanceTileState(missing), 'plain');
    assert.equal(allowanceProgress(missing), null);
    assert.equal(showUsageCapBanner(missing), false);
  }
});

test('exempt wins over everything, including a stale grace flag', () => {
  // An early member's row carries in_grace false and cap null by contract,
  // but the precedence is asserted here so a future row shape cannot show a
  // trial-week message to someone who is never metered.
  const odd = { ...free(0, { in_grace: true }), exempt: true, exempt_reason: 'comped' };
  assert.equal(allowanceTileState(odd), 'exempt');
  assert.equal(allowanceProgress(odd), null);
});

test('a Free row with no cap (the SQL says there is nothing to run out of) is plain', () => {
  assert.equal(allowanceTileState(free(42, { monthly: { ...free(42).monthly, cap: null, remaining: null } })), 'plain');
});

test('progress carries the numbers the bar and the copy need', () => {
  assert.deepEqual(allowanceProgress(free(42)), {
    used: 42,
    cap: 150,
    remaining: 108,
    ratio: 42 / 150,
    pct: 28,
    nearLimit: false,
    atLimit: false,
  });
  // Grace has no bar: nothing is being counted.
  assert.equal(allowanceProgress(free(3, { in_grace: true })), null);
});

test('the bar turns amber at exactly 80% and red at exactly 100%', () => {
  // 120 of 150 is the crossing the edge function's 80% email fires on, so the
  // dashboard has to agree with the email about when "close" begins.
  assert.equal(ALLOWANCE_WARN_RATIO, 0.8);
  const at119 = allowanceProgress(free(119));
  const at120 = allowanceProgress(free(120));
  const at149 = allowanceProgress(free(149));
  const at150 = allowanceProgress(free(150));
  const at163 = allowanceProgress(free(163));

  assert.equal(at119.nearLimit, false);
  assert.equal(allowanceTone(at119), 'brand');
  assert.equal(at120.nearLimit, true);
  assert.equal(at120.atLimit, false);
  assert.equal(allowanceTone(at120), 'amber');
  assert.equal(allowanceTone(at149), 'amber');
  assert.equal(at150.atLimit, true);
  assert.equal(allowanceTone(at150), 'red');
  // Past the cap (rows written by a reservation that landed at the boundary)
  // the bar is full, not overflowing, and remaining is zero, not negative.
  assert.equal(at163.pct, 100);
  assert.equal(at163.remaining, 0);
  assert.equal(allowanceTone(at163), 'red');
  assert.equal(allowanceTone(null), 'brand');
});

test('the Usage banner appears only for a metered Free workspace at 80% or more', () => {
  assert.equal(showUsageCapBanner(free(119)), false);
  assert.equal(showUsageCapBanner(free(120)), true);
  assert.equal(showUsageCapBanner(free(150)), true);
  assert.equal(showUsageCapBanner(free(150, { in_grace: true })), false);
  assert.equal(showUsageCapBanner({ ...free(150), exempt: true, exempt_reason: 'early_member' }), false);
  assert.equal(showUsageCapBanner({ ...free(150), plan: 'personal', monthly: { ...free(150).monthly, cap: null } }), false);
});

/**
 * Every dashboard.json key the four allowance states render, per surface. A
 * missing one renders as the key itself, in one language, on the screen that
 * tells a customer whether their agent still works.
 */
const ALLOWANCE_COPY_KEYS = [
  // Overview tile
  'overview.actionsThisMonth',
  'overview.actionsOfCap',
  'overview.actionsCapReached',
  'overview.actionsGrace',
  'overview.actionsExempt',
  // Usage page strip and banner
  'usage.allowanceCounting',
  'usage.allowanceReached',
  'usage.allowanceGrace',
  'usage.allowanceExempt',
  'usage.capCompare',
  // Billing card, "What your plan includes"
  'billing.actionsUsed',
  'billing.actionsGrace',
  'billing.actionsExempt',
  'billing.actionsNoCap',
  'billing.plans.personalFeatureActions',
];

const here = path.dirname(fileURLToPath(import.meta.url));

function lookup(messages, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

test('every allowance string exists in all five locales', () => {
  for (const locale of ['en', 'es', 'fr', 'nb', 'zh']) {
    const messages = JSON.parse(
      readFileSync(path.resolve(here, `../../../messages/${locale}/dashboard.json`), 'utf8'),
    );
    for (const key of ALLOWANCE_COPY_KEYS) {
      assert.equal(typeof lookup(messages, key), 'string', `${locale}: ${key} is missing`);
    }
  }
});

test('no allowance string smuggles a literal "<" past next-intl', () => {
  // next-intl escapes ICU apostrophes and angle brackets at build time only in
  // development: a bare "<" renders literally in production, where it reads as
  // a broken tag (feedback_nextintl_icu_escape_dev_only). Reword, never escape.
  for (const locale of ['en', 'es', 'fr', 'nb', 'zh']) {
    const messages = JSON.parse(
      readFileSync(path.resolve(here, `../../../messages/${locale}/dashboard.json`), 'utf8'),
    );
    for (const key of ALLOWANCE_COPY_KEYS) {
      assert.ok(!lookup(messages, key).includes('<'), `${locale}: ${key} contains "<"`);
    }
  }
});

test('the placeholders each allowance string declares are the ones it is given', () => {
  // The render sites pass {used}, {cap} and {date}; a translation that invents
  // a fourth placeholder throws at render rather than degrading.
  const allowed = new Set(['used', 'cap', 'date']);
  for (const locale of ['en', 'es', 'fr', 'nb', 'zh']) {
    const messages = JSON.parse(
      readFileSync(path.resolve(here, `../../../messages/${locale}/dashboard.json`), 'utf8'),
    );
    for (const key of ALLOWANCE_COPY_KEYS) {
      for (const [, name] of lookup(messages, key).matchAll(/\{(\w+)\}/g)) {
        assert.ok(allowed.has(name), `${locale}: ${key} uses unknown placeholder {${name}}`);
      }
    }
  }
});

test('a locale never quotes a different set of placeholders than English', () => {
  const placeholders = (messages, key) =>
    [...lookup(messages, key).matchAll(/\{(\w+)\}/g)].map(([, n]) => n).sort();
  const en = JSON.parse(readFileSync(path.resolve(here, '../../../messages/en/dashboard.json'), 'utf8'));
  for (const locale of ['es', 'fr', 'nb', 'zh']) {
    const messages = JSON.parse(
      readFileSync(path.resolve(here, `../../../messages/${locale}/dashboard.json`), 'utf8'),
    );
    for (const key of ALLOWANCE_COPY_KEYS) {
      assert.deepEqual(placeholders(messages, key), placeholders(en, key), `${locale}: ${key}`);
    }
  }
});
