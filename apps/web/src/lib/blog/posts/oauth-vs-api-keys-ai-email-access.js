const post = {
  slug: 'oauth-vs-api-keys-ai-email-access',
  title: 'OAuth vs. API Keys for AI Email Access: Which Should You Use?',
  description: 'OAuth vs. API keys for AI email access: use OAuth for claude.ai, Claude Desktop, and Cursor; use a scoped API key for Cline, JetBrains, and scripts.',
  cover: '/blog/cover-oauth-vs-api-keys-ai-email-access.svg',
  coverAlt: 'OAuth versus API keys for connecting AI agents to email — MCPEmails',
  authorId: 'asgeir',
  publishedAt: "2026-06-12T09:00:00.000Z",
  updatedAt: "2026-06-21T09:00:00.000Z",
  tags: ['OAuth', 'Security', 'MCP', 'Tutorial'],
  featured: false,
  content: `When you connect an AI agent to your email through MCP Emails, you authenticate one of two ways: OAuth or an API key. The short answer is OAuth if your client supports it (claude.ai, Claude Desktop, Cursor), and a scoped API key if it doesn't (Cline, JetBrains, scripts, cURL). Both hit the same endpoint and expose the same tools. The difference is who manages the secret and how easily you can pull the plug.

This isn't a security-vs-convenience tradeoff where you sacrifice one for the other. Both paths are scoped to exactly \`read:email\`, \`send:email\`, or both, and both can be revoked from the dashboard in one click. The real question is which fits the client you're actually using. For the bigger picture on how any of this connects, start with the pillar guide, [how to give your AI agent access to email](/blog/how-to-give-your-ai-agent-email-access).

## The 30-second recommendation

Use **OAuth** when your MCP client supports it. That covers claude.ai, Claude Desktop, and Cursor today. You paste one URL, sign in, approve the scopes, and you're done. No secret to copy, no secret to store, no secret to leak.

Use an **API key** when your client has no OAuth flow. Cline, the JetBrains AI assistant, a Python cron job, a shell script piping JSON-RPC over cURL — these need a bearer token. You create one in the dashboard, scope it, copy it once, and pass it in the \`Authorization\` header.

If both are options for the same client, pick OAuth. Fewer secrets in your config files is always the better default.

## How OAuth works here

OAuth is the no-key path. Instead of you generating a credential and pasting it somewhere, the client and the server negotiate one directly, and the token lives inside the client rather than in a config file you manage.

In claude.ai, the flow is: **Customize → Connectors → Add connector → paste the URL → Connect → sign in and approve.** The URL is the MCP endpoint, \`https://mcpemails.com/api/mcp\`. After you approve, the agent has access and you never touched a secret.

Under the hood it's standard, current OAuth:

- **Authorization Code + PKCE** (RFC 7636), so no client secret is ever transmitted. PKCE is the same mechanism that protects mobile and single-page app logins.
- **Dynamic Client Registration** (RFC 7591), so the client registers itself with no manual setup on your end.
- **Tokens refresh automatically** inside supported clients. You're not babysitting an expiry.
- **Scopes are exactly what you approve** on the consent screen: \`read:email\`, \`send:email\`, or both.

The practical upside: the token never appears as a plain string you could accidentally commit, log, or paste into the wrong chat. When you want to cut access, you revoke the connection in the dashboard and the agent is locked out immediately. For why that revocation actually matters, the inbox itself stays untouched because [email is never stored](/blog/why-email-never-stored-matters) on our side in the first place.

## How API keys work here

Some clients don't speak OAuth. That's not a knock on them. Cline, JetBrains, and anything you write yourself just expect a bearer token, which is the older and perfectly fine way to authenticate a machine.

You make one in **Dashboard → API Keys**:

1. Name the key something you'll recognize later (\`cline-laptop\`, \`triage-cron\`).
2. Choose its scopes: \`read:email\`, \`send:email\`, or both.
3. Copy it. It's shown **once** and never again. If you lose it, you make a new one.

The key looks like \`mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456\`, and you pass it on every request:

\`\`\`
Authorization: Bearer mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456
\`\`\`

A raw JSON-RPC call to list your inboxes looks like this:

\`\`\`json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "inbox_list", "arguments": {} }
}
\`\`\`

POST that to \`https://mcpemails.com/api/mcp\` with the bearer header and you get back your connected inboxes and their IDs. From there the agent calls \`email_read\` (with \`action\` set to list, read, or search) and \`email_compose\` (\`action\` send, reply, or forward) — the core tools, plus \`email_organize\`, \`folder\`, \`schedule\`, and \`contact_search\` for flags, folders, scheduling, and contacts.

The one thing API keys ask of you that OAuth doesn't: treat the key like a password. It's a long-lived secret in plain text. Put it in an environment variable, not in source you'll push to GitHub. If a key leaks, revoke it from the dashboard and rotate to a new one.

## Scopes: grant the minimum, every time

This part is identical for both methods, and it's the security control that does the most work. A connection that can only \`read:email\` cannot send anything, no matter what the agent decides to do. If you're building a [summarize-and-triage workflow](/blog/ai-agent-triage-summarize-inbox), grant read-only. The agent reads, ranks, and reports, and there's no path for a confused or manipulated model to fire off a message.

Only add \`send:email\` when sending is the actual job, like an [auto-responder built on the MCP tools](/blog/build-email-auto-responder-mcp-agent). Even then, scope a separate key or connection per task rather than one all-powerful credential you reuse everywhere. Least privilege isn't paranoia. It's the cheapest insurance you'll buy.

## So which should you use?

### Use OAuth if...

Your client is claude.ai, Claude Desktop, or Cursor. You want zero secrets in your config. You want token refresh handled for you. You want the cleanest possible revoke story. This is the default and you should reach for it first.

### Use an API key if...

Your client has no OAuth support — Cline, JetBrains, the OpenAI-style tool runners, or your own code. You're scripting against the endpoint with cURL or a small program. You need a stable credential a headless process can use without a human clicking through a consent screen. A scoped key is exactly right here, and there's a full walkthrough for the [Cursor, Cline, and VS Code clients](/blog/email-for-ai-agents-cursor-cline-vscode).

One more thing that's true regardless of which you pick: rate limits. Every API key is capped at 100 requests/minute, 1,000/hour, and 10,000/day, and each workspace has a burst ceiling by plan (60/min on [Free](/pricing), up to 1,000/min on Team). When you hit a limit the server hands back a \`retry_after\` value in seconds. Honor it, and never blind-retry an \`email_compose\` send — you'll double-send.

## The bottom line

OAuth and API keys aren't a security ranking. They're a match to your client. OAuth is the better default because it keeps secrets out of your hands entirely, but a scoped, well-stored API key is genuinely safe for the clients and scripts that need one. Pick the scopes carefully, store keys in env vars, and revoke anything you're not using.

Ready to wire one up? Connecting an inbox and a client takes about [two minutes end to end](/blog/connect-email-to-ai-agent-under-2-minutes), or you can read the full [docs](/docs) and [start free](/signup).`,
};

export default post;
