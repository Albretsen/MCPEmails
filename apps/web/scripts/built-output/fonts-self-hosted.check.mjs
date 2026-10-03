// The webfonts are served by this app, not by Google: same-origin files with
// immutable caching, one preload, no request to fonts.googleapis.com or
// fonts.gstatic.com, and no less glyph coverage than Google's own CSS offered.
//
// On demand, with the same build requirement as visible-text.check.mjs
// (npm run check:built-output).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  webRoot, buildRequired, buildUnavailableReason, startServer, fetchPageWithCss, linkHeaderEntries,
} from './harness.mjs';
import { fontFaceRules, unicodeIntervals, uncovered } from '../fonts/faces.mjs';

const unavailable = buildUnavailableReason();
const skip = unavailable && !buildRequired ? unavailable : false;

const WEBFONT_FAMILIES = ['Geist', 'Geist Mono', 'Instrument Serif'];
// Two marketing pages, an app-realm page, and the not-found screen.
const PAGES = ['/', '/zh', '/login', '/this-page-does-not-exist'];
const googleFixture = JSON.parse(readFileSync(path.join(webRoot, 'scripts/fonts/fixtures/google-fonts-faces.json'), 'utf8'));

let server;
const pages = new Map();
const fontFiles = new Map(); // url path -> Response

const srcUrl = (rule) => /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(rule.src)?.[1];

before(async () => {
  if (skip) return;
  if (unavailable) throw new Error(unavailable);
  server = await startServer();
  for (const route of PAGES) pages.set(route, await fetchPageWithCss(server.origin, route));
  for (const page of pages.values()) {
    for (const sheet of page.css) {
      for (const rule of fontFaceRules(sheet.text)) {
        if (!WEBFONT_FAMILIES.includes(rule.family)) continue;
        const resolved = new URL(srcUrl(rule), new URL(sheet.href, server.origin));
        if (resolved.origin !== server.origin || fontFiles.has(resolved.pathname)) continue;
        fontFiles.set(resolved.pathname, await fetch(resolved, { signal: AbortSignal.timeout(30_000) }));
      }
    }
  }
});

after(async () => {
  if (server) await server.stop();
});

function webfontRules(route) {
  const seen = new Set();
  const rules = [];
  for (const sheet of pages.get(route).css) {
    for (const rule of fontFaceRules(sheet.text)) {
      if (!WEBFONT_FAMILIES.includes(rule.family)) continue;
      // The same stylesheet content can be linked from more than one chunk.
      const id = [rule.family, rule.weight, rule.style, rule.unicodeRange, rule.src].join('|');
      if (seen.has(id)) continue;
      seen.add(id);
      rules.push({ ...rule, sheet: sheet.href });
    }
  }
  return rules;
}

test('source: no stylesheet imports anything from another origin', () => {
  const dir = path.join(webRoot, 'styles');
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.css'))) {
    const body = readFileSync(path.join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(body, /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//, name);
  }
});

for (const route of PAGES) {
  test(`${route}: nothing in the document or its CSS loads from Google Fonts`, { skip }, () => {
    const page = pages.get(route);
    for (const tag of page.html.matchAll(/<link\b[^>]*>/g)) {
      assert.doesNotMatch(tag[0], /fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
    for (const sheet of page.css) {
      assert.doesNotMatch(sheet.text, /fonts\.googleapis\.com|fonts\.gstatic\.com/, sheet.href);
      assert.doesNotMatch(sheet.text, /@import/, `${sheet.href} still has an @import`);
    }
  });

  test(`${route}: every webfont face points at a same-origin file under /_next/static/media`, { skip }, () => {
    const rules = webfontRules(route);
    assert.equal(rules.length, googleFixture.faces.length);
    for (const rule of rules) {
      const resolved = new URL(srcUrl(rule), new URL(rule.sheet, server.origin));
      assert.equal(resolved.origin, server.origin, rule.src);
      assert.match(resolved.pathname, /^\/_next\/static\/media\/[^/]+\.woff2$/);
      assert.match(rule.src, /format\(["']woff2["']\)/);
    }
  });

  test(`${route}: glyph coverage per family, weight and style is at least what Google's CSS offered`, { skip }, () => {
    const rules = webfontRules(route);
    const key = (face) => `${face.family} ${face.weight} ${face.style}`;
    const wanted = new Map();
    for (const face of googleFixture.faces) wanted.set(key(face), [...(wanted.get(key(face)) ?? []), face.unicodeRange]);
    assert.equal(wanted.size, 10);
    for (const [face, ranges] of wanted) {
      const have = rules.filter((rule) => key(rule) === face).map((rule) => rule.unicodeRange);
      const missing = uncovered(unicodeIntervals(ranges), unicodeIntervals(have));
      assert.deepEqual(missing, [], `${face} lost code points`);
    }
  });

  test(`${route}: preloads exactly one font, the Geist latin file`, { skip }, () => {
    const page = pages.get(route);
    // Next announces the preload in the Link response header, which reaches
    // the browser before the first byte of HTML; a <link> tag would do too.
    const fromTags = [...page.html.matchAll(/<link\b[^>]*rel="preload"[^>]*>/g)].map((m) => m[0]).filter((tag) => /as="font"/.test(tag))
      .map((tag) => ({ href: /href="([^"]+)"/.exec(tag)?.[1], type: /type="([^"]+)"/.exec(tag)?.[1], crossorigin: /\scrossorigin/i.test(tag) }));
    const fromHeader = linkHeaderEntries(page.headers).filter((entry) => entry.rel === 'preload' && entry.as === 'font');
    const preloads = [...fromTags, ...fromHeader];
    assert.equal(preloads.length, 1, JSON.stringify(preloads));
    const [{ href, type, crossorigin }] = preloads;
    assert.equal(type, 'font/woff2');
    // Fonts are always fetched in CORS mode; a preload without crossorigin is
    // fetched a second time.
    assert.equal(crossorigin, true);
    const latin = webfontRules(route).filter((rule) => rule.family === 'Geist' && uncovered([[0x41, 0x5a]], unicodeIntervals([rule.unicodeRange])).length === 0);
    assert.equal(latin.length, 5, 'expected one latin face per Geist weight');
    for (const rule of latin) {
      assert.equal(new URL(srcUrl(rule), new URL(rule.sheet, server.origin)).pathname, new URL(href, server.origin).pathname);
    }
  });

  test(`${route}: the metric-adjusted "Fallback" faces next/font generates are never used`, { skip }, () => {
    // They exist in the CSS, but only a rule that names one in a font-family
    // can bring it into a stack. The only such rules are next/font's own
    // generated classes, which the app does not apply to any element.
    const page = pages.get(route);
    for (const sheet of page.css) {
      const withoutFaces = sheet.text.replace(/@font-face\s*\{[^}]*\}/g, '');
      for (const match of withoutFaces.matchAll(/([^{}]+)\{([^{}]*Fallback[^{}]*)\}/g)) {
        const classes = [...match[1].matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
        assert.ok(classes.length > 0, `a non-class rule references a Fallback face: ${match[0]}`);
        for (const name of classes) {
          assert.match(name, /module__.*__(className|variable)$/, `unexpected rule references a Fallback face: ${match[0]}`);
          assert.ok(!page.html.includes(name), `${name} is applied in the document`);
        }
      }
    }
  });
}

test('font files: served as woff2 with a one-year immutable cache', { skip }, () => {
  // 15 files: 5 Geist subsets, 6 Geist Mono subsets, 2 x 2 Instrument Serif.
  assert.ok(fontFiles.size >= 15, `only ${fontFiles.size} font files found`);
  for (const [pathname, response] of fontFiles) {
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('content-type'), 'font/woff2', pathname);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', pathname);
  }
});
