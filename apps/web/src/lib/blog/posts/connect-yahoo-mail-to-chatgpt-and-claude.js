// Facts checked on 2026-10-29:
//   - help.openai.com/en/articles/11487775 (Connected apps in ChatGPT): the
//     email plugins it names are Gmail, Outlook and iCloud Mail; no Yahoo Mail.
//   - Claude's own email connectors are Gmail and Microsoft 365 (sources in
//     can-claude-read-my-email.js); claude.com/connectors lists no Yahoo one.
//   - help.yahoo.com/kb/SLN15241.html: Account Security page, under "External
//     connections", Create app password, name it, Generate password.
//   - MCPEmails Yahoo preset and provider data: src/lib/email-providers/
//     imap-presets.ts and src/lib/connect/providers.mjs (IMAP
//     export.imap.mail.yahoo.com:993 TLS, SMTP smtp.mail.yahoo.com:465 TLS),
//     dashboard hint in messages/en/dashboardChrome.json (hintYahoo).
const post = {
  slug: 'connect-yahoo-mail-to-chatgpt-and-claude',
  title: 'How to Connect Yahoo Mail to ChatGPT and Claude',
  description:
    'ChatGPT and Claude have no Yahoo Mail connector. Connect Yahoo Mail to both with a Yahoo app password and one MCP URL, so the AI can read, search, send and organize your mail.',
  cover: '/blog/cover-connect-email-to-ai-agent-under-2-minutes.svg',
  coverAlt: 'Yahoo Mail connected to ChatGPT and Claude through MCPEmails',
  authorId: 'asgeir',
  publishedAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  tags: ['ChatGPT', 'Claude', 'Yahoo', 'Tutorial'],
  featured: false,
  content: `ChatGPT cannot read Yahoo Mail on its own, and neither can Claude. ChatGPT's email plugins cover Gmail, Outlook and iCloud Mail. Claude's cover Gmail and work Microsoft 365 accounts. To connect Yahoo Mail to either one, you put an MCP server in front of the mailbox. With MCPEmails that takes a Yahoo app password and one URL, and the same Yahoo inbox then works in ChatGPT, Claude and other AI apps.

**Jump to:** [Why there is no built-in option](#why-chatgpt-and-claude-cannot-read-yahoo-mail-yet) · [App password](#step-1-create-a-yahoo-app-password) · [ChatGPT](#step-3a-add-it-to-chatgpt) · [Claude](#step-3b-add-it-to-claude) · [FAQ](#faq)

## Why ChatGPT and Claude cannot read Yahoo Mail yet

OpenAI's [list of connected apps](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt) has plugins for Gmail, Outlook and, since 27 October 2026, [iCloud Mail](/blog/chatgpt-icloud-mail-plugin). It has no Yahoo Mail plugin. Claude's own connectors are for Gmail and Microsoft 365, as [Can Claude read my email?](/blog/can-claude-read-my-email) sets out.

What turns up instead when you search:

- **Browser extensions** that add a ChatGPT button inside Yahoo Mail on the web. They help you write a message in the page you have open. ChatGPT itself still has no access to your inbox, so it cannot search it or work through it for you.
- **Automation platforms** that pass single messages from Yahoo to an AI model when a trigger fires. Useful for one fixed workflow, not for asking questions about your mail in a chat.
- **Copying and pasting** messages into the chat, which works for one email at a time.

An MCP server is the route that gives the AI your actual mailbox. ChatGPT and Claude both accept one as a custom connector, and the server does the Yahoo sign-in.

## What you need

- A Yahoo Mail address: yahoo.com, a country version such as yahoo.co.uk, or the ymail.com or rocketmail.com form you signed up with.
- **For ChatGPT:** Go or a paid plan, on chatgpt.com in a browser. OpenAI does not let Free plans add a custom MCP server, and you cannot add one in the mobile app.
- **For Claude:** any plan, including Free, which allows one custom connector.
- A free MCPEmails account. [Create one here](/signup); the free plan connects one inbox.

## Step 1: Create a Yahoo app password

Yahoo does not let other apps sign in with your normal Yahoo password, so you create an app password for MCPEmails. [Yahoo's help page](https://help.yahoo.com/kb/SLN15241.html) has the steps:

1. Sign in to Yahoo and open your **Account Security** page.
2. Under **External connections**, click **Create app password**.
3. Type a name, for example MCPEmails, and click **Generate password**.
4. Copy the password. Yahoo shows it once.

If you cannot find the option, turn on two-step verification on the same page and look again. To revoke access later, delete this app password on the same screen.

## Step 2: Connect Yahoo Mail to MCPEmails

1. In the MCPEmails dashboard, open **Inboxes** and click **Connect inbox**.
2. Pick **Yahoo Mail**.
3. Enter your full Yahoo address and paste the app password.

The server settings are filled in for you. MCPEmails checks the login against Yahoo before it saves the inbox, so a wrong password fails here, not later in a chat. The [Yahoo Mail settings page](/connect/yahoo) lists the IMAP and SMTP details and the mistakes people make most often.

An AOL address is a separate account with its own app password. Connect it as AOL, using the [AOL settings](/connect/aol).

## Step 3a: Add it to ChatGPT

1. On chatgpt.com, open **Plugins**, then **Personal**, and click **Add**.
2. Choose **Add custom MCP server** and name it MCPEmails.
3. Under **Connection**, paste:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Choose **OAuth**, confirm, click **Create as a plugin**, and sign in to MCPEmails.
5. In a chat, type **@** and pick MCPEmails. Do it again when a follow-up needs your mail.

OpenAI moves these menus from time to time. The [ChatGPT setup page](/docs/chatgpt) has the current path and fixes for the usual errors.

## Step 3b: Add it to Claude

1. In claude.ai or Claude Desktop, open **Customize**, then **Connectors**.
2. Click **+ Add**, then **Add custom connector**.
3. Name it MCPEmails, paste \`https://mcpemails.com/api/mcp\`, click **Continue**, then **Add**.
4. Click **Connect**, sign in to MCPEmails and approve the access you want Claude to have.

In a chat, click **+**, choose **Connectors** and switch MCPEmails on. The [Claude setup page](/docs/claude) covers Team and Enterprise plans, where an owner adds the connector first.

You can do both. One MCPEmails account serves ChatGPT and Claude at the same time, with the same Yahoo inbox.

## What ChatGPT and Claude can do with Yahoo Mail

Start with something read-only:

> Summarize my unread Yahoo mail from today and tell me which messages need a reply.

Once that works, the AI can:

- Read and search your mail by sender, subject, date or unread state.
- Send, reply and forward from your Yahoo address, with attachments.
- Save drafts for you to finish, and schedule a send for later.
- Create folders and move, archive, flag or delete messages.
- Sign every message with the signature you set for the inbox.

A few prompts that suit a Yahoo inbox:

- "Find every newsletter I got this month and move them to a folder called Reading. Show me the list first."
- "Draft a reply to the last email from my landlord, but leave it as a draft."
- "What did the airline send me about my booking last week?"

MCPEmails does not push new mail to the AI. It checks when you ask, which suits catch-ups and cleanup.

## Is it safe?

Your Yahoo mail is never stored by MCPEmails. Each message is fetched live from Yahoo when ChatGPT or Claude asks for it, then discarded. Only the app password is kept, encrypted. Your real Yahoo password is never entered anywhere but Yahoo.

You choose what each AI app may do when you approve the connection: reading only, or sending as well. An inbox owner can also hold every send for approval in the dashboard. [Is it safe to give an AI agent email access?](/blog/is-it-safe-to-give-ai-agent-email-access) covers the risks worth knowing, such as instructions hidden inside an email.

## Troubleshooting

- **Yahoo rejects the password.** Use an app password, not your Yahoo password, and paste it without spaces.
- **No option to create an app password.** Turn on two-step verification on the Account Security page first.
- **ChatGPT has no option to add a custom MCP server.** You need Go or a paid plan, on chatgpt.com in a browser.
- **The AI answers without reading your mail.** In ChatGPT, @mention MCPEmails in that message. In Claude, check MCPEmails is switched on under Connectors.
- **You have Yahoo and another mailbox.** Connect both to MCPEmails. [Multiple email accounts in Claude and ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explains how the AI tells them apart.

## FAQ

**Can ChatGPT read Yahoo Mail?**
Not on its own: ChatGPT has no Yahoo Mail plugin. Connect Yahoo Mail to an MCP server such as MCPEmails with a Yahoo app password, add \`https://mcpemails.com/api/mcp\` to ChatGPT as a custom MCP server, and ChatGPT can read, search and send your Yahoo mail.

**Does Claude work with Yahoo Mail?**
Yes, through a custom connector. Claude's own email connectors cover Gmail and Microsoft 365, so Yahoo goes through an MCP server. Custom connectors work on every Claude plan, including Free.

**Do I need my Yahoo password?**
No. Yahoo does not accept it from other apps. Create an app password under External connections on your Account Security page and use that.

**Will the same setup work in both ChatGPT and Claude?**
Yes. Connect the Yahoo inbox once and add the same URL to each app. Each one signs in to MCPEmails separately, with its own permissions.

**How do I disconnect?**
Remove the inbox in MCPEmails, or delete the app password in Yahoo's Account Security page. Either one cuts access off.

## Next step

[Start free](/signup), connect your Yahoo inbox with an app password, and add one URL to ChatGPT or Claude. [What is an app password?](/blog/what-is-an-app-password) explains the password step for Yahoo, AOL, iCloud and others.`,
};

export default post;
