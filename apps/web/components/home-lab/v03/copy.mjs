/**
 * All English copy for Homepage Lab variant v03 ("The Letter").
 * Staging only. Facts follow messages/en/home.json, the changelog and the docs;
 * the wording is new, in the brief's modest and concrete voice.
 * Prices, plan names, Business per person and the FAQ are not written here:
 * they come from Stripe, plans.ts, business-seat-copy and `faqItems`.
 */

export const MCP_URL = 'https://mcpemails.com/api/mcp';

export const letterhead = {
  homeLabel: 'MCPEmails home',
  address: ['Albretsen AS, Bergen, Norway', 'Data stored in Stockholm, Sweden'],
  contact: 'support@mcpemails.com',
  navLabel: 'Primary navigation',
  nav: [
    { href: '/#how', label: 'How it works' },
    { href: '/#pricing', label: 'Pricing' },
    { href: '/docs', label: 'Docs' },
    { href: '/blog', label: 'Blog' },
    { href: '/changelog', label: 'Changelog' },
    { href: '/login', label: 'Sign in' },
  ],
  cta: 'Start free',
};

export const hero = {
  place: 'Bergen',
  re: 'Re: MCPEmails, a hosted email MCP server',
  poster: "Your company's mail in Claude and ChatGPT. You say when it goes out.",
  salutation: 'Dear reader,',
  lead:
    'MCPEmails is an email MCP server: one connector that puts info@, sales@, invoices@ or just your own Gmail, Outlook, iCloud, Fastmail or any IMAP inbox inside Claude, ChatGPT and every other MCP client. Your assistant reads, searches, files and drafts live from your provider. The mail it reads is never stored, and a draft comes back to you as a card in the chat that you send yourself.',
  body: [
    'This is a letter rather than a brochure, because we are a small company and email is what we know. Below is an ordinary day with the product on two tracks, one for a team that runs shared addresses on its own domain and one for a single person with their own mailbox. Each chapter carries the date we last shipped something for it, read from our public changelog.',
  ],
  ctaPrimary: 'Start free',
  ctaSecondary: 'Install in Claude or ChatGPT',
  ctaNote: 'One inbox free, for good. No card.',
  clip: {
    caption:
      'The real draft card from the chat, at actual size: the To line, Subject and body stay editable, then Save or Send, with a few seconds to undo.',
    play: 'Play the clip',
    playLong: 'Play the clip: a draft is sent from the chat and turns into a receipt',
    alt: 'MCPEmails draft card in a chat: a reply to jordan@example.com saved to Drafts by the assistant, with editable To, Subject and body, and Save and Send buttons.',
    videoLabel:
      'Screen recording: an MCPEmails draft card in a chat, Send is clicked, a five-second Undo countdown runs and the card becomes a Sent receipt.',
  },
};

export const whatIs = {
  h: 'What is an email MCP server?',
  p: [
    'MCP, the Model Context Protocol, is how an AI assistant reaches tools outside the chat. An email MCP server is the tool for mail: Claude, ChatGPT, Cursor, VS Code or any other MCP client calls it to list, read, search, draft, send and organise messages in a real mailbox, through one endpoint and without a separate integration per app.',
    'MCPEmails is a hosted one. It works with Gmail and Google Workspace, Outlook and Microsoft 365, iCloud, Fastmail, Yahoo, Zoho, Yandex and any mailbox that speaks IMAP, and one assistant can work several mailboxes in the same conversation.',
  ],
  links: [
    { href: '/connect/imap', label: 'Set up the IMAP MCP server' },
    { href: '/for/business', label: 'Email MCP for company mailboxes' },
    { href: '/blog/connect-claude-to-email', label: 'How to connect Claude to your email' },
    { href: '/blog/connect-chatgpt-to-email', label: 'How to connect ChatGPT to your email' },
    { href: '/blog/claude-imap-connector', label: 'Claude IMAP connector guide' },
    { href: '/native-connectors-vs-mcp', label: 'Native connectors or MCP?' },
  ],
};

export const tracks = {
  team: 'For your team (info@, sales@)',
  you: 'For you',
};

/** Chapter 1: how it works, told as one day. */
export const day = {
  kicker: 'Chapter one',
  h: 'How it works: one day with MCPEmails',
  intro:
    'Three steps, done once: connect a mailbox, paste one URL into your AI client, then ask. After that it is just a working day.',
  steps: [
    { n: '1', h: 'Connect a mailbox', p: 'Sign in and choose Connect Inbox. Microsoft sign-in for Outlook and Microsoft 365; an app password for Gmail, iCloud, Fastmail, Yahoo, Zoho, Yandex and any IMAP host.' },
    { n: '2', h: 'Paste the URL', p: 'Add a custom connector in Claude or ChatGPT with the address below and approve the sign-in. OAuth clients need no API key; scripts and clients without OAuth get a scoped key.' },
    { n: '3', h: 'Ask', p: 'Your assistant calls tools such as email_read and email_compose. MCPEmails fetches live from your provider and returns the result. Nothing is cached between calls.' },
  ],
  urlLabel: 'MCP endpoint',
  times: [
    {
      time: '08:00',
      label: 'Morning',
      team: {
        h: 'The shared inboxes, before the first coffee',
        p: [
          '"Go through sales@ and info@ and list every enquiry from this week nobody has answered." The assistant reads both mailboxes live from your mail server and gives you the list, oldest first, with who wrote and what they asked.',
          'An admin connected those addresses once, in the dashboard, with the same credentials your mail client uses. Nobody on the team copies an inbox ID or a password into a chat.',
        ],
      },
      you: {
        h: 'Your own inbox, without opening it',
        p: [
          '"What did the doctor\'s office say about my appointment?" One question, one answer, read from the message itself rather than from a copy somewhere.',
          'On Pro, a daily morning brief is placed straight in your own inbox, so it is waiting for you even when no chat is open.',
        ],
      },
    },
    {
      time: '12:30',
      label: 'Noon',
      team: {
        h: 'Invoices go to the accountant',
        p: [
          '"Forward this month\'s invoices from invoices@ to our accountant." The forward goes out through your own provider, from your own address, with the PDFs attached, and a copy sits in your Sent folder like any other mail.',
          'When an inbox has review turned on, the send is held instead. It shows up in the chat with an Approve in browser button and on the dashboard Approvals page, and nothing leaves until a person says yes.',
        ],
      },
      you: {
        h: 'A reply you can still change',
        p: [
          'Ask for a reply and it comes back as the draft card shown above: the recipients, subject and text are editable in the chat, it is saved to your real Drafts folder, and Send gives you a few seconds to undo.',
          'Replies follow the Reply-To address when the sender set one, and after sending the card turns into a receipt with the address it went from and whether a copy is in Sent.',
        ],
      },
    },
    {
      time: '18:00',
      label: 'Evening',
      team: {
        h: 'Monday morning, scheduled tonight',
        p: [
          '"Send this at 8am Monday, not now." The message is queued and nothing goes out before then; schedule_list shows what is waiting and you can cancel it until it leaves.',
          'Follow-up reminders flag mail you sent that nobody answered, and snooze takes a thread out of the inbox until the day you choose. Both keep running after the chat is closed.',
        ],
      },
      you: {
        h: 'The inbox tidied while you cook',
        p: [
          '"Move every receipt from this month into a Receipts folder." "Archive the newsletters I have not opened since spring." Moves, copies, flags and deletes work one at a time, in bulk or straight from a search.',
          'If a bulk move went wider than you meant, Claude shows a card with what changed and an Undo button. On mailboxes connected over IMAP, undo works for 24 hours.',
        ],
      },
    },
  ],
};

/** Chapter 2: approval, then what we keep. */
export const approval = {
  kicker: 'Chapter two',
  h: 'Nothing goes out without your yes',
  intro:
    'Sending is the part people worry about, so it has the most settings. Pick, per mailbox, how much review you want before your assistant sends.',
  team: {
    h: 'Approval in your own browser',
    p: [
      'Turn on review for a shared mailbox and every send, reply, forward, draft send and scheduled send is held. The card in the chat says it plainly: approval happens on mcpemails.com in your own browser, and no agent, including the one that wrote the email, can approve a send.',
      'On Business, admins approve what is held, and recipient rules hold any mail to someone outside the domains you allow.',
    ],
    img: {
      alt: 'MCPEmails approval card in a chat: a reply to billing@supplier.example waiting for approval, with Reject and Approve in browser buttons.',
      caption: 'The approval card as it appears in the chat, waiting for a person.',
    },
  },
  you: {
    h: 'Ask in the chat first',
    p: [
      'For your own mailbox the lighter setting is often enough. With Ask in the chat first, your assistant shows you the email in the conversation and waits for your yes before it sends.',
      'Either way, after a send you get a receipt in the chat with the sending address, recipients, subject and attachments, so you can see what went out without leaving the conversation.',
    ],
    img: {
      alt: 'MCPEmails card after sending a draft: Sent to jordan@example.com with the subject, the start of the message and a Show full message link.',
      caption: 'The receipt the draft card turns into after Send.',
    },
  },
};

export const security = {
  kicker: 'Chapter three',
  h: 'What we keep, and where: Stockholm',
  intro:
    'A small company, a real inbox for support, and nothing of yours on our disks that we do not need to make the next call.',
  diagram: {
    alt: 'MCPEmails stores only encrypted credentials and scheduled or held sends, in an EU database in Stockholm; the mail you read is fetched live and not stored.',
    caption:
      'Kept, encrypted, in Stockholm: the credentials for each inbox, and sends that are waiting for a time or for your approval. Not kept: the mail your assistant reads.',
  },
  team: {
    h: 'For whoever signs off on vendors',
    p: [
      'OAuth tokens and app passwords are encrypted with AES-256-GCM before they are written to the database, and decrypted on our servers only for the request that needs them. The key is an environment secret kept apart from the database.',
      'Our database is in the EU, in Stockholm. A data processing agreement is available, and on Business there is an audit log with CSV export.',
    ],
    links: [
      { href: '/security', label: 'Security overview' },
      { href: '/dpa', label: 'Data processing agreement' },
      { href: '/privacy', label: 'Privacy policy' },
    ],
  },
  you: {
    h: 'For you and your one inbox',
    p: [
      'Every tool call goes to your provider in real time: the Gmail or Microsoft side, or plain IMAP. Bodies, subjects and attachments pass through to your assistant and are discarded. The site uses cookieless analytics and never collects email content, addresses, keys or tokens.',
      'MCPEmails is standard MCP with OAuth 2.1, so you can revoke any client from the dashboard in one click. The code is open source under AGPL-3.0 if you would rather run it yourself.',
    ],
    links: [
      { href: '/docs/read-only-access', label: 'Read-only access' },
      { href: '/self-hosting', label: 'Self-hosting' },
      { href: '/docs#oauth', label: 'How the OAuth connection works' },
    ],
  },
};

/** Chapter 4: teams on their own domain, and the providers. */
export const teams = {
  kicker: 'Chapter four',
  h: 'Teams on their own domain',
  intro:
    'A company mostly lives in a few shared addresses on its own domain, with a handful of people behind them. MCPEmails is built for that case first, and a single inbox is the simple version of it.',
  team: {
    h: 'One workspace for the company',
    p: [
      'Connect each shared address once and the whole team reaches all of them through the same connector. An assistant can list the mailboxes, pick the right one for each request, and move between support@ and a personal address in one conversation.',
      'Everyone gets a role, viewer, member or admin, and several workspaces can sit on one subscription, one per company or client.',
    ],
    seat:
      'Business is billed per person who connects a mailbox. Each person keeps their own mailboxes private, the shared addresses belong to the company, and anyone without a mailbox of their own is free, whatever their role.',
  },
  you: {
    h: 'One person, several addresses',
    p: [
      'Plenty of people run a business alone: an address for sales, one for invoices, one that is just theirs. Personal connects three mailboxes and Pro up to ten, all on one assistant.',
      'Pro also searches every connected inbox at once and lets you give your assistant instructions per inbox, so it answers sales@ in one voice and your own mail in another.',
    ],
    img: {
      alt: 'MCPEmails Connect an inbox dialog with provider tiles for IMAP / SMTP, Gmail, iCloud Mail, Yahoo Mail, Zoho Mail, Yandex Mail, Fastmail and Outlook.',
      caption: 'Adding a mailbox in the dashboard: pick the provider, then sign in or paste an app password.',
    },
  },
  review: {
    h: 'From a customer',
    via: 'Review on Google',
  },
  providers: {
    h: 'Which mailboxes connect',
    p:
      'Gmail and Google Workspace connect with a Google app password over IMAP. Outlook and Microsoft 365 use Microsoft sign-in; a work or school account may need its IT admin to approve the app once. Fastmail, iCloud, Yahoo, Zoho and Yandex use an app-specific password, and everything else, including your own domain at a web host, uses the generic IMAP and SMTP connection. Every message you send goes out through your own provider, from your own address.',
    wallAlt:
      'Supported email providers: Gmail, Outlook / Microsoft 365, iCloud Mail, Fastmail, Yahoo Mail, Zoho Mail, Yandex Mail, GMX, WEB.DE and any IMAP server.',
    links: [
      { href: '/connect/gmail', label: 'Gmail' },
      { href: '/connect/outlook', label: 'Outlook and Microsoft 365' },
      { href: '/connect/icloud', label: 'iCloud Mail' },
      { href: '/connect/fastmail', label: 'Fastmail' },
      { href: '/connect/yahoo', label: 'Yahoo Mail' },
      { href: '/connect/zoho', label: 'Zoho Mail' },
      { href: '/connect/yandex', label: 'Yandex Mail' },
      { href: '/connect/imap', label: 'Any IMAP mailbox' },
    ],
    more: [
      { href: '/docs/providers', label: 'Provider support in the docs' },
      { href: '/tools/email-settings-lookup', label: 'Look up IMAP and SMTP settings' },
      { href: '/connect', label: 'All connect guides' },
    ],
  },
};

export const pricing = {
  kicker: 'Both tracks end here',
  h: 'Pricing: by inbox, with no metering on paid plans',
  sub:
    'Free connects one inbox. Personal connects three. Pro connects up to ten for one person running a business. Business is for a team, billed per person who connects a mailbox: everyone\'s own mail stays private, and shared addresses are company-wide.',
  subFlat:
    'Free connects one inbox. Personal connects three. Pro connects up to ten for one person running a business. Business includes ten mailboxes, adds $3 a month for each extra, and has room for your whole team.',
  perForever: '/forever',
  perMonth: '/month',
  vat: 'incl. VAT',
  desc: {
    free: 'One inbox, for good, with everything your assistant needs to work it.',
    personal: 'Three mailboxes for one person or a very small business.',
    solo: 'Up to ten mailboxes for one person running a business.',
    business: 'For a business with many mailboxes or several people.',
  },
  cta: { free: 'Start free', personal: 'Get Personal', solo: 'Get Pro', business: 'Get Business' },
  tracks: { free: 'For you', personal: 'For you', solo: 'For you, with a business', business: 'For your team' },
  footnote:
    'Every plan: the mail your assistant reads is fetched live and never stored, credentials are encrypted at rest, and data is stored in Stockholm.',
  compare: 'Compare every plan in full',
  business: 'Running a company\'s mailboxes? See how they connect',
  contact: 'Need something custom? Write to hello@mcpemails.com',
};

export const faq = {
  kicker: 'Chapter five',
  h: 'Questions people ask before they connect',
  intro: 'The same answers we give by email, in one place.',
  more: 'Still unsure? The help center has longer answers, and support@mcpemails.com answers by email.',
};

export const changelog = {
  kicker: 'Chapter six',
  h: 'Recently shipped',
  intro:
    'The newest entries from the public changelog, as they were published. The product changes most weeks; this is the proof that it does.',
  all: 'Read the full changelog',
  kinds: { added: 'Added', improved: 'Improved', fixed: 'Fixed', changed: 'Changed' },
  shipped: 'Last shipped for this',
};

export const closing = {
  signoff: 'Yours,',
  name: 'Asgeir Albretsen',
  role: 'Builds MCPEmails, Bergen, Norway',
  about: 'More about who runs MCPEmails',
  ps: 'P.S.',
  psText:
    'Start free. One inbox, no card and no end date, with reading, searching, drafting, sending and approval all included. If it is not for you, disconnect and delete the account from the dashboard.',
  psCta: 'Start free',
  psSecondary: 'Or install it in Claude or ChatGPT first',
};

export const footer = {
  tagline:
    'A hosted email MCP server that gives Claude, ChatGPT and other AI clients read and send access to your inbox, without storing the mail it reads.',
  groups: [
    {
      h: 'Product',
      links: [
        { href: '/#features', label: 'Features' },
        { href: '/#how', label: 'How it works' },
        { href: '/pricing', label: 'Pricing' },
        { href: '/for/business', label: 'For business' },
        { href: '/for/founders', label: 'For founders' },
        { href: '/developers', label: 'Developers' },
        { href: '/changelog', label: 'Changelog' },
        { href: '/status', label: 'Status' },
        { href: '/best-email-mcp-servers', label: 'Best email MCP servers' },
      ],
    },
    {
      h: 'Docs',
      links: [
        { href: '/docs', label: 'Docs' },
        { href: '/docs#quickstart', label: 'Quickstart' },
        { href: '/docs#tools', label: 'Tool reference' },
        { href: '/docs#oauth', label: 'OAuth connection' },
        { href: '/docs/clients', label: 'MCP client setup' },
        { href: '/docs/providers', label: 'Provider support' },
        { href: '/docs/api', label: 'Developer guide' },
        { href: '/docs/read-only-access', label: 'Read-only access' },
        { href: '/self-hosting', label: 'Self-hosting' },
      ],
    },
    {
      h: 'Company',
      links: [
        { href: '/about', label: 'About' },
        { href: '/blog', label: 'Blog' },
        { href: '/help', label: 'Help and support' },
        { href: '/security', label: 'Security' },
        { href: '/privacy', label: 'Privacy' },
        { href: '/terms', label: 'Terms' },
        { href: '/terms#agreement', label: 'Impressum' },
        { href: '/dpa', label: 'DPA' },
        { href: '/cancel', label: 'Cancel contracts here' },
        { href: '/cancel?type=withdraw', label: 'Withdraw from contract here' },
      ],
    },
  ],
  contact: [
    { href: 'mailto:support@mcpemails.com', label: 'support@mcpemails.com' },
    { href: 'mailto:hello@mcpemails.com', label: 'hello@mcpemails.com' },
  ],
  mcpLabel: 'MCP endpoint',
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
  legal: 'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
  copyright: '© 2026 MCPEmails.',
  facts: 'Email fetched live, never stored. Credentials encrypted at rest. Data stored in Stockholm.',
};
