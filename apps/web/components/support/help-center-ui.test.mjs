// ---------------------------------------------------------------------------
// HelpCenter, rendered for real with the real English copy.
//
// Run with: npm run test:help-center
//
// Pins what help center v2 promised: articles start collapsed, contacting us
// sits above every article, `#article-<id>` opens that article (on load and on
// a later hash change), `#contact` opens the form, picking an article in the
// search opens it in place, and dashboard links are handed to onNavigate.
// The categories are a small fixture so this file does not move with the
// writers' article set.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { default: HelpCenter } = await import('./HelpCenter.jsx');
const { default: en } = await import('../../src/lib/support/help-content/en.json', { with: { type: 'json' } });

const copy = { ...en };
delete copy.articles;

const art = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  summary: `Summary ${id}`,
  keywords: '',
  body: [],
  steps: [`Step for ${id}.`],
  links: [],
  ...extra,
});

const CATEGORIES = [
  { area: 'common-fixes', title: 'Common fixes', lead: '', articles: [art('fix-one'), art('fix-two')] },
  {
    area: 'getting-started',
    title: 'Getting started',
    lead: '',
    articles: [
      art('connect-gmail', {
        body: ['Some context.'],
        links: [
          { label: 'Inboxes', href: '/dashboard/inboxes' },
          { label: 'Fix one', href: '/help#article-fix-one' },
          { label: 'Gmail guide', href: '/connect/gmail' },
        ],
      }),
    ],
  },
];

const INDEX = [
  { id: 'article:connect-gmail', kind: 'article', title: 'Title connect-gmail', hint: 'Summary', href: '#article-connect-gmail', terms: 'gmail' },
  { id: 'provider:gmail', kind: 'provider', title: 'Gmail', hint: 'Webmail', href: '/connect/gmail', terms: 'googlemail' },
];

function setHash(hash) {
  window.history.replaceState(null, '', `/dashboard/help${hash}`);
}

async function render(t, props = {}) {
  const view = await mount(createElement(HelpCenter, {
    variant: 'app',
    locale: 'en',
    copy,
    categories: CATEGORIES,
    index: INDEX,
    supportCategories: ['connect', 'client', 'billing', 'bug', 'feature', 'other'],
    form: { signedInEmail: 'ada@example.com', context: null, formToken: 't', meta: {} },
    ...props,
  }));
  t.after(async () => {
    await view.unmount();
    setHash('');
  });
  return view;
}

const details = (view, id) => view.container.querySelector(`details#article-${id}`);
const openIds = (view) => [...view.container.querySelectorAll('details.help-article')].filter((d) => d.open).map((d) => d.id).join(',');
const formShown = (view) => view.container.querySelector('form') !== null;

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

test('every article starts collapsed, with title and summary in the summary line', async (t) => {
  setHash('');
  const view = await render(t);
  const all = view.container.querySelectorAll('details.help-article');
  assert.equal(all.length, 3);
  assert.equal(openIds(view), '');
  const s = details(view, 'connect-gmail').querySelector('summary').textContent;
  assert.equal(s.includes('Title connect-gmail'), true);
  assert.equal(s.includes('Summary connect-gmail'), true);
  assert.equal(s.includes('Some context.'), false, 'the body is not in the summary');
});

test('the contact block, with the mailto and the reply time, comes before the first category', async (t) => {
  setHash('');
  const view = await render(t);
  const contact = view.container.querySelector('#contact');
  const firstCategory = view.container.querySelector('.help-category');
  assert.equal(contact === null, false);
  assert.equal(Boolean(contact.compareDocumentPosition(firstCategory) & window.Node.DOCUMENT_POSITION_FOLLOWING), true);
  const mail = contact.querySelector('a[href^="mailto:"]');
  assert.equal(mail.getAttribute('href'), 'mailto:support@mcpemails.com');
  assert.equal(contact.textContent.includes(en.contact.heading), true);
  assert.equal(contact.textContent.includes('one business day'), true);
  assert.equal(/a person reads/i.test(contact.textContent), false);
});

test('the section nav links the contact block and every category', async (t) => {
  setHash('');
  const view = await render(t);
  const links = [...view.container.querySelectorAll('.help-nav a')].map((a) => a.getAttribute('href'));
  const ids = [...view.container.querySelectorAll('.help-category')].map((c) => `#${c.id}`);
  assert.deepEqual(links, ['#contact', ...ids]);
  assert.equal(view.container.querySelector('.help-nav a').getAttribute('aria-current'), 'location');
});

test('"Was this helpful?" posts the answer once and says thanks', async (t) => {
  setHash('');
  window.localStorage.clear();
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posts.push([url, JSON.parse(init.body)]); return { ok: true, status: 204 }; };
  t.after(() => { globalThis.fetch = realFetch; });
  const view = await render(t);
  const article = view.container.querySelector('details.help-article');
  const no = [...article.querySelectorAll('.help-feedback-btn')].find((b) => b.textContent === en.feedback.no);
  await flush(() => no.click());
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], '/api/support/article-feedback');
  assert.deepEqual(posts[0][1], { articleId: article.id.replace(/^article-/, ''), locale: 'en', helpful: false });
  assert.equal(article.querySelector('.help-feedback-btn'), null, 'the buttons are gone');
  assert.equal(article.textContent.includes(en.feedback.thanksNo), true);
  assert.equal(article.querySelector('.help-feedback a').getAttribute('href'), '#contact');
});

test('the form is behind one click, and the button opens it', async (t) => {
  setHash('');
  const view = await render(t);
  assert.equal(formShown(view), false);
  const btn = [...view.container.querySelectorAll('#contact button')].find((b) => b.textContent.trim() === en.contact.openForm);
  await flush(() => btn.click());
  assert.equal(formShown(view), true);
  assert.equal(view.container.querySelector('#contact form') === null, false, 'the form sits in the contact block');
});

test('form.open (arrived with a topic) shows the form straight away', async (t) => {
  setHash('');
  const view = await render(t, { form: { signedInEmail: null, formToken: 't', meta: {}, open: true } });
  assert.equal(formShown(view), true);
});

test('#article-<id> on load opens exactly that article', async (t) => {
  setHash('#article-connect-gmail');
  const view = await render(t);
  await waitFor(() => openIds(view) !== '', { message: 'an article to open' });
  assert.equal(openIds(view), 'article-connect-gmail');
});

test('a later hash change opens the new article too', async (t) => {
  setHash('');
  const view = await render(t);
  window.location.hash = '#article-fix-two';
  await waitFor(() => details(view, 'fix-two').open, { message: 'fix-two to open' });
  assert.equal(details(view, 'fix-one').open, false);
});

test('#contact opens the form', async (t) => {
  setHash('#contact');
  const view = await render(t);
  await waitFor(() => formShown(view), { message: 'the form to open' });
});

test('choosing an article in the search opens it in place and sets the hash', async (t) => {
  setHash('');
  const view = await render(t);
  await type(view.container.querySelector('#help-search-input'), 'gmail');
  const result = [...view.container.querySelectorAll('a.help-result')].find((a) => a.getAttribute('href') === '#article-connect-gmail');
  assert.equal(result === undefined, false, 'the article is a result');
  await flush(() => result.click());
  assert.equal(details(view, 'connect-gmail').open, true);
  assert.equal(window.location.hash, '#article-connect-gmail');
  assert.equal(view.container.querySelector('#help-search-input').value, '', 'the box is cleared');
});

test('a non-article result is an ordinary link', async (t) => {
  setHash('');
  const view = await render(t);
  await type(view.container.querySelector('#help-search-input'), 'googlemail');
  const result = view.container.querySelector('a.help-result');
  assert.equal(result.getAttribute('href'), '/connect/gmail');
  assert.equal(openIds(view), '');
});

test('article links: /help anchors become in-page, dashboard links go to onNavigate', async (t) => {
  setHash('');
  const navigated = [];
  const view = await render(t, { onNavigate: (href) => { navigated.push(href); return href.startsWith('/dashboard'); } });
  const links = [...details(view, 'connect-gmail').querySelectorAll('a')];
  assert.equal(links.map((a) => a.getAttribute('href')).join(' '), '/dashboard/inboxes #article-fix-one /connect/gmail');
  await flush(() => links[0].click());
  assert.equal(navigated.join(','), '/dashboard/inboxes');
});

test('the public variant localises marketing links', async (t) => {
  setHash('');
  const view = await render(t, { variant: 'page', locale: 'nb' });
  const hrefs = [...details(view, 'connect-gmail').querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.equal(hrefs.join(' '), '/dashboard/inboxes #article-fix-one /nb/connect/gmail');
  assert.equal(view.container.querySelector('h1').textContent, en.hero.title);
});
