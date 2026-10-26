import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  FLOW_B_EVENTS,
  activeGraceDays,
  formatUsd,
  graceEndNote,
  nextInboxNeedsUpgrade,
  parseFlowBEvent,
  recommendPlan,
  showPlanSummary,
  summaryPrice,
  usageMeterLevel,
} from './flow-b.mjs';
import { multiInboxPromptVariant } from './multi-inbox-prompt.mjs';

const DAY = 24 * 60 * 60 * 1000;
const created = '2026-10-20T10:00:00.000Z';
const flowB = (extra = {}) => ({
  plan: 'free',
  createdAt: created,
  firstCallAt: '2026-10-20T10:05:00.000Z',
  summaryDismissedAt: null,
  graceNoteSeenAt: null,
  triedSecondInbox: false,
  ...extra,
});

test('recommendPlan: work domain Pro, tried a second inbox Personal, else none', () => {
  assert.equal(recommendPlan({ businessShaped: true }), 'solo');
  assert.equal(recommendPlan({ businessShaped: true, triedSecondInbox: true }), 'solo');
  assert.equal(recommendPlan({ triedSecondInbox: true }), 'personal');
  assert.equal(recommendPlan({}), null);
  assert.equal(recommendPlan({ businessShaped: 'yes' }), null);
});

test('plan summary: after the first call, first 3 days, until dismissed, Free only', () => {
  const now = Date.parse(created) + DAY;
  assert.equal(showPlanSummary({ flowB: flowB(), now }), true);
  assert.equal(showPlanSummary({ flowB: null, now }), false);
  assert.equal(showPlanSummary({ flowB: flowB({ firstCallAt: null }), now }), false, 'never before a win');
  assert.equal(showPlanSummary({ flowB: flowB({ summaryDismissedAt: '2026-10-20T11:00:00Z' }), now }), false);
  assert.equal(showPlanSummary({ flowB: flowB({ plan: 'personal' }), now }), false);
  assert.equal(showPlanSummary({ flowB: flowB(), now: Date.parse(created) + 3 * DAY + 1 }), false);
});

test('active grace days count the days with calls between signup and grace end', () => {
  const counts = [
    { date: '2026-10-19', count: 4 },
    { date: '2026-10-20', count: 3 },
    { date: '2026-10-21', count: 0 },
    { date: '2026-10-22', count: 9 },
    { date: '2026-10-23', count: 2 },
    { date: '2026-10-24', count: 5 },
  ];
  assert.equal(activeGraceDays(counts, created, '2026-10-23T10:00:00.000Z'), 3);
  assert.equal(activeGraceDays(null, created, '2026-10-23T10:00:00.000Z'), 0);
});

test('grace-end note: once, after the grace, within a week, only for someone who used it', () => {
  const allowance = { plan: 'free', exempt: false, in_grace: false, grace_ends_at: '2026-10-23T10:00:00.000Z' };
  const dailyCounts = [{ date: '2026-10-20', count: 2 }, { date: '2026-10-22', count: 1 }];
  const end = Date.parse(allowance.grace_ends_at);
  assert.deepEqual(graceEndNote({ flowB: flowB(), allowance, dailyCounts, now: end + 60_000 }), { days: 2, today: true, since: '2026-10-23' });
  assert.equal(graceEndNote({ flowB: flowB(), allowance, dailyCounts, now: end + 2 * DAY }).today, false);
  assert.equal(graceEndNote({ flowB: flowB(), allowance, dailyCounts, now: end + 8 * DAY }), null);
  assert.equal(graceEndNote({ flowB: flowB(), allowance: { ...allowance, in_grace: true }, dailyCounts, now: end - 1 }), null);
  assert.equal(graceEndNote({ flowB: flowB(), allowance: { ...allowance, exempt: true }, dailyCounts, now: end + 1 }), null);
  assert.equal(graceEndNote({ flowB: flowB({ graceNoteSeenAt: 'x' }), allowance, dailyCounts, now: end + 1 }), null);
  assert.equal(graceEndNote({ flowB: flowB(), allowance, dailyCounts: [], now: end + 1 }), null);
  assert.equal(graceEndNote({ flowB: null, allowance, dailyCounts, now: end + 1 }), null);
});

test('usage meter levels at 50, 80 and 100%', () => {
  assert.equal(usageMeterLevel(null), null);
  assert.equal(usageMeterLevel({ used: 74, cap: 150 }), null);
  assert.equal(usageMeterLevel({ used: 75, cap: 150 }), 50);
  assert.equal(usageMeterLevel({ used: 120, cap: 150 }), 80);
  assert.equal(usageMeterLevel({ used: 150, cap: 150 }), 100);
  assert.equal(usageMeterLevel({ used: 151, cap: 150 }), 100);
});

test('second inbox needs an upgrade only at a real cap', () => {
  assert.equal(nextInboxNeedsUpgrade(1, 1), true);
  assert.equal(nextInboxNeedsUpgrade(0, 1), false);
  assert.equal(nextInboxNeedsUpgrade(5, null), false);
});

test('prices: monthly always, yearly only when configured; $ formatting', () => {
  const prices = {
    personal: { monthlyCents: 900, yearlyCents: 8640, yearlyPriceConfigured: true },
    solo: { monthlyCents: 1500, yearlyCents: 14400, yearlyPriceConfigured: false },
  };
  assert.deepEqual(summaryPrice(prices, 'personal'), { monthlyCents: 900, yearlyCents: 8640 });
  assert.deepEqual(summaryPrice(prices, 'solo'), { monthlyCents: 1500, yearlyCents: null });
  assert.equal(summaryPrice(null, 'personal'), null);
  assert.equal(formatUsd(900), '$9');
  assert.equal(formatUsd(8640), '$86.40');
});

test('consumer workspaces see the multi-inbox invitation only in Flow B', () => {
  assert.equal(multiInboxPromptVariant({ businessShaped: false, inboxCount: 1, atInboxLimit: true }), null);
  assert.equal(multiInboxPromptVariant({ businessShaped: false, inboxCount: 1, atInboxLimit: true, convert: 'on' }), 'consumer_upgrade');
  assert.equal(multiInboxPromptVariant({ businessShaped: false, inboxCount: 1, atInboxLimit: false, convert: 'on' }), 'consumer_open');
  assert.equal(multiInboxPromptVariant({ businessShaped: false, inboxCount: 2, convert: 'on' }), null);
  assert.equal(multiInboxPromptVariant({ businessShaped: true, inboxCount: 1, atInboxLimit: true, convert: 'on' }), 'upgrade');
});

test('every funnel stage and category Flow B writes is in its migration', () => {
  const sql = readFileSync(new URL('../../../../../supabase/migrations/20261026233917_onboarding_flow_b.sql', import.meta.url), 'utf8');
  const bodies = [
    { event: 'second_inbox_prompt_shown' },
    { event: 'second_inbox_prompt_clicked' },
    { event: 'plan_summary_shown', surface: 'overview' },
    { event: 'plan_summary_dismissed', surface: 'onboarding' },
    { event: 'plan_summary_clicked', plan: 'personal' },
    { event: 'usage_meter_shown', level: 50, since: '2026-11-01T00:00:00Z' },
    { event: 'usage_meter_shown', level: 100, since: '2026-11-01T00:00:00Z' },
    { event: 'grace_end_note_shown' },
    { event: 'grace_end_note_dismissed' },
  ];
  const seen = new Set();
  for (const body of bodies) {
    const parsed = parseFlowBEvent(body);
    assert.ok(parsed, JSON.stringify(body));
    seen.add(body.event);
    if (parsed.stage) assert.ok(sql.includes(`'${parsed.stage}'`), parsed.stage);
    if (parsed.category.startsWith('surface_') || parsed.category.startsWith('level_')) {
      assert.ok(sql.includes(`'${parsed.category}'`), parsed.category);
    }
  }
  assert.deepEqual([...seen].sort(), [...FLOW_B_EVENTS].sort());
});
