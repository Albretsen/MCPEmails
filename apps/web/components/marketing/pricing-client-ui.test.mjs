// ---------------------------------------------------------------------------
// /pricing: what a logged-out and a logged-in visitor see, and where every
// button goes.
//
// Run with: npm run test:pricing-ui
//
// WHY THIS EXISTS. The pricing page is prerendered and CDN-cached, so it cannot
// know who is looking at it. The HTML is always the logged-out page. After it
// mounts, the page asks the Supabase browser client for the session and, for a
// signed-in visitor, changes three things:
//
//   - the nav shows their email and a Dashboard button instead of Sign in /
//     Get started;
//   - the Free card's button goes to /dashboard instead of /signup;
//   - each paid card's button goes straight at the checkout route instead of
//     through /signup.
//
// A paid button pointing at the wrong place is a lost sale or, worse, a buyer
// sent to sign up for an account they already have. So this renders the real
// `PricingClient` with the real English messages and pins every CTA target in
// both states, the moment the page flips between them, and that a logged-out
// visitor's page does not change at all when the session check comes back.
//
// `@/lib/supabase/client` is mocked (the DOM test hooks already point it at a
// stub) so the session is whatever the test says and nothing leaves the
// process. `fetch` is replaced because the page posts an analytics beacon.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
// next/link schedules its viewport check on `self.requestIdleCallback`, falling
// back to a timer. Outside a browser there is no `self` at all.
globalThis.self ??= globalThis;

/** What the mocked browser client reports, and what the page did with it. */
let session = { user: null };
let calls = [];
let listeners = [];
let unsubscribed = 0;
/** When set, `getUser()` waits on this before answering. */
let getUserGate = null;

mock.module(new URL('../../scripts/test-stubs/supabase-client.mjs', import.meta.url).href, {
  namedExports: {
    createClient: () => {
      calls.push('createClient');
      return {
        auth: {
          getUser: async () => {
            calls.push('getUser');
            if (getUserGate) await getUserGate;
            return { data: { user: session.user }, error: null };
          },
          onAuthStateChange: (callback) => {
            calls.push('onAuthStateChange');
            listeners.push(callback);
            return { data: { subscription: { unsubscribe: () => { unsubscribed += 1; } } } };
          },
          signOut: async () => ({ error: null }),
        },
      };
    },
  },
});

const { NextIntlClientProvider } = await import('next-intl');
const { default: PricingClient } = await import('./PricingClient.jsx');
const { renderToString } = await import('react-dom/server');

/** Every English namespace, as the request config loads them for the page. */
const messagesDir = new URL('../../messages/en/', import.meta.url);
const messages = Object.fromEntries(
  readdirSync(messagesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(f, messagesDir), 'utf8'))]),
);
const pricing = messages.pricing;
const home = messages.home;

const USER = { id: 'u-0001', email: 'ada@example.com' };
const PLAN_KEYS = ['free', 'personal', 'solo', 'pro'];
const checkout = (plan, interval) => `/api/stripe/checkout/start?plan=${plan}&interval=${interval}`;
const viaSignup = (plan, interval) => `/signup?redirect=${encodeURIComponent(checkout(plan, interval))}`;

function tree() {
  return createElement(NextIntlClientProvider, { locale: 'en', messages }, createElement(PricingClient, { stripePrices: undefined }));
}

async function renderPricing(t, { user = null, gate = null } = {}) {
  session = { user };
  calls = [];
  listeners = [];
  unsubscribed = 0;
  getUserGate = gate;
  const beacons = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    beacons.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 204, json: async () => ({}) };
  };
  const view = await mount(tree());
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await view.unmount(); } };
  t.after(async () => {
    await unmount();
    globalThis.fetch = previousFetch;
    getUserGate = null;
  });

  const c = view.container;
  return {
    ...view,
    unmount,
    beacons,
    /** The four plan cards' buttons, in ladder order: [text, href]. */
    cardCtas: () => [...c.querySelectorAll('.price-grid .price > a.btn')].map((a) => [a.textContent, a.getAttribute('href')]),
    cardCta: (i) => c.querySelectorAll('.price-grid .price > a.btn')[i],
    navCta: () => [...c.querySelectorAll('header.nav .nav-cta > *')].map((el) => [el.tagName, el.textContent, el.getAttribute('href')]),
    toggle: (label) => [...c.querySelectorAll('.billing-toggle .billing-opt')].find((b) => b.firstChild.nodeValue === label),
    bandCtas: () => [...c.querySelectorAll('.pricing-cta-btns a')].map((a) => [a.textContent, a.getAttribute('href')]),
  };
}

/**
 * One spelling for the same DOM, so server and client markup can be compared.
 * React's server output differs from a client render only in ways that are not
 * content: `<!-- -->` markers between text nodes, resource-preload `<link>`s
 * hoisted to the front, self-closing syntax, attribute order and the spacing
 * inside a `style` attribute.
 */
function canonical(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  for (const link of host.querySelectorAll('link[rel="preload"]')) link.remove();
  const walker = document.createTreeWalker(host, window.NodeFilter.SHOW_COMMENT);
  const comments = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node);
  for (const comment of comments) comment.remove();
  host.normalize();
  const print = (node) => {
    if (node.nodeType === window.Node.TEXT_NODE) return JSON.stringify(node.nodeValue);
    const value = (a) => (a.name === 'style' ? node.style.cssText : a.value);
    const attrs = [...node.attributes].map((a) => `${a.name}=${JSON.stringify(value(a))}`).sort().join(' ');
    return `<${node.tagName.toLowerCase()} ${attrs}>${[...node.childNodes].map(print).join('')}</>`;
  };
  return [...host.childNodes].map(print).join('');
}

const LOGGED_OUT_NAV = [
  ['A', home.nav.signIn, '/login'],
  ['A', home.nav.getStarted, '/signup'],
];
const LOGGED_IN_NAV = [
  ['SPAN', USER.email, null],
  ['A', home.nav.dashboard, '/dashboard'],
];
const ctaText = (key) => pricing.plans[key].cta;

function loggedOutCtas(interval) {
  return [
    [ctaText('free'), '/signup'],
    [ctaText('personal'), viaSignup('personal', interval)],
    [ctaText('solo'), viaSignup('solo', interval)],
    [ctaText('pro'), viaSignup('pro', interval)],
  ];
}

function loggedInCtas(interval) {
  return [
    [ctaText('free'), '/dashboard'],
    [ctaText('personal'), checkout('personal', interval)],
    [ctaText('solo'), checkout('solo', interval)],
    [ctaText('pro'), checkout('pro', interval)],
  ];
}

// ===========================================================================
// Logged out
// ===========================================================================

test('logged out: every card button goes through /signup, annual preselected', async (t) => {
  const view = await renderPricing(t);
  await waitFor(() => calls.includes('getUser'), { message: 'the session check' });
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));

  assert.deepEqual(view.cardCtas(), loggedOutCtas('year'));
  assert.deepEqual(view.navCta(), LOGGED_OUT_NAV);
  assert.deepEqual(view.bandCtas(), [
    [pricing.ctaBand.ctaPrimary, '/signup'],
    [pricing.ctaBand.ctaSecondary, '/docs'],
  ]);
  assert.equal(view.container.querySelector('.nav-signed-in'), null);
});

test('logged out: the Monthly toggle re-targets the paid buttons at the monthly interval', async (t) => {
  const view = await renderPricing(t);
  await flush(() => view.toggle(pricing.billing.monthly).click());
  assert.deepEqual(view.cardCtas(), loggedOutCtas('month'));
  await flush(() => view.toggle(pricing.billing.annual).click());
  assert.deepEqual(view.cardCtas(), loggedOutCtas('year'));
});

test('logged out: the page a visitor gets is the prerendered page, and the session check changes nothing', async (t) => {
  session = { user: null };
  const serverHtml = renderToString(tree());

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const view = await renderPricing(t, { gate });
  const beforeCheck = view.container.innerHTML;
  assert.equal(canonical(beforeCheck), canonical(serverHtml), 'the first client render is the prerendered HTML');

  await flush(() => { release(); });
  await waitFor(() => calls.includes('getUser'), { message: 'the session check' });
  await flush(() => new Promise((resolve) => setTimeout(resolve, 30)));
  // An INITIAL_SESSION event with no session is what a real client emits too.
  await flush(() => { for (const listener of listeners) listener('INITIAL_SESSION', null); });
  assert.equal(view.container.innerHTML, beforeCheck, 'not one byte of the logged-out page moves');
});

test('logged out: the plan cards show four plans in ladder order, the featured one primary', async (t) => {
  const view = await renderPricing(t);
  const cards = [...view.container.querySelectorAll('.price-grid .price')];
  assert.deepEqual(cards.map((c) => c.querySelector('h4').textContent), PLAN_KEYS.map((k) => pricing.plans[k].name));
  assert.deepEqual(cards.map((c) => c.className), ['price', 'price', 'price featured', 'price']);
  assert.deepEqual(cards.map((c) => c.querySelector('a.btn').className), [
    'btn btn-lg btn-secondary', 'btn btn-lg btn-secondary', 'btn btn-lg btn-primary', 'btn btn-lg btn-secondary',
  ]);
});

// ===========================================================================
// Logged in
// ===========================================================================

test('logged in: the nav shows the account, Free goes to the dashboard, paid buttons go straight to checkout', async (t) => {
  const view = await renderPricing(t, { user: USER });
  await waitFor(() => view.container.querySelector('.nav-signed-in'), { message: 'the signed-in nav' });

  assert.deepEqual(view.navCta(), LOGGED_IN_NAV);
  assert.equal(view.container.querySelector('.nav-signed-in').getAttribute('title'), USER.email);
  assert.deepEqual(view.cardCtas(), loggedInCtas('year'));
  // The bottom band is the same for everyone.
  assert.deepEqual(view.bandCtas(), [
    [pricing.ctaBand.ctaPrimary, '/signup'],
    [pricing.ctaBand.ctaSecondary, '/docs'],
  ]);
});

test('logged in: the Monthly toggle re-targets checkout at the monthly interval', async (t) => {
  const view = await renderPricing(t, { user: USER });
  await waitFor(() => view.container.querySelector('.nav-signed-in'), { message: 'the signed-in nav' });
  await flush(() => view.toggle(pricing.billing.monthly).click());
  assert.deepEqual(view.cardCtas(), loggedInCtas('month'));
});

test('logged in: the first render is still the logged-out page (it has to match the prerendered HTML)', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const view = await renderPricing(t, { user: USER, gate });
  assert.deepEqual(view.navCta(), LOGGED_OUT_NAV, 'until the session is known, the page is the logged-out page');
  assert.deepEqual(view.cardCtas(), loggedOutCtas('year'));

  await flush(() => { release(); });
  await waitFor(() => view.container.querySelector('.nav-signed-in'), { message: 'the signed-in nav' });
  assert.deepEqual(view.cardCtas(), loggedInCtas('year'));
});

test('logged in: apart from the nav and the card buttons, the page is the same as logged out', async (t) => {
  const out = await renderPricing(t);
  await waitFor(() => calls.includes('getUser'), { message: 'the session check' });
  const normalise = (container) => {
    const clone = container.cloneNode(true);
    clone.querySelector('header.nav .nav-cta').innerHTML = '';
    for (const a of clone.querySelectorAll('.price-grid .price > a.btn')) a.setAttribute('href', '#');
    return clone.innerHTML;
  };
  const loggedOut = normalise(out.container);
  await out.unmount();

  const view = await renderPricing(t, { user: USER });
  await waitFor(() => view.container.querySelector('.nav-signed-in'), { message: 'the signed-in nav' });
  assert.equal(normalise(view.container), loggedOut);
});

// ===========================================================================
// How the session is read
// ===========================================================================

test('session: one client, one getUser, one auth listener, all from the mount', async (t) => {
  await renderPricing(t, { user: USER });
  await waitFor(() => calls.includes('onAuthStateChange') && calls.includes('getUser'), { message: 'the session wiring' });
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual([...calls].sort(), ['createClient', 'getUser', 'onAuthStateChange']);
  assert.equal(calls[0], 'createClient');
  assert.equal(listeners.length, 1);
});

test('session: an auth event signs the page in and out without a reload', async (t) => {
  const view = await renderPricing(t);
  await waitFor(() => listeners.length === 1, { message: 'the auth listener' });
  assert.deepEqual(view.navCta(), LOGGED_OUT_NAV);

  await flush(() => { listeners[0]('SIGNED_IN', { user: USER }); });
  assert.deepEqual(view.navCta(), LOGGED_IN_NAV);
  assert.deepEqual(view.cardCtas(), loggedInCtas('year'));

  await flush(() => { listeners[0]('SIGNED_OUT', null); });
  assert.deepEqual(view.navCta(), LOGGED_OUT_NAV);
  assert.deepEqual(view.cardCtas(), loggedOutCtas('year'));
});

test('session: leaving the page unsubscribes the auth listener, exactly once', async (t) => {
  const view = await renderPricing(t, { user: USER });
  await waitFor(() => listeners.length === 1, { message: 'the auth listener' });
  assert.equal(unsubscribed, 0);
  await view.unmount();
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(unsubscribed, 1);
});

test('the pricing-view beacon is still sent, once, for the pricing page', async (t) => {
  const view = await renderPricing(t);
  await waitFor(() => view.beacons.length > 0, { message: 'the analytics beacon' });
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(view.beacons, [{ url: '/api/analytics/pricing-view', body: { surface: 'pricing_page' } }]);
});
