// The albretsen.no "emails handled" figure: how a count is shown, and when to post it.
// Run: npm run test:site-feed
import assert from 'node:assert/strict';
import test from 'node:test';

import { FIGURE_LABEL, FIGURE_STALE_MS, decideFigure, displayEmailsHandled, displayedFloor, readSiteFigure } from './figure.ts';

test('below a million: thousands, rounded down, with a plus', () => {
  assert.equal(displayEmailsHandled(948_999), '948,000+');
  assert.equal(displayEmailsHandled(948_000), '948,000+');
  assert.equal(displayEmailsHandled(1_000), '1,000+');
  assert.equal(displayEmailsHandled(999_999), '999,000+');
  assert.equal(displayEmailsHandled(12_345.9), '12,000+');
});

test('from a million: two decimals of millions, rounded down', () => {
  assert.equal(displayEmailsHandled(1_000_000), '1.00 million+');
  assert.equal(displayEmailsHandled(1_257_482), '1.25 million+');
  assert.equal(displayEmailsHandled(1_259_999), '1.25 million+');
  assert.equal(displayEmailsHandled(1_260_000), '1.26 million+');
  assert.equal(displayEmailsHandled(1_310_000), '1.31 million+');
  assert.equal(displayEmailsHandled(1_009_999), '1.00 million+');
  assert.equal(displayEmailsHandled(9_999_999), '9.99 million+');
});

test('from ten million: one decimal; from a billion: two decimals of billions', () => {
  assert.equal(displayEmailsHandled(10_000_000), '10.0 million+');
  assert.equal(displayEmailsHandled(12_499_999), '12.4 million+');
  assert.equal(displayEmailsHandled(999_999_999), '999.9 million+');
  assert.equal(displayEmailsHandled(1_029_000_000), '1.02 billion+');
});

test('a broken count is refused, not shown', () => {
  for (const bad of [0, -5, 999, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(displayEmailsHandled(bad), null, String(bad));
  }
});

test('every displayed string fits the site and never claims more than the count', () => {
  for (const n of [1_000, 47_123, 948_999, 1_000_000, 1_257_482, 9_999_999, 10_000_000, 87_654_321, 999_999_999, 3_141_592_653]) {
    const shown = displayEmailsHandled(n)!;
    assert.ok(shown.length <= 24, shown);
    const floor = displayedFloor(shown)!;
    assert.ok(floor <= n && floor > n * 0.98, `${n} -> ${shown} -> ${floor}`);
  }
});

test('displayedFloor reads back what displayEmailsHandled writes', () => {
  assert.equal(displayedFloor('948,000+'), 948_000);
  assert.equal(displayedFloor('1.25 million+'), 1_250_000);
  assert.equal(displayedFloor('12.4 million+'), 12_400_000);
  assert.equal(displayedFloor('1.02 billion+'), 1_020_000_000);
  assert.equal(displayedFloor(48_000), 48_000);
  for (const other of ['about a million', '1.25 million', '1,25 million+', '', 'NaN+']) {
    assert.equal(displayedFloor(other), null, other);
  }
});

const NOW = Date.UTC(2026, 9, 25, 12, 7);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const shown = (value: number | string | null, updated: string | null = ago(60_000), label: string | null = FIGURE_LABEL) => ({ label, value, updated });

test('posts when the site has nothing, the old MRR figure, or a value it cannot read', () => {
  assert.equal(decideFigure(null, '1.25 million+', NOW), 'post');
  assert.equal(decideFigure(shown(10203.19, ago(60_000), 'MRR'), '1.25 million+', NOW), 'post');
  assert.equal(decideFigure(shown(null), '1.25 million+', NOW), 'post');
  assert.equal(decideFigure(shown('lots'), '1.25 million+', NOW), 'post');
});

test('posts when the displayed string grew', () => {
  assert.equal(decideFigure(shown('1.25 million+'), '1.26 million+', NOW), 'post');
  assert.equal(decideFigure(shown('999,000+'), '1.00 million+', NOW), 'post');
  assert.equal(decideFigure(shown('9.99 million+'), '10.0 million+', NOW), 'post');
});

test('never posts a figure lower than the one the site shows', () => {
  assert.equal(decideFigure(shown('1.26 million+'), '1.25 million+', NOW), 'would_decrease');
  assert.equal(decideFigure(shown('1.00 million+'), '999,000+', NOW), 'would_decrease');
  assert.equal(decideFigure(shown(1_300_000), '1.25 million+', NOW), 'would_decrease');
  // Not even as a heartbeat, however stale the site copy is.
  assert.equal(decideFigure(shown('1.26 million+', ago(30 * 86_400_000)), '1.25 million+', NOW), 'would_decrease');
});

test('the same string is reposted only once a day, as a heartbeat', () => {
  assert.equal(FIGURE_STALE_MS, 23 * 3_600_000);
  assert.equal(decideFigure(shown('1.25 million+', ago(22 * 3_600_000)), '1.25 million+', NOW), 'unchanged');
  assert.equal(decideFigure(shown('1.25 million+', ago(23 * 3_600_000)), '1.25 million+', NOW), 'post');
  assert.equal(decideFigure(shown('1.25 million+', null), '1.25 million+', NOW), 'post');
  assert.equal(decideFigure(shown('1.25 million+', 'yesterday-ish'), '1.25 million+', NOW), 'post');
});

test('readSiteFigure picks this product out of the GET body', () => {
  const body = {
    figures: {
      'mcp-emails': { label: 'emails handled', value: '1.25 million+', updated: '2026-10-25T11:07:00.000Z' },
      other: { value: 1 },
    },
  };
  assert.deepEqual(readSiteFigure(body), { label: 'emails handled', value: '1.25 million+', updated: '2026-10-25T11:07:00.000Z' });
  assert.equal(readSiteFigure({ figures: {} }), null);
  assert.equal(readSiteFigure(null), null);
  assert.equal(readSiteFigure('nope'), null);
  assert.deepEqual(readSiteFigure({ figures: { 'mcp-emails': { value: Number.NaN, updated: 0 } } }), {
    label: null,
    value: null,
    updated: '1970-01-01T00:00:00.000Z',
  });
});
