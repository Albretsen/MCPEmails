/**
 * All English copy for Homepage Lab v08, "The Spec Sheet" (staging only).
 *
 * Voice: two readers. Every section is written for a person, and most end
 * with a short "Note to the agent" for the AI that reads the page too. The
 * notes only state facts and point at the docs; they never ask an agent to do
 * anything.
 *
 * Facts follow messages/en/home.json, messages/en/docs.json and
 * messages/en/about.json. The founder letter is built only from what /about
 * already publishes, in Asgeir's own first person as /about writes it.
 */

export const MCP_URL = 'https://mcpemails.com/api/mcp';
export const REPO_URL = 'https://github.com/Albretsen/MCPEmails';

export const nav = {
  label: 'Primary',
  links: [
    { href: '/#features', label: 'Spec sheet' },
    { href: '/#how', label: 'How it works' },
    { href: '/#pricing', label: 'Pricing' },
    { href: '/docs', label: 'Docs' },
    { href: '/blog', label: 'Blog' },
  ],
  signIn: 'Sign in',
  start: 'Start free',
};

export const hero = {
  kicker: 'Hosted email MCP server',
  h1: 'The email MCP server for the inboxes your company runs on.',
  lead:
    'MCPEmails connects info@, sales@ and invoices@ on your own domain, or the one inbox you use yourself, to Claude, ChatGPT, Cursor and any MCP client as a connector. Gmail, Outlook, iCloud, Fastmail and any IMAP mailbox. Your agent reads, searches, drafts and sends live, and the mail it reads is never stored.',
  ctaPrimary: 'Start free',
  ctaSecondary: 'Install in Claude or ChatGPT',
  facts: ['1 inbox free, forever', 'No card required', 'Data stored in Stockholm'],
  business: 'Running several company addresses?',
  businessLink: 'One agent for all your work mailboxes',
  objectLabel: 'The draft card, as an object',
  objectCaption:
    'A send is a slip of paper that waits for your stamp. Rendered in 3D once, here; everything below is a real screenshot.',
  objectAlt:
    'The MCPEmails draft card shown as a physical object: a white slip with a cobalt edge, message lines, a Send button and an approval stamp beside it.',
  clipLabel: 'Real recording, no edits',
  clipCaption:
    'A draft card in a chat. Send is clicked, a five-second Undo countdown runs, and the card turns into a Sent receipt for jordan@example.com.',
  clipAlt:
    'MCPEmails draft card in a chat: a reply to jordan@example.com with editable To, Subject and body, and Save and Send buttons.',
  clipVideoLabel:
    'Screen recording: an MCPEmails draft card, Send is clicked, a five-second Undo countdown runs and the card becomes a Sent receipt.',
  pause: 'Pause clip',
  play: 'Play clip',
  agentNote:
    'the MCP endpoint is https://mcpemails.com/api/mcp. The tool reference, with every argument, is at /docs#tools.',
};

export const index = {
  label: 'On this page',
  progress: 'Reading progress',
};

export const quotes = {
  h2: 'In a customer’s words',
  intro:
    'The only reviews on this page are ones people published under their own names. This one is quoted as written, spelling included.',
  ratingLabel: 'Rated 5 out of 5',
  via: 'Read it on',
  agentNote:
    'reviews here come from one source file and are quoted verbatim. The source link opens the review itself.',
};

/**
 * The spec sheet. Each group is an H3 with its own git date; rows are a
 * two-column key/value table. `links` render after the value.
 */
export const spec = {
  h2: 'The spec sheet',
  intro:
    'Everything a buyer asks about, on one long sheet. Read it top to bottom, or jump to the row you came for. Where a row has a page of its own, the link is beside it.',
  groups: [
    {
      id: 'what',
      dateKey: 'specWhat',
      h3: 'What is an email MCP server?',
      lede:
        'An email MCP server is the bridge between an AI assistant and a real mailbox. It speaks the Model Context Protocol, so Claude, ChatGPT, Cursor or any other MCP client can read, search, draft and send email through one endpoint, with no separate integration for each app.',
      rows: [
        { key: 'Product', value: 'MCPEmails, a hosted email MCP server. The same server is open source, so you can also run it yourself.' },
        { key: 'Endpoint', value: 'One URL for every client:', code: 'https://mcpemails.com/api/mcp' },
        {
          key: 'Built for',
          value:
            'Teams who run mail on their own domain: info@, sales@, invoices@, support@. And the person who wants Claude or ChatGPT working one inbox of their own.',
          links: [
            { href: '/for/business', label: 'For business' },
            { href: '/for/founders', label: 'For founders' },
          ],
        },
        {
          key: 'Guides',
          value: 'Step by step, with screenshots of each client.',
          links: [
            { href: '/blog/connect-claude-to-email', label: 'Connect Claude to your email' },
            { href: '/blog/connect-chatgpt-to-email', label: 'Connect ChatGPT to your email' },
            { href: '/blog/claude-imap-connector', label: 'Claude IMAP connector' },
          ],
        },
        {
          key: 'Compared',
          value: 'How a hosted MCP server differs from the connectors built into chat apps, and how the email MCP servers compare.',
          links: [
            { href: '/native-connectors-vs-mcp', label: 'Native connectors vs MCP' },
            { href: '/best-email-mcp-servers', label: 'Best email MCP servers' },
          ],
        },
      ],
    },
    {
      id: 'providers',
      dateKey: 'specProviders',
      h3: 'Providers',
      lede:
        'Gmail, Outlook, iCloud, Fastmail and any IMAP inbox. Each mailbox connects once, and its credential is encrypted before it is stored.',
      rows: [
        { key: 'Providers', value: 'Gmail, Google Workspace, Outlook, Microsoft 365, iCloud Mail, Fastmail, Yahoo Mail, Zoho Mail, Yandex Mail, GMX, WEB.DE, and any mailbox that speaks IMAP and SMTP.', links: [{ href: '/connect', label: 'All providers' }, { href: '/docs/providers', label: 'Provider support' }] },
        { key: 'Gmail and Workspace', value: 'A Google app password over IMAP.', links: [{ href: '/connect/gmail', label: 'Connect Gmail' }] },
        { key: 'Outlook and Microsoft 365', value: 'Sign in with Microsoft (OAuth 2.0). A work or school account may need its IT admin to approve the app once; the dashboard gives you a link to send them.', links: [{ href: '/connect/outlook', label: 'Connect Outlook' }] },
        { key: 'iCloud Mail', value: 'An app-specific password from your Apple account.', links: [{ href: '/connect/icloud', label: 'Connect iCloud' }] },
        { key: 'Fastmail', value: 'A Fastmail app password.', links: [{ href: '/connect/fastmail', label: 'Connect Fastmail' }] },
        { key: 'Yahoo, Zoho, Yandex', value: 'An app-specific password for each.', links: [{ href: '/connect/yahoo', label: 'Yahoo' }, { href: '/connect/zoho', label: 'Zoho' }, { href: '/connect/yandex', label: 'Yandex' }] },
        { key: 'Your own domain', value: 'The generic IMAP and SMTP connector: your web host, a regional ISP, your company server. Enter the server details and an app password once.', links: [{ href: '/connect/imap', label: 'Set up the IMAP MCP server' }, { href: '/tools/email-settings-lookup', label: 'IMAP and SMTP settings lookup' }] },
        { key: 'Several at once', value: 'Connect each mailbox to the same account and one agent reaches all of them through one endpoint. It lists the inboxes, picks the right one for each request, and moves between a support address and a personal one in the same conversation.' },
        { key: 'Compatibility', value: 'Every inbox reports a versioned compatibility profile, so an agent can use portable actions and still see where a provider behaves differently.' },
      ],
      figure: {
        desktop: 'dashboard-connect-providers-light-desktop',
        mobile: 'dashboard-connect-providers-light-mobile',
        w: 1280,
        h: 1800,
        mw: 780,
        mh: 1688,
        narrow: true,
        alt: 'MCPEmails Connect an inbox dialog with provider tiles for IMAP / SMTP, Gmail, iCloud Mail, Yahoo Mail, Zoho Mail, Yandex Mail, Fastmail and Outlook.',
        caption: 'The Connect an inbox dialog in the dashboard. Pick a provider, paste an app password or sign in with Microsoft.',
      },
      agentNote: 'which providers support which operations is listed per provider at /docs/providers.',
    },
    {
      id: 'clients',
      dateKey: 'specClients',
      h3: 'Clients',
      lede:
        'Standard MCP over streamable-http, with OAuth 2.1, DCR and PKCE. Paste one URL into the client you already use.',
      rows: [
        { key: 'Clients', value: 'Claude (claude.ai and Claude Desktop), ChatGPT, Cursor, VS Code, Windsurf, n8n, Make, LibreChat, OpenWebUI, and any MCP-compatible client.', links: [{ href: '/docs/clients', label: 'MCP client setup' }] },
        { key: 'Claude and ChatGPT', value: 'Add a custom connector in your client settings, paste the endpoint URL as the server URL, and approve the sign-in. No API key to copy.', links: [{ href: '/connect', label: 'Install' }] },
        { key: 'OAuth', value: 'Clients that support OAuth connect through authorization code and PKCE, and register themselves with DCR.', links: [{ href: '/docs#oauth', label: 'OAuth connection' }] },
        { key: 'API key', value: 'For clients without OAuth (Cline, JetBrains, your own scripts), generate a scoped API key in the dashboard.', links: [{ href: '/docs/api', label: 'Developer guide' }, { href: '/developers', label: 'Developers' }] },
        { key: 'Tools', value: 'Action-based tools for the everyday work: inbox_list, email_read and email_compose, plus organizing, deleting, folders, drafts, scheduling, contacts, signatures and unattended automations.', links: [{ href: '/docs#tools', label: 'Tool reference' }] },
        { key: 'Read only', value: 'An API key or an OAuth connection can be given read-only access: list and search inboxes, read emails. Calls that change or send mail are refused.', links: [{ href: '/docs/read-only-access', label: 'Read-only access' }] },
      ],
      figure: {
        desktop: 'card-draft-light-desktop',
        mobile: 'card-draft-light-mobile',
        w: 1364,
        h: 776,
        mw: 720,
        mh: 878,
        alt: 'MCPEmails draft card in a chat: a reply to jordan@example.com saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons.',
        caption: 'The draft card a client shows when your agent writes a reply. To, Subject and body stay editable until you click Send.',
      },
      agentNote: 'the scope each tool needs is listed beside it at /docs#tools.',
    },
    {
      id: 'data',
      dateKey: 'specData',
      h3: 'Data',
      lede: 'What is kept, where, and how you take access back.',
      rows: [
        { key: 'Data location', value: 'Account data is stored in one region, in an EU database in Stockholm, Sweden.', links: [{ href: '/privacy', label: 'Privacy' }, { href: '/dpa', label: 'DPA' }] },
        { key: 'Storage', value: 'Mail is fetched live from your provider on each call and never stored. Message bodies, subjects and attachments go to the agent and are discarded. The exceptions are outgoing messages that have to wait: a scheduled send, or a send held for your approval, is stored encrypted.' },
        { key: 'Credentials', value: 'OAuth tokens and app passwords are encrypted with AES-256-GCM before they are written. The key is an environment secret, kept apart from the database.' },
        { key: 'Revoke', value: 'Any agent connection can be revoked from the dashboard in one click. The next call it makes is refused.' },
        { key: 'Analytics', value: 'Cookieless product analytics only. No email content, addresses, API keys, OAuth tokens or MCP request data.' },
      ],
      agentNote: 'the full security model, with the disclosure process, is at /security.',
    },
    {
      id: 'sending',
      dateKey: 'specSending',
      h3: 'Sending',
      lede: 'Every message goes out from your own address, through your own provider, and you can make any inbox wait for a person.',
      rows: [
        { key: 'Sends from', value: 'Your own provider and your own address: Gmail, Outlook, Fastmail, or your own SMTP server.' },
        { key: 'Draft card', value: 'The agent writes, you edit in the chat and click Send. Five seconds to Undo, then the card turns into a Sent receipt.' },
        { key: 'Approval', value: 'Turn on approval for an inbox and sends, replies, forwards, draft sends and scheduled sends wait for review. The card says Approve in browser, and no agent can approve a send.' },
        { key: 'Schedule', value: 'Send at 8:00 on Monday, not now. Cancel any time before it goes out.' },
        { key: 'Relay', value: 'If a provider refuses connections from cloud addresses, the connection goes through our relay: a plain tunnel with TLS end to end, so the relay never sees your mail or your password.' },
        { key: 'Send As', value: 'A different From address works only when it is a verified Send As address for that inbox.' },
      ],
      figure: {
        pair: true,
        top: { desktop: 'card-approval-light-desktop', mobile: 'card-approval-light-mobile', w: 1364, h: 484, mw: 720, mh: 602, alt: 'MCPEmails approval card in a chat: a reply to billing@supplier.example waiting for approval, with Reject and Approve in browser buttons and the note that no agent can approve a send.' },
        bottom: { desktop: 'card-sent-light-desktop', mobile: 'card-sent-light-mobile', w: 1364, h: 138, mw: 720, mh: 172, alt: 'MCPEmails receipt card: Sent to billing@supplier.example, approved in the browser, sent over SMTP and copied to Sent.' },
        caption: 'A held send, then its receipt. The approval happens in the browser, by a person; the receipt says how it was sent and that a copy is in Sent.',
      },
      agentNote: 'a held send returns a pending result. What happens next is described under approval at /docs.',
    },
    {
      id: 'how',
      dateKey: 'specSetup',
      h3: 'How it works',
      lede: 'You are the user. MCPEmails is the pipe. Three steps from sign-up to your agent reading and sending mail.',
      rows: [
        { key: '1. Connect your inbox', value: 'Sign in and click Connect Inbox. Choose Gmail, Outlook, iCloud, Fastmail or any IMAP inbox, then sign in with Microsoft or paste an app password.', links: [{ href: '/signup', label: 'Create a free account' }] },
        { key: '2. Paste the URL', value: 'In a client with OAuth, paste the endpoint, click Connect and authorize. In a client without it, use a scoped API key.', links: [{ href: '/docs#quickstart', label: 'Quickstart' }] },
        { key: '3. Your agent works the inbox', value: 'It calls tools like email_read or email_compose. MCPEmails fetches live from your provider and returns the result. Nothing is cached between calls.' },
      ],
      figure: {
        svg: true,
        desktop: '/home-lab/assets/c/diagram-flow.svg',
        mobile: '/home-lab/assets/c/diagram-flow-mobile.svg',
        w: 960,
        h: 432,
        mw: 358,
        mh: 252,
        alt: 'How it works: your chat app asks MCPEmails over MCP, MCPEmails fetches your inbox live, and you review each draft in the chat and click Send before it goes out from your own address.',
        caption: 'One call, start to finish: your chat app asks, MCPEmails fetches from your provider, and the draft waits for your Send.',
      },
      agentNote: 'inbox_list returns every connected inbox with its id. Its result is described at /docs#tools.',
    },
    {
      id: 'plans',
      dateKey: 'specPlans',
      h3: 'Plans',
      lede: 'Priced by inbox. No metering on paid plans. Full prices are in the Pricing section below.',
      rows: [
        { key: 'Plans', value: 'Free, Personal, Pro and Business, monthly or yearly. Every plan reads, searches, organizes, drafts, schedules and sends.', links: [{ href: '/#pricing', label: 'Prices' }, { href: '/pricing', label: 'Full comparison' }] },
        { key: 'One person', value: 'Free connects one inbox. Personal connects three. Pro connects up to 10 for one person running a business.' },
        { key: 'A team', value: 'Business is billed per person who connects a mailbox. Each person’s own mail stays private, and shared addresses are company-wide.' },
        { key: 'Self-host', value: 'Open source under AGPL-3.0. A docker-compose stack runs the full MCP server against your own database.', links: [{ href: '/self-hosting', label: 'Self-hosting' }] },
      ],
    },
  ],
};

export const security = {
  h2: 'Security model',
  intro: 'Four statements. They are the four things people ask before connecting a mailbox, and each one is true of the code that runs today.',
  items: [
    { n: '1', h: 'Mail is fetched live and never stored.', p: 'Each tool call reaches your provider in real time, through IMAP, the Gmail API or Microsoft Graph. What the agent reads is passed on and dropped once the response is sent.' },
    { n: '2', h: 'Credentials are encrypted at rest.', p: 'An OAuth token or app password is encrypted with AES-256-GCM before it is written, and decrypted on our servers only for the request that needs it.' },
    { n: '3', h: 'OAuth access is revocable in one click.', p: 'Every connected client is listed in the dashboard. Revoke one and its token stops working on the next call.' },
    { n: '4', h: 'Data is stored in Stockholm.', p: 'The database sits in one EU region, in Stockholm. What it holds: your account, encrypted credentials, and sends that are scheduled or waiting for approval.' },
  ],
  figure: {
    src: '/home-lab/assets/c/diagram-stored.svg',
    w: 960,
    h: 400,
    mobileSrc: '/home-lab/assets/c/diagram-stored-mobile.svg',
    mobileW: 358,
    mobileH: 588,
    alt: 'MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored.',
    caption: 'What is kept, and what passes through. The first panel is the whole of what is stored.',
  },
  links: [
    { href: '/security', label: 'Security' },
    { href: '/privacy', label: 'Privacy policy' },
    { href: '/dpa', label: 'Data processing agreement' },
    { href: '/status', label: 'Status' },
  ],
  agentNote: 'message content you read through MCPEmails exists only for the call that fetched it. The details are at /security.',
};

export const letter = {
  h2: 'A letter from the founder',
  salutation: 'To whoever is about to connect a mailbox,',
  paragraphs: [
    'My name is Asgeir Albretsen. I am a software developer in Bergen, Norway, and I build and run MCPEmails alone.',
    'I wanted my own agents working my inbox. Every option I found wanted a copy of my mail first: sync it, index it, keep it in someone else’s database for as long as the account exists. For a mailbox full of invoices, contracts and password resets, that is a lot to give up for something I only needed now and then.',
    'So I built the version I was willing to use. Mail is fetched live when your agent asks for it and dropped once the response is sent, so there is no stored copy. What is kept per inbox is the mailbox credential, encrypted at rest, because the next call needs it, plus the few details a feature you turn on needs, such as a scheduled message waiting to go out. I run my own mail through it every day.',
    'You are trusting three things. A named person: me, not a support alias. A registered company: MCPEmails is operated by Albretsen AS, a Norwegian private limited company that I own and whose board I chair. And code you can read: the server is public on GitHub under AGPL-3.0, and the hosted service runs the same code.',
    'One person running an email service is a real risk. That is what the licence is for. If I stop, you clone the repository, bring the stack up with one command, point your agent at your own instance, and carry on. The tool names stay the same. Your credentials are yours, and your mail was never stored here.',
    'There is no support queue. Your message arrives with me, and I answer it, usually within one business day.',
  ],
  signName: 'Asgeir Albretsen',
  signRole: 'Founder, Albretsen AS, Bergen',
  psLabel: 'P.S.',
  psIntro: 'What it does, in short:',
  ps: [
    'Reads, searches, organizes, drafts, schedules and sends mail in the inboxes you connect.',
    'Several mailboxes on one agent, through one endpoint.',
    'A draft card in the chat: edit, click Send, five seconds to Undo.',
    'Per-inbox approval, so sends wait for a person.',
    'On Pro: follow-up reminders, snooze, a daily morning brief and one search across every inbox.',
    'Open source, with a self-host guide you can walk while everything is fine.',
  ],
  links: [
    { href: '/about', label: 'About the founder' },
    { href: REPO_URL, label: 'Source code', external: true },
    { href: 'mailto:support@mcpemails.com', label: 'support@mcpemails.com' },
  ],
  agentNote: 'the person and the company behind this service are named on /about, with the organisation number.',
};

export const pricing = {
  h2: 'Pricing',
  sub: 'Free connects one inbox, forever. Personal connects three. Pro connects up to 10 for one person running a business.',
  subSeat: 'Business is for a team, billed per person who connects a mailbox: everyone’s own mail stays private, and shared addresses are company-wide.',
  subFlat: 'Business includes 10 mailboxes, adds $3 a month for each extra, and has room for your whole team.',
  mostPopular: 'Most popular',
  perForever: 'forever',
  perMonth: 'a month',
  inclVat: 'incl. VAT',
  keys: { price: 'Price', who: 'For', includes: 'Includes', terms: 'Terms' },
  tiers: {
    free: {
      desc: 'Connect one inbox and give your agent a real mailbox.',
      features: ['1 connected inbox', 'Read, search, organise, draft, schedule and send', 'Send review and approval hold', 'Usage analytics', 'Gmail, Outlook, iCloud, Fastmail and any IMAP', 'Unlimited API keys', 'Help center and email support'],
      cta: 'Start free',
    },
    personal: {
      desc: 'Three mailboxes for one person or one small business: work, personal, or your first company addresses.',
      features: ['Everything in Free', '3 connected inboxes', '2x higher burst rate limit', 'Priority email support'],
      cta: 'Get Personal',
    },
    solo: {
      desc: 'For one person running a business: up to 10 mailboxes on one agent, from finance and sales to support and your own.',
      features: ['Everything in Personal', '10 connected inboxes', '5x higher burst rate limit', 'Longer analytics history', 'Follow-up reminders when nobody replies', 'Snooze: mail leaves the inbox and comes back when you choose', 'A daily morning brief, placed in your inbox', 'Search every connected inbox at once', 'Instructions for your AI, per inbox'],
      cta: 'Get Pro',
    },
    business: {
      desc: 'For a business with many mailboxes or several people: 10 mailboxes included, more at a fixed price each.',
      features: ['Everything in Pro', '10 mailboxes included, $3 a month for each extra', 'Unlimited members with roles, at no extra cost', 'Admins approve sends held for review', 'Several workspaces on one subscription, one per company or client'],
      cta: 'Get Business',
    },
  },
  foot: 'All plans: the mail your agent reads is fetched live and never stored, and credentials are encrypted at rest. Need something custom?',
  footContact: 'Write to hello@mcpemails.com',
  footCompare: 'See the full feature comparison',
  footBusiness: 'Running a company’s mailboxes?',
  footBusinessLink: 'See how one person connects them all',
  agentNote: 'plan names here are the names the dashboard and invoices use. The full comparison is at /pricing.',
};

export const faq = {
  h2: 'Questions, answered',
  intro: 'The questions people ask before connecting their first inbox, answered in full.',
  agentNote: 'these answers are the same text as this page’s FAQ structured data.',
};

export const start = {
  h2: 'Connect the first inbox today.',
  p: 'One inbox is free, forever, with no card. Add sales@ and invoices@ when you are ready, then bring the team.',
  ctaPrimary: 'Start free',
  ctaSecondary: 'Install in Claude or ChatGPT',
  signIn: 'Already have an account? Sign in',
  agentNote: 'that is the end of the page for people. Setup instructions for each client are at /docs/clients.',
};

export const footer = {
  tagline: 'A hosted email MCP server that gives AI agents read and send access to your inbox, without storing the mail it reads.',
  endpointLabel: 'MCP endpoint',
  supportLabel: 'Support',
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
        { href: '/changelog', label: 'Changelog' },
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
  languagesLabel: 'Language',
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
  legal: 'Email fetched live, never stored. Credentials encrypted at rest. Data stored in Stockholm.',
  entity: 'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
  colophon: 'Set in Familjen Grotesk, from a Stockholm foundry, and Literata.',
};
