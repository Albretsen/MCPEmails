const post = {
  slug: 'connect-claude-to-outlook-com-hotmail',
  title: 'Connect Claude to Hotmail and Outlook.com (Personal Accounts)',
  description:
    "Claude's Microsoft 365 connector does not accept personal Microsoft accounts. Connect a Hotmail, Outlook.com, Live or MSN inbox to Claude with Sign in with Microsoft and one custom connector URL.",
  cover: '/blog/cover-connect-outlook-microsoft-365-ai-agent-mcp.svg',
  coverAlt: 'Claude connected to a personal Outlook.com or Hotmail inbox through MCPEmails',
  authorId: 'asgeir',
  publishedAt: '2026-10-20T09:00:00.000Z',
  updatedAt: '2026-10-20T09:00:00.000Z',
  tags: ['Claude', 'Outlook', 'Tutorial', 'MCP'],
  featured: false,
  content: `To connect Claude to a personal Outlook.com, Hotmail, Live or MSN address, you add the mailbox to MCPEmails with **Connect with Microsoft**, then add one URL to Claude as a custom connector. Claude's own Microsoft 365 connector requires a business Microsoft tenant, and Anthropic says personal Microsoft accounts can't be used with it. A custom connector has no such requirement, so an old hotmail.com address works the same way as a new outlook.com one.

This guide is for personal Microsoft accounts in Claude. If your mail is a work or school Microsoft 365 account, read the [Outlook and Microsoft 365 guide](/blog/connect-outlook-microsoft-365-ai-agent-mcp) instead.

## Why Claude's Microsoft 365 connector refuses personal accounts

Anthropic's [Microsoft 365 connector help page](https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector) sets two conditions before anyone can connect:

- The account must belong to a Microsoft Entra tenant tied to a Microsoft Business plan.
- A Global Administrator in that tenant has to authorize the integration first.

The same page says personal Microsoft accounts, such as @outlook.com or @hotmail.com addresses, can't be used to connect. A personal account has no business tenant and no administrator behind it, so there is nothing to approve and no setting you can change to make it work. The connector is made for organisations: it searches SharePoint, OneDrive, Outlook and Teams, and its permissions are read-only until an administrator turns on write tools.

Your mailbox itself is fine. Claude simply needs a different route to it.

## What you need

- A personal Microsoft account with an Outlook mailbox: an address on outlook.com, hotmail.com, live.com or msn.com, including country versions such as hotmail.co.uk, outlook.de or live.no.
- Claude on the web or Claude Desktop. Anthropic offers custom connectors on every Claude plan, including Free, which allows one custom connector.
- An MCPEmails account. [Start free](/signup) and keep the tab open.

MCPEmails sits between the two. It talks to Claude over the Model Context Protocol on one side and to your Outlook.com mailbox through Microsoft Graph on the other.

## Step 1: Connect your Outlook.com or Hotmail inbox

1. In the MCPEmails dashboard, go to **Inboxes** and click **Connect inbox**.
2. Pick **Outlook**, then click **Connect with Microsoft**.
3. Sign in on Microsoft's own page with your Outlook.com, Hotmail, Live or MSN address, and complete two-step verification if your account uses it.
4. Review the permissions and approve. Microsoft asks to let MCPEmails read and change your mail, send mail as you, keep that access, and see your basic profile and email address.

You land back in the dashboard with the inbox connected. No administrator is involved for a personal account, and you never type your Microsoft password into MCPEmails.

### Do not use IMAP or an app password

Many older guides tell you to create an app password and enter Outlook's IMAP settings. That no longer works: Microsoft [ended password sign-in for Outlook accounts in non-Microsoft mail apps](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d) on 16 September 2024. If you choose **IMAP / SMTP** and type a Hotmail or Outlook.com address, the dashboard shows a notice with a **Use Sign in with Microsoft** button that takes you back to the Outlook option. The [Outlook.com settings page](/connect/outlook) has the provider details in one place.

## Step 2: Add MCPEmails to Claude as a custom connector

In claude.ai or Claude Desktop:

1. Open **Customize → Connectors**.
2. Click **+ Add**, then **Add custom connector**.
3. Give it a name, for example MCPEmails, and paste this URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Click **Continue**, keep the authentication settings Claude detects, and click **Add**.
5. Click **Connect**, sign in to your MCPEmails account, and approve the permissions you want Claude to have, for example \`read:email\` to read mail and \`send:email\` to send it.

To use it in a chat, click **+** in the lower left of the message box, choose **Connectors** and switch MCPEmails on. There is no API key to create and no config file to edit. On a Team or Enterprise plan, only an owner can add a custom connector; members then find it under **Customize → Connectors** and click **Connect**. If Claude gets stuck on any of these screens, the [Claude setup page](/docs/claude) covers the common problems.

## Step 3: Ask Claude something small

Start with a read-only request:

> Summarize my five newest unread emails in my Hotmail inbox and tell me which ones need a reply.

Claude uses the \`email_read\` tool to list and open the messages. If it answers, the connection works. Then try:

- "Find the order confirmation I got last week and tell me the delivery date."
- "Draft a reply to the latest email from my landlord, but don't send it."
- "Move every newsletter from this month into a folder called Reading."

If you also have Gmail, iCloud or a work mailbox, connect them the same way and Claude sees all of them through the same connector. [Multiple email accounts in Claude and ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explains how Claude keeps them apart.

## What Claude can do with an Outlook.com inbox

Once connected, Claude works through the same email tools it uses for any other provider:

- Read and search mail.
- Send, reply and forward from your own address, with attachments.
- Create and edit drafts, and schedule a send for later.
- Create folders, including nested ones, and move, copy and archive messages.
- Flag messages and mark them read or unread.
- Move messages to Deleted Items or delete them permanently.
- Add the signature you set for that inbox to every message it sends.

Outlook.com organises mail in folders, not labels, so Claude files mail by moving it into a folder. One Microsoft Graph limit is worth knowing: a text search cannot be combined with the unread, attachment, flagged or date filters. When a search includes text, those filters are dropped, and the result tells Claude which ones. Ask for the text first and let Claude narrow the results.

MCPEmails does not push new mail to Claude. Claude checks when you ask it to, which suits triage and summaries.

## Is my Outlook.com mail stored anywhere?

No. Each time Claude asks for a message, MCPEmails fetches it live from Microsoft, hands it to Claude, and discards it. The only thing kept for the inbox is the OAuth token from your Microsoft sign-in, encrypted at rest. To disconnect, delete the inbox in MCPEmails, or remove MCPEmails from the apps that have access to your Microsoft account. [Why "email is never stored" matters](/blog/why-email-never-stored-matters) explains the model, and [is it safe to give an AI agent email access?](/blog/is-it-safe-to-give-ai-agent-email-access) covers what to watch for, such as instructions hidden inside an email.

## FAQ

**Can I connect Claude to Outlook.com or Hotmail?**
Yes. Claude's built-in Microsoft 365 connector does not support personal Microsoft accounts, but a custom connector does. Connect the address to MCPEmails with Connect with Microsoft, add \`https://mcpemails.com/api/mcp\` to Claude under Customize → Connectors, and Claude can read, search, send and organise your Outlook.com, Hotmail, Live or MSN mail.

**Why does Claude's Microsoft 365 connector reject my Hotmail address?**
Anthropic's help page says that connector needs a Microsoft Entra tenant tied to a Microsoft Business plan and a Global Administrator to authorize it, and that personal Microsoft accounts can't be used. A personal account has no tenant and no administrator.

**Do I need an app password or IMAP settings?**
No. Personal Microsoft accounts connect through Sign in with Microsoft and Microsoft Graph. Microsoft no longer accepts password sign-in from non-Microsoft mail apps on these accounts, so an app password would not log in anyway.

**Does it work with an old Hotmail address?**
Yes. Hotmail, Live, MSN and Outlook.com addresses are the same Microsoft consumer mail service, so they all connect the same way. If the Microsoft account you sign in with has no Outlook mailbox behind it, MCPEmails refuses the connection and tells you so.

**Does the same setup work in ChatGPT?**
Yes. The URL is the same, and [connecting ChatGPT to Hotmail and Outlook.com](/blog/connect-chatgpt-to-outlook-com-hotmail) walks through ChatGPT's side, where you add it as a custom MCP server.

## Next step

[Start free](/signup), connect your Outlook.com or Hotmail inbox with Microsoft, add the URL to Claude, and ask it to summarize your unread mail. For every other provider, the [Claude email setup guide](/blog/connect-claude-to-email) covers Gmail, iCloud, Fastmail and IMAP.`,
};

export default post;
