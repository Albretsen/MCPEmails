// The "Use <provider> in ChatGPT" block and FAQ entry on /connect/<provider>.
// Run with: npm run test:connect-chatgpt (the DOM loader is only for its
// extensionless-import resolution: seo.ts, posts.js and RichText.jsx need it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './providers.mjs';
import { getProviderContent } from './content.mjs';
import { getMultiMailboxCopy, showsMultiMailbox } from './multi-mailbox.mjs';
import {
  CHATGPT_BLOG_SLUG,
  CHATGPT_DIRECTORY_LISTING_URL,
  CHATGPT_LOCALES,
  chatgptBlogLink,
  chatgptFaq,
  chatgptSection,
  getChatgptCopy,
  showsChatgpt,
  showsChatgptFaq,
} from './chatgpt.mjs';
import { providerFaq } from './faq.mjs';
import { routing } from '../../i18n/routing.ts';
import { connectJsonLd } from '../../i18n/seo.ts';
import { stripTags } from '../../../components/marketing/RichText.jsx';
import { getPost, getPostLocales } from '../blog/posts.js';

// URLs and host names are compared after parsing, never by substring.
const urlsIn = (text) =>
  (stripTags(text).match(/https?:\/\/[^\s"'()，。、]+/g) ?? [])
    .map((u) => new URL(u.replace(/[.,;:]+$/, '')))
    .map((u) => `${u.protocol}//${u.host}${u.pathname}`);
const codeUrlsIn = (text) =>
  [...text.matchAll(/<code>([\s\S]*?)<\/code>/g)].flatMap((m) => urlsIn(m[1]));
const hostsIn = (text) =>
  (stripTags(text).match(/(?<![\w./-])[a-z0-9-]+(?:\.[a-z0-9-]+)+(?![\w/-])/gi) ?? [])
    .map((h) => h.replace(/\.+$/, '').toLowerCase());

const here = path.dirname(fileURLToPath(import.meta.url));
const copy = (locale) => JSON.parse(readFileSync(path.join(here, 'chatgpt', `${locale}.json`), 'utf8'));
const EM_DASH = new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']');
// OpenAI's help pages, checked 2026-10-26: custom MCP servers are added on
// ChatGPT Go and paid plans, under Plugins, Personal, Add, with no developer
// mode. Menu labels stay in English in every locale.
const GO_PLAN = /ChatGPT Go\b/;
const MENU_PATH = /Plugins[,、]\s*Personal/;
const STALE = /developer mode|Developer mode|Entwicklermodus|mode développeur|modo desarrollador|utviklermodus|开发者模式|Plus.{1,3}Pro.{1,3}Business/;
const MCP_URL = 'https://mcpemails.com/api/mcp';

test('the copy covers every routed locale', () => {
  assert.deepEqual([...CHATGPT_LOCALES].sort(), [...routing.locales].sort());
});

test('the flag is off: OpenAI has not listed the app yet', () => {
  assert.equal(CHATGPT_DIRECTORY_LISTING_URL, null);
});

test('every supported provider gets the block; the limited ones do not', () => {
  for (const p of PROVIDERS) assert.equal(showsChatgpt(p), p.status === 'supported', p.slug);
  for (const slug of ['hey', 'proton', 'tutanota']) {
    assert.equal(showsChatgpt(PROVIDERS.find((p) => p.slug === slug)), false, slug);
  }
  assert.equal(showsChatgpt(null), false);
});

test('the FAQ entry is on every supported page except Yahoo', () => {
  for (const p of PROVIDERS) {
    assert.equal(showsChatgptFaq(p), p.status === 'supported' && p.slug !== 'yahoo', p.slug);
  }
});

test('every locale has the same keys, filled, and actually translated', () => {
  const english = copy('en');
  for (const locale of CHATGPT_LOCALES) {
    const c = copy(locale);
    assert.deepEqual(Object.keys(c).sort(), Object.keys(english).sort(), locale);
    for (const key of ['steps', 'directorySteps']) {
      assert.equal(c[key].length, english[key].length, `${locale} ${key}`);
    }
    for (const [key, value] of Object.entries(c)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        assert.ok(v.trim().length > 0, `${locale} ${key} is empty`);
        assert.ok(!EM_DASH.test(v), `${locale} ${key} has an em dash`);
        assert.ok(!/</.test(stripTags(v)), `${locale} ${key} has a stray angle bracket`);
        assert.ok(!/[Mm]cpemails(?!\.com)|MCP[ -]Emails/.test(v), `${locale} ${key}: the brand is "MCPEmails"`);
        assert.ok(!/\{(?!provider\})/.test(v), `${locale} ${key}: unexpected brace`);
      }
      if (locale !== 'en' && key !== 'eyebrow') {
        assert.notDeepEqual(value, english[key], `${locale} ${key} is still English`);
      }
    }
  }
});

test('the claims match how ChatGPT adds a custom MCP server today, in every locale', () => {
  for (const locale of CHATGPT_LOCALES) {
    const c = copy(locale);
    for (const key of ['sub', 'faqA']) {
      assert.ok(GO_PLAN.test(c[key]), `${locale} ${key} must say ChatGPT Go and paid plans`);
      assert.ok(hostsIn(c[key]).some((h) => h === 'chatgpt.com'), `${locale} ${key} must say it is on chatgpt.com`);
    }
    for (const v of [c.sub, c.faqA, ...c.steps]) assert.ok(!STALE.test(v), `${locale}: stale developer-mode or plan-list claim`);
    assert.deepEqual(c.steps.flatMap(codeUrlsIn), [MCP_URL], `${locale}: connector URL`);
    assert.deepEqual(urlsIn(c.faqA), [MCP_URL], `${locale}: FAQ connector URL`);
    assert.ok(c.steps.some((s) => s.includes('OAuth')) && c.faqA.includes('OAuth'), `${locale}: OAuth`);
    assert.ok(c.steps.some((s) => MENU_PATH.test(s)), locale);
    assert.ok(c.steps.some((s) => s.includes('<b>@</b>')), `${locale}: the per-message @ step`);
  }
});

test('the rendered block stays short enough not to bury the setup steps', () => {
  const en = chatgptSection(copy('en'), 'AOL Mail');
  const words = [en.title, en.sub, ...en.steps, en.docs.label, en.blogLabel]
    .map(stripTags)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  assert.ok(words <= 120, `English block is ${words} words`);
});

test('the provider name is filled in, and the directory variant swaps the steps', async () => {
  for (const locale of CHATGPT_LOCALES) {
    const c = await getChatgptCopy(locale);
    const s = chatgptSection(c, 'AOL Mail');
    assert.ok(s.title.includes('AOL Mail'), locale);
    assert.ok(s.steps[0].includes('AOL Mail'), locale);
    assert.equal(s.steps.length, 4, locale);
    assert.equal(s.listing, null, locale);
    assert.equal(s.docs.href, '/docs/chatgpt');
    for (const v of [s.title, s.sub, ...s.steps]) assert.ok(!v.includes('{provider}'), locale);

    const listed = chatgptSection(c, 'AOL Mail', 'https://chatgpt.com/apps/example');
    assert.deepEqual(listed.steps, c.directorySteps.map((x) => x.replaceAll('{provider}', 'AOL Mail')));
    assert.deepEqual(listed.listing, { href: 'https://chatgpt.com/apps/example', label: c.directoryLink });
    assert.deepEqual(listed.steps.flatMap(urlsIn), [], `${locale}: directory steps need no URL`);

    const faq = chatgptFaq(c, 'AOL Mail');
    assert.ok(faq.q.includes('AOL Mail') && faq.a.includes('AOL Mail'), locale);
    assert.equal(chatgptFaq(c, 'AOL Mail', 'https://chatgpt.com/apps/example').a,
      c.directoryFaqA.replaceAll('{provider}', 'AOL Mail'));
  }
  // An unknown locale falls back to English rather than throwing.
  assert.deepEqual(await getChatgptCopy('xx'), copy('en'));
});

test('the blog link is locale-aware exactly where the post is translated', () => {
  const post = getPost(CHATGPT_BLOG_SLUG);
  assert.ok(post, `the blog post ${CHATGPT_BLOG_SLUG} is gone; the provider pages link to it`);
  const postLocales = getPostLocales(post);
  // Every locale has a translation today; the sidecars are what make it so.
  const sidecars = readdirSync(path.join(here, '../blog/translations', CHATGPT_BLOG_SLUG)).map((f) => f.replace(/\.js$/, ''));
  assert.deepEqual([...postLocales].sort(), ['en', ...sidecars].sort());
  for (const locale of CHATGPT_LOCALES) {
    assert.deepEqual(chatgptBlogLink(locale, postLocales), {
      href: `/blog/${CHATGPT_BLOG_SLUG}`,
      localized: postLocales.includes(locale),
    }, locale);
    assert.equal(chatgptBlogLink(locale, postLocales).localized, true, locale);
  }
  // A locale without a translation gets the English post, unprefixed.
  assert.deepEqual(chatgptBlogLink('fr', ['en']), { href: `/blog/${CHATGPT_BLOG_SLUG}`, localized: false });
});

test('a name that already says Mail is not doubled in the English question', () => {
  const en = copy('en');
  assert.equal(chatgptFaq(en, 'AOL Mail').q, 'Can ChatGPT read my AOL Mail?');
  assert.equal(chatgptFaq(en, 'Gmail').q, 'Can ChatGPT read my Gmail?');
  assert.equal(chatgptFaq(en, 'Rackspace Email').q, 'Can ChatGPT read my Rackspace Email?');
  assert.equal(chatgptFaq(en, 'IONOS').q, 'Can ChatGPT read my IONOS mail?');
  for (const p of PROVIDERS) {
    assert.ok(!/mail mail/i.test(chatgptFaq(en, p.name).q), p.name);
  }
});

async function jsonLdFaq(locale, slug) {
  const provider = PROVIDERS.find((p) => p.slug === slug);
  const content = await getProviderContent(locale, slug);
  assert.ok(content, `${locale}/${slug}`);
  const multiMailbox = showsMultiMailbox(provider) ? await getMultiMailboxCopy(locale) : null;
  const faq = providerFaq({ content, provider, multiMailbox, chatgptCopy: await getChatgptCopy(locale) });
  const ld = connectJsonLd(locale, {
    path: `/connect/${slug}`,
    title: content.meta.title,
    description: content.meta.description,
    howToName: 'x',
    steps: content.setup.map((s) => ({ h: s.h, p: stripTags(s.p) })),
    faq: faq.map((f) => ({ q: f.q, a: stripTags(f.a) })),
    connectLabel: 'Connect',
  });
  const page = (ld['@graph'] ?? [ld]).find((n) => n['@type'] === 'FAQPage');
  return { provider, faq, questions: page ? page.mainEntity.map((e) => e.name) : [] };
}

test('the FAQ entry is in the FAQPage JSON-LD on a non-Yahoo page, after the page\'s own entries', async () => {
  for (const [locale, slug] of [['en', 'aol'], ['fr', 'gmail'], ['en', 'ionos']]) {
    const { provider, faq, questions } = await jsonLdFaq(locale, slug);
    const q = chatgptFaq(copy(locale), provider.name).q;
    assert.ok(questions.includes(q), `${locale}/${slug}: JSON-LD is missing "${q}"`);
    assert.equal(faq.at(-1).q, q, `${locale}/${slug}: the ChatGPT entry comes last`);
  }
});

test('Yahoo keeps its own ChatGPT FAQ and gets no second one', async () => {
  for (const locale of PROVIDERS.find((p) => p.slug === 'yahoo').locales) {
    const { provider, questions } = await jsonLdFaq(locale, 'yahoo');
    assert.ok(!questions.includes(chatgptFaq(copy(locale), provider.name).q), locale);
  }
});
