#!/usr/bin/env node
/**
 * Crawl every URL in the sitemap, collect the internal links on each page and
 * report the link targets that do not answer 200.
 *
 *   node scripts/check-internal-links.mjs                       # production
 *   node scripts/check-internal-links.mjs --base http://localhost:3000
 *   node scripts/check-internal-links.mjs --json out.json       # full report
 *
 * The sitemap's own URLs are rewritten onto --base, so a local `npm run start`
 * can be crawled with the production sitemap's host in it. Exits 1 when any
 * dead target is found. It needs a running server (network), so it is not part
 * of CI; run it after a deploy or against a local build.
 *
 * Also reports pages whose <html lang> does not match their locale prefix.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = arg('--base', 'https://mcpemails.com').replace(/\/$/, '');
const CONCURRENCY = Number(arg('--concurrency', '12'));
const JSON_OUT = arg('--json', null);
const LOCALES = ['nb', 'es', 'fr', 'zh', 'de', 'pt', 'ja', 'it', 'nl', 'pl', 'sv', 'da', 'fi', 'ko', 'tr', 'ar'];

const UA = 'mcpemails-link-check/1.0';

async function get(url, method = 'GET') {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method, redirect: 'manual', headers: { 'user-agent': UA } });
      return res;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function toBase(url) {
  const u = new URL(url);
  return BASE + u.pathname + u.search;
}

function normalise(href, pageUrl) {
  if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) return null;
  let u;
  try {
    u = new URL(href.replace(/&amp;/g, '&'), pageUrl);
  } catch {
    return null;
  }
  const base = new URL(BASE);
  const prodHosts = new Set([base.host, 'mcpemails.com', 'www.mcpemails.com']);
  if (!prodHosts.has(u.host)) return null;
  // Static assets and API routes are not pages.
  if (u.pathname.startsWith('/_next/') || u.pathname.startsWith('/api/')) return null;
  if (/\.(png|jpe?g|svg|webp|gif|ico|css|js|woff2?|txt|xml|json|pdf|mp4|webm)$/i.test(u.pathname)) return null;
  return u.pathname.replace(/\/$/, '') || '/';
}

async function main() {
  const t0 = Date.now();
  const sm = await (await get(`${BASE}/sitemap.xml`)).text();
  const pages = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => toBase(m[1]));
  const unique = [...new Set(pages)];
  console.error(`sitemap: ${unique.length} URLs from ${BASE}`);

  /** target path -> Set of source page paths */
  const linksTo = new Map();
  const pageStatus = new Map();
  const langMismatch = [];

  await pool(unique, async (url) => {
    const path = new URL(url).pathname;
    const res = await get(url);
    pageStatus.set(path.replace(/\/$/, '') || '/', res.status);
    if (res.status !== 200) return;
    const html = await res.text();
    const seg = path.split('/')[1];
    const expected = LOCALES.includes(seg) ? seg : 'en';
    const lang = (html.match(/<html[^>]*\blang="([^"]+)"/i) || [])[1];
    if (lang && lang.split('-')[0] !== expected && !(expected === 'en' && lang === 'ar' && path.includes('arabic'))) {
      langMismatch.push({ path, lang, expected });
    }
    for (const m of html.matchAll(/<a\b[^>]*?\bhref="([^"]*)"/gi)) {
      const target = normalise(m[1], url);
      if (!target) continue;
      if (!linksTo.has(target)) linksTo.set(target, new Set());
      linksTo.get(target).add(path);
    }
  });

  const targets = [...linksTo.keys()].filter((t) => !pageStatus.has(t));
  await pool(targets, async (t) => {
    const res = await get(BASE + t, 'HEAD');
    pageStatus.set(t, res.status);
  });

  const dead = [];
  for (const [target, sources] of linksTo) {
    const status = pageStatus.get(target);
    if (status >= 400 || status === undefined) dead.push({ target, status, sources: [...sources].sort() });
  }
  dead.sort((a, b) => b.sources.length - a.sources.length);
  const redirects = [...linksTo]
    .filter(([t]) => pageStatus.get(t) >= 300 && pageStatus.get(t) < 400)
    .map(([target, s]) => ({ target, status: pageStatus.get(target), sources: s.size, from: [...s].sort().slice(0, 4) }));
  const sitemapNon200 = unique
    .map((u) => new URL(u).pathname.replace(/\/$/, '') || '/')
    .filter((p) => pageStatus.get(p) !== 200)
    .map((p) => ({ path: p, status: pageStatus.get(p) }));

  const brokenLinks = dead.reduce((n, d) => n + d.sources.length, 0);
  console.log(`pages crawled: ${unique.length}, internal targets: ${linksTo.size}`);
  console.log(`dead targets: ${dead.length}, broken links (page x target): ${brokenLinks}`);
  for (const d of dead) {
    console.log(`  ${d.status} ${d.target}  <- ${d.sources.length} page(s): ${d.sources.slice(0, 4).join(', ')}${d.sources.length > 4 ? ', ...' : ''}`);
  }
  if (sitemapNon200.length) {
    console.log(`sitemap URLs not answering 200: ${sitemapNon200.length}`);
    for (const s of sitemapNon200) console.log(`  ${s.status} ${s.path}`);
  }
  if (redirects.length) {
    console.log(`internal links to redirects: ${redirects.length} target(s)`);
    for (const r of redirects.filter((x) => !x.target.startsWith('/dashboard')).slice(0, 20)) console.log(`  ${r.status} ${r.target} <- ${r.sources} page(s): ${r.from.join(', ')}`);
  }
  if (langMismatch.length) {
    console.log(`html lang mismatches: ${langMismatch.length}`);
    for (const l of langMismatch.slice(0, 20)) console.log(`  ${l.path} lang="${l.lang}" expected ${l.expected}`);
  }
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, dead, redirects, sitemapNon200, langMismatch }, null, 2));
  process.exit(dead.length || sitemapNon200.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
