// ---------------------------------------------------------------------------
// /help copy: five locales that agree with each other and with the ticket API.
//
// Run with: npm run test:support-help
//
// What is held here:
//  - every locale has exactly English's key set (and the same array lengths),
//  - no string anywhere contains `<` (see apps/web/CLAUDE.md),
//  - every `{placeholder}` in an English string survives translation,
//  - article ids and link targets are identical across locales (a translation
//    rewords, it never re-points a link),
//  - every error code the ticket API can return has a line, in every locale,
//  - the category list matches the API's allow-list.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getHelpContent,
  HELP_LOCALES,
  SUPPORT_CATEGORIES,
  SUPPORT_ERROR_CODES,
  helpHref,
} from './help-content.mjs';
import { SUPPORT_CATEGORIES as API_CATEGORIES } from './validation.ts';

/** The ticket API's error codes, from the shared contract. */
const API_ERROR_CODES = [
  'invalid_json',
  'invalid_email',
  'invalid_category',
  'subject_required',
  'subject_too_long',
  'message_required',
  'message_too_long',
  'invalid_form_token',
  'rate_limited',
  'server_error',
  'not_found',
];

const content = Object.fromEntries(
  await Promise.all(HELP_LOCALES.map(async (l) => [l, await getHelpContent(l)])),
);

/** Every leaf as [path, value]; arrays contribute their length as a leaf too. */
function leaves(node, path = '') {
  if (Array.isArray(node)) {
    return [[`${path}.length`, node.length], ...node.flatMap((v, i) => leaves(v, `${path}[${i}]`))];
  }
  if (node && typeof node === 'object') {
    return Object.keys(node).sort().flatMap((k) => leaves(node[k], path ? `${path}.${k}` : k));
  }
  return [[path, node]];
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('non-English locales are real translations, not English copies', () => {
  for (const l of HELP_LOCALES.filter((x) => x !== 'en')) {
    assert.notEqual(content[l], content.en, `${l} fell back to English`);
    assert.notEqual(content[l].hero.title, content.en.hero.title, l);
    assert.notEqual(content[l].articles[0].steps[0], content.en.articles[0].steps[0], l);
  }
});

test('every locale has the same key set and array lengths as English', () => {
  const enPaths = leaves(content.en).map(([p]) => p).join('\n');
  for (const l of HELP_LOCALES) {
    assert.equal(leaves(content[l]).map(([p]) => p).join('\n'), enPaths, `${l} key set differs`);
  }
});

test('no string in any locale contains a literal "<"', () => {
  for (const l of HELP_LOCALES) {
    for (const [path, value] of leaves(content[l])) {
      if (typeof value === 'string') assert.equal(value.includes('<'), false, `${l} ${path}`);
    }
  }
});

test('placeholders survive translation', () => {
  const en = new Map(leaves(content.en));
  for (const l of HELP_LOCALES) {
    for (const [path, value] of leaves(content[l])) {
      if (typeof value !== 'string') continue;
      assert.equal(placeholders(value), placeholders(en.get(path)), `${l} ${path}`);
    }
  }
});

test('seven articles, same ids and link targets in every locale', () => {
  const ids = content.en.articles.map((a) => a.id);
  assert.equal(ids.length, 7);
  assert.deepEqual(ids, [
    'imap-password-rejected',
    'app-password-required',
    'yandex-imap-disabled',
    'assistant-sees-nothing',
    'usage-limit-reached',
    'change-or-cancel-plan',
    'disconnect-or-delete',
  ]);
  const hrefs = (c) => c.articles.map((a) => a.links.map((x) => x.href).join(' ')).join('\n');
  for (const l of HELP_LOCALES) {
    assert.deepEqual(content[l].articles.map((a) => a.id), ids, l);
    assert.equal(hrefs(content[l]), hrefs(content.en), l);
    for (const a of content[l].articles) {
      assert.equal(a.steps.length >= 3, true, `${l} ${a.id} has too few steps`);
      assert.equal(a.links.length >= 1, true, `${l} ${a.id} has no link`);
    }
  }
});

test('every ticket API error code has a line in every locale', () => {
  for (const code of API_ERROR_CODES) {
    assert.equal(SUPPORT_ERROR_CODES.includes(code), true, code);
  }
  for (const l of HELP_LOCALES) {
    for (const code of [...API_ERROR_CODES, 'network', 'unknown']) {
      const line = content[l].errors[code];
      assert.equal(typeof line === 'string' && line.length > 0, true, `${l} errors.${code}`);
    }
  }
});

test('the six categories match the ticket API and have labels everywhere', () => {
  assert.deepEqual([...SUPPORT_CATEGORIES], [...API_CATEGORIES]);
  for (const l of HELP_LOCALES) {
    for (const c of SUPPORT_CATEGORIES) {
      assert.equal(typeof content[l].categories[c] === 'string' && content[l].categories[c].length > 0, true, `${l} ${c}`);
    }
  }
});

test('copy keeps the house facts: 14-day refund, no SOC 2, support address', () => {
  for (const l of HELP_LOCALES) {
    const all = leaves(content[l]).map(([, v]) => String(v)).join('\n');
    assert.equal(/\b30\b/.test(all), false, `${l} mentions 30 (refund window is 14 days)`);
    assert.equal(/soc ?2/i.test(all), false, `${l} mentions SOC 2`);
    assert.equal(all.includes('14'), true, `${l} lost the 14-day refund`);
    assert.equal(all.includes('support@mcpemails.com'), true, l);
  }
});

test('an unknown locale falls back to English', async () => {
  assert.equal(await getHelpContent('it'), content.en);
});

test('helpHref prefixes marketing paths but never the dashboard', () => {
  assert.equal(helpHref('en', '/connect/yahoo'), '/connect/yahoo');
  assert.equal(helpHref('nb', '/connect/yahoo'), '/nb/connect/yahoo');
  assert.equal(helpHref('fr', '/docs#errors'), '/fr/docs#errors');
  assert.equal(helpHref('zh', '/dashboard/settings'), '/dashboard/settings');
  assert.equal(helpHref('es', 'mailto:support@mcpemails.com'), 'mailto:support@mcpemails.com');
});
