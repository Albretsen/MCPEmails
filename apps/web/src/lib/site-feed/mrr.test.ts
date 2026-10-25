// The albretsen.no MRR figure: USD minor units to NOK, and when to post it.
// Run: npm run test:site-feed
import assert from 'node:assert/strict';
import test from 'node:test';

import { usdPerUnit } from '@/lib/analytics/fx';
import { FIGURE_STALE_MS, monthKey, mrrNok, readSiteFigure, shouldPostFigure } from './mrr.ts';

const fixed = (rate: number | null) => () => rate;

test('USD minor units convert to NOK at the given rate, two decimals', () => {
  // 1,074.00 USD at 0.105247 USD per NOK.
  assert.equal(mrrNok(107_400, '2026-10', fixed(0.105247)), 10204.57);
  assert.equal(mrrNok(100, '2026-10', fixed(0.1)), 10);
  // Rounds half away at the second decimal, never truncates.
  assert.equal(mrrNok(1, '2026-10', fixed(0.3)), 0.03);
  assert.equal(mrrNok(123_456, '2026-10', fixed(0.105247)), Math.round((1234.56 / 0.105247) * 100) / 100);
});

test('the rate is asked for in NOK and for the month passed', () => {
  const asked: string[] = [];
  mrrNok(1000, '2026-10', (currency, month) => {
    asked.push(`${currency}:${month}`);
    return 0.1;
  });
  assert.deepEqual(asked, ['nok:2026-10']);
});

test('zero, negative and non-finite MRR are refused', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(mrrNok(bad, '2026-10', fixed(0.1)), null, String(bad));
  }
});

test('a missing or nonsensical rate is refused', () => {
  for (const bad of [null, 0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(mrrNok(1000, '2026-10', fixed(bad)), null, String(bad));
  }
});

test('the real table: a month past its end uses the latest month, before its start the first', () => {
  const latest = usdPerUnit('nok', '2026-10');
  assert.ok(latest && latest > 0);
  assert.equal(mrrNok(107_400, '2030-01'), mrrNok(107_400, '2026-10'));
  const first = usdPerUnit('nok', '2026-01');
  assert.equal(mrrNok(107_400, '2020-01'), Math.round((1074 / first!) * 100) / 100);
});

test('monthKey is the UTC month', () => {
  assert.equal(monthKey(Date.UTC(2026, 9, 31, 23, 59)), '2026-10');
  assert.equal(monthKey(Date.UTC(2026, 10, 1, 0, 0)), '2026-11');
});

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('posts when the site has nothing or the read failed', () => {
  assert.equal(shouldPostFigure(null, 100, NOW), true);
  assert.equal(shouldPostFigure(undefined, 100, NOW), true);
});

test('posts when the value changed by half an ore or more', () => {
  assert.equal(shouldPostFigure({ value: 100, updated: ago(60_000) }, 100.01, NOW), true);
  assert.equal(shouldPostFigure({ value: 100, updated: ago(60_000) }, 99.99, NOW), true);
  assert.equal(shouldPostFigure({ value: 100, updated: ago(60_000) }, 100.004, NOW), false);
  assert.equal(shouldPostFigure({ value: Number.NaN, updated: ago(60_000) }, 100, NOW), true);
});

test('an unchanged value is reposted only once the site copy is 55 minutes old', () => {
  assert.equal(FIGURE_STALE_MS, 55 * 60_000);
  assert.equal(shouldPostFigure({ value: 100, updated: ago(54 * 60_000) }, 100, NOW), false);
  assert.equal(shouldPostFigure({ value: 100, updated: ago(55 * 60_000) }, 100, NOW), true);
  assert.equal(shouldPostFigure({ value: 100, updated: ago(3 * 3_600_000) }, 100, NOW), true);
});

test('an unreadable updated stamp counts as stale', () => {
  assert.equal(shouldPostFigure({ value: 100, updated: null }, 100, NOW), true);
  assert.equal(shouldPostFigure({ value: 100, updated: 'yesterday-ish' }, 100, NOW), true);
});

test('readSiteFigure picks this product out of the GET body', () => {
  const body = {
    figures: {
      'mcp-emails': { label: 'MRR', value: 10203.19, unit: 'NOK', updated: '2026-10-24T11:00:00.000Z' },
      other: { value: 1 },
    },
  };
  assert.deepEqual(readSiteFigure(body), { value: 10203.19, updated: '2026-10-24T11:00:00.000Z' });
  assert.equal(readSiteFigure({ figures: {} }), null);
  assert.equal(readSiteFigure(null), null);
  assert.equal(readSiteFigure('nope'), null);
  assert.deepEqual(readSiteFigure({ figures: { 'mcp-emails': { value: '5', updated: 0 } } }), {
    value: 5,
    updated: '1970-01-01T00:00:00.000Z',
  });
});
