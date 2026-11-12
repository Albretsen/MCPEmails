/**
 * English copy for Homepage Lab v09, "Re: your questions" (staging only).
 *
 * Facts follow messages/en/home.json, messages/en/security.json, the
 * business-seat copy and the draft card. Voice: business-plain, for owners
 * delegating shared inboxes. Addresses are only the form info@, sales@,
 * invoices@ at example.com, or the product's own support and sales mailboxes
 * in the footer.
 */

export const MCP_URL = 'https://mcpemails.com/api/mcp';

/** The company every header block writes to or from. */
export const YOU = {
  info: 'Your company <info@example.com>',
  sales: 'Your company <sales@example.com>',
  invoices: 'Your company <invoices@example.com>',
  team: 'info@, sales@, invoices@ at your company',
};
export const US = 'MCPEmails';

export const labels = { from: 'From', to: 'To', subject: 'Subject', date: 'Date', folder: 'Folder', no: 'No.' };

export const nav = {
  aria: 'Primary navigation',
  links: [
    { href: '#index', label: 'Index' },
    { href: '#how', label: 'How it works' },
    { href: '#providers', label: 'Providers' },
    { href: '#security', label: 'Security' },
    { href: '#pricing', label: 'Pricing' },
    { href: '#faq', label: 'Questions' },
    { href: '/docs', label: 'Docs' },
    { href: '/blog', label: 'Blog' },
  ],
  signIn: 'Sign in',
  start: 'Start free',
};

export const hero = {
  date: 'Today, whenever you are ready',
  kicker: 'Email MCP server for Claude and ChatGPT',
  display: 'Give the AI the invoices@ inbox. Keep the approve button for yourself.',
  lead:
    'MCPEmails is a hosted email MCP server: one connector that lets Claude, ChatGPT, Cursor or any MCP client read, search, draft and send from the mailboxes your company already runs. Connect Gmail, Outlook and Microsoft 365, iCloud, Fastmail or any IMAP inbox once. The mail it reads is fetched live from your provider and never stored.',
  second:
    'This page is written as a stack of messages. The short ones explain the product; the rest answer the questions people ask before they connect a work inbox. Read it in order or jump from the index.',
  ctaPrimary: 'Start free',
  ctaSecondary: 'Install in Claude or ChatGPT',
  ctaTertiary: 'Pick your provider',
  facts: ['1 inbox free, forever', 'No card required', 'Revoke any connection in one click'],
  askLabel: 'Example request, typed in Claude or ChatGPT',
  ask: 'Answer the supplier about invoice 2041 from invoices@, and hold the reply until I approve it.',
  fig1: {
    alt: 'MCPEmails approval card in a chat: a reply to billing@supplier.example about invoice 2041 waiting for approval, with Reject and Approve in browser buttons and the note that no agent can approve a send.',
    caption:
      'Fig. 1. The card MCPEmails shows in the chat for a held send. The reply to billing@supplier.example waits until a person presses Approve in browser.',
  },
  fig2: {
    alt: 'MCPEmails draft card in a chat: a reply saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons.',
    caption:
      'Fig. 2. The draft card, shown here on another thread. Anything the assistant saves to Drafts opens in the chat, editable, with Send and a short Undo.',
  },
};

export const index = {
  subject: 'Index: what this page answers',
  date: 'About eight minutes of reading',
  intro:
    'Seven numbered messages from us, and four folders of questions from people like you. Every question is open below, with its answer, so nothing hides behind a click.',
  colFrom: 'From',
  colSubject: 'Subject',
  colWhen: 'When it matters',
  unread: 'Unread',
};

export const what = {
  no: '01',
  to: YOU.info,
  date: 'Before you connect anything',
  title: 'What is an email MCP server?',
  p1: 'An email MCP server is the bridge between an AI assistant and a real mailbox. It speaks the Model Context Protocol, so Claude, ChatGPT, Cursor or any other MCP client can read, search, draft and send email through one endpoint, with no separate integration for each app.',
  p2: 'MCPEmails is a hosted one. It works with Gmail, Outlook and Microsoft 365, iCloud, Fastmail and any mailbox that speaks IMAP, and one agent can work several mailboxes at once: info@ for enquiries, sales@ for leads, invoices@ for the supplier who wants to know when they get paid. Mail is fetched live from your provider on each call and never stored on our servers.',
  p3: 'You are the user. We are the pipe. The agent asks, MCPEmails fetches from your provider, the answer goes back to the chat, and nothing is cached between calls.',
  links: [
    { href: '/connect/imap', label: 'Set up the IMAP MCP server' },
    { href: '/for/business', label: 'Email MCP for company mailboxes' },
    { href: '/docs/providers', label: 'All supported email providers' },
    { href: '/blog/connect-claude-to-email', label: 'How to connect Claude to your email' },
    { href: '/blog/connect-chatgpt-to-email', label: 'How to connect ChatGPT to your email' },
    { href: '/blog/claude-imap-connector', label: 'Claude IMAP connector guide' },
  ],
  howTitle: 'How it works, in three envelopes',
  howIntro: 'Three steps from sign-up to an agent that reads and sends from your own address. Most people finish them in a couple of minutes.',
  steps: [
    {
      h: 'Connect your inbox',
      p: 'Create a free account and connect a mailbox: a Google app password for Gmail, Microsoft sign-in for Outlook and Microsoft 365, an app password for iCloud, Fastmail, Yahoo, Zoho and Yandex, or server details for any IMAP host. The password or token is encrypted before it is saved.',
    },
    {
      h: 'Add one URL to your AI client',
      p: 'Paste the MCP endpoint into Claude, ChatGPT, Cursor or another MCP client and approve the sign-in. Clients with OAuth need no API key. For clients without OAuth, such as Cline, JetBrains or your own scripts, create a scoped API key instead.',
      code: MCP_URL,
    },
    {
      h: 'Ask in plain words',
      p: 'The agent lists your inboxes, picks the right one and calls tools to read, search, file, draft, schedule or send. MCPEmails fetches live from your provider and returns the result. Sends go out through your own provider, from your own address.',
    },
  ],
  stepLabel: 'Step',
};

/** FAQ folders: which questions sit where. Matched on the question text. */
export const groups = [
  {
    id: 'faq',
    slug: 'setup',
    name: 'Setup',
    from: YOU.info,
    subject: 'Setup questions',
    date: 'Minute one',
    intro:
      'What people ask while they are still deciding whether it fits their stack. Short version: if your mailbox speaks IMAP, or it is Gmail or Outlook, it works, and if your AI client speaks MCP, it connects.',
    match: ['IMAP MCP server', 'add the email MCP connector', 'Which AI clients', 'Which email providers', 'How do I connect an inbox'],
  },
  {
    id: 'safety',
    slug: 'safety',
    name: 'Safety',
    from: YOU.invoices,
    subject: 'Safety questions',
    date: 'Before you hand over a work inbox',
    intro:
      'The questions that come from whoever owns the invoices@ password. What is kept, what is counted, and what the agent is allowed to do on its own.',
    match: ['Is my email stored', 'Do you use analytics', 'What can the AI actually do'],
  },
  {
    id: 'teams',
    slug: 'teams',
    name: 'Teams',
    from: YOU.sales,
    subject: 'Team questions',
    date: 'When more than one person needs in',
    intro:
      'Most companies that connect MCPEmails run more than one address. One agent can work all of them, and on Business each person brings their own mailboxes, kept private, next to the addresses the whole company shares. Business is billed per person who connects a mailbox; colleagues who only approve or watch are free.',
    match: ['several mailboxes'],
  },
  {
    id: 'billing',
    slug: 'billing',
    name: 'Billing',
    from: YOU.invoices,
    subject: 'Billing questions',
    date: 'When the first invoice arrives',
    intro:
      'What it costs, what is free for good, and what happens if you would rather run it yourself. Every plan is on this page with its price; there is no sales call between you and a number.',
    match: ['really free', 'self-host'],
  },
];

export const faq = {
  re: 'Re:',
  answeredBy: 'Answered by MCPEmails',
};

export const providers = {
  no: '02',
  to: YOU.info,
  date: 'Minute two',
  title: 'Gmail, Outlook, iCloud, Fastmail and any IMAP inbox',
  intro:
    'Connect the mailboxes you already have. Nothing moves, nothing gets a new address, and your provider keeps doing the storing, filtering and sending it does today.',
  wallAlt:
    'Supported email providers: Gmail, Outlook / Microsoft 365, iCloud Mail, Fastmail, Yahoo Mail, Zoho Mail, Yandex Mail, GMX, WEB.DE and any IMAP inbox, each with how it connects.',
  tableCaption: 'How each provider connects',
  cols: ['Provider', 'How it connects', 'Guide'],
  rows: [
    { name: 'Gmail and Google Workspace', how: 'A Google app password over IMAP', href: '/connect/gmail', link: 'Gmail setup' },
    { name: 'Outlook and Microsoft 365', how: 'Sign in with Microsoft (OAuth 2.0). A work or school account may need its IT admin to approve the app once.', href: '/connect/outlook', link: 'Outlook setup' },
    { name: 'iCloud Mail', how: 'An app-specific password from your Apple account', href: '/connect/icloud', link: 'iCloud setup' },
    { name: 'Fastmail', how: 'An app password over IMAP and SMTP', href: '/connect/fastmail', link: 'Fastmail setup' },
    { name: 'Yahoo Mail', how: 'An app password', href: '/connect/yahoo', link: 'Yahoo setup' },
    { name: 'Zoho Mail', how: 'An app-specific password', href: '/connect/zoho', link: 'Zoho setup' },
    { name: 'Yandex Mail', how: 'An app password', href: '/connect/yandex', link: 'Yandex setup' },
    { name: 'Your own domain, GMX, WEB.DE, any host', how: 'The generic IMAP and SMTP connector: server details and a password, once', href: '/connect/imap', link: 'IMAP setup' },
  ],
  after:
    'Every inbox reports a compatibility profile, so the agent knows where a provider behaves differently. If a provider refuses connections from cloud addresses, the connection goes through our relay, a plain tunnel with TLS end to end, so the relay never sees your mail or password.',
  links: [
    { href: '/connect', label: 'All providers' },
    { href: '/docs/providers', label: 'Provider support' },
    { href: '/tools/email-settings-lookup', label: 'Look up IMAP and SMTP settings' },
  ],
};

export const clients = {
  no: '03',
  to: YOU.sales,
  date: 'Minute three',
  title: 'Claude, ChatGPT and every other MCP client',
  intro:
    'MCPEmails is a standard streamable-http MCP server with OAuth 2.1, DCR and PKCE. The same connector and the same inboxes work in every client you use, so switching assistants next year does not mean setting up mail again.',
  endpointLabel: 'The one URL every client gets',
  cols: ['Client', 'Where the URL goes', 'Sign-in'],
  rows: [
    { name: 'Claude (claude.ai and Claude Desktop)', where: 'Settings, Connectors, Add custom connector', auth: 'OAuth, no key' },
    { name: 'ChatGPT', where: 'Custom MCP servers need a paid plan, in a browser on chatgpt.com: OpenAI lists Business and Enterprise/Edu, with read-only access on Pro. An admin or owner may need to add it.', auth: 'OAuth, no key' },
    { name: 'Cursor, VS Code, Windsurf', where: 'The MCP settings of the editor', auth: 'OAuth, no key' },
    { name: 'n8n, Make', where: 'An MCP client step in the workflow', auth: 'OAuth or API key' },
    { name: 'LibreChat, OpenWebUI', where: 'The MCP server list', auth: 'OAuth or API key' },
    { name: 'Cline, JetBrains, your own scripts', where: 'The client config, with a header', auth: 'Scoped API key' },
  ],
  after:
    'At sign-in you choose what the connection may do. Read-only lets it list, search and read and nothing else; full access adds sending, filing and deleting. You can change it later or revoke the connection from the dashboard in one click.',
  links: [
    { href: '/docs/clients', label: 'MCP client setup' },
    { href: '/docs#quickstart', label: 'Quickstart' },
    { href: '/docs#oauth', label: 'OAuth connection' },
    { href: '/docs/read-only-access', label: 'Read-only access' },
    { href: '/native-connectors-vs-mcp', label: 'Native connectors vs MCP' },
    { href: '/best-email-mcp-servers', label: 'Best email MCP servers' },
  ],
};

export const security = {
  no: '04',
  to: YOU.invoices,
  date: 'Before you hand over a password',
  title: 'Fetched live, never stored, and kept in Stockholm',
  intro:
    'Built for the long haul. A tool that sits in your company mail should be easy to leave and hard to misuse, so MCPEmails keeps as little as it can and gives you the exit in one click.',
  diagramAlt:
    'MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored.',
  ledgerCaption: 'What MCPEmails keeps, and what it never keeps',
  cols: ['Item', 'Kept?', 'How'],
  rows: [
    { item: 'Message bodies, subjects, attachments', kept: 'No', how: 'Fetched live on each request, passed to your chat, then discarded' },
    { item: 'OAuth tokens and app passwords', kept: 'Yes', how: 'AES-256-GCM encrypted at rest; the key is an environment secret, separate from the database' },
    { item: 'Scheduled sends and sends held for approval', kept: 'Yes, until sent', how: 'Stored encrypted; the record stays in your history' },
    { item: 'Account and workspace data', kept: 'Yes', how: 'An EU database in Stockholm, Sweden' },
    { item: 'Email content in analytics', kept: 'No', how: 'Cookieless product analytics only, never content, addresses, keys or tokens' },
  ],
  points: [
    {
      h: 'Your mail never leaves your provider’s storage',
      p: 'There is no copy of your mailbox on our side to leak, export or hold hostage. Mail is processed live in the US (East) for the request that needs it and kept nowhere; everything we do store sits in the EU, in Stockholm.',
    },
    {
      h: 'Revoke in one click',
      p: 'Every agent connection and every API key is listed in the dashboard. Cut one off and the agent loses access at once. Disconnect an inbox from the same page whenever you like.',
    },
    {
      h: 'No lock-in',
      p: 'Standard MCP, so any client works, and the server is open source under AGPL-3.0, so you can run the same code yourself. Cancel online whenever you like; your mailboxes were never moved, so there is nothing to move back.',
    },
  ],
  links: [
    { href: '/security', label: 'Security' },
    { href: '/privacy', label: 'Privacy' },
    { href: '/dpa', label: 'Data processing agreement' },
    { href: '/self-hosting', label: 'Self-hosting' },
  ],
};

export const approval = {
  no: '05',
  to: YOU.invoices,
  date: 'Before every send that matters',
  title: 'The agent drafts. A person approves.',
  intro:
    'Turn on approval for an inbox and every send, reply, forward, draft send and scheduled send from it is held. The chat shows a card with the message and an Approve in browser button that opens mcpemails.com. No agent, including the one that wrote the message, can approve it.',
  clipLabel:
    'Screen recording: the MCPEmails approval card in a chat, the Approve in browser button is clicked and the card turns into a Sent to billing@supplier.example receipt.',
  clipCaption: 'Fig. 3. A held reply to a supplier, approved in the browser, then sent from your own address.',
  receiptAlt: 'MCPEmails receipt card: Sent to billing@supplier.example, approved in the browser, sent over SMTP and copied to Sent.',
  receiptCaption: 'Fig. 4. The receipt the card turns into. The copy lands in your Sent folder like any other mail.',
  points: [
    {
      h: 'Held sends wait for a person',
      p: 'A held send expires after 24 hours if nobody acts on it. Reject it and it is never sent; approve it and your provider sends it, from your address, with a copy in Sent.',
    },
    {
      h: 'Drafts stay drafts until you press Send',
      p: 'When the assistant saves a draft, the draft card opens in the chat with To, Subject and body you can edit. Send gives you a few seconds to undo before it goes.',
    },
    {
      h: 'On Business, admins approve',
      p: 'Sends held for review go to the admins of the workspace, and recipient rules can hold any mail addressed outside the domains you allow.',
    },
  ],
};

export const review = {
  subject: 'Review on Google',
  date: '13 Sep 2026',
  heading: 'Reviews: what a customer wrote, as he wrote it',
  ratingLabel: 'Rated 5 out of 5',
  via: 'Read it on Google',
  note: 'Quoted verbatim, spelling included.',
};

export const pricing = {
  no: '06',
  to: YOU.invoices,
  date: 'Before the first invoice',
  title: 'Every plan and every price, Business per person included',
  intro:
    'Priced by inbox, and per person for teams. No metering on paid plans, no contact-us gate. Free connects one inbox for good. Personal connects three. Pro connects up to 10 for one person running a business. Business is for a team: everyone’s own mail stays private, and the shared addresses are company-wide.',
  cols: { plan: 'Plan', who: 'Who it is for', price: 'Price' },
  perForever: '/forever',
  perMonth: '/month',
  popular: 'Most popular',
  inclVat: 'incl. VAT',
  freeNote: 'No card required.',
  detail: 'In the ledger',
  tiers: {
    free: {
      desc: 'Connect one inbox and give your agent a real mailbox.',
      features: [
        '1 connected inbox',
        'Read, search, organise, draft, schedule and send',
        'Send review and approval hold',
        'Usage analytics',
        'Gmail, Outlook, iCloud, Fastmail and any IMAP',
        'Unlimited API keys',
        'Help center and email support',
      ],
      cta: 'Start free',
    },
    personal: {
      desc: 'Three mailboxes for one person or one small business: work, personal, or your first company addresses.',
      features: ['Everything in Free', '3 connected inboxes', '2x higher burst rate limit', 'Priority email support'],
      cta: 'Get Personal',
    },
    solo: {
      desc: 'For one person running a business: up to 10 mailboxes on one agent, from finance and sales to support and your own.',
      features: [
        'Everything in Personal',
        '10 connected inboxes',
        '5x higher burst rate limit',
        'Longer analytics history',
        'Follow-up reminders when nobody replies to mail you sent',
        'Snooze: mail leaves the inbox and comes back when you choose',
        'A daily morning brief, placed straight in your inbox',
        'Search every connected inbox at once',
        'Instructions for your AI, per inbox',
      ],
      cta: 'Get Pro',
    },
    business: {
      desc: 'For a business with many mailboxes or several people: 10 mailboxes included, more at a fixed price each.',
      features: [
        'Everything in Pro',
        '10 mailboxes included, $3 a month for each extra',
        'Unlimited members with roles, at no extra cost',
        'Admins approve sends held for review',
        'Several workspaces on one subscription, one per company or client',
      ],
      cta: 'Get Business',
    },
  },
  seatTitle: 'Business, per person',
  seatBody:
    'You pay for each person who connects a mailbox. Each of them gets private mailboxes of their own, and the company’s shared addresses (info@, sales@, invoices@) are reachable by the whole team. Viewers and approvers who connect nothing cost nothing.',
  footnoteBefore: 'All plans: the mail your agent reads is fetched live and never stored, and tokens are encrypted at rest.',
  compare: 'See the full feature comparison',
  contact: 'Ask us about anything custom',
  business: 'See how one person connects a company’s mailboxes',
};

export const questions = {
  no: '07',
  to: YOU.team,
  date: 'Whenever something is still unclear',
  title: 'Questions: every one on this page, and where to ask the rest',
  intro:
    'Jump straight to an answer. Each one lights up briefly when you land on it. If yours is not here, write to us and we will answer it.',
  contactTitle: 'Still a question?',
  contact: [
    { label: 'Support', href: 'mailto:support@mcpemails.com', value: 'support@mcpemails.com' },
    { label: 'Sales and teams', href: 'mailto:hello@mcpemails.com', value: 'hello@mcpemails.com' },
  ],
  more: [
    { href: '/help', label: 'Help center' },
    { href: '/status', label: 'Status' },
    { href: '/changelog', label: 'Changelog' },
    { href: '/developers', label: 'Developers' },
    { href: '/docs/api', label: 'Developer guide' },
  ],
  closing: 'Connect one inbox free, add the URL to your AI client, and ask it to find what is waiting in invoices@.',
};

export const footer = {
  tagline:
    'A hosted email MCP server that gives AI agents read and send access to your inbox, without ever storing the email it reads.',
  columns: [
    {
      h: 'Product',
      links: [
        { href: '/', label: 'Home' },
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
      h: 'Company',
      links: [
        { href: '/about', label: 'About' },
        { href: '/security', label: 'Security' },
        { href: '/status', label: 'Status' },
        { href: '/help', label: 'Help and support' },
        { href: '/privacy', label: 'Privacy' },
        { href: '/terms', label: 'Terms' },
        { href: '/dpa', label: 'DPA' },
        { href: '/cancel?type=withdraw', label: 'Withdraw from contract here' },
        { href: '/cancel', label: 'Cancel contracts here' },
        { href: '/terms#agreement', label: 'Impressum' },
      ],
    },
  ],
  account: [
    { href: '/login', label: 'Sign in' },
    { href: '/signup', label: 'Create a free account' },
  ],
  endpointLabel: 'MCP endpoint',
  languagesLabel: 'Language',
  languages: [
    { code: 'en', href: '/', label: 'English' },
    { code: 'nb', href: '/nb', label: 'Norsk' },
    { code: 'es', href: '/es', label: 'Español' },
    { code: 'fr', href: '/fr', label: 'Français' },
    { code: 'zh', href: '/zh', label: '中文' },
    { code: 'de', href: '/de', label: 'Deutsch' },
    { code: 'pt-BR', href: '/pt', label: 'Português (Brasil)' },
    { code: 'ja', href: '/ja', label: '日本語' },
  ],
  copyright: '© 2026 MCPEmails.',
  legal: 'Email fetched live, never stored. Credentials encrypted at rest.',
  entity: 'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
};

/** A stable anchor id for a FAQ question. */
export function questionId(q) {
  return `q-${q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)}`;
}
