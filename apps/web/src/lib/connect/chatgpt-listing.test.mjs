// The Any Mailbox listing in the ChatGPT app directory, wherever the site
// shows it: /connect/<provider>, /docs/chatgpt, the home FAQ and llms.txt.
// Run with: npm run test:chatgpt-listing
//
// THE FIRST TEST FAILS ON PURPOSE until OpenAI approves the listing and
// CHATGPT_DIRECTORY_LISTING_URL (src/lib/connect/chatgpt.mjs) is set to the
// real URL. It is what keeps the launch PR from merging with a placeholder
// link. Do not skip it or loosen it: set the URL (and the same URL in
// public/llms.txt, which the llms.txt test below checks).
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

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');
const json = (...p) => JSON.parse(readFileSync(path.join(webRoot, ...p), 'utf8'));

test('EXPECTED TO FAIL until OpenAI approves: the listing URL is the real one, not the placeholder', () => {
  assert.notEqual(
    CHATGPT_DIRECTORY_LISTING_URL,
    CHATGPT_DIRECTORY_LISTING_PLACEHOLDER,
    'CHATGPT_DIRECTORY_LISTING_URL is still the placeholder. Set it to the Any Mailbox listing URL in ' +
      'src/lib/connect/chatgpt.mjs and public/llms.txt once OpenAI approves the app.',
  );
  assert.match(CHATGPT_DIRECTORY_LISTING_URL, /^https:\/\/(chatgpt\.com|openai\.com)\//);
  assert.ok(!/placeholder/i.test(CHATGPT_DIRECTORY_LISTING_URL));
});

test('llms.txt names Any Mailbox with the same URL as the constant', () => {
  const llms = readFileSync(path.join(webRoot, 'public/llms.txt'), 'utf8');
  const lines = llms.split('\n').filter((l) => l.includes(`"${CHATGPT_APP_NAME}"`));
  assert.equal(lines.length, 1, 'one llms.txt line names Any Mailbox');
  assert.ok(lines[0].includes(CHATGPT_DIRECTORY_LISTING_URL), `llms.txt: ${lines[0]}`);
});

test('the home FAQ has one directory question per locale, with the link token', () => {
  for (const locale of CHATGPT_LOCALES) {
    const items = json('messages', locale, 'home.json').faq.items;
    const hits = items.filter((i) => i.a.includes(LISTING_URL_TOKEN));
    assert.equal(hits.length, 1, `${locale}: one FAQ answer links the listing`);
    const [item] = hits;
    assert.ok(item.a.includes(CHATGPT_APP_NAME), `${locale}: the answer names ${CHATGPT_APP_NAME}`);
    assert.ok(item.a.includes('MCP Emails'), `${locale}: the answer names the developer`);
    assert.ok(item.q.includes('ChatGPT'), locale);
    // The visible FAQ links the token; the JSON-LD writes the URL out.
    assert.equal(splitOnListingUrl(item.a).length, 2, locale);
    const filled = fillListingUrl(item.a);
    assert.ok(filled.includes(CHATGPT_DIRECTORY_LISTING_URL) && !filled.includes(LISTING_URL_TOKEN), locale);
    assert.ok(!/[<{}]/.test(filled), `${locale}: no stray brace or angle bracket after filling`);
  }
});

test('/docs/chatgpt leads with the directory install and keeps developer mode as the fallback', () => {
  assert.equal(getClient('chatgpt').listingUrl, CHATGPT_DIRECTORY_LISTING_URL);
  for (const locale of CHATGPT_LOCALES) {
    const c = json('src/lib/clients/content', locale, 'chatgpt.json');
    const connect = json('src/lib/connect/chatgpt', `${locale}.json`);
    const consent = json('messages', locale, 'auth.json').authorize;

    assert.equal(c.listingLink, connect.directoryLink, `${locale}: one label for the listing link`);
    assert.ok(c.hero.titleLine2.includes(CHATGPT_APP_NAME), locale);
    const answer = c.hero.answer;
    assert.ok(answer.includes(CHATGPT_APP_NAME) && answer.indexOf(CHATGPT_APP_NAME) < answer.indexOf(MCP_URL),
      `${locale}: the answer names Any Mailbox before the connector URL`);

    // Main steps: account, the listing, sign in, consent. No connector URL.
    const steps = c.setup.map((s) => `${s.h} ${s.p}`);
    assert.equal(steps.length, 4, locale);
    assert.ok(steps[1].includes(CHATGPT_APP_NAME) && steps[1].includes('Connect'), `${locale}: step 2 opens the listing`);
    assert.ok(steps[2].includes('MCP Emails'), `${locale}: step 3 signs in to MCP Emails`);
    assert.ok(!steps.slice(1).join(' ').includes(MCP_URL), `${locale}: the directory steps need no URL`);
    // The consent step uses the consent screen's own labels, verbatim.
    for (const label of [
      consent.preset.readOnly.title,
      consent.preset.full.title,
      consent.preset.custom.title,
      consent.allInboxes,
      consent.specificInboxes,
      consent.allowAccess,
    ]) {
      assert.ok(steps[3].includes(label), `${locale}: the consent step must say "${label}" as the screen does`);
    }

    // Fallback: developer mode and the custom connector, with the URL.
    const fb = c.fallback.steps.map((s) => s.p).join(' ');
    assert.equal(c.fallback.steps.length, 4, locale);
    assert.ok(fb.includes(`<code>${MCP_URL}</code>`), `${locale}: the fallback carries the connector URL`);
    assert.ok(fb.includes('OAuth') && fb.includes('<b>+</b>'), locale);
    assert.ok(!/mcpemails(?!\.com)/i.test(JSON.stringify({ s: c.setup, f: c.fallback })), `${locale}: the brand is "MCP Emails"`);
  }
});
