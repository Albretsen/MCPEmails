// Facts about Claude Cowork and Claude's connectors were read on 2026-10-29:
//   - support.claude.com/en/articles/13345190 (get started with Cowork): Pro,
//     Max, Team and Enterprise; connectors managed from the "+" menu or
//     Customize > Connectors; each tool Always allow / Needs approval /
//     Blocked; Team and Enterprise may require per-task approval for
//     write-capable connector tools; "Chat and Cowork now share one home".
//   - support.claude.com/en/articles/11175166 (custom connectors): "available
//     on Claude, Cowork, and Claude Desktop"; Customize > Connectors, "+ Add",
//     "Add custom connector"; Claude connects from Anthropic's cloud, so the
//     server must be reachable from the internet; local servers from
//     claude_desktop_config.json are not available in Cowork.
//   - support.claude.com/en/articles/10166901 (Google Workspace connectors):
//     "the Google account you've connected"; no second account mentioned.
//   - support.claude.com/en/articles/12542951 (Microsoft 365 connector):
//     personal accounts cannot connect; a Global Administrator consents;
//     read-only until write tools are enabled.
//   - support.claude.com/en/articles/13854387 (scheduled tasks): tasks use the
//     same connectors.
// Re-read them before editing the built-in connector sections; Cowork changes
// monthly. Never claim the built-in Gmail connector "replaces" a first account
// when a second is added: only vendor blogs say so, not Anthropic.
const post = {
  slug: 'multiple-email-accounts-in-claude-cowork',
  title: 'Multiple Email Accounts in Claude Cowork, Including Personal Outlook',
  description:
    'Claude Cowork reaches one Google account through its Gmail connector, and its Microsoft 365 connector refuses personal Outlook addresses. How to give one Cowork task several inboxes, work and personal.',
  cover: '/blog/cover-agent-inbox.svg',
  coverAlt:
    'Work and personal email accounts, including Gmail and Outlook.com, connected to one Claude Cowork task',
  authorId: 'asgeir',
  publishedAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  tags: ['Claude', 'Cowork', 'Multiple inboxes', 'MCP'],
  featured: false,
  content: `**Claude Cowork uses the same connectors as Claude chat, so it has the same email limits: one Google account through the Gmail connector, and work Microsoft 365 accounts only through the Microsoft 365 connector.** A personal Outlook.com or Hotmail address, a second Gmail, or a company mailbox on an IMAP host needs a custom connector. With an MCP server such as MCPEmails, one custom connector gives a Cowork task every mailbox you connect, each by name.

**Jump to:** [Built-in connectors](#what-coworks-built-in-email-connectors-reach) · [Several inboxes](#several-inboxes-in-one-cowork-task) · [Setup](#set-it-up) · [Permissions](#keep-sending-under-your-control) · [FAQ](#faq)

## What Cowork's built-in email connectors reach

Anthropic's [Cowork guide](https://support.claude.com/en/articles/13345190-get-started-with-cowork) manages connectors from the same **Customize → Connectors** page as chat, and chat and Cowork now share one home in the Claude app. Whatever your Claude account has connected is what a Cowork task can use.

- **Gmail.** Claude's Gmail connector reads, searches, drafts and sends. [Anthropic's article](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) describes access to "the Google account you've connected" and says nothing about adding a second one. A personal and a work Gmail do not sit side by side through it.
- **Microsoft 365.** The [Microsoft 365 connector](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) is for accounts in a company's Microsoft 365 tenant. A Global Administrator has to consent first, it starts read-only, and personal Microsoft accounts such as @outlook.com and @hotmail.com cannot connect.
- **Everything else.** Yahoo, iCloud, Fastmail, Zoho, IONOS or your own mail server have no built-in Claude connector.

So the common mix, a work mailbox plus a personal Outlook.com or a second Gmail, does not fit in Cowork with the built-in connectors alone.

## Several inboxes in one Cowork task

[Custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) are remote MCP servers, and Anthropic lists them as available in Claude, Cowork and Claude Desktop. Claude reaches them from Anthropic's cloud, which has one consequence for Cowork: a local MCP server you configured in \`claude_desktop_config.json\` is not available there. The server has to be reachable on the internet.

MCPEmails is a hosted MCP server, so that is already the case. You connect each mailbox to it once, add one URL to Claude, and every mailbox is in your Cowork tasks:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Any mix of providers.** [Gmail and Google Workspace](/connect/gmail) with a Google app password, [personal Outlook.com, Hotmail and Live](/connect/outlook) and [work Microsoft 365](/connect/office365) with Sign in with Microsoft, [iCloud](/connect/icloud), [Yahoo](/connect/yahoo), [Fastmail](/connect/fastmail), [Zoho](/connect/zoho) and any mailbox that speaks [IMAP and SMTP](/connect/imap).
- **Each mailbox by name.** The task calls \`inbox_list\` and sees every connected address with its display name, so "check info@ and my Outlook" needs no extra setup.
- **Replies from the right address.** Each mailbox sends through its own provider, with its own sender name and signature.
- **Not stored.** Mail is fetched live from your provider for each request and is not kept on our servers.

A personal Outlook.com address connects with Sign in with Microsoft and needs no admin. A work Microsoft 365 account may need its IT admin to approve MCPEmails once for the organization; [Microsoft 365 admin approval](/docs/microsoft-365-admin-consent) explains what they approve and gives them the link.

## Set it up

1. **Connect your mailboxes.** [Create a free MCPEmails account](/signup), open **Inboxes**, then **Connect inbox**, once per mailbox. Give each a clear display name such as "Personal Outlook" or "Acme Sales": it is what Claude reads to tell them apart.
2. **Add the connector to Claude.** Open **Customize → Connectors**, click **+ Add**, then **Add custom connector**. Name it MCPEmails, enter \`https://mcpemails.com/api/mcp\`, click **Continue**, keep the detected sign-in settings and click **Add**. On Team and Enterprise an Owner adds it, and members click **Connect**.
3. **Sign in and choose the access.** **Read-only** for tasks that only read, **Standard** to add drafts and sending, or **Full access** to add scheduling, folders and deleting.
4. **Turn it on in Cowork.** In a task, open the **+** menu and switch MCPEmails on under connectors.

The [Claude setup guide](/blog/connect-claude-to-email) shows each screen, and [Claude custom connectors explained](/blog/claude-custom-connectors-explained) covers what a custom connector can and cannot do.

Cowork itself is on Claude's Pro, Max, Team and Enterprise plans. The Free plan of MCPEmails connects one mailbox; several mailboxes need a paid plan, listed on the [pricing page](/pricing).

## Keep sending under your control

A Cowork task works through many steps on its own, so decide up front what it may do without asking.

- **In Claude.** Anthropic's Cowork guide lets you set each connector tool to **Always allow**, **Needs approval** or **Blocked**. Setting MCPEmails' sending tools to **Needs approval** makes Claude stop before every send. On Team and Enterprise your organization may require approval for write tools anyway.
- **In MCPEmails.** Turn on **Review before sending** for a mailbox and pick how: **Ask in the chat first** makes Claude show you the email and wait for your yes, and **Approve on mcpemails.com** holds each send until a workspace owner or admin approves it, signed in, which Claude cannot do for you. See [human approval for AI email sends](/blog/approve-ai-agent-email-sends).
- **Drafts first.** When you ask for an email, MCPEmails tells Claude to save it as a draft in that mailbox, where you can read and edit it before anything is sent.

Mail is written by other people, and some of it is written to steer an AI. A task that reads mail and can also send should have one of these checks on.

## Prompts for several inboxes

> Using MCPEmails, go through my work inbox and my personal Outlook and list everything from the last two days that needs a reply from me. One list, each line tagged with the inbox. Do not send or move anything.

> Using MCPEmails, find the flight confirmation for next week. Search every connected inbox and tell me which one it is in.

> Using MCPEmails, draft a reply from sales@ to the newest enquiry and save it as a draft. Do not send it.

For the same summary every morning without asking, put the first prompt on a schedule: [daily email briefing with Claude and ChatGPT](/blog/daily-email-briefing-with-claude-and-chatgpt) covers Claude's scheduled tasks. [Multiple email accounts in Claude and ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) covers the same setup in Claude chat and ChatGPT.

## FAQ

**Can Claude Cowork use two Gmail accounts?**
Not through Claude's built-in Gmail connector, which Anthropic describes as reaching the one Google account you connected. Connect both accounts to MCPEmails with Google app passwords and add MCPEmails as a custom connector; a Cowork task then sees both.

**Can Cowork read my personal Outlook.com or Hotmail email?**
Not with Claude's Microsoft 365 connector, which refuses personal Microsoft accounts. Connect the address to MCPEmails with Sign in with Microsoft, then add MCPEmails to Claude. [Connect Claude to Outlook.com and Hotmail](/blog/connect-claude-to-outlook-com-hotmail) has the steps.

**Do custom connectors work in Cowork?**
Yes. Anthropic lists custom connectors as available in Claude, Cowork and Claude Desktop. They must be remote servers reachable on the internet; a local server from the desktop config file is not available in Cowork.

**Do I need one connector per mailbox?**
No. One MCPEmails connector covers every mailbox in your workspace, and the same URL works in Claude chat, Cowork, ChatGPT and other MCP clients.

**Can Claude send email from Cowork?**
Yes, from any mailbox you connected with Standard or Full access. [Can Claude read my email and send emails?](/blog/can-claude-read-my-email#can-claude-send-emails) compares how each connector handles sending.

## Next step

[Start free](/signup), connect the mailbox you check most, add MCPEmails to Claude, and ask a Cowork task what needs a reply today. Add the other inboxes when you want one answer instead of several.`,
};

export default post;
