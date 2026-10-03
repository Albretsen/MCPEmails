// What the production build sends for a representative set of routes, reduced
// to the text a visitor can read, compared against committed snapshots.
//
// The reason this exists: changes to HOW a page is delivered (which message
// namespaces are serialised into the HTML, how fonts are loaded) must not
// change WHAT it says. The snapshots exclude the serialised payload on
// purpose, so the payload can shrink while every rendered string stays pinned.
//
// Needs a production build made with the CI placeholder env:
//   cd apps/web && npm run build     (env as in .github/workflows/ci.yml)
//   npm run check:built-output
//
// ON DEMAND ONLY. This is deliberately not a `test:*` script, so neither
// `npm test` nor CI runs it, and the files are named *.check.mjs so the
// orphan check in scripts/run-tests.mjs does not take them for tests. Two
// reasons: it needs a build, which the unit-test job does not have; and any
// intended copy edit on a snapshotted route changes a snapshot, which must not
// be able to hold a production deploy. Run it before and after a change to how
// pages are delivered. Without a placeholder-env build it fails, it never
// skips.
//
// To re-record after an intended copy change:
//   UPDATE_BUILT_OUTPUT_SNAPSHOTS=1 npm run check:built-output

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  webRoot, buildRequired, buildUnavailableReason, startServer, fetchRoute, visibleText, untranslatedKeyLines, decodeEntities,
} from './harness.mjs';
import { ROUTES, snapshotName } from './routes.mjs';

const snapshotDir = path.join(webRoot, 'scripts/built-output/snapshots');
const updating = process.env.UPDATE_BUILT_OUTPUT_SNAPSHOTS === '1';
const unavailable = buildUnavailableReason();
const skip = unavailable && !buildRequired ? unavailable : false;

// Every namespace under messages/, so a key from the app realm is recognised too.
const NAMESPACES = readdirSync(path.join(webRoot, 'messages/en')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

let server;
const responses = new Map();

before(async () => {
  if (skip) {
    console.log(`\nSKIPPED built-output suite: ${skip}\n`);
    return;
  }
  if (unavailable) throw new Error(unavailable);
  server = await startServer();
  // Sequential on purpose: the placeholder Supabase host makes the home page
  // wait on a failing lookup, and parallel requests only queue behind it.
  for (const { route } of ROUTES) responses.set(route, await fetchRoute(server.origin, route));
});

after(async () => {
  if (server) await server.stop();
});

test('extraction: visible text drops scripts and styles, keeps text-bearing attributes', () => {
  const html = '<html><head><title>T &amp; t</title><meta name="description" content="D"/><style>.a{}</style>'
    + '<script>self.__next_f.push([1,"pricing.title secret"])</script><script type="application/ld+json">{"name":"N"}</script></head>'
    + '<body><h1>Hello<!-- --> <em>world</em></h1><img alt="Logo" src="x"/><input placeholder="you@example.com"/>'
    + '<button aria-label="Close" title="Close it">×</button></body></html>';
  assert.equal(
    visibleText(html),
    ['T & t', '[meta description] D', 'Hello', 'world', '[alt] Logo', '[placeholder] you@example.com', '[aria-label] Close', '[title] Close it', '×', '[json-ld] {"name":"N"}', ''].join('\n'),
  );
  assert.equal(decodeEntities('&#x27;a&#39; &lt;b&gt; &nbsp;'), "'a' <b>  ");
});

test('extraction: a rendered key path is recognised, real copy is not', () => {
  const text = ['pricing.hero.title', '[aria-label] home.nav.open', 'Read docs.mcpemails.com for more', 'docs', 'auth.login.title', 'server.json'].join('\n');
  assert.deepEqual(untranslatedKeyLines(text, NAMESPACES), ['pricing.hero.title', '[aria-label] home.nav.open', 'auth.login.title']);
});

for (const expected of ROUTES) {
  test(`${expected.route} answers ${expected.status}`, { skip }, () => {
    const got = responses.get(expected.route);
    assert.equal(got.status, expected.status);
    if (expected.location) assert.equal(new URL(got.location, 'http://x').pathname + new URL(got.location, 'http://x').search, expected.location);
  });

  if (expected.status >= 300 && expected.status < 400) continue;

  test(`${expected.route} renders no message key in place of its message`, { skip }, () => {
    const text = visibleText(responses.get(expected.route).html);
    assert.deepEqual(untranslatedKeyLines(text, NAMESPACES), []);
  });

  test(`${expected.route} visible text matches its snapshot`, { skip }, () => {
    const text = visibleText(responses.get(expected.route).html);
    const file = path.join(snapshotDir, snapshotName(expected.route));
    if (updating) {
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(file, text);
      return;
    }
    assert.ok(existsSync(file), `no snapshot for ${expected.route}; record one with UPDATE_BUILT_OUTPUT_SNAPSHOTS=1`);
    const want = readFileSync(file, 'utf8');
    if (text !== want) {
      const a = want.split('\n');
      const b = text.split('\n');
      const first = a.findIndex((line, i) => line !== b[i]);
      assert.fail(
        `${expected.route}: visible text changed (snapshot ${a.length} lines, now ${b.length}). First difference at line ${first + 1}:\n`
        + `  snapshot: ${JSON.stringify(a[first])}\n  now:      ${JSON.stringify(b[first])}`,
      );
    }
  });
}

test('every route has a snapshot and every snapshot has a route', { skip: skip || updating }, () => {
  const wanted = ROUTES.filter((r) => r.status < 300 || r.status >= 400).map((r) => snapshotName(r.route)).sort();
  assert.deepEqual(readdirSync(snapshotDir).sort(), wanted);
});

test('the snapshots are of real pages, not of error screens', { skip }, () => {
  // A page that 500s still has "visible text". Pin a phrase per realm so a
  // snapshot recorded from a broken build cannot pass for a good one.
  const text = (route) => visibleText(responses.get(route).html);
  assert.match(text('/'), /\[meta description\] /);
  assert.ok(text('/').split('\n').length > 150, 'home page text is suspiciously short');
  assert.ok(text('/docs').split('\n').length > 300, 'docs text is suspiciously short');
  assert.match(text('/login'), /\[placeholder\] /);
  assert.match(text('/this-page-does-not-exist'), /Page not found/);
  assert.match(text('/nb/blog/this-post-does-not-exist'), /Page not found/);
  for (const { route, status } of ROUTES) {
    // /auth/error is the one page whose own copy says "Something went wrong".
    if (status === 200 && route !== '/auth/error') assert.doesNotMatch(text(route), /Something went wrong|Critical error|Application error/, route);
  }
});
