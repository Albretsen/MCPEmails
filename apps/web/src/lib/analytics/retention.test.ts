import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAY_MS,
  buildSessions,
  firstActivityTimes,
  frequencyBand,
  groupSuccessfulActivities,
  isValueActivity,
  rollingReturn,
  twoDayValueWithinFirstWeek,
  utcDayStart,
} from './retention.ts';

const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 0, 1 + day, hour)).toISOString();

test('connectivity calls are not value activation', () => {
  assert.equal(isValueActivity({ tool_name: 'inbox_list' }), false);
  assert.equal(isValueActivity({ tool_name: 'list_inboxes' }), false);
  assert.equal(isValueActivity({ tool_name: 'email_search' }), true);
});

test('sessions split after the inactivity threshold', () => {
  const sessions = buildSessions([0, 5 * 60_000, 35 * 60_000, 36 * 60_000]);
  assert.deepEqual(sessions, [
    { start: 0, end: 5 * 60_000, calls: 2 },
    { start: 35 * 60_000, end: 36 * 60_000, calls: 2 },
  ]);
});

test('rolling return counts any activity in the requested UTC-day window', () => {
  const rows = groupSuccessfulActivities([
    { workspace_id: 'a', tool_name: 'email_search', created_at: at(0, 23) },
    { workspace_id: 'a', tool_name: 'email_read', created_at: at(4, 1) },
    { workspace_id: 'b', tool_name: 'email_search', created_at: at(0, 10) },
    { workspace_id: 'b', tool_name: 'email_read', created_at: at(8, 10) },
  ]);
  const first = firstActivityTimes(rows, true);
  assert.deepEqual(rollingReturn(first, rows, 1, 7, utcDayStart(at(10)), true), {
    eligible: 2,
    retained: 1,
  });
});

test('two-day value requires distinct UTC days within the first week', () => {
  const rows = groupSuccessfulActivities([
    { workspace_id: 'same-day', tool_name: 'email_search', created_at: at(0, 1) },
    { workspace_id: 'same-day', tool_name: 'email_read', created_at: at(0, 5) },
    { workspace_id: 'returner', tool_name: 'email_search', created_at: at(0, 1) },
    { workspace_id: 'returner', tool_name: 'email_read', created_at: at(6, 5) },
  ]);
  const first = firstActivityTimes(rows, true);
  assert.deepEqual(twoDayValueWithinFirstWeek(first, rows, utcDayStart(at(10))), {
    eligible: 2,
    retained: 1,
  });
});

test('frequency bands remain stable at their boundaries', () => {
  assert.equal(frequencyBand(1), '1');
  assert.equal(frequencyBand(3), '2–3');
  assert.equal(frequencyBand(7), '4–7');
  assert.equal(frequencyBand(8), '8+');
  assert.equal(DAY_MS, 86_400_000);
});
