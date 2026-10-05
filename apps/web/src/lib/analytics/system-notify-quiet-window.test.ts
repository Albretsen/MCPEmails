import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isQuiet,
  QUIET_EVENT_TYPES,
} from '../../../../../supabase/functions/system-notify/quiet-window.ts';

const at = (iso: string) => new Date(iso);

test('signup and checkout feedback are silent for the whole trip', () => {
  for (const type of ['user.signup', 'checkout.feedback']) {
    assert.equal(isQuiet(type, at('2026-10-05T22:00:00Z')), true, 'first instant, 00:00 Oslo on the 6th');
    assert.equal(isQuiet(type, at('2026-10-10T12:00:00Z')), true, 'mid trip');
    assert.equal(isQuiet(type, at('2026-10-13T21:59:59Z')), true, 'last second, 23:59:59 Oslo on the 13th');
  }
});

test('mail resumes at 00:00 Oslo on the 14th and was not muted before the 6th', () => {
  for (const type of ['user.signup', 'checkout.feedback']) {
    assert.equal(isQuiet(type, at('2026-10-13T22:00:00Z')), false, 'resumes exactly on the 14th');
    assert.equal(isQuiet(type, at('2026-10-20T08:00:00Z')), false);
    assert.equal(isQuiet(type, at('2026-10-05T21:59:59Z')), false, 'still on before the 6th');
  }
});

test('unknown events are never muted, and automation alerts follow the window', () => {
  assert.equal(isQuiet('automation.auto_disabled', at('2026-10-10T12:00:00Z')), true);
  assert.equal(isQuiet('automation.auto_disabled', at('2026-10-14T08:00:00Z')), false);
  assert.equal(isQuiet('some.future_event', at('2026-10-10T12:00:00Z')), false);
});

test('the muted set is exactly the three events', () => {
  assert.deepEqual([...QUIET_EVENT_TYPES].sort(), ['automation.auto_disabled', 'checkout.feedback', 'user.signup']);
});
