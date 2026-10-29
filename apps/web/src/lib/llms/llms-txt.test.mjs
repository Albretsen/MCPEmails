// ---------------------------------------------------------------------------
// /llms.txt: the generated parts stay tied to their sources.
//
// Run with: npm run test:llms-txt
//
// On 2026-10-29 the static llms.txt linked none of the client setup pages, the
// Claude and ChatGPT guides, the comparison or the settings lookup. This pins
// every public client page, none of the held ones, the pages added then, and
// the tool counts from public-facts.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLlmsTxt, clientSection } from './llms-txt.mjs';
import { ALL_CLIENTS, CLIENTS, HELD_CLIENTS } from '../clients/clients.mjs';
import { MODEL_VISIBLE_TOOL_COUNT, APP_ONLY_TOOL_COUNT } from '../public-facts.mjs';

const text = buildLlmsTxt();

test('lists every public client page under "Use it from your AI app"', () => {
  const section = text.slice(text.indexOf('## Use it from your AI app'), text.indexOf('## Connect a provider'));
  assert.ok(section.length > 0);
  for (const c of CLIENTS) {
    assert.ok(section.includes(`(https://mcpemails.com/docs/${c.slug})`), `missing /docs/${c.slug}`);
  }
  assert.ok(section.includes('(https://mcpemails.com/docs/clients)'));
});

test('a held client is left out', () => {
  const held = ALL_CLIENTS[0];
  const section = clientSection(ALL_CLIENTS.filter((c) => c.slug !== held.slug));
  assert.ok(!section.includes(`/docs/${held.slug})`));
  for (const slug of HELD_CLIENTS) assert.ok(!text.includes(`/docs/${slug})`), `held client ${slug} listed`);
});

test('links the pages the 2026-10-29 audit found missing', () => {
  for (const path of [
    '/blog/connect-claude-to-email',
    '/blog/connect-chatgpt-to-email',
    '/blog/can-claude-read-my-email',
    '/best-email-mcp-servers',
    '/tools/email-settings-lookup',
  ]) {
    assert.ok(text.includes(`(https://mcpemails.com${path})`), `missing ${path}`);
  }
});

test('tool counts come from public-facts', () => {
  assert.ok(text.includes(`Tools (${MODEL_VISIBLE_TOOL_COUNT}, `));
  assert.ok(text.includes(`also lists ${APP_ONLY_TOOL_COUNT} app-only tools`));
});

test('public/llms.txt is the generated file (run `npm run gen:llms`)', () => {
  const committed = readFileSync(new URL('../../../public/llms.txt', import.meta.url), 'utf8');
  assert.equal(committed, text);
});

test('no em dashes, no template leftovers', () => {
  assert.ok(!text.includes('—'));
  assert.ok(!text.includes('${'));
});
