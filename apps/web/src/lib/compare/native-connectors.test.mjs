import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKED_ON, DATE_PUBLISHED, DATE_MODIFIED, SOURCES, TABLE_ROWS, NOT_STATED, LOCALES,
} from './native-connectors.mjs';

/**
 * /native-connectors-vs-mcp makes dated claims about other companies in five
 * languages. These checks keep the translations the same page as the English
 * one and keep the sourcing rules in native-connectors.mjs enforceable.
 */

const here = dirname(fileURLToPath(import.meta.url));
const load = (locale) => JSON.parse(readFileSync(join(here, 'native-connectors', `${locale}.json`), 'utf8'));
const content = Object.fromEntries(LOCALES.map((l) => [l, load(l)]));

// The cross-link to /best-email-mcp-servers renders in English only, because
// that route exists in English only.
const ENGLISH_ONLY = new Set(['more']);

function leaves(value, path = '', out = new Map()) {
  if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  } else out.set(path, value);
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

test('every locale has exactly the English keys', () => {
  const en = [...leaves(content.en).keys()].filter((k) => !ENGLISH_ONLY.has(k.split('.')[0])).sort();
  assert.ok(content.en.more, 'en.json lost the English-only cross-link copy');
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    assert.deepEqual([...leaves(content[locale]).keys()].sort(), en, `${locale}.json keys differ from en.json`);
  }
});

test('translations are translated, not copied', () => {
  const en = leaves(content.en);
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    for (const key of ['hero.lead', 'kinds.sub', 'table.footnote', 'faq.items[0].a']) {
      assert.notEqual(leaves(content[locale]).get(key), en.get(key), `${locale}: ${key} is still English`);
    }
  }
});

test('copy follows the house rules', () => {
  for (const locale of LOCALES) {
    for (const [key, s] of leaves(content[locale])) {
      const where = `${locale}: ${key}`;
      // A literal "<" renders verbatim in production; this copy has no markup.
      assert.ok(!s.includes('<'), `${where} contains "<"`);
      assert.ok(!s.includes('—'), `${where} contains an em dash`);
      // No tool counts (rule 4): they drift with every release.
      assert.ok(!/\b\d+\s*(tools|verktøy|herramientas|outils)\b/i.test(s) && !/\d+\s*个工具/.test(s), `${where} states a tool count`);
      assert.ok(!/seventeen|sytten|diecisiete|dix-sept/i.test(s), `${where} states a tool count`);
    }
    for (const key of ['hero.updated', 'table.footnote', 'sources.sub']) {
      assert.ok(leaves(content[locale]).get(key).includes('{date}'), `${locale}: ${key} lost its {date}`);
    }
  }
});

test('every table cell and source resolves in every locale', () => {
  for (const locale of LOCALES) {
    const c = content[locale];
    for (const row of TABLE_ROWS) {
      assert.ok(c.table.rows[row.key], `${locale}: no label for row ${row.key}`);
      for (const col of ['apps', 'provider', 'us']) {
        const v = row[col];
        if (typeof v === 'string' && v !== NOT_STATED) assert.ok(c.table.values[v], `${locale}: no value ${v}`);
      }
    }
    for (const s of SOURCES) assert.ok(c.sources.items[s.id], `${locale}: no label for source ${s.id}`);
    assert.equal(Object.keys(c.sources.items).length, SOURCES.length, `${locale}: a source label has no source`);
  }
});

test('sources are dated, and CHECKED_ON is the oldest of them', () => {
  for (const s of SOURCES) {
    assert.match(s.checkedOn, ISO, `${s.id}: checkedOn is not an ISO date`);
    assert.ok(s.url.startsWith('https://'), `${s.id}: url is not https`);
  }
  assert.equal(CHECKED_ON, SOURCES.map((s) => s.checkedOn).sort()[0]);
  assert.match(DATE_PUBLISHED, ISO);
  assert.match(DATE_MODIFIED, ISO);
  assert.ok(DATE_MODIFIED >= CHECKED_ON, 'DATE_MODIFIED is older than the facts on the page');
});
