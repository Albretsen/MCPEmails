import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relatedPostSlugs, PINNED_HUBS } from './related.mjs';

const posts = [
  { slug: 'connect-any-email-to-claude-and-chatgpt', tags: ['Claude', 'ChatGPT', 'Connectors'], publishedAt: '2026-11-11' },
  { slug: 'what-is-an-mcp-email-server', tags: ['MCP', 'AI agents', 'Email'] },
  { slug: 'connect-claude-to-email', tags: ['Claude', 'MCP', 'Email', 'Tutorial'], publishedAt: '2026-07-28' },
  { slug: 'connect-gmail-to-claude', tags: ['Tutorial', 'Gmail', 'Claude', 'MCP'], publishedAt: '2026-06-23' },
  { slug: 'why-email-never-stored-matters', tags: ['Privacy', 'Email'] },
  { slug: 'hidden', tags: ['Claude', 'MCP', 'Email', 'Tutorial'], noindex: true },
];

test('a Claude + MCP post links both hubs first, then the closest post', () => {
  assert.deepEqual(relatedPostSlugs(posts[2], posts), [
    'connect-any-email-to-claude-and-chatgpt',
    'what-is-an-mcp-email-server',
    'connect-gmail-to-claude',
  ]);
});

test('a hub never links itself, and noindex posts are never linked', () => {
  const got = relatedPostSlugs(posts[0], posts);
  assert.ok(!got.includes('connect-any-email-to-claude-and-chatgpt'));
  assert.ok(!got.includes('hidden'));
});

test('a post sharing no pinned tag gets no hub, only tag matches', () => {
  assert.deepEqual(relatedPostSlugs(posts[4], posts), ['connect-claude-to-email', 'what-is-an-mcp-email-server']);
});

test('hub slugs are distinct', () => {
  assert.equal(new Set(PINNED_HUBS.map((h) => h.slug)).size, PINNED_HUBS.length);
});
