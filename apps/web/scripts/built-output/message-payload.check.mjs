// What the HTML carries in its serialised message payload, checked on the
// built output: a route's document contains the copy of the namespaces it is
// handed and none of the copy of the ones it is not.
//
// "Copy of a namespace" is a handful of sentinel strings taken from
// messages/en/<namespace>.json: long, plain-ASCII sentences that occur in that
// one namespace and nowhere else, so finding one in a document means that
// namespace's messages (or a page rendering them) are in it.
//
// On demand, with the same build requirement as visible-text.check.mjs
// (npm run check:built-output).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  webRoot, buildRequired, buildUnavailableReason, startServer, fetchRoute,
} from './harness.mjs';

const unavailable = buildUnavailableReason();
const skip = unavailable && !buildRequired ? unavailable : false;

const MARKETING = ['home', 'pricing', 'docs', 'privacy', 'terms', 'security', 'selfHosting', 'about', 'blog', 'compare', 'connect', 'forFounders'];

function leaves(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') for (const value of Object.values(node)) leaves(value, out);
  return out;
}

const dir = path.join(webRoot, 'messages/en');
const strings = Object.fromEntries(
  readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f.slice(0, -5), leaves(JSON.parse(readFileSync(path.join(dir, f), 'utf8')))]),
);

/** Up to five strings that identify one namespace and survive any escaping unchanged. */
function sentinels(namespace) {
  const elsewhere = new Set(Object.entries(strings).filter(([name]) => name !== namespace).flatMap(([, list]) => list));
  return strings[namespace]
    .filter((s) => s.length >= 40 && /^[A-Za-z0-9 ,.]+$/.test(s) && !elsewhere.has(s))
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
}

const present = (html, namespace) => sentinels(namespace).filter((s) => html.includes(s));

// route -> the marketing namespaces whose copy must NOT be in the document.
// Everything not listed for a route is either handed to it or rendered by it.
const ABSENT = {
  '/login': MARKETING,
  '/signup': MARKETING,
  '/authorize': MARKETING,
  '/forgot-password': MARKETING,
  '/this-page-does-not-exist': MARKETING,
  '/blog/this-post-does-not-exist': MARKETING.filter((n) => !['home', 'compare', 'blog'].includes(n)),
  '/': MARKETING.filter((n) => !['home', 'compare'].includes(n)),
  '/pricing': MARKETING.filter((n) => !['home', 'compare', 'pricing'].includes(n)),
  '/docs': MARKETING.filter((n) => !['home', 'compare', 'docs'].includes(n)),
  // Under the docs layout, so it carries `docs` although it does not read it.
  '/docs/claude': MARKETING.filter((n) => !['home', 'compare', 'docs'].includes(n)),
  '/for/founders': MARKETING.filter((n) => !['home', 'compare', 'forFounders'].includes(n)),
  '/privacy': MARKETING.filter((n) => !['home', 'compare', 'privacy'].includes(n)),
  '/connect/yahoo': MARKETING.filter((n) => !['home', 'compare', 'connect'].includes(n)),
};

// route -> namespaces whose copy must be there, so an "absent" result cannot
// come from sentinels that never match anything.
const PRESENT = {
  '/': ['home'],
  '/pricing': ['home', 'pricing'],
  '/docs': ['home', 'docs'],
  '/for/founders': ['home', 'forFounders'],
  '/privacy': ['home', 'privacy'],
};

// Raw HTML bytes. Before the narrowing every document was at least 203 KB,
// because it carried ~180 KB of messages. The ceilings sit well above today's
// sizes (login 27 KB, home 168 KB, pricing 101 KB) and well below the old ones
// (213 KB, 333 KB, 254 KB): they catch the catalogue coming back, not copy edits.
const MAX_BYTES = {
  '/login': 80_000,
  '/signup': 80_000,
  '/authorize': 80_000,
  '/this-page-does-not-exist': 80_000,
  '/': 240_000,
  '/pricing': 170_000,
  '/privacy': 190_000,
};

let server;
const responses = new Map();

before(async () => {
  if (skip) return;
  if (unavailable) throw new Error(unavailable);
  server = await startServer();
  for (const route of new Set([...Object.keys(ABSENT), ...Object.keys(PRESENT), ...Object.keys(MAX_BYTES)])) {
    responses.set(route, await fetchRoute(server.origin, route));
  }
});

after(async () => {
  if (server) await server.stop();
});

test('sentinels: every marketing namespace has strings that identify it', () => {
  for (const namespace of MARKETING) {
    assert.ok(sentinels(namespace).length >= 1, `no usable sentinel in messages/en/${namespace}.json`);
  }
});

for (const [route, namespaces] of Object.entries(ABSENT)) {
  test(`${route}: carries no copy from [${namespaces.length === MARKETING.length ? 'any marketing namespace' : namespaces}]`, { skip }, () => {
    const { html } = responses.get(route);
    for (const namespace of namespaces) {
      assert.deepEqual(present(html, namespace), [], `${namespace} copy found in ${route}`);
    }
  });
}

for (const [route, namespaces] of Object.entries(PRESENT)) {
  test(`${route}: still carries [${namespaces}]`, { skip }, () => {
    const { html } = responses.get(route);
    for (const namespace of namespaces) {
      assert.ok(present(html, namespace).length > 0, `no ${namespace} copy found in ${route}`);
    }
  });
}

for (const [route, limit] of Object.entries(MAX_BYTES)) {
  test(`${route}: HTML is under ${limit / 1000} KB`, { skip }, () => {
    const { rawBytes } = responses.get(route);
    assert.ok(rawBytes < limit, `${route} is ${rawBytes} bytes`);
  });
}
