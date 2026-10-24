import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countSuccessDays,
  dismissedWorkspaceIds,
  firstWeekChecklist,
  inboxNeedsAttention,
  withDismissed,
  withinFirstWeekWindow,
  type FirstWeekCounts,
} from './first-week-checklist.ts';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function counts(patch: Partial<FirstWeekCounts> = {}): FirstWeekCounts {
  return {
    paidAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    paid: true,
    dismissed: false,
    successDays: 0,
    recentErrorCodes: [],
    troubleInboxId: null,
    automationCount: 0,
    ...patch,
  };
}

function state(patch: Partial<FirstWeekCounts> = {}, opts: { isOwner?: boolean; inboxCount?: number; maxInboxes?: number | null } = {}) {
  return firstWeekChecklist({
    counts: counts(patch),
    now: NOW,
    isOwner: opts.isOwner ?? true,
    inboxCount: opts.inboxCount ?? 1,
    maxInboxes: opts.maxInboxes === undefined ? 1 : opts.maxInboxes,
  });
}

const ids = (s: ReturnType<typeof state>) => s.items.map((i) => i.id);

test('a new payer sees the three required items, in order, none ticked', () => {
  const s = state();
  assert.equal(s.visible, true);
  assert.deepEqual(ids(s), ['first_call', 'active_days', 'automation']);
  assert.equal(s.items.every((i) => !i.done), true);
  assert.equal(s.items[1].progress, 0);
});

test('items tick from the counts', () => {
  const s = state({ successDays: 2, automationCount: 1 });
  assert.deepEqual(s.items.map((i) => [i.id, i.done]), [['first_call', true], ['active_days', false], ['automation', true]]);
  assert.equal(s.items[1].progress, 2);
});

test('the card hides once every required item is done', () => {
  assert.equal(state({ successDays: 3, automationCount: 1 }).visible, false);
  assert.equal(state({ successDays: 3, automationCount: 0 }).visible, true);
  assert.equal(state({ successDays: 2, automationCount: 1 }).visible, true);
});

test('active days are capped at 3 and never negative', () => {
  assert.equal(state({ successDays: 9 }).items[1].progress, 3);
  assert.equal(state({ successDays: -1 }).items[1].progress, 0);
});

test('the 14 day window: shown up to just before day 14, hidden at and after it', () => {
  assert.equal(state({ paidAt: new Date(NOW.getTime() - 14 * DAY + 60_000).toISOString() }).visible, true);
  assert.equal(state({ paidAt: new Date(NOW.getTime() - 14 * DAY).toISOString() }).visible, false);
  assert.equal(state({ paidAt: new Date(NOW.getTime() - 30 * DAY).toISOString() }).visible, false);
  assert.equal(state({ paidAt: null }).visible, false, 'never paid');
  assert.equal(state({ paidAt: 'not a date' }).visible, false);
  assert.equal(withinFirstWeekWindow(new Date(NOW.getTime() + DAY).toISOString(), NOW), false, 'a future time is not inside');
});

test('only the owner of a paid workspace that has not dismissed it sees it', () => {
  assert.equal(state({}, { isOwner: false }).visible, false);
  assert.equal(state({ paid: false }).visible, false);
  assert.equal(state({ dismissed: true }).visible, false);
  assert.equal(firstWeekChecklist({ counts: null, now: NOW, isOwner: true, inboxCount: 1, maxInboxes: 1 }).visible, false);
});

test('error majority: most of the last 10 calls failing on the inbox swaps item 1 for Reconnect', () => {
  const s = state({
    successDays: 1,
    recentErrorCodes: ['auth_failed', 'auth_failed', null, 'provider_error', 'connection_limit', 'auth_failed'],
    troubleInboxId: 'ib-1',
  });
  assert.deepEqual(ids(s), ['inbox_attention', 'active_days', 'automation']);
  assert.equal(s.items[0].done, false);
  assert.equal(s.items[0].inboxId, 'ib-1');
  // Even with every other item done, a broken inbox keeps the card up.
  assert.equal(state({ successDays: 3, automationCount: 1, recentErrorCodes: ['auth_failed'] }).visible, true);
});

test('error majority is strictly more than half, of inbox codes only, of the latest 10', () => {
  assert.equal(inboxNeedsAttention([]), false, 'no calls is not trouble');
  assert.equal(inboxNeedsAttention(['auth_failed', null]), false, 'half is not most');
  assert.equal(inboxNeedsAttention(['auth_failed', 'auth_failed', null]), true);
  assert.equal(inboxNeedsAttention(['-32602', '-32602', 'message_not_found']), false, 'client mistakes are not the inbox');
  const old = [...Array(10).fill(null), ...Array(10).fill('auth_failed')];
  assert.equal(inboxNeedsAttention(old), false, 'failures before the latest 10 do not count');
});

test('plan room: the optional inbox row shows only below the plan limit, last', () => {
  const room = state({}, { inboxCount: 1, maxInboxes: 3 });
  assert.deepEqual(ids(room), ['first_call', 'active_days', 'automation', 'another_inbox']);
  const last = room.items[3];
  assert.equal(last.optional, true);
  assert.equal(last.inboxLimit, 3);
  assert.equal(ids(state({}, { inboxCount: 3, maxInboxes: 3 })).includes('another_inbox'), false, 'at the limit');
  assert.equal(ids(state({}, { inboxCount: 1, maxInboxes: null })).includes('another_inbox'), false, 'unlimited has no N');
});

test('the optional row never keeps the card up on its own', () => {
  assert.equal(state({ successDays: 3, automationCount: 1 }, { inboxCount: 1, maxInboxes: 3 }).visible, false);
});

test('countSuccessDays walks one UTC day at a time and stops at the cap', async () => {
  const successes = [
    '2026-10-20T23:59:00.000Z',
    '2026-10-20T23:59:30.000Z',
    '2026-10-21T00:00:01.000Z',
    '2026-10-23T08:00:00.000Z',
    '2026-10-24T08:00:00.000Z',
  ];
  const asked: string[] = [];
  const lookup = async (from: string) => {
    asked.push(from);
    return successes.find((s) => s >= from) ?? null;
  };
  assert.equal(await countSuccessDays('2026-10-20T10:00:00.000Z', lookup), 3);
  assert.deepEqual(asked, ['2026-10-20T10:00:00.000Z', '2026-10-21T00:00:00.000Z', '2026-10-22T00:00:00.000Z']);
  assert.equal(await countSuccessDays('2026-10-24T09:00:00.000Z', lookup), 0);
  assert.equal(await countSuccessDays('2026-10-20T10:00:00.000Z', lookup, 10), 4);
});

test('dismissal list: per workspace, deduplicated, bounded, tolerant of junk', () => {
  assert.deepEqual(dismissedWorkspaceIds(null), []);
  assert.deepEqual(dismissedWorkspaceIds({ first_week_checklist_dismissed: 'ws' }), []);
  assert.deepEqual(dismissedWorkspaceIds({ first_week_checklist_dismissed: ['a', 3, 'b'] }), ['a', 'b']);
  assert.deepEqual(withDismissed({ first_week_checklist_dismissed: ['a', 'b'] }, 'a'), ['b', 'a']);
  const many = { first_week_checklist_dismissed: Array.from({ length: 30 }, (_, i) => `w${i}`) };
  const next = withDismissed(many, 'new');
  assert.equal(next.length, 20);
  assert.equal(next[next.length - 1], 'new');
});
