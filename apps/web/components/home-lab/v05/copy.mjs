/**
 * English copy for Homepage Lab v05 ("setup sheet").
 *
 * Voice: calm Scandinavian understatement, written lowercase except product,
 * provider and proper names (the brief's wildcard). The page reads as a Q and
 * A: every section opens on a bold question and a short answer. Facts follow
 * messages/en/home.json, the client setup pages and /about. Nothing here is a
 * quote from a person except the one sentence marked as taken from /about.
 */

export const ENDPOINT = 'https://mcpemails.com/api/mcp';

export const nav = {
  how: 'how it works',
  pricing: 'pricing',
  docs: 'docs',
  blog: 'blog',
  signIn: 'sign in',
  start: 'start free',
  label: 'primary',
};

export const hero = {
  label: 'hosted email MCP server',
  h1: 'an email MCP server for Claude and ChatGPT.',
  lead:
    'MCPEmails is the connector between your AI and the mailboxes your company already runs: info@, sales@ and invoices@ on Gmail, Outlook or any IMAP server, or just your own inbox. connect them once, paste one URL into Claude or ChatGPT, and ask. it reads your mail when you ask, and keeps none of it.',
  start: 'start free',
  install: 'add to Claude or ChatGPT',
  meta: [
    ['1 inbox', 'free, for good'],
    ['card', 'not needed'],
    ['mail', 'fetched live'],
  ],
  indexLabel: 'the setup, in order',
};

export const steps = {
  clip: {
    tag: 'the card',
    h: 'what does it look like in the chat?',
    p: [
      'a card. the assistant writes the reply, the card shows it with the real To, Subject and body, and you can change a word before anything happens. press send and a five-second undo runs first. after that it is a short receipt.',
      'nothing is drawn for this page: the clip is the draft card MCPEmails puts in the chat, recorded on our own test inboxes.',
    ],
    figure: 'fig. {n} · a draft card: send, the undo countdown, then the receipt',
    clipAlt:
      'Screen recording: an MCPEmails draft card in a chat, Send is clicked, a five-second Undo countdown runs and the card becomes a sent receipt.',
    pause: 'pause',
    play: 'play',
  },
  connect: {
    tag: 'connect',
    h: 'which mailboxes can it reach?',
    p: [
      'most of them. Gmail and Google Workspace connect with a Google app password over IMAP. Outlook and Microsoft 365 connect by signing in with Microsoft, over OAuth; a work or school account may need its IT admin to approve the app once. iCloud, Fastmail, Yahoo, Zoho and Yandex take an app-specific password.',
      'everything else that speaks IMAP and SMTP connects with the generic connector: a mailbox on your own domain at a hosting company, a regional ISP, a server in a cupboard. you enter the server details once, the agent reads over IMAP and sends through your own SMTP server.',
      'for a company, connect each address once. info@, sales@, invoices@ and support@ sit side by side, and one agent works all of them through one endpoint, picking the right inbox for each request.',
    ],
    hoverHint: 'hover or focus a provider to see how it connects.',
    links: [
      ['/connect', 'every provider we connect'],
      ['/docs/providers', 'provider support, in detail'],
      ['/tools/email-settings-lookup', 'look up IMAP and SMTP settings'],
    ],
    figure: 'fig. {n} · connect an inbox, in the dashboard',
  },
  paste: {
    tag: 'paste the URL',
    h: 'how do I add it to Claude or ChatGPT?',
    p: [
      'with one URL. MCPEmails is a standard remote MCP server, so both clients add it as a custom connector and sign in over OAuth. there is no API key to create and no config file to edit.',
    ],
    endpointLabel: 'endpoint',
    startAbove: 'start free, then pick your client',
    claude: {
      h: 'add to Claude',
      steps: [
        'in claude.ai or Claude Desktop, open customize, then connectors. click + add and choose add custom connector.',
        `name it MCPEmails and paste ${ENDPOINT} as the server URL. keep the sign-in settings it detects.`,
        'click add and sign in with MCPEmails. Claude can now read, search and send from your inbox.',
      ],
      guide: ['/blog/connect-claude-to-email', 'the full Claude guide'],
      figure: 'fig. {n}a · a sent draft, as the card shows it in the chat',
    },
    chatgpt: {
      h: 'add to ChatGPT',
      steps: [
        'on chatgpt.com, open plugins, then personal. click add and choose add custom MCP server.',
        `name it MCPEmails, paste ${ENDPOINT} under connection and choose OAuth.`,
        'create it as a plugin and sign in. in a chat, type @ and pick MCPEmails.',
      ],
      note: 'OpenAI lists custom MCP servers for Business and Enterprise/Edu, with read-only access on Pro, on the web.',
      guide: ['/blog/connect-chatgpt-to-email', 'the full ChatGPT guide'],
      figure: 'fig. {n}b · a send held for approval, as the card shows it',
    },
    after:
      'the same URL works in Cursor, VS Code, Windsurf, n8n, Make, LibreChat and any other MCP client. OAuth clients connect in a click. clients without OAuth, and your own scripts, use a scoped API key from the dashboard instead.',
    links: [
      ['/docs/clients', 'setup for every MCP client'],
      ['/docs#quickstart', 'quickstart'],
      ['/docs#oauth', 'how the OAuth connection works'],
      ['/blog/claude-imap-connector', 'Claude as an IMAP connector'],
    ],
    figure: 'fig. {n} · the endpoint sits at the top of every dashboard page',
  },
  ask: {
    tag: 'ask',
    h: 'what do I actually say to it?',
    p: [
      'what you would say to a capable assistant. it lists the inboxes you connected, picks the right one, and reads, searches, drafts, files and sends. there is no dashboard to learn first and no syntax.',
      'behind each request sits a tool call. inbox_list finds the connected inboxes, email_read lists, reads and searches, email_compose sends, replies and forwards, and smaller tools cover folders, drafts, scheduling, contacts and signatures.',
    ],
    promptsLabel: 'things people ask',
    prompts: [
      ['go through sales@ and info@ and list every enquiry from this week nobody has answered', 'open enquiries across both inboxes, oldest first.'],
      ['forward this month’s invoices from invoices@ to our accountant', 'forwarded from invoices@, PDFs attached.'],
      ['move every receipt from this month into a Receipts folder', 'moved into Receipts.'],
      ['send this at 8am monday, not now', 'scheduled. nothing goes out before then.'],
    ],
    toolsLink: ['/docs#tools', 'the tool reference'],
    figure: 'fig. {n} · a reply drafted by the assistant, saved to Drafts',
  },
  approve: {
    tag: 'approve',
    h: 'can it send without me?',
    p: [
      'only if you let it. turn on approval for an inbox and every send, reply, forward, draft send and scheduled send waits for you. the card in the chat says approve in browser; you open the request on your dashboard, read exactly what will go out, and decide.',
      'on Business, admins approve the sends held for review, and recipient rules hold any message addressed outside the domains you list.',
    ],
    figure: 'fig. {n} · the approve email send dialog, on the dashboard',
  },
  sent: {
    tag: 'sent',
    h: 'and then?',
    p: [
      'it goes out through your own provider, from your own address: Gmail, Microsoft Graph or your SMTP server. it lands in your Sent folder like anything you send yourself, and the card becomes a short receipt.',
      'if a provider refuses connections from cloud addresses, the connection goes through our relay, a plain tunnel with TLS end to end, so the relay never sees your mail or your password.',
    ],
    figure: 'fig. {n} · the receipt: approved in the browser, sent over SMTP, copied to Sent',
  },
};

export const security = {
  tag: 'storage',
  h: 'where does my mail go?',
  intro:
    'to your agent, and no further. a few short answers on what MCPEmails touches, what it keeps, and where that is.',
  items: [
    {
      q: 'is my email stored anywhere?',
      a: 'no. each tool call reaches your provider live, through the Gmail API, Microsoft Graph or IMAP. message bodies, subjects and attachments go to the agent and are discarded right after. the exceptions are messages that have to wait: one you schedule for later, or a send held for your approval, is stored encrypted until it goes.',
      margin: 'stored',
    },
    {
      q: 'what is kept, and where?',
      a: 'one thing per inbox: the token or app password the next call needs, encrypted. it sits in an EU database in Stockholm, with the scheduled and held sends and nothing else from your mailbox.',
      margin: 'location',
    },
    {
      q: 'how are the credentials protected?',
      a: 'OAuth tokens and app passwords are encrypted with AES-256-GCM before they reach the database, and decrypted on our servers only for the request that needs them. the encryption key is kept as an environment secret, apart from the database.',
      margin: 'encrypted',
    },
    {
      q: 'how does a request travel?',
      a: 'your chat app calls MCPEmails over MCP. MCPEmails opens your mailbox, does the one thing asked, and returns the answer. you review a draft in the chat before it sends from your address. nothing is cached between calls.',
      margin: 'flow',
    },
    {
      q: 'how do I cut an agent off?',
      a: 'one click. MCPEmails is standard MCP over streamable HTTP with OAuth 2.1, dynamic client registration and PKCE, so every connected client is listed in the dashboard, and each one can be revoked on its own.',
      margin: 'revoke',
    },
  ],
  links: [
    ['/security', 'security'],
    ['/privacy', 'privacy policy'],
    ['/dpa', 'data processing agreement'],
    ['/docs/read-only-access', 'read-only access'],
  ],
};

export const team = {
  tag: 'for a company',
  h: 'is it for one person or a team?',
  intro:
    'both, and the company comes first. most small companies run their mail on their own domain, with a handful of shared addresses and one or two people who answer most of them. MCPEmails is built for that shape.',
  items: [
    {
      q: 'one person, many addresses?',
      a: 'that is Pro. one login, up to 10 mailboxes on one agent: finance, sales, support and your own. each mailbox keeps its own sender name and signature and sends through its own mail server. two or three addresses fit on Personal.',
    },
    {
      q: 'colleagues who need their own login?',
      a: 'that is Business, billed per person who connects a mailbox. each person connects their own mailboxes, and those stay private to them: colleagues and admins see that a mailbox is connected, never its mail. shared addresses like info@ and sales@ are made company-wide, and everyone works them from their own AI client, within their role.',
    },
    {
      q: 'and the paperwork?',
      a: 'invoices carry your company name and VAT ID, a data processing agreement is published, roles come in viewer, member and admin, and the audit log of what each AI client did can be exported as CSV.',
    },
  ],
  links: [
    ['/for/business', 'MCPEmails for a company’s mailboxes'],
    ['/for/founders', 'for founders running everything alone'],
  ],
};

export const maker = {
  tag: 'the maker',
  h: 'who is behind it?',
  items: [
    {
      q: 'a company, or a person?',
      a: 'both. MCPEmails is built and run by Asgeir Albretsen, a software developer in Bergen, Norway, and operated by Albretsen AS, a registered Norwegian company. he builds it alone, in his own time, self funded.',
    },
    {
      q: 'why build it?',
      a: 'he wanted his own agents working his inbox, and every option he found wanted a copy of the mail first: sync it, index it, keep it. so MCPEmails fetches mail when the agent asks and drops it once the answer is sent.',
    },
    {
      q: 'and if he stops?',
      a: 'the server is open source under AGPL-3.0, and the hosted service runs the same code. you clone it, bring the stack up with docker-compose, point your agent at your own instance, and carry on. the tool names stay the same.',
    },
    {
      q: 'who answers support?',
      a: 'he does. there is no queue, and a reply usually comes within one business day, European time. write to',
    },
  ],
  quote: 'I run my own mail through it every day.',
  quoteSource: 'Asgeir Albretsen, on the about page',
  links: [
    ['/about', 'about MCPEmails'],
    ['/self-hosting', 'run it yourself'],
    ['/developers', 'for developers'],
    ['/docs/api', 'developer guide'],
    ['/changelog', 'what changed lately'],
    ['/status', 'service status'],
  ],
};

export const reviews = {
  tag: 'reviews',
  h: 'what do people running it say?',
  intro: 'only reviews published under the reviewer’s own name, quoted as written, with a link to where they wrote it.',
  publishedOn: 'published on',
  rating: 'rated {n} out of 5',
};

export const pricing = {
  tag: 'pricing',
  h: 'what does it cost?',
  intro:
    'priced by inbox, with no metering on paid plans. Free connects one inbox, Personal three, Pro up to 10 for one person running a business, and Business is for a team.',
  perForever: '/forever',
  perMonth: '/month',
  inclVat: 'incl. VAT',
  popular: 'one person, many mailboxes',
  marks: { free: '1 inbox', personal: '3 inboxes', solo: 'up to 10 inboxes', business: 'billed per person', businessFlat: '10 mailboxes included' },
  tiers: {
    free: {
      desc: 'one inbox, and a real mailbox for your agent.',
      features: [
        '1 connected inbox',
        'read, search, organise, draft, schedule and send',
        'send review and approval hold',
        'Gmail, Outlook, iCloud, Fastmail and any IMAP',
        'unlimited API keys',
      ],
      cta: 'start free',
    },
    personal: {
      desc: 'three mailboxes for one person: work, personal, or your first company addresses.',
      features: ['everything in Free', '3 connected inboxes', '2x higher burst rate limit', 'priority email support'],
      cta: 'get Personal',
    },
    solo: {
      desc: 'one person running a business: up to 10 mailboxes on one agent.',
      features: [
        'everything in Personal',
        '10 connected inboxes',
        'follow-up reminders when nobody replies',
        'snooze, and a daily morning brief',
        'search every connected inbox at once',
        'instructions for your AI, per inbox',
      ],
      cta: 'get Pro',
    },
    business: {
      desc: 'many mailboxes or several people: 10 mailboxes included, more at a fixed price each.',
      features: [
        'everything in Pro',
        '10 mailboxes included, $3 a month for each extra',
        'unlimited members with roles',
        'admins approve sends held for review',
        'several workspaces on one subscription',
      ],
      cta: 'get Business',
    },
  },
  footnote: 'on every plan, the mail your agent reads is fetched live and never stored.',
  compare: ['/pricing', 'the full comparison'],
  contact: 'need something custom? write to',
};

export const faq = {
  tag: 'faq',
  h: 'the questions left over.',
  intro: 'the ones people ask before they connect a first inbox.',
};

export const closing = {
  h: 'one inbox is free, for good.',
  p: 'no card, no trial clock. connect a mailbox, paste the URL, and ask for something small. a second and third mailbox, or a team, can come later.',
  start: 'start free',
  install: 'client setup guides',
  signIn: 'already have an account? sign in',
};

export const footer = {
  tagline:
    'a hosted email MCP server that gives AI agents read and send access to your inbox, without storing the email it reads.',
  endpoint: 'MCP endpoint',
  contact: 'contact',
  sales: 'sales',
  groups: [
    {
      h: 'product',
      links: [
        ['/#features', 'storage and security'],
        ['/#how', 'how it works'],
        ['/pricing', 'pricing'],
        ['/docs', 'docs'],
        ['/self-hosting', 'self-hosting'],
        ['/for/founders', 'for founders'],
        ['/for/business', 'for business'],
        ['/developers', 'developers'],
      ],
    },
    {
      h: 'resources',
      links: [
        ['/docs#tools', 'tool reference'],
        ['/docs#quickstart', 'quickstart'],
        ['/docs#oauth', 'OAuth connection'],
        ['/docs/providers', 'provider support'],
        ['/docs/read-only-access', 'read-only access'],
        ['/docs/api', 'developer guide'],
        ['/docs/clients', 'MCP client setup'],
        ['/tools/email-settings-lookup', 'IMAP and SMTP settings lookup'],
        ['/blog', 'blog'],
        ['/changelog', 'changelog'],
      ],
    },
    {
      h: 'connect',
      links: [
        ['/connect', 'all providers'],
        ['/connect/imap', 'IMAP'],
        ['/connect/gmail', 'Gmail'],
        ['/connect/outlook', 'Outlook'],
        ['/connect/fastmail', 'Fastmail'],
        ['/connect/icloud', 'iCloud'],
        ['/connect/yahoo', 'Yahoo'],
        ['/connect/zoho', 'Zoho'],
        ['/connect/yandex', 'Yandex'],
        ['/native-connectors-vs-mcp', 'native connectors vs MCP'],
        ['/best-email-mcp-servers', 'best email MCP servers'],
      ],
    },
    {
      h: 'company',
      links: [
        ['/about', 'about'],
        ['/security', 'security'],
        ['/status', 'status'],
        ['/help', 'help and support'],
        ['/privacy', 'privacy'],
        ['/terms', 'terms'],
        ['/dpa', 'DPA'],
        ['/cancel?type=withdraw', 'withdraw from contract here'],
        ['/cancel', 'cancel contracts here'],
        ['/terms#agreement', 'impressum'],
      ],
    },
  ],
  languagesLabel: 'language',
  languages: [
    ['/', 'en', 'English'],
    ['/nb', 'nb', 'Norsk'],
    ['/es', 'es', 'Español'],
    ['/fr', 'fr', 'Français'],
    ['/de', 'de', 'Deutsch'],
    ['/pt', 'pt-BR', 'Português (Brasil)'],
    ['/ja', 'ja', '日本語'],
    ['/zh', 'zh', '中文'],
  ],
  legal: 'email fetched live, never stored · credentials encrypted at rest · data stored in Stockholm',
  copyright: '© 2026 MCPEmails.',
  entity:
    'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
};

/** Providers for the connect grid. `how` is shown on hover and focus. */
export const providers = [
  { name: 'Gmail', href: '/connect/gmail', logo: 'gmail', w: 28, how: 'Google app password, over IMAP' },
  { name: 'Outlook / Microsoft 365', href: '/connect/outlook', logo: 'outlook', w: 26, how: 'OAuth: sign in with Microsoft' },
  { name: 'iCloud Mail', href: '/connect/icloud', logo: 'icloud', w: 30, how: 'app-specific password' },
  { name: 'Fastmail', href: '/connect/fastmail', logo: 'fastmail', w: 26, how: 'app password' },
  { name: 'Yahoo Mail', href: '/connect/yahoo', logo: 'yahoo', w: 26, how: 'app password' },
  { name: 'Zoho Mail', href: '/connect/zoho', logo: null, mono: 'Z', how: 'app password' },
  { name: 'Yandex Mail', href: '/connect/yandex', logo: 'yandex', w: 26, how: 'app password' },
  { name: 'GMX', href: '/connect', logo: 'gmx', w: 42, how: 'IMAP login' },
  { name: 'WEB.DE', href: '/connect', logo: 'webde', w: 24, how: 'IMAP login' },
  { name: 'any IMAP inbox', href: '/connect/imap', logo: 'imap', w: 26, how: 'IMAP and SMTP login' },
];
