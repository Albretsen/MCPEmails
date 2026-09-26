import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './providers.mjs';
import { CLIENTS } from '../clients/clients.mjs';

/**
 * A translated provider or client page must be the SAME page as its English
 * source, in another language. The first 18 translated provider pages were
 * generated from an early English draft and never refreshed: every one of them
 * shipped without the gotchas, limits, FAQ and auth sections the English page
 * later gained, and Google filed most of them under "Crawled - currently not
 * indexed". This test makes that drift a failure instead of a surprise.
 *
 * What must match English exactly: the key structure (same keys, same array
 * lengths), `_sources`, the non-prose auth fields, internal link hrefs, and
 * every <code> span and every URL in each string. What must differ: the prose, so an untranslated copy of
 * the English file cannot pass as a translation.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SETS = [
  { name: 'connect', dir: join(here, 'content'), registry: PROVIDERS },
  { name: 'clients', dir: join(here, '../clients/content'), registry: CLIENTS },
];
const ALLOWED_TAG = /^<\/?(b|code)>$/;
const VERBATIM = new Set(['_sources', 'auth.method', 'auth.status', 'auth.helpUrl', 'guide.href', 'persona.href', 'seeAlso.href']);

function leaves(value, path = '', out = new Map()) {
  if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  } else out.set(path, value);
  return out;
}

const sorted = (xs) => [...xs].sort();
const codeSpans = (s) => sorted(s.match(/<code>[\s\S]*?<\/code>/g) ?? []);
const urls = (s) => sorted((s.match(/https?:\/\/[^\s<"')]+/g) ?? []).map((u) => u.replace(/[.,;:]+$/, '')));
const isVerbatim = (path) => [...VERBATIM].some((v) => path === v || path.startsWith(`${v}[`));

for (const { name, dir, registry } of SETS) {
  const locales = readdirSync(dir).filter((l) => l !== 'en');

  test(`${name}: every translated file mirrors its English source`, () => {
    for (const locale of locales) {
      for (const file of readdirSync(join(dir, locale))) {
        const where = `${name}/${locale}/${file}`;
        const enPath = join(dir, 'en', file);
        assert.ok(existsSync(enPath), `${where} has no English source`);
        const en = leaves(JSON.parse(readFileSync(enPath, 'utf8')));
        const tr = leaves(JSON.parse(readFileSync(join(dir, locale, file), 'utf8')));

        assert.deepEqual(sorted(tr.keys()), sorted(en.keys()), `${where}: key structure differs from English`);

        let changed = 0;
        for (const [path, enValue] of en) {
          const value = tr.get(path);
          if (typeof enValue !== 'string') {
            assert.equal(value, enValue, `${where} ${path}`);
            continue;
          }
          assert.equal(typeof value, 'string', `${where} ${path} is not a string`);
          assert.ok(value.trim().length > 0, `${where} ${path} is empty`);
          if (isVerbatim(path)) {
            assert.equal(value, enValue, `${where} ${path} must stay verbatim`);
            continue;
          }
          if (value !== enValue) changed++;
          assert.ok(!value.includes('\u2014'), `${where} ${path} contains an em dash`);
          for (const tag of value.match(/<[^>]*>/g) ?? []) {
            assert.match(tag, ALLOWED_TAG, `${where} ${path} has a disallowed tag ${tag}`);
          }
          assert.equal(
            (value.match(/<b>/g) ?? []).length,
            (value.match(/<\/b>/g) ?? []).length,
            `${where} ${path} has unbalanced <b>`,
          );
          assert.deepEqual(codeSpans(value), codeSpans(enValue), `${where} ${path}: <code> spans differ from English`);
          assert.deepEqual(urls(value), urls(enValue), `${where} ${path}: URLs differ from English`);
        }
        assert.ok(changed > en.size / 3, `${where} looks untranslated (${changed} of ${en.size} strings differ)`);
      }
    }
  });

  test(`${name}: the registry's locales match the files on disk`, () => {
    for (const entry of registry) {
      const onDisk = readdirSync(dir).filter((l) => existsSync(join(dir, l, `${entry.slug}.json`)));
      assert.deepEqual(sorted(entry.locales), sorted(onDisk), `${name} ${entry.slug}`);
    }
  });
}
