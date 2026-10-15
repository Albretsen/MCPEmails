// ---------------------------------------------------------------------------
// /signup?provider=ionos and /login?provider=ionos: the hint on its way through.
//
// Run with: npm run test:connect-intent-auth-ui
//
// A visitor who pressed "Connect IONOS free" on a provider landing page lands
// on /signup with the slug in the link. This renders the real SignupApp and
// LoginApp and pins the parts of the hand-off a DOM can show:
//
//   - the slug is remembered in browser storage, under its own key;
//   - "sign in" on the signup page and "create a workspace" on the login page
//     carry it across, so changing your mind does not lose it;
//   - it is NOT in what the password signup sends to Supabase. It is a UI
//     hint, and the workspace row must never see it;
//   - with no slug, both pages are byte for byte what they were.
//
// jsdom does not navigate, so where the page goes AFTER a successful signup or
// an OAuth button cannot be read off `location`. Those destinations are built
// by `withConnectIntent`, whose behaviour is pinned in
// src/lib/connect/intent.test.mjs; the last test here pins that each of them
// is actually built with it.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

const window = installDom();

let onSignUp = null;
mock.module(new URL('../../scripts/test-stubs/supabase-client.mjs', import.meta.url).href, {
  namedExports: {
    createClient: () => ({
      auth: {
        signUp: async (params) => onSignUp(params),
        getUser: async () => ({ data: { user: null }, error: null }),
      },
    }),
  },
});
const { NextIntlClientProvider } = await import('next-intl');
const { SignupApp } = await import('./SignupApp.jsx');
const { LoginApp } = await import('./LoginApp.jsx');
const auth = (await import('../../messages/en/auth.json', { with: { type: 'json' } })).default;
const { CONNECT_INTENT_KEY, readStoredConnectIntent, rememberConnectIntent } = await import('../../src/lib/connect/intent-carry.mjs');

window._virtualConsole?.removeAllListeners?.('jsdomError');

async function render(t, Component, props) {
  window.localStorage.clear();
  const calls = [];
  onSignUp = async (params) => {
    calls.push(params);
    // No session: the page stays on "check your email" and does not navigate.
    return { data: { user: null, session: null }, error: null };
  };
  const view = await mount(
    createElement(NextIntlClientProvider, { locale: 'en', messages: { auth } }, createElement(Component, props)),
  );
  t.after(async () => {
    onSignUp = null;
    await view.unmount();
    window.localStorage.clear();
  });
  return { ...view, calls };
}

const footerLink = (container) => container.querySelector('.auth-footer a')?.getAttribute('href');

function setInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('signup: the provider is remembered and carried to the sign-in link', async (t) => {
  const { container } = await render(t, SignupApp, { connectProvider: 'ionos' });
  assert.equal(readStoredConnectIntent(window.localStorage), 'ionos');
  assert.equal(footerLink(container), '/login?provider=ionos');
});

test('signup: an invite redirect keeps its own link and still carries the provider', async (t) => {
  const { container } = await render(t, SignupApp, { connectProvider: 'ionos', redirectTo: '/invite/abc' });
  assert.equal(footerLink(container), '/login?redirect=%2Finvite%2Fabc&provider=ionos');
  assert.equal(readStoredConnectIntent(window.localStorage), 'ionos');
});

test('signup: the provider is not part of what the password signup sends', async (t) => {
  const { container, calls } = await render(t, SignupApp, { connectProvider: 'ionos' });
  await flush(() => {
    setInput(container.querySelector('#signup-email'), 'person@example.com');
    setInput(container.querySelector('#signup-password'), 'correct-horse-battery');
  });
  await flush(() => {
    container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(calls.length, 1, 'signUp was called once');
  const sent = JSON.stringify(calls[0]);
  assert.ok(!sent.includes('ionos'), `the hint reached Supabase: ${sent}`);
  assert.ok(!Object.keys(calls[0].options.data).some((key) => /provider|intent/i.test(key)));
  // Attribution is untouched by it.
  assert.equal(calls[0].options.data.acquisition_source, 'direct');
  assert.equal(calls[0].options.data.acquisition_landing_path, '/other');
  // And the confirmation link is the one it always was.
  assert.equal(new URL(calls[0].options.emailRedirectTo).search, '');
});

test('signup: with no provider nothing is stored and the page is unchanged', async (t) => {
  const { container } = await render(t, SignupApp, {});
  assert.equal(window.localStorage.getItem(CONNECT_INTENT_KEY), null);
  assert.equal(footerLink(container), '/login');
});

test('signup: with no provider an invite redirect link is unchanged', async (t) => {
  const { container } = await render(t, SignupApp, { redirectTo: '/invite/abc' });
  assert.equal(footerLink(container), '/login?redirect=%2Finvite%2Fabc');
});

test('login: the provider is remembered and carried back to the signup link', async (t) => {
  const { container } = await render(t, LoginApp, { connectProvider: 'ionos' });
  assert.equal(readStoredConnectIntent(window.localStorage), 'ionos');
  assert.equal(footerLink(container), '/signup?provider=ionos');
});

test('login: with no provider nothing is stored and the page is unchanged', async (t) => {
  const { container } = await render(t, LoginApp, {});
  assert.equal(window.localStorage.getItem(CONNECT_INTENT_KEY), null);
  assert.equal(footerLink(container), '/signup');
});

test('a hint already stored is left alone by a visit that carries none', async (t) => {
  // Someone who pressed the button, then reached /login through the nav.
  window.localStorage.clear();
  rememberConnectIntent(window.localStorage, 'ionos');
  const view = await mount(
    createElement(NextIntlClientProvider, { locale: 'en', messages: { auth } }, createElement(LoginApp, {})),
  );
  t.after(async () => { await view.unmount(); window.localStorage.clear(); });
  assert.equal(readStoredConnectIntent(window.localStorage), 'ionos');
});

test('every place a signed-in user is sent to is built with the hint', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  const signup = read('./SignupApp.jsx');
  // Password signup with a session, and both OAuth buttons.
  assert.equal(
    signup.match(/getSafeRedirect\(\) \?\? withConnectIntent\('\/dashboard\?firstrun=1', connectProvider\)/g)?.length,
    2,
  );
  assert.ok(!signup.includes("?? '/dashboard?firstrun=1'"), 'a signup destination is built without the hint');

  const login = read('./LoginApp.jsx');
  // Password sign-in.
  assert.ok(login.includes("return getSafeRedirect() ?? withConnectIntent('/dashboard', connectProvider);"));
  // Google and GitHub: `next` is only added when there is something to carry.
  assert.ok(login.includes("url.searchParams.set('next', withConnectIntent('/dashboard', connectProvider));"));
  assert.ok(!login.includes("?? '/dashboard';"), 'a login destination is built without the hint');

  // The pages hand the apps a shape-checked value and nothing else.
  for (const page of ['../../app/signup/page.js', '../../app/(auth)/login/page.js']) {
    const source = read(page);
    assert.ok(source.includes('const connectProvider = connectIntentSlugShape(params?.[CONNECT_INTENT_PARAM]);'), page);
    assert.ok(source.includes('connectProvider={connectProvider}'), page);
  }

  // A signed-in visitor is bounced off /signup by the session middleware,
  // which keeps the hint on the way to the dashboard.
  const middleware = read('../../src/lib/supabase/middleware.ts');
  assert.ok(middleware.includes("request.nextUrl.searchParams.get(CONNECT_INTENT_PARAM)"));

  // The OAuth initiation routes forward `next` untouched, which is what
  // carries the hint across the round trip. They need no change, and must not
  // grow one that reads the hint for anything else.
  for (const route of ['../../app/auth/google/route.ts', '../../app/auth/github/route.ts']) {
    const source = read(route);
    assert.ok(source.includes("callbackUrl.searchParams.set('next', next);"), route);
    assert.ok(!source.includes('intent'), route);
  }
});
