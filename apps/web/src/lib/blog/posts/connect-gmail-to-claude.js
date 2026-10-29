const post = {
  slug: 'connect-gmail-to-claude',
  title: 'How to Connect Gmail to Claude: Built-in Connector or MCP',
  description:
    "Claude's built-in Gmail connector covers one Gmail account inside Claude. When you also need Outlook, IMAP, several inboxes or other AI apps, connect Gmail to Claude over MCP in two minutes with an app password and one URL.",
  cover: '/blog/cover-connect-gmail-to-claude.svg',
  coverAlt:
    'How to connect Gmail to Claude in two minutes over MCP: a Google app password, one endpoint URL, no email stored',
  authorId: 'asgeir',
  publishedAt: '2026-06-23T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  tags: ['Tutorial', 'Gmail', 'Claude', 'MCP'],
  featured: false,
  content: `Claude has its own Gmail connector. If all you want is one Gmail account inside Claude, switch that on in Claude's connector settings and you are done. MCPEmails fits when you need more: Outlook, iCloud, Yahoo or any IMAP mailbox next to Gmail, several inboxes in one chat, or the same inbox in ChatGPT, Cursor and other MCP apps. The rest of this guide sets that up.

To connect Gmail to Claude through MCPEmails, you do two things: connect your Gmail inbox once in the MCPEmails dashboard with a Google app password, then paste a single endpoint URL into Claude's connector settings and approve a sign-in. That's the whole job: no code, no SDK, no API key. It takes about two minutes, and Claude never stores your email: every read and send goes to Gmail live and is discarded the moment Claude has it.

This is the focused, Gmail-only walkthrough. If you run several mailboxes or a non-Gmail provider, the [connect any email in under two minutes](/blog/connect-email-to-ai-agent-under-2-minutes) guide covers Outlook, iCloud, Fastmail, and IMAP too.

## What you'll need

- A **Gmail or Google Workspace** account.
- **Claude** on the web (claude.ai) or in Claude Desktop. Every Claude plan can add custom connectors, which are how Claude talks to MCP servers. The Free plan allows one, and Pro and Max have no limit.
- A free **MCPEmails** account. No credit card, one connected inbox, forever. [Start free](/signup) and keep this tab open.

MCPEmails is the bridge in the middle: it speaks the Model Context Protocol to Claude on one side and talks to Gmail on the other over IMAP and SMTP. If you want the background on what that means, see [what an MCP email server actually is](/blog/what-is-an-mcp-email-server).

## Step 1: Connect your Gmail inbox

In the MCPEmails dashboard, open **Inboxes → Connect Inbox** and choose **Gmail**. Gmail connects with a Google app password by default:

1. Turn on 2-Step Verification in your Google account if it is not on already. Google only offers app passwords on accounts that have it.
2. Go to **myaccount.google.com/apppasswords** and create one. It is 16 lowercase letters in four groups, and the spaces do not matter.
3. Back in MCPEmails, enter your full Gmail address, paste the app password, and click **Connect inbox**. The connection is tested against Gmail before it is saved. Done.

Your normal Google password is never used. The app password is a separate credential, MCPEmails encrypts it with AES-256-GCM, and you can revoke it from the same Google page at any time. Underneath, the inbox connects over IMAP and SMTP (\`imap.gmail.com\`).

### On a Google Workspace account

A Google Workspace administrator can switch app passwords off for the whole domain. If **myaccount.google.com/apppasswords** is not available to you, ask your admin to turn app passwords on. The [Gmail settings and limits](/connect/gmail) page collects the Gmail-specific details in one place.

## Step 2: Add MCPEmails to Claude

Now point Claude at the same endpoint. Because Claude is an OAuth client, you don't need an API key at all: you paste one URL and approve a sign-in.

1. In **claude.ai or Claude Desktop**, open **Customize → Connectors**.
2. Click **+ Add**, then **Add custom connector**.
3. Name it MCPEmails and paste this as the connector URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Click **Continue**, review the sign-in settings Claude detected (the defaults are fine), and click **Add**.
5. Sign in with your MCPEmails account and approve the scopes you want: \`read:email\`, \`send:email\`, or both.
6. In a chat, click **+** at the lower left, choose **Connectors** and switch MCPEmails on.

On a Team or Enterprise plan, an Owner adds the connector once under **Organization settings → Connectors**. Members then open **Customize → Connectors**, find MCPEmails and click **Connect**.

That's the entire client side. The connection is scoped to exactly what you approved, and you can revoke it from the dashboard in one click. If you'd rather understand the API-key path (for clients without built-in OAuth, like Cline or a custom script), read [OAuth vs API keys for AI email access](/blog/oauth-vs-api-keys-ai-email-access). Connecting a different inbox too? The [step-by-step Claude email setup](/blog/connect-claude-to-email) covers Outlook, iCloud, Fastmail and IMAP.

## Step 3: Ask Claude your first prompt

Test it with something small. Ask Claude:

> "Summarize my three most recent unread emails."

Behind the scenes Claude calls \`inbox_list\` to discover your connected Gmail, then \`email_read\` to list and read the messages. If it answers, your connection is live. From there, try:

- "Find the invoice from Stripe last month and tell me the amount."
- "Draft a polite reply to the last email from my landlord, but don't send it yet."
- "Archive every newsletter in my inbox from this week."
- "What did I agree to in my email thread with Acme?"

For a deeper set of patterns (daily triage, auto-summaries, and clean-up routines), see [the best ways to let Claude manage your inbox](/blog/best-ways-to-let-claude-manage-your-inbox) and the [triage-and-summarize playbook](/blog/ai-agent-triage-summarize-inbox).

## What Claude can do with your Gmail

Once connected, Claude works through a small set of consolidated tools, so it can do far more than read:

- **Read & search:** \`email_read\` (list, read, and search by sender, recipient, subject, unread status or date range).
- **Send & reply:** \`email_compose\` (send, reply, forward). Messages go out through Gmail as normal mail from your own address, so your domain reputation stays yours.
- **Organize:** \`email_organize\` (move, copy, flag, archive). Gmail labels show up as folders, so a message with several labels appears in several folders, moving it changes its labels, and archiving removes it from the Inbox.
- **Drafts, folders, scheduling, contacts:** \`draft\`, \`folder\`, \`schedule\`, and \`contact_search\` round out the set.

One thing to expect up front: MCPEmails is poll-based. There are no push webhooks, so Claude reacts to new mail when you ask it to check, not the instant a message arrives. For almost every assistant workflow, that's exactly the right model.

## Is it safe to connect Gmail to Claude?

Short version: yes, and the design is built around it.

- **Your email is never stored.** Bodies, subjects, and attachments are fetched live on each call, handed to Claude, and dropped immediately. The only thing persisted per inbox is the encrypted credential, your app password. Here's [why "email is never stored" actually matters](/blog/why-email-never-stored-matters).
- **You control scope.** Approve read-only and Claude literally cannot send. Approve both and you can still revoke either at any time.
- **No password sharing.** Your normal Google password never reaches MCPEmails. An app password is a separate credential you can revoke at myaccount.google.com/apppasswords at any time, or you can delete the inbox in MCPEmails.

The full threat model (what's encrypted, what an attacker would and wouldn't see) is laid out in [is it safe to give an AI agent email access?](/blog/is-it-safe-to-give-ai-agent-email-access)

## FAQ

**Do I need an API key to connect Gmail to Claude?**
No. Claude supports OAuth, so you paste the endpoint URL and approve a sign-in. API keys are only for clients without built-in OAuth.

**Does Claude store my Gmail messages?**
No. Email is fetched live from Gmail on every request and discarded right after Claude reads it. Nothing is retained except your encrypted credential (the app password).

**Can Claude send email from my Gmail?**
Yes, if you grant the \`send:email\` scope. Sends go out through Gmail as normal messages from your own account. Grant read-only if you'd rather Claude never send.

**Does this work with the free Claude plan?**
Yes. Claude's Free plan can add one custom connector, which is enough for MCPEmails, and Pro and Max have no limit. The MCPEmails side is free with no card.

**Will MCPEmails see my Google password?**
No. You paste an app password, a separate credential that Google generates and you can revoke at any time. Your normal Google password is never entered anywhere in MCPEmails.

## Wrap-up

That's the whole thing: one Google app password, one endpoint URL, and Claude can read, search, and send your real mail, without ever storing it. The Free tier costs nothing, needs no card, and connects one inbox; Personal is $9/month for up to three inboxes, and Pro connects up to 10 (see [pricing](/pricing)).

Ready? [Connect your Gmail free](/signup), paste the endpoint into Claude, and ask it to summarize your unread mail.`,
};

export default post;
