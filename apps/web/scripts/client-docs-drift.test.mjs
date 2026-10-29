import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { extractText, normalizedHash, missingPhrases, lineDiff, checkOwnLinks, decodeEntities } from './client-docs-drift.mjs';

test('extractText keeps <main>, drops scripts, nav and tags', () => {
  const html = `<html><head><title>x</title></head><body><nav>Home Pricing</nav><main>
    <h1>Add a server</h1><script>var a = "Add custom MCP server";</script>
    <p>Open <b>Plugins</b> &gt; <b>Add custom MCP server</b>.</p><footer>Legal</footer></main></body></html>`;
  const text = extractText(html, 'text/html');
  assert.equal(text, 'Add a server\nOpen Plugins > Add custom MCP server .');
});

test('markdown pages pass through as lines', () => {
  assert.equal(extractText('# Title\n\n  some   text \n', 'text/markdown'), '# Title\nsome text');
});

test('the hash ignores digits, case and whitespace, and sees words', () => {
  assert.equal(normalizedHash('Updated 3 days ago\nAdd connector'), normalizedHash('updated 12 days   ago add connector'));
  assert.notEqual(normalizedHash('Add connector'), normalizedHash('Add plugin'));
});

test('missingPhrases is case-insensitive and also searches the raw page (URL patterns in attributes)', () => {
  const raw = '<a href="cursor://anysphere.cursor-deeplink/mcp/install?name=x&amp;config=y">Install</a>';
  assert.deepEqual(missingPhrases('install', raw, ['INSTALL', 'cursor://anysphere.cursor-deeplink/mcp/install?name=', 'name=x&config=', 'Developer mode']), ['Developer mode']);
});

test('lineDiff lists added and removed lines', () => {
  const d = lineDiff('a\nb\nc', 'a\nc\nd');
  assert.deepEqual(d.removed, ['b']);
  assert.deepEqual(d.added, ['d']);
});

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(decodeEntities('&quot;a&quot; &#x27;b&#39; &rarr;'), '"a" \'b\' →');
});

test('our own install actions all point at the production MCP URL (offline part)', async () => {
  assert.deepEqual(await checkOwnLinks({ live: false }), []);
});

test('the baseline is well formed and every source has a snapshot', () => {
  const baseline = JSON.parse(readFileSync(new URL('./client-docs-drift.baseline.json', import.meta.url), 'utf8'));
  const ids = new Set();
  for (const s of baseline.sources) {
    assert.ok(/^[a-z0-9-]+$/.test(s.id), s.id);
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.ok(s.url.startsWith('https://'), s.id);
    assert.ok(Array.isArray(s.phrases) && s.phrases.length > 0, s.id);
    assert.match(s.hash, /^[0-9a-f]{16}$/, s.id);
    assert.ok(existsSync(new URL(`./client-docs-drift/${s.id}.txt`, import.meta.url)), `${s.id} snapshot`);
  }
});
