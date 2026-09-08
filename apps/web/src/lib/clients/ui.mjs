/**
 * Chrome strings for the client setup pages: section headings, table labels
 * and link text that repeat on every page and are not worth restating in each
 * client's content file.
 *
 * Kept here rather than in messages/, for the same reason the copy is (see
 * content.mjs): a next-intl namespace ships to every marketing page, and these
 * strings are read by two routes. Keyed by locale so adding a language is
 * adding a key, with `en` as the fallback until one exists.
 *
 * House style, enforced by hand: no em dashes, and no angle brackets. RichText
 * renders the inline subset (b, code) that the content files use; anything
 * else in these strings would reach the DOM as literal text.
 */
const EN = {
  hub: {
    eyebrow: 'MCP clients',
    title: 'Connect your inbox to any MCP client',
    lead: 'One hosted MCP server, {count} setup guides. Pick the client you actually use and follow the steps written for it, not a generic template.',
    answer: 'mcpemails is a hosted MCP server for email. You connect a mailbox once, then paste one URL into the client you already work in. {oauth} of the {count} clients here run the OAuth browser flow and need no API key at all; the rest take a scoped API key in an Authorization header.',
    meta: {
      title: 'Connect Email to Claude, Cursor, ChatGPT and {count} MCP Clients',
      description: 'Per-client setup guides for the mcpemails MCP server. Connect a real inbox to Claude, Claude Code, Cursor, VS Code, ChatGPT, Cline, Windsurf, Gemini CLI, Zed, JetBrains, Raycast, Warp or curl.',
    },
    genericTitle: 'Client not listed?',
    genericSub: 'Any client that speaks Streamable HTTP MCP works. The endpoint, the handshake and the tool catalogue are in the docs.',
    genericCta: 'Read the docs',
    breadcrumb: 'MCP clients',
    authOauth: 'OAuth',
    authKey: 'API key',
  },
  page: {
    breadcrumb: 'MCP clients',
    ctaPrimary: 'Connect your inbox',
    ctaSecondary: 'Read the docs',
    endpoint: {
      title: 'The one value you need',
      sub: 'Everything on this page is a way of getting this URL into {client}.',
      colField: 'Field',
      colValue: 'Value',
      fieldUrl: 'MCP server URL',
      fieldTransport: 'Transport',
      transport: 'Streamable HTTP (MCP 2025-06-18)',
      fieldAuth: 'Authentication',
      authOauth: 'OAuth 2.1, authorization code with PKCE. No API key.',
      authKey: 'Authorization: Bearer, using a scoped API key from your dashboard.',
    },
    how: {
      eyebrow: 'Setup',
      title: 'How to connect {client} to your inbox',
      sub: 'Four steps. The first two are the same for every client, the rest are specific to this one.',
    },
    config: {
      title: 'Configuration',
      terminal: 'terminal',
      json: 'json',
    },
    gotchas: {
      eyebrow: 'Before you start',
      title: 'What trips people up in {client}',
    },
    limits: {
      title: 'Limits worth knowing',
    },
    faq: {
      eyebrow: 'FAQ',
      title: '{client} and email, answered',
    },
    related: {
      title: 'Set up another client',
      sub: 'The same inbox, the same URL. Connect as many clients as you like.',
      link: 'Connect {client}',
      all: 'All MCP client setup guides',
    },
    guideLink: {
      intro: 'Official {client} documentation for remote MCP servers:',
    },
    providers: {
      intro: 'Wondering which mailbox to connect first?',
      label: 'See the provider compatibility matrix',
    },
    connect: {
      intro: 'Connecting a specific mailbox?',
      label: 'Provider setup guides',
    },
  },
};

const UI = { en: EN };

export function clientUi(locale) {
  return UI[locale] ?? EN;
}

/** Tiny placeholder substitution, so these strings can hold {client} and {count}. */
export function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m,
  );
}
