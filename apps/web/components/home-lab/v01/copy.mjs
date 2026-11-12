/**
 * All English copy for Homepage Lab v01 ("Catalogue"). Staging only.
 *
 * Voice: plain manual. Short instructions, one fact per sentence.
 * Markup inside strings, rendered by `rich()` in Home.jsx:
 *   [[key]]   a footnote superscript; links to the source in FOOTNOTES
 *   `code`    inline code
 * Rules: see home-lab/banned.md. No tool count, no plan slugs, no action caps.
 */

export const MCP_URL = 'https://mcpemails.com/api/mcp';

/** Footnotes in order of first appearance on the page. */
export const FOOTNOTES = [
  { key: 'live', claim: 'Mail your agent reads is fetched live from your provider and not stored.', source: 'Security: what we access and what we store', href: '/security#access-vs-store' },
  { key: 'card', claim: 'Drafts open in an editable card in Claude and ChatGPT, and Send has a few seconds to undo.', source: 'Changelog', href: '/changelog' },
  { key: 'oauth', claim: 'Standard MCP with OAuth 2.1, dynamic client registration and PKCE. Any connection can be revoked from the dashboard.', source: 'Docs: OAuth connection', href: '/docs#oauth' },
  { key: 'clients', claim: 'The same endpoint works in Claude, ChatGPT, Cursor, VS Code and other MCP clients.', source: 'Docs: MCP client setup', href: '/docs/clients' },
  { key: 'providers', claim: 'How each email provider connects: app password, Microsoft sign-in or IMAP and SMTP.', source: 'Docs: provider support', href: '/docs/providers' },
  { key: 'tools', claim: 'What an agent can do in a mailbox, tool by tool.', source: 'Docs: tool reference', href: '/docs#tools' },
  { key: 'readonly', claim: 'A read-only connection reads and searches and nothing else, and reading never marks mail as read.', source: 'Docs: read-only access', href: '/docs/read-only-access' },
  { key: 'approval', claim: 'Per-inbox approval holds sends for a person to approve.', source: 'Changelog: approval before an agent sends anything', href: '/changelog' },
  { key: 'creds', claim: 'OAuth tokens and app passwords are encrypted with AES-256-GCM; the key is held apart from the database.', source: 'Security: credentials', href: '/security#credentials' },
  { key: 'location', claim: 'Stored data is in the EU, in Stockholm, Sweden. Mail is processed live and not written down.', source: 'Security: subprocessors and locations', href: '/security#subprocessors' },
  { key: 'selfhost', claim: 'The server is open source under AGPL-3.0 and runs with docker-compose.', source: 'Self-hosting guide', href: '/self-hosting' },
  { key: 'relay', claim: 'The relay for providers that refuse cloud addresses is a TLS tunnel. It cannot read mail or passwords.', source: 'Security: the relay', href: '/security#subprocessors' },
  { key: 'dpa', claim: 'A data processing agreement is published for customers who need one.', source: 'Data processing agreement', href: '/dpa' },
  { key: 'analytics', claim: 'Analytics are cookieless and never touch email content, addresses, keys or MCP requests.', source: 'Privacy policy', href: '/privacy' },
  { key: 'business', claim: 'How a company connects its shared and private mailboxes on Business.', source: 'For business', href: '/for/business' },
  { key: 'pricing', claim: 'Every plan, feature by feature, monthly and annual.', source: 'Pricing: full comparison', href: '/pricing' },
];

export const NAV = {
  label: 'Primary navigation',
  links: [
    { href: '/#features', label: 'Spec' },
    { href: '/#how', label: 'How it works' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/docs', label: 'Docs' },
    { href: '/blog', label: 'Blog' },
  ],
  signIn: { href: '/login', label: 'Sign in' },
  start: { href: '/signup', label: 'Start free' },
};

export const HERO = {
  label: 'MCPEmails / Hosted email MCP server',
  h1: 'An email MCP server for the inboxes your company runs on.',
  lead:
    'MCPEmails is a connector that lets Claude, ChatGPT and any MCP client work your Gmail, Outlook, iCloud, Fastmail or IMAP mailbox. Connect info@, sales@ and invoices@ once. Paste one URL. Ask. Mail is fetched live and never stored.[[live]]',
  solo: 'Working alone in Claude or ChatGPT? The same connector takes one personal inbox, free.',
  primary: { href: '/signup', label: 'Start free' },
  secondary: { href: '/connect', label: 'Install in Claude or ChatGPT' },
  tertiary: { href: '/docs/clients', label: 'Setup for every client' },
  meta: ['1 inbox free, forever', 'No card required'],
  indexLabel: 'Contents',
  index: [
    { id: 'connect', title: 'Connect', line: 'Gmail, Outlook or any IMAP inbox. One URL.' },
    { id: 'ask', title: 'Ask', line: 'Read, search, sort and draft in plain words.' },
    { id: 'approve', title: 'Approve', line: 'You decide what leaves, and when.' },
    { id: 'teams', title: 'Teams', line: 'Private mailboxes each, shared addresses for all.' },
    { id: 'plans', title: 'Plans', line: 'Free for one inbox. Business per person.' },
  ],
};

/** The before and after exhibit. Names and addresses are examples. */
export const SAMPLE = {
  label: 'Sample mailbox',
  note: 'info@ at a small company. Names and addresses are examples.',
  prompt: 'Asked in chat: “Draft replies to anything that needs one this morning, and file the rest.”',
  before: { title: 'Before', when: '08:02', summary: '7 unread' },
  after: { title: 'After', when: '08:04', summary: '3 drafts waiting' },
  rows: [
    { from: 'Jordan Lee', subject: "Moving Thursday's design review", time: '07:48', draft: 0 },
    { from: 'billing@supplier.example', subject: 'Invoice 2041 for October', time: '07:31', draft: 1 },
    { from: 'quotes@freight.example', subject: 'Quote request: 40 pallets to Bergen', time: '07:12', draft: 2 },
    { from: 'Website form', subject: 'New enquiry from the contact page', time: '06:58', after: 'Flagged for sales@' },
    { from: 'Logistics Weekly', subject: 'This week in freight', time: '06:55', after: 'Filed to Newsletters' },
    { from: 'Card terminal', subject: 'Receipt for order 5521', time: '06:40', after: 'Moved to Receipts' },
    { from: 'Calendar', subject: 'Reminder: VAT return due Friday', time: '05:30', after: 'Left as it was' },
  ],
  draftState: 'Draft waiting: review and send',
  heldState: 'Held: approve in browser',
  clip: {
    title: 'Then',
    caption:
      'The real draft card in a chat. Press Send, get a five-second undo, then the sent receipt.[[card]]',
    alt: 'Screen recording: an MCPEmails draft card in a chat, Send is clicked, a five-second Undo countdown runs and the card becomes a Sent to jordan@example.com receipt.',
  },
};

export const SPEC = {
  label: 'Spec sheet',
  h2: 'What is an email MCP server?',
  paragraphs: [
    'An email MCP server is the bridge between an AI assistant and a real mailbox. It speaks the Model Context Protocol, so Claude, ChatGPT, Cursor or any other MCP client can read, search, draft and send email through one endpoint. There is no separate integration for each app.',
    'MCPEmails is a hosted one. It works with Gmail, Outlook and Microsoft 365, iCloud, Fastmail and any mailbox that speaks IMAP. One agent can work several mailboxes at once, so a company can put info@, sales@ and invoices@ behind the same connector. Mail is fetched live from your provider on each call and is not kept on our servers.',
  ],
  links: [
    { href: '/connect/imap', label: 'Set up the IMAP MCP server' },
    { href: '/for/business', label: 'Email MCP for company mailboxes' },
    { href: '/docs/providers', label: 'All supported email providers' },
    { href: '/blog/connect-claude-to-email', label: 'How to connect Claude to your email' },
    { href: '/blog/connect-chatgpt-to-email', label: 'How to connect ChatGPT to your email' },
    { href: '/blog/claude-imap-connector', label: 'Claude IMAP connector guide' },
  ],
  h3: 'Specification',
  rows: [
    { k: 'Endpoint', v: '`https://mcpemails.com/api/mcp`. One URL for every client.' },
    { k: 'Protocol', v: 'Standard MCP over streamable HTTP. OAuth 2.1 with dynamic client registration and PKCE.[[oauth]]' },
    { k: 'Keys', v: 'Scoped API keys for clients without OAuth, and for scripts. Unlimited on every plan.' },
    { k: 'Clients', v: 'Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n, Make, LibreChat, OpenWebUI and any MCP client.[[clients]]' },
    { k: 'Providers', v: 'Gmail and Google Workspace with a Google app password over IMAP. Outlook and Microsoft 365 with Microsoft sign-in. iCloud, Fastmail, Yahoo, Zoho and Yandex with an app password. Everything else over IMAP and SMTP.[[providers]]' },
    { k: 'Actions', v: 'Read, search, draft, send, reply, forward, schedule, move, copy, flag, archive and delete. Folders, contacts, signatures and unattended automations.[[tools]]' },
    { k: 'Read-only', v: 'A connection can be read-only: it reads and searches, nothing else. Reading never marks mail as read.[[readonly]]' },
    { k: 'Sending', v: 'Through your own provider, from your own address. Per-inbox approval holds sends until a person approves.[[approval]]' },
    { k: 'Storage', v: 'Mail is fetched live and never stored. One encrypted credential per inbox. Scheduled and held sends are stored encrypted until they go.[[live]]' },
    { k: 'Encryption', v: 'AES-256-GCM at rest. The key is a server secret, kept apart from the database.[[creds]]' },
    { k: 'Data location', v: 'Stored data lives in the EU, in Stockholm, Sweden.[[location]]' },
    { k: 'Revoking', v: 'One click in the dashboard ends a connection. The next call fails.[[oauth]]' },
    { k: 'Source', v: 'Open source under AGPL-3.0. Run it yourself with docker-compose.[[selfhost]]' },
  ],
  keyLabel: 'Colour key',
  keyIntro: 'Colour on this page means one thing each, the same as in the product.',
  key: [
    { tone: 'action', name: 'Cobalt', meaning: 'An action, or something waiting on you.' },
    { tone: 'sent', name: 'Mint', meaning: 'Sent, or approved.' },
    { tone: 'held', name: 'Amber', meaning: 'Held for a person to approve.' },
    { tone: 'blocked', name: 'Red', meaning: 'Rejected or refused. Nothing was sent.' },
  ],
};

export const BELIEFS = {
  label: 'Principles',
  h2: 'Six things we hold to about email and agents.',
  sub: 'Numbered so you can hold us to them. Each one links to how it works. If one stops being true, that is a bug.',
  items: [
    { h: 'Mail is fetched live.', p: 'Every call goes to your provider in real time: Gmail, Microsoft Graph or IMAP. Bodies, subjects and attachments pass to your agent and are dropped. We keep one encrypted credential per inbox so the next call works.', link: { href: '/security', label: 'What we store, and what we do not' } },
    { h: 'A person approves the sends.', p: 'Turn on approval for an inbox and every send, reply, forward and scheduled send waits for review. No agent can approve a send. A signed-in person does it in the browser.', link: { href: '/docs#tools', label: 'How sending and approval work' } },
    { h: 'Your provider stays the source of truth.', p: 'Drafts land in your Drafts folder. Mail goes out through your own server and lands in Sent. Folders and labels stay yours. Disconnect MCPEmails and your mailbox is as you left it.', link: { href: '/docs/providers', label: 'How each provider connects' } },
    { h: 'One endpoint, any client.', p: 'Standard MCP, so Claude, ChatGPT, Cursor and the rest use the same URL. Change assistants without reconnecting a single inbox. No lock-in.', link: { href: '/docs/clients', label: 'Client setup guides' } },
    { h: 'Access ends in one click.', p: 'OAuth clients connect with a scoped grant. Revoke it, or delete an API key, in the dashboard. The next call is refused.', link: { href: '/docs#oauth', label: 'OAuth and API keys' } },
    { h: 'The code is open.', p: 'The server is AGPL-3.0. Read it, audit it, or run it on your own machine against any IMAP or SMTP mailbox.', link: { href: '/self-hosting', label: 'Self-hosting guide' } },
  ],
};

export const CONNECT = {
  label: 'Connect',
  h2: 'Connect an inbox. Paste one URL. Ask.',
  sub: 'Three steps from sign-up to an agent working your mail. Most mailboxes take a couple of minutes.',
  steps: [
    { h: 'Connect your inbox', p: 'Sign up and press Connect Inbox. Pick Gmail, Outlook, iCloud, Fastmail or any IMAP inbox. Sign in with Microsoft, or paste an app password. The credential is encrypted.[[creds]]' },
    { h: 'Paste the URL', p: 'In Claude, ChatGPT or Cursor, add a custom connector with `https://mcpemails.com/api/mcp` and approve the sign-in. OAuth clients need no key. For Cline, JetBrains or a script, make a scoped API key instead.[[oauth]]' },
    { h: 'Ask', p: 'Your agent calls tools such as `email_read` and `email_compose`. MCPEmails fetches from your provider and returns the result. Nothing is cached between calls.[[tools]]' },
  ],
  fig1: {
    n: 'Fig. 1',
    caption: 'Dashboard overview: connected inboxes, API keys, calls per day and a list of recent tool calls. Counts are test traffic.',
    alt: 'MCPEmails dashboard overview: inboxes connected, API keys, MCP calls today and this month, a calls-per-day chart and a list of recent MCP tool calls.',
  },
  diagram: {
    n: 'Diagram A',
    caption: 'One request, end to end. Your chat app asks over MCP, MCPEmails fetches live from your provider, and you review the draft before it sends from your address.',
  },
};

export const ASK = {
  label: 'Ask',
  h2: 'Ask in plain words. It reads, writes and files.',
  sub: 'No commands to learn. Tell your assistant what you want, and it uses MCPEmails to do it inside your mailbox.',
  youAsk: 'You ask',
  itDoes: 'It does',
  examples: [
    { prompt: 'Go through sales@ and info@ and list every enquiry from this week nobody has answered.', outcome: 'Lists the open enquiries across both inboxes, oldest first.' },
    { prompt: "Forward this month's invoices from invoices@ to our accountant.", outcome: 'Finds the invoices and forwards them with the PDFs attached.' },
    { prompt: 'Move every receipt from this month into a Receipts folder.', outcome: 'Creates the folder if needed and moves the receipts.' },
    { prompt: 'Send this at 8am Monday, not now.', outcome: 'Schedules it. Nothing goes out before then.' },
    { prompt: "Reply to Jordan that Friday works, and keep it short.", outcome: 'Writes the reply in the thread and shows it to you as a draft.' },
  ],
  fig2: {
    n: 'Fig. 2',
    caption: 'The draft card in a chat. Change the recipient, subject or text, then Save or Send. Send gives you a few seconds to undo.[[card]]',
    alt: 'MCPEmails draft card in a chat: a reply to jordan@example.com saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons.',
  },
  toolsH3: 'What the agent can reach',
  tools: [
    { name: 'inbox_list', p: 'Finds every connected inbox and its ID. Called first, so nobody copies IDs from a dashboard.' },
    { name: 'email_read', p: 'Lists recent mail, reads a full message, reads in batches, searches across providers and pulls readable text from attachments.' },
    { name: 'email_compose', p: 'Sends a new message, replies in the thread or forwards, through Gmail, Microsoft Graph or your SMTP server.' },
    { name: 'email_organize', p: 'Moves, copies, flags, archives or deletes, one at a time or in bulk. Long runs report progress and can be cancelled.' },
    { name: 'draft', p: 'Creates, updates and sends drafts stored at your provider, including a reply kept in its conversation for review.' },
    { name: 'schedule', p: 'Queues a message for later and cancels it before it goes.' },
    { name: 'folder', p: 'Creates, renames and deletes folders (labels on Gmail) and uses them as move targets.' },
    { name: 'contact_search', p: 'Finds people by name or address with a live scan of recent mail. Nothing is stored.' },
  ],
};

export const APPROVE = {
  label: 'Approve',
  h2: 'You decide what leaves, and when.',
  sub: 'A draft waits in its card for your Send. Turn on approval for an inbox and every send the agent makes waits for a person, in the browser.',
  states: [
    { tone: 'held', h: 'Held', p: 'Per-inbox approval holds sends, replies, forwards, draft sends and scheduled sends for review.[[approval]]' },
    { tone: 'action', h: 'Your move', p: 'No agent can approve a send. A signed-in person opens it, reads it the way a mail client shows it, and decides.' },
    { tone: 'sent', h: 'Approved, then sent', p: 'It goes out the moment you approve, through your own provider and from your own address, and lands in Sent.' },
    { tone: 'blocked', h: 'Rejected', p: 'Reject it and nothing is sent. The record stays in your history.' },
  ],
  relay: 'A few providers refuse connections from cloud addresses. Those connect through our relay, a plain TLS tunnel that never sees your mail or password.[[relay]]',
  fig2b: {
    n: 'Fig. 2b',
    caption: 'A held send in the chat: Approve in browser, or Reject. Plays on hover or focus.',
    alt: 'Screen recording: the MCPEmails approval card in a chat, the Approve in browser button is clicked and the card turns into a Sent to billing@supplier.example receipt.',
  },
  fig2c: {
    n: 'Fig. 2c',
    caption: 'The Approvals page in the dashboard: Review & approve, then Approve & send. Plays on hover or focus.',
    alt: 'Screen recording: on the MCPEmails Approvals page a person opens Review & approve, checks the Approve email send dialog, clicks Approve & send, and the queue updates with an Email approved toast.',
  },
};

export const SECURITY = {
  label: 'Security and storage',
  h2: 'Where your data lives, and what is never kept.',
  sub: 'MCPEmails is a pipe between your assistant and your provider. It keeps what it needs to make the next call, and nothing it reads.',
  diagram: {
    n: 'Diagram B',
    alt: 'MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored.',
  },
  rows: [
    { k: 'Not stored', v: 'The mail your agent reads. Bodies, subjects and attachments are fetched live and dropped after the call.[[live]]' },
    { k: 'Stored, encrypted', v: 'One credential per inbox: an OAuth token or an app password, encrypted with AES-256-GCM. It is decrypted only for the request that needs it.[[creds]]' },
    { k: 'Stored until sent', v: 'A message you schedule for later, or a send held for approval, is stored encrypted until it goes. Its record stays in your history.' },
    { k: 'Where', v: 'Stored data sits in an EU database in Stockholm, Sweden. Mail is processed live on servers in the US (East) and the EU, and is not written down.[[location]]' },
    { k: 'No model of ours', v: 'MCPEmails sends your mail to no AI provider of its own. Your agent does that, under your control and its provider\'s policy.' },
    { k: 'Analytics', v: 'Cookieless product analytics only. Never on email content, addresses, API keys, OAuth tokens or MCP requests.[[analytics]]' },
    { k: 'Paperwork', v: 'A published data processing agreement, and company invoices with your VAT ID on Business.[[dpa]]' },
  ],
  links: [
    { href: '/security', label: 'Security' },
    { href: '/privacy', label: 'Privacy' },
    { href: '/dpa', label: 'DPA' },
  ],
};

export const PROVIDERS = {
  label: 'Works with',
  h2: 'Works with your provider and your assistant.',
  sub: 'A compatibility list, not a customer list. Each name opens its setup guide.',
  fig3: {
    n: 'Fig. 3',
    caption: 'Connect screens in the dashboard.',
    shots: [
      { file: 'dashboard-connect-gmail', cap: 'Gmail: your address and a Google app password.', alt: 'MCPEmails Connect Gmail form asking for an email address and a Google app password, with a Get an app password button.' },
      { file: 'dashboard-connect-pick-outlook', cap: 'Outlook and Microsoft 365: Connect with Microsoft. A work account may need its IT admin to approve the app once.', alt: 'MCPEmails Connect an inbox dialog with Outlook selected and the Connect with Microsoft button, explaining the Microsoft consent screen.' },
      { file: 'dashboard-connect-imap', cap: 'Any IMAP inbox: address, IMAP and SMTP host and port, and a password.', alt: 'MCPEmails Connect IMAP / SMTP form with email address, IMAP and SMTP host and port, and password fields.' },
    ],
  },
  providersH3: 'Email providers',
  providers: [
    { slug: 'gmail', name: 'Gmail', how: 'Google app password over IMAP', logo: 'gmail' },
    { slug: 'outlook', name: 'Outlook / Microsoft 365', how: 'Microsoft sign-in', logo: 'outlook' },
    { slug: 'icloud', name: 'iCloud Mail', how: 'App-specific password', logo: 'icloud' },
    { slug: 'fastmail', name: 'Fastmail', how: 'App password', logo: 'fastmail' },
    { slug: 'yahoo', name: 'Yahoo Mail', how: 'App password', logo: 'yahoo' },
    { slug: 'zoho', name: 'Zoho Mail', how: 'App password', logo: null },
    { slug: 'yandex', name: 'Yandex Mail', how: 'App password', logo: 'yandex' },
    { slug: 'gmx', name: 'GMX', how: 'IMAP and SMTP', logo: 'gmx' },
    { slug: 'web-de', name: 'WEB.DE', how: 'IMAP and SMTP', logo: 'webde' },
    { slug: 'imap', name: 'Any IMAP inbox', how: 'Host, port and password', logo: 'imap' },
  ],
  providersMore: [
    { href: '/connect', label: 'Every provider guide' },
    { href: '/tools/email-settings-lookup', label: 'Look up IMAP and SMTP settings' },
  ],
  clientsH3: 'AI clients',
  clients: [
    { slug: 'claude', name: 'Claude', how: 'Custom connector, OAuth' },
    { slug: 'chatgpt', name: 'ChatGPT', how: 'Custom MCP server, OAuth' },
    { slug: 'cowork', name: 'Claude Cowork', how: 'Custom connector, OAuth' },
    { slug: 'claude-code', name: 'Claude Code', how: 'One terminal command' },
    { slug: 'codex', name: 'OpenAI Codex', how: 'One terminal command' },
    { slug: 'cursor', name: 'Cursor', how: 'mcp.json, OAuth' },
    { slug: 'vscode', name: 'VS Code', how: 'MCP server config, OAuth' },
    { slug: 'windsurf', name: 'Windsurf', how: 'MCP config' },
    { slug: 'gemini', name: 'Gemini', how: 'Custom app' },
    { slug: 'n8n', name: 'n8n', how: 'MCP client node' },
  ],
  clientsMore: [
    { href: '/docs/clients', label: 'Every client guide' },
    { href: '/native-connectors-vs-mcp', label: 'Built-in connectors or MCP?' },
    { href: '/best-email-mcp-servers', label: 'Best email MCP servers compared' },
  ],
};

export const REVIEWS = {
  label: 'Reviews',
  h2: "In a customer's own words.",
  sub: 'Quoted in full, as written, under the name he publishes. The link opens the original review.',
  rated: 'Rated {rating} out of 5',
  via: 'Read it on Google',
};

export const TEAMS = {
  label: 'Teams',
  h2: 'One login for every address, or one each for the team.',
  sub: 'Most companies run on a few shared addresses: info@, sales@, invoices@, support@. Choose the plan by counting people, not mailboxes.',
  soloH3: 'One person, many addresses',
  soloPlan: 'solo',
  soloP: 'One login and up to 10 connected mailboxes on one agent. Each mailbox keeps its own sender name and signature and sends through its own mail server. It keeps working after you close the chat: follow-up reminders, snooze, a daily morning brief, one search across every inbox, and instructions for your AI per inbox.',
  teamH3: 'A team, billed per person',
  teamPlan: 'pro',
  teamPSeat:
    'Each person connects their own mailboxes, and they stay private to them. info@, sales@ and support@ are connected once and shared company-wide. The AI each person uses sees only what that person may see, and admins set the rules for what goes out.[[business]]',
  teamPFlat:
    'For a business with many mailboxes or several people: mailboxes are included, more at a fixed price each, and members join with roles. Admins approve sends held for review.[[business]]',
  founders: { href: '/for/founders', label: 'Running the company alone? For founders' },
  business: { href: '/for/business', label: 'How a team connects its mailboxes' },
};

export const PLANS = {
  label: 'Plans',
  h2: 'Plans, priced by inbox.',
  subSeat: 'Free connects one inbox, forever, with no card. Personal connects three. Pro connects up to 10 for one person running a business. Business is for a team, billed per person who connects a mailbox.',
  subFlat: 'Free connects one inbox, forever, with no card. Personal connects three. Pro connects up to 10 for one person running a business. Business includes 10 mailboxes and room for the whole team.',
  caption: 'Plans compared. Monthly prices.',
  perForever: 'forever',
  perMonth: 'a month',
  inclVat: 'incl. VAT',
  yes: 'Yes',
  no: 'No',
  ctas: { free: 'Start free', personal: 'Get Personal', solo: 'Get Pro', pro: 'Get Business' },
  notes: [
    'All plans: the mail your agent reads is fetched live and never stored. Credentials are encrypted at rest.',
    'Paying annually saves about 20% on every paid plan. Need something custom? Write to hello@mcpemails.com.',
  ],
  compare: { href: '/pricing', label: 'Full comparison, monthly and annual' },
};

export const FAQ = {
  label: 'FAQ',
  h2: 'Questions, answered',
  sub: 'What people ask before they connect a first inbox.',
};

export const FOOTNOTES_SECTION = {
  label: 'Footnotes',
  h2: 'Footnotes',
  sub: 'Every superscript number on this page links to the page that proves it. Here they are in order.',
};

export const CLOSING = {
  h2: 'Start with one inbox, free.',
  p: 'Connect an inbox. Paste one URL. Ask.',
};

export const FOOTER = {
  tagline: 'A hosted email MCP server that gives AI agents read and send access to your inbox, without storing the email it reads.',
  mcpLabel: 'MCP endpoint',
  contactLabel: 'Contact',
  columns: [
    {
      h: 'Product',
      links: [
        { href: '/#features', label: 'Features' },
        { href: '/#how', label: 'How it works' },
        { href: '/pricing', label: 'Pricing' },
        { href: '/docs', label: 'Docs' },
        { href: '/self-hosting', label: 'Self-hosting' },
        { href: '/for/founders', label: 'For founders' },
        { href: '/for/business', label: 'For business' },
        { href: '/developers', label: 'Developers' },
      ],
    },
    {
      h: 'Resources',
      links: [
        { href: '/docs#tools', label: 'Tool reference' },
        { href: '/docs#quickstart', label: 'Quickstart' },
        { href: '/docs#oauth', label: 'OAuth connection' },
        { href: '/docs/providers', label: 'Provider support' },
        { href: '/docs/read-only-access', label: 'Read-only access' },
        { href: '/docs/api', label: 'Developer guide' },
        { href: '/docs/clients', label: 'MCP client setup' },
        { href: '/tools/email-settings-lookup', label: 'IMAP and SMTP settings lookup' },
        { href: '/blog', label: 'Blog' },
        { href: '/changelog', label: 'Changelog' },
      ],
    },
    {
      h: 'Connect',
      links: [
        { href: '/connect', label: 'All providers' },
        { href: '/connect/imap', label: 'IMAP' },
        { href: '/connect/gmail', label: 'Gmail' },
        { href: '/connect/outlook', label: 'Outlook' },
        { href: '/connect/fastmail', label: 'Fastmail' },
        { href: '/connect/icloud', label: 'iCloud' },
        { href: '/connect/yahoo', label: 'Yahoo' },
        { href: '/connect/zoho', label: 'Zoho' },
        { href: '/connect/yandex', label: 'Yandex' },
        { href: '/native-connectors-vs-mcp', label: 'Native connectors vs MCP' },
        { href: '/best-email-mcp-servers', label: 'Best email MCP servers' },
      ],
    },
    {
      h: 'Company',
      links: [
        { href: '/about', label: 'About' },
        { href: '/security', label: 'Security' },
        { href: '/status', label: 'Status' },
        { href: '/help', label: 'Help & support' },
        { href: '/privacy', label: 'Privacy' },
        { href: '/terms', label: 'Terms' },
        { href: '/dpa', label: 'DPA' },
        { href: '/cancel?type=withdraw', label: 'Withdraw from contract here' },
        { href: '/cancel', label: 'Cancel contracts here' },
        { href: '/terms#agreement', label: 'Impressum' },
      ],
    },
  ],
  languagesLabel: 'Language',
  languages: [
    { href: '/', label: 'English', lang: 'en' },
    { href: '/nb', label: 'Norsk', lang: 'nb' },
    { href: '/es', label: 'Español', lang: 'es' },
    { href: '/fr', label: 'Français', lang: 'fr' },
    { href: '/de', label: 'Deutsch', lang: 'de' },
    { href: '/pt', label: 'Português (Brasil)', lang: 'pt-BR' },
    { href: '/ja', label: '日本語', lang: 'ja' },
    { href: '/zh', label: '中文', lang: 'zh' },
  ],
  legal: 'Email fetched live, never stored. Credentials encrypted at rest.',
  entity: 'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
  copyright: '© 2026 MCPEmails.',
};
