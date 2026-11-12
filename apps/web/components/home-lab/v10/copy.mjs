/**
 * All English copy for Homepage Lab v10 ("The Annotated Inbox").
 * Staging experiment only, English only. Facts are lifted from
 * messages/en/home.json, src/lib/clients/content/en/*.json and
 * src/lib/changelog/entries.mjs; wording is rewritten in the brief's voice.
 * Ship dates on the museum labels are real changelog dates.
 */

export const MCP_URL = 'https://mcpemails.com/api/mcp';

export const nav = {
  label: 'Primary',
  links: [
    { href: '#how', label: 'How it works' },
    { href: '#security', label: 'Security' },
    { href: '#pricing', label: 'Pricing' },
    { href: '/docs', label: 'Docs' },
    { href: '/blog', label: 'Blog' },
  ],
  signIn: 'Sign in',
  start: 'Start free',
};

export const hero = {
  kicker: 'MCPEmails, the hosted email MCP server for Claude and ChatGPT.',
  title: 'An inbox is a list of small promises. This helps you keep them.',
  lead:
    'Connect Gmail, Outlook, iCloud, Fastmail or any IMAP mailbox once, then add one connector to Claude, ChatGPT, Cursor or VS Code. Your AI reads, searches, drafts and sends from your own address, and you see every draft before it leaves. Mail is fetched live and never stored.',
  business: {
    before: 'Running',
    addresses: ['info@', 'sales@', 'invoices@'],
    after: 'for a company? All of them can sit behind one agent, each sending from its own server.',
    link: 'Email MCP for company mailboxes',
  },
  primary: 'Start free',
  secondary: 'Install in Claude or ChatGPT',
  meta: 'One inbox free, forever. No card required.',
};

export const tabs = {
  title: 'Add the connector to your client',
  intro:
    'Four clients, one address. Choose yours. The steps below are the real ones, checked against each client’s own documentation, and none of them asks you to create an API key.',
  legend: 'Your AI client',
  clients: [
    {
      id: 'claude',
      name: 'Claude',
      surface: 'claude.ai and Claude Desktop, as a custom connector',
      auth: 'OAuth sign-in. No API key, no config file.',
      steps: [
        'In claude.ai or Claude Desktop, open Customize, then Connectors.',
        'Click + Add, then Add custom connector.',
        'Name it MCPEmails and paste the address below. Click Continue and keep the sign-in settings Claude detects.',
        'Click Add and sign in with MCPEmails.',
      ],
      code: MCP_URL,
      codeLabel: 'Server URL',
      result: 'Ask Claude to answer a message, and the reply opens as the draft card shown on this page.',
      docs: { href: '/docs/claude', label: 'Claude setup, step by step' },
      guide: { href: '/blog/connect-claude-to-email', label: 'How to connect Claude to your email' },
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      surface: 'chatgpt.com, as a custom MCP server',
      auth: 'OAuth sign-in. Added on the web; the mobile app cannot add one.',
      steps: [
        'On chatgpt.com, open Plugins, then Personal. Click Add and choose Add custom MCP server.',
        'Name it MCPEmails and paste the address below under Connection.',
        'Choose OAuth, tick I understand and want to continue, and click Create as a plugin.',
        'Sign in with MCPEmails. In a chat, type @ and pick MCPEmails for each message that needs your mail.',
      ],
      code: MCP_URL,
      codeLabel: 'Connection',
      result:
        'OpenAI lists custom MCP servers for Business and Enterprise/Edu workspaces, and read-only access on Pro. Drafts open as the same card.',
      docs: { href: '/docs/chatgpt', label: 'ChatGPT setup, step by step' },
      guide: { href: '/blog/connect-chatgpt-to-email', label: 'How to connect ChatGPT to your email' },
    },
    {
      id: 'cursor',
      name: 'Cursor',
      surface: 'the Cursor editor, in mcp.json',
      auth: 'OAuth sign-in, which Cursor prompts for. No API key.',
      steps: [
        'Open ~/.cursor/mcp.json for every project, or .cursor/mcp.json inside one.',
        'Add the entry below under mcpServers. The field Cursor wants is url.',
        'Sign in with MCPEmails when Cursor asks, and approve the scopes you want the editor to hold.',
      ],
      code: `{\n  "mcpServers": {\n    "mcpemails": {\n      "url": "${MCP_URL}"\n    }\n  }\n}`,
      codeLabel: '~/.cursor/mcp.json',
      result: 'Ask the agent for a reply and it is saved to your Drafts folder, for you to check before it goes anywhere.',
      docs: { href: '/docs/cursor', label: 'Cursor setup, step by step' },
    },
    {
      id: 'vscode',
      name: 'VS Code',
      surface: 'GitHub Copilot agent mode in VS Code',
      auth: 'OAuth sign-in. No API key.',
      steps: [
        'Open the Command Palette and run MCP: Add Server.',
        'Choose HTTP (HTTP or Server-Sent Events), paste the address below and enter mcpemails as the server ID.',
        'For the destination, choose Global, then Copilot Global. VS Code writes the entry into ~/.copilot/mcp-config.json.',
        'Approve the sign-in prompt. The mail tools appear in agent mode.',
      ],
      code: `{\n  "mcpServers": {\n    "mcpemails": {\n      "type": "http",\n      "url": "${MCP_URL}"\n    }\n  }\n}`,
      codeLabel: '~/.copilot/mcp-config.json',
      result: 'Ask Copilot for a reply and it is saved to your Drafts folder, for you to check before it goes anywhere.',
      docs: { href: '/docs/vscode', label: 'VS Code setup, step by step' },
    },
  ],
  more: { href: '/docs/clients', label: 'Every MCP client we have a setup guide for' },
};

/** Museum labels. Every date is a real changelog date (entries.mjs). */
export const labels = {
  draftCard: {
    title: 'The draft card',
    medium: 'Screenshot of the in-chat card, Claude and ChatGPT',
    note: 'A reply to jordan@example.com, written by the assistant and saved to Drafts at 3:02 PM. Nothing has been sent.',
    shipped: '2026-10-27',
    entry: 'Edit drafts right in the chat',
  },
  sendClip: {
    title: 'Send, and the pause after it',
    medium: 'Screen recording, muted, no sound',
    note: 'Send is pressed, a five-second Undo runs, and the card becomes a receipt.',
    shipped: '2026-10-27',
    entry: 'Edit drafts right in the chat',
  },
  draftSent: {
    title: 'The receipt',
    medium: 'Screenshot of the in-chat card',
    note: 'Sent to jordan@example.com, with the subject and the first lines of the message.',
    shipped: '2026-10-27',
    entry: 'See what your AI sent, right in the chat',
  },
  approval: {
    title: 'A held send',
    medium: 'Screenshot of the approval card',
    note: 'A reply to billing@supplier.example, waiting. The only buttons are Reject and Approve in browser.',
    shipped: '2026-08-03',
    entry: 'Approval before an agent sends anything',
  },
  cardSent: {
    title: 'After approval',
    medium: 'Screenshot of the receipt card',
    note: 'Approved in the browser, sent over SMTP, copied to Sent.',
    shipped: '2026-10-27',
    entry: 'See what your AI sent, right in the chat',
  },
  wall: {
    title: 'Provider marks',
    medium: 'Composed SVG. Used only to name providers, never customers.',
    note: 'Gmail and Fastmail at launch; any IMAP server three days later; Outlook and Microsoft 365 in September.',
    shipped: '2026-05-26',
    entry: 'MCPEmails is live',
  },
  providersDialog: {
    title: 'Connect an inbox',
    medium: 'Screenshot of the dashboard dialog',
    note: 'One tile per provider. Outlook is the only one that signs in with Microsoft; the rest take an app password.',
    shipped: '2026-09-26',
    entry: 'Outlook and Microsoft 365 inboxes',
  },
  imapForm: {
    title: 'The IMAP form',
    medium: 'Screenshot of the dashboard, nothing typed',
    note: 'Address, IMAP and SMTP host and port, password. The settings fill themselves for many hosts.',
    shipped: '2026-05-29',
    entry: 'Connect any mailbox over IMAP',
  },
  flow: {
    title: 'The path of one request',
    medium: 'Diagram, drawn for this page in November 2026',
    note: 'Chat app to MCPEmails to your provider and back. The path itself has run since launch.',
    shipped: '2026-05-26',
    entry: 'MCPEmails is live',
  },
  stored: {
    title: 'What is stored, and where',
    medium: 'Diagram, drawn for this page in November 2026',
    note: 'Encrypted credentials and waiting sends, in an EU database in Stockholm. The mail you read is not on it.',
    shipped: '2026-06-23',
    entry: 'Scheduled sends encrypted at rest',
  },
  compare: {
    title: 'The same workspace, twice',
    medium: 'Two dashboard screenshots, one frame',
    note: 'Left: the Inboxes page, two IMAP mailboxes connected, nothing waiting. Right: the Approvals page, two emails an assistant prepared, waiting for a person.',
    shipped: '2026-08-10',
    entry: 'Approve a held send from its own page',
  },
  review: {
    title: 'A review',
    medium: 'Left on Google, quoted verbatim',
    shipped: '2026-09-13',
  },
  shippedWord: 'Shipped',
  leftWord: 'Left',
  changelog: 'changelog',
};

export const walkthrough = {
  title: 'One task, from the first word to the receipt',
  intro: [
    'Before any explanation, the work itself. Someone asks their assistant to answer Jordan, who wants to move Thursday’s design review. What follows is what happens, in the order it happens, with nothing staged.',
  ],
  steps: [
    {
      h: 'The request',
      prompt: 'Reply to Jordan: Friday at 10 works, keep the same agenda.',
      p: 'The assistant calls MCPEmails. MCPEmails opens the mailbox at the provider, finds Jordan’s message and reads the thread. The message passes through on its way to the assistant and is not kept. There is no copy of your inbox on our side to search, leak or forget about.',
    },
    {
      h: 'The draft',
      p: 'The reply is written into your Drafts folder, where you would have written it yourself, and it opens in the chat as a card. To, Subject and body are all editable. Change a word, add a Cc, attach a file, or delete it. The card counts the words and says where the draft is saved, because a draft you cannot find is not a draft.',
    },
    {
      h: 'The send, and the pause after it',
      p: 'Press Send and a five-second Undo runs before anything moves. Then the message leaves through your own provider, from your own address, and a copy lands in your Sent folder. To Jordan it is simply a reply from you.',
    },
    {
      h: 'The receipt',
      p: 'The card turns into a receipt: who it went to, the subject, the first lines. It describes what happened rather than what was intended, which is the only kind of record worth keeping.',
    },
    {
      h: 'When a send should wait for a person',
      p: 'Turn on approval for an inbox and the assistant can prepare but not send. The card says so plainly: approval happens on mcpemails.com, in your own browser, and no agent can approve a send, including the one that wrote it. Approve it and the receipt follows. Reject it and nothing leaves.',
    },
  ],
};

walkthrough.marginNote = {
  label: 'Margin note',
  text: 'The draft card itself is shown at the top of this page, with its museum label.',
};

export const providers = {
  title: 'The mailboxes it opens',
  intro:
    'Much of the mail that matters to a business does not live in Gmail. It lives on a domain, at a host, behind an IMAP server someone set up years ago and nobody has touched since. MCPEmails opens all of it, and one agent can work several mailboxes at once.',
  rows: [
    { name: 'Gmail and Google Workspace', how: 'A Google app password, over IMAP.', href: '/connect/gmail' },
    { name: 'Outlook and Microsoft 365', how: 'Sign in with Microsoft. A work or school account may need its IT admin to approve the app once.', href: '/connect/outlook' },
    { name: 'iCloud Mail', how: 'An app-specific password from your Apple account.', href: '/connect/icloud' },
    { name: 'Fastmail', how: 'A Fastmail app password. Nothing else.', href: '/connect/fastmail' },
    { name: 'Yahoo Mail', how: 'An app-specific password.', href: '/connect/yahoo' },
    { name: 'Zoho Mail', how: 'An app-specific password.', href: '/connect/zoho' },
    { name: 'Yandex Mail', how: 'An app-specific password.', href: '/connect/yandex' },
  ],
  imap: {
    name: 'Any IMAP inbox',
    how: 'Your own domain, a hosting provider, a regional ISP. Enter the server details and a password once. Your agent reads over IMAP and sends through your own SMTP server.',
    href: '/connect/imap',
  },
  links: [
    { href: '/connect', label: 'Every provider with a setup guide' },
    { href: '/docs/providers', label: 'Provider support in the docs' },
    { href: '/tools/email-settings-lookup', label: 'Look up IMAP and SMTP settings' },
  ],
};

export const how = {
  title: 'How it works, in three figures',
  intro: [
    'An email MCP server is the bridge between an AI assistant and a real mailbox. It speaks the Model Context Protocol, so Claude, ChatGPT, Cursor or any other MCP client can read, search, draft and send email through one endpoint, with no separate integration for each app.',
    'MCPEmails is a hosted one. You are the user; we are the pipe. Three steps separate a new account from an assistant that answers your mail.',
  ],
  figs: [
    {
      n: 'Fig. 1',
      h: 'Connect the mailbox',
      p: [
        'Sign in and choose Connect Inbox. Pick Gmail, Outlook, iCloud, Fastmail or any IMAP inbox, then sign in with Microsoft or paste an app password. The credential is encrypted before it is written down.',
        'Most hosts need no settings typed by hand: the form fills them in for a long list of providers, and the free settings lookup finds the rest.',
      ],
    },
    {
      n: 'Fig. 2',
      h: 'Paste one address into your client',
      p: [
        'Clients that support OAuth, such as claude.ai, Claude Desktop, ChatGPT, Cursor and VS Code, take the address, open a sign-in window, and are done. They register themselves with dynamic client registration and authorize with PKCE, so there is no client ID to create and no secret to copy.',
        'For clients without OAuth, such as Cline, JetBrains and n8n, or for your own scripts, create a scoped API key in the dashboard instead.',
      ],
      links: [
        { href: '/docs#quickstart', label: 'Quickstart' },
        { href: '/docs#oauth', label: 'OAuth connection' },
        { href: '/docs/api', label: 'Developer guide' },
      ],
    },
    {
      n: 'Fig. 3',
      h: 'The agent works the inbox',
      p: [
        'The agent lists your inboxes first, so nobody copies an ID from a dashboard. Then it calls the tools it needs: read and search, compose and reply, move and archive, folders, drafts, schedules, contacts. MCPEmails asks your provider at that moment and returns the answer. Nothing is cached between calls.',
      ],
      links: [{ href: '/docs#tools', label: 'Tool reference' }],
    },
  ],
};

export const security = {
  title: 'What we keep, and what we never keep',
  intro:
    'Giving software your inbox is a serious act, and it deserves a plain account of what happens to what you give. Here it is, in full.',
  location: 'Data stored in Stockholm, Sweden',
  locationLink: { href: '/security#subprocessors', label: 'See the sub-processor list' },
  blocks: [
    {
      h: 'The mail itself: fetched, then let go',
      p: 'Every tool call goes to your provider at the moment it is made: the Gmail API, Microsoft Graph or IMAP. Bodies, subjects and attachments go to the agent and are discarded. Nothing is indexed, cached or kept for later.',
    },
    {
      h: 'Your credentials: encrypted, kept apart from the key',
      p: 'OAuth tokens and app passwords are encrypted with AES-256-GCM before they reach the database, and decrypted only for the request that needs them. The key lives as an environment secret, apart from the data it protects.',
    },
    {
      h: 'Messages that have to wait',
      p: 'Two things are stored, because they must be: a message you schedule for later, and a send held for approval. Both are encrypted, and their record is kept for your history.',
    },
    {
      h: 'Every send from your own server',
      p: 'Your own provider sends every message, from your address. When a provider refuses connections from cloud addresses, the connection goes through our relay, a plain tunnel with TLS end to end, so the relay never sees your mail or your password.',
    },
    {
      h: 'Access you can take back',
      p: 'Each connected client appears in the dashboard and can be revoked in one click. Keys can be scoped down to reading only, and read-only keys are enforced by your mail server too.',
    },
  ],
  links: [
    { href: '/security', label: 'Security' },
    { href: '/privacy', label: 'Privacy' },
    { href: '/dpa', label: 'Data processing agreement' },
    { href: '/docs/read-only-access', label: 'Read-only access' },
    { href: '/self-hosting', label: 'Self-host it, open source under AGPL-3.0' },
  ],
};

export const uses = {
  title: 'Use cases, by mailbox',
  intro:
    'A company’s email is a set of addresses, and each has its own temperament. The front door is patient, sales is impatient, invoices are exact. Here is what people ask of each one, in their own words.',
  items: [
    {
      address: 'info@',
      h: 'The front door',
      p: 'Everything arrives here first, and nothing is urgent until it is. An agent that can read info@ and sales@ together can tell you what has waited longest, and draft the answers while you read the list.',
      prompt: 'Go through sales@ and info@ and list every enquiry from this week nobody has answered',
    },
    {
      address: 'sales@',
      h: 'The address that should never go quiet',
      p: 'A reply in an hour and a reply tomorrow are different businesses. Drafts appear in the chat as cards, and each one sends from sales@ with its own sender name and signature, through its own mail server.',
      prompt: 'Send this at 8am Monday, not now',
    },
    {
      address: 'invoices@',
      h: 'The exact one',
      p: 'Invoices want to be found, filed and passed on, never improvised. Forwarding keeps the attachments, moving keeps the folders tidy, and approval can hold anything that leaves for a person to read first.',
      prompt: 'Forward this month’s invoices from invoices@ to our accountant',
    },
    {
      address: 'you@',
      h: 'And your own address',
      p: 'Most people start with one personal inbox and one assistant. Claude and ChatGPT users get the same card, the same undo and the same receipt.',
      prompt: 'What did the doctor’s office say about my appointment?',
    },
  ],
  compare: {
    h: 'The same workspace, before and after',
    p: 'Drag the divider. On one side, two mailboxes connected and quiet. On the other, the work an assistant prepared overnight, waiting for someone to say yes.',
    before: 'Before: connected',
    after: 'After: drafts ready for review',
    range: 'Divider position, before and after',
  },
  links: [
    { href: '/for/business', label: 'Email MCP for company mailboxes' },
    { href: '/for/founders', label: 'For founders' },
    { href: '/blog/claude-imap-connector', label: 'Claude IMAP connector guide' },
    { href: '/native-connectors-vs-mcp', label: 'Native connectors or an MCP server?' },
    { href: '/best-email-mcp-servers', label: 'The best email MCP servers, compared' },
  ],
};

export const reviews = {
  title: 'In a customer’s words',
  intro: 'One review, quoted as it was written, spelling included.',
  stars: 'Five stars out of five',
  readOn: 'Read the review on Google',
};

export const pricing = {
  title: 'Priced by inbox',
  intro:
    'You pay for mailboxes, not for questions. Paid plans are not metered. Start with one inbox, free, and add the rest when they have earned their place.',
  perForever: '/forever',
  perMonth: '/month',
  inclVat: 'incl. VAT',
  popular: 'Most chosen',
  freeNote: 'No card required.',
  tiers: {
    free: {
      desc: 'One inbox, and a real mailbox for your agent.',
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
      desc: 'Three mailboxes for one person: work, personal, or a first company address.',
      features: ['Everything in Free', '3 connected inboxes', '2x higher burst rate limit', 'Priority email support'],
      cta: 'Get Personal',
    },
    solo: {
      desc: 'One person running a business: up to 10 mailboxes on one agent, from finance to support.',
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
      desc: 'Many mailboxes or several people: 10 mailboxes included, more at a fixed price each.',
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
  footnote: {
    before: 'On every plan, the mail your agent reads is fetched live and never stored.',
    compare: 'Full feature comparison',
    contact: 'Ask for something custom',
    business: 'How one person connects a company’s mailboxes',
  },
};

export const faq = {
  title: 'Questions, answered',
  intro: 'What people ask before they connect their first inbox.',
  note: {
    label: 'Not answered here?',
    before: 'Write to',
    middle: 'and a person replies, or read the',
    help: 'help articles',
  },
};

export const closing = {
  title: 'Start with one inbox',
  p: 'Connect the mailbox you answer most. Ask for one reply, and read the draft before it goes. If it earns a second inbox, you will know.',
  primary: 'Start free',
  secondary: 'Set up your client',
};

export const footer = {
  tagline:
    'A hosted email MCP server that gives AI agents read and send access to your inbox, without ever storing the email it reads.',
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
  contact: [
    { label: 'Support', href: 'mailto:support@mcpemails.com', value: 'support@mcpemails.com' },
    { label: 'Sales', href: 'mailto:hello@mcpemails.com', value: 'hello@mcpemails.com' },
  ],
  endpointLabel: 'MCP endpoint',
  languagesLabel: 'Language',
  languages: [
    { href: '/', code: 'en', label: 'English' },
    { href: '/nb', code: 'nb', label: 'Norsk' },
    { href: '/es', code: 'es', label: 'Español' },
    { href: '/fr', code: 'fr', label: 'Français' },
    { href: '/de', code: 'de', label: 'Deutsch' },
    { href: '/pt', code: 'pt-BR', label: 'Português (Brasil)' },
    { href: '/ja', code: 'ja', label: '日本語' },
    { href: '/zh', code: 'zh', label: '中文' },
  ],
  copyright: '© 2026 MCPEmails.',
  legal: 'Email fetched live, never stored. Credentials encrypted at rest.',
  entity:
    'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
};

/** "2026-10-27" -> "27 Oct 2026". */
export function museumDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}
