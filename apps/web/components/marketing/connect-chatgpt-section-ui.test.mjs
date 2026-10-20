// ---------------------------------------------------------------------------
// /connect/<provider>: the "Use <provider> in ChatGPT" block.
//
// Run with: npm run test:connect-chatgpt-ui
//
// Renders the real ConnectProviderView with the real copy, the way the page
// does (src/lib/connect/chatgpt.mjs decides who gets the block, faq.mjs builds
// the FAQ), for a sample of providers in every locale they are published in,
// and pins: the block sits after the setup steps, names the provider, has the
// four steps, links /docs/chatgpt and the blog post through the locale-aware
// Link, and the FAQ carries the ChatGPT question everywhere but Yahoo.
//
// Harness as in connect-provider-cta.test.mjs: next-intl/server reads the real
// message files, the locale-aware Link is marked so it can be told apart from
// a plain anchor, and Nav and Footer are dropped before rendering.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { JSDOM } from 'jsdom';

const messagesFor = (locale) =>
  JSON.parse(readFileSync(new URL(`../../messages/${locale}/connect.json`, import.meta.url), 'utf8'));

const { createTranslator } = await import('next-intl');

mock.module('next-intl/server', {
  namedExports: {
    getTranslations: async ({ locale, namespace }) =>
      createTranslator({ locale, namespace, messages: { [namespace]: messagesFor(locale) } }),
  },
});
mock.module(new URL('../../src/i18n/navigation.ts', import.meta.url).href, {
  namedExports: {
    Link: ({ href, children, ...rest }) => createElement('a', { ...rest, href, 'data-intl-link': '' }, children),
    usePathname: () => '/',
    useRouter: () => ({}),
    redirect: () => {},
    getPathname: () => '/',
  },
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mcpemails.com/' });
globalThis.window ??= dom.window;
globalThis.document ??= dom.window.document;
globalThis.self ??= globalThis;

const { default: ConnectProviderView } = await import('./ConnectProviderView.jsx');
const { Nav, Footer } = await import('./Sections.jsx');
const { cloneElement, Children } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { PROVIDERS } = await import('../../src/lib/connect/providers.mjs');
const { getProviderContent } = await import('../../src/lib/connect/content.mjs');
const { getMultiMailboxCopy, showsMultiMailbox } = await import('../../src/lib/connect/multi-mailbox.mjs');
const { CHATGPT_BLOG_SLUG, CHATGPT_DIRECTORY_LISTING_URL, chatgptBlogLink, chatgptFaq, getChatgptCopy, showsChatgpt } =
  await import('../../src/lib/connect/chatgpt.mjs');
const { getPost, getPostLocales } = await import('../../src/lib/blog/posts.js');

const SAMPLE = ['aol', 'gmail', 'icloud', 'yahoo', 'ionos', 'imap', 'gmx', 'proton'];

/** The same props the page passes. */
async function render(locale, slug, postLocales = getPostLocales(getPost(CHATGPT_BLOG_SLUG))) {
  const provider = PROVIDERS.find((p) => p.slug === slug);
  const content = await getProviderContent(locale, slug);
  assert.ok(content, `no ${locale} copy for ${slug}`);
  const multiMailbox = showsMultiMailbox(provider) ? await getMultiMailboxCopy(locale) : null;
  const chatgpt = showsChatgpt(provider)
    ? { copy: await getChatgptCopy(locale), blog: chatgptBlogLink(locale, postLocales) }
    : null;
  const page = await ConnectProviderView({ locale, provider, content, multiMailbox, chatgpt });
  const kept = Children.toArray(page.props.children).filter((c) => c?.type !== Nav && c?.type !== Footer);
  const html = renderToStaticMarkup(cloneElement(page, {}, ...kept));
  return { provider, document: new JSDOM(html).window.document };
}

const fill = (s, name) => s.replaceAll('{provider}', name);

for (const slug of SAMPLE) {
  const provider = PROVIDERS.find((p) => p.slug === slug);
  for (const locale of provider.locales) {
    test(`${locale}/${slug}: the ChatGPT block ${showsChatgpt(provider) ? 'renders after the setup steps' : 'is absent'}`, async () => {
      const { document } = await render(locale, slug);
      const section = document.querySelector('section#chatgpt');
      if (!showsChatgpt(provider)) {
        assert.equal(section === null, true, 'limited pages promise nothing about ChatGPT');
        return;
      }
      const c = await getChatgptCopy(locale);
      assert.ok(section, 'section#chatgpt is missing');
      // Right after the setup steps.
      assert.equal(section.previousElementSibling?.id, 'how');
      assert.equal(section.querySelector('h2').textContent, fill(c.title, provider.name));
      // The app-directory install: CHATGPT_DIRECTORY_LISTING_URL is set.
      const steps = [...section.querySelectorAll('ol.connect-chatgpt-steps li')];
      assert.equal(steps.length, c.directorySteps.length);
      assert.ok(steps[0].textContent.includes(provider.name));
      assert.ok(steps.some((li) => li.textContent.includes('Any Mailbox')), 'a step names Any Mailbox');

      const links = [...section.querySelectorAll('a')].map((a) => ({
        href: a.getAttribute('href'),
        text: a.textContent,
        intl: a.hasAttribute('data-intl-link'),
      }));
      assert.deepEqual(links, [
        { href: CHATGPT_DIRECTORY_LISTING_URL, text: c.directoryLink, intl: false },
        { href: '/docs/chatgpt', text: c.docsLink, intl: true },
        { href: `/blog/${CHATGPT_BLOG_SLUG}`, text: c.blogLink, intl: true },
      ]);
      if (locale === 'en') assert.equal(c.blogLink, 'How to connect ChatGPT to your email');

      const questions = [...document.querySelectorAll('#faq summary h3')].map((h) => h.textContent);
      const q = chatgptFaq(c, provider.name).q;
      assert.equal(questions.includes(q), slug !== 'yahoo', `FAQ "${q}"`);
    });
  }
}

test('a locale the post is not translated into links the English post with no prefix', async () => {
  const { document } = await render('fr', 'aol', ['en']);
  const blog = [...document.querySelectorAll('section#chatgpt a')].find((a) => a.getAttribute('href').startsWith('/blog/'));
  assert.equal(blog.getAttribute('href'), `/blog/${CHATGPT_BLOG_SLUG}`);
  assert.equal(blog.hasAttribute('data-intl-link'), false);
});
