/**
 * Blog post registry.
 *
 * Posts are authored inline as Markdown (rendered server-side — see
 * ./markdown.js). To add a post, append an entry to POSTS. There is exactly
 * one test post for now.
 *
 * Dates are ISO-8601 strings so they serialise cleanly into JSON-LD and the
 * <time> elements.
 */

/** Author records, keyed by id, reused across posts and for E-E-A-T author markup. */
export const AUTHORS = {
  asgeir: {
    id: 'asgeir',
    name: 'Asgeir Albretsen',
    role: 'Founder & Engineer, MCPEmails',
    avatar: '/blog/author-asgeir.svg',
    bio: 'Asgeir builds MCPEmails — the bridge that lets AI agents read, search, and send real email over the Model Context Protocol. He writes about agents, email infrastructure, and developer experience.',
    url: 'https://mcpemails.com/blog',
    twitter: '@mcpemails',
  },
};

// New cluster posts, each authored in its own module under ./posts/.
import pillarEmailAccess from './posts/how-to-give-your-ai-agent-email-access';
import whatIsMcpEmailServer from './posts/what-is-an-mcp-email-server';
import connectUnder2Minutes from './posts/connect-email-to-ai-agent-under-2-minutes';
import connectGmailToClaude from './posts/connect-gmail-to-claude';
import emailSignaturesForClaude from './posts/email-signatures-for-claude';
import inboxZeroWithAi from './posts/inbox-zero-with-ai-claude';
import connectOutlook365 from './posts/connect-outlook-microsoft-365-ai-agent-mcp';
import emailForCursorCline from './posts/email-for-ai-agents-cursor-cline-vscode';
import connectIcloudFastmailImap from './posts/connect-icloud-fastmail-imap-to-claude';
import isItSafe from './posts/is-it-safe-to-give-ai-agent-email-access';
import whyNeverStored from './posts/why-email-never-stored-matters';
import oauthVsApiKeys from './posts/oauth-vs-api-keys-ai-email-access';
import hostedVsSelfHosted from './posts/hosted-vs-self-hosted-gmail-mcp-server';
import bestWaysClaudeInbox from './posts/best-ways-to-let-claude-manage-your-inbox';
import sevenThingsInbox from './posts/7-things-ai-agent-can-do-with-inbox-access';
import triageSummarize from './posts/ai-agent-triage-summarize-inbox';
import autoResponder from './posts/build-email-auto-responder-mcp-agent';

// Sidecar translations: { [slug]: { [locale]: { title, description, coverAlt, content } } }.
import TRANSLATIONS from './translations';

/** Posts authored as standalone modules (newest cluster). */
const MODULE_POSTS = [
  pillarEmailAccess,
  whatIsMcpEmailServer,
  connectUnder2Minutes,
  connectGmailToClaude,
  emailSignaturesForClaude,
  inboxZeroWithAi,
  connectOutlook365,
  emailForCursorCline,
  connectIcloudFastmailImap,
  isItSafe,
  whyNeverStored,
  oauthVsApiKeys,
  hostedVsSelfHosted,
  bestWaysClaudeInbox,
  sevenThingsInbox,
  triageSummarize,
  autoResponder,
];

/** @type {Array<import('./types').Post>} */
export const POSTS = [
  {
    slug: 'give-your-ai-agent-an-inbox',
    title: 'Give your AI agent an inbox: a practical guide to email over MCP',
    description:
      'Why connecting email to your AI agent is harder than it looks — and how the Model Context Protocol makes Gmail, Outlook, and IMAP a single, secure endpoint your agent can actually use.',
    cover: '/blog/cover-agent-inbox.svg',
    coverAlt: 'Give your AI agent an inbox — MCPEmails',
    authorId: 'asgeir',
    publishedAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    tags: ['MCP', 'AI agents', 'Email', 'Tutorial'],
    featured: true,
    content: `Most "AI email" demos stop at a screenshot. The agent drafts a reply, everyone claps, and nobody asks the awkward question: **how does the model actually reach a real inbox** — securely, across providers, without you pasting an app password into a prompt?

This post walks through why that last mile is deceptively hard, and how the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) turns Gmail, Outlook, Fastmail, and generic IMAP into a single endpoint your agent can call like any other tool.

## The problem with "just give it my email"

Email looks like a solved problem. It is not — at least not for an autonomous agent. Three things get in the way:

1. **Auth is provider-specific.** Gmail wants OAuth with the right scopes. Outlook wants Microsoft identity. Fastmail wants an app password. Each has its own token lifecycle and failure modes.
2. **Credentials are radioactive.** You do not want a mailbox password sitting in a chat transcript, a log line, or a vector store. Ever.
3. **The "shape" of email is messy.** MIME, threading, HTML vs. plain text, attachments, folders that are really labels. An agent needs a clean, predictable interface — not raw RFC 5322.

The naive fix — handing the model an IMAP library and your password — fails all three at once.

## What MCP actually changes

MCP is a standard way to expose **tools** and **resources** to a language model. Instead of teaching every agent how to speak IMAP, you run one server that presents email as a small, well-typed set of tools:

\`\`\`json
{
  "tools": [
    "inbox_list",
    "email_read",
    "email_compose",
    "email_organize"
  ]
}
\`\`\`

The agent never sees a password. It sees verbs. That single shift is what makes email safe to automate.

> The best agent integrations are boring on purpose: a stable verb, a predictable response, and no secrets in the prompt.

### Discovery before action

A well-behaved email tool is **stateless from the agent's point of view**. The agent shouldn't hardcode a mailbox UUID. Instead it calls \`inbox_list\` first, discovers what's available, and then acts:

- \`inbox_list\` → returns connected accounts and their capabilities
- \`email_read\` (action \`list\`) → paginated, newest-first, per inbox
- \`email_read\` (action \`read\`) → the parsed body, sender, and metadata for one message
- \`email_compose\` (action \`send\`) → compose and dispatch, with the provider chosen for you

This discovery-first pattern is the difference between a demo and something you'd trust on a Tuesday afternoon.

## A concrete walk-through

Say you want Claude to triage your morning inbox. With email exposed over MCP, the conversation looks like this:

1. The agent calls \`inbox_list\` and finds your work Gmail.
2. It calls \`email_read\` with action \`list\` for the last 24 hours.
3. For anything that looks urgent, it calls \`email_read\` with action \`read\` to get the full body.
4. It drafts replies and calls \`email_compose\` with action \`reply\` — or just summarises and waits for your go-ahead.

No passwords crossed the wire. No provider-specific code lived in your prompt. The agent reasoned over verbs and got real work done.

## Security is the feature

The reason this works is that the boring parts are handled where they belong — on the server, not in the model:

- **OAuth tokens are encrypted at rest** and never returned to the client.
- **Scopes are minimal**: read and send, nothing more.
- **The agent authenticates to the server**, the server authenticates to the provider. Two hops, one secret store.

If you remember one thing from this post, make it this: *the model should hold capabilities, never credentials.*

## Where to go from here

Connecting an inbox should take minutes, not an afternoon of OAuth debugging. If you want to try the discovery-first flow above, the [quick-start guide](/docs#quickstart) gets you from zero to a live endpoint, and the [provider matrix](/docs/providers) shows exactly which features light up for Gmail, Outlook, Fastmail, and friends.

Give your agent verbs, not passwords — and let it get to work.`,
  },
  ...MODULE_POSTS,
];

/**
 * Display order for the blog index — most relevant and useful to MCPEmails
 * first. High-intent, on-product, conversion-driving content (core setup →
 * the pillar → the top buyer objection → the bottom-funnel comparison) leads;
 * top-of-funnel definitions and use-case inspiration trail. Edit this list to
 * reorder; any post not listed falls to the end (newest publishedAt first).
 */
const RELEVANCE_ORDER = [
  'connect-email-to-ai-agent-under-2-minutes',
  'connect-gmail-to-claude',
  'email-signatures-for-claude',
  'inbox-zero-with-ai-claude',
  'how-to-give-your-ai-agent-email-access',
  'is-it-safe-to-give-ai-agent-email-access',
  'hosted-vs-self-hosted-gmail-mcp-server',
  'give-your-ai-agent-an-inbox',
  'connect-icloud-fastmail-imap-to-claude',
  'connect-outlook-microsoft-365-ai-agent-mcp',
  'why-email-never-stored-matters',
  'oauth-vs-api-keys-ai-email-access',
  'email-for-ai-agents-cursor-cline-vscode',
  'best-ways-to-let-claude-manage-your-inbox',
  'what-is-an-mcp-email-server',
  'ai-agent-triage-summarize-inbox',
  '7-things-ai-agent-can-do-with-inbox-access',
  'build-email-auto-responder-mcp-agent',
];

/** All posts, sorted by relevance to MCPEmails (see RELEVANCE_ORDER). */
export function getAllPosts() {
  const rank = (slug) => {
    const i = RELEVANCE_ORDER.indexOf(slug);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...POSTS].sort((a, b) => {
    const ra = rank(a.slug);
    const rb = rank(b.slug);
    if (ra !== rb) return ra - rb;
    // Tie-break (unranked posts): newest first.
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });
}

/** A single post by slug, or undefined. */
export function getPost(slug) {
  return POSTS.find((p) => p.slug === slug);
}

/** Resolve a post's author record. */
export function getAuthor(post) {
  return AUTHORS[post.authorId];
}

// ---------------------------------------------------------------------------
// Localization
//
// Translations come from two interchangeable sources, merged transparently:
//
//   1. Sidecar files — src/lib/blog/translations/<slug>/<locale>.js, each
//      exporting { title, description, coverAlt, content }. This is the primary
//      mechanism: one file per (post, locale), so translations are added one at
//      a time without touching the English source or any other translation.
//   2. Inline per-field maps — a post field written as { en: '…', es: '…' }
//      instead of a plain string. Useful for a quick one-off.
//
// English (the default locale) is always available. A post counts as
// "translated" into a locale when that locale appears in either source. The
// page layer canonicalises untranslated locales to the English URL and omits
// them from hreflang (see app/[locale]/blog/[slug]/page.js), so search engines
// never index a fake-localized duplicate. Tags stay canonical (English) keys.
// ---------------------------------------------------------------------------

const LOCALIZABLE_FIELDS = ['title', 'description', 'coverAlt', 'cover', 'content'];

/** Resolve a possibly-localized field (string or { locale: value } map) for `locale`. */
export function resolveLocalized(field, locale) {
  if (field == null || typeof field === 'string') return field;
  return field[locale] ?? field.en ?? Object.values(field)[0];
}

/** Locales a post is translated into (sidecars + inline maps), always incl. en. */
export function getPostLocales(post) {
  const locales = new Set(['en']);
  for (const f of LOCALIZABLE_FIELDS) {
    const v = post[f];
    if (v && typeof v === 'object') for (const l of Object.keys(v)) locales.add(l);
  }
  const sidecar = TRANSLATIONS[post.slug];
  if (sidecar) for (const l of Object.keys(sidecar)) locales.add(l);
  return [...locales];
}

/** Resolve one field for `locale`: sidecar override wins, else inline map / string. */
function pickField(post, sidecar, field, locale) {
  if (locale !== 'en' && sidecar && sidecar[field] != null) return sidecar[field];
  return resolveLocalized(post[field], locale);
}

/**
 * A post with every localizable field resolved to a string for `locale`, plus
 * `locales` (everything it's translated into) and `translated` (whether the
 * requested locale is a real translation rather than an English fallback).
 */
export function getLocalizedPost(slug, locale) {
  const post = getPost(slug);
  if (!post) return undefined;
  const sidecar = (TRANSLATIONS[post.slug] || {})[locale];
  const locales = getPostLocales(post);
  return {
    ...post,
    title: pickField(post, sidecar, 'title', locale),
    description: pickField(post, sidecar, 'description', locale),
    coverAlt: pickField(post, sidecar, 'coverAlt', locale),
    cover: pickField(post, sidecar, 'cover', locale),
    content: pickField(post, sidecar, 'content', locale),
    locales,
    translated: locales.includes(locale),
  };
}
