// Runs public/ce.js in a small fake browser (node:vm) and checks what it sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../../../public/ce.js', import.meta.url), 'utf8');

function makeBrowser(pathname = '/dashboard/inboxes', { hydrated = true } = {}) {
  const sent = [];
  const timers = [];
  const listeners = { window: {}, document: {} };
  const on = (bag) => (type, fn) => { (bag[type] ??= []).push(fn); };
  const location = { pathname, href: `https://mcpemails.com${pathname}` };
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    documentElement: { lang: 'en' },
    body: hydrated ? { __reactFiber$abc: {} } : {},
    addEventListener: on(listeners.document),
  };
  class FakeBlob {
    constructor(parts) { this.text = parts.join(''); }
  }
  const window = {
    innerWidth: 1280,
    navigator: { sendBeacon: (url, blob) => { sent.push({ url, body: JSON.parse(blob.text) }); return true; } },
    addEventListener: on(listeners.window),
  };
  const context = {
    window, document, location, Blob: FakeBlob, JSON, Object, String, Date, RegExp,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  window.document = document;
  vm.runInNewContext(SOURCE, context);
  const events = () => sent.map((s) => s.body.e[0]);
  const runTimers = () => { while (timers.length) timers.shift().fn(); };
  const el = (tag, attrs = {}, text = '') => ({
    tagName: tag,
    textContent: text,
    getAttribute: (n) => attrs[n] ?? null,
    closest() { return this; },
  });
  const click = (target) => listeners.document.click.forEach((fn) => fn({ target }));
  const fire = (type, ev) => (listeners.window[type] ?? []).forEach((fn) => fn(ev));
  return { sent, events, runTimers, el, click, fire, location, document };
}

test('sends one page event with the hydration state on a buy page', () => {
  const b = makeBrowser('/pricing');
  b.runTimers();
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].url, '/api/analytics/client-event');
  assert.deepEqual(b.events()[0], { k: 'page', p: '/pricing', w: 1280, g: 'en', h: true });
  const cold = makeBrowser('/dashboard', { hydrated: false });
  cold.runTimers();
  assert.equal(cold.events()[0].h, false);
});

test('sends nothing for ordinary pages', () => {
  const b = makeBrowser('/blog/some-post');
  b.runTimers();
  b.fire('error', { message: 'boom', filename: 'x.js', lineno: 1, target: {} });
  assert.equal(b.sent.length, 0);
});

test('classifies buy links, signup redirects, plan buttons and contact links', () => {
  const b = makeBrowser('/dashboard/settings');
  b.click(b.el('A', { href: '/api/stripe/checkout/start?plan=personal&interval=month' }));
  b.click(b.el('A', { href: '/signup?redirect=%2Fapi%2Fstripe%2Fcheckout%2Fstart%3Fplan%3Dsolo%26interval%3Dyear' }));
  b.click(b.el('BUTTON', {}, 'Get Business'));
  b.click(b.el('BUTTON', {}, 'Compare all plans with Pro'));
  b.click(b.el('A', { href: 'mailto:hello@mcpemails.com' }));
  b.click(b.el('A', { href: '/dashboard/help' }));
  b.click(b.el('A', { href: '/docs' }));
  const got = b.events().map((e) => `${e.k}:${e.t}`);
  assert.deepEqual(got, ['buy:personal', 'buy:pro', 'buy:business', 'contact:mailto', 'contact:help']);
});

test('reports a buy click that did not leave the page, and not one that did', () => {
  const stuck = makeBrowser('/dashboard/inboxes');
  stuck.click(stuck.el('A', { href: '/api/stripe/checkout/start?plan=solo' }));
  stuck.runTimers();
  const kinds = stuck.events().map((e) => e.k);
  assert.ok(kinds.includes('buy_stalled'), kinds.join(','));

  const ok = makeBrowser('/dashboard/inboxes');
  ok.click(ok.el('A', { href: '/api/stripe/checkout/start?plan=solo' }));
  ok.location.href = 'https://checkout.stripe.com/c/pay/cs_live_x';
  ok.runTimers();
  assert.ok(!ok.events().some((e) => e.k === 'buy_stalled'));
});

test('reports script errors and failed script loads once each', () => {
  const b = makeBrowser('/dashboard');
  b.fire('error', { message: 'TypeError: x is undefined', filename: 'https://mcpemails.com/_next/a.js', lineno: 3, target: {} });
  b.fire('error', { message: 'TypeError: x is undefined', filename: 'https://mcpemails.com/_next/a.js', lineno: 3, target: {} });
  b.fire('error', { target: { tagName: 'SCRIPT', src: 'https://mcpemails.com/_next/static/chunks/b.js' } });
  b.fire('unhandledrejection', { reason: new Error('chunk load failed') });
  const got = b.events().map((e) => e.k);
  assert.deepEqual(got, ['error', 'resource', 'rejection']);
});

test('never throws, even with a broken environment', () => {
  assert.doesNotThrow(() => vm.runInNewContext(SOURCE, { window: {}, document: {} }));
  assert.doesNotThrow(() => vm.runInNewContext(SOURCE, {}));
});
