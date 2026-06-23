export default {
  slug: 'connect-gmail-to-claude',
  title: 'How to Connect Gmail to Claude (in 2 Minutes, No Code)',
  description:
    'Connect Gmail to Claude over MCP in about two minutes: one Google sign-in, one endpoint URL, no API key, no code. Claude reads, searches, and sends your mail live — and your email is never stored.',
  cover: '/blog/cover-connect-gmail-to-claude.svg',
  coverAlt:
    'How to connect Gmail to Claude in two minutes over MCP — one Google sign-in, one endpoint URL, no email stored',
  authorId: 'asgeir',
  publishedAt: '2026-06-23T09:00:00.000Z',
  updatedAt: '2026-06-23T09:00:00.000Z',
  tags: ['Tutorial', 'Gmail', 'Claude', 'MCP'],
  featured: false,
  content: `To connect Gmail to Claude, you do two things: connect your Gmail inbox once in the MCP Emails dashboard, then paste a single endpoint URL into Claude's connector settings and approve a sign-in. That's the whole job — no code, no SDK, no API key. It takes about two minutes, and Claude never stores your email: every read and send hits the Gmail API live and is discarded the moment Claude has it.

This is the focused, Gmail-only walkthrough. If you run several mailboxes or a non-Gmail provider, the [connect any email in under two minutes](/blog/connect-email-to-ai-agent-under-2-minutes) guide covers Outlook, iCloud, Fastmail, and IMAP too.

## What you'll need

- A **Gmail or Google Workspace** account.
- A version of **Claude that supports custom connectors** — claude.ai on a paid plan, or Claude Desktop. (Connectors are how Claude talks to MCP servers.)
- A free **MCP Emails** account. No credit card, unlimited inboxes and calls. [Start free](/signup) and keep this tab open.

MCP Emails is the bridge in the middle: it speaks the Model Context Protocol to Claude on one side and the Gmail API to Google on the other. If you want the background on what that means, see [what an MCP email server actually is](/blog/what-is-an-mcp-email-server).

## Step 1: Connect your Gmail inbox

In the MCP Emails dashboard, open **Inboxes → Connect Inbox → Gmail** and click **Connect with Google**.

1. You're sent to Google's normal sign-in. Pick the account you want Claude to use.
2. Approve read and send access on Google's consent screen.
3. You land back in the dashboard with the inbox connected. Done.

No password ever changes hands. MCP Emails receives an OAuth token from Google, encrypts it with AES-256-GCM, and calls the Gmail API directly on each request. Because it uses Gmail's own API, your agent's searches can use native operators like \`from:\`, \`is:unread\`, and \`after:\` — so Claude can be precise instead of guessing.

> One honest note: while MCP Emails finishes Google's security review, the consent flow may show a "Google hasn't verified this app" screen. To proceed, click **Advanced**, then **Go to mcpemails.com**. This screen disappears once verification completes.

## Step 2: Add MCP Emails to Claude

Now point Claude at the same endpoint. Because Claude is an OAuth client, you don't need an API key at all — you paste one URL and approve a sign-in.

1. In **claude.ai or Claude Desktop**, open **Settings → Connectors**.
2. Click **Add custom connector**.
3. Paste this as the connector URL, then click **Add**:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Click **Connect**, sign in with your MCP Emails account, and approve the scopes you want — \`read:email\`, \`send:email\`, or both.

That's the entire client side. The connection is scoped to exactly what you approved, and you can revoke it from the dashboard in one click. If you'd rather understand the API-key path (for clients without built-in OAuth, like Cline or a custom script), read [OAuth vs API keys for AI email access](/blog/oauth-vs-api-keys-ai-email-access).

## Step 3: Ask Claude your first prompt

Test it with something small. Ask Claude:

> "Summarize my three most recent unread emails."

Behind the scenes Claude calls \`inbox_list\` to discover your connected Gmail, then \`email_read\` to list and read the messages. If it answers, your connection is live. From there, try:

- "Find the invoice from Stripe last month and tell me the amount."
- "Draft a polite reply to the last email from my landlord, but don't send it yet."
- "Archive every newsletter in my inbox from this week."
- "What did I agree to in my email thread with Acme?"

For a deeper set of patterns — daily triage, auto-summaries, and clean-up routines — see [the best ways to let Claude manage your inbox](/blog/best-ways-to-let-claude-manage-your-inbox) and the [triage-and-summarize playbook](/blog/ai-agent-triage-summarize-inbox).

## What Claude can do with your Gmail

Once connected, Claude works through a small set of consolidated tools, so it can do far more than read:

- **Read & search** — \`email_read\` (list, read, full-text search with Gmail operators).
- **Send & reply** — \`email_compose\` (send, reply, forward) — messages go out through Gmail as normal mail from your own address, so your domain reputation stays yours.
- **Organize** — \`email_organize\` (move, label, flag, archive).
- **Drafts, folders, scheduling, contacts** — \`draft\`, \`folder\`, \`schedule\`, and \`contact_search\` round out the set.

One thing to expect up front: MCP Emails is poll-based. There are no push webhooks, so Claude reacts to new mail when you ask it to check, not the instant a message arrives. For almost every assistant workflow, that's exactly the right model.

## Is it safe to connect Gmail to Claude?

Short version: yes, and the design is built around it.

- **Your email is never stored.** Bodies, subjects, and attachments are fetched live on each call, handed to Claude, and dropped immediately. The only thing persisted per inbox is your encrypted OAuth token. Here's [why "email is never stored" actually matters](/blog/why-email-never-stored-matters).
- **You control scope.** Approve read-only and Claude literally cannot send. Approve both and you can still revoke either at any time.
- **No password sharing.** Gmail uses OAuth, so MCP Emails never sees your Google password, and you can disconnect from your Google account settings too.

The full threat model — what's encrypted, what an attacker would and wouldn't see — is laid out in [is it safe to give an AI agent email access?](/blog/is-it-safe-to-give-ai-agent-email-access)

## FAQ

**Do I need an API key to connect Gmail to Claude?**
No. Claude supports OAuth, so you paste the endpoint URL and approve a sign-in. API keys are only for clients without built-in OAuth.

**Does Claude store my Gmail messages?**
No. Email is fetched live from the Gmail API on every request and discarded right after Claude reads it. Nothing is retained except your encrypted access token.

**Can Claude send email from my Gmail?**
Yes, if you grant the \`send:email\` scope. Sends go through the Gmail API as normal messages from your own account. Grant read-only if you'd rather Claude never send.

**Does this work with the free Claude plan?**
Custom connectors require a Claude plan that supports them (claude.ai paid or Claude Desktop). The MCP Emails side is free with no card.

**Will MCP Emails see my Google password?**
No. The Gmail connection uses Google OAuth, so your password never leaves Google.

## Wrap-up

That's the whole thing: one Google sign-in, one endpoint URL, and Claude can read, search, and send your real mail — without ever storing it. Every plan is unlimited on inboxes, calls, and keys, and the Free tier costs nothing and needs no card (see [pricing](/pricing) if you need higher burst limits or SSO).

Ready? [Connect your Gmail free](/signup), paste the endpoint into Claude, and ask it to summarize your unread mail.`,
};
