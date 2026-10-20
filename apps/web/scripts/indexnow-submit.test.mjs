import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildPayloads, KEY, KEY_LOCATION, sitemapUrls } from './indexnow-submit.mjs';

test('the public key file matches the key the script submits', async () => {
  const file = await readFile(new URL(`../public/${KEY}.txt`, import.meta.url), 'utf8');
  assert.equal(file.trim(), KEY);
  assert.equal(KEY_LOCATION, `https://mcpemails.com/${KEY}.txt`);
});

test('reads <loc> entries once each and ignores hreflang alternates', () => {
  const xml = `<urlset><url><loc>https://mcpemails.com</loc>
    <xhtml:link rel="alternate" hreflang="nb" href="https://mcpemails.com/nb" /></url>
    <url><loc> https://mcpemails.com/pricing </loc></url>
    <url><loc>https://mcpemails.com</loc></url></urlset>`;
  assert.deepEqual(sitemapUrls(xml), ['https://mcpemails.com', 'https://mcpemails.com/pricing']);
});

test('drops other hosts, since IndexNow rejects a batch with foreign URLs', () => {
  const [payload, ...rest] = buildPayloads(['https://mcpemails.com/a', 'https://www.mcpemails.com/b', 'https://example.com/c']);
  assert.equal(rest.length, 0);
  assert.deepEqual(payload.urlList, ['https://mcpemails.com/a']);
  assert.equal(payload.host, 'mcpemails.com');
});

test('splits at the 10,000 URL protocol limit', () => {
  const urls = Array.from({ length: 10001 }, (_, i) => `https://mcpemails.com/p${i}`);
  assert.deepEqual(buildPayloads(urls).map((p) => p.urlList.length), [10000, 1]);
});
