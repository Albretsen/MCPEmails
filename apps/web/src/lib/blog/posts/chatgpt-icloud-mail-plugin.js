// Facts about ChatGPT's iCloud Mail plugin were read on 2026-10-29 at:
//   - help.openai.com/en/articles/11487775 (Connected apps in ChatGPT):
//     "iCloud Mail and iCloud Calendar are separate plugins, and both include
//     read-only contact lookup"; rolling out "to all ChatGPT plans on web,
//     desktop, and iOS, subject to workspace app controls"; "Both plugins use
//     an Apple app-specific password"; Mail takes an address ending in
//     @icloud.com, @me.com or @mac.com; Calendar takes the primary Apple
//     Account email.
//   - x.com/ChatGPT/status/2115139248458191070 (launch post, 2026-10-27).
//   - 9to5mac.com/2026/10/27/icloud-mail-and-calendar-plugins-now-work-with-chatgpt
//     and digitaltrends.com (launch coverage): search, summarize, draft, send,
//     contact lookup; only mail stored in iCloud Mail, not Gmail or Outlook
//     accounts added to Apple Mail.
//   - support.apple.com/en-us/102654: app-specific passwords need two-factor
//     authentication; Sign-In and Security > App-Specific Passwords; Remove or
//     Revoke All; changing or resetting the Apple Account password revokes
//     every app-specific password.
// No OpenAI page says whether the plugin can move or delete mail, so the post
// does not claim either way. Claude's built-in email connectors (Gmail and
// Microsoft 365) are sourced in can-claude-read-my-email.js.
const post = {
  slug: 'chatgpt-icloud-mail-plugin',
  title: "ChatGPT's iCloud Mail Plugin: Setup, Limits and Other Accounts",
  description:
    "How to connect iCloud Mail to ChatGPT with OpenAI's new plugin, what it can and cannot reach, why your other Apple Mail accounts are missing, and how to use iCloud in Claude too.",
  cover: '/blog/cover-connect-icloud-fastmail-imap-to-claude.svg',
  coverAlt: 'iCloud Mail connected to ChatGPT and Claude',
  authorId: 'asgeir',
  publishedAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  tags: ['ChatGPT', 'iCloud', 'Claude', 'Tutorial'],
  featured: false,
  content: `On 27 October 2026 OpenAI added an iCloud Mail plugin and an iCloud Calendar plugin to ChatGPT. The Mail plugin lets ChatGPT search, read, draft and send mail in one iCloud mailbox, using an Apple app-specific password. It covers iCloud only: Gmail, Outlook or work accounts you have added to the Mail app on your iPhone or Mac stay out of reach, and Claude has no iCloud option of its own.

This guide covers how to set the plugin up, what it does, the problems people run into, and what to use when you need iCloud in Claude or several inboxes in one place.

**Jump to:** [Setup](#how-to-connect-icloud-mail-to-chatgpt) · [What it can do](#what-the-icloud-mail-plugin-can-do) · [Not working?](#icloud-plugin-not-working) · [Other accounts](#why-your-other-apple-mail-accounts-are-missing) · [Claude](#icloud-mail-in-claude) · [FAQ](#faq)

## How to connect iCloud Mail to ChatGPT

OpenAI's [connected apps help page](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt) says the plugins are rolling out to every ChatGPT plan, Free included, on the web, the desktop app and iOS. Mail and Calendar are separate plugins, so connecting one does not connect the other.

1. **Turn on two-factor authentication** for your Apple Account if it is off. Apple [only issues app-specific passwords](https://support.apple.com/en-us/102654) to accounts protected with it.
2. **Create an app-specific password.** Sign in at account.apple.com, open **Sign-In and Security**, choose **App-Specific Passwords**, and generate one. Name it ChatGPT so you can find it later.
3. **Open the plugin in ChatGPT.** Go to **Settings**, then **Plugins**, and pick **iCloud Mail**.
4. **Enter your iCloud address and the app-specific password.** OpenAI asks for an address ending in @icloud.com, @me.com or @mac.com.

Your normal Apple Account password will not work here. That is Apple's rule for every app outside Apple's own, and it is the same password type a third-party mail app uses.

## What the iCloud Mail plugin can do

From OpenAI's help page and the launch coverage by [9to5Mac](https://9to5mac.com/2026/10/27/icloud-mail-and-calendar-plugins-now-work-with-chatgpt/) and others, the Mail plugin can:

- Search your iCloud mail and read messages.
- Summarize what came in, for example unread mail from today.
- Draft replies and send email.
- Look up your iCloud contacts. Contact lookup is read-only, and there is no separate Contacts or Reminders plugin in this launch.

Neither OpenAI's page nor the launch coverage says the plugin can move messages into folders or delete them, so do not count on inbox cleanup until OpenAI documents it. Accounts managed by a company or school may be blocked by their workspace's app settings.

Disconnecting the plugin in ChatGPT does not delete the app-specific password at Apple. To cut access off for good, remove the password at account.apple.com under **Sign-In and Security**, **App-Specific Passwords**.

## iCloud plugin not working?

The common causes, roughly in the order people hit them:

- **Your Apple password is refused.** Use an app-specific password. If **App-Specific Passwords** is missing at account.apple.com, two-factor authentication is off.
- **The plugin is not listed.** OpenAI is still rolling it out, so it may not have reached your account yet. On a Business or Enterprise workspace, an admin may also have the plugin switched off.
- **Your address is refused.** The Mail plugin asks for an @icloud.com, @me.com or @mac.com address. If you only use a custom domain through iCloud+, enter the iCloud address of the same Apple Account.
- **You changed your Apple Account password.** Apple revokes every app-specific password when you change or reset it, and the same happens with **Revoke All**. Create a new app-specific password and reconnect.
- **A message is in Gmail or Outlook, not iCloud.** See the next section.

## Why your other Apple Mail accounts are missing

The Mail app on an iPhone or Mac shows every account you have added to it in one list. ChatGPT does not read the Mail app. The plugin signs in to Apple's iCloud mail servers directly, so it sees the iCloud mailbox and nothing else. A Gmail, Outlook.com, Yahoo or work account that sits next to iCloud in Apple Mail is invisible to it.

For Gmail and Outlook, ChatGPT has separate plugins you can connect as well. Two catches:

- **Yahoo, AOL, Fastmail, Zoho and company mailboxes on IMAP have no ChatGPT plugin.** [Yahoo Mail with ChatGPT and Claude](/blog/connect-yahoo-mail-to-chatgpt-and-claude) covers that case.
- **A personal Outlook.com or Hotmail address** may be refused by ChatGPT's Outlook plugin. [Connecting ChatGPT to Outlook.com and Hotmail](/blog/connect-chatgpt-to-outlook-com-hotmail) explains why and what works instead.

Each plugin is its own connection, with its own sign-in, and ChatGPT has to be told which one to use.

## iCloud Mail in Claude

Claude has two email connectors of its own, one for Gmail and one for work Microsoft 365 accounts. There is no iCloud option in Claude, and Apple offers no sign-in for iCloud Mail that a third party could use instead of a password. [Can Claude read my email?](/blog/can-claude-read-my-email) goes through Claude's options mailbox by mailbox.

To use iCloud in Claude, you add an MCP server that holds the iCloud connection, and that is what MCPEmails is. It connects to iCloud the same way OpenAI's plugin does, with an app-specific password over IMAP, and then serves the mailbox to any app that speaks the Model Context Protocol: Claude, ChatGPT, Cursor and the other [supported clients](/docs/clients).

1. [Create a free MCPEmails account](/signup). The free plan connects one inbox.
2. In the dashboard, open **Inboxes**, click **Connect inbox**, pick **iCloud Mail**, and paste your iCloud address with a new app-specific password. The [iCloud settings page](/connect/icloud) has the server details and Apple's username quirks.
3. In Claude, open **Customize**, then **Connectors**, click **+ Add**, choose **Add custom connector**, and paste \`https://mcpemails.com/api/mcp\`. The [Claude setup page](/docs/claude) has the full click path.

Claude can then read, search, send, reply, schedule and organize your iCloud mail, including moving messages between folders.

## When the plugin is enough, and when it is not

Use OpenAI's plugin if iCloud is your only mailbox and ChatGPT is your only AI app. It is free on every plan and takes two minutes.

MCPEmails is worth a look when:

- **You use Claude**, or switch between Claude, ChatGPT and a coding tool, and want the same inbox in each.
- **You have more than one mailbox.** Connect iCloud, Gmail, Yahoo, Outlook.com and company IMAP inboxes to one account, and every client sees all of them through one URL. [Multiple email accounts in Claude and ChatGPT](/blog/multiple-email-accounts-in-claude-and-chatgpt) shows how the agent keeps them apart.
- **You want to file and clean up mail**, not only read it: folders, moves, archive, scheduled sends and standing rules.

In ChatGPT, MCPEmails is added as a custom MCP server, which OpenAI allows on Go and paid plans on chatgpt.com, not on Free. The [ChatGPT setup page](/docs/chatgpt) has the steps.

Your mail is never stored by MCPEmails. Each message is fetched live from Apple when the agent asks for it, and only the encrypted app-specific password is kept. Revoking that password at Apple disconnects the inbox at once.

## FAQ

**Can ChatGPT read my iCloud email?**
Yes. Connect the iCloud Mail plugin under Settings, Plugins, with your iCloud address and an Apple app-specific password. OpenAI says it is rolling out to all ChatGPT plans on the web, desktop and iOS.

**Does the ChatGPT iCloud plugin see my Gmail or Outlook accounts in Apple Mail?**
No. It signs in to iCloud's mail servers, not to the Mail app, so it only sees mail stored in iCloud. Connect other accounts with their own plugin, or through an MCP server such as MCPEmails.

**Why does ChatGPT reject my Apple password?**
Apple requires an app-specific password for every app outside Apple's own. Create one at account.apple.com under Sign-In and Security, App-Specific Passwords. Two-factor authentication must be on.

**Does Claude have an iCloud connector?**
No. Claude's own email connectors cover Gmail and work Microsoft 365 accounts. Add iCloud to Claude as a custom connector through an MCP server: connect the mailbox to MCPEmails with an app-specific password and paste \`https://mcpemails.com/api/mcp\` into Claude.

**How do I disconnect iCloud from ChatGPT completely?**
Disconnect the plugin in ChatGPT's settings, then remove the app-specific password at account.apple.com. Disconnecting in ChatGPT alone leaves the password valid at Apple.

## Next step

If iCloud in ChatGPT is all you need, the plugin will do. To have the same iCloud inbox in Claude, or next to your other mailboxes, [start free](/signup), connect iCloud with an app-specific password, and paste one URL into your AI app. The [iCloud, Fastmail and IMAP guide](/blog/connect-icloud-fastmail-imap-to-claude) has more detail on the password step.`,
};

export default post;
