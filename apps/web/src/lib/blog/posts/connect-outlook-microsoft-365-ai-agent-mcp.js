export default {
  slug: 'connect-outlook-microsoft-365-ai-agent-mcp',
  title: 'Connecting Outlook and Microsoft 365 to Your AI Agent via MCP',
  description:
    'Connect Outlook or Microsoft 365 to your AI agent over MCP in minutes. Microsoft sign-in OAuth, Graph under the hood, read/search/send/reply — no custom server.',
  cover: '/blog/cover-connect-outlook-microsoft-365-ai-agent-mcp.svg',
  coverAlt: 'Connecting Outlook and Microsoft 365 to an AI agent over MCP',
  authorId: 'asgeir',
  publishedAt: "2026-05-18T09:00:00.000Z",
  updatedAt: "2026-05-18T09:00:00.000Z",
  tags: ['Outlook', 'Tutorial', 'MCP', 'AI agents'],
  featured: false,
  // Outlook / Microsoft 365 is built but not yet generally available ("coming
  // soon"). Keep this post reachable for early readers but out of search
  // indexes and the sitemap until the connector ships, so we don't promise a
  // live connect flow we can't yet deliver. See the disclaimer at the top of
  // the content below.
  noindex: true,
  content: `> **Coming soon.** Outlook and Microsoft 365 support is built but not yet generally available. You can't connect an Outlook mailbox in production today — this guide previews how it will work once the connector ships. For inboxes you can connect right now, see [Gmail and IMAP](/docs/providers).

To connect an Outlook or Microsoft 365 mailbox to your AI agent, you sign in to MCP Emails, add the inbox with Microsoft OAuth, and point your agent at one MCP endpoint. No app registration, no Azure portal, no custom Graph server. The whole thing takes about two minutes, and your agent gets read, search, send, reply, flags, and folders against the live mailbox.

Most "AI for email" guides assume Gmail and stop there. Outlook gets a shrug and a link to some half-maintained GitHub repo. If you live in Microsoft 365 for work, that's the wrong end of the stick. This post is the Outlook-first version: what actually works, how the Microsoft sign-in flows, what runs underneath, and where the personal-vs-work-account edges are.

## Why Outlook is harder than it looks (and why that's not your problem here)

Microsoft email is not one thing. There's consumer Outlook.com / Hotmail / Live, and there's Microsoft 365 work and school accounts living in Entra ID (the identity service formerly called Azure AD). They authenticate differently, and a work tenant can have conditional access policies, admin consent requirements, and MFA rules layered on top.

The DIY path means registering an application in the Azure / Entra portal, picking the right supported account types, requesting Microsoft Graph scopes like \`Mail.Read\` and \`Mail.Send\`, wiring a redirect URI, handling token refresh, and then writing the Graph calls to list, read, and send mail. People burn an afternoon on this and end up maintaining a tiny server forever. I've watched it happen.

MCP Emails does that registration and token plumbing once, centrally, so you don't. You click "sign in with Microsoft," approve, and you're connected. If you want the conceptual background on why this layer exists at all, the [complete guide to giving your AI agent email access](/blog/how-to-give-your-ai-agent-email-access) is the pillar to start from.

## Connect your Outlook / Microsoft 365 inbox

Two parts: connect the mailbox, then connect the agent. They're separate on purpose — the mailbox connection authorizes MCP Emails to reach your provider, and the agent connection authorizes your client to reach MCP Emails.

### Step 1 — Add the inbox

1. [Start free](/signup) and open the dashboard.
2. Go to **Inboxes → Connect Inbox**.
3. Pick **Outlook / Microsoft 365**.
4. You're handed to Microsoft's own sign-in page. Enter your work or personal Microsoft account, complete MFA if your tenant requires it, and review the consent screen.
5. Approve. Microsoft hands back an OAuth token, MCP Emails encrypts it (AES-256-GCM) and stores only that token. Nothing else about your mailbox is persisted.

This is OAuth 2.0 — the same model Gmail uses. You never paste an Outlook password into MCP Emails, and there's no app password to generate. That's the key difference from the IMAP providers; if you're connecting [iCloud, Fastmail, or a generic IMAP mailbox](/blog/connect-icloud-fastmail-imap-to-claude), those use an app-specific password instead, because they don't offer OAuth for third-party clients.

### Step 2 — Connect your agent

You connect a client once, and the same setup works for every inbox on your account. For OAuth-capable clients (claude.ai, Claude Desktop, Cursor), in claude.ai it's:

**Customize → Connectors → Add connector → paste the URL → Connect → sign in & approve.**

The endpoint is:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

When you click Connect, you sign in to your MCP Emails account and approve scopes — \`read:email\`, \`send:email\`, or both. No API key changes hands; it uses OAuth 2.0 Authorization Code with PKCE and dynamic client registration under the hood.

For clients that don't speak OAuth (Cline, JetBrains plugins, your own scripts, raw cURL), generate a scoped key in **Dashboard → API Keys**, pick scopes, and send it as \`Authorization: Bearer <api-key>\`. The full walk-through for those clients lives in [email for AI agents in Cursor, Cline, and VS Code](/blog/email-for-ai-agents-cursor-cline-vscode). If you're weighing the two approaches, [OAuth vs API keys for AI email access](/blog/oauth-vs-api-keys-ai-email-access) lays out the trade-offs.

## Microsoft Graph, under the hood

Once connected, every tool call your agent makes goes out to Microsoft Graph in real time. Read a message, and MCP Emails calls Graph, hands the parsed result to your agent, and discards it. Send a message, and it goes through Graph on your behalf — from your real address, through Microsoft's infrastructure, so your domain's deliverability and reputation stay yours. MCP Emails never relays mail from its own domain.

The practical upshot: the mail your agent sends looks exactly like mail you sent, because it is. It lands in your Sent Items. Replies thread correctly because the reply tool sets the In-Reply-To and References headers for you.

## Personal vs work/school accounts

Both work. A consumer Outlook.com account and a Microsoft 365 work/school account both connect through the same Microsoft sign-in flow, and both expose the same tools to your agent.

The one place reality intrudes is the consent screen on work/school accounts. If your IT admin has locked down third-party app consent in your tenant — which plenty of larger orgs do — you may see "approval required" instead of a normal consent prompt, and the connection waits on an administrator. That's not an MCP Emails limitation; it's your tenant's policy, and it would block any third-party client identically. For a personal account, or a tenant that permits user consent, you approve it yourself and you're done.

## What works once it's connected

Your agent gets the core consolidated tools plus the extras Outlook supports:

- \`inbox_list\` — always call this first. It returns your connected mailboxes and their \`inbox_id\` UUIDs so the agent never guesses an ID.
- \`email_read\` — one tool, several actions: \`list\` (newest-first, paginated, with filters like \`unread_only\`), \`read\` (parsed plain text, optional sanitized HTML, optional attachments), and \`search\` (see the search note below).
- \`email_compose\` — the \`send\` action composes with CC/BCC, HTML, and attachments up to 10 MB total; the \`reply\` and \`forward\` actions thread correctly with the right headers.
- \`email_organize\` — marking read/unread, flagging, archiving, deleting, and moving, each via its own \`action\`.

Beyond those, Outlook supports marking read/unread, flagging (Outlook's "flag" maps to the starred/flagged concept), forwarding, and moving between folders. Check the live [docs](/docs) for the current capability list before you build against a specific tool.

### Search uses Microsoft's \`$search\`

Outlook search isn't Gmail search. Where Gmail takes operators like \`from:\` and \`is:unread\`, \`email_read\` with the \`search\` action against an Outlook inbox passes your query to Microsoft Graph's \`$search\`, which does relevance-ranked full-text matching across the mailbox and also accepts KQL. So a query like \`invoice from accounting last week\` works as natural language, and you can get more precise with KQL like \`from:finance@acme.com AND subject:invoice\`. If you write prompts that hardcode Gmail operators, they won't behave the same way on Outlook — tell your agent to search in plain language and let Graph rank.

## A workflow worth setting up

Here's a triage loop I run against a Microsoft 365 inbox. Once or twice an hour, the agent:

1. Calls \`email_read\` with the \`list\` action and \`unread_only: true\`.
2. Reads anything that looks time-sensitive with \`email_read\`'s \`read\` action.
3. Summarizes the batch and drafts replies for the ones I'd obviously answer.
4. Leaves everything unread until I confirm.

One honest caveat: MCP Emails is poll-based. There are no webhooks and no server push, so the agent checks on a schedule rather than getting pinged the instant mail arrives. For triage that's fine — you set the cadence. If you're building something more reactive, read [how to triage and summarize an inbox](/blog/ai-agent-triage-summarize-inbox) for the polling patterns that hold up.

## Compared to building your own M365 server

The self-hosted Outlook MCP servers floating around GitHub all hit the same wall: the Entra app registration and Graph token lifecycle are the actual work, and you own them forever. You handle refresh tokens, scope changes when Microsoft adjusts Graph, and the security of wherever those tokens sit. With the hosted approach, the token is encrypted at rest, decrypted only inside an isolated function at call time, and revocable from the dashboard in one click. If you want the full comparison, [hosted vs self-hosted](/blog/hosted-vs-self-hosted-gmail-mcp-server) goes deep on the trade-offs.

Connecting Outlook costs nothing to try — the [Free plan](/pricing) connects one inbox at 60 requests per minute, with no card required. Add your Microsoft 365 mailbox, point Claude at the endpoint, and give it something to read.`,
};
