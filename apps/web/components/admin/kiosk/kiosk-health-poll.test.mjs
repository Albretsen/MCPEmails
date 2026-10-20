// ---------------------------------------------------------------------------
// Kiosk health panel: how often it asks /api/kiosk/health.
//
// Run with: npm run test:kiosk-health-poll
//
// Was every 45 s, 24/7, at about 50 ms of CPU a call. Now every 120 s, never on
// mount (the server rendered a fresh snapshot), nothing while the page is
// hidden, and one check the moment it is shown. Fake timers drive the real
// provider; `fetch` is the stub.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../../scripts/test-dom.mjs';

installDom();

const { KioskHealthProvider, POLL_MS } = await import('./KioskHealth.tsx');

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
function setVisibility(state) {
  visibility = state;
  document.dispatchEvent(new window.Event('visibilitychange'));
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await flush(() => new Promise((resolve) => setImmediate(resolve)));
  }
}

async function advance(t, ms) {
  await flush(() => { t.mock.timers.tick(ms); });
  await settle();
}

async function renderProvider(t) {
  visibility = 'visible';
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let gets = 0;
  const previousFetch = globalThis.fetch;
  const snapshot = () => ({ level: 'ok', headline: 'OK', reason: '', since: null, checkedAt: new Date().toISOString() });
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/kiosk/health')) gets += 1;
    return { ok: true, status: 200, json: async () => snapshot() };
  };
  const view = await mount(createElement(KioskHealthProvider, { initial: snapshot() }, null));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
    visibility = 'visible';
  });
  await settle();
  return { view, gets: () => gets };
}

test('the interval is two minutes', () => {
  assert.equal(POLL_MS, 120_000);
});

test('no check on mount; then one every 120 s, not every 45 s', async (t) => {
  const { gets } = await renderProvider(t);
  assert.equal(gets(), 0);
  await advance(t, 45_000);
  assert.equal(gets(), 0, 'the old 45 s cadence is gone');
  await advance(t, 74_999);
  assert.equal(gets(), 0);
  await advance(t, 1);
  assert.equal(gets(), 1);
  await advance(t, 120_000);
  assert.equal(gets(), 2);
});

test('hidden: no checks; shown again: one check at once', async (t) => {
  const { view, gets } = await renderProvider(t);
  await flush(() => setVisibility('hidden'));
  await advance(t, 60 * 60_000);
  assert.equal(gets(), 0, 'a hidden page must not poll');
  await flush(() => setVisibility('visible'));
  await settle();
  assert.equal(gets(), 1, 'becoming visible checks immediately');
  assert.match(view.container.firstElementChild.className, /is-health-ok/);
  await advance(t, 120_000);
  assert.equal(gets(), 2);
});
