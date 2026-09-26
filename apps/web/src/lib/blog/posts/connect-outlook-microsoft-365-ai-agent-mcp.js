const post = {
  slug: 'connect-outlook-microsoft-365-ai-agent-mcp',
  title: 'Connecting Outlook and Microsoft 365 to Your AI Agent via MCP',
  description:
    'Connect Outlook.com or Microsoft 365 to your AI agent over MCP. Sign in with Microsoft, no app password, Microsoft Graph underneath. Work accounts may need IT admin approval once.',
  cover: '/blog/cover-connect-outlook-microsoft-365-ai-agent-mcp.svg',
  coverAlt: 'Connecting Outlook and Microsoft 365 to an AI agent over MCP',
  authorId: 'asgeir',
  publishedAt: "2026-05-18T09:00:00.000Z",
  updatedAt: "2026-09-25T09:00:00.000Z",
  tags: ['Outlook', 'Tutorial', 'MCP', 'AI agents'],
  featured: false,
  content: `To connect an Outlook or Microsoft 365 mailbox to your AI agent, you add the inbox in the MCP Emails dashboard with **Sign in with Microsoft**, then point your agent at one MCP endpoint. There is no app password, no IMAP or SMTP settings, no Azure portal and no Graph server of your own. A personal Outlook.com account connects in a couple of minutes. A work or school Microsoft 365 account often needs one extra step first: an IT admin approves the app once for the whole organisation.

Most "AI for email" guides assume Gmail and stop there. If you live in Outlook, this is the Outlook-first version: which accounts connect straight away, what the admin approval step looks like, what your agent can do once it is connected, and the few places where Outlook behaves differently from Gmail.

## Personal accounts and work accounts are two different cases

Microsoft email is not one thing, and the difference decides how your connection goes.

- **Personal Microsoft accounts**: Outlook.com, Hotmail, Live and MSN addresses. You sign in with Microsoft, approve the permissions yourself, and you are connected. No admin is involved.
- **Work or school Microsoft 365 accounts**: these live in your organisation's Microsoft Entra tenant. Many organisations require an IT admin to approve a third-party app before anyone can use it. Microsoft's default consent policy (since late 2025) does not let employees approve mailbox read access for themselves, so in many tenants you will not be able to finish the connection alone. That is a Microsoft tenant policy, not something MCP Emails can switch off, and it applies to any third-party email app.

The admin approval is a one-time step for the whole organisation. Once it is done, every employee connects the normal way.

## Connect your Outlook or Microsoft 365 inbox

Two parts: connect the mailbox, then connect the agent. They are separate on purpose. The mailbox connection lets MCP Emails reach your mailbox, and the agent connection lets your AI client reach MCP Emails.

### Step 1: Add the inbox

1. [Start free](/signup) and open the dashboard.
2. Go to **Inboxes → Connect Inbox** and pick **Outlook**.
3. Click **Connect with Microsoft**. You are sent to Microsoft's own sign-in page.
4. Sign in with your Microsoft account and complete MFA if your account uses it.
5. Review the consent screen and approve. Microsoft shows the app as coming from a verified publisher, and it asks for permission to read and write your mail, send mail as you, and keep access until you disconnect.

MCP Emails stores the resulting OAuth token encrypted and nothing else about your mailbox. You never type your Microsoft password into MCP Emails, and there is no app password to generate. That is the main difference from the IMAP providers: [iCloud, Fastmail, and generic IMAP mailboxes](/blog/connect-icloud-fastmail-imap-to-claude) use an app-specific password instead.

### If your organisation has to approve the app first

On a work or school account, Microsoft may stop you before the consent screen and say that admin approval is required. When that happens, the dashboard shows a notice with a **Send to your IT admin** link:

1. Send that link to your IT admin.
2. Your admin opens it, signs in, and approves MCP Emails once for the whole organisation.
3. Come back to the dashboard and connect Outlook as in Step 1. It now goes through like a personal account.

Your admin approves the app for the organisation, and each person still signs in with their own account and connects only their own mailbox.

### If the account has no Exchange mailbox

Some Microsoft accounts have no Exchange Online mailbox, for example an admin account without an Exchange licence, or an organisation whose mail is hosted somewhere else. MCP Emails refuses those accounts because there is nothing to connect, and tells you so. If your mail actually lives on another server, connect the address with IMAP instead.

### Step 2: Connect your agent

You connect a client once, and the same setup works for every inbox on your account. For OAuth-capable clients (claude.ai, Claude Desktop, Cursor), in claude.ai it is:

**Customize → Connectors → Add connector → paste the URL → Connect → sign in & approve.**

The endpoint is:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

When you click Connect, you sign in to your MCP Emails account and approve scopes: \`read:email\`, \`send:email\`, or both. No API key changes hands.

For clients that do not speak OAuth (Cline, JetBrains plugins, your own scripts, raw cURL), generate a scoped key in **Dashboard → API Keys** and send it as \`Authorization: Bearer <api-key>\`. The full walk-through for those clients lives in [email for AI agents in Cursor, Cline, and VS Code](/blog/email-for-ai-agents-cursor-cline-vscode). If you are weighing the two approaches, [OAuth vs API keys for AI email access](/blog/oauth-vs-api-keys-ai-email-access) lays out the trade-offs.

## Microsoft Graph, under the hood

Outlook connects through Microsoft Graph, not IMAP. Every tool call your agent makes goes to Graph in real time: read a message, and MCP Emails fetches it from Graph, hands the result to your agent, and discards it. Send a message, and it goes out through Graph from your real address, so your deliverability and reputation stay yours. MCP Emails never relays mail from its own domain.

## What your agent can do with an Outlook inbox

- Read and search mail.
- Send, reply and forward, with attachments up to 25 MB.
- Work with drafts, and schedule a send for later.
- Work with folders, including nested folders.
- Move, copy and archive messages.
- Flag and unflag messages, and mark them read or unread.
- Move messages to Deleted Items, or delete them permanently.
- Use the signature you set for that inbox on every message the agent sends.

### Where Outlook differs from Gmail

**Folders, not labels.** Outlook organises mail in folders. The label tools are Gmail-only, so on an Outlook inbox your agent files mail by moving it into a folder.

**Search.** Outlook search runs on Microsoft Graph's own search. One Graph limitation matters: a text search cannot be combined with the unread, has-attachment, flagged or date filters. When your query includes text, those filters are not applied, and the result tells your agent which ones were left out. If you need both, search for the text first and let the agent narrow the results it gets back.

**New Outlook.com accounts.** Microsoft may temporarily block sending from a brand-new Outlook.com account that sends many messages in a short burst. That is Microsoft's anti-abuse protection. If sending fails on a new account, send at a slower pace and try again later.

## A workflow worth setting up

Here is a triage loop that works well on an Outlook inbox. Once or twice an hour, the agent:

1. Lists unread mail in the inbox.
2. Reads anything that looks time-sensitive.
3. Summarizes the batch and drafts replies for the ones you would obviously answer.
4. Leaves everything unread until you confirm.

MCP Emails does not push new mail to your agent, so the agent checks on a schedule you choose. For triage that is fine. For the polling patterns that hold up, read [how to triage and summarize an inbox](/blog/ai-agent-triage-summarize-inbox).

## Compared to building your own Microsoft 365 server

The self-hosted Outlook MCP servers on GitHub all hit the same wall: the Entra app registration, admin consent and Graph token lifecycle are the actual work, and you own them forever. The self-hosted MCP Emails stack is IMAP and SMTP only. The Outlook connector stays on the hosted product, so a self-hoster who wants it would have to register their own Microsoft Entra app. With the hosted approach, the token is encrypted at rest, decrypted only at call time, and you can disconnect the inbox from the dashboard at any time. [Hosted vs self-hosted](/blog/hosted-vs-self-hosted-gmail-mcp-server) goes deeper on the trade-offs.

If you want the conceptual background on why this layer exists at all, the [complete guide to giving your AI agent email access](/blog/how-to-give-your-ai-agent-email-access) is the place to start. Otherwise, [start free](/signup), connect your Outlook inbox, point your agent at the endpoint, and give it something to read.`,
};

export default post;
