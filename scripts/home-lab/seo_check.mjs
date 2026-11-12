#!/usr/bin/env node
// Homepage Lab SEO check: fetch a variant's HTML without running JavaScript and
// compare it with home-lab/baseline.json (today's homepage).
//
// Usage: node scripts/home-lab/seo_check.mjs <url> [--baseline home-lab/baseline.json] [--json]
//   e.g. node scripts/home-lab/seo_check.mjs 'https://staging.mcpemails.com/?home=v03'
// A local file path works too (an HTML file saved earlier).
// Exit code 1 when any check fails. No dependencies.

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const baselinePath = args.includes('--baseline') ? args[args.indexOf('--baseline') + 1] : 'home-lab/baseline.json';
const asJson = args.includes('--json');
if (!target) {
  console.error('usage: seo_check.mjs <url|file> [--baseline file] [--json]');
  process.exit(2);
}

const html = existsSync(target)
  ? readFileSync(target, 'utf8')
  : await (await fetch(target, { headers: { 'user-agent': 'mcpemails-home-lab-seo-check' }, redirect: 'follow' })).text();
const base = JSON.parse(readFileSync(baselinePath, 'utf8'));

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
const text = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}=("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decode(m[2] ?? m[3]) : null;
};

const ldBlocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const body = html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  // The lab picker is tooling, not page content.
  .replace(/<div[^>]*data-home-lab-picker[\s\S]*?<\/ol>|<div[^>]*data-home-lab-picker[^>]*>/gi, ' ');

const title = text((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
const description = attr((/<meta[^>]*name="description"[^>]*>/i.exec(html) || [''])[0], 'content');
const h1s = [...body.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => text(m[1]));
const headings = [...body.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), text: text(m[2]) }));
const words = text(body.replace(/<head[\s\S]*?<\/head>/i, ' ')).split(' ').filter(Boolean);
const hrefs = new Set([...body.matchAll(/<a\s[^>]*>/gi)].map((m) => attr(m[0], 'href')).filter(Boolean));
const imgs = [...body.matchAll(/<img\s[^>]*>/gi)].map((m) => ({
  src: attr(m[0], 'src'),
  alt: attr(m[0], 'alt'),
  width: attr(m[0], 'width'),
  height: attr(m[0], 'height'),
}));
const landmarks = ['header', 'main', 'nav', 'footer'].filter((t) => new RegExp(`<${t}[\\s>]`, 'i').test(body));

let faqLd = [];
for (const block of ldBlocks) {
  try {
    const data = JSON.parse(block);
    for (const node of data['@graph'] || [data]) {
      if (node['@type'] === 'FAQPage') faqLd = node.mainEntity.map((q) => q.name);
    }
  } catch {}
}
const visibleText = text(body);

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

check('title unchanged', title === base.title, title);
check('meta description unchanged', description === base.description, description);
check('exactly one H1', h1s.length === 1, `${h1s.length}: ${h1s.join(' | ')}`);
const firstPara = text((/<p[^>]*>([\s\S]*?)<\/p>/i.exec(body.slice(body.search(/<h1/i))) || [])[1] || '');
const lead = `${h1s.join(' ')} ${firstPara}`.toLowerCase();
const terms = ['mcp', 'claude', 'chatgpt', 'gmail', 'outlook', 'imap'];
const missingTerms = terms.filter((t) => !lead.includes(t));
check('H1 + first paragraph keep the main terms', missingTerms.length === 0, missingTerms.length ? `missing: ${missingTerms.join(', ')}` : 'all present');
check('mentions MCPEmails', /MCPEmails/.test(visibleText));
// The two counters (Python baseline, this regex pass) differ by a few words on the same page, so 1% slack.
const minWords = Math.floor(base.word_count * 0.99);
check(`word count >= baseline (${minWords})`, words.length >= minWords, String(words.length));
let skipped = null;
for (let i = 1; i < headings.length; i++) {
  if (headings[i].level > headings[i - 1].level + 1) {
    skipped = `${headings[i - 1].level} -> ${headings[i].level} at "${headings[i].text}"`;
    break;
  }
}
check('heading order never skips a level', !skipped, skipped || 'ok');
check('H2 count >= 6', headings.filter((h) => h.level === 2).length >= 6, String(headings.filter((h) => h.level === 2).length));
const normal = (h) => h.replace(/^https:\/\/mcpemails\.com(?=\/|$)/, '') || '/';
const have = new Set([...hrefs].map(normal));
const missingLinks = base.internal_links.filter((l) => !have.has(normal(l)));
check('every baseline internal link present', missingLinks.length === 0, missingLinks.join(' '));
check('JSON-LD FAQPage present', faqLd.length > 0, String(faqLd.length));
const faqMissing = faqLd.filter((q) => !visibleText.includes(q));
check('every FAQPage question is visible on the page', faqLd.length > 0 && faqMissing.length === 0, faqMissing.join(' | '));
const badImgs = imgs.filter((i) => !i.width || !i.height || i.alt === null);
check('images have width, height and alt', badImgs.length === 0, badImgs.map((i) => i.src).join(' '));
const emptyAlt = imgs.filter((i) => i.alt === '');
check('informative images have alt text (empty alt only for decoration)', true, `${emptyAlt.length} decorative`);
check('landmarks header, main, nav, footer', landmarks.length === 4, landmarks.join(','));
check('no em dashes in visible copy', !visibleText.includes('—'));
check('no banned phrases', !/SOC ?2|30 days|MCP Emails|JMAP|Supercharge|Seamless|Unlock |Effortless/i.test(visibleText),
  (visibleText.match(/SOC ?2|30 days|MCP Emails|JMAP|Supercharge|Seamless|Unlock |Effortless/gi) || []).join(', '));

const failed = checks.filter((c) => !c.ok);
if (asJson) {
  console.log(JSON.stringify({ target, words: words.length, h1: h1s, checks, passed: checks.length - failed.length, total: checks.length }, null, 2));
} else {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail.slice(0, 300)})` : ''}`);
  console.log(`${checks.length - failed.length}/${checks.length} SEO checks passed`);
}
process.exit(failed.length ? 1 : 0);
