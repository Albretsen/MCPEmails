// Third-party facts below were checked on 2026-10-20 against the vendors' own
// pages. Re-check them before editing the sections that use them:
//   - support.claude.com/en/articles/11175166 (custom connectors): add one
//     under Customize > Connectors, "+ Add", "Add custom connector", then
//     name + URL, Continue, Add; Team owners use Organization settings >
//     Connectors and members click Connect; the
//     connection to the MCP server originates from Anthropic's servers on
//     every Claude client, the mobile apps included.
//   - support.claude.com/en/articles/11176164 (connectors): a connector added
//     on Claude or Claude Desktop is available the next time you sign in on
//     Claude for iOS or Android; installing on mobile is in beta.
//   - help.openai.com/en/articles/12584461 (custom MCP servers in ChatGPT):
//     connecting a custom MCP server is web only. Plan and role rules change
//     often, so this post links /docs/chatgpt instead of repeating them.
//   - support.apple.com/102654 (app-specific passwords): account.apple.com,
//     Sign-In and Security, App-Specific Passwords; needs two-factor
//     authentication; changing the Apple Account password revokes them all.
//   - support.apple.com/guide/mail/mail35803/mac: Mail > Settings > Accounts.
//   - support.apple.com/102619: Settings > Apps > Mail > Mail Accounts.
//   - support.apple.com/guide/mail/mlhlp1021/mac: On My Mac mailboxes are only
//     on the Mac where they were created.
// The product claims (drafts saved to the provider's Drafts folder, a Sent
// copy appended after an SMTP send, inbox_list) are in
// supabase/functions/mcp-server (index.ts, sent-copy.ts, mcp-app-drafts.ts).
// The consent-screen access levels (Read-only, Standard, Full access, Custom)
// are apps/web/src/lib/oauth/consent-presets.ts and messages/en/auth.json;
// moving mail needs manage:folders (Full access), drafts need manage:drafts.
const post = {
  slug: 'connect-claude-to-apple-mail',
  title: 'Connect Claude to Apple Mail: iCloud, Gmail, Outlook, Yahoo',
  description:
    'Connect Claude to the accounts in Apple Mail (iCloud, Gmail, Outlook.com, Yahoo, IMAP) to read, search, draft and send mail from any device, iPhone included.',
  cover: '/blog/cover-connect-icloud-fastmail-imap-to-claude.svg',
  coverAlt: 'The iCloud, Gmail, Outlook and Yahoo accounts from Apple Mail connected to Claude over MCP',
  authorId: 'asgeir',
  publishedAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  tags: ['Apple Mail', 'iCloud', 'Claude', 'Tutorial'],
  featured: false,
  content: `To connect Claude to Apple Mail, you connect the email accounts Apple Mail shows, not the Mail app itself. Apple Mail is a client: it syncs an iCloud, Gmail, Outlook.com, Yahoo or other IMAP account from that provider's servers. MCPEmails connects Claude to those same accounts on the server side, so Claude sees the same inbox, folders, drafts and sent mail that Apple Mail does, and it works from claude.ai, Claude Desktop and the Claude app on your iPhone. Your Mac does not have to be on.

## Can Claude connect to Apple Mail?

Yes, through the accounts inside it. Apple Mail has no connection of its own that Claude can sign in to, so the reliable route is:

1. Check which accounts Apple Mail uses.
2. Connect each account to MCPEmails, a hosted MCP server.
3. Add MCPEmails to Claude as a custom connector with one URL.

After that, Claude can read, search, draft, send, schedule and organize mail in every connected account, within the access you grant it. The changes show up in Apple Mail on your Mac and iPhone the next time it syncs, because both are looking at the same mailbox.

## Why connect the account and not the Mail app

The Apple Mail MCP servers you will find on GitHub run on your Mac and work through the Mail app itself, with AppleScript or by reading Mail's local index. That works, with limits that follow from the design:

- It only runs on a Mac, with the server installed and Mail available.
- Claude on your iPhone, on a Windows PC or on the web cannot reach it, because the connection lives on that one Mac.
- If the Mac is asleep or closed, the server is unreachable.

A custom connector in Claude works the other way round. Anthropic's help center says the connection to an MCP server comes from Anthropic's servers, not from your device, on every Claude client including the mobile apps. A server-side connection to your mail account fits that model: there is nothing to install, and the same connector works wherever you open Claude.

## Step 1: See which accounts Apple Mail uses

- **On a Mac:** in Mail, choose **Mail → Settings**, then click **Accounts**.
- **On iPhone or iPad:** open **Settings → Apps → Mail → Mail Accounts**.

Each account in that list connects to MCPEmails in one of these ways:

- **iCloud** (@icloud.com, @me.com, @mac.com): an Apple app-specific password. Settings on the [iCloud page](/connect/icloud).
- **Google**: a Google app password. Settings on the [Gmail page](/connect/gmail).
- **Outlook.com, Hotmail, Live or Microsoft 365**: Sign in with Microsoft. A work or school account may need your IT admin to approve MCPEmails once. Details on the [Outlook page](/connect/outlook).
- **Yahoo**: a Yahoo app password. Settings on the [Yahoo Mail page](/connect/yahoo).
- **Other (IMAP)**: your host's IMAP and SMTP settings. See the [custom IMAP page](/connect/imap).

If your provider is not in this list, [every supported provider](/connect) has its own page with the server settings.

## Step 2: Connect each account to MCPEmails

Create a free [MCPEmails account](/signup), open the dashboard, go to **Inboxes → Connect Inbox**, and choose the provider.

### iCloud Mail

Apple does not accept your Apple Account password from other apps. You need an app-specific password:

1. Sign in at [account.apple.com](https://account.apple.com).
2. In **Sign-In and Security**, select **App-Specific Passwords**.
3. Select **Generate an app-specific password**, name it \`MCPEmails\`, and copy the password Apple shows.
4. In MCPEmails, choose **iCloud**, enter your iCloud address and paste that password.

Your Apple Account needs two-factor authentication for this. One thing to know: changing your Apple Account password revokes every app-specific password, so after a password change you generate a new one and reconnect. The [iCloud, Fastmail and IMAP guide](/blog/connect-icloud-fastmail-imap-to-claude) has more detail.

### Gmail

Apple Mail signs in to Google with your Google account. MCPEmails uses a Google app password over IMAP instead, which Google offers once 2-Step Verification is on. Choose **Gmail** and paste the 16-letter password with your address. The [Gmail guide](/blog/connect-gmail-to-claude) covers Workspace accounts where an administrator has turned app passwords off.

### Outlook.com, Hotmail and Microsoft 365

Choose **Outlook** and click **Connect with Microsoft**. There is no password to paste.

### Yahoo and other IMAP accounts

Create an app password with your provider, choose **Yahoo** or **IMAP / SMTP**, and enter the address and password. Common hosts fill in their server settings from the address.

Connect each Apple Mail account you want Claude to reach; how many inboxes you can add depends on your [plan](/pricing). Claude finds them with \`inbox_list\`, so you never paste an account ID into a prompt.

## Step 3: Add MCPEmails to Claude

On claude.ai or in Claude Desktop:

1. Open **Customize → Connectors**.
2. Click **+ Add**, then **Add custom connector**.
3. Enter a name such as \`MCPEmails\` and paste the connector URL:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

4. Continue through the prompts and click **Add**. Then click **Connect**, sign in to MCPEmails, and choose how much Claude may do: **Read-only**, **Standard** (adds sending, drafts and contacts), **Full access** (adds folders, scheduling and deleting) or **Custom**.

There is no API key and no config file. On a Team or Enterprise plan, an owner adds the connector under **Organization settings → Connectors** first, and members then click **Connect** on it. The [Claude setup page](/docs/claude) covers each step and the common errors.

### Using it on iPhone

Anthropic's help center says a connector you add on claude.ai or Claude Desktop is available the next time you sign in to the Claude app for iOS or Android. Add it once on the web, then ask Claude about your mail from your phone. The iPhone's Mail app does not need to be open, and your Mac does not need to be on.

## What Claude sees, and what it does not

Claude works on the server copy of each account, which is the copy Apple Mail syncs. That means:

- **Folders you created for the account are visible.** A mailbox you made under your iCloud or Gmail account lives on the server, so Claude can list and search it, and move mail into it if you granted folder access.
- **Drafts land in Apple Mail.** When Claude saves a draft, it goes into that account's Drafts folder, so you can open it in Apple Mail, edit it and send it yourself.
- **Sent mail is filed.** A message Claude sends is saved to the account's Sent folder, like one sent from Apple Mail. If a mail server refuses that copy, Claude's result says so.
- **"On My Mac" mailboxes are not visible.** Apple stores those only on the Mac where you created them, so no server connection can see them. Move anything Claude should find into a mailbox under the account.
- **POP accounts may be partial.** An account Apple Mail uses over POP may have removed older mail from the server after downloading it to your Mac. MCPEmails connects over IMAP, so Claude can only reach what is still on the server.

Mail is fetched live from your provider for each request and is not stored by MCPEmails. The one exception is a message you schedule for later, which is held until it is sent.

## Prompts to try

Start with something read-only:

> Summarize my unread mail in iCloud and Gmail from today. One list, tagged with the account each message came from.

> Find the flight confirmation I got last month and tell me the booking reference.

> Draft a reply to the latest message from my landlord, but do not send it. I will finish it in Apple Mail.

For more routines, see [ways to let Claude manage your inbox](/blog/best-ways-to-let-claude-manage-your-inbox) and the [inbox triage playbook](/blog/ai-agent-triage-summarize-inbox). If you run several accounts, [managing multiple email accounts with AI](/blog/manage-multiple-email-accounts-with-ai) shows how to keep replies coming from the right address.

## Connecting ChatGPT to the same accounts

The connector URL is a standard MCP server, so ChatGPT can reach the same Apple Mail accounts. You add it on chatgpt.com as a custom MCP server; OpenAI's help center says that step is web only. Which plans and workspace roles can add one changes often, so the [ChatGPT setup page](/docs/chatgpt) keeps the current steps, and the [ChatGPT email guide](/blog/connect-chatgpt-to-email) covers the common errors.

## Keep yourself in control

- **Grant only what you need.** Choose **Read-only** on the consent screen if Claude should never send.
- **Review sends first.** Turn on **Review before sending** for an account in the dashboard, and every send from it waits for your approval. See [human approval for AI email sends](/blog/approve-ai-agent-email-sends).
- **Revoke at any time.** Remove the app-specific password at account.apple.com, or revoke Claude's connection under **API Keys** in the MCPEmails dashboard.

Treat every email as untrusted text: a message can contain instructions aimed at an AI. The [email access safety guide](/blog/is-it-safe-to-give-ai-agent-email-access) explains the risks, and [security](/security) covers how credentials are encrypted and where data is stored.

## FAQ

**How do I connect Claude to Apple Mail?**
Connect the accounts Apple Mail uses (iCloud, Gmail, Outlook.com, Yahoo or IMAP) to MCPEmails, then add \`https://mcpemails.com/api/mcp\` as a custom connector in Claude under Customize, Connectors. Claude then reads and sends from those accounts, and the results show up in Apple Mail.

**Do I need a Mac for this?**
No. Nothing runs on your Mac. Claude reaches your mail accounts through MCPEmails, so it works from claude.ai, Claude Desktop on Windows or Mac, and the Claude app on iPhone and Android.

**Does it work with Apple Mail on iPhone?**
Yes. Your iPhone's Mail app and Claude both work on the same accounts. Add the connector once on claude.ai and it is available in the Claude iPhone app the next time you sign in.

**Why is my Apple Account password rejected?**
iCloud only accepts an app-specific password from other apps. Generate one at account.apple.com under Sign-In and Security, and paste that instead.

**Can Claude see my On My Mac folders?**
No. Those mailboxes exist only on your Mac. Move the messages into a mailbox under your iCloud or other account and Claude can see them.

**Is my email stored?**
No. Each request fetches mail live from your provider and discards it. The exceptions are messages you schedule, which are held until they are sent, and the encrypted credential for each account, which MCPEmails keeps. The full step-by-step for every provider is in the [guide to connecting Claude to email](/blog/connect-claude-to-email).

## Next step

[Start free](/signup), connect your iCloud account, add the connector in Claude, and ask it what needs a reply today. Then open Apple Mail and you will see the same inbox Claude just read.`,
};

export default post;
