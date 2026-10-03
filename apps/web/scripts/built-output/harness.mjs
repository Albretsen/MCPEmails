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
import { fileURLToPath } from 'node:url';

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
 * `BUILT_OUTPUT_REQUIRED=1` (set in the CI build job) turns a skip into a failure.
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

export const buildRequired = process.env.BUILT_OUTPUT_REQUIRED === '1';

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
    env: { ...process.env, ...PLACEHOLDER_ENV },
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
      const response = await fetch(`${origin}/robots.txt`);
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
  const response = await fetch(origin + route, { redirect: 'manual', headers: { accept: 'text/html' } });
  const body = Buffer.from(await response.arrayBuffer());
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
  let work = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g, (whole, attrs, body) => {
    if (/type="application\/ld\+json"/.test(attrs)) jsonLd.push(body);
    return '\n';
  });
  work = work.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '\n');
  // React writes <!-- --> between adjacent text nodes; they are not a break.
  work = work.replace(/<!--[\s\S]*?-->/g, '');
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
