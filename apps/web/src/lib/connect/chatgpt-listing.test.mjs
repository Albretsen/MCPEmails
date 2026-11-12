// The Any Mailbox listing in the ChatGPT plugin directory, wherever the site
// shows it: /connect/<provider>, /docs/chatgpt, the home FAQ, the JSON-LD
// alternateName and llms.txt.
// Run with: npm run test:chatgpt-listing
//
// THE FIRST TEST FAILS ON PURPOSE until OpenAI approves the listing and
// CHATGPT_DIRECTORY_LISTING_URL (src/lib/connect/chatgpt.mjs) is set to the
// real URL. It is what keeps the launch PR from merging with a placeholder
// link. Do not skip it or loosen it: set the URL, then `npm run gen:llms`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHATGPT_APP_NAME,
  CHATGPT_DIRECTORY_LISTING_PLACEHOLDER,
  CHATGPT_DIRECTORY_LISTING_URL,
  CHATGPT_LOCALES,
  LISTING_URL_TOKEN,
  fillListingUrl,
  splitOnListingUrl,
} from './chatgpt.mjs';
import { getClient, MCP_URL } from '../clients/clients.mjs';
import { buildLlmsTxt } from '../llms/llms-txt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const json = (...p) => JSON.parse(readFileSync(path.join(webRoot, ...p), 'utf8'));
// "MCP Emails" and bare "mcpemails" are not the brand; mcpemails.com is a host.
const BRAND_MISSPELT = /MCP[ -]Emails|(?<![\w./@-])[Mm]cpemails(?![\w/@]|\.\w)/;
// OpenAI's labels (help.openai.com/en/articles/20001256, 2026-11-11), which
// every locale quotes in English except ja and zh, which quote OpenAI's own
// localised labels. "Install plugin" is what the directory button says.
const INSTALL = /Install plugin|プラグインをインストール|安装插件/;

test('EXPECTED TO FAIL until OpenAI approves: the listing URL is the real one, not the placeholder', () => {
  assert.notEqual(
    CHATGPT_DIRECTORY_LISTING_URL,
    CHATGPT_DIRECTORY_LISTING_PLACEHOLDER,
    'CHATGPT_DIRECTORY_LISTING_URL is still the placeholder. Set it to the Any Mailbox listing URL in ' +
      'src/lib/connect/chatgpt.mjs once OpenAI approves the plugin, then run `npm run gen:llms`.',
  );
  assert.match(CHATGPT_DIRECTORY_LISTING_URL, /^https:\/\/(chatgpt\.com|openai\.com)\//);
  assert.ok(!/placeholder/i.test(CHATGPT_DIRECTORY_LISTING_URL));
});

test('the listing URL is set, so every surface shows the directory variant', () => {
  assert.equal(typeof CHATGPT_DIRECTORY_LISTING_URL, 'string');
  assert.match(CHATGPT_DIRECTORY_LISTING_URL, /^https:\/\//);
  assert.equal(getClient('chatgpt').listingUrl, CHATGPT_DIRECTORY_LISTING_URL);
});

test('llms.txt names Any Mailbox once, with the same URL as the constant', () => {
  const lines = buildLlmsTxt().split('\n').filter((l) => l.includes(`"${CHATGPT_APP_NAME}"`));
  assert.equal(lines.length, 1, 'one llms.txt line names Any Mailbox');
  assert.ok(lines[0].includes(CHATGPT_DIRECTORY_LISTING_URL), `llms.txt: ${lines[0]}`);
  assert.ok(lines[0].includes('plugin directory'), lines[0]);
  assert.ok(!BRAND_MISSPELT.test(lines[0]), lines[0]);
});

test('the home FAQ has one directory question per locale, with the link token', () => {
  for (const locale of CHATGPT_LOCALES) {
    const items = json('messages', locale, 'home.json').faq.items;
    const hits = items.filter((i) => i.a.includes(LISTING_URL_TOKEN));
    assert.equal(hits.length, 1, `${locale}: one FAQ answer links the listing`);
    const [item] = hits;
    assert.ok(item.a.includes(CHATGPT_APP_NAME), `${locale}: the answer names ${CHATGPT_APP_NAME}`);
    assert.ok(item.a.includes('MCPEmails'), `${locale}: the answer names the developer`);
    assert.ok(item.q.includes('ChatGPT'), locale);
    assert.ok(!BRAND_MISSPELT.test(item.q + item.a), `${locale}: the brand is "MCPEmails"`);
    // The visible FAQ links the token; the JSON-LD writes the URL out.
    assert.equal(splitOnListingUrl(item.a).length, 2, locale);
    const filled = fillListingUrl(item.a);
    assert.ok(filled.includes(CHATGPT_DIRECTORY_LISTING_URL) && !filled.includes(LISTING_URL_TOKEN), locale);
    assert.ok(!/[<{}]/.test(filled), `${locale}: no stray brace or angle bracket after filling`);
  }
});

test('the /connect block names the plugin directory and its labels in every locale', () => {
  for (const locale of CHATGPT_LOCALES) {
    const c = json('src/lib/connect/chatgpt', `${locale}.json`);
    const all = [c.directorySub, ...c.directorySteps, c.directoryLink, c.directoryFaqA].join(' ');
    assert.ok(all.split(CHATGPT_APP_NAME).length >= 4, `${locale}: the directory copy names ${CHATGPT_APP_NAME}`);
    assert.ok(INSTALL.test(c.directorySteps.join(' ')), `${locale}: a step says Install plugin`);
    assert.ok(!/app directory|appkatalog|directorio de apps|annuaire d'applications|App-Verzeichnis|diretório de apps|アプリディレクトリ|应用目录/.test(all),
      `${locale}: OpenAI calls it the plugin directory now`);
  }
});

test('/docs/chatgpt leads with the plugin install and keeps the custom MCP server as the fallback', () => {
  for (const locale of CHATGPT_LOCALES) {
    const c = json('src/lib/clients/content', locale, 'chatgpt.json');
    const connect = json('src/lib/connect/chatgpt', `${locale}.json`);
    const consent = json('messages', locale, 'auth.json').authorize;

    assert.equal(c.listingLink, connect.directoryLink, `${locale}: one label for the listing link`);
    assert.ok(c.hero.titleLine2.includes(CHATGPT_APP_NAME), locale);
    const answer = c.hero.answer;
    assert.ok(answer.includes(CHATGPT_APP_NAME) && answer.indexOf(CHATGPT_APP_NAME) < answer.indexOf(MCP_URL),
      `${locale}: the answer names Any Mailbox before the custom-server URL`);

    // Main steps: account, the listing, sign in, consent. No server URL.
    const steps = c.setup.map((s) => `${s.h} ${s.p}`);
    assert.equal(steps.length, 4, locale);
    assert.ok(steps[1].includes(CHATGPT_APP_NAME) && INSTALL.test(steps[1]), `${locale}: step 2 installs the plugin`);
    assert.ok(steps[2].includes('MCPEmails'), `${locale}: step 3 signs in to MCPEmails`);
    assert.ok(!steps.join(' ').includes(MCP_URL), `${locale}: the directory steps need no URL`);
    // The consent step uses the consent screen's own labels, verbatim.
    for (const label of [
      consent.preset.readOnly.title,
      consent.preset.standard.title,
      consent.preset.full.title,
      consent.preset.custom.title,
      consent.allInboxes,
      consent.specificInboxes,
      consent.allowAccess,
    ]) {
      assert.ok(steps[3].includes(label), `${locale}: the consent step must say "${label}" as the screen does`);
    }
    assert.ok(steps[3].includes('<b>@</b>'), `${locale}: the last step says how to use it in a chat`);

    // Fallback: the custom MCP server on chatgpt.com, with the URL and OAuth.
    assert.equal(c.fallback.steps.length, 4, locale);
    const fb = c.fallback.steps.map((s) => s.p).join(' ');
    assert.ok(fb.includes(`<code>${MCP_URL}</code>`), `${locale}: the fallback carries the server URL`);
    assert.ok(fb.includes('OAuth') && fb.includes('<b>@</b>'), locale);
    assert.ok(!/developer mode|Developer mode|Entwicklermodus|mode développeur|modo desarrollador|modo de desenvolvedor|utviklermodus|開発者モード|开发者模式/
      .test(JSON.stringify(c)), `${locale}: ChatGPT needs no developer mode for a custom MCP server`);

    // The FAQ says Any Mailbox is MCPEmails.
    assert.ok(c.faq.some((f) => f.q.includes(CHATGPT_APP_NAME) && f.a.includes(MCP_URL)), `${locale}: FAQ on Any Mailbox`);
    for (const [k, v] of Object.entries({ setup: c.setup, fallback: c.fallback, faq: c.faq, hero: c.hero, meta: c.meta })) {
      assert.ok(!BRAND_MISSPELT.test(JSON.stringify(v)), `${locale} ${k}: the brand is "MCPEmails"`);
    }
  }
});
