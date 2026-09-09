import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMNS,
  channel,
  matchesQuery,
  paginate,
  resolveColumn,
  resolveSegment,
  SEGMENTS,
  sortRows,
  stageLabel,
  summarise,
} from './user-table.ts';
import type { UserDirectoryRow } from './user-directory.ts';

/** A person with nothing: every test below states only what it cares about. */
function person(overrides: Partial<UserDirectoryRow> = {}): UserDirectoryRow {
  return {
    user_id: overrides.email ?? 'id',
    email: 'nobody@example.com',
    display_name: null,
    avatar_url: null,
    signed_up_at: '2026-01-01T00:00:00Z',
    is_internal: false,
    unsubscribed_at: null,
    unsubscribed_categories: null,
    workspaces: 1,
    memberships: 0,
    primary_workspace_id: null,
    primary_workspace_name: null,
    primary_workspace_slug: null,
    plan: 'free',
    is_comped: false,
    unlimited_inboxes: false,
    grandfathered: false,
    acquisition_source: null,
    acquisition_utm_source: null,
    acquisition_utm_medium: null,
    acquisition_utm_campaign: null,
    acquisition_landing_path: null,
    acquisition_referrer: null,
    acquisition_locale: null,
    onboarding_stage: null,
    onboarding_client: null,
    first_inbox_connected_at: null,
    first_inbox_provider: null,
    first_credential_created_at: null,
    first_credential_method: null,
    first_tool_used_at: null,
    first_tool_name: null,
    first_tool_client: null,
    value_activated_at: null,
    inboxes: 0,
    inboxes_broken: 0,
    providers: null,
    api_keys: 0,
    key_last_used_at: null,
    calls: 0,
    successes: 0,
    active_days: 0,
    last_active_at: null,
    paywall_hits: 0,
    billing_plan: null,
    subscription_status: null,
    stripe_customer_id: null,
    current_period_end: null,
    total_rows: 1,
    ...overrides,
  };
}

test('every column key is unique, so a header cannot sort by another column', () => {
  const keys = COLUMNS.map((column) => column.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('an unknown sort key falls back rather than blanking the table', () => {
  assert.equal(resolveColumn('nonsense').key, 'signed_up');
  assert.equal(resolveColumn(undefined).key, 'signed_up');
  assert.equal(resolveSegment('nonsense').key, 'all');
});

test('nulls sink in both directions', () => {
  // The bug this exists to stop: sorting by "last call" descending and getting
  // three hundred people who have never made one at the top of the page.
  const column = resolveColumn('last_active');
  const rows = [
    person({ email: 'never@x.com', last_active_at: null }),
    person({ email: 'recent@x.com', last_active_at: '2026-09-01T00:00:00Z' }),
    person({ email: 'older@x.com', last_active_at: '2026-06-01T00:00:00Z' }),
  ];
  assert.deepEqual(
    sortRows(rows, column, true).map((row) => row.email),
    ['recent@x.com', 'older@x.com', 'never@x.com'],
  );
  assert.deepEqual(
    sortRows(rows, column, false).map((row) => row.email),
    ['older@x.com', 'recent@x.com', 'never@x.com'],
  );
});

test('a success rate is withheld until the denominator can carry one', () => {
  const column = resolveColumn('success');
  // 1 of 1 is not a better success rate than 900 of 1000.
  assert.equal(column.value(person({ calls: 1, successes: 1 })), null);
  assert.equal(column.value(person({ calls: 1000, successes: 900 })), 0.9);
});

test('comped sorts below free, because it is a paid plan id that earns nothing', () => {
  const column = resolveColumn('plan');
  const rows = [
    person({ email: 'free@x.com', plan: 'free' }),
    person({ email: 'comped@x.com', plan: 'pro', is_comped: true }),
    person({ email: 'team@x.com', plan: 'pro' }),
  ];
  assert.deepEqual(
    sortRows(rows, column, true).map((row) => row.email),
    ['team@x.com', 'free@x.com', 'comped@x.com'],
  );
});

test('the stage ladder reads in funnel order, not alphabetically', () => {
  assert.equal(stageLabel(person()), 'signed up');
  assert.equal(stageLabel(person({ inboxes: 1 })), 'connected');
  // The connect flow is mailbox-first: a key is the rung after a mailbox.
  assert.equal(stageLabel(person({ inboxes: 1, api_keys: 1 })), 'has a key');
  assert.equal(stageLabel(person({ inboxes: 1, first_tool_used_at: '2026-02-01T00:00:00Z' })), 'called a tool');
  assert.equal(stageLabel(person({ inboxes: 1, value_activated_at: '2026-02-01T00:00:00Z' })), 'activated');
  assert.equal(stageLabel(person({ plan: 'solo' })), 'paying');
  // A comped account is on a paid plan id and is not a customer.
  assert.equal(stageLabel(person({ plan: 'pro', is_comped: true })), 'signed up');
});

test('every segment except ours and comped excludes our own accounts', () => {
  const ours = person({ is_internal: true, plan: 'pro', inboxes: 3, calls: 90, paywall_hits: 2 });
  for (const segment of SEGMENTS) {
    if (segment.key === 'internal' || segment.key === 'comped') continue;
    assert.equal(segment.match(ours), false, `segment ${segment.key} counted an internal account`);
  }
});

test('"gone quiet" means connected once and silent now, not never started', () => {
  const dormant = resolveSegment('dormant');
  const cold = resolveSegment('cold');
  const quiet = person({ first_inbox_connected_at: '2026-03-01T00:00:00Z', inboxes: 1, calls: 0 });
  const never = person();
  assert.equal(dormant.match(quiet), true);
  assert.equal(dormant.match(never), false);
  assert.equal(cold.match(never), true);
  assert.equal(cold.match(quiet), false);
});

test('search reaches the fields somebody would actually paste', () => {
  const row = person({
    email: 'ana@massif.mx',
    primary_workspace_name: 'Massif',
    providers: 'gmail',
    stripe_customer_id: 'cus_123',
  });
  assert.equal(matchesQuery(row, 'massif.mx'), true);
  assert.equal(matchesQuery(row, 'MASSIF'), true);
  assert.equal(matchesQuery(row, 'gmail'), true);
  assert.equal(matchesQuery(row, 'cus_123'), true);
  assert.equal(matchesQuery(row, ''), true);
  assert.equal(matchesQuery(row, 'outlook'), false);
});

test('an unknown channel stays unknown rather than being folded into direct', () => {
  assert.equal(channel(person()), null);
  assert.equal(channel(person({ acquisition_source: 'organic' })), 'organic');
  // utm wins over the coarser source, and a referrer is reduced to its host.
  assert.equal(channel(person({ acquisition_source: 'organic', acquisition_utm_source: 'lobehub' })), 'lobehub');
  assert.equal(channel(person({ acquisition_referrer: 'https://www.google.com/search?q=x' })), 'google.com');
});

test('a stale page number lands on the last real page, not an empty table', () => {
  const rows = Array.from({ length: 45 }, (_, index) => person({ email: `p${index}@x.com` }));
  const page = paginate(rows, 99, 25);
  assert.equal(page.page, 2);
  assert.equal(page.pages, 2);
  assert.equal(page.rows.length, 20);
  assert.equal(page.from, 26);
  assert.equal(page.to, 45);
});

test('an empty result reports a zero range rather than "1 to 0"', () => {
  const page = paginate([], 1, 25);
  assert.deepEqual([page.from, page.to, page.total, page.pages], [0, 0, 0, 1]);
});

test('the summary counts what is on screen', () => {
  const summary = summarise([
    person({ plan: 'solo', inboxes: 2, calls: 10, value_activated_at: '2026-02-01T00:00:00Z' }),
    person({ plan: 'pro', is_comped: true, inboxes: 1, calls: 4 }),
    person(),
  ]);
  assert.deepEqual(summary, { people: 3, connected: 2, activated: 1, active: 2, paying: 1, inboxes: 3, calls: 14 });
});
