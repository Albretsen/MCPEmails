export default {
  slug: 'how-to-give-your-ai-agent-email-access',
  title: 'How to Give Your AI Agent Access to Email (The Complete 2026 Guide)',
  description:
    'Give your AI agent read and send access to a real inbox over MCP — Gmail, Outlook, iCloud, Fastmail, or IMAP. How it works, the tools, security, and setup.',
  cover: '/blog/cover-how-to-give-your-ai-agent-email-access.svg',
  coverAlt: 'How to give your AI agent access to email over MCP — MCPEmails',
  authorId: 'asgeir',
  publishedAt: '2026-06-01T23:00:00.000Z',
  updatedAt: '2026-06-01T23:00:00.000Z',
  tags: ['MCP', 'AI agents', 'Email', 'Tutorial'],
  featured: true,
  content: `To give an AI agent access to email, you connect your inbox to an MCP server and point your agent at one endpoint URL. The agent then gets a small set of tools for reading, searching, and sending mail. The hard part isn't the agent — it's doing this without leaking your password into a prompt, a log, or a vector store. That last mile is what this guide is about.

If you just want the fast path: connect an inbox in the dashboard, paste the MCP endpoint into [claude.ai](https://claude.ai), Claude Desktop, Cursor, or your own agent, and call \`list_inboxes\` first. The rest of this post explains what's actually happening, why the security model matters, and how to wire up every supported provider.

## What "email over MCP" actually means

The [Model Context Protocol](https://modelcontextprotocol.io) is a standard way to expose tools to a language model over HTTP. An MCP email server presents your inbox not as raw IMAP, but as a handful of typed verbs the agent can call: list messages, read one, search, send, reply. The agent reasons over those verbs. It never touches the underlying mailbox protocol, and it never sees your credentials.

That's the whole idea behind [MCP Emails](/). One endpoint, one set of tools, any MCP-compatible client. If you want the ground-up explanation of the architecture, the companion post [what is an MCP email server](/blog/what-is-an-mcp-email-server) covers it in plain English.

## Why the last mile is hard

Hooking a model up to email looks trivial until you try it for real. Three things bite:

1. **Auth is different for every provider.** Gmail wants OAuth with specific scopes. Outlook wants Microsoft identity. iCloud and Fastmail want an app-specific password. Each has its own token refresh cycle and its own failure modes.
2. **Credentials are radioactive.** A mailbox password sitting in a chat transcript or a log line is a breach waiting to happen. You cannot let the model hold the secret.
3. **Email is shaped badly for agents.** MIME, threading headers, HTML versus plain text, attachments, folders that are really labels. The model needs a clean response, not RFC 5322.

The naive DIY fix — hand the model an IMAP library and your password — fails all three at once. Most "Gmail MCP server" repos on GitHub stop right there.

## How MCP Emails solves it

Four design decisions do the heavy lifting. They're the reason I trust this with my own inbox.

### Email is fetched live and never stored

Every tool call hits your provider in real time: the Gmail API, Microsoft Graph, or IMAP/SMTP. Message bodies, subjects, and attachments are handed to the agent and discarded immediately. Nothing is cached, indexed, or warehoused. The only thing persisted per inbox is the credential needed to make the next call. If you want the long version of why this matters, read [why "email never stored" matters](/blog/why-email-never-stored-matters).

### Credentials are AES-256-GCM encrypted at rest

The OAuth token or app password for each inbox is encrypted before it's written to the database. Decryption happens only inside an isolated Edge Function, at call time, using a key that lives as an environment secret separate from the database. So even a database leak hands an attacker ciphertext, not your inbox.

### Sending goes through your own provider

When the agent sends or replies, the mail leaves through your Gmail, your Microsoft 365, or your SMTP server. MCP Emails never relays from its own domain. Your deliverability and domain reputation stay entirely yours — no shared-IP spam-folder roulette.

### It's standard MCP over HTTP

The server speaks Streamable HTTP per the MCP 2025-06-18 spec. No SDK to install, no custom client. It drops into anything that speaks MCP.

## The tools your agent gets

Six core tools cover the whole surface area, plus a handful more for flags, folders, scheduling, and contacts. The agent always starts with \`list_inboxes\` to discover what's connected and grab each inbox's ID — it never hardcodes a UUID.

- \`list_inboxes\` — discover connected accounts and their capabilities
- \`list_messages\` — paginated, newest-first, per inbox
- \`read_email\` — parsed plain text, optional sanitized HTML, optional attachments
- \`search_emails\` — provider-native syntax (Gmail operators, Outlook KQL, IMAP text search)
- \`send_email\` — compose with CC/BCC, HTML, and attachments up to 10 MB total
- \`reply_to_email\` — same, and it sets the threading headers (In-Reply-To, References) for you

One honest limitation worth stating up front: this is **polling, not push**. There are no webhooks. To react to new mail, your agent polls on a schedule, for example \`list_messages\` with \`unread_only: true\`. Any auto-responder you build works on a timer, not an instant trigger. The [auto-responder build guide](/blog/build-email-auto-responder-mcp-agent) shows how to do this well.

A morning-triage run reads like this:

\`\`\`json
{
  "step1": "list_inboxes  → finds your work Gmail",
  "step2": "list_messages → last 24h, unread_only",
  "step3": "read_email    → full body for anything urgent",
  "step4": "reply_to_email → draft, or just summarize and wait"
}
\`\`\`

No password crossed the wire. The agent held capabilities, not credentials. For more ideas, see [7 things an AI agent can do with inbox access](/blog/7-things-ai-agent-can-do-with-inbox-access) and the deeper [triage and summarize walkthrough](/blog/ai-agent-triage-summarize-inbox).

## Supported providers and how each connects

You connect an inbox once in **Dashboard → Inboxes → Connect Inbox**. How you authenticate depends on the provider.

### OAuth providers (one click)

- **Gmail** — OAuth 2.0 via Google sign-in.
- **Outlook / Microsoft 365** — OAuth 2.0 via Microsoft sign-in. Setup details in [connect Outlook and Microsoft 365 to an AI agent](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

### App-password providers

iCloud, Fastmail, Yahoo, Zoho, Yandex, and any generic IMAP mailbox connect with an app-specific password rather than OAuth. You generate the password in your provider's security settings and paste it into MCP Emails. iCloud passwords come from appleid.apple.com; Fastmail is **app-password only** (create one in Fastmail settings). They all ride the same IMAP/SMTP transport and share an identical feature set. The full walkthrough lives in [connect iCloud, Fastmail, or any IMAP inbox to Claude](/blog/connect-icloud-fastmail-imap-to-claude).

## Connecting your AI client

Same endpoint, same tools, two ways in depending on whether your client speaks OAuth.

### OAuth-capable clients (no API key)

claude.ai, Claude Desktop, Cursor, and similar clients connect with OAuth 2.0 Authorization Code + PKCE and RFC 7591 Dynamic Client Registration. In claude.ai it's **Customize → Connectors → Add connector**, paste the MCP endpoint URL, click Connect, sign in to your MCP Emails account, and approve. Tokens are scoped to exactly what you approve: \`read:email\`, \`send:email\`, or both.

### Clients without OAuth (API key)

Cline, JetBrains, custom scripts, and raw cURL use a scoped API key. Create one in **Dashboard → API Keys**, pick its scopes, and copy it (it's shown once). Pass it as \`Authorization: Bearer <api-key>\`. Full setup for these is in [email for AI agents in Cursor, Cline, and VS Code](/blog/email-for-ai-agents-cursor-cline-vscode), and the trade-off between the two approaches is covered in [OAuth vs API keys for AI email access](/blog/oauth-vs-api-keys-ai-email-access).

Either way, you revoke any connection from the dashboard in one click. Grab the exact endpoint URL from [the docs](/docs) — copy it from there rather than typing it by hand.

## Is this safe? And the rate limits

Short answer: yes, and the [is it safe to give an AI agent email access](/blog/is-it-safe-to-give-ai-agent-email-access) post makes the full case. The model holds scoped capabilities, not your password; credentials are encrypted; nothing is stored; sending stays on your provider; access revokes in one click.

On rate limits, each API key is capped at 100 requests/min, 1,000/hour, and 10,000/day on every plan. There's also a per-workspace burst ceiling that scales with your plan — 60/min on Free, 300/min on Solo, 1,000/min on Team. When you hit a limit the server returns a retryable error with a \`retry_after\` value in seconds. Honor it. And never blindly auto-retry a \`send_email\` — you'll send duplicates.

## Pricing

Everything is unlimited on every plan: inboxes, tool calls, API keys, team members. Tiers differ only on burst rate, analytics retention, team features, and support.

- **Free — $0 forever.** No card. 60 req/min, 7-day analytics, community support.
- **Solo — $12/month** (or $120/year). 300 req/min, 90-day analytics, email support.
- **Team — $49/month** (or $490/year). 1,000 req/min, team roles and multiple workspaces, SSO with SAML/OIDC plus audit log, 1-year analytics, priority support.

Full breakdown on the [pricing page](/pricing).

## Get started

Connect an inbox, paste the endpoint into your agent, and call \`list_inboxes\`. That's the whole onboarding. [Start free](/signup) or skim the [quick-start](/docs#quickstart) — you'll have an agent reading real mail in a couple of minutes.`,
};
