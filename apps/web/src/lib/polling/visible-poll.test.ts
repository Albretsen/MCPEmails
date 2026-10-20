// Run with: npm run test:visible-poll
//
// The poll loop behind the dashboard's large-work runs panel and the kiosk
// health panel. Fake timers prove the cadence, the pause while hidden and the
// immediate refresh on becoming visible.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startVisiblePoll } from './visible-poll.ts';

class FakeDocument extends EventTarget {
  visibilityState = 'visible';
  set(state: 'visible' | 'hidden') {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

// setImmediate is not faked, so this drains the poll's promise chain.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function advance(t: test.TestContext, ms: number) {
  t.mock.timers.tick(ms);
  await settle();
}

function setup(t: test.TestContext, opts: { immediate?: boolean; interval?: () => number } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new FakeDocument();
  let calls = 0;
  const loop = startVisiblePoll({
    poll: async () => { calls += 1; },
    intervalMs: opts.interval ?? (() => 1000),
    immediate: opts.immediate,
    doc,
  });
  t.after(() => loop.stop());
  return { doc, loop, calls: () => calls };
}

test('polls once per interval, not on mount unless asked', async (t) => {
  const { calls } = setup(t);
  await settle();
  assert.equal(calls(), 0);
  await advance(t, 999);
  assert.equal(calls(), 0);
  await advance(t, 1);
  assert.equal(calls(), 1);
  await advance(t, 1000);
  assert.equal(calls(), 2);
});

test('immediate polls on start', async (t) => {
  const { calls } = setup(t, { immediate: true });
  await settle();
  assert.equal(calls(), 1);
});

test('nothing runs while hidden; showing polls at once and resumes the cadence', async (t) => {
  const { doc, calls } = setup(t);
  await advance(t, 1000);
  assert.equal(calls(), 1);

  doc.set('hidden');
  await advance(t, 60 * 60 * 1000);
  assert.equal(calls(), 1, 'a hidden tab must not poll');

  doc.set('visible');
  await settle();
  assert.equal(calls(), 2, 'becoming visible polls immediately');
  await advance(t, 1000);
  assert.equal(calls(), 3);
});

test('starting hidden schedules nothing until shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new FakeDocument();
  doc.visibilityState = 'hidden';
  let calls = 0;
  const loop = startVisiblePoll({ poll: () => { calls += 1; }, intervalMs: () => 1000, immediate: true, doc });
  t.after(() => loop.stop());
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(calls, 0);
  doc.set('visible');
  await settle();
  assert.equal(calls, 1);
});

test('the delay is re-read after every poll', async (t) => {
  // As in the runs panel: the poll itself learns whether work is in flight,
  // and the next delay follows from that answer.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new FakeDocument();
  const answers = [true, false, false];
  let active = true;
  let calls = 0;
  const loop = startVisiblePoll({
    poll: () => { active = answers[calls] ?? false; calls += 1; },
    intervalMs: () => (active ? 5000 : 60_000),
    doc,
  });
  t.after(() => loop.stop());
  await advance(t, 5000);
  assert.equal(calls, 1, 'fast while active');
  await advance(t, 5000);
  assert.equal(calls, 2, 'the active answer kept the fast cadence');
  await advance(t, 5000);
  assert.equal(calls, 2, 'idle cadence must not fire at the fast interval');
  await advance(t, 55_000);
  assert.equal(calls, 3);
});

test('now() polls at once and restarts the clock without doubling it', async (t) => {
  const { loop, calls } = setup(t);
  await advance(t, 600);
  loop.now();
  await settle();
  assert.equal(calls(), 1);
  await advance(t, 600);
  assert.equal(calls(), 1, 'the old timer was cleared');
  await advance(t, 400);
  assert.equal(calls(), 2);
  await advance(t, 1000);
  assert.equal(calls(), 3, 'exactly one clock is running');
});

test('a rejected poll keeps the loop alive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new FakeDocument();
  let calls = 0;
  const loop = startVisiblePoll({ poll: async () => { calls += 1; throw new Error('boom'); }, intervalMs: () => 1000, doc });
  t.after(() => loop.stop());
  await advance(t, 1000);
  await advance(t, 1000);
  assert.equal(calls, 2);
});

test('stop() ends polling and ignores later visibility changes', async (t) => {
  const { doc, loop, calls } = setup(t);
  loop.stop();
  await advance(t, 5000);
  doc.set('hidden');
  doc.set('visible');
  await settle();
  assert.equal(calls(), 0);
});
