export default {
  slug: 'connect-claude-to-email',
  title: 'Connect Claude to Your Email with MCP (Gmail, iCloud & IMAP)',
  description:
    'A practical guide to connecting Claude to Gmail, iCloud, Fastmail, Yahoo, Zoho, and any IMAP inbox over MCP — no code and no email stored. Outlook support is in progress.',
  cover: '/blog/cover-connect-email-to-ai-agent-under-2-minutes.svg',
  coverAlt:
    'Connect Claude to Gmail, Outlook, iCloud, Fastmail, Yahoo, Zoho, and IMAP email with MCP Emails',
  authorId: 'asgeir',
  publishedAt: '2026-07-28T09:00:00.000Z',
  updatedAt: '2026-07-28T09:00:00.000Z',
  tags: ['Claude', 'MCP', 'Email', 'Tutorial'],
  featured: false,
  content: `> **Outlook and Microsoft 365 are in progress.** They cannot be connected in production yet. This guide covers Gmail, iCloud, Fastmail, Yahoo, Zoho, and other IMAP inboxes available today.

Claude can read, search, organize, and send your email — but it needs an MCP server to reach a real inbox. MCP Emails is that bridge: connect an inbox once, add one secure endpoint to Claude, and Claude gets a consistent set of email tools across Gmail, iCloud, Fastmail, Yahoo, Zoho, and other IMAP providers.

There is no code to write, no SDK to install, and no API key when you connect through Claude's OAuth flow. Email is fetched live from your provider for each request and is not stored by MCP Emails.

## What you need

- A **Claude plan or app that supports custom connectors**.
- A free **MCP Emails** account — [create one here](/signup).
- One email inbox. Gmail and Outlook use OAuth; iCloud, Fastmail, Yahoo, Zoho, and most other providers use an app-specific password.

## Step 1: Connect your inbox to MCP Emails

In the MCP Emails dashboard, open **Inboxes → Connect Inbox**, then choose your provider.

- **Gmail / Google Workspace:** sign in with Google and approve access.
- **Outlook / Microsoft 365:** sign in with Microsoft and approve access.
- **iCloud and Fastmail:** create an app-specific password with the provider, then enter it in MCP Emails.
- **Yahoo, Zoho, Yandex, and other IMAP email:** create an app password, choose **IMAP**, and enter the address and password. Common server settings are detected automatically.

You can connect more than one inbox. Claude discovers them with \`inbox_list\`, so you do not have to paste mailbox IDs into a prompt.

Need provider-by-provider help? See the [two-minute multi-provider setup guide](/blog/connect-email-to-ai-agent-under-2-minutes), the dedicated [Gmail guide](/blog/connect-gmail-to-claude), or the [iCloud, Fastmail, and IMAP guide](/blog/connect-icloud-fastmail-imap-to-claude).

## Step 2: Add MCP Emails to Claude

In claude.ai or Claude Desktop:

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Paste this URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Select **Connect**, sign in to MCP Emails, and approve the scopes you want: \`read:email\`, \`send:email\`, or both.

That is the entire Claude setup. OAuth limits the connection to the scopes you approve, and you can revoke it from MCP Emails whenever you want. If you use a client without OAuth support, use a scoped API key instead; [OAuth vs. API keys](/blog/oauth-vs-api-keys-ai-email-access) explains that path.

## Step 3: Give Claude a safe first task

Start with a read-only request:

> Summarize my three newest unread emails and flag anything that needs a reply today.

Claude first finds the connected inbox, then lists and reads the relevant messages. Once that works, try:

- “Find the invoice from Stripe from last month and tell me the amount.”
- “Draft a reply to the latest message from Alex, but do not send it.”
- “Show me newsletters from this week that I can archive.”
- “What did I agree to in my thread with Acme?”

For repeatable routines, use the [inbox triage playbook](/blog/ai-agent-triage-summarize-inbox) or [ways to let Claude manage your inbox](/blog/best-ways-to-let-claude-manage-your-inbox).

## What Claude can do after it is connected

MCP Emails gives Claude focused email tools rather than a password or raw IMAP connection:

- **Read and search:** \`email_read\` lists messages, reads full messages, and searches mail. Gmail searches also support Gmail operators such as \`from:\` and \`is:unread\`.
- **Send, reply, and forward:** \`email_compose\` sends through your own provider and address.
- **Organize:** \`email_organize\` moves, labels, flags, and archives messages.
- **Work with drafts, folders, schedules, and contacts:** \`draft\`, \`folder\`, \`schedule\`, and \`contact_search\` cover the rest of a practical email workflow.

MCP Emails is poll-based: Claude checks for new mail when you ask it to, rather than receiving a push event the instant an email arrives.

## Is it safe to connect Claude to email?

Yes, provided you give the connection only the access it needs and keep a person involved for outgoing actions.

- **Email is not stored.** MCP Emails retrieves message content live for each call and discards it after delivery. The encrypted credential needed to reconnect to your provider is the only inbox data retained.
- **Your provider keeps control of authentication.** Gmail and Outlook use OAuth, so MCP Emails never receives your password. For IMAP providers, use a revocable app-specific password rather than your normal password.
- **Scopes are explicit.** Grant read-only access if Claude should never send. Add send access only when you need it, and revoke either access path at any time.

Treat every email body as untrusted input. Ask Claude to draft before it sends, review external-facing messages, and do not let instructions inside an email override your intent. The [email-access safety guide](/blog/is-it-safe-to-give-ai-agent-email-access) explains the threat model in more detail.

## FAQ

**Can Claude connect to Gmail, Outlook, or iCloud?**  
Yes. Gmail and Outlook connect with OAuth. iCloud connects through an app-specific password. MCP Emails also supports Fastmail and generic IMAP, which covers services such as Yahoo and Zoho.

**Do I need an API key?**  
No, not for Claude's OAuth connector flow. Paste the endpoint URL and sign in. API keys are for MCP clients that do not have built-in OAuth.

**Can Claude send email?**  
Yes, if you grant \`send:email\`. Start with read-only access or ask Claude to draft replies first if you want a review step.

**Does MCP Emails store my inbox?**  
No. Messages are read live from your provider and discarded. MCP Emails stores only the encrypted connection credential required to make those live requests.

## Next step

[Start free](/signup), connect your inbox, add \`https://mcpemails.com/api/mcp\` to Claude, and ask it to summarize your unread email. For the complete MCP tool reference and provider capabilities, visit the [documentation](/docs).`,
};
