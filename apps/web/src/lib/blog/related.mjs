// ---------------------------------------------------------------------------
// The "Related guides" links under every blog post.
//
// Before 2026-11-24 a post linked other posts only where its body happened to,
// and Search Console listed /blog/connect-any-email-to-claude-and-chatgpt and
// /blog/what-is-an-mcp-email-server as "discovered, not indexed": next to no
// internal links pointed at them. Two hub posts are pinned where a reader of
// the current post is likely to want them; the rest of the slots go to the
// posts sharing the most tags, newest first.
//
// Plain .mjs with no imports so related.test.mjs runs under bare `node --test`.
// ---------------------------------------------------------------------------

/** How many related posts a post links. */
export const RELATED_COUNT = 3;

/**
 * Hub posts and the tags that earn them a pinned slot. A post carrying any of
 * the tags links the hub first (never itself).
 */
export const PINNED_HUBS = [
  // The roundup: any mailbox into Claude or ChatGPT.
  { slug: 'connect-any-email-to-claude-and-chatgpt', tags: ['Claude', 'ChatGPT', 'Connectors', 'Multiple inboxes', 'IMAP', 'Yahoo', 'iCloud', 'Outlook', 'Gmail'] },
  // The explainer: what an MCP email server is.
  { slug: 'what-is-an-mcp-email-server', tags: ['MCP', 'AI agents', 'Connectors', 'OAuth', 'Security'] },
];

/**
 * Up to `limit` posts related to `post`, as slugs, from `posts` (each with
 * `slug`, `tags`, `publishedAt` and optional `noindex`).
 */
export function relatedPostSlugs(post, posts, limit = RELATED_COUNT) {
  const eligible = posts.filter((p) => p.slug !== post.slug && !p.noindex);
  const bySlug = new Map(eligible.map((p) => [p.slug, p]));
  const out = [];
  for (const hub of PINNED_HUBS) {
    if (out.length >= limit) break;
    if (!bySlug.has(hub.slug)) continue;
    if (post.tags.some((t) => hub.tags.includes(t))) out.push(hub.slug);
  }
  const tags = new Set(post.tags);
  const shared = (p) => p.tags.filter((t) => tags.has(t)).length;
  const rest = eligible
    .filter((p) => !out.includes(p.slug) && shared(p) > 0)
    .sort((a, b) => shared(b) - shared(a) || String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')) || a.slug.localeCompare(b.slug));
  for (const p of rest) {
    if (out.length >= limit) break;
    out.push(p.slug);
  }
  return out;
}
