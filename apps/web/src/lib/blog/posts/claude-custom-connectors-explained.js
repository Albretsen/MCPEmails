const post = {
  slug: 'claude-custom-connectors-explained',
  title: 'Claude Custom Connectors Explained: Plans, Setup, OAuth and Safety',
  description:
    'What Claude custom connectors are, which plans and apps support them, how to add a remote MCP server by URL, sign-in options, admin controls, and safety tips.',
  cover: '/blog/cover-claude-custom-connectors-explained.svg',
  coverAlt: 'Claude custom connectors explained: a remote MCP server added to Claude by URL',
  authorId: 'asgeir',
  publishedAt: '2026-10-21T09:00:00.000Z',
  updatedAt: '2026-10-21T09:00:00.000Z',
  tags: ['Claude', 'Connectors', 'MCP', 'OAuth'],
  featured: false,
  content: `**Claude custom connectors** let you add any remote [Model Context Protocol](https://modelcontextprotocol.io) server to Claude by pasting its URL. Once you add one, Claude can call that server's tools in your chats: read a database, file a ticket, or, in the worked example at the end of this guide, read and send your email.

Plan and menu details below come from Anthropic's own help pages, checked on 20 October 2026. Claude's interface changes often, so if a label differs, Anthropic's [custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) is the reference.

## What is a Claude custom connector?

A Claude custom connector is a remote MCP server that you add to Claude by its URL instead of picking it from the Connectors Directory. The server runs on the internet, exposes a set of tools, and usually asks you to sign in with OAuth. Claude then calls those tools on your behalf, within the permissions you approved.

Three things are worth knowing up front:

- **Anthropic does not verify custom connectors.** Directory listings carry Verified or Community labels. A connector you add by URL connects Claude to a service Anthropic has not reviewed, so you are trusting whoever runs the server.
- **The connection comes from Anthropic's cloud, not from your computer.** Anthropic says this holds in every Claude client, including claude.ai, Claude Desktop, Cowork, and the mobile apps. The server must be reachable over the public internet. A server on a private network or behind a VPN will not connect unless its firewall allows Anthropic's IP ranges, or it is reached through what Anthropic calls an MCP tunnel.
- **You add it once per account, not once per device.**

If MCP itself is new to you, [what an MCP email server is](/blog/what-is-an-mcp-email-server) covers the protocol with email as the example.

## How custom connectors differ from directory connectors and desktop extensions

Claude has three ways to reach an outside tool:

- **Directory connectors** are listed in Claude's Connectors Directory. You browse them under **Customize → Connectors** and click **Connect**. Claude's Gmail and Microsoft 365 connectors are in this group.
- **Custom connectors** are remote MCP servers you add by URL. They are the subject of this guide.
- **Desktop extensions** are local MCP servers packaged as \`.mcpb\` files and installed under **Settings → Extensions** in the Claude desktop app. They run on your own computer. Local servers configured in \`claude_desktop_config.json\` are a separate mechanism again and are not available in claude.ai or Cowork.

Claude Code adds the same kind of remote server from the terminal; the [Claude Code setup page](/docs/claude-code) shows the command for MCPEmails. For how a general MCP server and a built-in single-provider connector behave differently, see [native connectors and MCP compared](/native-connectors-vs-mcp).

## Which Claude plans and apps support custom connectors

According to Anthropic's help center, as of October 2026:

- **Plans:** custom connectors are available on Free, Pro, Max, Team, and Enterprise. The Free plan is limited to one custom connector.
- **Apps where you add them:** claude.ai on the web, Claude Desktop, and Cowork.
- **Mobile:** a connector you connect on the web or in Claude Desktop becomes available in Claude for iOS and Android the next time you sign in there. Anthropic describes installing connectors on mobile as a beta and calls the web and desktop apps the primary path for custom connectors, so set it up on a computer first.
- **Who can add one on a business plan:** on Team plans, only Owners and Primary Owners. On Enterprise plans, Owners, Primary Owners, and people with a custom role that includes managing the organization's libraries.

## How to add a custom connector on Free, Pro, or Max

1. Open **Customize → Connectors** in claude.ai or Claude Desktop.
2. Click **Add custom connector**. In some layouts it sits behind a **+ Add** button.
3. Enter a name and the server's URL, then click **Continue**.
4. Review the authentication settings Claude detected and click **Continue**. The next section explains the choices.
5. Click **Add**, then **Connect** to sign in to the service.

You cannot change a connector's authentication settings after adding it. To change them, remove the connector and add it again. To remove one, open **Customize → Connectors** and use **Remove** or the three-dot menu next to it.

## How organizations add custom connectors on Team and Enterprise

On Team and Enterprise plans, adding a connector and connecting to it are two separate steps:

1. **An Owner adds it for the organization.** Open **Organization settings → Connectors**, click **Add**, choose **Custom**, then **Web** if Claude asks for a type. Enter the name and URL and finish the same authentication screens.
2. **Each member connects with their own account.** Members open **Customize → Connectors**, find the connector, which usually carries a **Custom** label, and click **Connect**.

Because each person signs in individually, Claude reaches only what that person can reach in the connected service. The exception is a connector set up with a shared credential such as an API key: everyone who uses it gets that credential's access.

Owners can also limit what a connector may do across the whole organization. Each tool can be set to **Always allow**, **Needs approval**, or **Blocked**, and individual users cannot override the organization's setting. Anthropic's own example is close to the email case below: let Claude search and summarize email, but stop it from sending messages.

Members who cannot add a connector themselves need an Owner to add it. The **Request** button Claude offers applies to directory listings, so for a custom URL, send your Owner the URL directly.

## Sign-in options: OAuth, automatic registration, or no sign-in

Claude shows up to three groups of settings when you add a connector. The detected values are usually right.

**Authentication** decides when people sign in:

- **Sign in now:** each user goes through the server's OAuth sign-in before using the connector. This is the right choice for a server that holds personal data.
- **Sign in when needed:** Claude connects without credentials and asks users to sign in when the server requires it.
- **No sign-in:** anyone with the URL can use the connector. This also covers servers that expect a fixed API key, which you then add as a request header.

**OAuth client** decides how Claude identifies itself to the server's sign-in system. It is hidden when you choose No sign-in:

- **Use Claude's published identity** is Anthropic's recommendation. The server reads Claude's details from a Client ID Metadata Document that Anthropic hosts, so nothing needs to be set up, as long as the server supports that method.
- **Register automatically** uses OAuth Dynamic Client Registration, which most MCP servers support.
- **Use your own OAuth client** is for a client ID you registered with the server yourself.

**Request headers** hold fixed credentials such as an API key or bearer token. Claude stores them securely, does not show them again after you save, and sends them on every request, up to four headers per connector. Anthropic marks request headers as a beta available to a limited set of organizations, so the section may not appear for you.

The practical difference: with OAuth, every person signs in as themselves, approves specific permissions, and can revoke access without anyone sharing a secret. With a fixed key, one credential carries the same access for everyone who uses the connector. [OAuth vs. API keys for AI email access](/blog/oauth-vs-api-keys-ai-email-access) goes deeper on that trade-off.

## Turning a connector on in a chat

Adding a connector does not make every chat use it. In a conversation, click the **+** button at the lower left, open **Connectors**, and toggle each connector on or off for that chat. Claude can also suggest a connected app on its own when it fits the request.

To control individual tools, open **Customize → Connectors**, select the connector, and set each tool, or each group of read-only and write tools, to **Always allow**, **Needs approval**, or **Blocked**. When Claude asks to run a tool, choose **Allow always** only for servers and tools you trust to run unsupervised.

## Safety checklist before you connect

Anthropic's guidance comes down to five points:

- **Connect only to servers run by organizations you trust.** The server decides what its tools do, and it can change them later.
- **Read the permissions on the sign-in screen.** Grant the narrowest set that does the job and deny anything that looks unnecessary.
- **Treat tool output as untrusted.** A web page, a ticket, or an email can contain text written to steer Claude. Anthropic says Claude has built-in protections against prompt injection, but you should still watch what goes in and out.
- **Block or gate write actions you do not need.** Sending, deleting, and moving are where mistakes become visible to other people.
- **Be careful with Research.** Anthropic notes that Research can call connector tools automatically without asking each time, so turn off write tools before you use it with a connector.

## Worked example: email in Claude through MCPEmails

Email tests all of the above: a mailbox holds private data, and sending is a real action. MCPEmails is a hosted MCP server that connects Gmail, Outlook and Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex, and other IMAP mailboxes, and presents them to Claude as one custom connector.

**1. Connect a mailbox to MCPEmails.** [Create an account](/signup), then open **Dashboard → Inboxes → Connect inbox**. Outlook and Microsoft 365 use Sign in with Microsoft, most other providers use an app-specific password, and the [provider pages](/connect) list the settings for each. The [Claude setup page](/docs/claude) has the short version of steps 1 and 2.

**2. Add the connector in Claude.** Under **Customize → Connectors**, choose **Add custom connector**, name it MCPEmails, and enter:

\`\`\`
https://mcpemails.com/api/mcp
\`\`\`

**3. Pick the sign-in settings.** Choose **Sign in now**. For the OAuth client, either of the first two options works: MCPEmails supports Claude's published identity and automatic registration. Leave request headers empty, since OAuth needs no API key.

**4. Sign in and choose the access.** Click **Connect**, sign in to MCPEmails, and approve permissions on the consent screen. Claude first asks only for \`read:email\`, and the screen opens on the matching read-only option. Add \`send:email\`, \`manage:drafts\`, \`manage:folders\`, or \`delete:email\` only when a workflow needs them. A token without \`send:email\` cannot send, whatever Claude is asked to do. If a later request needs a permission you did not grant, MCPEmails answers with an \`insufficient_scope\` error that names the missing scope. When you reconnect, tick that permission on the consent screen. The [read-only access page](/docs/read-only-access) shows exactly what a read-only grant can and cannot do.

**5. Set tool permissions in Claude.** MCPEmails splits reading and writing into separate tools. \`email_read\`, \`inbox_list\`, \`folder_list\`, and \`draft_list\` only read, while \`email_compose\` sends, replies, and forwards, and \`email_delete\` deletes. That split lets you put \`email_compose\` on **Needs approval** and \`email_delete\` on **Blocked** while reading stays on **Always allow**. The [tool reference](/docs#tools) lists every tool.

**6. Try a read-only first task.** Turn the connector on in a new chat and ask Claude to list your inboxes and summarize your five newest unread emails without sending, moving, or deleting anything. More starter prompts are in the [guide to connecting Claude to email](/blog/connect-claude-to-email).

For a team, the Owner adds the same URL once in **Organization settings → Connectors**, and each member clicks **Connect** and signs in with their own MCPEmails account. Each person sees only the inboxes their own account can reach. To make outgoing mail wait for a person regardless of what Claude decides, an inbox owner can turn on send approval in the MCPEmails dashboard: every send, reply, forward, draft send, and scheduled send is then held until someone approves it, and an undecided request expires after 24 hours. [Approving AI agent email sends](/blog/approve-ai-agent-email-sends) walks through that setup.

On the data side, MCPEmails fetches mail live from your provider for each request and does not store message content. It keeps only the encrypted OAuth token or app password it needs to reach the mailbox. Results that contain mailbox text are marked as untrusted content, so Claude is told that an email asking it to forward or delete something is data to report, not an instruction. The [security overview](/security) and [is it safe to give an AI agent email access?](/blog/is-it-safe-to-give-ai-agent-email-access) cover the threat model.

## Troubleshooting custom connectors

- **There is no Add custom connector button.** On Team and Enterprise plans, members cannot add custom connectors. Ask an Owner to add the URL under **Organization settings → Connectors**.
- **You cannot add a second connector on Free.** The Free plan allows one custom connector. Remove the one you no longer use, or move to a paid Claude plan.
- **The connection times out or fails.** Claude connects from Anthropic's cloud, so the server must be reachable from the public internet. The hosted MCPEmails URL is. A server you run yourself, such as the [self-hosted stack](/self-hosting), needs a public HTTPS address or a firewall that allows Anthropic's IP ranges. The self-hosted stack signs in with an API key rather than OAuth, so Claude can only use it where the Request headers section is available.
- **You chose the wrong sign-in settings.** Authentication settings cannot be edited. Remove the connector and add it again, and members then reconnect.
- **The connector is connected but Claude does not use it.** Open **+ → Connectors** in that chat and check that its toggle is on, and that the tool you need is not set to **Blocked**.
- **It does not show up on your phone.** Connect it on the web or in Claude Desktop first, then sign in again in the mobile app.
- **An email action is denied.** The token is missing a scope. Reconnect the connector and approve the scope that action needs, or revoke the old grant in the MCPEmails dashboard under **API keys**, where Claude's connection is listed as \`OAuth:\` followed by the client name. The [Claude setup page](/docs/claude) lists the remaining Claude-specific fixes.

## FAQ

**What are Claude custom connectors?**  
They are remote MCP servers you add to Claude by URL. Claude calls the server's tools in your chats after you sign in and approve permissions. They are available on Free, Pro, Max, Team, and Enterprise plans, and the Free plan allows one.

**Do custom connectors work in Claude Desktop and on mobile?**  
Yes. You add them in claude.ai, Claude Desktop, or Cowork, and a connector you connect there is available in the iOS and Android apps the next time you sign in.

**Who can add a custom connector on a Team or Enterprise plan?**  
On Team, Owners and Primary Owners. On Enterprise, also people with a custom role that includes managing the organization's libraries. Members then connect individually.

**Is a custom connector safe?**  
It is as safe as the server behind it and the permissions you grant. Anthropic does not verify custom connectors, so connect only to servers you trust, approve the narrowest permissions, and gate or block write actions.

**Do I need an API key to use MCPEmails as a Claude custom connector?**  
No. Claude signs in to MCPEmails with OAuth. API keys are for MCP clients without an OAuth flow, such as scripts.

## Next step

[Create a free MCPEmails account](/signup), connect a mailbox, and add \`https://mcpemails.com/api/mcp\` as a custom connector in Claude. If your mailbox uses IMAP and has no named preset, the [Claude IMAP connector guide](/blog/claude-imap-connector) covers the server settings.`,
};

export default post;
