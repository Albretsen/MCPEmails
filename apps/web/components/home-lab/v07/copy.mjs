/**
 * All English copy for Homepage Lab v07, "The Front Page". Staging only.
 * Voice: clipped fragments. Facts follow messages/en/home.json, the docs and
 * the code: mail is fetched live and never stored, credentials are encrypted
 * at rest, data is stored in Stockholm. No tool count, no plan slugs.
 */

export const REPO_URL = 'https://github.com/Albretsen/MCPEmails';
export const CODE_URL = 'https://github.com/Albretsen/MCPEmails/tree/main/supabase/functions/mcp-server';
export const NPM_URL = 'https://www.npmjs.com/package/mcpemails';
export const MCP_URL = 'https://mcpemails.com/api/mcp';

export const masthead = {
  editionPrefix: 'Edition of',
  place: 'Stockholm',
  placeNote: 'where your account data is kept',
  strap: 'The hosted email MCP server. For Claude, ChatGPT and every MCP client.',
  price: 'Free to start',
  nav: [
    { href: '#providers', label: 'Providers' },
    { href: '#how', label: 'How it works' },
    { href: '#dispatches', label: 'Dispatches' },
    { href: '#pricing', label: 'Pricing' },
    { href: '/docs', label: 'Docs' },
    { href: '/blog', label: 'Blog' },
  ],
  signIn: 'Sign in',
  start: 'Start free',
  navLabel: 'Sections',
};

export const lead = {
  kicker: 'Lead story',
  kickerTopic: 'The draft card',
  h1a: 'Email MCP server for info@, sales@ and invoices@.',
  h1b: 'In Claude. In ChatGPT.',
  dek:
    'MCPEmails is the hosted email MCP server and connector for the mailboxes your company runs on. Gmail, Outlook, iCloud, Fastmail, any IMAP inbox on your own domain. Connected once. Fetched live. Never stored. Ask. Review. Send.',
  ctaPrimary: 'Start free',
  ctaSecondary: 'Install in Claude or ChatGPT',
  ctaMeta: ['1 inbox free, forever', 'No card', 'Several mailboxes, one agent'],
  frames: [
    {
      n: '1',
      title: 'Connect',
      caption: 'Pick the provider. App password, or Microsoft sign-in for Outlook.',
    },
    {
      n: '2',
      title: 'Ask',
      caption: 'The assistant drafts the reply. It lands in the chat as a card.',
    },
    {
      n: '3',
      title: 'Approve',
      caption: 'A held send waits for a person. No agent can approve one.',
    },
  ],
  framesLabel: 'The whole product in three frames',
  body: [
    {
      h: 'You already use Claude or ChatGPT.',
      p: [
        'Good. Keep it. MCPEmails puts your mailboxes inside it. No new mail app. No copying threads between tabs. One email MCP server, one URL, every inbox you connect.',
        'Business teams first: one agent can work info@, sales@, invoices@ and support@ in the same conversation, and pick the right mailbox for each request. Solo? Your own Gmail or Outlook works the same way.',
      ],
    },
    {
      h: 'The install. One URL.',
      steps: [
        'Open your client’s connector settings and add a custom connector.',
        'Paste the server URL below.',
        'Approve the sign-in. OAuth clients need no API key.',
      ],
      after:
        'Same URL in Cursor, VS Code, Windsurf, n8n and Make. Clients without OAuth take a scoped API key from the dashboard.',
    },
    {
      h: 'What to ask first.',
      prompts: [
        'Go through sales@ and info@ and list every enquiry from this week nobody has answered.',
        'Forward this month’s invoices from invoices@ to our accountant.',
        'Move every receipt from this month into a Receipts folder.',
        'Send this at 8am Monday, not now.',
      ],
    },
    {
      h: 'The draft card.',
      p: [
        'Ask for a reply. It comes back as a card in the chat: To, Subject and body, all editable. Save keeps it in your Drafts folder. Send sends it from your own address, after a five-second Undo.',
        'Turn on approval for an inbox and every send waits instead. Approve in browser, on mcpemails.com. No agent, including the one that wrote it, can approve a send.',
      ],
    },
  ],
  crossfade: {
    label: 'Before and after',
    before: 'Before: the draft, in the chat.',
    after: 'After: Sent to jordan@example.com.',
    note: 'Loops every five seconds. Hover to hold.',
  },
};

export const rail = {
  h2: 'Also in this edition',
  providers: {
    kicker: 'Page 2',
    h: 'Providers, plates I to XII',
    p: 'Gmail. Google Workspace. Outlook and Microsoft 365. iCloud. Fastmail. Yahoo. Zoho. Yandex. GMX. WEB.DE. Your own domain. Any IMAP inbox.',
    link: 'See the plates',
  },
  plans: {
    kicker: 'Classifieds',
    h: 'Plans, by the inbox',
    link: 'Full prices',
    perPerson: '/person',
    perMonth: '/mo',
  },
  letter: {
    kicker: 'Letters',
    h: 'From a reader',
    rated: 'Rated {rating} of 5 on {source}',
    readOn: 'Read it on {source}',
  },
  stockholm: {
    kicker: 'Dateline: Stockholm',
    h: 'Kept in the EU',
    p: 'Account data in a database in Stockholm. Mail fetched live, never stored. Tokens and app passwords encrypted with AES-256-GCM.',
    link: 'Security',
  },
  wire: {
    kicker: 'Wire',
    h: 'Latest from the changelog',
    link: 'All dispatches',
  },
  open: {
    kicker: 'Open by default',
    h: 'Read the code',
    p: 'Open source under AGPL-3.0. The hosted service runs the same server. Check it yourself.',
    repo: 'GitHub',
    npm: 'npm',
    code: 'The MCP server',
  },
  business: {
    kicker: 'For business',
    h: 'A team, billed per person',
    p: 'Each colleague connects their own mailbox, private to them. info@ and sales@ become company-wide. Admins approve held sends.',
    link: 'For business',
    linkFounders: 'For founders',
  },
};

export const providers = {
  kicker: 'Page 2 · Field guide',
  h2: 'Providers. Plates I to XII.',
  intro:
    'Twelve common species of mailbox, and how each one connects. Gmail by Google app password over IMAP. Outlook by Microsoft sign-in. The rest by app password, or straight IMAP and SMTP. If it speaks IMAP, it connects.',
  connectsLabel: 'Connects with',
  notesLabel: 'Field notes',
  guide: 'Guide',
  allGuides: 'Every provider guide',
  lookup: 'Look up IMAP and SMTP settings',
  docs: 'Provider support, in the docs',
  plates: [
    { name: 'Gmail', logo: 'gmail', href: '/connect/gmail', connects: 'Google app password, over IMAP.', notes: 'Labels work as folders. Sends through Gmail, from your address.' },
    { name: 'Google Workspace', tile: 'GW', href: '/connect/google-workspace', connects: 'Google app password, over IMAP.', notes: 'Your own domain, hosted by Google. Send As addresses work once verified.' },
    { name: 'Outlook and Microsoft 365', logo: 'outlook', href: '/connect/outlook', connects: 'Microsoft sign-in (OAuth 2.0).', notes: 'Outlook.com and Microsoft 365. A work account may need its IT admin to approve once.' },
    { name: 'iCloud Mail', logo: 'icloud', href: '/connect/icloud', connects: 'App-specific password.', notes: 'Generated in your Apple account settings. Your Apple ID password stays with Apple.' },
    { name: 'Fastmail', logo: 'fastmail', href: '/connect/fastmail', connects: 'App password.', notes: 'App password only. Mail and folders over IMAP, sends over SMTP.' },
    { name: 'Yahoo Mail', logo: 'yahoo', href: '/connect/yahoo', connects: 'App password.', notes: 'yahoo.com, ymail.com and rocketmail.com addresses.' },
    { name: 'Zoho Mail', tile: 'Zo', href: '/connect/zoho', connects: 'Zoho password, or an app-specific password.', notes: 'Free accounts and custom domains alike.' },
    { name: 'Yandex Mail', logo: 'yandex', href: '/connect/yandex', connects: 'App password.', notes: 'IMAP at imap.yandex.com, port 993.' },
    { name: 'GMX', logo: 'gmx', href: '/connect/gmx', connects: 'GMX password, or an app password with 2FA.', notes: 'IMAP has to be switched on in GMX settings first.' },
    { name: 'WEB.DE', logo: 'webde', href: '/connect/web-de', connects: 'WEB.DE password, or an app password with 2FA.', notes: 'Same family as GMX. Same switch to turn on.' },
    { name: 'Your own domain', tile: '@', href: '/connect/cpanel', connects: 'Mailbox password, over IMAP and SMTP.', notes: 'cPanel, Plesk and most web hosts. Server settings filled in for many of them.' },
    { name: 'Any IMAP inbox', logo: 'imap', href: '/connect/imap', connects: 'Server, port and an app password.', notes: 'A regional ISP, a hosting company, your own server. Sends through your own SMTP.' },
  ],
};

export const how = {
  kicker: 'Page 3 · How it works',
  h2: 'How it works. Connect. Ask. Approve.',
  whatIs: {
    h: 'What is an email MCP server?',
    p: [
      'A bridge. On one side an AI assistant, on the other a real mailbox. It speaks the Model Context Protocol, so Claude, ChatGPT, Cursor or any MCP client can read, search, draft and send email through one endpoint. No separate integration per app.',
      'MCPEmails is a hosted one. Gmail, Outlook and Microsoft 365, iCloud, Fastmail, any mailbox that speaks IMAP. Several at once, one agent. Mail fetched live from your provider on each call. Never stored on our servers.',
    ],
    links: [
      { href: '/connect/imap', label: 'Set up the IMAP MCP server' },
      { href: '/for/business', label: 'Email MCP for company mailboxes' },
      { href: '/docs/providers', label: 'All supported email providers' },
      { href: '/blog/connect-claude-to-email', label: 'Connect Claude to your email' },
      { href: '/blog/connect-chatgpt-to-email', label: 'Connect ChatGPT to your email' },
      { href: '/blog/claude-imap-connector', label: 'Claude IMAP connector guide' },
    ],
  },
  steps: [
    {
      h: 'Connect your inbox.',
      p: 'Sign in. Connect Inbox. Gmail, Outlook, iCloud, Fastmail or any IMAP mailbox. Microsoft sign-in or an app password. Encrypted before it is written down.',
    },
    {
      h: 'Paste the URL.',
      p: 'OAuth clients (claude.ai, Claude Desktop, ChatGPT, Cursor): paste the endpoint, click Connect, authorize. No key. Everything else (Cline, JetBrains, your own scripts): a scoped API key from the dashboard.',
    },
    {
      h: 'Ask. Review. Send.',
      p: 'The agent calls the tools: read, search, organize, draft, schedule, send. MCPEmails fetches from your provider and returns the result. Nothing cached between calls. Sends go out through your own provider, from your own address.',
    },
  ],
  live: {
    h: 'Live, not copied.',
    p: 'A, the chat. B, your dashboard. Same thread, read from the same mailbox at the same moment. There is no second copy of your mail sitting on our side to drift out of date.',
    captionChat: 'In the chat: the draft card',
    captionInbox: 'In the dashboard: the same thread, held for approval',
    lineLabel: 'The hairline joins the subject in the chat to the same subject in the approval queue.',
  },
  stored: {
    h: 'Where it is kept: Stockholm.',
    p: [
      'Mail your agent reads goes to the agent and is discarded. Bodies, subjects, attachments: not stored.',
      'Kept: one encrypted token or app password per inbox, so the next call works. Plus outgoing mail that has to wait (a scheduled send, a send held for approval), stored encrypted, its record kept for your history.',
      'Encryption: AES-256-GCM, before anything is written. The key lives apart from the database, as an environment secret. Database: in the EU, in Stockholm.',
      'Revoke any agent from the dashboard. One click. Read-only access if you want an agent that can look but never send.',
    ],
    caption: 'What is kept, and where',
    links: [
      { href: '/security', label: 'Security' },
      { href: '/privacy', label: 'Privacy' },
      { href: '/dpa', label: 'DPA' },
      { href: '/docs/read-only-access', label: 'Read-only access' },
    ],
  },
};

export const dispatches = {
  kicker: 'Page 4 · Wire',
  h2: 'Latest dispatches from the changelog',
  intro: 'What shipped, as it shipped. Straight from the changelog, newest first.',
  all: 'Every dispatch',
  kinds: { added: 'Added', improved: 'Improved', fixed: 'Fixed', changed: 'Changed' },
};

export const pricing = {
  kicker: 'Page 5 · Classifieds',
  h2: 'Pricing. By the inbox, not by the call.',
  sub:
    'Free connects one inbox. Personal connects three. Pro connects up to 10, for one person running a business. Business is for a team.',
  subSeat:
    'Free connects one inbox. Personal connects three. Pro connects up to 10, for one person running a business. Business is for a team, billed per person who connects a mailbox: everyone\u2019s own mail stays private, shared addresses are company-wide.',
  perForever: '/forever',
  perMonth: '/month',
  inclVat: 'incl. VAT',
  mostPopular: 'Most popular',
  tiers: {
    free: {
      desc: 'One inbox. A real mailbox for your agent.',
      features: [
        '1 connected inbox',
        'Read, search, organise, draft, schedule, send',
        'Send review and approval hold',
        'Gmail, Outlook, iCloud, Fastmail, any IMAP',
        'Unlimited API keys',
      ],
      cta: 'Start free',
    },
    personal: {
      desc: 'Three mailboxes. Work, personal, a first company address.',
      features: ['Everything in Free', '3 connected inboxes', '2x higher burst rate limit', 'Priority email support'],
      cta: 'Get Personal',
    },
    solo: {
      desc: 'One person, up to 10 mailboxes, one agent. Finance, sales, support, your own.',
      features: [
        'Everything in Personal',
        '10 connected inboxes',
        'Follow-up reminders when nobody replies',
        'Snooze, and a daily morning brief',
        'Search every connected inbox at once',
        'Instructions for your AI, per inbox',
      ],
      cta: 'Get Pro',
    },
    business: {
      desc: 'Many mailboxes or several people. 10 mailboxes included, more at a fixed price each.',
      features: [
        'Everything in Pro',
        '10 mailboxes included, $3 a month for each extra',
        'Unlimited members with roles, at no extra cost',
        'Admins approve sends held for review',
        'Several workspaces on one subscription',
      ],
      cta: 'Get Business',
    },
  },
  footContact: 'Need something custom?',
  footContactLink: 'Contact us',
  footCompare: 'Full feature comparison',
  footBusiness: 'Running a company’s mailboxes?',
  footBusinessLink: 'How one person connects them all',
  footStored: 'Every plan: mail fetched live, never stored. Tokens encrypted at rest.',
};

export const faq = {
  kicker: 'Letters to the editor',
  h2: 'Readers’ questions, answered',
};

export const colophon = {
  kicker: 'Back page',
  h2: 'Colophon',
  open: {
    h: 'Open by default.',
    p: 'The server is open source under AGPL-3.0. The hosted service runs the same code you can read, fork or run yourself. Check how it handles your mail instead of taking our word for it.',
    repo: 'GitHub repository',
    npm: 'npm package',
    docs: 'Docs',
    code: 'Read the code',
    selfHost: 'Self-host it',
    developers: 'Developers',
    api: 'Developer guide',
  },
  type: {
    h: 'Set in IBM Plex.',
    p: 'Headlines in IBM Plex Sans Condensed, text in IBM Plex Sans, labels in IBM Plex Mono. Screenshots are the real product, printed as they are.',
  },
  publisher: {
    h: 'Publisher.',
    p: 'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
    about: 'About',
    status: 'Status',
    help: 'Help and support',
  },
};

export const footer = {
  tagline: 'A hosted email MCP server that gives AI agents read and send access to your inbox, without storing the mail it reads.',
  endpointLabel: 'MCP endpoint',
  contactLabel: 'Support',
  salesLabel: 'Sales',
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
  languagesLabel: 'Also printed in',
  languages: [
    { href: '/nb', label: 'Norsk', lang: 'nb' },
    { href: '/es', label: 'Español', lang: 'es' },
    { href: '/fr', label: 'Français', lang: 'fr' },
    { href: '/de', label: 'Deutsch', lang: 'de' },
    { href: '/pt', label: 'Português (Brasil)', lang: 'pt-BR' },
    { href: '/ja', label: '日本語', lang: 'ja' },
    { href: '/zh', label: '中文', lang: 'zh' },
  ],
  copyright: '© 2026 MCPEmails.',
  legal: 'Email fetched live, never stored. Credentials encrypted at rest.',
};
