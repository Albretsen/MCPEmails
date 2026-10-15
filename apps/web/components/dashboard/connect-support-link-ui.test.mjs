// ---------------------------------------------------------------------------
// ConnectModal: "Still stuck? Contact support" under a failed connect.
//
// Run with: npm run test:support-entry-points
//
// v1 of /help is internal-only, so the line appears only when the dashboard
// hands the modal `supportVisible` (SUPPORT_RELEASE_GATE). When it does, the
// link carries the selected provider and the route's `error_code` so /help can
// preselect the form: `/help?topic=connect&provider=<slug>&code=<code>#contact`,
// each value URL-encoded and an empty one left out.
//
// The real modal is rendered with the real English messages; only `fetch` is
// replaced, to answer the connect route with a failure.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
window.HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { ConnectModal, supportContactHref } = await import('./ConnectModal.jsx');
const { ToastProvider } = await import('./Toast.jsx');
const chrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

const STILL_STUCK = chrome.connect.errorContactSupport;

/**
 * Mount the modal on the generic card at its credentials step. `reply` is what
 * the connect route answers with.
 */
async function openForm(t, { supportVisible, reply }) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === '/api/inboxes/imap') {
      requests.push(JSON.parse(init.body));
      return { ok: false, status: reply.status, json: async () => reply.body };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const props = {
    reconnect: null,
    onClose: () => {},
    onConnect: () => {},
    preselect: { card: 'generic' },
    atInboxLimit: false,
    planName: 'Free',
    inboxCount: 0,
    maxInboxes: null,
    stripePrices: null,
    businessShaped: false,
    onAdminConsentLink: () => {},
  };
  if (supportVisible !== undefined) props.supportVisible = supportVisible;
  const view = await mount(createElement(AppLocaleProvider, null, createElement(ToastProvider, null,
    createElement(ConnectModal, props))));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });
  const next = buttonNamed(view, chrome.connect.enterCredentials);
  assert.equal(next === null, false, 'step 1 has the button that opens the credentials form');
  await flush(async () => { next.click(); });
  await waitFor(() => view.container.querySelector('#cm-imap-host'), { message: 'the credentials form' });
  return { view, requests };
}

function buttonNamed(view, text) {
  return [...view.container.querySelectorAll('button')].find((b) => b.textContent.trim() === text) ?? null;
}

function linkNamed(view, text) {
  return [...view.container.querySelectorAll('a')].find((a) => a.textContent.trim() === text) ?? null;
}

const q = (view, id) => view.container.querySelector(`#${id}`);

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function fillAndSubmit(view) {
  await type(q(view, 'cm-email'), 'someone@example.com');
  await type(q(view, 'cm-imap-host'), 'imap.example.com');
  await type(q(view, 'cm-smtp-host'), 'smtp.example.com');
  await type(q(view, 'cm-password'), 'a-long-enough-password');
  await submitOnly(view);
}

async function submitOnly(view) {
  const connect = buttonNamed(view, chrome.connect.connectInbox);
  assert.equal(connect === null, false, 'the credentials step has its Connect button');
  await flush(async () => { connect.click(); });
}

const AUTH_FAILED = { status: 401, body: { error: 'Login failed', error_code: 'auth_failed' } };

test('supportVisible + a route failure: the link carries provider and code', async (t) => {
  const { view, requests } = await openForm(t, { supportVisible: true, reply: AUTH_FAILED });
  assert.equal(linkNamed(view, STILL_STUCK) === null, true, 'nothing before an error');
  await fillAndSubmit(view);
  await waitFor(() => requests.length === 1, { message: 'the connect request' });
  const link = await waitFor(() => linkNamed(view, STILL_STUCK), { message: 'the contact link' });
  assert.equal(link.getAttribute('href'), '/help?topic=connect&provider=generic&code=auth_failed#contact');
  assert.equal(q(view, 'cm-form-error').parentElement.contains(link), true, 'it sits in the error area');
});

test('the code is URL-encoded', async (t) => {
  const reply = { status: 400, body: { error: 'x', error_code: 'odd code&x=1' } };
  const { view, requests } = await openForm(t, { supportVisible: true, reply });
  await fillAndSubmit(view);
  await waitFor(() => requests.length === 1, { message: 'the connect request' });
  const link = await waitFor(() => linkNamed(view, STILL_STUCK), { message: 'the contact link' });
  assert.equal(link.getAttribute('href'), '/help?topic=connect&provider=generic&code=odd%20code%26x%3D1#contact');
});

test('not visible: the same failure shows no contact link', async (t) => {
  const { view, requests } = await openForm(t, { supportVisible: false, reply: AUTH_FAILED });
  await fillAndSubmit(view);
  await waitFor(() => requests.length === 1, { message: 'the connect request' });
  await waitFor(() => q(view, 'cm-form-error'), { message: 'the error headline' });
  assert.equal(linkNamed(view, STILL_STUCK) === null, true);
  assert.equal(view.container.textContent.includes(STILL_STUCK), false);
});

test('prop omitted: hidden by default', async (t) => {
  const { view, requests } = await openForm(t, { reply: AUTH_FAILED });
  await fillAndSubmit(view);
  await waitFor(() => requests.length === 1, { message: 'the connect request' });
  await waitFor(() => q(view, 'cm-form-error'), { message: 'the error headline' });
  assert.equal(linkNamed(view, STILL_STUCK) === null, true);
});

test('a client-side validation error after a route failure drops the old code', async (t) => {
  const { view, requests } = await openForm(t, { supportVisible: true, reply: AUTH_FAILED });
  await fillAndSubmit(view);
  await waitFor(() => requests.length === 1, { message: 'the connect request' });
  await waitFor(() => linkNamed(view, STILL_STUCK), { message: 'the first contact link' });
  // Clear a host: the modal refuses before any request.
  await type(q(view, 'cm-imap-host'), '');
  await submitOnly(view);
  await waitFor(
    () => linkNamed(view, STILL_STUCK)?.getAttribute('href') === '/help?topic=connect&provider=generic#contact',
    { message: 'the link without the stale code' },
  );
  assert.equal(requests.length, 1, 'the second submit never reached the route');
});

test('supportContactHref omits empty values and encodes the rest', () => {
  assert.equal(supportContactHref('', null), '/help?topic=connect#contact');
  assert.equal(supportContactHref('yahoo', ''), '/help?topic=connect&provider=yahoo#contact');
  assert.equal(supportContactHref('a b', 'c/d'), '/help?topic=connect&provider=a%20b&code=c%2Fd#contact');
});
