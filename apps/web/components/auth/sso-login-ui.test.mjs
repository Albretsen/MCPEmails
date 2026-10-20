// ---------------------------------------------------------------------------
// "Sign in with SSO" on /login.
//
// Run with: npm run test:sso-login-ui
//
// Renders the real LoginApp with the real English messages. Pins that the
// SSO form is reachable from both other modes and opens directly for
// `initialMode="sso"` (/login?sso=1), that it POSTs the address to /auth/sso
// (never in a URL), and that each answer shows the right one-line message.
// jsdom does not navigate, so the happy path is pinned by the request it
// makes; app/auth/sso/route.test.ts pins the URL that comes back.
//
// Only reserved example domains.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

const window = installDom();

// SSO ships dark behind NEXT_PUBLIC_SSO_ENABLED; most tests run with it on.
process.env.NEXT_PUBLIC_SSO_ENABLED = 'true';

const { NextIntlClientProvider } = await import('next-intl');
const { LoginApp } = await import('./LoginApp.jsx');
const auth = (await import('../../messages/en/auth.json', { with: { type: 'json' } })).default;

window._virtualConsole?.removeAllListeners?.('jsdomError');

async function render(t, props = {}, answer = { status: 404, body: { error: 'sso_not_configured' } }) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const view = await mount(
    createElement(NextIntlClientProvider, { locale: 'en', messages: { auth } }, createElement(LoginApp, props)),
  );
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await view.unmount();
  });
  return { ...view, requests };
}

function setInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const buttonByText = (container, text) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === text) ?? null;

async function submitSso(container, email) {
  await flush(() => setInput(container.querySelector('#login-email-sso'), email));
  await flush(() => {
    container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}

test('flag off: no SSO link on either form, and ?sso=1 opens the password form', async (t) => {
  process.env.NEXT_PUBLIC_SSO_ENABLED = '';
  t.after(() => { process.env.NEXT_PUBLIC_SSO_ENABLED = 'true'; });
  const { container } = await render(t, { initialMode: 'sso' });
  assert.equal(container.querySelector('#login-email-sso'), null);
  assert.equal(buttonByText(container, auth.login.ssoLink), null, 'link on the password form');
  await flush(() => buttonByText(container, auth.login.switchToMagicLink).click());
  assert.equal(buttonByText(container, auth.login.ssoLink), null, 'link on the magic-link form');
});

test('the SSO form is reachable from the password form and from the magic-link form', async (t) => {
  const { container } = await render(t);
  assert.equal(container.querySelector('#login-email-sso'), null);
  await flush(() => buttonByText(container, auth.login.ssoLink).click());
  assert.ok(container.querySelector('#login-email-sso'));
  assert.equal(container.querySelector('h1')?.textContent, auth.login.ssoLink);

  await flush(() => buttonByText(container, auth.login.switchToPassword).click());
  await flush(() => buttonByText(container, auth.login.switchToMagicLink).click());
  assert.ok(buttonByText(container, auth.login.ssoLink), 'link missing on the magic-link form');
});

test('/login?sso=1 opens straight on the SSO form', async (t) => {
  const { container } = await render(t, { initialMode: 'sso' });
  assert.ok(container.querySelector('#login-email-sso'));
});

test('submitting POSTs the address and the safe redirect to /auth/sso', async (t) => {
  const { container, requests } = await render(t, { initialMode: 'sso', redirectTo: '/dashboard/inboxes' }, {
    status: 200, body: { url: 'https://idp.example/saml' },
  });
  await submitSso(container, ' pat@company-sso.example ');
  await waitFor(() => requests.length === 1);
  assert.equal(requests[0].url, '/auth/sso');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { email: 'pat@company-sso.example', next: '/dashboard/inboxes' });
  assert.ok(!requests[0].url.includes('pat'), 'the address leaked into the URL');
});

test('an unknown domain shows the one generic line', async (t) => {
  const { container } = await render(t, { initialMode: 'sso' });
  await submitSso(container, 'pat@unknown.example');
  await waitFor(() => container.querySelector('[role="alert"]'));
  assert.equal(container.querySelector('[role="alert"]').textContent, auth.login.ssoNotConfigured);
});

test('an outage says SSO is unavailable, not that it is not set up', async (t) => {
  const { container } = await render(t, { initialMode: 'sso' }, { status: 503, body: { error: 'sso_unavailable' } });
  await submitSso(container, 'pat@company-sso.example');
  await waitFor(() => container.querySelector('[role="alert"]'));
  assert.equal(container.querySelector('[role="alert"]').textContent, auth.login.ssoUnavailable);
});

test('an invalid address is caught before any request', async (t) => {
  const { container, requests } = await render(t, { initialMode: 'sso' });
  await submitSso(container, 'not an email');
  assert.equal(requests.length, 0);
  assert.equal(container.querySelector('#login-email-sso-error')?.textContent, auth.login.errorEmailInvalid);
});
