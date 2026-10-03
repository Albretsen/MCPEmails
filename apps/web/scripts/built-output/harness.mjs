// ---------------------------------------------------------------------------
// Shared pieces for the built-output suites: start the production server from
// an existing `next build`, fetch routes, and reduce an HTML document to what a
// visitor can read.
//
// WHY A REAL SERVER. Every page here is rendered on demand (the root layout
// awaits the locale, and the CSP nonce is per request), so there is no
// prerendered HTML on disk to read. The only faithful source for "what does
// this route send" is the production server answering a request.
//
// WHY THE BUILD MUST BE THE CI PLACEHOLDER BUILD. NEXT_PUBLIC_* values are
// inlined at build time. With the placeholder Supabase URL the homepage
// experiment read fails and serves the control variant, and with no Stripe
// price ids the pricing copy comes from the static catalogue; both make the
// text deterministic. A build made against real services could legitimately
// render different text, so it is refused rather than compared.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const buildDir = path.join(webRoot, '.next');

/** The environment .github/workflows/ci.yml builds with, plus what `next start` needs to answer. */
export const PLACEHOLDER_ENV = {
  CI: '1',
  NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder-anon-key',
  NEXT_PUBLIC_APP_URL: 'https://mcpemails.com',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_placeholder',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  // Not a secret and not valid anywhere: the homepage constructs a service
  // client before its experiment read, and throws without a value.
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
  NEXT_TELEMETRY_DISABLED: '1',
};

/**
 * Why the suite cannot run here, or null when it can.
 */
export function buildUnavailableReason() {
  if (!existsSync(path.join(buildDir, 'BUILD_ID'))) {
    return 'no production build in apps/web/.next (run `npm run build` with the CI placeholder env first)';
  }
  const chunkDir = path.join(buildDir, 'static/chunks');
  const hasPlaceholder = existsSync(chunkDir)
    && readdirSync(chunkDir).some((name) => name.endsWith('.js') && readFileSync(path.join(chunkDir, name), 'utf8').includes('placeholder.supabase.co'));
  if (!hasPlaceholder) {
    return 'apps/web/.next was not built with the CI placeholder env (NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co), so its text is not comparable';
  }
  return null;
}

// The suites are run on demand (npm run check:built-output), where a missing
// build is a failure, never a skip. BUILT_OUTPUT_OPTIONAL=1 restores the skip
// for anyone who wires them into something that may run without a build.
export const buildRequired = process.env.BUILT_OUTPUT_OPTIONAL !== '1';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Starts `next start` on a free port and resolves once it answers. */
export async function startServer() {
  const port = await freePort();
  const nextBin = path.resolve(webRoot, '../../node_modules/next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
    cwd: webRoot,
    env: {
      ...process.env,
      ...PLACEHOLDER_ENV,
      // Fail lookups of the placeholder Supabase host in process, at once.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(path.join(webRoot, 'scripts/built-output/offline-placeholder-host.mjs')).href}`.trim(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  // `localhost`, not 127.0.0.1: next-intl rewrites / to /en against the host
  // the server believes it has, and a mismatch turns the rewrite into a redirect.
  const origin = `http://localhost:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode}\n${log}`);
    try {
      // robots.txt is static, so readiness does not depend on any page rendering.
      // The timeout matters. A connection made while the server is still
      // booting can be accepted and then never answered, and a fetch with no
      // timeout sits on it for undici's five-minute default: three of those in
      // a row made this suite take fifteen minutes, twice, on 2026-10-03.
      const response = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`next start did not answer within 60s\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return {
    origin,
    log: () => log,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }),
  };
}

/** One GET, redirects not followed. */
export async function fetchRoute(origin, route) {
  // Bounded for the same reason as the readiness probe in startServer(): one
  // retry, then a failure that says which route stalled. The slowest route
  // (the home page, waiting out its failing experiment read) takes about 7 s.
  let response;
  let body;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await fetch(origin + route, { redirect: 'manual', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(60_000) });
      body = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      if (attempt === 2) throw new Error(`GET ${route} failed twice: ${error.message}`, { cause: error });
    }
  }
  return {
    route,
    status: response.status,
    location: response.headers.get('location'),
    headers: response.headers,
    html: body.toString('utf8'),
    rawBytes: body.length,
    gzipBytes: gzipSync(body).length,
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return body in ENTITIES ? ENTITIES[body] : whole;
  });
}

const TEXT_ATTRIBUTES = ['alt', 'aria-label', 'placeholder', 'title'];
const META_NAMES = /^(description|og:title|og:description|og:site_name|og:locale|og:locale:alternate|twitter:title|twitter:description)$/;

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeEntities(match[1]) : null;
}

/**
 * Everything in a server-rendered document that a visitor (or a crawler, or a
 * screen reader) can read, one item per line, in document order:
 *
 *   - text nodes, with <script> and <style> bodies removed. That removes the
 *     RSC flight payload and the serialised message catalogue, which is the
 *     point: the catalogue may shrink, the rendered text may not change.
 *   - the text-bearing attributes (alt, aria-label, placeholder, title), since
 *     a translated string is as likely to land in one of those as in a node.
 *   - <title>, the description and social-card meta tags, and JSON-LD.
 *
 * Tags become line breaks, so an inline <strong> splits a sentence over lines.
 * That is fine for a snapshot: it is stable, and nothing reads it as prose.
 */
export function visibleText(html) {
  const lines = [];
  const jsonLd = [];
  let work = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi, (whole, attrs, body) => {
    if (/type="application\/ld\+json"/.test(attrs)) jsonLd.push(body);
    return '\n';
  });
  work = work.replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, '\n');
  // React writes <!-- --> between adjacent text nodes; they are not a break.
  // Repeated until stable so a comment cannot be reassembled from its remains.
  for (let previous; previous !== work; ) {
    previous = work;
    work = work.replace(/<!--[\s\S]*?-->/g, '');
  }
  work = work.replace(/<[^>]+>/g, (tag) => {
    const out = [];
    if (/^<meta\b/.test(tag)) {
      const name = attribute(tag, 'name') ?? attribute(tag, 'property');
      const content = attribute(tag, 'content');
      if (name && META_NAMES.test(name) && content) out.push(`[meta ${name}] ${content}`);
    } else {
      for (const name of TEXT_ATTRIBUTES) {
        const value = attribute(tag, name);
        if (value && value.trim()) out.push(`[${name}] ${value}`);
      }
    }
    return `\n${out.join('\n')}\n`;
  });
  for (const raw of decodeEntities(work).split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  for (const block of jsonLd) lines.push(`[json-ld] ${block.replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n') + '\n';
}

/**
 * Lines that look like a message key rendered in place of its message, which
 * is what next-intl falls back to when a namespace or key is not available:
 * `pricing.hero.title` instead of the title.
 *
 * A line counts when the WHOLE line is a dotted identifier path that starts
 * with a namespace name. Real copy that merely contains such a token inside a
 * sentence (a hostname, a file name) is left alone.
 */
export function untranslatedKeyLines(text, namespaces) {
  const shape = new RegExp(`^(?:\\[[a-z-]+\\] )?(?:${namespaces.join('|')})(?:\\.[A-Za-z_][A-Za-z0-9_]*)+$`);
  return text.split('\n').filter((line) => shape.test(line));
}

/** hrefs of the stylesheets a document links. */
export function stylesheetLinks(html) {
  return [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
    .map((tag) => /href="([^"]+)"/.exec(tag[0])?.[1])
    .filter(Boolean);
}

/** Entries of a `Link:` response header: [{ href, rel, as, type, crossorigin }]. */
export function linkHeaderEntries(headers) {
  const value = headers.get('link');
  if (!value) return [];
  return value.split(/,\s*(?=<)/).map((entry) => {
    const href = /^<([^>]*)>/.exec(entry)?.[1];
    const param = (name) => new RegExp(`;\\s*${name}(?:="?([^";]*)"?)?(?=;|$)`).exec(entry);
    return {
      href,
      rel: param('rel')?.[1],
      as: param('as')?.[1],
      type: param('type')?.[1],
      crossorigin: param('crossorigin') !== null,
    };
  });
}

/**
 * A page and the text of every stylesheet it loads: the <link rel="stylesheet">
 * tags, plus `as="style"` entries of the Link header, which is how Next hands
 * the stylesheets to a document whose body is rendered on the client (the
 * not-found screen).
 */
export async function fetchPageWithCss(origin, route) {
  const page = await fetchRoute(origin, route);
  const css = [];
  const hrefs = new Set([
    ...stylesheetLinks(page.html),
    ...linkHeaderEntries(page.headers).filter((entry) => entry.rel === 'preload' && entry.as === 'style').map((entry) => entry.href),
  ]);
  for (const href of hrefs) {
    const response = await fetch(new URL(href, origin), { signal: AbortSignal.timeout(30_000) });
    css.push({ href, status: response.status, text: await response.text() });
  }
  return { ...page, css };
}
