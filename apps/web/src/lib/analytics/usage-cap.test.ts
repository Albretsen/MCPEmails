// Run: node --test --experimental-strip-types src/lib/analytics/usage-cap.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  EMPTY_USAGE_CAP_OVERVIEW,
  capShare,
  closestToTheWall,
  describeUsageCapState,
  normaliseUsageCapOverview,
  ownerDomain,
  usageCapFunnelSteps,
  usageCapRetentionPair,
  usageCapStateTiles,
  usageCapTone,
} from './usage-cap.ts';
import type { GrowthUsageCapWorkspaceRow } from './growth-types.ts';

test('the empty overview is total and every field is a finite zero', () => {
  for (const [key, value] of Object.entries(EMPTY_USAGE_CAP_OVERVIEW)) {
    assert.equal(value, 0, `${key} was ${value}`);
  }
  assert.equal(Object.keys(EMPTY_USAGE_CAP_OVERVIEW).length, 27);
});

test('normalising fills holes and refuses non-numbers rather than printing NaN', () => {
  assert.deepEqual(normaliseUsageCapOverview(null), EMPTY_USAGE_CAP_OVERVIEW);
  assert.deepEqual(normaliseUsageCapOverview(undefined), EMPTY_USAGE_CAP_OVERVIEW);
  const row = normaliseUsageCapOverview({ capped: 3, warn: Number.NaN, half: '7' as unknown as number });
  assert.equal(row.capped, 3);
  assert.equal(row.warn, 0);
  assert.equal(row.half, 0);
  assert.equal(row.in_grace, 0);
});

test('the state tiles come in wall order and the helpers never throw on the empty row', () => {
  const tiles = usageCapStateTiles(EMPTY_USAGE_CAP_OVERVIEW);
  assert.deepEqual(tiles.map((tile) => tile.key), ['grace', 'under_half', 'half', 'warn', 'capped']);
  assert.ok(tiles.every((tile) => tile.value === 0));
  assert.equal(usageCapFunnelSteps(EMPTY_USAGE_CAP_OVERVIEW).length, 4);
  assert.deepEqual(usageCapRetentionPair(EMPTY_USAGE_CAP_OVERVIEW), {
    capped: { retained: 0, eligible: 0 },
    uncapped: { retained: 0, eligible: 0 },
  });
});

test('the tone is red for anyone capped, amber for anyone warned, green otherwise', () => {
  assert.equal(usageCapTone(EMPTY_USAGE_CAP_OVERVIEW), 'good');
  assert.equal(usageCapTone({ ...EMPTY_USAGE_CAP_OVERVIEW, warn: 1 }), 'warn');
  assert.equal(usageCapTone({ ...EMPTY_USAGE_CAP_OVERVIEW, warn: 1, capped: 1 }), 'bad');
});

test('the funnel reads the four rungs from the overview in order', () => {
  const steps = usageCapFunnelSteps({
    ...EMPTY_USAGE_CAP_OVERVIEW,
    funnel_capped: 9,
    funnel_pricing_viewed: 4,
    funnel_checkout_started: 2,
    funnel_checkout_completed: 1,
  });
  assert.deepEqual(steps.map((step) => step.value), [9, 4, 2, 1]);
});

test('capShare rounds DOWN so 119 of 150 never reads as the 80% crossing', () => {
  assert.equal(capShare(119, 150), 79);
  assert.equal(capShare(120, 150), 80);
  assert.equal(capShare(150, 150), 100);
  assert.equal(capShare(0, 150), 0);
  assert.equal(capShare(-5, 150), 0);
  assert.equal(capShare(10, null), null);
  assert.equal(capShare(10, 0), null);
  assert.equal(capShare(Number.NaN, 150), null);
});

test('ownerDomain keeps the domain and nothing that could name a person', () => {
  assert.equal(ownerDomain('someone@Example.ORG'), 'example.org');
  assert.equal(ownerDomain('a+tag@sub.example.org'), 'sub.example.org');
  assert.equal(ownerDomain('no-at-sign'), null);
  assert.equal(ownerDomain('@example.org'), null);
  assert.equal(ownerDomain('trailing@'), null);
  assert.equal(ownerDomain(null), null);
  assert.equal(ownerDomain(''), null);
});

test('every SQL state has words, and an unknown one falls through unchanged', () => {
  for (const state of ['exempt_early', 'exempt_support', 'paid', 'grace', 'under_half', 'half', 'warn', 'capped']) {
    assert.notEqual(describeUsageCapState(state), state);
  }
  assert.equal(describeUsageCapState('something_new'), 'something_new');
});

const row = (id: string, used: number, created: string): GrowthUsageCapWorkspaceRow => ({
  workspace_id: id,
  owner_id: `owner-${id}`,
  owner_email: `${id}@example.org`,
  owner_domain: 'example.org',
  workspace_name: id,
  state: used >= 150 ? 'capped' : used >= 120 ? 'warn' : 'half',
  used,
  cap: 150,
  remaining: Math.max(150 - used, 0),
  period_start: '2026-09-01T00:00:00Z',
  period_end: '2026-10-01T00:00:00Z',
  created_at: created,
  last_action_at: null,
  refusals: 0,
  emails_sent: null,
  emails_queued: null,
  paused_rules: 0,
});

test('closestToTheWall sorts by usage, breaks ties by age, and honours the limit', () => {
  const rows = [row('b', 120, '2026-09-02'), row('a', 150, '2026-09-03'), row('c', 120, '2026-09-01'), row('d', 80, '2026-09-04')];
  assert.deepEqual(closestToTheWall(rows, 3).map((r) => r.workspace_id), ['a', 'c', 'b']);
  assert.deepEqual(closestToTheWall(rows, 0), []);
  assert.deepEqual(closestToTheWall([], 5), []);
  // The input is not mutated: the sub-page reads the same array afterwards.
  assert.equal(rows[0].workspace_id, 'b');
});

/*
 * The two fetchers, checked at the source rather than by calling them.
 *
 * `growth-queries.ts` imports `next/cache`, and Next 16.3.3 ships no `exports`
 * map, so `next/cache` cannot be resolved by the bare `node --test` runner at
 * all (it would have to be spelled `next/cache.js`). Importing the module here
 * therefore fails before any assertion runs, and mocking it would need a
 * resolver hook in scripts/, shared by every other suite.
 *
 * What actually has to hold is structural, and is readable without importing:
 * both fetchers must go through `rpcRows`/`rpcSingleRow`, which run inside
 * `cachedSection`'s try/catch and return `{ ok: false, error }` instead of
 * throwing, and both must be tagged `growth:usage-cap` so the exemption form
 * and the Refresh button can drop them. A future edit that reaches for the
 * service-role client directly, or that throws on a bad window, would take the
 * band from "a visibly dead tile" to "a 500 on the whole board", which is the
 * one failure mode /admin/growth is built to avoid.
 */
const growthQueriesSource = readFileSync(new URL('./growth-queries.ts', import.meta.url), 'utf8');

function fetcherBody(name: string): string {
  const start = growthQueriesSource.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} is not exported from growth-queries.ts`);
  const open = growthQueriesSource.indexOf('{', start);
  const end = growthQueriesSource.indexOf('\n}', open);
  assert.ok(end > open, `${name} has no readable body`);
  return growthQueriesSource.slice(open, end);
}

test('both usage-cap fetchers delegate to the cached wrapper, so neither can throw', () => {
  const overview = fetcherBody('fetchUsageCapOverview');
  const roster = fetcherBody('fetchUsageCapWorkspaces');

  assert.match(overview, /return rpcSingleRow<GrowthUsageCapOverviewRow>\('growth_usage_cap_overview'/);
  assert.match(roster, /return rpcRows<GrowthUsageCapWorkspaceRow>\('growth_usage_cap_workspaces'/);

  for (const [name, body] of [['overview', overview], ['roster', roster]] as const) {
    assert.ok(body.includes('GROWTH_TAGS.usageCap'), `${name} is not tagged growth:usage-cap`);
    assert.ok(!body.includes('createServiceRoleClient'), `${name} reaches past the cached wrapper`);
    assert.ok(!/\bthrow\b/.test(body), `${name} can throw`);
    assert.ok(body.includes('internalAccountMatchers()'), `${name} does not exclude our own accounts`);
  }

  // A window is clamped in TypeScript as well as in SQL: the RPC's own
  // greatest(?, 1) cannot save a NaN that arrives as null over PostgREST.
  assert.match(overview, /p_window_days: clampInt\(days, 1, 90\)/);
});
