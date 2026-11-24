#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Live check of rendered <title> and meta description lengths.
//
//   node scripts/check-seo-lengths.mjs [base-url] [--all]
//
// Reads <base>/sitemap.xml, fetches every page and lists each <title> over 60
// characters and each meta description over 160 (TITLE_MAX and
// DESCRIPTION_MAX in src/lib/seo/title.mjs). Exits 1 when it finds any.
// src/lib/seo/meta-lengths.test.mjs holds the source copy to the same budget
// in CI; this script also catches titles built in code. Default base:
// https://mcpemails.com.
// ---------------------------------------------------------------------------

import { TITLE_MAX, DESCRIPTION_MAX } from '../src/lib/seo/title.mjs';

const base = (process.argv.slice(2).find((a) => !a.startsWith('--')) || 'https://mcpemails.com').replace(/\/$/, '');
const CONCURRENCY = 8;

// One pass, so "&amp;lt;" decodes to "&lt;" and not on to "<".
const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>' };
const decode = (s) => s.replace(/&(?:amp|quot|#x27|#39|lt|gt);/g, (m) => ENTITIES[m]);

const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, base));

const problems = [];
let errors = 0;
let next = 0;
async function worker() {
  while (next < urls.length) {
    const url = urls[next++];
    try {
      const html = await (await fetch(url, { redirect: 'follow' })).text();
      const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '');
      const description = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '');
      if (title.length > TITLE_MAX) problems.push(`title ${title.length} ${url} | ${title}`);
      if (description.length > DESCRIPTION_MAX) problems.push(`description ${description.length} ${url} | ${description}`);
    } catch (err) {
      errors += 1;
      problems.push(`error ${url} | ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

problems.sort();
for (const p of problems) console.log(p);
console.log(`${urls.length} pages, ${problems.length - errors} over budget, ${errors} fetch errors`);
process.exit(problems.length ? 1 : 0);
