// The fonts the production build actually serves: which faces the stylesheets
// a page links make available, and what the family tokens resolve to in the
// CSS as shipped (after the bundler has had its way with it).
//
// On demand, with the same build requirement as visible-text.check.mjs
// (npm run check:built-output).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequired, buildUnavailableReason, startServer, fetchRoute,
} from './harness.mjs';
import {
  fontFaceRules, googleImportUrls, facesFromGoogleUrl, matrix, customProperties, resolveFamilies,
} from '../fonts/faces.mjs';

const unavailable = buildUnavailableReason();
const skip = unavailable && !buildRequired ? unavailable : false;

const FACES = {
  Geist: ['300 normal', '400 normal', '500 normal', '600 normal', '700 normal'],
  'Geist Mono': ['400 normal', '500 normal', '600 normal'],
  'Instrument Serif': ['400 italic', '400 normal'],
};
const WEBFONT_FAMILIES = Object.keys(FACES);

// One marketing page and one app-realm page: they link different stylesheets.
const PAGES = ['/', '/login'];

let server;
/** page -> { html, css: [{ href, text, response }] } */
const pages = new Map();

function stylesheetLinks(html) {
  return [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
    .map((tag) => /href="([^"]+)"/.exec(tag[0])?.[1])
    .filter(Boolean);
}

before(async () => {
  if (skip) return;
  if (unavailable) throw new Error(unavailable);
  server = await startServer();
  for (const page of PAGES) {
    const { html, status } = await fetchRoute(server.origin, page);
    assert.equal(status, 200, page);
    const css = [];
    for (const href of stylesheetLinks(html)) {
      const response = await fetch(new URL(href, server.origin), { signal: AbortSignal.timeout(30_000) });
      css.push({ href, text: await response.text(), response });
    }
    pages.set(page, { html, css, origin: server.origin });
  }
});

after(async () => {
  if (server) await server.stop();
});

/** Faces a page's stylesheets make available, from @font-face rules and Google imports alike. */
function availableFaces(page) {
  const faces = [];
  const displays = [];
  for (const { text } of pages.get(page).css) {
    for (const rule of fontFaceRules(text)) {
      faces.push(rule);
      if (WEBFONT_FAMILIES.includes(rule.family)) displays.push(rule.display);
    }
    for (const url of googleImportUrls(text)) {
      const parsed = facesFromGoogleUrl(url);
      faces.push(...parsed.faces);
      displays.push(parsed.display);
    }
  }
  return { faces, displays };
}

for (const page of PAGES) {
  test(`${page}: links at least one stylesheet, and each one loads`, { skip }, () => {
    const { css } = pages.get(page);
    assert.ok(css.length > 0);
    for (const sheet of css) assert.equal(sheet.response.status, 200, sheet.href);
  });

  test(`${page}: the three webfont families are available in exactly the pinned weights and styles`, { skip }, () => {
    const { faces } = availableFaces(page);
    const got = matrix(faces.filter((face) => WEBFONT_FAMILIES.includes(face.family)));
    assert.deepEqual(got, FACES);
  });

  test(`${page}: every webfont face uses font-display: swap`, { skip }, () => {
    const { displays } = availableFaces(page);
    assert.ok(displays.length > 0);
    for (const display of displays) assert.equal(display, 'swap');
  });

  test(`${page}: the family tokens in the shipped CSS resolve to the same stacks`, { skip }, () => {
    const properties = {};
    for (const { text } of pages.get(page).css) {
      for (const [name, values] of Object.entries(customProperties(text))) {
        if (!name.startsWith('--font-')) continue;
        // The same sheet can be linked by more than one chunk; identical
        // re-declarations are one declaration.
        properties[name] = [...new Set([...(properties[name] ?? []), ...values.map((v) => v.replace(/\s+/g, ' '))])];
      }
    }
    assert.deepEqual(resolveFamilies('var(--font-sans)', properties), ['Geist', 'ui-sans-serif', '-apple-system', 'Segoe UI', 'sans-serif']);
    assert.deepEqual(resolveFamilies('var(--font-mono)', properties), ['Geist Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace']);
    assert.deepEqual(resolveFamilies('var(--font-display)', properties), ['Instrument Serif', 'Iowan Old Style', 'Georgia', 'serif']);
  });
}
