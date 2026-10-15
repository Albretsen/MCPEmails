// Pins which font each text role resolves to, from the source alone: the three
// family tokens, the roles that use them, and the set of faces (family, weight,
// style) the site declares. Run: npm run test:fonts
//
// It reads declarations, not a browser, so it holds for any way of delivering
// the font files. What it cannot see (the files themselves, what a browser
// computes) is covered by scripts/built-output/fonts.check.mjs (on demand) and by the
// recorded browser measurements in scripts/built-output/fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declaredFaces, matrix, customProperties, resolveFamilies, ruleDeclarations, facesFromGoogleUrl, googleImportUrls,
  fontFaceRules, facesFromNextFontSource, unicodeIntervals, uncovered,
} from './faces.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stylesDir = path.join(webRoot, 'styles');
const css = (name) => readFileSync(path.join(stylesDir, name), 'utf8');
const sheets = readdirSync(stylesDir).filter((name) => name.endsWith('.css'));
const tokens = customProperties(css('colors_and_type.css'));

const SANS = ['Geist', 'ui-sans-serif', '-apple-system', 'Segoe UI', 'sans-serif'];
const MONO = ['Geist Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'];
const DISPLAY = ['Instrument Serif', 'Iowan Old Style', 'Georgia', 'serif'];

// The faces the Google Fonts import asked for, and so the faces every
// `font-weight` in the app is matched against. Discrete on purpose: the CSS
// uses in-between weights (550, 620, 650, 680, 750), which snap to the nearest
// declared face. A variable range would render them literally instead.
const FACES = {
  Geist: ['300 normal', '400 normal', '500 normal', '600 normal', '700 normal'],
  'Geist Mono': ['400 normal', '500 normal', '600 normal'],
  'Instrument Serif': ['400 italic', '400 normal'],
};

test('the three family tokens resolve to the same stacks', () => {
  assert.deepEqual(resolveFamilies('var(--font-sans)', tokens), SANS);
  assert.deepEqual(resolveFamilies('var(--font-mono)', tokens), MONO);
  assert.deepEqual(resolveFamilies('var(--font-display)', tokens), DISPLAY);
});

test('the family tokens are declared once, in colors_and_type.css, and nowhere else', () => {
  for (const name of sheets) {
    const declared = customProperties(css(name));
    for (const token of ['--font-sans', '--font-mono', '--font-display']) {
      const count = (declared[token] ?? []).length;
      assert.equal(count, name === 'colors_and_type.css' ? 1 : 0, `${token} in ${name}`);
    }
  }
});

test('body text: Geist stack', () => {
  const rule = ruleDeclarations(css('colors_and_type.css'), 'body');
  assert.deepEqual(resolveFamilies(rule['font-family'], tokens), SANS);
  assert.equal(rule['font-size'], 'var(--fs-16)');
});

test('headings: Geist stack at 600', () => {
  for (const selector of ['.t-display-lg', '.t-display-sm', '.t-h1', '.t-h2', '.t-h3', '.t-h4', '.t-h5']) {
    const rule = ruleDeclarations(css('colors_and_type.css'), selector);
    assert.deepEqual(resolveFamilies(rule['font-family'], tokens), SANS, selector);
    assert.equal(rule['font-weight'], '600', selector);
  }
});

test('body copy classes: Geist stack at 400, label at 500', () => {
  for (const selector of ['.t-lead', '.t-body', '.t-body-sm', '.t-caption']) {
    const rule = ruleDeclarations(css('colors_and_type.css'), selector);
    assert.deepEqual(resolveFamilies(rule['font-family'], tokens), SANS, selector);
    assert.equal(rule['font-weight'], '400', selector);
  }
  const label = ruleDeclarations(css('colors_and_type.css'), '.t-label');
  assert.deepEqual(resolveFamilies(label['font-family'], tokens), SANS);
  assert.equal(label['font-weight'], '500');
});

test('code and mono: Geist Mono stack', () => {
  for (const selector of ['.t-code', '.t-mono', '.t-code-inline']) {
    const rule = ruleDeclarations(css('colors_and_type.css'), selector);
    assert.deepEqual(resolveFamilies(rule['font-family'], tokens), MONO, selector);
  }
});

test('editorial accent: Instrument Serif stack, italic 400', () => {
  const rule = ruleDeclarations(css('colors_and_type.css'), '.t-display-italic');
  assert.deepEqual(resolveFamilies(rule['font-family'], tokens), DISPLAY);
  assert.equal(rule['font-style'], 'italic');
  assert.equal(rule['font-weight'], '400');
});

test('buttons: Geist stack at 500, on the marketing site and in the app', () => {
  for (const sheet of ['marketing.css', 'dashboard.css']) {
    const rule = ruleDeclarations(css(sheet), '.btn');
    assert.deepEqual(resolveFamilies(rule['font-family'], tokens), SANS, sheet);
    assert.equal(rule['font-weight'], '500', sheet);
  }
});

test('no stylesheet names a webfont family directly: every use goes through a token', () => {
  // If a rule said `font-family: "Geist"` itself, it would bypass the token and
  // its fallback stack, and nothing above would notice.
  for (const name of sheets) {
    const body = css(name).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of body.matchAll(/font(?:-family)?\s*:\s*([^;}]+)/g)) {
      assert.doesNotMatch(match[1], /Geist|Instrument Serif/, `${name}: ${match[0]}`);
    }
  }
});

test('the faces the source declares are exactly the pinned set, with font-display: swap', () => {
  const declared = declaredFaces(webRoot);
  assert.ok(declared.sources.length > 0, 'found no font declaration at all');
  assert.deepEqual(matrix(declared.faces), FACES);
  assert.ok(declared.displays.length > 0);
  for (const display of declared.displays) assert.equal(display, 'swap');
});

test('the pinned set is what Google served for the original import', () => {
  const fixture = JSON.parse(readFileSync(path.join(webRoot, 'scripts/fonts/fixtures/google-fonts-faces.json'), 'utf8'));
  assert.equal(fixture.faces.length, 47);
  assert.deepEqual(matrix(fixture.faces), FACES);
  for (const face of fixture.faces) assert.equal(face.display, 'swap');
});

test('parsers: css2 URL, @font-face, next/font call, unicode ranges', () => {
  const url = 'https://fonts.googleapis.com/css2?family=Geist:wght@300;400&family=Instrument+Serif:ital@0;1&family=Inter:ital,wght@0,100..900;1,400&display=swap';
  assert.deepEqual(googleImportUrls(`@import url("${url}");`), [url]);
  assert.deepEqual(matrix(facesFromGoogleUrl(url).faces), {
    Geist: ['300 normal', '400 normal'],
    'Instrument Serif': ['400 italic', '400 normal'],
    Inter: ['100 900 normal', '400 italic'],
  });
  assert.equal(facesFromGoogleUrl(url).display, 'swap');
  assert.deepEqual(
    fontFaceRules('@font-face{font-family:Geist Mono;font-style:normal;font-weight:500;font-display:swap;src:url(a.woff2)format("woff2");unicode-range:U+0-FF,U+131}'),
    [{ family: 'Geist Mono', weight: '500', style: 'normal', display: 'swap', unicodeRange: 'U+0-FF,U+131', src: 'url(a.woff2)format("woff2")' }],
  );
  const source = "import { Geist, Instrument_Serif } from 'next/font/google';\nconst a = Geist({ weight: ['400', '500'], subsets: ['latin'], display: 'swap' });\nconst b = Instrument_Serif({ weight: '400', style: ['normal', 'italic'] });\nconst c = Geist({ subsets: ['latin'] });\n";
  const parsed = facesFromNextFontSource(source);
  assert.deepEqual(matrix(parsed.filter((f) => !f.option)), {
    Geist: ['400 normal', '500 normal', 'variable normal'],
    'Instrument Serif': ['400 italic', '400 normal'],
  });
  assert.deepEqual(unicodeIntervals(['U+0-FF,U+131', 'U+100-130']), [[0, 0x131]]);
  assert.deepEqual(uncovered([[0, 0xff]], [[0, 0x7f], [0x90, 0xff]]), [[0x80, 0x8f]]);
  assert.deepEqual(uncovered([[0, 0xff]], [[0, 0x1ff]]), []);
});
