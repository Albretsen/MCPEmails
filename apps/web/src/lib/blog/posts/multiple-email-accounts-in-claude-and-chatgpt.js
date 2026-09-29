// Facts about Claude's and ChatGPT's own connectors below were checked on
// 2026-09-29 against the vendors' help centres:
//   - support.claude.com/en/articles/10166901 (Google Workspace connectors):
//     Claude reaches "the Google account you've connected".
//   - help.openai.com/en/articles/6825453 (ChatGPT release notes): 2026-08-28,
//     multiple accounts for the Gmail, Google Calendar and Google Contacts
//     plugins on Plus, Pro, Business and Enterprise; 2026-09-17, multiple
//     accounts extended to other plugins, all plans.
// Re-check both before editing the "What the built-in connectors do" section;
// these products change monthly. Prices are deliberately not quoted: they are
// on /pricing, and a repricing must not leave this post wrong.
const post = {
  slug: 'multiple-email-accounts-in-claude-and-chatgpt',
  title: 'Multiple Email Accounts in Claude and ChatGPT: Every Mailbox, One Connector',
  description:
    'How to put several email accounts into Claude and ChatGPT at once, including company mailboxes on IONOS, Zoho, Namecheap, Google Workspace or your own server, with one MCP connector that works in both.',
  cover: '/blog/cover-agent-inbox.svg',
  coverAlt:
    'Several work and personal email accounts connected to Claude and ChatGPT through one MCP connector',
  authorId: 'asgeir',
  publishedAt: '2026-09-29T09:00:00.000Z',
  updatedAt: '2026-09-29T09:00:00.000Z',
  tags: ['Multiple inboxes', 'Claude', 'ChatGPT', 'MCP'],
  featured: false,
  content: `You want to ask one question and have it answered across every mailbox you run: your own address, info@, sales@, the invoices inbox, maybe a personal Gmail. This guide shows how to get several email accounts into Claude and ChatGPT at the same time, what the built-in connectors already cover, and where you need an MCP server instead.

**Jump to:** [Built-in connectors](#what-the-built-in-connectors-do) · [One connector for every mailbox](#one-connector-for-every-mailbox) · [Claude setup](#add-it-to-claude) · [ChatGPT setup](#add-it-to-chatgpt) · [Plans](#how-many-mailboxes-each-plan-connects)

## What the built-in connectors do

Both assistants ship their own mail connectors, and they have moved quickly, so here is where they stood when this was written (September 2026).

- **ChatGPT.** Since late August 2026 its own Gmail, Google Calendar and Google Contacts plugins can hold more than one account on Plus, Pro, Business and Enterprise, so a personal and a work Gmail can sit in the same conversation. In September OpenAI extended multiple accounts to other plugins. If every mailbox you have is a Google account, ChatGPT's own plugin may be all you need.
- **Claude.** Anthropic's help centre describes the Gmail connector as reaching "the Google account you've connected". One Google account per connection.

What neither is built for is the mailbox a company actually runs on its own domain when that domain is not on Google or Microsoft: IONOS, Zoho Mail, Namecheap Private Email, STRATO, Migadu, a cPanel host or your own server. Those speak IMAP and SMTP, and reaching them takes something that speaks IMAP.

## One connector for every mailbox

MCP Emails is a hosted MCP server. You connect each mailbox to it once, and your AI client reaches all of them through one URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

- **Any mix of providers.** Gmail and Google Workspace (app password or Sign in with Google), Outlook and Microsoft 365 (Sign in with Microsoft), iCloud, Fastmail, Yahoo, Zoho, Yandex, and any mailbox that speaks IMAP and SMTP. There is a page per host under [connect](/connect), including [IONOS](/connect/ionos), [Zoho Mail](/connect/zoho), [Namecheap](/connect/namecheap), [STRATO](/connect/strato), [Migadu](/connect/migadu), [Google Workspace](/connect/google-workspace) and [Microsoft 365](/connect/office365).
- **The same mailboxes in both assistants.** It is a standard MCP server, so the one connection works in Claude and in ChatGPT, and in Cursor, VS Code and other MCP clients too. Add a mailbox once and every client sees it.
- **The agent knows which mailbox is which.** It calls \`inbox_list\` and gets every connected address with its display name. Every other tool names the mailbox it acts on, so you just say "in sales@" in plain language.
- **Replies leave from the right address.** Each mailbox sends through its own provider or SMTP server, with its own sender name and signature. A reply to a thread in support@ goes out from support@.

Mail is fetched live for each request and not stored. The one exception is a message you schedule for later, which is held until it is sent.

## Connect the mailboxes

In the MCP Emails dashboard, open **Inboxes**, then **Connect Inbox**, once per mailbox:

- **Company mailbox on its own domain.** Choose **IMAP** and type the address. Common hosts are recognised from the address, and a Google Workspace domain is recognised from its mail records, so the settings fill themselves in. Use the password or app password your host requires.
- **Gmail or Google Workspace.** An app password, or Sign in with Google. On Workspace, your administrator decides whether app passwords and IMAP are allowed.
- **Outlook or Microsoft 365.** Sign in with Microsoft. A work or school account may need its IT admin to approve the app once for the whole organisation.

Give each mailbox a clear display name, such as "Acme Sales" rather than "work2". It is what the agent reads to tell them apart, and it is the name recipients see.

## Add it to Claude

In claude.ai or Claude Desktop:

1. Open **Settings**, then **Connectors**.
2. Choose **Add custom connector** and paste \`https://mcpemails.com/api/mcp\`.
3. Select **Connect**, sign in to MCP Emails, and approve.

Every mailbox you connected is now available. The [Claude guide](/blog/connect-claude-to-email) has the details.

## Add it to ChatGPT

Custom connectors need ChatGPT Plus, Pro, Business, Enterprise or Edu on the web, with developer mode switched on. On Business and Enterprise an admin may need to allow it first.

1. Turn on **developer mode** in ChatGPT settings, under the apps and connectors advanced settings.
2. Create a connector, paste \`https://mcpemails.com/api/mcp\`, choose **OAuth**, and authorize with MCP Emails.
3. In each new chat, click **+**, choose **Developer mode** and select the MCP Emails app.

The [ChatGPT guide](/blog/connect-chatgpt-to-email) covers the menus and the common errors.

## Prompts that use several mailboxes

> Go through sales@ and info@ and list every enquiry from this week that nobody has answered. One combined list, tagged with the mailbox it came from. Do not send or move anything.

> Find the Hetzner invoice from August. Search every connected mailbox and tell me which one it is in.

> Draft a reply from support@ to the latest delivery complaint. Show it to me before sending.

One call reaches one mailbox, so "search every mailbox" is the agent running the search once per mailbox and merging the answers. Ask for one combined list, or you get one report per account. [Managing multiple email accounts with AI](/blog/manage-multiple-email-accounts-with-ai) goes deeper into scoping, sender identity and per-mailbox review.

## Keep a human on the send button

Turn on **Review before sending** for any mailbox and every send, reply, forward, draft send and scheduled send from it waits for your approval in the dashboard. It is set per mailbox, so the invoices inbox can be held while your own sends freely. It is included on every plan, Free too. See [human approval for AI email sends](/blog/approve-ai-agent-email-sends).

## How many mailboxes each plan connects

- **Free:** one mailbox.
- **Personal:** three mailboxes.
- **Pro:** every mailbox you run, with no limit, on one login.
- **Team:** for when a second person needs a login of their own.

A company with info@, sales@ and invoices@ plus your own address is four mailboxes, which is Pro. Current prices are on the [pricing page](/pricing), and [MCP Emails for business](/for/business) shows how one person runs every company mailbox from one agent.

## FAQ

**Can Claude use more than one email account at once?**
Yes, through an MCP server. Connect each mailbox to MCP Emails, add one custom connector to Claude, and Claude sees all of them and names the mailbox on every call.

**Can ChatGPT use more than one email account?**
Its own Gmail plugin can now hold several Google accounts. For mailboxes that are not on Google, such as a company address at IONOS, Zoho or a cPanel host, add MCP Emails as a custom connector and every connected mailbox is available.

**Do I need a separate connector per mailbox?**
No. One connector URL covers every mailbox in your MCP Emails workspace, and the same URL works in Claude, ChatGPT and other MCP clients.

**Will a reply go out from the right address?**
Yes. Each mailbox sends through its own provider or mail server with its own display name and signature. Sending from an address that is not the mailbox's own works only for a verified Gmail Send As address on a mailbox connected with Sign in with Google, and is refused elsewhere.

**Is the mail from all those accounts stored?**
No. Message content is fetched live from your provider on each request and discarded. The encrypted credential for each mailbox is what is kept. See [security](/security).

## Next step

[Start free](/signup) with your busiest mailbox, add the MCP Emails connector to Claude or ChatGPT, and ask what needs a reply today. Add the other mailboxes when you want one answer instead of several.`,
};

export default post;
