/**
 * German (de) is the newest locale, and the one most likely to drift: a PR that
 * adds an English key and fills in nb, es and fr from habit can forget de, and
 * next-intl then renders the raw key path on /de in production. So every
 * messages/de namespace must carry exactly the English keys, the same ICU
 * arguments and the same tags, and no em dash.
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

test('messages/de has every English namespace', () => {
  assert.deepEqual(sorted(readdirSync(join(MESSAGES, 'de'))), sorted(namespaces));
});

for (const file of namespaces) {
  test(`messages/de/${file} mirrors messages/en/${file}`, () => {
    const en = leaves(JSON.parse(readFileSync(join(MESSAGES, 'en', file), 'utf8')));
    const de = leaves(JSON.parse(readFileSync(join(MESSAGES, 'de', file), 'utf8')));
    assert.deepEqual(sorted(de.keys()), sorted(en.keys()), `${file}: keys differ from English`);
    for (const [key, enValue] of en) {
      const value = de.get(key);
      if (typeof enValue !== 'string') {
        assert.equal(value, enValue, `${file} ${key}`);
        continue;
      }
      assert.equal(typeof value, 'string', `${file} ${key} is not a string`);
      assert.ok(!/[—–]/.test(value), `${file} ${key} has an em or en dash`);
      // A dropped `{article, select, ...}` is fine where German needs no
      // article choice; any other English argument must survive.
      const expected = args(enValue).filter((a) => a !== 'article');
      assert.deepEqual(args(value).filter((a) => a !== 'article'), expected, `${file} ${key}: ICU arguments differ`);
      assert.deepEqual(tags(value), tags(enValue), `${file} ${key}: tags differ`);
    }
  });
}
