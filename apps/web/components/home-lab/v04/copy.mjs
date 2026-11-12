/**
 * English copy for Homepage Lab v04 ("The Correspondence Catalogue").
 * Staging only. Facts follow messages/en/home.json and the code; the wording
 * is rewritten in a mission voice. No em dashes, no tool count, no plan slugs.
 */

export const MCP_URL = 'https://mcpemails.com/api/mcp';

export const nav = [
  { href: '#setup', label: 'Setup' },
  { href: '#safety', label: 'Safety' },
  { href: '#teams', label: 'Teams' },
  { href: '#pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
  { href: '/blog', label: 'Blog' },
];

export const hero = {
  letter: [
    { k: 'From', v: 'MCPEmails, a hosted email MCP server' },
    { k: 'To', v: 'Claude, ChatGPT, Cursor, VS Code and any MCP client' },
    { k: 'Re', v: 'Does it work with my mailbox?' },
  ],
  providers: [
    { word: 'Gmail', href: '/connect/gmail' },
    { word: 'Outlook', href: '/connect/outlook' },
    { word: 'iCloud', href: '/connect/icloud' },
    { word: 'Fastmail', href: '/connect/fastmail' },
    { word: 'Yahoo', href: '/connect/yahoo' },
    { word: 'Zoho', href: '/connect/zoho' },
    { word: 'Any IMAP', href: '/connect/imap' },
  ],
  lead:
    "Your AI can write the email. It still can't send it. MCPEmails is the hosted email MCP server that fixes that: one connector that gives Claude, ChatGPT and any other MCP client your real mailbox, whether it lives at Gmail, Outlook, iCloud, Fastmail or any IMAP host. Mail is fetched live and never stored.",
  business:
    'Written first for companies that answer mail on their own domain: info@, sales@, invoices@, all on one agent. And for anyone who simply wants Claude or ChatGPT to reach their inbox.',
  businessLink: 'See how a company connects every address',
  ctaPrimary: 'Start free',
  ctaSecondary: 'Install in Claude or ChatGPT',
  footnote: 'One inbox free, forever. No card required.',
};

export const contents = {
  label: 'Contents',
  items: [
    { n: 'I', href: '#setup', title: 'Setup', sub: 'How it works, which clients, which mailboxes' },
    { n: 'II', href: '#safety', title: 'Safety', sub: 'What is stored, where, and how to pull the plug' },
    { n: 'III', href: '#teams', title: 'Teams', sub: 'Company addresses, roles and the control panel' },
    { n: 'IV', href: '#pricing', title: 'Billing', sub: 'Four plates, priced by inbox' },
  ],
};

export const whatIs = {
  kicker: 'Before the questions',
  title: 'What is an email MCP server?',
  mission: 'Your mail belongs in your mailbox, not in one more database.',
  p1:
    'An email MCP server is the bridge between an AI assistant and a real mailbox. It speaks the Model Context Protocol, so Claude, ChatGPT, Cursor or any other MCP client can read, search, draft and send email through one endpoint, with no separate integration for each app.',
  p2:
    'MCPEmails is a hosted one, and it is built on a single principle: the assistant should reach your mail where it already lives. It works with Gmail, Outlook and Microsoft 365, iCloud, Fastmail and any mailbox that speaks IMAP, and one agent can work several mailboxes at once. Each request is answered from your provider, live, and the mail is not kept afterwards.',
  p3:
    'Most visitors arrive with the same handful of questions. They are answered below in four chapters, in the order people tend to ask them: how to set it up, whether it is safe, how a team shares it, and what it costs.',
  links: [
    { href: '/connect/imap', label: 'Set up the IMAP MCP server' },
    { href: '/for/business', label: 'Email MCP for company mailboxes' },
    { href: '/docs/providers', label: 'All supported email providers' },
    { href: '/blog/connect-claude-to-email', label: 'How to connect Claude to your email' },
    { href: '/blog/connect-chatgpt-to-email', label: 'How to connect ChatGPT to your email' },
    { href: '/blog/claude-imap-connector', label: 'Claude IMAP connector guide' },
  ],
};

export const setup = {
  numeral: 'I',
  kicker: 'Chapter I',
  title: 'Setup: how it works',
  lead:
    'Three steps from sign-up to an assistant that reads and sends your mail. None of them asks you to move your mail anywhere.',
  stepsTitle: 'Three steps, in order',
  steps: [
    {
      h: 'Connect your inbox',
      memo: 'Dashboard, Connect inbox',
      p: 'Sign in and click Connect inbox. Choose Gmail, Outlook, iCloud, Fastmail or any IMAP inbox, then sign in with Microsoft or paste an app password. The credential is encrypted before it is saved; the mail itself is never saved.',
    },
    {
      h: 'Paste one URL into your client',
      memo: MCP_URL,
      p: 'Clients that support OAuth (claude.ai, Claude Desktop, ChatGPT, Cursor, VS Code and others) take the URL, open a sign-in, and are done. No API key. For clients without OAuth, such as Cline, JetBrains or your own scripts, create a scoped API key in the dashboard instead.',
    },
    {
      h: 'Your agent works the inbox',
      memo: 'email_read(), email_compose()',
      p: 'The assistant calls tools to list, read, search, draft, send, schedule and file mail. MCPEmails asks your provider for exactly what each call needs and hands the answer back. Nothing is cached between calls.',
    },
  ],
  clientsTitle: 'Paste the URL into your client',
  clientsLead: 'Pick your client. The steps are the ones each vendor documents today.',
  clients: [
    {
      slug: 'claude',
      name: 'Claude',
      steps:
        'In claude.ai or Claude Desktop, open Customize, Connectors, click + Add, then Add custom connector. Name it MCPEmails, paste the URL, click Continue, keep the detected sign-in settings, click Add and sign in with MCPEmails. There is no API key to create and no config file to edit.',
      file: null,
    },
    {
      slug: 'chatgpt',
      name: 'ChatGPT',
      steps:
        'On chatgpt.com, open Plugins, Personal, Add, then Add custom MCP server. Name it MCPEmails, paste the URL under Connection, choose OAuth, tick the confirmation box, click Create as a plugin and sign in with MCPEmails. In a chat, type @ and pick MCPEmails.',
      file: null,
    },
    {
      slug: 'cursor',
      name: 'Cursor',
      steps:
        'Add one entry under mcpServers in ~/.cursor/mcp.json with the URL below. Cursor then asks you to sign in through OAuth, and no API key is involved.',
      file: '~/.cursor/mcp.json',
    },
    {
      slug: 'vscode',
      name: 'VS Code',
      steps:
        'Run MCP: Add Server from the Command Palette, choose HTTP, paste the URL and pick Global. Approve the sign-in prompt to authorize with MCPEmails. No API key is involved.',
      file: null,
    },
  ],
  clientsMore: 'Setup for every other client',
  cardTitle: 'You read it before it leaves',
  cardP:
    'When the assistant drafts a reply, the draft appears in the chat as a card with To, Subject and the body, all editable. Nothing goes out until you press Send, and a short Undo window follows the click. Turn on approval for an inbox and every send waits in your dashboard as well.',
  cardAlt:
    'MCPEmails draft card in a chat: a reply to jordan@example.com saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons.',
  providersTitle: 'Which mailbox? Any of these.',
  providersLead:
    'Each provider connects the way it allows. Gmail and Google Workspace use a Google app password over IMAP. Outlook and Microsoft 365 use Microsoft sign-in; a work or school account may need its IT admin to approve the app once. iCloud, Fastmail, Yahoo, Zoho and Yandex use an app-specific password. Anything else connects over plain IMAP and SMTP.',
  providersAlt:
    'Supported email providers: Gmail, Outlook / Microsoft 365, iCloud Mail, Fastmail, Yahoo Mail, Zoho Mail, Yandex Mail, GMX, WEB.DE and any IMAP inbox, each with how it connects.',
  providerList: [
    { href: '/connect/gmail', name: 'Gmail', how: 'Google app password, IMAP' },
    { href: '/connect/outlook', name: 'Outlook and Microsoft 365', how: 'Microsoft sign-in' },
    { href: '/connect/icloud', name: 'iCloud Mail', how: 'App-specific password' },
    { href: '/connect/fastmail', name: 'Fastmail', how: 'App password' },
    { href: '/connect/yahoo', name: 'Yahoo Mail', how: 'App password' },
    { href: '/connect/zoho', name: 'Zoho Mail', how: 'App-specific password' },
    { href: '/connect/yandex', name: 'Yandex Mail', how: 'App password' },
    { href: '/connect/imap', name: 'Any IMAP inbox', how: 'Server details and a password' },
  ],
  providersAll: 'Every provider guide',
  lookup: 'Not sure of your IMAP or SMTP server? Look up the settings',
  examplesTitle: 'What people ask it to do',
  examples: [
    { prompt: 'Go through sales@ and info@ and list every enquiry from this week nobody has answered', note: 'Two inboxes, one question.' },
    { prompt: "Forward this month's invoices from invoices@ to our accountant", note: 'Sent from your own address, PDFs attached.' },
    { prompt: 'Move every receipt from this month into a Receipts folder', note: 'Filed in your mailbox, where your mail app sees it.' },
    { prompt: 'Send this at 8am Monday, not now', note: 'Scheduled; nothing goes out before then.' },
  ],
  faqTitle: 'Setup questions',
};

export const safety = {
  numeral: 'II',
  kicker: 'Chapter II',
  title: "Safety: where your mail goes, and where it doesn't",
  mission: 'Your mail belongs in your mailbox, not in one more database.',
  lead:
    'We hold as little as the job allows, and we say exactly what that is. Read the ledger below the way you would read a contract: every line is something the code does today.',
  ledgerTitle: 'The ledger',
  ledger: [
    {
      h: 'Fetched live. Never stored.',
      p: 'Every tool call goes to your provider in real time. Bodies, subjects and attachments pass to the assistant and are discarded. We keep one thing per inbox: an encrypted token or app password, so the next call can be made.',
    },
    {
      h: 'Two exceptions, both outgoing',
      p: 'A message you schedule for later, or a send held for your approval, has to wait somewhere. It is stored encrypted until it goes out, and its record is kept for your history.',
    },
    {
      h: 'Encrypted at rest',
      p: 'OAuth tokens and app passwords are encrypted with AES-256-GCM before they are written. They are decrypted only for the request that needs them, and the key is held as an environment secret, apart from the database.',
    },
    {
      h: 'Stored in Stockholm',
      p: 'What we do keep lives in one region: an EU database in Stockholm, Sweden. Product analytics are cookieless and never see email content, addresses, keys or MCP requests.',
    },
    {
      h: 'Sent by your provider, from your address',
      p: 'Your own provider sends every message. If a provider refuses connections from cloud addresses, the connection goes through our relay, a plain tunnel with TLS end to end, so the relay never sees your mail or your password.',
    },
    {
      h: 'Held until you approve',
      p: 'Turn on approval for an inbox and sends, replies, forwards, draft sends and scheduled sends wait for review. The assistant tells you to Approve in browser, and nothing leaves until someone does.',
    },
  ],
  revokeTitle: 'Pull the plug',
  revokeLine:
    'Click the bin beside an inbox and it is disconnected at once: its stored credentials are wiped, and every agent loses that mailbox on its next call.',
  revokeAlt:
    'The Inboxes page in the MCPEmails dashboard: two connected IMAP inboxes, each row ending in a refresh button and a bin button that disconnects it.',
  revokeNote:
    'Agent connections work the same way. Each OAuth connection and API key can be revoked from the dashboard in one click, and the client is refused from then on.',
  storedAlt:
    'MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored.',
  links: [
    { href: '/security', label: 'Security overview' },
    { href: '/privacy', label: 'Privacy policy' },
    { href: '/dpa', label: 'Data processing agreement' },
    { href: '/docs/read-only-access', label: 'Give an agent read-only access' },
    { href: '/self-hosting', label: 'Run it yourself' },
  ],
  faqTitle: 'Safety questions',
};

export const teams = {
  numeral: 'III',
  kicker: 'Chapter III',
  title: 'Teams: one agent, every company address',
  lead:
    'A company on its own domain does not have one inbox. It has several, each with a job, and the questions that matter cut across all of them.',
  addresses: [
    { k: 'To', v: 'info@yourcompany.com', note: 'Enquiries, sorted and answered.' },
    { k: 'To', v: 'sales@yourcompany.com', note: 'Leads followed up before they cool.' },
    { k: 'To', v: 'invoices@yourcompany.com', note: 'Bills filed, forwarded, reconciled.' },
  ],
  p1:
    "Connect each address once and the same assistant can work all of them. It lists the connected inboxes, picks the right one for each request and moves between a support address and a personal one in the same conversation. Every reply goes out from the address it belongs to, through your own provider, so your customers see your domain.",
  p2:
    'Bring the team in when you are ready. Members get roles, admins approve the sends that are held for review, and one subscription can hold a separate workspace for each company or client you run.',
  seatTitle: 'Business, billed per person',
  seatFallback:
    'Business includes 10 mailboxes, adds $3 a month for each extra, and has room for your whole team, with members and roles at no extra cost.',
  dashTitle: 'The control panel, annotated',
  dashLead: 'One screen tells you what your agents are connected to and what they have been doing.',
  dashAlt:
    'MCPEmails dashboard overview: inboxes connected, API keys, MCP calls today and this month, a calls-per-day chart and a live list of recent MCP tool calls.',
  pins: [
    { x: 56.6, y: 3.4, h: 'MCP endpoint', p: 'The one URL you paste into Claude, ChatGPT or any MCP client, with a copy button beside it.' },
    { x: 86.4, y: 15.6, h: 'Connect inbox', p: 'Add Gmail, Outlook, iCloud, Fastmail or any IMAP mailbox to the workspace.' },
    { x: 36.6, y: 22.6, h: 'Inboxes and keys', p: 'What your agents can reach, and the API keys that reach it.' },
    { x: 13.4, y: 31.8, h: 'Members', p: 'Invite the people who share the workspace and give each a role.' },
    { x: 13.4, y: 43.1, h: 'Approvals', p: 'Sends held for review wait here until someone approves or rejects them.' },
    { x: 33.4, y: 53.9, h: 'Calls per day', p: 'Every MCP tool call, counted per day across all tools.' },
    { x: 77.4, y: 53.9, h: 'Recent activity', p: 'Each tool call as it happens, with the inbox it touched.' },
  ],
  reviewTitle: 'In a customer’s own words',
  reviewVia: 'Reviewed on Google',
  reviewRating: 'Rated 5 out of 5',
  links: [
    { href: '/for/business', label: 'MCPEmails for business' },
    { href: '/for/founders', label: 'MCPEmails for founders' },
    { href: '/developers', label: 'For developers' },
    { href: '/docs/api', label: 'Developer guide' },
  ],
  faqTitle: 'Team questions',
};

export const billing = {
  numeral: 'IV',
  kicker: 'Chapter IV',
  title: 'Billing: the short version',
  lead:
    'You pay for the number of mailboxes your assistant can reach. Paid plans are not metered, and every plan includes every way of reading, sending and filing mail.',
  faqTitle: 'Billing questions',
};

export const pricing = {
  kicker: 'The catalogue',
  title: 'Priced by inbox. No metering on paid plans.',
  lead:
    'Four plates. Each lists what it includes and nothing it hides. Start on the first one; move up a plate when you need more mailboxes.',
  plateWord: 'Plate',
  specInboxes: 'Inboxes',
  specPrice: 'Price',
  specFor: 'For',
  perForever: '/forever',
  perMonth: '/month',
  inclVat: 'incl. VAT',
  order: 'Order',
  plates: {
    free: {
      inboxes: '1',
      for: 'Trying it on one mailbox',
      includes: [
        'Read, search, organise, draft, schedule and send',
        'Send review and approval hold',
        'Gmail, Outlook, iCloud, Fastmail and any IMAP',
        'Unlimited API keys and usage analytics',
        'Help center and email support',
      ],
    },
    personal: {
      inboxes: '3',
      for: 'One person, work and personal mail',
      includes: ['Everything on Plate I', '3 connected inboxes', '2x higher burst rate limit', 'Priority email support'],
    },
    solo: {
      inboxes: '10',
      for: 'One person running a business',
      includes: [
        'Everything on Plate II',
        '10 connected inboxes',
        'Follow-up reminders when nobody replies',
        'Snooze, and a daily morning brief in your inbox',
        'Search every connected inbox at once',
        'Instructions for your AI, per inbox',
      ],
    },
    business: {
      inboxes: '10+',
      inboxesSeat: 'Shared + private',
      for: 'A team on its own domain',
      desc: 'For a business with many mailboxes or several people: 10 mailboxes included, more at a fixed price each.',
      includes: [
        'Everything on Plate III',
        '10 mailboxes included, $3 a month for each extra',
        'Unlimited members with roles, at no extra cost',
        'Admins approve sends held for review',
        'Several workspaces on one subscription',
      ],
    },
  },
  sharedTitle: 'One order form for all four',
  sharedP: 'Every account starts on Plate I. Upgrade from the dashboard whenever a plate stops being enough.',
  sharedCta: 'Start free',
  sharedNote: 'One inbox free, forever. No card required.',
  footnote: 'All plans: the mail your agent reads is fetched live and never stored, and credentials are encrypted at rest.',
  compare: 'See the full feature comparison',
  contact: 'Need something custom? Write to hello@mcpemails.com',
  businessLink: 'Running a company’s mailboxes? See how one person connects them all',
};

export const closing = {
  kicker: 'Postscript',
  title: 'Start free. Keep your mail where it is.',
  p: 'Connect one inbox in a couple of minutes, paste one URL into Claude or ChatGPT, and ask for the first thing you would have done by hand. If it is not for you, disconnect the inbox and nothing of your mail stays behind.',
  signoff: 'Yours,',
  sign: 'MCPEmails',
  endpointLabel: 'MCP endpoint',
  ctaPrimary: 'Start free',
  ctaSecondary: 'Install in Claude or ChatGPT',
  ctaTertiary: 'Client setup guides',
};

export const footer = {
  tagline:
    'A hosted MCP server that gives AI agents read and send access to your inbox, without ever storing the email it reads.',
  contactLabel: 'Contact',
  contact: 'support@mcpemails.com',
  endpointLabel: 'MCP endpoint',
  columns: [
    {
      h: 'Product',
      links: [
        ['/#features', 'Features'],
        ['/#how', 'How it works'],
        ['/pricing', 'Pricing'],
        ['/docs', 'Docs'],
        ['/self-hosting', 'Self-hosting'],
        ['/for/founders', 'For founders'],
        ['/for/business', 'For business'],
        ['/developers', 'Developers'],
      ],
    },
    {
      h: 'Resources',
      links: [
        ['/docs#tools', 'Tool reference'],
        ['/docs#quickstart', 'Quickstart'],
        ['/docs#oauth', 'OAuth connection'],
        ['/docs/providers', 'Provider support'],
        ['/docs/read-only-access', 'Read-only access'],
        ['/docs/api', 'Developer guide'],
        ['/docs/clients', 'MCP client setup'],
        ['/tools/email-settings-lookup', 'IMAP and SMTP settings lookup'],
        ['/blog', 'Blog'],
        ['/changelog', 'Changelog'],
      ],
    },
    {
      h: 'Connect',
      links: [
        ['/connect', 'All providers'],
        ['/connect/imap', 'IMAP'],
        ['/connect/gmail', 'Gmail'],
        ['/connect/outlook', 'Outlook'],
        ['/connect/fastmail', 'Fastmail'],
        ['/connect/icloud', 'iCloud'],
        ['/connect/yahoo', 'Yahoo'],
        ['/connect/zoho', 'Zoho'],
        ['/connect/yandex', 'Yandex'],
        ['/native-connectors-vs-mcp', 'Native connectors vs MCP'],
        ['/best-email-mcp-servers', 'Best email MCP servers'],
      ],
    },
    {
      h: 'Company',
      links: [
        ['/about', 'About'],
        ['/security', 'Security'],
        ['/status', 'Status'],
        ['/help', 'Help & support'],
        ['/privacy', 'Privacy'],
        ['/terms', 'Terms'],
        ['/dpa', 'DPA'],
        ['/cancel?type=withdraw', 'Withdraw from contract here'],
        ['/cancel', 'Cancel contracts here'],
        ['/terms#agreement', 'Impressum'],
      ],
    },
  ],
  languages: [
    ['/', 'en', 'English'],
    ['/nb', 'nb', 'Norsk'],
    ['/es', 'es', 'Español'],
    ['/fr', 'fr', 'Français'],
    ['/zh', 'zh', '中文'],
    ['/de', 'de', 'Deutsch'],
    ['/pt', 'pt-BR', 'Português (Brasil)'],
    ['/ja', 'ja', '日本語'],
  ],
  languageLabel: 'Language',
  copyright: '© 2026 MCPEmails.',
  legal: 'Email fetched live, never stored. Credentials encrypted at rest.',
  legalEntity:
    'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
};

/**
 * Which chapter each FAQ question belongs to. Matched by question text; any
 * question not listed here (a future one) lands in Billing, so nothing in
 * `faqItems` is ever dropped from the page.
 */
export const FAQ_CHAPTER = {
  'Is MCPEmails an IMAP MCP server?': 'setup',
  'How do I add the email MCP connector to Claude or ChatGPT?': 'setup',
  'Which AI clients does it work with?': 'setup',
  'Which email providers can I connect?': 'setup',
  'How do I connect an inbox?': 'setup',
  'What can the AI actually do with my inbox?': 'setup',
  'Is my email stored anywhere?': 'safety',
  'Do you use analytics?': 'safety',
  'Can I self-host it?': 'safety',
  'Can one agent work several mailboxes at once?': 'teams',
  'Is it really free?': 'billing',
};
