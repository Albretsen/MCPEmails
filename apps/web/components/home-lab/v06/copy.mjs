/**
 * English copy for Homepage Lab v06, "By hand, or connected". Voice: FAQ
 * plainness. A question the reader would ask, then the short answer first.
 * Staging experiment only; never imported by production.
 */

export const MCP_URL = 'https://mcpemails.com/api/mcp';

export const nav = {
  label: 'Primary',
  links: [
    { href: '#security', text: 'Security' },
    { href: '#features', text: 'By hand vs connected' },
    { href: '#how', text: 'How it works' },
    { href: '#pricing', text: 'Pricing' },
    { href: '/docs', text: 'Docs' },
  ],
  signIn: 'Sign in',
  start: 'Start free',
};

export const hero = {
  h1: 'MCPEmails is the email MCP server for Claude and ChatGPT.',
  lead:
    'Connect Gmail, Outlook, iCloud, Fastmail or any IMAP mailbox once, add one connector in Claude or ChatGPT, and your AI reads, searches, drafts and sends from your own address. The mail it reads is fetched live and never stored.',
  team:
    'Made first for companies on their own domain: info@, sales@ and invoices@ on one agent, each sending from its own address. One person with one inbox works the same way.',
  addresses: ['info@', 'sales@', 'invoices@'],
  ctaPrimary: 'Start free',
  ctaSecondary: 'Install in Claude or ChatGPT',
  facts: ['One inbox free, forever', 'No card required', 'Data stored in Stockholm'],
  envelopeAlt:
    'A stack of white envelopes with the top one open, its cobalt lining showing, the way a draft waits in MCPEmails before you send it.',
};

export const security = {
  id: 'security',
  h2: 'Does it store my email? No. It fetches it when asked.',
  intro:
    'Most buyers ask about privacy before anything else, so it comes first. Four questions, four straight answers, and a link to the full security page if you want the detail.',
  items: [
    {
      q: 'Is my mail kept on your servers?',
      a: 'No. Every tool call goes to your provider in real time, through the Gmail API, Microsoft Graph or IMAP. Message bodies, subjects and attachments go to your AI and are dropped as soon as the call ends. Two things are kept, both encrypted: a message you schedule for later, and a send held for your approval.',
      tag: 'Never stored',
    },
    {
      q: 'Where is my data?',
      a: 'In the EU, in Stockholm. Your account, the encrypted credentials for each inbox and the record of held or scheduled sends live in one database there. There is no copy of your mailbox anywhere, because we never make one.',
      tag: 'Stockholm',
    },
    {
      q: 'How are my passwords and tokens kept?',
      a: 'Encrypted at rest with AES-256-GCM before they reach the database, and decrypted only for the request that needs them. The encryption key is an environment secret, kept apart from the database.',
      tag: 'Encrypted',
    },
    {
      q: 'Can I take the access back?',
      a: 'Yes, in one click. Each AI client connects with its own OAuth sign-in or a scoped API key, and you can revoke any one of them from the dashboard while the others keep working.',
      tag: 'Revoke',
    },
  ],
  diagramAlt:
    'MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored.',
  caption: 'What is kept, and where. Everything outside the Stockholm box passes through and is gone.',
  more: 'Read the security page',
  dpa: 'Data processing agreement (DPA)',
  privacy: 'Privacy policy',
};

/**
 * Five rows of the same idea: the task done by hand (copying between the inbox
 * and the chat), then done connected. The screenshot is always the connected
 * result, from the real product.
 */
export const demo = {
  id: 'features',
  h2: 'The same five jobs, by hand and connected.',
  intro:
    'Without an email MCP server you are the connector: you copy a thread out of your inbox, paste it into the chat, copy the answer back and fix the formatting. Here is what each job looks like both ways.',
  byHand: 'By hand',
  connected: 'Connected',
  rows: [
    {
      h3: 'Answer a new enquiry at info@',
      hand: [
        'Open the info@ mailbox in a browser tab.',
        'Copy the customer’s message and the thread above it.',
        'Paste it into Claude or ChatGPT and ask for a reply.',
        'Copy the reply back, fix the line breaks, find the signature.',
        'Send it, and hope you picked the right From address.',
      ],
      connected:
        'Ask “reply to the newest enquiry at info@”. The draft appears in the chat as a card with To, Subject and body you can edit. Click Send, and it leaves from info@ through your own provider, with five seconds to undo.',
      shot: 'card-draft',
      alt: 'MCPEmails draft card in a chat: a reply to jordan@example.com saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons.',
      caption: 'The real draft card, shown in the chat.',
    },
    {
      h3: 'Have a second look before it goes',
      hand: [
        'Paste the draft into a message to a colleague.',
        'Wait for them to read it in another app.',
        'Copy their edits back into the email.',
        'Send it yourself, after they say yes.',
      ],
      connected:
        'Turn on approval for an inbox and every send, reply, forward and scheduled send from that inbox is held. The chat shows the card with Approve in browser, so nothing leaves until a person has looked.',
      shot: 'card-approval',
      alt: 'MCPEmails approval card in a chat: a reply to billing@supplier.example waiting for approval, with Reject and Approve in browser buttons.',
      caption: 'A held send. The button says Approve in browser.',
    },
    {
      h3: 'Clear the queue for the whole team',
      hand: [
        'Ask everyone to forward drafts to one person.',
        'Keep a list of what is waiting and for whom.',
        'Reply to each one with an okay or a change.',
      ],
      connected:
        'Held sends from every inbox land on one Approvals page. Open one, read the recipients, subject and time left, and click Approve & send. On Business, admins approve for the team.',
      shot: 'dashboard-approvals',
      alt: 'MCPEmails Approvals page with emails prepared by an AI assistant waiting for review, each with Reject and Review & approve buttons.',
      caption: 'The Approvals page in the MCPEmails dashboard.',
    },
    {
      h3: 'Work sales@, info@ and invoices@ from one chat',
      hand: [
        'Sign in to each mailbox in its own tab.',
        'Search each one separately for the same customer.',
        'Paste the results into the chat one by one.',
        'Remember which reply belongs to which address.',
      ],
      connected:
        'Connect every mailbox to the same account. Your AI lists them, picks the right one for each request and moves between them in one conversation. Each keeps its own sender name, signature and mail server.',
      shot: 'dashboard-inboxes',
      alt: 'MCPEmails Inboxes page listing two connected IMAP inboxes with a green Connected status and call counts.',
      caption: 'Connected inboxes, each with its own status.',
    },
    {
      h3: 'Know what the AI did, and stop it',
      hand: [
        'Scroll back through chat history to guess what was sent.',
        'Check the Sent folder of every mailbox.',
        'Change a password to cut off access.',
      ],
      connected:
        'The dashboard keeps a live list of recent tool calls and a chart of calls per day. If something looks wrong, revoke that client in one click and the rest keep working.',
      shot: 'dashboard-overview',
      alt: 'MCPEmails dashboard overview: inboxes connected, API keys, MCP calls today and this month, a calls-per-day chart and a live list of recent MCP tool calls.',
      caption: 'The overview: calls per day and the latest tool calls.',
    },
  ],
};

export const providers = {
  id: 'providers',
  h2: 'Connect your inbox. Which providers work?',
  lead:
    'Any mailbox that speaks IMAP and SMTP, and the big ones by name. You connect each inbox once in the dashboard; after that every AI client you add can reach it.',
  postboxAlt:
    'A cobalt postbox on a round base, with lines from its slot to the names of the email providers you can connect.',
  slots: [
    { name: 'Gmail', href: '/connect/gmail' },
    { name: 'Outlook / Microsoft 365', href: '/connect/outlook' },
    { name: 'iCloud Mail', href: '/connect/icloud' },
    { name: 'Fastmail', href: '/connect/fastmail' },
    { name: 'Yahoo Mail', href: '/connect/yahoo' },
    { name: 'Zoho Mail', href: '/connect/zoho' },
    { name: 'Yandex Mail', href: '/connect/yandex' },
    { name: 'GMX', href: '/connect/gmx' },
    { name: 'WEB.DE', href: '/connect/web-de' },
    { name: 'Any IMAP inbox', href: '/connect/imap' },
  ],
  how: [
    { q: 'Gmail and Google Workspace?', a: 'A Google app password, over IMAP. You paste it once.' },
    { q: 'Outlook and Microsoft 365?', a: 'Sign in with Microsoft. A work or school account may need its IT admin to approve the app once.' },
    { q: 'iCloud, Fastmail, Yahoo, Zoho, Yandex?', a: 'An app-specific password from the provider. Fastmail connects with an app password only.' },
    { q: 'My own domain at a host?', a: 'The generic IMAP and SMTP connector: server details and a password, and your AI sends through your own mail server.' },
    { q: 'Can one AI use several at once?', a: 'Yes. Connect as many as your plan allows and label each by its job, like sales or invoices. Your AI picks the right one for each request.' },
    { q: 'What if my provider blocks cloud servers?', a: 'The connection goes through our relay, a plain tunnel with TLS end to end, so the relay never sees your mail or password.' },
  ],
  links: [
    { href: '/connect', text: 'All provider guides' },
    { href: '/docs/providers', text: 'Provider support in the docs' },
    { href: '/tools/email-settings-lookup', text: 'Look up IMAP and SMTP settings' },
  ],
};

export const how = {
  id: 'how',
  h2: 'How it works, in three steps.',
  lead: 'A couple of minutes from sign-up to your AI reading and sending mail.',
  steps: [
    {
      h3: 'Connect your inbox',
      p: 'Create a free account, no card needed, and click Connect Inbox. Pick your provider and complete the Microsoft sign-in or paste an app password. Credentials are encrypted; the mail your AI reads is never stored.',
    },
    {
      h3: 'Add the connector',
      p: 'Paste the connector URL into your AI client. Clients with OAuth, like claude.ai, Claude Desktop, ChatGPT and Cursor, sign in with MCPEmails and need no API key. For clients without OAuth, such as Cline, JetBrains or your own scripts, make a scoped API key in the dashboard.',
    },
    {
      h3: 'Ask, then review',
      p: 'Ask in plain words. Your AI calls tools such as email_read and email_compose, MCPEmails fetches live from your provider, and every draft comes back as a card you can edit and send. Nothing is cached between calls.',
    },
  ],
  urlLabel: 'Connector URL',
  copy: 'Copy',
  copied: 'Copied',
  proofNote:
    'These are the menu names inside each client, from our setup docs. We show the real MCPEmails card rather than a mock-up of someone else’s app.',
  clients: [
    {
      name: 'Claude',
      where: 'claude.ai or Claude Desktop',
      steps: [
        'Open Customize, then Connectors.',
        'Click + Add, then Add custom connector.',
        'Name it MCPEmails and paste the connector URL. Click Continue, keep the detected sign-in settings, click Add.',
        'Sign in with MCPEmails. In a chat, click +, choose Connectors and turn MCPEmails on.',
      ],
      href: '/docs/claude',
      link: 'Full Claude setup',
    },
    {
      name: 'ChatGPT',
      where: 'chatgpt.com, on the web',
      steps: [
        'Open Plugins, then Personal, click Add and choose Add custom MCP server.',
        'Name it MCPEmails and paste the connector URL under Connection.',
        'Choose OAuth, tick I understand and want to continue, click Create as a plugin.',
        'Sign in with MCPEmails. In a chat, type @ and pick MCPEmails.',
      ],
      href: '/docs/chatgpt',
      link: 'Full ChatGPT setup',
    },
  ],
  cardAlt:
    'MCPEmails card after sending a draft: Sent to jordan@example.com with the subject, the start of the message and a Show full message link.',
  cardCaption: 'What you see in the chat after Send: a receipt card from MCPEmails.',
  others:
    'The same URL works in Cursor, VS Code, Windsurf, n8n, Make, LibreChat, OpenWebUI and any client that speaks MCP over streamable HTTP with OAuth 2.1, DCR and PKCE.',
  otherLinks: [
    { href: '/docs/clients', text: 'Setup for every MCP client' },
    { href: '/docs#quickstart', text: 'Quickstart' },
    { href: '/developers', text: 'For developers' },
  ],
};

export const reviews = {
  id: 'reviews',
  h2: 'What do customers say?',
  lead: 'One review so far, quoted word for word, from a founder who runs his company mail through MCPEmails.',
  source: 'Read it on Google',
  rated: (n) => `Rated ${n} out of 5`,
};

export const pricing = {
  id: 'pricing',
  h2: 'What does it cost? One inbox is free.',
  lead:
    'You pay by inbox, not by message. Free connects one inbox. Personal connects three. Pro connects up to 10 for one person running a business. Business is for a team, billed per person who connects a mailbox.',
  freeNote: 'No card required.',
  perForever: '/forever',
  perMonth: '/month',
  inclVat: 'incl. VAT',
  popular: 'Most popular',
  tiers: {
    free: {
      desc: 'Connect one inbox and give your AI a real mailbox.',
      features: [
        '1 connected inbox',
        'Read, search, organise, draft, schedule and send',
        'Send review and approval hold',
        'Gmail, Outlook, iCloud, Fastmail and any IMAP',
        'Unlimited API keys',
      ],
      cta: 'Start free',
    },
    personal: {
      desc: 'Three mailboxes for one person or a small business just starting out.',
      features: ['Everything in Free', '3 connected inboxes', '2x higher burst rate limit', 'Priority email support'],
      cta: 'Get Personal',
    },
    solo: {
      desc: 'For one person running a business: up to 10 mailboxes on one agent, from finance and sales to support.',
      features: [
        'Everything in Personal',
        '10 connected inboxes',
        'Follow-up reminders when nobody replies',
        'Snooze, and a daily morning brief in your inbox',
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
        'Unlimited members with roles',
        'Admins approve sends held for review',
        'Several workspaces on one subscription',
      ],
      cta: 'Get Business',
    },
  },
  team: {
    h3: 'Is Business really per person?',
    p: 'Yes. Each colleague signs in with their own account and connects their own mailboxes, which stay private to them. Shared addresses like info@ and sales@ are made company-wide once, and everyone works them from their own AI client within their role. You pay only for people who connect a mailbox.',
    solo: 'Running every address yourself, with no colleagues who need a login? That is Pro: one login, up to 10 mailboxes, one agent.',
    link: 'How Business works for a team',
  },
  footnote:
    'All plans: the mail your AI reads is fetched live and never stored, and credentials are encrypted at rest.',
  contact: 'Need something custom? Write to',
  compare: 'Compare every plan',
};

export const faq = {
  id: 'faq',
  h2: 'Questions, answered plainly.',
  lead: 'The questions people ask before they connect a first inbox.',
};

export const whatIs = {
  id: 'what-is',
  h2: 'What is an email MCP server?',
  p1: 'An email MCP server is the bridge between an AI assistant and a real mailbox. It speaks the Model Context Protocol, so Claude, ChatGPT, Cursor or any other MCP client can read, search, draft and send email through one endpoint, with no separate integration for each app.',
  p2: 'MCPEmails is a hosted one. It works with Gmail, Outlook and Microsoft 365, iCloud, Fastmail and any mailbox that speaks IMAP, and one agent can work several mailboxes at once. It is open source under AGPL-3.0, so you can also run it yourself.',
  p3: 'It is not a mail host and not a new inbox. Your mail stays with Google, Microsoft or your own provider, and MCPEmails is the pipe between that mailbox and the AI you already use.',
  links: [
    { href: '/connect/imap', text: 'Set up the IMAP MCP server' },
    { href: '/for/business', text: 'Email MCP for company mailboxes' },
    { href: '/blog/connect-claude-to-email', text: 'How to connect Claude to your email' },
    { href: '/blog/connect-chatgpt-to-email', text: 'How to connect ChatGPT to your email' },
    { href: '/blog/claude-imap-connector', text: 'Claude IMAP connector guide' },
    { href: '/native-connectors-vs-mcp', text: 'Native connectors or MCP?' },
    { href: '/self-hosting', text: 'Self-host MCPEmails' },
  ],
  ctaLead: 'Start with one inbox. It is free, and stays free.',
};

export const footer = {
  tagline:
    'A hosted MCP server that gives AI agents read and send access to your inbox, without ever storing the email it reads.',
  contactLabel: 'Contact',
  salesLabel: 'Sales',
  urlLabel: 'MCP endpoint',
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
    ['/', 'English', 'en'],
    ['/nb', 'Norsk', 'nb'],
    ['/es', 'Español', 'es'],
    ['/fr', 'Français', 'fr'],
    ['/de', 'Deutsch', 'de'],
    ['/pt', 'Português (Brasil)', 'pt-BR'],
    ['/ja', '日本語', 'ja'],
    ['/zh', '中文', 'zh'],
  ],
  languageLabel: 'Language',
  copyright: '© 2026 MCPEmails.',
  legal: 'Email fetched live, never stored. Credentials encrypted at rest. Data stored in Stockholm.',
  legalEntity:
    'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
};
