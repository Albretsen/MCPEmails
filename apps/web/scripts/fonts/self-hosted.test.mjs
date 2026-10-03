// The committed webfont files and their @font-face rules: the rules are
// exactly the ones Google served (same families, weights, styles, display and
// unicode-range values, in the same order), every rule points at a file that
// is in the repo, and nothing here needs the network. Run: npm run test:fonts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fontFaceRules } from './faces.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fontsDir = path.join(webRoot, 'fonts');
const css = readFileSync(path.join(fontsDir, 'fonts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = fontFaceRules(css);
const google = JSON.parse(readFileSync(path.join(webRoot, 'scripts/fonts/fixtures/google-fonts-faces.json'), 'utf8')).faces;
const fileOf = (rule) => /^url\("\.\/([a-z0-9-]+\.woff2)"\) format\('woff2'\)$/.exec(rule.src)?.[1];

test('fonts.css declares the same 47 faces Google served, descriptor for descriptor, in the same order', () => {
  assert.equal(rules.length, 47);
  assert.deepEqual(rules.map(({ src, ...rest }) => rest), google);
});

test('every rule loads a woff2 file committed next to fonts.css, and every committed file is used', () => {
  const used = new Set();
  for (const rule of rules) {
    const file = fileOf(rule);
    assert.ok(file, `not a local woff2 reference: ${rule.src}`);
    assert.ok(existsSync(path.join(fontsDir, file)), `${file} is missing`);
    used.add(file);
  }
  const committed = readdirSync(fontsDir).filter((name) => name.endsWith('.woff2')).sort();
  assert.deepEqual([...used].sort(), committed);
  assert.equal(committed.length, 15);
});

test('one file per family, style and subset: all weights of a variable family share it', () => {
  const byFile = new Map();
  for (const rule of rules) {
    const key = `${rule.family}|${rule.style}|${rule.unicodeRange}`;
    const file = fileOf(rule);
    if (byFile.has(key)) assert.equal(byFile.get(key), file, key);
    byFile.set(key, file);
  }
  assert.equal(new Set(byFile.values()).size, 15);
});

test('the files are the ones recorded in fonts/README.md, byte for byte', () => {
  const readme = readFileSync(path.join(fontsDir, 'README.md'), 'utf8');
  const recorded = new Map([...readme.matchAll(/\| `([a-z0-9-]+\.woff2)` \|[^\n]*?\| `([0-9a-f]{64})` \|/g)].map((m) => [m[1], m[2]]));
  assert.equal(recorded.size, 15);
  for (const [file, sha] of recorded) {
    const actual = createHash('sha256').update(readFileSync(path.join(fontsDir, file))).digest('hex');
    assert.equal(actual, sha, file);
  }
});

test('the SIL Open Font License text for each family sits next to the files', () => {
  for (const [file, holder] of [
    ['OFL-Geist.txt', 'The Geist Project Authors'],
    ['OFL-Geist-Mono.txt', 'The Geist Project Authors'],
    ['OFL-Instrument-Serif.txt', 'The Instrument Serif Project Authors'],
  ]) {
    const text = readFileSync(path.join(fontsDir, file), 'utf8');
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.ok(text.includes(holder), `${file} does not name ${holder}`);
  }
});

test('nothing in the app source loads a font from the network at build time or run time', () => {
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name === 'node_modules' || name.name.startsWith('.')) continue;
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full, out);
      else if (/\.(js|jsx|ts|tsx|mjs|css)$/.test(name.name) && !/\.test\.[a-z]+$/.test(name.name)) out.push(full);
    }
    return out;
  };
  for (const dir of ['app', 'components', 'src', 'styles', 'fonts']) {
    for (const file of walk(path.join(webRoot, dir))) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /from\s+['"]next\/font\/google['"]/, `${path.relative(webRoot, file)} imports next/font/google`);
      assert.doesNotMatch(source, /@import\s+(?:url\()?\s*["']?https?:/, `${path.relative(webRoot, file)} imports a remote stylesheet`);
      assert.doesNotMatch(source, /url\(\s*["']?https?:\/\/fonts\./, `${path.relative(webRoot, file)} loads a remote font`);
    }
  }
});
