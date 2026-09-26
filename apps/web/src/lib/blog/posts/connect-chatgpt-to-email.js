const post = {
  slug: 'connect-chatgpt-to-email',
  title: 'Connect ChatGPT to Your Email with MCP (Gmail, iCloud and IMAP)',
  description:
    'Step by step: connect Gmail, iCloud, Fastmail or any IMAP inbox to ChatGPT with a custom MCP connector, and to OpenAI Codex with a scoped key. No email stored.',
  cover: '/blog/cover-email-for-ai-agents-cursor-cline-vscode.svg',
  coverAlt:
    'Connect ChatGPT and OpenAI Codex to Gmail, iCloud, Fastmail and IMAP email with MCP Emails',
  authorId: 'asgeir',
  publishedAt: '2026-09-15T09:00:00.000Z',
  updatedAt: '2026-09-25T09:00:00.000Z',
  tags: ['ChatGPT', 'Codex', 'MCP', 'Email', 'Tutorial'],
  featured: false,
  content: `ChatGPT cannot reach a mailbox on its own. It needs an MCP server in front of your email, and MCP Emails is that server: connect an inbox once, point ChatGPT at a single URL, and it gets the same email tools whether the mail lives in Gmail, iCloud, Fastmail, Yahoo, Zoho or a self-hosted IMAP server.

Two OpenAI surfaces are involved, and they authenticate differently. ChatGPT runs an OAuth flow in the browser, so there is no API key to paste. OpenAI Codex runs in your terminal and uses a scoped bearer key instead. Same endpoint, same tools.

**Jump to:** [ChatGPT setup](#step-2-add-the-connector-in-chatgpt) · [OpenAI Codex](#openai-codex-in-the-terminal) · [Troubleshooting](#troubleshooting)

## What you need

- **ChatGPT Plus, Pro, Business, Enterprise or Edu, on the web.** Custom MCP connectors live behind developer mode, which OpenAI offers on chatgpt.com to those plans. Free and Go accounts cannot add one, and the mobile and desktop apps do not show the option. On Business and Enterprise an admin may need to allow developer mode first.
- **A free MCP Emails account.** [Create one here](/signup). The free plan holds one connected inbox and needs no card.
- **One mailbox.** Gmail, Outlook or Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex, or anything that speaks IMAP and SMTP.

If you are on Free or Go, the same inbox and URL already work in [Claude](/docs/claude), [Cursor](/docs/cursor), [VS Code](/docs/vscode) and the other [supported clients](/docs/clients).

## Step 1: Connect your inbox to MCP Emails

In the MCP Emails dashboard, open **Inboxes**, then **Connect Inbox**, then pick your provider.

### Gmail and Google Workspace

Gmail connects with a Google app password over IMAP by default, and Google OAuth sign-in is also available. Use the app password if a Workspace administrator restricts third-party app access. The [Gmail walkthrough](/blog/connect-gmail-to-claude) has the steps.

### iCloud, Fastmail, Yahoo and Zoho

These want an app-specific password, not the password you type on the web. Create one at the provider, pick the provider in MCP Emails, and paste it in. The [iCloud, Fastmail and IMAP guide](/blog/connect-icloud-fastmail-imap-to-claude) has the exact steps.

### Outlook and Microsoft 365

Outlook connects with Sign in with Microsoft, not an app password: choose **Outlook**, click **Connect with Microsoft**, and approve. Personal Outlook.com, Hotmail, Live and MSN accounts connect straight away. Work or school Microsoft 365 accounts may need an IT admin to approve the app once for the whole organisation first; the dashboard gives you a link to send them. The [Outlook and Microsoft 365 guide](/blog/connect-outlook-microsoft-365-ai-agent-mcp) has the details.

### Any other IMAP mailbox

Choose **IMAP** and enter the address and app password. Common settings are detected automatically; a custom domain may need the host, port and security mode from your provider. The [provider matrix](/docs/providers) lists what each one supports, and there is a page per provider under [connect](/connect), including [Gmail](/connect/gmail), [iCloud](/connect/icloud) and [generic IMAP](/connect/imap).

Connect more than one mailbox if your plan allows it. ChatGPT discovers them with \`inbox_list\`, so you never paste a mailbox id into a prompt.

## Step 2: Add the connector in ChatGPT

1. Turn on **developer mode** in ChatGPT settings, under the apps and connectors advanced settings.
2. Create a new connector and give it a name.
3. Paste this connector URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Choose **OAuth** as the authentication method, create the connector, then authorize with MCP Emails.
5. Open a new chat, click **+**, choose **Developer mode** and select the MCP Emails app. ChatGPT only sees the tools in a chat where you have done this, so repeat it in every new conversation.

Pick OAuth, not "no authentication". This server refuses anonymous calls, so a connector created without authentication looks fine at setup and then fails on its first tool call, which is the confusing way round. With OAuth, ChatGPT registers itself and completes an authorization code flow with PKCE: no client id to create, no client secret anywhere. The menu wording moves as OpenAI iterates on the beta, so check the [ChatGPT setup page](/docs/chatgpt) for the current path.

## Step 3: Approve only the scopes you need

The consent screen is ours, not OpenAI's. The first consent starts at \`read:email\`, which is enough for triage, summarizing and finding things, and takes every irreversible action off the table while you decide how far to go. The other scopes are \`send:email\`, \`search:email\` and \`manage:automations\`.

Granting too little is recoverable: a call that needs a scope your token lacks comes back as a 403 with an insufficient-scope error, so the client can re-consent for that scope and retry. An inbox owner can also require [human approval](/blog/approve-ai-agent-email-sends) in the dashboard, which holds every send, reply, forward, draft send and scheduled send until a person releases it.

## Step 4: Give ChatGPT a safe first task

Start read-only:

> Summarize my three newest unread emails and flag anything that needs a reply today. Do not send, move or delete anything.

ChatGPT finds the inbox first, then reads only the messages it needs. Once that works, try:

- "Find the invoice from Stripe from last month and tell me the amount."
- "Draft a reply to the latest message from Alex, but leave it as a draft."
- "Show me newsletters from this week I could archive, and wait for my confirmation."

For repeatable routines, start from the [inbox triage playbook](/blog/ai-agent-triage-summarize-inbox) or the [workflow prompt collection](/blog/ai-agent-email-workflows-and-prompts).

## What ChatGPT can do once it is connected

MCP Emails hands ChatGPT focused tools rather than a password or a raw IMAP socket:

- **Read and search:** \`email_read\` covers list, read, read_batch, search and attachment. Gmail searches accept operators such as \`from:\` and \`is:unread\`.
- **Send, reply and forward:** \`email_compose\` sends through your own provider and address.
- **Organize:** \`email_organize\`, \`email_search_and_move\` and \`email_delete\`.
- **Drafts, folders and scheduling:** \`draft\`, \`draft_list\`, \`folder\`, \`folder_list\`, \`schedule\` and \`schedule_list\`.
- **The rest:** \`contact_search\`, \`signature_get\`, \`signature_set\`, plus \`automation\` and \`automation_read\` for recurring rules.

One limit to plan around: MCP Emails is poll-based. There are no webhooks and no server-initiated events, so ChatGPT checks for new mail when you ask it to rather than the moment a message lands.

## OpenAI Codex in the terminal

Codex is a different surface from ChatGPT connectors, and the browser OAuth flow is not the path there. A terminal client authenticates with a bearer token instead:

1. In the dashboard, open **API Keys** and create a key, ticking only the scopes this agent needs.
2. Copy it immediately. The key looks like \`mcpe_\` followed by 64 hex characters and is shown once.
3. Register \`https://mcpemails.com/api/mcp\` as a streamable HTTP MCP server in Codex's own MCP configuration, passing the key as an \`Authorization: Bearer\` header.

Key and OAuth connections hit the same endpoint and see the same tool catalogue. The only difference is where the token came from. To sanity-check the endpoint first, the [raw HTTP guide](/docs/curl) has a one-line \`tools/list\` call, and [OAuth vs API keys](/blog/oauth-vs-api-keys-ai-email-access) explains when each path is right.

Scope the key tightly. Read-only is usually correct for a coding agent: one that can summarize a support thread is useful, one that can send mail unattended is a different risk category.

## Troubleshooting

- **No option to create a custom connector.** Developer mode needs Plus, Pro, Business, Enterprise or Edu, on chatgpt.com in a browser. Free and Go accounts do not have it. On a Business or Enterprise workspace, an admin has to allow it.
- **The connector fails on its first tool call.** It was probably created with no authentication. Delete it and recreate it with OAuth.
- **The connector is created, but ChatGPT answers without touching your mail.** It is not switched on in this chat. Click **+**, choose **Developer mode** and select the MCP Emails app, then ask again.
- **The provider rejects your password.** Use a provider-generated app password, not your web sign-in password. Some providers only issue one once two-factor authentication is on.
- **A custom IMAP connection times out.** Confirm the host, port and TLS mode. Port 993 normally uses implicit TLS; port 143 normally uses STARTTLS.
- **ChatGPT connects but sees no mail.** Check the inbox is active in the dashboard, confirm the connection holds \`read:email\`, and ask ChatGPT to call \`inbox_list\` first.

## FAQ

**Can ChatGPT read and send my email?**
Through a custom MCP connector, yes: reading, searching, sending, replying, forwarding, organizing and scheduling, all limited to the scopes you approve at setup.

**Do I need an API key for ChatGPT?**
No. Choose OAuth and ChatGPT registers itself and completes the flow. API keys are for clients that cannot run a browser flow, such as Codex and scripts.

**Is Codex set up the same way?**
No. Codex is a terminal surface, so it uses a scoped API key on an \`Authorization: Bearer\` header instead of the browser OAuth flow. Same endpoint, same tools.

**Is my email stored on your servers?**
No. Every message is fetched live from your provider for the request that asked for it, then discarded. Only the encrypted provider credential is retained. [Why never storing email matters](/blog/why-email-never-stored-matters) explains the reasoning.

**What does it cost?**
Free covers one connected inbox and 150 billable email actions per UTC calendar month, with the first 7 days uncounted. That monthly cap applies to workspaces created on or after 2026-09-13; workspaces created earlier are exempt. Paid plans add inboxes and remove the cap: see [pricing](/pricing).

## Next step

[Start free](/signup), connect an inbox, add \`https://mcpemails.com/api/mcp\` to ChatGPT, and ask it to summarize your unread mail. The [ChatGPT setup page](/docs/chatgpt) has the current click path; the [documentation](/docs) has the full tool reference.`,
};

export default post;
