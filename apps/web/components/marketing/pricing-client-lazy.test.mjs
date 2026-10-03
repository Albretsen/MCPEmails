// ---------------------------------------------------------------------------
// /pricing: the Supabase client is loaded after the page, not with it.
//
// Run with: npm run test:pricing-ui
//
// pricing-client-ui.test.mjs pins what the page shows. This pins what is new
// now that the session check reaches the client through `import()`:
//
//   1. PricingClient.jsx has no static import of the browser client. One would
//      put supabase-js back in front of every visitor to a public page.
//   2. If the client cannot be obtained, the visitor keeps the complete
//      signed-out page and nothing is thrown.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis;

let attempts = 0;
mock.module(new URL('../../scripts/test-stubs/supabase-client.mjs', import.meta.url).href, {
  namedExports: {
    createClient: () => {
      attempts += 1;
      throw new Error('ChunkLoadError: loading chunk failed');
    },
  },
});

const { NextIntlClientProvider } = await import('next-intl');
const { default: PricingClient } = await import('./PricingClient.jsx');

const messagesDir = new URL('../../messages/en/', import.meta.url);
const messages = Object.fromEntries(
  readdirSync(messagesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(f, messagesDir), 'utf8'))]),
);

test('PricingClient.jsx does not statically import the Supabase browser client', () => {
  const source = readFileSync(new URL('./PricingClient.jsx', import.meta.url), 'utf8');
  const staticImports = source.split('\n').filter((line) => /^\s*import\b.*\bfrom\b/.test(line));
  assert.deepEqual(staticImports.filter((line) => /supabase/.test(line)), [],
    'a static import puts supabase-js back in the pricing page first load');
  assert.match(source, /import\('@\/lib\/supabase\/client'\)/, 'the client is reached through import()');
});

test('when the client cannot be obtained, the visitor keeps the signed-out page and nothing is thrown', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 204, json: async () => ({}) });

  const view = await mount(createElement(NextIntlClientProvider, { locale: 'en', messages },
    createElement(PricingClient, { stripePrices: undefined })));
  t.after(async () => {
    await view.unmount();
    process.off('unhandledRejection', onUnhandled);
    globalThis.fetch = previousFetch;
  });
  const first = view.container.innerHTML;
  await flush(() => new Promise((resolve) => setTimeout(resolve, 40)));

  assert.equal(attempts, 1, 'the page did try to read the session');
  assert.deepEqual(unhandled, []);
  assert.equal(view.container.innerHTML, first, 'the signed-out page is untouched');
  const hrefs = [...view.container.querySelectorAll('.price-grid .price > a.btn')].map((a) => a.getAttribute('href'));
  assert.equal(hrefs[0], '/signup');
  assert.ok(hrefs.slice(1).every((h) => h.startsWith('/signup?redirect=')), 'paid buttons still go through signup');
  assert.equal(view.container.querySelector('.nav-signed-in'), null);
});
