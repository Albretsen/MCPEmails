export default {
  slug: 'claude-imap-connector',
  title: 'Claude IMAP Connector: Connect Any IMAP Inbox to Claude',
  description:
    'Set up a Claude IMAP connector for any mailbox with IMAP/SMTP settings, app passwords, TLS ports, security guidance, limitations, and troubleshooting.',
  cover: '/blog/cover-connect-icloud-fastmail-imap-to-claude.svg',
  coverAlt: 'Claude connected to an IMAP and SMTP mailbox through MCPEmails',
  authorId: 'asgeir',
  publishedAt: '2026-08-05T09:00:00.000Z',
  updatedAt: '2026-08-05T09:00:00.000Z',
  tags: ['Claude', 'IMAP', 'MCP', 'Tutorial'],
  featured: false,
  content: `A **Claude IMAP connector** lets Claude work with mailboxes that do not have a native Claude integration: Fastmail, iCloud Mail, Yahoo, Zoho, Yandex, a mailbox on your own domain, or almost any provider that exposes IMAP and SMTP.

Claude does not log in to the mail server or handle your mailbox password directly. MCPEmails sits between them. It connects to the provider over IMAP for incoming mail and SMTP for outgoing mail, then presents a consistent set of [Model Context Protocol](https://modelcontextprotocol.io) tools to Claude. That distinction matters: IMAP and SMTP handle the mailbox, while MCP gives Claude safe, structured actions such as read, search, reply, and move.

This guide covers the generic connector and the Claude side of the setup. If you use iCloud or Fastmail and want their exact app-password screens and server names, keep the [provider-specific iCloud, Fastmail, and IMAP guide](/blog/connect-icloud-fastmail-imap-to-claude) open alongside it.

## What the Claude IMAP connector actually does

The connection has three parts:

1. **Your mail provider** exposes IMAP for reading and organizing messages, plus SMTP for sending.
2. **MCPEmails** holds the mail credential in encrypted form, talks to those servers, and turns their responses into predictable email tools.
3. **Claude** connects to the MCP endpoint and calls only the tools allowed by the scopes you approve.

Claude therefore never needs an IMAP library, an SMTP configuration, or a password in its prompt. Once connected, it can use \`inbox_list\` to discover the mailbox, \`email_read\` to list, read, search, or fetch attachments, \`email_compose\` to send, reply, and forward, and \`email_organize\` to move, copy, flag, or archive messages. Separate tools cover folders, drafts, scheduling, contacts, and deletion; the full list is in the [tool reference](/docs#tools).

## What you need before setup

Collect these values from your email provider's help page or administrator:

- **Email address:** for example, \`you@example.com\`. This is the address shown on the connected inbox.
- **Login username:** usually the full email address. Some custom-domain hosts issue a different IMAP/SMTP username.
- **IMAP host and port:** for example, \`imap.example.com\` on port \`993\` for IMAP over implicit TLS. This connection handles reading, searching, folders, and message actions.
- **SMTP host and port:** for example, \`smtp.example.com\` on port \`465\` or \`587\`. Port \`465\` uses implicit TLS; \`587\` upgrades with STARTTLS. This connection handles sending, replying, and forwarding.
- **Password:** preferably a revocable app password created for mail-client access.

Do not guess the server names from the domain if your provider publishes settings. Mail hosting is often separate from website hosting, and a custom-domain address may use a provider-specific login that differs from the visible address.

Use an **app password** whenever the provider supports one. It is separate from your primary account password and can be revoked without changing the password you use to sign in. Providers commonly require two-factor authentication before they let you create one. Some also require you to enable IMAP access in mail settings first.

MCPEmails includes presets for iCloud, Yahoo, Zoho, and Yandex, plus a dedicated Fastmail app-password flow. Those choices fill the known hosts and ports for you. Choose **Generic IMAP** for another provider or your own mail server and enter the values yourself.

## Step 1: connect the IMAP/SMTP mailbox

1. [Create or sign in to your MCPEmails account](/signup), then open **Dashboard → Inboxes → Connect Inbox**.
2. Select the named provider when one is available. Otherwise select **IMAP / SMTP**.
3. Enter the email address and app password. For the generic connector, also enter the IMAP host and port, SMTP host and port, and a separate login username if your host gave you one.
4. Save the connection. MCPEmails validates the credential against the IMAP server before storing the inbox, so a rejected login or unreachable TLS endpoint fails here instead of surfacing later in Claude.

The normal secure defaults are IMAP \`993\`, then SMTP \`465\` or \`587\`. They are not interchangeable: use the port and security mode documented by the provider. MCPEmails treats SMTP port \`587\` as STARTTLS and other configured SMTP ports as implicit TLS. Connections that do not support TLS are rejected.

## Step 2: add MCPEmails as a Claude connector

After the mailbox is connected, point Claude at MCPEmails:

1. In claude.ai, open **Customize → Connectors**.
2. Choose **Add connector** and enter \`https://www.mcpemails.com/api/mcp\`.
3. Select **Connect**, sign in to MCPEmails, and approve only the permissions the workflow needs.

For example, a summarizer needs read and search access but not send or delete access. A reply workflow needs send access. Folder management and permanent deletion have their own scopes, so you can keep destructive actions unavailable until they are genuinely useful. See the [Claude email connection walkthrough](/blog/connect-claude-to-email) for the client-side flow in more detail.

Then run a small smoke test:

\`\`\`
Use inbox_list to find my IMAP inbox. List my five newest unread messages and summarize them. Do not send, move, or delete anything.
\`\`\`

Starting with \`inbox_list\` lets Claude obtain the right \`inbox_id\` instead of relying on a copied UUID.

## What Claude can do over IMAP

Once the connection works, Claude can:

- List and read messages fetched live from the provider.
- Search by sender, recipient, subject, body text, read status, flagged status, and dates.
- Download or extract supported attachments within the documented size and format limits.
- Send new messages through SMTP, or reply and forward while preserving the relevant message context.
- Move, copy, flag, archive, and organize mail in IMAP folders.
- Create and manage drafts, schedule messages, and search contacts where the tool supports the operation.
- Move mail to Trash or, with explicit delete permission and \`permanent: true\`, expunge it permanently on IMAP.

That last capability deserves care. Permanent IMAP deletion bypasses Trash and may be irreversible. MCPEmails exposes deletion as its own destructive tool, and the MCP client controls confirmation behavior, but you should still grant \`delete:email\` only to workflows that need it.

## Important IMAP limitations

An IMAP connector is broad, but it does not make every provider identical.

- **No incoming-mail push:** MCPEmails is request/response only. It does not send webhooks or trigger Claude when a message arrives. An automated workflow must poll on a schedule, for example by listing unread mail.
- **Search varies by transport:** structured sender, subject, text, and date filters work across providers, but generic IMAP does not support the \`has_attachment\` search filter. Provider-native search syntax is not portable.
- **Folders are not Gmail labels:** IMAP moves a message between folders, while Gmail can attach several labels to one message. The practical difference is explained in [Gmail labels vs. IMAP folders](/blog/gmail-labels-vs-imap-folders-ai-agents).
- **SMTP is required for sending:** a working IMAP login proves that Claude can reach incoming mail, not that the SMTP host, port, or send permission is correct. Test one harmless outbound message before relying on a reply workflow.
- **Provider policies still apply:** mailbox quotas, sending limits, simultaneous-connection limits, spam controls, and administrator restrictions remain in force.

## Troubleshooting a Claude IMAP connection

### “Authentication failed” when connecting the inbox

Use an app password, not the password you use on the provider's website. Confirm that two-factor authentication and IMAP access are enabled if the provider requires them. Re-copy the generated password without leading or trailing spaces. If the address is on a custom domain, verify whether the login username is the full email address or a separate account name.

### The server times out or TLS fails

Check the host spelling and use the provider's documented secure ports. Start with IMAP \`993\`; for SMTP use the documented \`465\` or \`587\`. A website hostname, control-panel hostname, or bare domain is not necessarily a mail server. On a private server, also confirm that its firewall accepts connections from outside your network and that its TLS certificate matches the mail hostname.

### Claude can read but cannot send

The IMAP settings are working, but SMTP is separate. Recheck the SMTP hostname and port, confirm the credential has SMTP or “mail” access, and verify that the provider permits authenticated sending for the From address. Fastmail app passwords, for example, should be created with **Mail (IMAP/SMTP)** access rather than read-only access.

### Claude cannot find the mailbox

Ask Claude to call \`inbox_list\` again. If the inbox does not appear, check its status in the MCPEmails dashboard and reconnect it if the app password was revoked or rotated. If the inbox appears but an action is denied, reconnect the Claude connector or update the API key with the needed scope.

### Search results are narrower than expected

Start with structured fields such as \`from\`, \`subject\`, \`text\`, \`since\`, and \`before\`, and specify which folders to search when needed. Do not copy Gmail operator syntax into a generic IMAP search and expect identical behavior. Remember that attachment-presence filtering is ignored for generic IMAP.

## Security: credentials stay out of Claude

MCPEmails stores the OAuth token or IMAP app password needed for future calls, encrypted at rest with AES-256-GCM. Ordinary mailbox content is fetched live when a tool runs and is not persisted between calls. Traffic uses TLS, and you can revoke an app password at the provider or disconnect the inbox from the dashboard.

The clean boundary is the main reason to use an MCP bridge instead of pasting mail credentials into a chat or local configuration: Claude receives scoped email capabilities, not the keys to the mailbox. For the storage and threat-model details, read [why “email is never stored” matters](/blog/why-email-never-stored-matters) and the [security overview](/security).

## The short version

A Claude IMAP connector is an IMAP/SMTP mailbox connection presented to Claude as MCP tools. Gather the secure server settings, create a revocable app password, connect the inbox in MCPEmails, and add \`https://www.mcpemails.com/api/mcp\` in Claude. Test read-only access first, add send or destructive scopes deliberately, and use the troubleshooting checklist above if the provider rejects the connection.

Ready to try it? [Connect an IMAP inbox](/signup), or use the [provider-specific setup guide](/blog/connect-icloud-fastmail-imap-to-claude) for iCloud and Fastmail details.`,
};
