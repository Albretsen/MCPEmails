/**
 * The scoped locales (de, pt, ja; SCOPED_LOCALES in src/i18n/locale-policy.mjs)
 * are the ones most likely to drift: a PR that adds an English key and fills
 * in nb, es and fr from habit can forget them, and next-intl then renders the
 * raw key path on /de, /pt or /ja in production. So every messages/<scoped>
 * namespace must carry exactly the English keys, the same ICU arguments and
 * the same tags, and no em dash. The file keeps its German name because
 * `npm run test:i18n-de` (and CI) runs it by that path.
 *
 * zh is deliberately not held to this (it is frozen with an English fallback),
 * and the other locales predate it. Provider and client pages have their own
 * check in src/lib/connect/translation-parity.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPED_LOCALES } from '../../i18n/locale-policy.mjs';

const MESSAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'messages');

function leaves(value, path = '', out = new Map()) {
  if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  } else out.set(path, value);
  return out;
}

const sorted = (xs) => [...xs].sort();
/** Top-level ICU argument names: `{name}` and `{count, plural, ...}`, not words inside branches. */
function args(message) {
  const names = [];
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    if (message[i] === '{') {
      if (depth === 0) names.push(message.slice(i + 1).match(/^\s*([A-Za-z_]\w*)/)?.[1]);
      depth++;
    } else if (message[i] === '}') depth--;
  }
  return sorted(names.filter(Boolean));
}
const tags = (s) => sorted(s.match(/<\/?[A-Za-z][\w-]*\s*\/?>/g) ?? []);

const namespaces = readdirSync(join(MESSAGES, 'en')).filter((f) => f.endsWith('.json'));

for (const locale of SCOPED_LOCALES) {
  test(`messages/${locale} has every English namespace`, () => {
    assert.deepEqual(sorted(readdirSync(join(MESSAGES, locale))), sorted(namespaces));
  });

  for (const file of namespaces) {
    test(`messages/${locale}/${file} mirrors messages/en/${file}`, () => {
      const en = leaves(JSON.parse(readFileSync(join(MESSAGES, 'en', file), 'utf8')));
      const tr = leaves(JSON.parse(readFileSync(join(MESSAGES, locale, file), 'utf8')));
      assert.deepEqual(sorted(tr.keys()), sorted(en.keys()), `${locale}/${file}: keys differ from English`);
      for (const [key, enValue] of en) {
        const value = tr.get(key);
        if (typeof enValue !== 'string') {
          assert.equal(value, enValue, `${locale}/${file} ${key}`);
          continue;
        }
        assert.equal(typeof value, 'string', `${locale}/${file} ${key} is not a string`);
        assert.ok(!/[—–―]/.test(value), `${locale}/${file} ${key} has an em or en dash`);
        // A dropped `{article, select, ...}` is fine where the language needs
        // no article choice; any other English argument must survive.
        const expected = args(enValue).filter((a) => a !== 'article');
        assert.deepEqual(args(value).filter((a) => a !== 'article'), expected, `${locale}/${file} ${key}: ICU arguments differ`);
        assert.deepEqual(tags(value), tags(enValue), `${locale}/${file} ${key}: tags differ`);
      }
    });
  }
}
