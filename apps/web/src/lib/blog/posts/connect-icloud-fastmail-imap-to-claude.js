const post = {
  slug: 'connect-icloud-fastmail-imap-to-claude',
  title: 'How to Connect iCloud, Fastmail, or Any IMAP Inbox to Claude',
  description:
    'Connect iCloud, Fastmail, or any IMAP inbox to Claude with an app-specific password. Step-by-step setup, the MCP endpoint, and what IMAP does that Gmail won’t.',
  cover: '/blog/cover-connect-icloud-fastmail-imap-to-claude.svg',
  coverAlt: 'Connect iCloud, Fastmail, and any IMAP inbox to Claude over MCP',
  authorId: 'asgeir',
  publishedAt: "2026-05-13T09:00:00.000Z",
  updatedAt: "2026-05-13T09:00:00.000Z",
  tags: ['iCloud', 'Fastmail', 'IMAP', 'Tutorial'],
  featured: false,
  content: `Connecting iCloud, Fastmail, or any IMAP mailbox to Claude takes one thing Gmail and Outlook don't need: an **app-specific password**. You generate it inside your email provider, paste it into MCP Emails once, and Claude can read, search, and send through that inbox. No OAuth dance, no SMTP server settings to memorize.

This is the route for every provider that isn't Gmail or Microsoft. iCloud, Fastmail, Yahoo, Zoho, Yandex, and any generic IMAP host all run through the same IMAP/SMTP transport, so they share an identical feature set. If you can get an app password out of the provider, you can connect it. One nice bonus over the OAuth providers: IMAP gives Claude real, permanent delete.

## Why these providers use an app password, not OAuth

Gmail and Outlook expose modern OAuth APIs, so MCP Emails connects them with a one-click sign-in. iCloud and Fastmail don't offer that path to third-party email tools. Instead they hand you an **app-specific password** — a long, randomly generated password scoped to a single application, separate from your real account password and revocable on its own.

One correction worth making, because older write-ups get it wrong: **Fastmail is app-password only.** Fastmail used to support an OAuth flow for some integrations, but for connecting to MCP Emails today you generate an app password in Fastmail's settings. Same as iCloud. If a guide tells you to "sign in with Fastmail" through OAuth, it's stale.

The app password becomes the one credential MCP Emails stores for that inbox, [encrypted with AES-256-GCM at rest](/blog/why-email-never-stored-matters) and decrypted only inside an isolated Edge Function at call time. Your actual email is never stored — every tool call fetches it live from the provider and discards it.

## Generate an app-specific password for iCloud

1. Go to [appleid.apple.com](https://appleid.apple.com) and sign in with your Apple Account.
2. In the **Sign-In and Security** section, open **App-Specific Passwords**.
3. Click the **+** (Generate an app-specific password), give it a label like \`MCP Emails\`, and confirm with your Apple Account password.
4. Apple shows you a password in the format \`abcd-efgh-ijkl-mnop\`. Copy it now. You can't view it again later.

You'll need two-factor authentication turned on for your Apple Account — app-specific passwords aren't available without it. The IMAP host for iCloud is \`imap.mail.me.com\` and SMTP is \`smtp.mail.me.com\`, but MCP Emails fills those in for you when you pick iCloud as the provider, so you usually won't touch them.

## Generate an app password for Fastmail

1. Sign in to Fastmail and open **Settings → Privacy & Security → Connected apps & API tokens** (older accounts label it **App Passwords**).
2. Click **New app password**.
3. Name it (\`MCP Emails\` works), and for access choose **Mail (IMAP/SMTP)** so it can both read and send.
4. Fastmail generates the password once. Copy it before you close the dialog.

Fastmail's IMAP host is \`imap.fastmail.com\` and SMTP is \`smtp.fastmail.com\`. Again, picking Fastmail in MCP Emails sets these automatically.

## Connect a generic IMAP inbox (everything else)

For Yahoo, Zoho, Yandex, a self-hosted mail server, or anything else with an IMAP endpoint, the steps are the same shape: get an app password from the provider (most that support 2FA require one), then hand MCP Emails four things:

- **IMAP host and port** (commonly \`993\` for TLS)
- **SMTP host and port** (commonly \`465\` or \`587\`)
- Your **email address** as the username
- The **app password** as the password

If you genuinely have only a regular password and the provider doesn't offer app passwords, that will work too — but an app password is the right move. It limits blast radius. Revoke it and only this connection dies, not your whole account.

## Connect the inbox in MCP Emails

Once you have the password copied:

1. Open the dashboard and go to **Inboxes → Connect Inbox**.
2. Pick your provider — **iCloud**, **Fastmail**, or **Generic IMAP**.
3. Paste your email address and the app-specific password. For generic IMAP, also confirm the host and port.
4. Save. The inbox is live in under a minute.

That's the whole thing. If you want the fastest possible version across any provider, the [under-two-minute connect walkthrough](/blog/connect-email-to-ai-agent-under-2-minutes) covers it end to end.

## Point Claude at your inbox

Connecting the inbox and connecting Claude are two separate steps. The inbox lives in MCP Emails; now you give Claude the [MCP](https://modelcontextprotocol.io) endpoint so it can call the tools.

In claude.ai:

1. Go to **Customize → Connectors**.
2. Click **Add connector** and paste the endpoint: \`https://www.mcpemails.com/api/mcp\`
3. Click **Connect**, sign in with your MCP Emails account, and approve the scopes you want — \`read:email\`, \`send:email\`, or both.

No API key, no config file. claude.ai uses OAuth with PKCE under the hood, and the token Claude gets is scoped to exactly what you approved. If you're on a client that can't do OAuth — Cursor, Cline, a cURL script — you mint a scoped key instead, which I cover in [email access for Cursor, Cline, and VS Code](/blog/email-for-ai-agents-cursor-cline-vscode).

Once it's connected, have Claude run \`inbox_list\` first. It returns your inbox and its \`inbox_id\`, so you never copy-paste a UUID. From there it's the [core tools](/docs) — \`email_read\` (list, read, and search messages), \`email_compose\` (send, reply, forward), and \`email_organize\` — plus a few more for folders, drafts, scheduling, and contacts. Each runs through an \`action\` parameter.

A prompt to confirm it works:

\`\`\`
Use inbox_list to find my iCloud inbox, then summarize my 5 most recent unread messages.
\`\`\`

## The one thing IMAP does that Gmail and Outlook can't

Here's the part people miss. When Claude "deletes" a message on Gmail or Outlook, it goes to Trash. That's a hard limit of the Gmail and Microsoft Graph APIs — they don't expose a permanent delete to third-party apps. The message lingers in Trash until the provider's retention window expires.

IMAP is different. Fastmail, iCloud, Yahoo, Zoho, Yandex, and generic IMAP all support **hard expunge** — Claude can permanently remove a message, not just trash it. If you want an agent that actually cleans up after itself, IMAP is the only transport that lets it. Useful, and also a reason to be deliberate about which scopes you grant. Expunge is irreversible.

Search behaves a little differently too. Gmail gets its full operator syntax, Outlook uses KQL, and IMAP providers use IMAP text search — capable, but not as expressive as Gmail's operators. Worth knowing if you're writing search-heavy prompts.

## What you can build once it's connected

The mechanics are the same regardless of provider, so any workflow you've seen for Gmail works on your Fastmail or iCloud inbox. A few that pull their weight:

- Morning triage that flags what needs a human and drafts replies to the rest. See [inbox triage and summarize](/blog/ai-agent-triage-summarize-inbox).
- A near-real-time auto-responder. One honest caveat: MCP Emails is poll-based, not push — there are no webhooks, so the agent checks for new mail on a schedule. The [auto-responder build](/blog/build-email-auto-responder-mcp-agent) explains how to do that well.

If you're still deciding whether to wire email into an agent at all, start with the pillar: [how to give your AI agent access to email](/blog/how-to-give-your-ai-agent-email-access).

## Wrap-up

iCloud, Fastmail, and IMAP aren't second-class here. Generate an app password, paste it into **Inboxes → Connect Inbox**, point Claude at the [endpoint](/docs), and you've got an agent with full read/send access plus permanent delete the OAuth providers can't offer. It's [free to start](/signup), no card, one inbox forever.`,
};

export default post;
