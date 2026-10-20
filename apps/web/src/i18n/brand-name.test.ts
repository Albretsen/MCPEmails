// The brand is written "MCP Emails". AI answers picked up "mcpemails" from the
// page title suffix and the JSON-LD names, so both are pinned here.
//
// seo.ts imports './routing' without an extension, which the bare node runner
// cannot resolve, and layout.js imports CSS, so these checks read the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const layoutSource = readFileSync(new URL('../../app/layout.js', import.meta.url), 'utf8');
const seoSource = readFileSync(new URL('./seo.ts', import.meta.url), 'utf8');

test('root layout title template ends with "MCP Emails"', () => {
  const match = layoutSource.match(/template:\s*'([^']*)'/);
  assert.ok(match, 'title template not found in app/layout.js');
  assert.equal(match[1], '%s · MCP Emails');
});

test('root layout og siteName is "MCP Emails"', () => {
  const match = layoutSource.match(/siteName:\s*'([^']*)'/);
  assert.ok(match, 'siteName not found in app/layout.js');
  assert.equal(match[1], 'MCP Emails');
});

function graphNode(type: string, id: string): string {
  const re = new RegExp(`'@type': '${type}',\\n\\s*'@id': ${id},\\n([\\s\\S]*?)\\n\\s*url:`);
  const match = seoSource.match(re);
  assert.ok(match, `${type} node not found in src/i18n/seo.ts`);
  return match[1];
}

test('Organization and WebSite say "MCP Emails" and list the old spellings', () => {
  for (const [type, id] of [['Organization', 'orgId'], ['WebSite', 'siteId']]) {
    const body = graphNode(type, id);
    assert.match(body, /name: 'MCP Emails',/, type);
    assert.match(body, /alternateName: \['mcpemails', 'mcpemails\.com', 'MCPEmails'\],/, type);
  }
  assert.match(seoSource, /'@type': 'SoftwareApplication',\n\s*name: 'MCP Emails',/);
});

test('default social image alt uses the brand name', () => {
  assert.match(seoSource, /alt: 'MCP Emails: /);
});

test('no JSON-LD name or breadcrumb in seo.ts still says "mcpemails"', () => {
  assert.doesNotMatch(seoSource, /name: 'mcpemails'/);
});
