// ---------------------------------------------------------------------------
// Sidebar: the Supabase client is loaded when signing out, not before.
//
// Run with: npm run test:sidebar-signout
//
// sidebar-signout.test.mjs pins WHAT sign-out does. This file pins the three
// things that are new now that the client arrives through `import()`:
//
//   1. Sidebar.jsx has no static import of the browser client. One is enough
//      to put all of supabase-js back in every dashboard page load, and nothing
//      about the page would look different.
//   2. Hovering or focusing the button fetches the module early and does
//      nothing else: no client, no sign-out, no navigation.
//   3. If the client cannot be obtained, nobody is sent home still signed in,
//      nothing is thrown, and the next click works.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

const window = installDom();

let events = [];
/** When set, building the client fails, as a chunk that will not load does. */
let clientFails = false;

mock.module(new URL('../../scripts/test-stubs/supabase-client.mjs', import.meta.url).href, {
  namedExports: {
    createClient: () => {
      if (clientFails) throw new Error('ChunkLoadError: loading chunk failed');
      events.push('createClient');
      return {
        auth: {
          signOut: async (...args) => { events.push(['signOut', ...args]); return { error: null }; },
          getUser: async () => ({ data: { user: null }, error: null }),
        },
      };
    },
  },
});

const navigationStub = new URL('../../scripts/test-stubs/next-navigation.mjs', import.meta.url).href;
const realNavigation = await import(navigationStub);
const router = { ...realNavigation.useRouter(), push: (...args) => { events.push(['push', ...args]); } };
mock.module(navigationStub, { namedExports: { ...realNavigation, useRouter: () => router } });

const { NextIntlClientProvider } = await import('next-intl');
const { Sidebar } = await import('./Sidebar.jsx');
const dashboardChrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

async function renderSidebar(t) {
  events = [];
  clientFails = false;
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
  return { ...view, button: view.container.querySelector(`button[title="${dashboardChrome.sidebar.signOut}"]`) };
}

const settle = () => flush(() => new Promise((resolve) => setTimeout(resolve, 30)));

test('Sidebar.jsx does not statically import the Supabase browser client', () => {
  const source = readFileSync(new URL('./Sidebar.jsx', import.meta.url), 'utf8');
  const staticImports = source.split('\n').filter((line) => /^\s*import\b.*\bfrom\b/.test(line));
  assert.deepEqual(staticImports.filter((line) => /supabase/.test(line)), [],
    'a static import puts supabase-js back in the dashboard first load');
  assert.match(source, /import\('@\/lib\/supabase\/client'\)/, 'the client is reached through import()');
});

test('hover and focus warm the module and do nothing else', async (t) => {
  const { button } = await renderSidebar(t);
  await flush(() => {
    button.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    button.focus();
  });
  await settle();
  assert.deepEqual(events, [], 'no client is built, nobody is signed out, nothing navigates');
  // The hover styling that was already there still applies.
  assert.equal(button.style.color, 'var(--fg-1)');
});

test('a click after a hover still signs out once and navigates once', async (t) => {
  const { button } = await renderSidebar(t);
  await flush(() => { button.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); });
  await flush(() => button.click());
  await waitFor(() => events.some((e) => e[0] === 'push'), { message: 'the navigation home' });
  assert.deepEqual(events, ['createClient', ['signOut', { scope: 'local' }], ['push', '/']]);
});

test('when the client cannot be obtained: no navigation, nothing thrown, and the next click works', async (t) => {
  const { button } = await renderSidebar(t);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  clientFails = true;
  await flush(() => button.click());
  await settle();
  assert.deepEqual(events, [], 'nobody is sent home while still signed in');
  assert.deepEqual(unhandled, [], 'the failure is not left as an unhandled rejection');
  assert.equal(button.disabled, false, 'the button is still usable');

  clientFails = false;
  await flush(() => button.click());
  await waitFor(() => events.some((e) => e[0] === 'push'), { message: 'the navigation home on retry' });
  assert.deepEqual(events, ['createClient', ['signOut', { scope: 'local' }], ['push', '/']]);
});
