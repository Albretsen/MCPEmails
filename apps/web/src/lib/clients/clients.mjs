// HAND-MAINTAINED DATA.
//
// The single source of truth for the /docs/<client> setup pages.
//
// Every client below is one we already ship a verified in-product setup guide
// for: the roster, the auth method, the config field names and the official
// documentation link are lifted from MCP_CLIENTS in
// components/dashboard/Pages.jsx and the `clients.*` strings in
// messages/en/dashboard.json, which carry the standing rule that only clients
// verified to connect to a REMOTE MCP server BY URL are listed, each with
// steps read from that client's own current documentation.
//
// Two things follow from that rule and must be kept:
//
//  1. `auth` is per client and is not guessable. Claude, ChatGPT, Cursor,
//     VS Code, Windsurf, Gemini CLI, Zed, Raycast and Warp run the OAuth 2.1
//     browser flow against /.well-known/oauth-authorization-server (RFC 7591
//     dynamic registration, authorization code + PKCE with S256, public
//     clients only). Cline, JetBrains and raw HTTP callers do not, and paste a
//     scoped API key into an Authorization header instead. Publishing the
//     wrong one of those two for a client sends the reader down a path that
//     cannot complete.
//
//  2. The config field names differ per client and are not interchangeable:
//     Cursor wants `url` under `mcpServers`, VS Code wants `type` + `url`
//     under `servers`, Windsurf wants `serverUrl`, Gemini CLI wants `httpUrl`,
//     and Zed wants `url` under `context_servers`.
//
// Prose lives in src/lib/clients/content/<locale>/<slug>.json, deliberately
// NOT in a next-intl namespace: src/i18n/request.ts hands every marketing
// namespace to every marketing page, so putting thirteen clients' copy there
// would put all of it in the bundle of the home page too.

/** The endpoint every one of these pages tells the reader to paste. */
export const MCP_URL = 'https://mcpemails.com/api/mcp';

export const CLIENT_CATEGORIES = [
  { id: 'assistant', label: 'AI assistants', anchor: 'assistants' },
  { id: 'editor', label: 'Code editors and IDEs', anchor: 'editors' },
  { id: 'terminal', label: 'Terminals, CLIs and scripts', anchor: 'terminals' },
];

export const CLIENTS = [
  {
    slug: 'claude',
    name: 'Claude',
    surface: 'claude.ai and Claude Desktop',
    category: 'assistant',
    logo: 'claude',
    color: '#D97757',
    auth: 'oauth',
    configFile: null,
    config: null,
    guide: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
    locales: ['en'],
  },
  {
    slug: 'claude-code',
    name: 'Claude Code',
    surface: 'the Claude Code CLI',
    category: 'terminal',
    logo: 'claude',
    color: '#D97757',
    auth: 'oauth',
    configFile: 'terminal',
    config: (url) => `claude mcp add --transport http mcpemails ${url}`,
    guide: 'https://code.claude.com/docs/en/mcp',
    locales: ['en'],
  },
  {
    slug: 'chatgpt',
    name: 'ChatGPT',
    surface: 'ChatGPT Apps and connectors, developer mode',
    category: 'assistant',
    logo: 'chatgpt',
    color: '#000000',
    auth: 'oauth',
    configFile: null,
    config: null,
    guide: 'https://help.openai.com/en/articles/12584461',
    locales: ['en'],
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    surface: 'the Cursor editor',
    category: 'editor',
    logo: 'cursor',
    color: '#000000',
    auth: 'oauth',
    configFile: '~/.cursor/mcp.json',
    config: (url) => `{
  "mcpServers": {
    "mcpemails": {
      "url": "${url}"
    }
  }
}`,
    guide: 'https://cursor.com/docs/mcp',
    locales: ['en'],
  },
  {
    slug: 'vscode',
    name: 'VS Code',
    surface: 'GitHub Copilot agent mode in VS Code',
    category: 'editor',
    logo: 'vscode',
    color: '#0078D4',
    auth: 'oauth',
    configFile: '.vscode/mcp.json',
    config: (url) => `{
  "servers": {
    "mcpemails": {
      "type": "http",
      "url": "${url}"
    }
  }
}`,
    guide: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    locales: ['en'],
  },
  {
    slug: 'cline',
    name: 'Cline',
    surface: 'the Cline extension for VS Code',
    category: 'editor',
    logo: 'cline',
    color: '#18181B',
    auth: 'apikey',
    configFile: null,
    config: null,
    guide: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    locales: ['en'],
  },
  {
    slug: 'windsurf',
    name: 'Windsurf',
    surface: 'Cascade in Windsurf',
    category: 'editor',
    logo: 'windsurf',
    color: '#0B100F',
    auth: 'oauth',
    configFile: '~/.codeium/windsurf/mcp_config.json',
    config: (url) => `{
  "mcpServers": {
    "mcpemails": {
      "serverUrl": "${url}"
    }
  }
}`,
    guide: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    locales: ['en'],
  },
  {
    slug: 'gemini-cli',
    name: 'Gemini CLI',
    surface: 'the Gemini CLI',
    category: 'terminal',
    logo: 'gemini',
    color: '#8E75B2',
    auth: 'oauth',
    configFile: '~/.gemini/settings.json',
    config: (url) => `{
  "mcpServers": {
    "mcpemails": {
      "httpUrl": "${url}"
    }
  }
}`,
    guide: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md',
    locales: ['en'],
  },
  {
    slug: 'zed',
    name: 'Zed',
    surface: 'the Zed Agent Panel',
    category: 'editor',
    logo: 'zed',
    color: '#084CCF',
    auth: 'oauth',
    configFile: 'settings.json',
    config: (url) => `{
  "context_servers": {
    "mcpemails": {
      "url": "${url}"
    }
  }
}`,
    guide: 'https://zed.dev/docs/ai/mcp',
    locales: ['en'],
  },
  {
    slug: 'jetbrains',
    name: 'JetBrains',
    surface: 'AI Assistant in any JetBrains IDE that supports it',
    category: 'editor',
    logo: 'jetbrains',
    color: '#000000',
    auth: 'apikey',
    configFile: null,
    config: null,
    guide: 'https://www.jetbrains.com/help/ai-assistant/configure-an-mcp-server.html',
    locales: ['en'],
  },
  {
    slug: 'raycast',
    name: 'Raycast',
    surface: 'Raycast AI',
    category: 'assistant',
    logo: 'raycast',
    color: '#FF6363',
    auth: 'oauth',
    configFile: null,
    config: null,
    guide: 'https://manual.raycast.com/ai/model-context-protocol',
    locales: ['en'],
  },
  {
    slug: 'warp',
    name: 'Warp',
    surface: 'Warp agents',
    category: 'terminal',
    logo: 'warp',
    color: '#01A4FF',
    auth: 'oauth',
    configFile: null,
    config: null,
    guide: 'https://docs.warp.dev/agent-platform/capabilities/mcp/',
    locales: ['en'],
  },
  {
    slug: 'curl',
    name: 'curl and the raw API',
    shortName: 'curl',
    surface: 'any HTTP client, script or backend',
    category: 'terminal',
    logo: 'curl',
    color: '#073551',
    auth: 'apikey',
    configFile: 'terminal',
    config: (url) => `curl -X POST ${url} \\
  -H "Authorization: Bearer mcpe_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    guide: null,
    locales: ['en'],
  },
];

const BY_SLUG = new Map(CLIENTS.map((c) => [c.slug, c]));

export function getClient(slug) {
  return BY_SLUG.get(slug) ?? null;
}

export function clientLocales(slug) {
  return getClient(slug)?.locales ?? [];
}

/** Clients available in one locale, in registry order. */
export function clientsForLocale(locale) {
  return CLIENTS.filter((c) => c.locales.includes(locale));
}

/**
 * Sibling links for one client page.
 *
 * Same reasoning as the provider pages: with this site's backlink profile a
 * page reachable only from the sitemap is a page that does not get crawled
 * often enough to rank, so every page seeds the next few in its silo. Rotate
 * by slug so each page in a category seeds a different slice, then top up from
 * the other categories rather than shipping a stub list.
 */
export function relatedClients(slug, locale = 'en', limit = 6) {
  const self = getClient(slug);
  if (!self) return [];
  const pool = clientsForLocale(locale).filter((c) => c.slug !== slug);

  const rotate = (list) => {
    const start = Math.max(0, list.findIndex((c) => c.slug > slug));
    return [...list.slice(start), ...list.slice(0, start)];
  };

  const out = rotate(pool.filter((c) => c.category === self.category)).slice(0, limit);
  const taken = new Set(out.map((c) => c.slug));
  for (const c of rotate(pool.filter((x) => x.category !== self.category))) {
    if (out.length >= limit) break;
    if (!taken.has(c.slug)) {
      out.push(c);
      taken.add(c.slug);
    }
  }
  return out;
}
