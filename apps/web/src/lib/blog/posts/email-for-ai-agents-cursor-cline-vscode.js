export default {
  slug: 'email-for-ai-agents-cursor-cline-vscode',
  title: 'Setting Up Email for AI Agents in Cursor, Cline, and VS Code',
  description: 'Give your coding agent email access in Cursor, Cline, and VS Code. Cursor uses OAuth; Cline and custom clients use a scoped API key over MCP. Full setup.',
  cover: '/blog/cover-email-for-ai-agents-cursor-cline-vscode.svg',
  coverAlt: 'Setting up email access for AI coding agents in Cursor, Cline, and VS Code over MCP',
  authorId: 'asgeir',
  publishedAt: "2026-05-23T09:00:00.000Z",
  updatedAt: "2026-05-23T09:00:00.000Z",
  tags: ['Cursor', 'Tutorial', 'MCP', 'AI agents'],
  featured: false,
  content: `Here's the short version. To give a coding agent in your editor access to a real inbox, point it at one MCP endpoint: \`https://www.mcpemails.com/api/mcp\`. Cursor speaks OAuth, so you paste that URL and sign in. Cline, the raw VS Code MCP config, and any custom script don't do the OAuth dance, so they authenticate with a scoped API key sent as an \`Authorization: Bearer\` header. Same endpoint, same tools, two ways in.

This guide covers both paths, shows how to mint an API key scoped to exactly \`read:email\` and \`send:email\`, and ends with a dev workflow I actually use: the agent triages my inbox and sends replies without me leaving the editor. If you want the wider picture first, the pillar guide on [how to give your AI agent access to email](/blog/how-to-give-your-ai-agent-email-access) is the place to start.

## Before you wire up any client: connect an inbox

The MCP server doesn't own your mail. It brokers a live connection to whatever provider you already use, fetches messages at call time, and discards them. Nothing about your email is stored. So step one happens in the dashboard, not in your editor.

Go to **Dashboard → Inboxes → Connect Inbox** and pick a provider:

- **Gmail** or **Outlook / Microsoft 365** → one-click OAuth. Sign in with Google or Microsoft and approve.
- **iCloud, Fastmail, Yahoo, Zoho, or any generic IMAP host** → an app-specific password. Generate it in the provider's settings (for iCloud that's appleid.apple.com) and paste it in.

Fastmail is app-password only, not OAuth, so don't go hunting for a Google-style consent screen there. If you're on iCloud or Fastmail, the [iCloud, Fastmail, and IMAP setup walkthrough](/blog/connect-icloud-fastmail-imap-to-claude) has the per-provider details. On Outlook, see [connecting Outlook and Microsoft 365](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

Once an inbox is connected, your agent reaches it through tools. You never paste a UUID or a password into your editor config.

## Cursor: paste the URL, sign in, done

Cursor supports OAuth 2.0 for MCP servers, which is the painless path. There's no API key and no secret to manage in a config file.

1. Open Cursor settings and find the MCP servers section.
2. Add a new server with the URL \`https://www.mcpemails.com/api/mcp\`.
3. Cursor opens a browser window. Sign in to your MCP Emails account and approve the scopes you want the agent to have — \`read:email\`, \`send:email\`, or both.
4. The connection goes green and the email tools appear in Cursor's tool list.

Under the hood that's OAuth 2.0 authorization code with PKCE, and the token Cursor holds is scoped to exactly what you approved. If you only granted \`read:email\`, the agent literally cannot send. When you're done, revoke the connection from **Dashboard → API Keys** (OAuth grants live there too) in one click, and Cursor's access dies immediately.

Claude Desktop and claude.ai follow the same paste-and-approve flow if you also run them.

## Cline, raw VS Code, and custom scripts: use an API key

Cline, the bare \`mcp\` config in VS Code, JetBrains, and anything you script yourself don't implement the OAuth handshake. For those you create an API key and send it as a bearer token. This is also the right call for CI jobs and cron-driven automation where there's no human to click an approval screen.

### Step 1: create a scoped API key

In **Dashboard → API Keys**, click **Create key**. Name it something you'll recognize later (\`cline-laptop\`, \`triage-cron\`), then pick its scopes:

- \`read:email\` for list, search, and read.
- \`send:email\` for send and reply.

Grant only what the client needs. A read-only triage assistant has no business holding \`send:email\`. The key is shown exactly once — copy it the moment it appears, because you can't view it again. Lose it and you rotate it, you don't recover it.

### Step 2: put the key in your client config

For Cline (and most VS Code MCP setups), add the server to the MCP config JSON with the bearer header:

\`\`\`json
{
  "mcpServers": {
    "mcpemails": {
      "url": "https://www.mcpemails.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

A raw cURL call to confirm the key works before touching any editor:

\`\`\`bash
curl -s https://www.mcpemails.com/api/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

If you get a tool list back, you're connected. A \`-32001\` error means the key is bad or missing a scope — that one is not retryable, so fix the key rather than looping. Don't commit the key. Read it from an environment variable and keep it out of git. If you're weighing which auth model to use where, [OAuth vs API keys for AI email access](/blog/oauth-vs-api-keys-ai-email-access) lays out the trade-offs.

## The tools your agent gets

Both paths expose the same surface. A handful of consolidated, action-based tools cover the work:

- \`inbox_list\` — always call this first to discover connected inboxes and their IDs.
- \`email_read\` (action \`list\`) — paginated, newest-first.
- \`email_read\` (action \`read\`) — parsed plain text, optional sanitized HTML, attachments.
- \`email_read\` (action \`search\`) — provider-native search (Gmail operators, Outlook KQL, IMAP text).
- \`email_compose\` (action \`send\`) — compose with CC/BCC, HTML, attachments up to 10 MB.
- \`email_compose\` (action \`reply\`) — sets In-Reply-To and References headers for you so the thread stays intact.

There are more for flags and moves (\`email_organize\`), folders, scheduled send, and contacts, but those few do the bulk of real work.

## A dev workflow that earns its keep

Here's where it pays off. I keep a read+send key wired into my editor and lean on the agent during the parts of the day I'd otherwise lose to the inbox.

Morning triage, typed straight into the chat panel:

> Call inbox_list, then list unread from my work inbox in the last 12 hours. Group them: needs a reply, FYI, and noise. For the FYI bucket give me one line each.

The agent runs \`inbox_list\`, then \`email_read\` with action \`list\` and \`unread_only\` set, reads the ones that matter, and hands back a sorted digest. When I spot one I want answered, I follow up:

> Reply to the message from the design contractor confirming Thursday at 2pm works, keep it short.

It calls \`email_compose\` with action \`reply\`, threading is handled, and the reply leaves through my own Gmail — so it lands from my address with my domain's reputation, not some relay. For a deeper treatment of triage prompts, see [how to make an AI agent triage and summarize your inbox](/blog/ai-agent-triage-summarize-inbox).

One honest limitation: there are no webhooks. The server doesn't push you new mail. If you want the agent to react to incoming messages, you poll — \`email_read\` with action \`list\` and \`unread_only: true\` on a schedule. That's a deliberate design choice, and it shapes how you build anything reactive, like an [auto-responder over MCP](/blog/build-email-auto-responder-mcp-agent).

## Rate limits for scripted access

If you're driving the server from a cron job or a tight agent loop, mind the limits. Every API key is capped at **100 requests per minute, 1,000 per hour, and 10,000 per day**, on every plan. On top of that there's a per-workspace burst ceiling set by your plan: 60/min on Free, 300/min on Solo ($12/month), 1,000/min on Team ($49/month). See the [pricing page](/pricing) for the full breakdown.

When you hit a limit the server returns a retryable error (code \`-32029\`) with \`data.retry_after\` in seconds. Honor it — back off for that long and try again. And never blind-retry an \`email_compose\` send on a generic failure; you'll fire duplicates. Check whether it actually sent first.

## Wrapping up

Cursor gets you connected with a URL and a sign-in. Everything else takes a scoped key and a bearer header. Both hit the same endpoint and the same tools, and both keep your credentials out of your repo and out of the model's context.

[Start free](/signup) and connect your first inbox, or read the [docs](/docs) for the full tool reference.`,
};
