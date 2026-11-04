// Facts about ChatGPT's Outlook plugin were checked on 2026-10-29:
//   - help.openai.com/en/articles/12512241 (Outlook Email and Calendar apps in
//     ChatGPT): does not say whether personal Microsoft accounts are supported;
//     "Some actions require Microsoft permissions that a Microsoft Entra
//     administrator must approve for your organization"; workspace admins
//     enable actions.
//   - learn.microsoft.com/en-gb/answers/questions/5558072 (Microsoft Q&A,
//     2025-09-17): the Outlook login step said only business or education
//     accounts can connect; a reply dated 2026-04-17 says personal Hotmail and
//     Outlook accounts were still unsupported.
// No OpenAI page confirms either way, so the post reports what users see and
// says OpenAI does not document it. Re-check before strengthening the claim.
// MCPEmails side mirrors connect-claude-to-outlook-com-hotmail.js and
// src/lib/connect/content/en/outlook.json (Microsoft Graph, Connect with
// Microsoft, permissions, Graph search filter limit).
const post = {
  slug: 'connect-chatgpt-to-outlook-com-hotmail',
  title: 'Connect ChatGPT to Hotmail and Outlook.com (Personal Accounts)',
  description:
    "ChatGPT's Outlook plugin is built for work and school accounts. Connect a personal Hotmail, Outlook.com, Live or MSN inbox to ChatGPT with Sign in with Microsoft and one custom MCP server URL.",
  cover: '/blog/cover-connect-outlook-microsoft-365-ai-agent-mcp.svg',
  coverAlt: 'ChatGPT connected to a personal Outlook.com or Hotmail inbox through MCPEmails',
  authorId: 'asgeir',
  publishedAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  tags: ['ChatGPT', 'Outlook', 'Tutorial', 'MCP'],
  featured: false,
  content: `To connect ChatGPT to a personal Outlook.com, Hotmail, Live or MSN address, add the mailbox to MCPEmails with **Connect with Microsoft**, then add one URL to ChatGPT as a custom MCP server. ChatGPT's own Outlook plugin is built around work and school Microsoft accounts, and people who try it with a personal address report being told that only business or education accounts can connect. A custom MCP server has no such limit.

This guide is for personal Microsoft accounts in ChatGPT. For Claude, read [Connect Claude to Hotmail and Outlook.com](/blog/connect-claude-to-outlook-com-hotmail). For a work or school Microsoft 365 account, read the [Outlook and Microsoft 365 guide](/blog/connect-outlook-microsoft-365-ai-agent-mcp).

## What ChatGPT's Outlook plugin supports

ChatGPT has Outlook Email and Outlook Calendar plugins. OpenAI's [help page for them](https://help.openai.com/en/articles/12512241) is written for organisations: some actions need Microsoft permissions that a Microsoft Entra administrator must approve for the organisation, and workspace admins choose which actions are switched on. The page does not say whether personal Microsoft accounts are supported.

Users who have tried say they are not. In a [Microsoft Q&A thread](https://learn.microsoft.com/en-gb/answers/questions/5558072/cant-connect-outlook-to-chatgpt) from September 2025, a Hotmail user was stopped at the Outlook sign-in step with a message that only business or education accounts can be connected. A reply from April 2026 says personal Hotmail and Outlook.com accounts still could not connect. OpenAI has not documented a change since, so check the plugin first if you want to try: if it accepts your address, you may not need anything else.

If it refuses you, the reason is the account type. A personal Microsoft account has no organisation and no administrator behind it. There is no setting on your side that changes that.

## What you need

- A personal Microsoft account with an Outlook mailbox: outlook.com, hotmail.com, live.com or msn.com, including country versions such as hotmail.co.uk or outlook.de.
- **ChatGPT Go or a paid plan, on chatgpt.com in a browser.** OpenAI lets those plans add a custom MCP server. Free cannot, and you cannot add one in the mobile app.
- An MCPEmails account. [Start free](/signup); the free plan connects one inbox.

MCPEmails talks to ChatGPT over the Model Context Protocol on one side and to your mailbox through Microsoft Graph on the other.

## Step 1: Connect your Outlook.com or Hotmail inbox

1. In the MCPEmails dashboard, go to **Inboxes** and click **Connect inbox**.
2. Pick **Outlook**, then click **Connect with Microsoft**.
3. Sign in on Microsoft's own page with your Outlook.com, Hotmail, Live or MSN address, and complete two-step verification if your account uses it.
4. Approve the permissions. Microsoft asks to let MCPEmails read and change your mail, send mail as you, keep that access, and see your basic profile and email address.

You land back in the dashboard with the inbox connected. No administrator is involved for a personal account, and you never type your Microsoft password into MCPEmails.

### Skip IMAP and app passwords

Older guides tell you to create an app password and enter Outlook's IMAP settings. Microsoft [ended password sign-in for Outlook accounts in non-Microsoft mail apps](https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d) on 16 September 2024, so that route no longer logs in. If you choose **IMAP / SMTP** and type a Hotmail or Outlook.com address, the dashboard points you back to **Use Sign in with Microsoft**. The [Outlook.com settings page](/connect/outlook) has the details in one place.

## Step 2: Add MCPEmails to ChatGPT

1. On chatgpt.com, open **Plugins**, then **Personal**, and click **Add** at the top right.
2. Choose **Add custom MCP server** and name it MCPEmails.
3. Under **Connection**, paste this URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Choose **OAuth**, tick **I understand and want to continue**, and click **Create as a plugin**.
5. Sign in to MCPEmails and approve the access you want ChatGPT to have, for example reading only to begin with.
6. In a chat, type **@** and pick MCPEmails. The pick applies to that message, so @mention it again when a follow-up needs your mail.

Pick OAuth, not "no authentication". A connector created without it looks fine at setup and then fails on its first call. On a Business or Enterprise workspace, an admin may need to add the server for you. OpenAI moves these menus now and then; the [ChatGPT setup page](/docs/chatgpt) has the current path.

## Step 3: Ask ChatGPT something small

Start read-only:

> Summarize my five newest unread emails in my Hotmail inbox and tell me which ones need a reply.

If it answers, the connection works. Then try:

- "Find the order confirmation I got last week and tell me the delivery date."
- "Draft a reply to the latest email from my landlord, but don't send it."
- "Move every newsletter from this month into a folder called Reading."

If you also have Gmail, iCloud, Yahoo or a work mailbox, connect them to MCPEmails too, and ChatGPT sees all of them through the same server. [Multiple email accounts in Claude and ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) explains how it keeps them apart.

## What ChatGPT can do with an Outlook.com inbox

- Read and search mail.
- Send, reply and forward from your own address, with attachments.
- Create and edit drafts, and schedule a send for later.
- Create folders, including nested ones, and move, copy and archive messages.
- Flag messages and mark them read or unread.
- Move messages to Deleted Items or delete them permanently.
- Add the signature you set for the inbox to every message it sends.

Outlook.com uses folders, not labels, so ChatGPT files mail by moving it. One Microsoft Graph limit is worth knowing: a text search cannot be combined with the unread, attachment, flagged or date filters. When a search includes text, those filters are dropped and the result says which ones. Ask for the text first and let ChatGPT narrow the results.

MCPEmails does not push new mail to ChatGPT. It checks when you ask.

## Is my Outlook.com mail stored anywhere?

No. Each time ChatGPT asks for a message, MCPEmails fetches it live from Microsoft, hands it over, and discards it. What is kept for the inbox is the OAuth token from your Microsoft sign-in, encrypted at rest, plus the few details a feature you turn on needs, such as a scheduled message waiting to go out. To disconnect, delete the inbox in MCPEmails, or remove MCPEmails from the apps that have access to your Microsoft account. [Why "email is never stored" matters](/blog/why-email-never-stored-matters) explains the model.

## FAQ

**Can I connect ChatGPT to Hotmail or Outlook.com?**
Yes, with a custom MCP server. Connect the address to MCPEmails with Connect with Microsoft, add \`https://mcpemails.com/api/mcp\` to ChatGPT under Plugins, and ChatGPT can read, search, send and organise your Outlook.com, Hotmail, Live or MSN mail. Adding a custom MCP server needs ChatGPT Go or a paid plan.

**Does ChatGPT's Outlook plugin work with a personal account?**
OpenAI's help page does not say so, and users report being told at sign-in that only business or education accounts can connect. Its documented setup relies on an organisation's Microsoft Entra administrator, which a personal account does not have.

**Do I need an app password or IMAP settings?**
No. Personal Microsoft accounts connect through Sign in with Microsoft and Microsoft Graph. Microsoft no longer accepts password sign-in from non-Microsoft mail apps on these accounts.

**Does it work with an old Hotmail address?**
Yes. Hotmail, Live, MSN and Outlook.com addresses are the same Microsoft consumer mail service and connect the same way.

**Does the same setup work in Claude?**
Yes, with the same URL. [Connect Claude to Hotmail and Outlook.com](/blog/connect-claude-to-outlook-com-hotmail) walks through Claude's side, and works on every Claude plan, including Free.

## Next step

[Start free](/signup), connect your Outlook.com or Hotmail inbox with Microsoft, add the URL to ChatGPT, and ask it to summarize your unread mail. For other providers, [Connect ChatGPT to your email](/blog/connect-chatgpt-to-email) covers Gmail, iCloud and IMAP.`,
};

export default post;
