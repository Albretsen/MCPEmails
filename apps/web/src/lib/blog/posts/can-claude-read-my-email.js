// Facts about Claude's own connectors and Google's Gmail MCP server were read
// on 2026-10-20 at:
//   - claude.com/connectors/gmail: "Made by Google", connector URL
//     https://gmailmcp.googleapis.com/mcp/v1, tools include read, search,
//     drafts, send, reply, forward, labels and trash.
//   - support.claude.com/en/articles/10166901 (Google Workspace connectors):
//     "Send, reply to, and forward emails from Gmail"; "By default, Claude asks
//     for your approval before each of these actions"; Team and Enterprise
//     owners enable it first and decide whether members may skip the ask;
//     "the Google account you've connected"; attachment content is metadata
//     only.
//   - support.claude.com/en/articles/12542951 (Microsoft 365 connector):
//     personal Microsoft accounts (@outlook.com, @hotmail.com) cannot connect;
//     a Microsoft Entra Global Administrator must consent; read-only until
//     write tools are enabled; write tools reject attachments.
//   - developers.google.com/workspace/gmail/api/guides/configure-mcp-server:
//     part of the Google Workspace Developer Preview Program (membership is a
//     prerequisite), same endpoint, documented tools create drafts and labels
//     but no send tool ("review and send it from Gmail"); Claude needs your
//     own OAuth client ID and secret.
//   - support.claude.com/en/articles/11175166 (custom connectors): Customize,
//     Connectors, "+ Add", "Add custom connector", name and URL, "Continue",
//     review the detected sign-in settings, "Add", then sign in. Free allows one
//     custom connector, Pro and Max unlimited. Re-checked 2026-10-26.
//     Settings > Connectors is the old path; do not reintroduce it.
//   - fastmail.help/hc/en-us/articles/15869557281295 and
//     zoho.com/mail/help/mcp/getting-started.html: both run their own MCP
//     server that can be added to Claude as a custom connector.
// Re-checked by the fact-check pass on 2026-10-20. The Microsoft 365 connector
// is read-only until write tools are enabled, so never say it "asks before
// sending" the way the Gmail connector does.
// These must agree with src/lib/compare/native-connectors.mjs. Never print the
// date Anthropic shipped Gmail send: no Anthropic page states it. Re-read the
// sources before editing the Gmail or Microsoft 365 sections.
const post = {
  slug: 'can-claude-read-my-email',
  title: 'Can Claude Read My Email and Send Emails? Mailbox by Mailbox',
  description:
    'Yes, for Gmail and work Microsoft 365 accounts, with Claude\'s own connectors. Yahoo, iCloud, Outlook.com, IMAP mailboxes and several providers at once need an MCP server.',
  cover: '/blog/cover-agent-inbox.svg',
  coverAlt:
    'Claude reading and sending email from Gmail, Microsoft 365, Yahoo, iCloud and IMAP mailboxes',
  authorId: 'asgeir',
  publishedAt: '2026-10-20T09:00:00.000Z',
  updatedAt: '2026-10-20T09:00:00.000Z',
  tags: ['Claude', 'Gmail', 'Outlook', 'MCP'],
  featured: false,
  content: `**Yes, Claude can read your email and send emails, but only from a mailbox you have connected to it.** Claude has two email connectors of its own, one for Gmail and one for work Microsoft 365 accounts. The Gmail connector reads, searches and sends, and asks for your approval before each send by default. The Microsoft 365 connector reads and searches, and can send only after an administrator turns on its write tools. Yahoo, iCloud, a personal Outlook.com address, a company mailbox on an IMAP host, or several providers behind one connection need an MCP server such as MCPEmails.

This page sorts out which case you are in. The facts about Anthropic's and Google's products were read on their own pages in October 2026. Those products change often, so each section links the page it rests on.

**Jump to:** [Gmail](#gmail-claudes-own-connector) · [Microsoft 365](#outlook-and-microsoft-365-work-accounts-only) · [What the built-in connectors miss](#what-the-built-in-connectors-do-not-cover) · [MCPEmails](#how-mcpemails-fills-the-gap) · [FAQ](#faq)

## Gmail: Claude's own connector

Claude's Gmail connector is listed in Claude's connector directory as made by Google, and it runs on Google's Gmail MCP server (\`gmailmcp.googleapis.com\`). You turn it on from Claude's connector settings and sign in with your Google account.

What it can do, according to [Anthropic's help article](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) and the [directory listing](https://claude.com/connectors/gmail):

- **Read and search** your mail with plain-language questions, and read whole threads.
- **Draft, send, reply and forward.** Anthropic's article lists all four.
- **Organize** with labels, and move messages or threads to the trash.
- **Ask first.** By default Claude asks for your approval before each send, reply or forward. On Team and Enterprise plans an owner has to enable the connector for the organization first, and decides whether members may let those actions run without asking.

Where it stops:

- **Attachments.** Anthropic's article says Claude sees attachment metadata only, not the content.
- **One Google account.** The article describes access to "the Google account you've connected" and does not mention adding a second one.

Google also documents the same Gmail MCP server as part of its [Workspace Developer Preview Program](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server). Members of that program can add it to other MCP clients themselves, with their own Google Cloud OAuth client. That documented version lists tools to search, read threads, create drafts and change labels, and no tool to send: you review the draft and send it from Gmail.

If Gmail is your only mailbox and Claude is your only AI app, the built-in connector may be all you need.

## Outlook and Microsoft 365: work accounts only

Claude's Microsoft 365 connector reads Outlook mail for accounts that belong to a company's Microsoft 365 tenant.

- **Reading and searching** cover your main mailbox, its Archive folder and shared mailboxes you can open.
- **Sending is off by default.** The connector starts read-only. Once write tools are enabled, Claude can send and forward mail and create, edit and delete drafts. Messages with attachments are rejected by the write tools.
- **An administrator has to approve it.** A Microsoft Entra Global Administrator in your organization must consent before anyone there can connect, and again before the write tools work.
- **Personal accounts are refused.** [Anthropic's article](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) is explicit: addresses such as @outlook.com and @hotmail.com cannot be used to connect.

So a personal Outlook.com, Hotmail or Live address has no built-in route into Claude. [Connect Claude to Outlook.com and Hotmail](/blog/connect-claude-to-outlook-com-hotmail) covers the route that works.

## What the built-in connectors do not cover

Put the two together and these are the mailboxes neither built-in connector reaches:

- **Yahoo Mail and AOL.**
- **iCloud Mail.**
- **Personal Outlook.com, Hotmail and Live** addresses.
- **Company mailboxes on an IMAP host**: Fastmail, Zoho Mail, IONOS, STRATO, a cPanel host or your own server.
- **A second Google account.** Anthropic's article describes one connected Google account and does not mention adding another.
- **Several providers behind one connection**, so that one question searches info@, your own address and a personal Gmail together.

Fastmail and Zoho Mail run MCP servers of their own, which you can add to Claude as custom connectors. Each reaches only its own provider's mailboxes. Neither of Claude's help articles mentions scheduling a send for later. The [comparison of Claude's and ChatGPT's built-in connectors](/native-connectors-vs-mcp) lists each capability with its source and the date it was checked.

## How MCPEmails fills the gap

MCPEmails is a hosted MCP server. You connect each mailbox to it once, then add one connector URL to Claude, and Claude can read, search and send from every connected mailbox:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Any provider.** [Yahoo Mail](/connect/yahoo), [iCloud Mail](/connect/icloud), [personal Outlook.com](/connect/outlook) and [work Microsoft 365](/connect/office365) (both with Sign in with Microsoft), [Gmail](/connect/gmail) with a Google app password, [Fastmail](/connect/fastmail) with an app password, [Zoho Mail](/connect/zoho), and any mailbox that speaks [IMAP and SMTP](/connect/imap). The [full provider list](/connect) has a settings page for each host.
- **Several mailboxes in one chat.** Claude calls \`inbox_list\` and sees every connected address by name, so "search sales@ and my Gmail" works in one conversation. [Multiple email accounts in Claude](/blog/multiple-email-accounts-in-claude-and-chatgpt) covers that setup.
- **Send from the right address.** Each mailbox sends through its own provider, with its own sender name and signature.
- **Schedule and organize.** Claude can schedule a send for later, and move, flag, archive or delete mail in every connected mailbox, once you give it Full access.
- **Read attachments.** Claude can [pull the text out of a PDF, CSV or HTML attachment](/blog/extract-email-attachments-for-ai) without the file being kept.
- **The same mailboxes in other apps.** It is a standard MCP server, so the one setup also works in ChatGPT, Cursor, VS Code and other MCP clients.

Mail is fetched live from your provider for each request and is not stored. What is kept: the encrypted credential for each mailbox, a message you schedule until it sends, and a send held for review until it is approved, rejected or expires. Data is stored in Stockholm.

### Add it to Claude

1. [Create a free MCPEmails account](/signup) and connect a mailbox under **Inboxes**, then **Connect Inbox**.
2. In claude.ai or Claude Desktop, open **Customize → Connectors**, click **+ Add**, then **Add custom connector**. Name it MCPEmails, enter \`https://mcpemails.com/api/mcp\`, click **Continue**, keep the detected sign-in settings and click **Add**.
3. Sign in to MCPEmails when Claude asks, and choose how much access Claude gets: **Read-only**, **Standard** (adds sending and drafts) or **Full access** (adds scheduling, folders and deleting).

The [step-by-step Claude setup guide](/blog/connect-claude-to-email) walks through each screen and each provider, and the [Claude setup page](/docs/claude) covers connector errors.

## Can Claude send emails without asking?

That depends on the connector and on you.

- **Claude's Gmail connector** asks before each send, reply and forward by default.
- **Claude's Microsoft 365 connector** cannot send at all until write tools are enabled.
- **MCPEmails** sends only if you gave Claude sending access when you connected it. On **Read-only**, Claude cannot send. For a mailbox where every outgoing message should be checked, switch on **Review before sending** in that inbox's settings: each send then waits until a workspace owner or admin approves it, signed in to MCPEmails in a browser. Claude cannot approve it itself. See [human approval for AI email sends](/blog/approve-ai-agent-email-sends).

Whichever route you use, treat what is inside an email as data, not instructions. A message can contain text written to steer an AI, and a review step catches it before anything leaves your mailbox. The [email access safety guide](/blog/is-it-safe-to-give-ai-agent-email-access) explains the risks in more detail.

## FAQ

**Can Claude read my email?**
Yes, once a mailbox is connected. Gmail and work Microsoft 365 accounts connect through Claude's own connectors. Yahoo, iCloud, personal Outlook.com and IMAP mailboxes connect through an MCP server such as MCPEmails, added to Claude as a custom connector.

**Can Claude send emails?**
Yes. Claude's Gmail connector can send, reply and forward, and asks for your approval first by default. The Microsoft 365 connector can send once write tools are enabled. Through MCPEmails, Claude sends from any connected mailbox if you gave it sending access when you connected it.

**Can Claude read my Gmail?**
Yes, with Claude's built-in Gmail connector, for the Google account you connect. To use more than one Google account, or Gmail alongside other providers in the same chat, connect them through MCPEmails with a Google app password.

**Can Claude access my Outlook or Hotmail email?**
Work and school Microsoft 365 accounts can use Claude's Microsoft 365 connector after an administrator approves it. Personal Outlook.com and Hotmail addresses cannot. MCPEmails connects both with Sign in with Microsoft, though a work account may still need its IT admin to approve the app once for the organization.

**Can Claude read Yahoo or iCloud email?**
Not with a built-in connector. Connect the mailbox to MCPEmails with an app password from Yahoo or Apple, then add MCPEmails to Claude.

**Can Claude read several email accounts at once?**
Yes, through MCPEmails. Every mailbox you connect appears in Claude through the one connector URL, and Claude names the mailbox on each call.

**Does MCPEmails store my emails?**
No. Message content is fetched live from your provider on each request and dropped once the answer is sent. See [security](/security) for what is kept.

## Next step

If your mail is all in one Gmail account, try Claude's Gmail connector first. For anything else, [start free](/signup), connect a mailbox, add \`https://mcpemails.com/api/mcp\` to Claude and ask it what needs a reply today.`,
};

export default post;
