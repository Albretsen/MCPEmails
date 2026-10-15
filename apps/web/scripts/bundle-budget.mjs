#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `npm run bundle:budget`: how much JavaScript each page makes a browser
// download before it can do anything, held to a ceiling.
//
// Run AFTER `npm run build`. It reads the build's own manifests; it does not
// build, and it exits 1 with a clear message if there is no build to read.
//
// WHAT "FIRST-LOAD JS" MEANS HERE. For one route, the set of script files the
// document loads up front: the framework's root files (`rootMainFiles` in
// .next/build-manifest.json) plus every file listed for the route's layouts and
// page under `entryJSFiles` in its `page_client-reference-manifest.js`. A chunk
// fetched later by an `import()` is, by construction, not in that set, which is
// the whole point of measuring it. Sizes are reported three ways: raw bytes on
// disk, gzip and brotli (Node's defaults, which is close to what a CDN serves).
//
// WHAT IT CHECKS, from scripts/bundle-budget.json:
//   - `ceiling`: a route's first-load JS may not exceed its recorded raw, gzip
//     and brotli sizes by more than `tolerance`. The tolerance exists because a
//     build is not byte-reproducible across machines: public env values are
//     inlined, and compressor output shifts a little between Node versions.
//   - `absent`: named libraries that must NOT be in a route's first-load set.
//     A size ceiling alone would let a 250 KB library come back as long as
//     something else of the same size left. Each library is recognised by a
//     string that survives minification (see FINGERPRINTS), and the check first
//     proves that string still exists SOMEWHERE in the build, so a fingerprint
//     that has rotted fails loudly instead of passing forever.
//
// `--write` records the current sizes as the new ceilings (and keeps every
// `absent` list as it is). Lowering a ceiling after a real reduction is the
// intended use; raising one should be a decision somebody can point to.
// `--json` prints the measurements as JSON.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nextDir = path.join(webRoot, '.next');
const budgetPath = path.join(webRoot, 'scripts', 'bundle-budget.json');

/**
 * The routes that are measured, by the key Next gives them in the client
 * reference manifest. One per distinct shape of page: the dashboard, each kind
 * of auth screen, the consent and approval screens, and three marketing pages.
 */
export const ROUTES = {
  dashboard: '/dashboard/[[...section]]/page',
  login: '/(auth)/login/page',
  signup: '/signup/page',
  'forgot-password': '/(auth)/forgot-password/page',
  'reset-password': '/(auth)/reset-password/page',
  authorize: '/authorize/page',
  approvals: '/approvals/[id]/page',
  invite: '/invite/[token]/page',
  pricing: '/[locale]/pricing/page',
  home: '/[locale]/page',
  docs: '/[locale]/docs/page',
};

/** One long sentence per language that exists only in that language's catalog. */
function catalogSentence(locale) {
  const file = path.join(webRoot, 'messages', locale, 'dashboard.json');
  return JSON.parse(readFileSync(file, 'utf8')).inboxes.detail.signature.importedHint;
}

/**
 * A string that identifies a library inside minified output. Each was checked
 * against a real build: it appears in the chunk that holds the library and in
 * no other first-load chunk.
 */
export const FINGERPRINTS = {
  // prosemirror-view's CSS class names, which TipTap cannot run without.
  tiptap: () => 'ProseMirror-',
  dompurify: () => 'DOMPurify',
  // The auth client class at the centre of supabase-js.
  'supabase-js': () => 'GoTrueClient',
  'catalog-en': () => catalogSentence('en'),
  'catalog-nb': () => catalogSentence('nb'),
  'catalog-es': () => catalogSentence('es'),
  'catalog-fr': () => catalogSentence('fr'),
  'catalog-zh': () => catalogSentence('zh'),
};

/** True when `source` holds `needle`, as written or as a JS string escape of it. */
function holds(source, needle) {
  if (source.includes(needle)) return true;
  const escaped = JSON.stringify(needle).slice(1, -1);
  if (escaped !== needle && source.includes(escaped)) return true;
  // Bundlers may also write non-ASCII as \uXXXX inside an otherwise plain string.
  const ascii = needle.replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return ascii !== needle && source.includes(ascii);
}

function loadManifest(file) {
  const scope = {};
  // The manifest is a script that assigns onto globalThis.__RSC_MANIFEST.
  new Function('globalThis', readFileSync(file, 'utf8'))(scope);
  return scope.__RSC_MANIFEST ?? {};
}

function findManifests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findManifests(full, out);
    else if (entry.name.endsWith('_client-reference-manifest.js')) out.push(full);
  }
  return out;
}

/** Reads the build and returns { routes: {name: measurement}, everywhere: Set<fingerprint> }. */
export function measure() {
  if (!existsSync(path.join(nextDir, 'build-manifest.json'))) {
    throw new Error('No build found at apps/web/.next. Run `npm run build` first, then `npm run bundle:budget`.');
  }
  const build = JSON.parse(readFileSync(path.join(nextDir, 'build-manifest.json'), 'utf8'));
  const manifests = {};
  for (const file of findManifests(path.join(nextDir, 'server', 'app'))) Object.assign(manifests, loadManifest(file));

  const needles = Object.fromEntries(Object.entries(FINGERPRINTS).map(([name, get]) => [name, get()]));
  const fileCache = new Map();
  const read = (rel) => {
    if (!fileCache.has(rel)) {
      const bytes = readFileSync(path.join(nextDir, rel));
      const source = bytes.toString('utf8');
      fileCache.set(rel, {
        raw: bytes.length,
        gzip: gzipSync(bytes).length,
        brotli: brotliCompressSync(bytes).length,
        contains: Object.keys(needles).filter((name) => holds(source, needles[name])),
      });
    }
    return fileCache.get(rel);
  };

  const routes = {};
  for (const [name, key] of Object.entries(ROUTES)) {
    const manifest = manifests[key];
    if (!manifest) throw new Error(`Route ${key} is not in the build. Was it renamed? Update ROUTES in scripts/bundle-budget.mjs.`);
    const files = new Set(build.rootMainFiles);
    for (const list of Object.values(manifest.entryJSFiles ?? {})) for (const file of list) files.add(file);
    const scripts = [...files].filter((f) => f.endsWith('.js'));
    const total = { raw: 0, gzip: 0, brotli: 0 };
    const contains = new Set();
    const chunks = [];
    for (const rel of scripts) {
      const info = read(rel);
      total.raw += info.raw;
      total.gzip += info.gzip;
      total.brotli += info.brotli;
      for (const name of info.contains) contains.add(name);
      chunks.push({ file: path.basename(rel), raw: info.raw, gzip: info.gzip, brotli: info.brotli, contains: info.contains });
    }
    routes[name] = { key, files: scripts.length, ...total, contains: [...contains].sort(), chunks };
  }

  // Every script the build emitted, first-load or not: where a fingerprint
  // must still be found for an `absent` check to mean anything.
  const everywhere = new Set();
  const staticChunks = path.join(nextDir, 'static', 'chunks');
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) for (const name of read(path.relative(nextDir, full)).contains) everywhere.add(name);
    }
  };
  walk(staticChunks);

  return { routes, everywhere };
}

/** Compares a measurement to the recorded budget. Returns a list of failures. */
export function check(measured, budget) {
  const failures = [];
  const tolerance = budget.tolerance ?? 0;
  for (const [name, limits] of Object.entries(budget.routes)) {
    const got = measured.routes[name];
    if (!got) { failures.push(`${name}: in the budget but not measured`); continue; }
    for (const metric of ['raw', 'gzip', 'brotli']) {
      const ceiling = limits.ceiling[metric];
      const allowed = Math.floor(ceiling * (1 + tolerance));
      if (got[metric] > allowed) {
        failures.push(`${name}: ${metric} first-load JS is ${got[metric]} bytes, over the ceiling of ${ceiling} (+${(tolerance * 100).toFixed(1)}% = ${allowed}) by ${got[metric] - allowed}`);
      }
    }
    for (const library of limits.absent ?? []) {
      if (!(library in FINGERPRINTS)) { failures.push(`${name}: "${library}" has no fingerprint in scripts/bundle-budget.mjs`); continue; }
      if (!measured.everywhere.has(library)) {
        failures.push(`${name}: the fingerprint for "${library}" is in no chunk of this build at all, so its absence from first load proves nothing. Fix the fingerprint.`);
      } else if (got.contains.includes(library)) {
        const where = got.chunks.filter((c) => c.contains.includes(library)).map((c) => c.file).join(', ');
        failures.push(`${name}: "${library}" is back in first-load JS (${where})`);
      }
    }
  }
  for (const name of Object.keys(measured.routes)) {
    if (!budget.routes[name]) failures.push(`${name}: measured but has no budget. Run with --write to record one.`);
  }
  return failures;
}

const kb = (bytes) => (bytes / 1024).toFixed(1).padStart(8);

function main() {
  const args = new Set(process.argv.slice(2));
  let measured;
  try {
    measured = measure();
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(1);
  }

  if (args.has('--json')) {
    console.log(JSON.stringify(measured.routes, null, 2));
    return;
  }

  const budget = existsSync(budgetPath)
    ? JSON.parse(readFileSync(budgetPath, 'utf8'))
    : { tolerance: 0.005, routes: {} };

  if (args.has('--write')) {
    for (const [name, got] of Object.entries(measured.routes)) {
      budget.routes[name] = {
        ceiling: { raw: got.raw, gzip: got.gzip, brotli: got.brotli },
        absent: budget.routes[name]?.absent ?? [],
      };
    }
    writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
    console.log(`Recorded ${Object.keys(measured.routes).length} ceilings in scripts/bundle-budget.json`);
  }

  console.log('First-load JS per route (KB)');
  console.log(`${'route'.padEnd(18)}${'files'.padStart(6)}${'raw'.padStart(9)}${'gzip'.padStart(9)}${'brotli'.padStart(9)}   ceiling raw   in first load`);
  for (const [name, got] of Object.entries(measured.routes)) {
    const ceiling = budget.routes[name]?.ceiling?.raw;
    console.log(`${name.padEnd(18)}${String(got.files).padStart(6)} ${kb(got.raw)} ${kb(got.gzip)} ${kb(got.brotli)}   ${ceiling ? kb(ceiling) : '       -'}      ${got.contains.join(', ') || '-'}`);
  }
  if (args.has('--chunks')) {
    for (const [name, got] of Object.entries(measured.routes)) {
      console.log(`\n${name} (${got.key})`);
      for (const c of got.chunks) console.log(`  ${c.file.padEnd(30)} ${kb(c.raw)} ${kb(c.gzip)} ${kb(c.brotli)}   ${c.contains.join(', ')}`);
    }
  }

  const failures = check(measured, budget);
  if (failures.length) {
    console.error(`\n${failures.length} bundle budget failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\nAll ${Object.keys(budget.routes).length} routes are within budget.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
