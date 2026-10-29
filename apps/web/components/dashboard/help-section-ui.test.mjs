// ---------------------------------------------------------------------------
// The dashboard's help section (/dashboard/help).
//
// Run with: npm run test:help-center
//
// HelpSection fetches /api/support/help-data in the app's locale, forwarding
// the connect modal's topic/provider/code from the page URL, shows one line
// while it loads or when it fails, and renders the shared HelpCenter. Only
// `fetch` is stubbed; the copy is the real English and Norwegian.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { NextIntlClientProvider } = await import('next-intl');
const { HelpSection, helpDataUrl, dashboardSectionFor } = await import('./HelpSection.jsx');
const chromeEn = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;
const chromeNb = (await import('../../messages/nb/dashboardChrome.json', { with: { type: 'json' } })).default;
const helpEn = (await import('../../src/lib/support/help-content/en.json', { with: { type: 'json' } })).default;

const copy = { ...helpEn };
delete copy.articles;

const PAYLOAD = {
  email: 'support@mcpemails.com',
  signedIn: true,
  signedInEmail: 'ada@example.com',
  context: null,
  formToken: 'tok',
  form: { initialCategory: 'connect', initialSubject: 'Trouble connecting Yahoo Mail', providerName: 'Yahoo Mail', meta: {}, open: true },
  ticketCategories: ['connect', 'client', 'billing', 'bug', 'feature', 'other'],
  locale: 'en',
  index: [],
  categories: [
    {
      area: 'getting-started',
      title: 'Getting started',
      lead: '',
      articles: [{ id: 'a1', title: 'Title a1', summary: 'Summary a1', keywords: '', body: [], steps: ['x'], links: [{ label: 'Inboxes', href: '/dashboard/inboxes' }] }],
    },
  ],
  copy,
};

function stubFetch(t, answer) {
  const calls = [];
  const previous = globalThis.fetch;
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    await gate;
    return answer();
  };
  t.after(() => { globalThis.fetch = previous; });
  return { calls, release };
}

async function render(t, { locale = 'en', messages = chromeEn, onNavigateSection = () => {} } = {}) {
  const view = await mount(createElement(NextIntlClientProvider, { locale, messages: { dashboardChrome: messages } },
    createElement(HelpSection, { onNavigateSection })));
  t.after(async () => {
    await view.unmount();
    window.history.replaceState(null, '', '/dashboard');
  });
  return view;
}

test('loads in the app locale, forwarding the connect seed, behind a skeleton', async (t) => {
  window.history.replaceState(null, '', '/dashboard/help?topic=connect&provider=yahoo&code=auth_failed&junk=1#contact');
  const { calls, release } = stubFetch(t, () => ({ ok: true, status: 200, json: async () => PAYLOAD }));
  const view = await render(t, { locale: 'nb', messages: chromeNb });
  assert.equal(view.container.querySelector('[role=status]').getAttribute('aria-label'), chromeNb.help.loading);
  assert.equal(view.container.querySelector('.help-center'), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], '/api/support/help-data?locale=nb&topic=connect&provider=yahoo&code=auth_failed');
  release();
  await waitFor(() => view.container.querySelector('.help-center'), { message: 'the help center' });
  assert.equal(view.container.querySelector('#contact form') === null, false, 'arrived with a topic: the form is open');
  assert.equal(view.container.querySelector('#help-subject').value, 'Trouble connecting Yahoo Mail', 'the seed reached the form');
});

test('a failed load is one error line', async (t) => {
  window.history.replaceState(null, '', '/dashboard/help');
  const { release } = stubFetch(t, () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found.' }) }));
  const view = await render(t);
  release();
  await waitFor(() => view.container.textContent === chromeEn.help.loadError, { message: 'the error line' });
  assert.equal(view.container.querySelectorAll('p').length, 1);
  assert.equal(view.container.querySelector('.help-center'), null);
});

test('a dashboard link in an article switches sections in place', async (t) => {
  window.history.replaceState(null, '', '/dashboard/help');
  const { release } = stubFetch(t, () => ({ ok: true, status: 200, json: async () => PAYLOAD }));
  const sections = [];
  const view = await render(t, { onNavigateSection: (s) => sections.push(s) });
  release();
  const link = await waitFor(() => view.container.querySelector('#article-a1 a'), { message: 'the article link' });
  assert.equal(link.getAttribute('href'), '/dashboard/inboxes');
  await flush(() => link.click());
  assert.equal(sections.join(','), 'inboxes');
});

test('helpDataUrl and dashboardSectionFor', () => {
  assert.equal(helpDataUrl('', ''), '/api/support/help-data?locale=en');
  assert.equal(helpDataUrl('fr', '?from=x&code=a%20b'), '/api/support/help-data?locale=fr&code=a+b&from=x');
  assert.equal(dashboardSectionFor('/dashboard'), 'overview');
  assert.equal(dashboardSectionFor('/dashboard/settings'), 'settings');
  assert.equal(dashboardSectionFor('/dashboard/nope'), null);
  assert.equal(dashboardSectionFor('/pricing'), null);
});
