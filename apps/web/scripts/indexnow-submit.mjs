#!/usr/bin/env node
/**
 * Pings IndexNow (Bing, Yandex, Seznam, Naver) with the URLs in the live
 * sitemap, or with the URLs given as arguments. Bing had most of the site as
 * "Discovered but not crawled" for weeks; IndexNow is the push channel it asks
 * for instead of waiting on its crawl queue.
 *
 * The key is public by design: the engines fetch it from KEY_LOCATION to
 * prove we control the host. Rotating it means a new public/<key>.txt.
 *
 *   node scripts/indexnow-submit.mjs --dry-run            # list what would be sent
 *   node scripts/indexnow-submit.mjs                      # every sitemap URL
 *   node scripts/indexnow-submit.mjs https://mcpemails.com/pricing
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const HOST = 'mcpemails.com';
export const KEY = 'd57d883bda7ce861569db875c41ef673';
export const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
// The protocol caps one POST at 10,000 URLs.
const BATCH = 10000;

export function sitemapUrls(xml) {
  const urls = new Set();
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) urls.add(match[1]);
  return [...urls];
}

export function buildPayloads(urls) {
  const own = urls.filter((url) => new URL(url).host === HOST);
  const payloads = [];
  for (let i = 0; i < own.length; i += BATCH) {
    payloads.push({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: own.slice(i, i + BATCH) });
  }
  return payloads;
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  let urls = argv.filter((arg) => !arg.startsWith('--'));
  if (urls.length === 0) {
    const res = await fetch(`https://${HOST}/sitemap.xml`);
    if (!res.ok) throw new Error(`sitemap.xml returned ${res.status}`);
    urls = sitemapUrls(await res.text());
  }
  const payloads = buildPayloads(urls);
  const count = payloads.reduce((sum, p) => sum + p.urlList.length, 0);
  if (count === 0) throw new Error(`no ${HOST} URLs to submit`);
  if (dryRun) {
    for (const p of payloads) for (const url of p.urlList) console.log(url);
    console.log(`${count} URLs (dry run, nothing sent)`);
    return;
  }
  const key = await fetch(KEY_LOCATION);
  if (!key.ok || (await key.text()).trim() !== KEY) {
    throw new Error(`${KEY_LOCATION} is not serving the key; deploy it before submitting`);
  }
  for (const payload of payloads) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    // 200 = accepted, 202 = accepted while the key is still being verified.
    if (res.status !== 200 && res.status !== 202) {
      throw new Error(`IndexNow returned ${res.status}: ${await res.text()}`);
    }
    console.log(`IndexNow ${res.status}: ${payload.urlList.length} URLs submitted`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
