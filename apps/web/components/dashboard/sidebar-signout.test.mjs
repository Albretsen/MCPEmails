// ---------------------------------------------------------------------------
// Sidebar: signing out.
//
// Run with: npm run test:sidebar-signout
//
// WHY THIS EXISTS. Sign-out is one button with no label, and it is the only
// reason the dashboard touches the Supabase browser client at all. What it has
// to do is small and exact:
//
//   1. call `auth.signOut({ scope: 'local' })`: local scope, so the session is
//      cleared on this device without waiting for (or depending on) Supabase's
//      server-side revocation, which can answer 503;
//   2. THEN send the person to `/` with the app router, and do that whether the
//      call resolved, resolved with an error, or threw.
//
// Getting the order wrong sends someone home still signed in. Dropping the
// navigation leaves them staring at a dashboard whose session is gone.
//
// The real `Sidebar` is rendered with the real English messages. The two
// modules with no meaning outside a Next page are the ones the DOM test hooks
// already substitute (`@/lib/supabase/client`, `next/navigation`); here they
// are mocked on top of that so each call lands in this file.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

/** Every observable step, in the order it happened. */
let events = [];
/** What `auth.signOut` does in the current test. */
let signOutImpl = async () => ({ error: null });
let clientsCreated = 0;

mock.module(new URL('../../scripts/test-stubs/supabase-client.mjs', import.meta.url).href, {
  namedExports: {
    createClient: () => {
      clientsCreated += 1;
      events.push('createClient');
      return {
        auth: {
          signOut: async (...args) => {
            events.push(['signOut', ...args]);
            return signOutImpl(...args);
          },
          getUser: async () => ({ data: { user: null }, error: null }),
        },
      };
    },
  },
});

// The navigation stub has more exports than the router (next-intl re-exports
// several by name), so keep all of them and replace only `useRouter`.
const navigationStub = new URL('../../scripts/test-stubs/next-navigation.mjs', import.meta.url).href;
const realNavigation = await import(navigationStub);
const router = {
  push: (...args) => { events.push(['push', ...args]); },
  replace: (...args) => { events.push(['replace', ...args]); },
  refresh: () => { events.push(['refresh']); },
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};
mock.module(navigationStub, { namedExports: { ...realNavigation, useRouter: () => router } });

const { NextIntlClientProvider } = await import('next-intl');
const { Sidebar } = await import('./Sidebar.jsx');
const dashboardChrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

const SIGN_OUT = dashboardChrome.sidebar.signOut;

async function renderSidebar(t) {
  events = [];
  clientsCreated = 0;
  signOutImpl = async () => ({ error: null });
  const view = await mount(
    createElement(NextIntlClientProvider, { locale: 'en', messages: { dashboardChrome } },
      createElement(Sidebar, {
        route: 'overview',
        setRoute: () => {},
        counts: { inboxes: 1, keys: 1, members: 1 },
        user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A' },
        workspace: { id: 'ws-0001', slug: 'acme', plan: 'pro', displayName: 'Acme' },
        workspaces: [],
        activeWorkspaceId: 'ws-0001',
        isOpen: false,
        onClose: () => {},
      })),
  );
  t.after(() => view.unmount());
  const button = view.container.querySelector(`button[title="${SIGN_OUT}"]`);
  return { ...view, button };
}

const pushes = () => events.filter((e) => Array.isArray(e) && e[0] === 'push');
const signOuts = () => events.filter((e) => Array.isArray(e) && e[0] === 'signOut');

test('the sign-out control is one button in the account footer, titled from the catalog', async (t) => {
  const { container, button } = await renderSidebar(t);
  assert.ok(button, 'a button titled "Sign out" exists');
  assert.equal(container.querySelectorAll(`button[title="${SIGN_OUT}"]`).length, 1);
  assert.ok(container.querySelector('.footer-user').contains(button));
  assert.equal(button.disabled, false);
});

test('rendering the sidebar does not sign anyone out or build a client', async (t) => {
  await renderSidebar(t);
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(signOuts(), []);
  assert.deepEqual(pushes(), []);
});

test('click: signOut({ scope: "local" }) is called once, then the router pushes "/"', async (t) => {
  const { button } = await renderSidebar(t);
  await flush(() => button.click());
  await waitFor(() => pushes().length > 0, { message: 'the navigation home' });

  assert.equal(clientsCreated, 1, 'one browser client is built for the sign-out');
  assert.deepEqual(events, [
    'createClient',
    ['signOut', { scope: 'local' }],
    ['push', '/'],
  ], 'same client call, same argument, then the same navigation, in that order');
});

test('order: the navigation waits for signOut to settle', async (t) => {
  const { button } = await renderSidebar(t);
  let release;
  signOutImpl = () => new Promise((resolve) => { release = () => resolve({ error: null }); });
  await flush(() => button.click());
  await waitFor(() => signOuts().length === 1, { message: 'signOut to be called' });
  await flush(() => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.deepEqual(pushes(), [], 'nobody is sent home while the session is still being cleared');

  await flush(() => { release(); });
  await waitFor(() => pushes().length === 1, { message: 'the navigation after signOut settles' });
  assert.deepEqual(pushes(), [['push', '/']]);
});

test('error path: signOut THROWING (e.g. a 503 from revocation) still navigates home', async (t) => {
  const { button } = await renderSidebar(t);
  signOutImpl = async () => { throw new Error('503 Service Unavailable'); };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  await flush(() => button.click());
  await waitFor(() => pushes().length > 0, { message: 'the navigation home after a failed signOut' });
  assert.deepEqual(events, ['createClient', ['signOut', { scope: 'local' }], ['push', '/']]);
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(unhandled, [], 'the failure is swallowed, not left as an unhandled rejection');
});

test('error path: signOut RESOLVING with an error still navigates home', async (t) => {
  const { button } = await renderSidebar(t);
  signOutImpl = async () => ({ error: { message: 'session_not_found', status: 403 } });
  await flush(() => button.click());
  await waitFor(() => pushes().length > 0, { message: 'the navigation home' });
  assert.deepEqual(events, ['createClient', ['signOut', { scope: 'local' }], ['push', '/']]);
});

test('sign-out uses the app router and nothing else: no replace, no refresh, no full-page load', async (t) => {
  const { button } = await renderSidebar(t);
  const before = window.location.href;
  await flush(() => button.click());
  await waitFor(() => pushes().length > 0, { message: 'the navigation home' });
  await flush(() => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(events.filter((e) => Array.isArray(e) && ['replace', 'refresh'].includes(e[0])), []);
  assert.equal(pushes().length, 1, 'exactly one navigation');
  assert.equal(window.location.href, before, 'the document itself is not navigated');
});

test('two clicks are two independent sign-outs, each ending in its own navigation', async (t) => {
  const { button } = await renderSidebar(t);
  await flush(() => { button.click(); button.click(); });
  await waitFor(() => pushes().length === 2, { message: 'both navigations' });
  assert.equal(signOuts().length, 2);
  assert.deepEqual(signOuts(), [['signOut', { scope: 'local' }], ['signOut', { scope: 'local' }]]);
});
