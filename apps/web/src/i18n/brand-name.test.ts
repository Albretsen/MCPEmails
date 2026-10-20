// The brand is written "MCPEmails": one word, camel case (owner decision,
// 2026-10-20). Search engines treat "MCPEmails" as a distinct entity and
// "MCP Emails" as a generic phrase, so the page title suffix and the JSON-LD
// names are pinned here. The other spellings live only in alternateName.
//
// seo.ts imports './routing' without an extension, which the bare node runner
// cannot resolve, and layout.js imports CSS, so these checks read the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const layoutSource = readFileSync(new URL('../../app/layout.js', import.meta.url), 'utf8');
const seoSource = readFileSync(new URL('./seo.ts', import.meta.url), 'utf8');

test('root layout title template ends with "MCPEmails"', () => {
  const match = layoutSource.match(/template:\s*'([^']*)'/);
  assert.ok(match, 'title template not found in app/layout.js');
  assert.equal(match[1], '%s · MCPEmails');
});

test('root layout og siteName is "MCPEmails"', () => {
  const match = layoutSource.match(/siteName:\s*'([^']*)'/);
  assert.ok(match, 'siteName not found in app/layout.js');
  assert.equal(match[1], 'MCPEmails');
});

test('root layout fallback titles end with "| MCPEmails"', () => {
  const titles = [...layoutSource.matchAll(/(?:default|title):\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(titles.length >= 3, `expected default, og and twitter titles, found ${titles.length}`);
  for (const title of titles) assert.match(title, / \| MCPEmails$/, title);
});

function graphNode(type: string, id: string): string {
  const re = new RegExp(`'@type': '${type}',\\n\\s*'@id': ${id},\\n([\\s\\S]*?)\\n\\s*url:`);
  const match = seoSource.match(re);
  assert.ok(match, `${type} node not found in src/i18n/seo.ts`);
  return match[1];
}

test('Organization and WebSite say "MCPEmails" and list the other spellings', () => {
  for (const [type, id] of [['Organization', 'orgId'], ['WebSite', 'siteId']]) {
    const body = graphNode(type, id);
    assert.match(body, /name: 'MCPEmails',/, type);
    assert.match(body, /alternateName: \['MCP Emails', 'mcpemails', 'mcpemails\.com'\],/, type);
  }
  assert.match(seoSource, /'@type': 'SoftwareApplication',\n\s*name: 'MCPEmails',/);
  assert.match(seoSource, /'@type': 'Product',\n\s*'@id': [^\n]*\n\s*name: 'MCPEmails',/);
});

test('default social image alt uses the brand name', () => {
  assert.match(seoSource, /alt: 'MCPEmails: /);
});

test('no JSON-LD name or breadcrumb in seo.ts says "MCP Emails" or "mcpemails"', () => {
  assert.doesNotMatch(seoSource, /name: '(?:mcpemails|MCP Emails)'/);
  const crumbs = [...seoSource.matchAll(/'ListItem', position: 1, name: '([^']*)'/g)].map((m) => m[1]);
  assert.ok(crumbs.length >= 3, `expected the home breadcrumbs, found ${crumbs.length}`);
  for (const name of crumbs) assert.equal(name, 'MCPEmails');
});
