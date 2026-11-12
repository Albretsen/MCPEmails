/**
 * English copy for Homepage Lab v02, "The Postal Manual". Staging only.
 *
 * Light markup, rendered by `Rich` in Home.jsx:
 *   ==text==   marker highlight (only the two promises: never stored, you approve)
 *   `text`     DM Mono, for addresses, URLs and tool names
 *   [text](href) a link
 *
 * Voice: postal and playful, plain facts. No em dashes, no tool count, no
 * action caps, plan names only through planDisplayName.
 */

export const MCP_URL = 'https://mcpemails.com/api/mcp';

export const nav = [
  { label: 'Contents', href: '#contents' },
  { label: 'How it works', href: '#how' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'Docs', href: '/docs' },
  { label: 'Blog', href: '/blog' },
];

export const hero = {
  kicker: 'The MCPEmails manual, first edition',
  h1Question: 'Which inbox do you use?',
  h1Answer: 'MCPEmails is the email MCP server and connector that hands it to Claude and ChatGPT.',
  lead:
    'Gmail, Outlook, iCloud, Fastmail or any IMAP mailbox, including the info@, sales@ and invoices@ addresses on your own company domain. Connect it once, paste one connector URL into Claude, ChatGPT, Cursor or any MCP client, and your AI reads, searches, drafts and sends from your real address. We carry the letter. We don’t keep a copy: mail is fetched live and ==never stored==.',
  pickerLegend: 'Pick your post office. The route in chapter 02 follows your choice.',
  ctaPrimary: 'Start free',
  ctaInstall: 'Install in Claude or ChatGPT',
  draftLink: 'See the draft card',
  meta: ['One inbox free, forever', 'No card required', 'Data stored in Stockholm'],
  figCaption:
    'Fig. 0. The real dashboard behind the connector: your connected inboxes, the connector URL and the tool calls your AI made.',
  figAltMobile:
    'MCPEmails dashboard overview on a phone: Inboxes connected 2 with 2 active inboxes, API keys 1, and a Connect inbox button.',
  figAlt:
    'MCPEmails dashboard, Recent activity panel: live MCP tool calls such as email_send, approval_decide, bulk_cancel and draft_create, each with the inbox it used and how long ago.',
};

/**
 * The picker. `route` replaces step 1 of chapter 02; `note` sits under the
 * picker in the hero. Connection methods match home.json and the dashboard.
 */
export const providers = [
  {
    id: 'imap',
    name: 'Your own domain',
    via: 'IMAP / SMTP',
    logo: 'logo-imap-mono.svg',
    logoW: 26,
    note: 'Any mailbox that speaks IMAP: your company domain, a hosting provider, a regional ISP. Reads over IMAP, sends through your own SMTP server.',
    route:
      'Choose IMAP / SMTP and enter the address, the IMAP and SMTP hosts and ports, and the mailbox password or an app password. Unsure of the settings? The [IMAP and SMTP settings lookup](/tools/email-settings-lookup) finds them for most hosts.',
    guide: { label: 'IMAP setup guide', href: '/connect/imap' },
    shot: { name: 'dashboard-connect-imap-light-desktop', alt: 'MCPEmails Connect IMAP / SMTP form with email address, IMAP and SMTP host and port, and password fields.' },
  },
  {
    id: 'gmail',
    name: 'Gmail',
    via: 'Google app password',
    logo: 'logo-gmail-mono.svg',
    logoW: 28,
    note: 'Gmail and Google Workspace connect with a Google app password over IMAP.',
    route:
      'Choose Gmail, press Get an app password, create one in your Google account and paste it next to your address. Gmail and Google Workspace both connect this way, over IMAP.',
    guide: { label: 'Gmail setup guide', href: '/connect/gmail' },
    shot: { name: 'dashboard-connect-gmail-light-desktop', alt: 'MCPEmails Connect Gmail form asking for an email address and a Google app password, with a Get an app password button.' },
  },
  {
    id: 'outlook',
    name: 'Outlook',
    via: 'Microsoft sign-in',
    logo: 'logo-outlook-mono.svg',
    logoW: 26,
    note: 'Outlook and Microsoft 365 connect by signing in with Microsoft. A work account may need its IT admin to approve the app once.',
    route:
      'Choose Outlook and press Connect with Microsoft. You sign in on Microsoft’s own page, so no password ever passes through us. A work or school account may need its IT admin to approve the app once.',
    guide: { label: 'Outlook setup guide', href: '/connect/outlook' },
    shot: { name: 'dashboard-connect-pick-outlook-light-desktop', w: 1088, h: 1530, alt: 'MCPEmails Connect an inbox dialog with Outlook selected and the Connect with Microsoft button, explaining the Microsoft consent screen.' },
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    via: 'App-specific password',
    logo: 'logo-icloud-mono.svg',
    logoW: 30,
    note: 'iCloud Mail connects with an app-specific password from your Apple Account.',
    route:
      'Create an app-specific password in your Apple Account settings, then enter your iCloud Mail address (the one ending in icloud.com or me.com) with that password.',
    guide: { label: 'iCloud setup guide', href: '/connect/icloud' },
    shot: { name: 'dashboard-connect-icloud-light-desktop', alt: 'MCPEmails Connect iCloud Mail form asking for an email address and an app-specific password.' },
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    via: 'App password',
    logo: 'logo-fastmail-mono.svg',
    logoW: 26,
    note: 'Fastmail connects with an app password.',
    route:
      'Create an app password in Fastmail’s settings and paste it with your address. That is the whole route for Fastmail: an app password, nothing else to set up.',
    guide: { label: 'Fastmail setup guide', href: '/connect/fastmail' },
    shot: { name: 'dashboard-connect-fastmail-light-desktop', alt: 'MCPEmails Connect Fastmail form asking for an email address and a Fastmail app password.' },
  },
  {
    id: 'other',
    name: 'Yahoo, Zoho, Yandex',
    via: 'App password',
    logo: null,
    note: 'Yahoo, Zoho and Yandex connect with an app-specific password. GMX, WEB.DE and the rest go through IMAP / SMTP.',
    route:
      'Choose your provider’s tile and paste an app-specific password from its security settings. GMX, WEB.DE and any host without its own tile connect through IMAP / SMTP.',
    guide: { label: 'Every provider guide', href: '/connect' },
    shot: { name: 'dashboard-connect-providers-light-desktop', alt: 'MCPEmails Connect an inbox dialog with provider tiles for IMAP / SMTP, Gmail, iCloud Mail, Yahoo Mail, Zoho Mail, Yandex Mail, Fastmail and Outlook.' },
  },
];

export const contents = {
  label: 'Contents',
  intro:
    'This page is a manual. Every line below opens into its chapter right where it sits, and closes again when you are done. Read it in order, or skip to the part you came for.',
  openAll: 'Open every chapter',
  closeAll: 'Close them all',
};

export const ch1 = {
  id: 'draft-card',
  num: '01',
  title: 'The answer card',
  dek: 'What you see in the chat when your AI writes a letter.',
  p1:
    'Ask Claude or ChatGPT to reply to a customer and the answer comes back as a card in the chat: the real draft, already saved to the Drafts folder of the inbox it came from. You read it, fix the To line or a sentence, and press Send. Nothing about it is a mock-up of an email; it is the email.',
  p2:
    'Some letters should wait for a second look. Turn on approval for an inbox and every send from it is held: the card says Approve in browser, and the letter only leaves once ==you approve== it on mcpemails.com, signed in as yourself. No agent, including the one that wrote it, can approve a send.',
  figMain:
    'Fig. 1.1. The draft card as it appears in the chat, with editable To, Subject and body, and the Save and Send buttons.',
  calloutsTitle: 'The three controls that matter, at 200%',
  callouts: [
    {
      n: 1,
      label: 'The To line',
      text: 'Who the letter goes to. Check it, remove a chip, add Cc or Bcc, all inside the card.',
      crop: { name: 'card-draft-light-desktop', W: 1364, H: 776, x: 16, y: 124, w: 660, h: 134 },
      alt: 'Close-up of the draft card To field with the recipient jordan@example.com and the subject line below it.',
    },
    {
      n: 2,
      label: 'Approve in browser',
      text: 'A held send waits for this button. It opens mcpemails.com, where you approve or reject it yourself.',
      crop: { name: 'card-approval-light-desktop', W: 1364, H: 484, x: 880, y: 388, w: 474, h: 84 },
      alt: 'Close-up of the approval card buttons: Reject and Approve in browser.',
    },
    {
      n: 3,
      label: 'The inbox picker',
      text: 'Where you choose the post office: IMAP / SMTP, Gmail, iCloud Mail and the rest, each with how it connects.',
      crop: { name: 'dashboard-connect-providers-light-desktop', W: 1280, H: 1800, x: 222, y: 450, w: 836, h: 222 },
      alt: 'Close-up of the Connect an inbox dialog: provider tiles for IMAP / SMTP (any mailbox, recommended), Gmail and iCloud Mail, each marked App password.',
    },
  ],
  receipt:
    'Fig. 1.2. After an approved send, the card becomes a receipt: approved in the browser, sent over SMTP, copied to Sent.',
  receiptAlt: 'MCPEmails receipt card: Sent to billing@supplier.example, approved in the browser, sent over SMTP and copied to Sent.',
};

export const ch2 = {
  id: 'how',
  num: '02',
  title: 'How it got there',
  dek: 'The route a letter takes, from your question to your outbox.',
  p1:
    'An email MCP server is the post office between an AI assistant and a real mailbox. It speaks the Model Context Protocol, so Claude, ChatGPT, Cursor, VS Code or any other MCP client can read, search, draft and send email through one endpoint, with no separate integration for each app. MCPEmails is a hosted one: when your AI asks for mail, we fetch it from your provider on that call, hand it over, and forget it.',
  figFlow:
    'Fig. 2.1. One request: your chat app asks MCPEmails over MCP, MCPEmails fetches your inbox live, and the draft comes back to the chat for you to send.',
  routeTitle: 'Your route, in three stops',
  routeFor: 'Showing the route for',
  steps: [
    { h: 'Connect your inbox', p: null },
    {
      h: 'Paste the connector URL',
      p: 'Add a custom connector in Claude or ChatGPT and paste `https://mcpemails.com/api/mcp`. Clients that support OAuth (claude.ai, Claude Desktop, ChatGPT, Cursor and others) ask you to sign in and approve, with no API key. For clients without OAuth, such as Cline, JetBrains or your own scripts, create a scoped API key in the dashboard. Per-client steps are in [MCP client setup](/docs/clients).',
    },
    {
      h: 'Ask for what you want',
      p: 'Your AI calls tools like `email_read` and `email_compose`. MCPEmails fetches live from your provider, returns the result and keeps nothing between calls. Sending goes out through your own provider, from your own address.',
    },
  ],
  officesTitle: 'Every post office we deliver to',
  offices:
    'Gmail and Google Workspace with a Google app password over IMAP. Outlook and Microsoft 365 by signing in with Microsoft. iCloud Mail, Fastmail, Yahoo, Zoho and Yandex with an app-specific password. Everything else, from GMX and WEB.DE to the mail server your web host runs, over a generic IMAP and SMTP connection. Connect as many as your plan holds, label them by use, and one agent works all of them.',
  logoAlt:
    'Supported email providers: Gmail, Outlook / Microsoft 365, iCloud Mail, Fastmail, Yahoo Mail, Zoho Mail, Yandex Mail, GMX, WEB.DE and any IMAP inbox, each with how it connects.',
  officeLinks: [
    { label: 'All providers', href: '/connect' },
    { label: 'IMAP', href: '/connect/imap' },
    { label: 'Gmail', href: '/connect/gmail' },
    { label: 'Outlook', href: '/connect/outlook' },
    { label: 'Fastmail', href: '/connect/fastmail' },
    { label: 'iCloud', href: '/connect/icloud' },
    { label: 'Yahoo', href: '/connect/yahoo' },
    { label: 'Zoho', href: '/connect/zoho' },
    { label: 'Yandex', href: '/connect/yandex' },
    { label: 'Provider support notes', href: '/docs/providers' },
  ],
  teamTitle: 'A company’s whole mailroom',
  team:
    'Most of the people who pay us run a business on its own domain. One person handling `info@`, `sales@` and `invoices@` connects all three to one agent and asks across them: which enquiries from this week has nobody answered, which invoices came in since Friday. When colleagues need their own login, Business gives each person their own private mailboxes and makes the shared addresses company-wide.',
  teamLink: { label: 'Email MCP for company mailboxes', href: '/for/business' },
  foundersLink: { label: 'For founders', href: '/for/founders' },
};

export const ch3 = {
  id: 'features',
  num: '03',
  title: 'What it can do',
  dek: 'The everyday work of a mailroom, done by the AI you already use.',
  p1:
    'Ask in plain words. Your AI picks the right tool, works in the right inbox and finishes the job inside your mailbox, instead of handing you text to paste somewhere.',
  abilities: [
    { h: 'Read and search', p: 'List recent mail, open a full message, search across providers, read attachment text, save the original as `.eml`.' },
    { h: 'Write and send', p: 'Send a new message, reply in the thread, forward, all from your own address through your own provider.' },
    { h: 'Drafts', p: 'Create, update and send drafts stored in your mailbox, so they show up in your normal mail app too.' },
    { h: 'Sort the post', p: 'Move, copy, flag, archive and delete, one at a time, in bulk, or straight from a search.' },
    { h: 'Folders and labels', p: 'Create, rename and remove folders (labels on Gmail) and file mail into them.' },
    { h: 'Schedule', p: 'Send at 8:00 on Monday, not now, and cancel any time before it goes.' },
    { h: 'People', p: 'Find a contact by name or address with a live scan of recent mail. Nothing is kept.' },
    { h: 'Signatures and automations', p: 'Set a signature per inbox, and on Pro run follow-up reminders, snooze and a daily morning brief that keep going after the chat is closed.' },
  ],
  promptsTitle: 'Things people ask',
  prompts: [
    'Go through sales@ and info@ and list every enquiry from this week nobody has answered.',
    'Forward this month’s invoices from invoices@ to our accountant.',
    'Move every receipt from this month into a Receipts folder.',
    'Send this at 8am Monday, not now.',
    'What did the doctor’s office say about my appointment?',
  ],
  gridTitle: 'Plates',
  tiles: {
    approvals: {
      crop: { name: 'dashboard-approvals-light-desktop', W: 2880, H: 1800, x: 540, y: 170, w: 2290, h: 590 },
      alt: 'MCPEmails Approvals page with two emails prepared by an AI assistant waiting for review, each with Reject and Review and approve buttons and the time left.',
      cap: 'The approvals queue: every held send, who it goes to and how long it waits.',
    },
    modal: {
      crop: { name: 'dashboard-approve-modal-light-desktop', W: 2880, H: 1800, x: 930, y: 330, w: 1010, h: 1470 },
      alt: 'MCPEmails Approve email send dialog showing the request, inbox, recipients, subject and time left, with Cancel and Approve and send buttons.',
      cap: 'The last check before a held letter leaves: inbox, recipients, subject.',
    },
    inboxes: {
      crop: { name: 'dashboard-inboxes-light-desktop', W: 2880, H: 1800, x: 540, y: 170, w: 1500, h: 580 },
      alt: 'MCPEmails Inboxes page listing two connected IMAP inboxes with a Connected status and call counts.',
      cap: 'Several mailboxes, one agent. Each inbox shows its provider and its status.',
    },
    clip: {
      name: 'card-draft-send-light-desktop',
      W: 1428,
      H: 840,
      alt: 'Screen recording: an MCPEmails draft card in a chat, Send is clicked, a five-second Undo countdown runs and the card becomes a Sent to jordan@example.com receipt.',
      cap: 'Send, then five seconds to change your mind with Undo.',
    },
    sent: {
      name: 'card-draft-sent-light-desktop',
      W: 1364,
      H: 462,
      alt: 'MCPEmails card after sending a draft: Sent to jordan@example.com with the subject, the start of the message and a Show full message link.',
      cap: 'The receipt. A copy sits in your Sent folder, where it belongs.',
    },
  },
  clientsTitle: 'Which counters it works at',
  clients:
    'Any MCP client: Claude, ChatGPT, Cursor, VS Code, Windsurf, n8n, Make, LibreChat, OpenWebUI and more. MCPEmails is a standard streamable-http MCP server with OAuth 2.1, dynamic client registration and PKCE, so the same inbox follows you from one app to the next.',
  devLinks: [
    { label: 'Tool reference', href: '/docs#tools' },
    { label: 'Quickstart', href: '/docs#quickstart' },
    { label: 'OAuth connection', href: '/docs#oauth' },
    { label: 'Developer guide', href: '/docs/api' },
    { label: 'Developers', href: '/developers' },
  ],
};

export const ch4 = {
  id: 'security',
  num: '04',
  title: 'What it won’t do',
  dek: 'The rules of the post office, written down.',
  p1:
    'We carry the letter. We don’t keep a copy. Every promise below is how the code works today, not a policy we hope to grow into.',
  rules: [
    {
      h: 'It won’t keep your mail',
      p: 'Every tool call reaches your provider in real time: the Gmail inbox over IMAP, Microsoft Graph for Outlook, IMAP for the rest. Bodies, subjects and attachments go to your AI and are dropped. Your mail is ==never stored==. The one exception is a letter that has to wait: a scheduled send, or one held for approval, is stored encrypted until it goes.',
      icon: 'icon-fetched-live.svg',
    },
    {
      h: 'It won’t send behind your back',
      p: 'Turn on approval for an inbox and every send, reply, forward, draft send and scheduled send is held until ==you approve== it in the dashboard. No agent can approve on your behalf, and admins on Business can be the ones who sign off.',
      icon: 'icon-approve-before-send.svg',
    },
    {
      h: 'It won’t leave the EU',
      p: 'What we do store, the encrypted credentials and the held or scheduled sends, sits in an EU database in Stockholm.',
      icon: 'icon-data-location.svg',
    },
    {
      h: 'It won’t keep passwords readable',
      p: 'OAuth tokens and app passwords are encrypted with AES-256-GCM before they reach the database, and decrypted only for the request that needs them. The key lives apart from the database.',
      icon: 'icon-encrypted-credentials.svg',
    },
    {
      h: 'It won’t hold on to an agent you are done with',
      p: 'Every connected client and API key can be revoked from the dashboard in one click. Need less than full access? Give an agent [read-only access](/docs/read-only-access).',
      icon: 'icon-revoke-access.svg',
    },
    {
      h: 'It won’t lock you in',
      p: 'Standard MCP, no proprietary client. MCPEmails is open source under AGPL-3.0, and you can [self-host](/self-hosting) the same server against your own database.',
      icon: 'icon-several-inboxes.svg',
    },
  ],
  figStored:
    'Fig. 4.1. What is stored and where: encrypted credentials and waiting sends in Stockholm. The mail you read is fetched live and not stored.',
  links: [
    { label: 'Security', href: '/security' },
    { label: 'Privacy', href: '/privacy' },
    { label: 'Data processing agreement', href: '/dpa' },
  ],
};

export const ch5 = {
  id: 'pricing',
  num: '05',
  title: 'Pricing',
  dek: 'Priced by mailbox. Business is priced by person.',
  p1:
    'Free connects one inbox for good. Personal connects three. Pro connects up to 10 for one person running a business. Business is for a team, billed for each person who connects a mailbox: everyone’s own mail stays private, and the shared addresses are company-wide.',
  perForever: '/forever',
  perMonth: '/month',
  inclVat: 'incl. VAT',
  popular: 'Most popular',
  tiers: {
    free: {
      desc: 'One inbox, forever, no card. Give your AI a real mailbox and see what it does with it.',
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
      desc: 'Three mailboxes for one person: work, personal, or your first company addresses.',
      features: ['Everything in Free', '3 connected inboxes', '2x higher burst rate limit', 'Priority email support'],
      cta: 'Get Personal',
    },
    solo: {
      desc: 'One person running a business: up to 10 mailboxes on one agent, from finance and sales to support.',
      features: [
        'Everything in Personal',
        '10 connected inboxes',
        'Follow-up reminders when nobody replies',
        'Snooze and a daily morning brief',
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
        'Members with roles',
        'Admins approve sends held for review',
      ],
      cta: 'Get Business',
    },
  },
  footnote:
    'Every plan: the mail your AI reads is fetched live and never stored, and credentials are encrypted at rest. Something custom? [Write to us](mailto:hello@mcpemails.com). [Compare every plan](/pricing).',
  businessLink: 'Running a company’s mailboxes? [See how a team shares them](/for/business).',
};

export const ch6 = {
  id: 'start',
  num: '06',
  title: 'Start free',
  dek: 'Post your first letter in a couple of minutes.',
  p1:
    'Create a free account, connect one mailbox and paste the connector URL into your AI. No card. If it is not for you, disconnect the inbox and revoke the client in one click each.',
  endpointLabel: 'Connector URL',
  install: [
    { label: 'Connect Claude to your email', href: '/blog/connect-claude-to-email' },
    { label: 'Connect ChatGPT to your email', href: '/blog/connect-chatgpt-to-email' },
    { label: 'Claude IMAP connector guide', href: '/blog/claude-imap-connector' },
    { label: 'Native connectors or MCP?', href: '/native-connectors-vs-mcp' },
  ],
  signIn: 'Already have an account?',
  signInLink: 'Sign in',
};

export const appA = {
  id: 'reviews',
  num: 'A',
  title: 'Letters from readers',
  dek: 'A review and the public directories that list us.',
  reviewIntro: 'A review published under the reviewer’s own name, quoted exactly as written.',
  reviewSource: 'Read it on Google',
  dirTitle: 'Listed in public MCP directories',
  dirIntro: 'Third parties list MCPEmails. Open the listings and check for yourself.',
  directories: [
    { name: 'Official MCP Registry', what: 'The Model Context Protocol’s own server registry', href: 'https://registry.modelcontextprotocol.io/v0/servers?search=com.mcpemails/emails' },
    { name: 'Glama', what: 'MCP server directory with automated checks', href: 'https://glama.ai/mcp/servers/Albretsen/MCPEmails' },
    { name: 'mcp.so', what: 'Community MCP server directory', href: 'https://mcp.so/servers/mcpemails' },
    { name: 'mcpservers.org', what: 'Awesome MCP Servers list', href: 'https://mcpservers.org/servers/mcpemails-com' },
  ],
  compare: { label: 'How the email MCP servers compare', href: '/best-email-mcp-servers' },
};

export const appB = {
  id: 'faq',
  num: 'B',
  title: 'Questions, answered',
  dek: 'What people ask before they connect their first inbox.',
};

export const footer = {
  tagline: 'A hosted email MCP server that gives AI agents read and send access to your inbox, without ever storing the email it reads.',
  columns: [
    {
      h: 'Product',
      links: [
        { label: 'Features', href: '/#features' },
        { label: 'How it works', href: '/#how' },
        { label: 'Pricing', href: '/pricing' },
        { label: 'Docs', href: '/docs' },
        { label: 'Self-hosting', href: '/self-hosting' },
        { label: 'For founders', href: '/for/founders' },
        { label: 'For business', href: '/for/business' },
        { label: 'Developers', href: '/developers' },
        { label: 'Get started free', href: '/signup' },
      ],
    },
    {
      h: 'Resources',
      links: [
        { label: 'Tool reference', href: '/docs#tools' },
        { label: 'Quickstart', href: '/docs#quickstart' },
        { label: 'OAuth connection', href: '/docs#oauth' },
        { label: 'Provider support', href: '/docs/providers' },
        { label: 'Read-only access', href: '/docs/read-only-access' },
        { label: 'Developer guide', href: '/docs/api' },
        { label: 'MCP client setup', href: '/docs/clients' },
        { label: 'IMAP and SMTP settings lookup', href: '/tools/email-settings-lookup' },
        { label: 'Blog', href: '/blog' },
        { label: 'Changelog', href: '/changelog' },
      ],
    },
    {
      h: 'Connect',
      links: [
        { label: 'All providers', href: '/connect' },
        { label: 'IMAP', href: '/connect/imap' },
        { label: 'Gmail', href: '/connect/gmail' },
        { label: 'Outlook', href: '/connect/outlook' },
        { label: 'Fastmail', href: '/connect/fastmail' },
        { label: 'iCloud', href: '/connect/icloud' },
        { label: 'Yahoo', href: '/connect/yahoo' },
        { label: 'Zoho', href: '/connect/zoho' },
        { label: 'Yandex', href: '/connect/yandex' },
        { label: 'Native connectors vs MCP', href: '/native-connectors-vs-mcp' },
        { label: 'Best email MCP servers', href: '/best-email-mcp-servers' },
      ],
    },
    {
      h: 'Company',
      links: [
        { label: 'About', href: '/about' },
        { label: 'Security', href: '/security' },
        { label: 'Status', href: '/status' },
        { label: 'Help and support', href: '/help' },
        { label: 'Privacy', href: '/privacy' },
        { label: 'Terms', href: '/terms' },
        { label: 'DPA', href: '/dpa' },
        { label: 'Withdraw from contract here', href: '/cancel?type=withdraw' },
        { label: 'Cancel contracts here', href: '/cancel' },
        { label: 'Impressum', href: '/terms#agreement' },
      ],
    },
  ],
  contact: 'support@mcpemails.com',
  sales: 'hello@mcpemails.com',
  languages: [
    { code: 'en', label: 'English', href: '/' },
    { code: 'nb', label: 'Norsk', href: '/nb' },
    { code: 'es', label: 'Español', href: '/es' },
    { code: 'fr', label: 'Français', href: '/fr' },
    { code: 'de', label: 'Deutsch', href: '/de' },
    { code: 'pt-BR', label: 'Português (Brasil)', href: '/pt' },
    { code: 'ja', label: '日本語', href: '/ja' },
    { code: 'zh', label: '中文', href: '/zh' },
  ],
  copyright: '© 2026 MCPEmails.',
  legal: 'Email fetched live, never stored. Credentials encrypted at rest. Data stored in Stockholm.',
  legalEntity: 'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
};
