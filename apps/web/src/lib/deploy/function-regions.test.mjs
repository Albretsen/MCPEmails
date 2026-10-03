// ---------------------------------------------------------------------------
// Where each server function runs, checked against a written-down decision.
//
// WHY THIS EXISTS. The Postgres + Auth project is in Stockholm (eu-north-1). A
// function in iad1 pays about 124 ms per database round trip, a function in
// arn1 about 10 ms. Some functions must nevertheless stay in iad1, above all
// the MCP proxy: the edge function it calls runs in the Supabase region
// nearest its caller, so moving the proxy would move every IMAP session away
// from the US mail hosts. Which function runs where is therefore a decision,
// and this test makes it impossible to add a route without making it.
//
// HOW THE REGION IS SET, and what this test therefore reads:
//
//   apps/web/vercel.json  `functions: { "<pattern>": { "regions": [...] } }`
//
// That is the ONLY mechanism that reaches a Node.js function on Vercel. The
// Next.js route segment export `preferredRegion` does not: Next writes it to
// .next/server/functions-config-manifest.json, and the Vercel builder
// (@vercel/next, getPageLambdaGroups) destructures `regions` out of that entry
// and throws it away for Node.js functions. It is honoured only for the edge
// runtime, and Next 16.3 deprecates it besides. So an export in a route file
// would look like a pin and do nothing; a check below refuses it.
//
// The builder resolves a function's options with
//
//   for (const [pattern, fn] of Object.entries(config.functions))
//     if (sourceFile === pattern || minimatch(sourceFile, pattern)) return fn
//
// i.e. FIRST match in file order wins, an exact path matches itself even when
// it contains [brackets], and a `**` never matches a path segment that starts
// with a dot (app/.well-known needs its own pattern). resolveRegion() below
// mirrors that for the small subset of glob syntax the config is allowed to
// use, and refuses any syntax outside that subset rather than guess.
//
// Verified against real build output on 2026-10-02 (Vercel CLI 54.6.1,
// @vercel/next 4.17.5): given a vercel.json with per-function regions, an
// offline `vercel build` writes "regions" into .vc-config.json for every one
// of the function sources exactly as this resolver predicts, and minimatch
// 10.1.1, the version that CLI resolves for the builder, agrees with
// compilePattern() on all of them (as does 3.1.5).
//
// Run: node --test src/lib/deploy/function-regions.test.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EVERY_FUNCTION_IS_PINNED,
  PATTERNS_ALLOWED_MAX_DURATION,
  PROJECT_DEFAULT_REGION,
  ROUTE_MAX_DURATIONS,
  ROUTES,
} from './function-regions.expected.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const APP_DIR = path.join(WEB_ROOT, 'app');
const VERCEL_JSON = path.join(WEB_ROOT, 'vercel.json');

/** The only regions a function here has a reason to be in. */
const KNOWN_REGIONS = ['iad1', 'arn1'];

/** vercel.json schema: `functions` has maxProperties 50. */
const MAX_FUNCTION_PATTERNS = 50;

/**
 * Files Next.js compiles into a server function: pages, route handlers and the
 * metadata routes. Layouts, loading/error boundaries and components are part
 * of a page's function, not functions of their own.
 */
const FUNCTION_SOURCE =
  /^(page|route|default|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.(js|jsx|ts|tsx|mjs)$/;

function listFunctionSources() {
  const found = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (FUNCTION_SOURCE.test(name)) found.push(path.relative(WEB_ROOT, full).split(path.sep).join('/'));
    }
  })(APP_DIR);
  return found.sort();
}

function readSource(file) {
  return readFileSync(path.join(WEB_ROOT, file), 'utf8');
}

function isEdgeRuntime(file) {
  return /^export\s+const\s+runtime\s*=\s*['"](edge|experimental-edge)['"]/m.test(readSource(file));
}

/** vercel.json, or null when the file does not exist. */
function readVercelConfig() {
  if (!existsSync(VERCEL_JSON)) return null;
  return JSON.parse(readFileSync(VERCEL_JSON, 'utf8'));
}

/** `functions` as [pattern, options] pairs, in file order (which is match order). */
function functionPatterns(config) {
  return Object.entries(config?.functions ?? {});
}

/**
 * Compile a `functions` pattern to a RegExp, for the subset of minimatch
 * syntax this config may use:
 *
 *   literal path segments    letters, digits, . _ - ( ) and simple [abc] groups
 *   *                        a whole segment: any one segment not starting with "."
 *   **                       a whole segment: zero or more segments, none starting with "."
 *
 * `[abc]` inside a literal segment is a character class to minimatch, so it is
 * compiled as one; a path that contains real brackets (app/[locale]/...) can
 * only be named by its exact path, which the caller checks by equality first.
 * Anything else (?, {}, !, extglobs, backslashes, a * inside a segment, nested
 * or dotted brackets) throws: a pattern this function cannot model must not be
 * guessed at.
 */
const ANY_SEGMENT = '(?!\\.)[^/]+';
const LITERAL_SEGMENT = /^(?:[A-Za-z0-9._()-]|\[[A-Za-z0-9_]+\])+$/;

export function compilePattern(pattern) {
  if (/[?{}!\\+@]/.test(pattern)) throw new Error(`Unsupported glob syntax in "${pattern}"`);
  const segments = pattern.split('/');
  let source = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      // Zero or more whole segments. As the final segment it has to consume
      // the rest of the path, which always has at least the file name left.
      source += last ? `${ANY_SEGMENT}(?:/${ANY_SEGMENT})*` : `(?:${ANY_SEGMENT}/)*`;
      return;
    }
    if (segment === '*') source += ANY_SEGMENT;
    else if (!LITERAL_SEGMENT.test(segment)) throw new Error(`Unsupported path segment "${segment}" in "${pattern}"`);
    // Escape the regex metacharacters a literal may contain. [ and ] are left
    // alone on purpose: they stay a character class, as they are to minimatch.
    else source += segment.replace(/[\\.()]/g, '\\$&');
    if (!last) source += '/';
  });
  return new RegExp(`^${source}$`);
}

/** Index of the first pattern that matches `file`, or -1. Mirrors getLambdaOptionsFromFunction. */
function firstMatch(file, patterns) {
  return patterns.findIndex(([pattern]) => file === pattern || compilePattern(pattern).test(file));
}

/**
 * Where `file` runs, and whether a vercel.json pattern put it there.
 * Edge-runtime functions take no region from vercel.json at all.
 */
function resolveRegion(file, patterns) {
  if (isEdgeRuntime(file)) return { region: 'edge', pinned: false, pattern: null };
  const index = firstMatch(file, patterns);
  if (index === -1) return { region: PROJECT_DEFAULT_REGION, pinned: false, pattern: null };
  const [pattern, options] = patterns[index];
  const regions = options?.regions;
  if (!Array.isArray(regions) || regions.length !== 1) {
    throw new Error(`vercel.json functions["${pattern}"] must name exactly one region`);
  }
  return { region: regions[0], pinned: true, pattern };
}

const sources = listFunctionSources();
const config = readVercelConfig();
const patterns = functionPatterns(config);
const expected = new Map(ROUTES.map(([file, region]) => [file, region]));

test('every function source under app/ has a region decision, and every decision has a file', () => {
  const undecided = sources.filter((file) => !expected.has(file));
  const stale = [...expected.keys()].filter((file) => !sources.includes(file));
  assert.deepEqual(
    undecided,
    [],
    `No region decision for: ${undecided.join(', ')}. Add a row to function-regions.expected.mjs ` +
      `saying where it should run and why, and make apps/web/vercel.json agree.`,
  );
  assert.deepEqual(stale, [], `Rows for files that no longer exist: ${stale.join(', ')}`);
});

test('the decision table is well formed', () => {
  assert.ok(sources.length > 100, `expected to find the app's routes, found ${sources.length}`);
  assert.equal(new Set(ROUTES.map(([file]) => file)).size, ROUTES.length, 'duplicate rows');
  for (const row of ROUTES) {
    assert.equal(row.length, 4, `row must be [file, region, database round trips, other calls]: ${row[0]}`);
    const [file, region, database, other] = row;
    assert.ok([...KNOWN_REGIONS, 'edge'].includes(region), `${file}: unknown region "${region}"`);
    assert.ok(typeof database === 'string' && database.length > 0, `${file}: database round trips missing`);
    assert.ok(typeof other === 'string' && other.length > 0, `${file}: other network calls missing ("-" for none)`);
  }
  assert.ok(KNOWN_REGIONS.includes(PROJECT_DEFAULT_REGION));
});

test('every function resolves to the region its decision names', () => {
  const wrong = [];
  for (const file of sources) {
    if (!expected.has(file)) continue; // reported by the first test
    const actual = resolveRegion(file, patterns);
    if (actual.region !== expected.get(file)) {
      wrong.push(`${file}: decided ${expected.get(file)}, resolves to ${actual.region}` +
        (actual.pattern ? ` via "${actual.pattern}"` : ' via the project default'));
    }
  }
  assert.deepEqual(wrong, []);
});

test('functions are pinned by a pattern, or none is: never a mixture', () => {
  const nodeFunctions = sources.filter((file) => !isEdgeRuntime(file));
  const pinned = nodeFunctions.filter((file) => resolveRegion(file, patterns).pinned);
  if (EVERY_FUNCTION_IS_PINNED) {
    const unpinned = nodeFunctions.filter((file) => !pinned.includes(file));
    assert.deepEqual(
      unpinned,
      [],
      `These run wherever the Vercel project default points, and would move if it changed: ${unpinned.join(', ')}`,
    );
  } else {
    assert.deepEqual(pinned, [], 'the table says nothing is pinned, but vercel.json pins these');
  }
});

test('vercel.json region config stays inside what this test can model', () => {
  if (config === null) {
    assert.equal(EVERY_FUNCTION_IS_PINNED, false, 'vercel.json is missing but the table says every function is pinned');
    return;
  }
  // This file exists to set function regions and must do nothing else. Until
  // it was added the project had no vercel.json at all, so ANY other top-level
  // key (trailingSlash, cleanUrls, crons, headers, redirects, rewrites, ...)
  // is new platform behaviour arriving through a file whose only reviewer is
  // this test. Headers and redirects live in next.config.js.
  assert.deepEqual(
    Object.keys(config).sort(),
    ['$schema', 'functions'],
    'apps/web/vercel.json may contain only "$schema" and "functions"',
  );
  // A top-level `regions` overrides the project's Function Region setting for
  // every unmatched function, which would make PROJECT_DEFAULT_REGION a lie.
  assert.equal(config.regions, undefined, 'top-level "regions" is not allowed; pin per function');
  assert.equal(config.functionFailoverRegions, undefined);
  assert.ok(patterns.length <= MAX_FUNCTION_PATTERNS, `vercel.json allows at most ${MAX_FUNCTION_PATTERNS} function patterns`);

  patterns.forEach(([pattern, options], index) => {
    assert.ok(pattern.startsWith('app/'), `"${pattern}" must name files under app/`);
    assert.doesNotThrow(() => compilePattern(pattern), `"${pattern}"`);
    // Regions only. maxDuration lives next to the handler as a route segment
    // export (see app/api/mcp/route.ts); two places to set it is one too many.
    // PATTERNS_ALLOWED_MAX_DURATION is the pinned set of entries that may also
    // carry one, and it is empty.
    const allowedKeys = PATTERNS_ALLOWED_MAX_DURATION.includes(pattern) ? ['maxDuration', 'regions'] : ['regions'];
    for (const key of Object.keys(options)) {
      assert.ok(allowedKeys.includes(key), `functions["${pattern}"] may not set "${key}"`);
    }
    assert.ok('regions' in options, `functions["${pattern}"] must set "regions"`);
    assert.ok(Array.isArray(options.regions) && options.regions.length === 1, `functions["${pattern}"] must name exactly one region`);
    assert.ok(KNOWN_REGIONS.includes(options.regions[0]), `functions["${pattern}"]: unknown region "${options.regions[0]}"`);
    // A pattern that is never the first match for anything is dead, or is
    // shadowed by an earlier one, which usually means the order is wrong.
    const decides = sources.filter((file) => firstMatch(file, patterns) === index);
    assert.ok(decides.length > 0, `functions["${pattern}"] decides no function (dead, or shadowed by an earlier pattern)`);
  });

  // The proxy (proxy.ts, the former middleware) is not under app/ and must not
  // be given a region: it runs before routing, at the edge location nearest
  // the visitor.
  assert.equal(firstMatch('proxy.ts', patterns), -1);
});

test('no route uses the preferredRegion export', () => {
  // It does nothing for a Node.js function on Vercel (see the header) and is
  // deprecated in Next 16.3. A route that exported it would look pinned to a
  // reader and to nothing else.
  const offenders = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|jsx|ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) {
        if (/^export\s+const\s+preferredRegion\b/m.test(readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(WEB_ROOT, full));
        }
      }
    }
  })(APP_DIR);
  assert.deepEqual(offenders, [], 'set the region in apps/web/vercel.json instead');
});

test('the function durations set next to the handlers are the pinned set', () => {
  // The builder merges a vercel.json entry with the route's own segment config
  // into one function. Region config must never cost a route its duration, so
  // the set that exists today is pinned: a route gaining, losing or changing
  // `export const maxDuration` has to be written down here as well.
  const found = {};
  for (const file of sources) {
    const match = /^export\s+const\s+maxDuration\s*=\s*(\d+)\s*;?\s*$/m.exec(readSource(file));
    if (match) found[file] = Number(match[1]);
  }
  assert.deepEqual(found, ROUTE_MAX_DURATIONS);
  for (const pattern of PATTERNS_ALLOWED_MAX_DURATION) {
    assert.ok(patterns.some(([candidate]) => candidate === pattern), `"${pattern}" is not a vercel.json pattern`);
  }
});

test('there is no second place a server function could come from', () => {
  // This test walks app/ and nothing else. A pages/ directory (API routes,
  // getServerSideProps pages) or a src/app tree would build functions it
  // cannot see, and they would run in the project default region unreviewed.
  for (const dir of ['pages', 'src/pages', 'src/app', 'api']) {
    assert.ok(!existsSync(path.join(WEB_ROOT, dir)), `apps/web/${dir} exists: its functions are invisible to the region test`);
  }
});

test('the pattern matcher behaves like the builder (minimatch) for the syntax in use', () => {
  const matches = (file, pattern) => file === pattern || compilePattern(pattern).test(file);

  // ** spans any depth, including bracketed and parenthesised segments.
  assert.ok(matches('app/api/mcp/route.ts', 'app/api/**'));
  assert.ok(matches('app/api/inboxes/[id]/check/route.ts', 'app/api/**'));
  assert.ok(matches('app/api/[[...unmatched]]/route.ts', 'app/api/**'));
  assert.ok(matches('app/(auth)/login/page.js', 'app/(auth)/**'));
  assert.ok(matches('app/[locale]/page.tsx', 'app/**'));
  assert.ok(matches('app/sitemap.ts', 'app/**'));
  assert.ok(matches('app/a/b/c/page.js', 'app/**/page.js'));
  assert.ok(matches('app/page.js', 'app/**/page.js'));

  // ...but never into a dot-directory: .well-known needs its own pattern.
  assert.ok(!matches('app/.well-known/security.txt/route.ts', 'app/**'));
  assert.ok(matches('app/.well-known/security.txt/route.ts', 'app/.well-known/**'));

  // A pattern is anchored at both ends and does not match a sibling prefix.
  assert.ok(!matches('app/apiary/route.ts', 'app/api/**'));
  assert.ok(!matches('app/api', 'app/api/**'));
  assert.ok(!matches('src/app/api/x/route.ts', 'app/api/**'));
  assert.ok(!matches('proxy.ts', 'app/**'));

  // An exact path matches itself even though [id] is a character class to a
  // glob; as a glob it would only match a one-letter directory.
  assert.ok(matches('app/api/inboxes/[id]/check/route.ts', 'app/api/inboxes/[id]/check/route.ts'));
  assert.ok(matches('app/api/inboxes/d/check/route.ts', 'app/api/inboxes/[id]/check/route.ts'));
  assert.ok(!matches('app/api/inboxes/[id]/route.ts', 'app/api/inboxes/[id]/check/route.ts'));

  // * is one whole segment.
  assert.ok(matches('app/auth/google/route.ts', 'app/auth/*/route.ts'));
  assert.ok(!matches('app/auth/gmail/callback/route.ts', 'app/auth/*/route.ts'));

  // Syntax outside the modelled subset is refused, not guessed at.
  for (const unsupported of ['app/{a,b}/**', 'app/a?/**', 'app/!(x)/**', 'app/api/*.ts', 'app/\\[locale\\]/**']) {
    assert.throws(() => compilePattern(unsupported), unsupported);
  }
});
