/**
 * Copy and facts for /best-email-mcp-servers.
 *
 * Deliberately not a next-intl namespace, for the same reason the provider
 * landing copy is not (see src/lib/connect/content.mjs): the root layout hands
 * every loaded namespace to NextIntlClientProvider, so anything under
 * `messages/` is serialised into the HTML of every marketing page. This page's
 * copy is several kilobytes that no other page needs.
 *
 * ---------------------------------------------------------------------------
 * RULES FOR EDITING THIS FILE
 * ---------------------------------------------------------------------------
 * 1. Every claim about a company other than us names a source URL in SOURCES,
 *    and that source carries the ISO date it was last read (`checkedOn`). If
 *    you change a claim, re-read the source and move its date. CHECKED_ON is
 *    derived (the oldest `checkedOn`), so the page can never say "read on X"
 *    while one source is older than X. email-mcp-servers.test.mjs enforces the
 *    shape. Competitor pricing and feature sets change without notice; an
 *    undated comparison becomes a false statement about a real business on a
 *    schedule we do not control.
 *
 * 2. Never state a competitor capability as absent unless the absence is
 *    itself sourced. Where the public pages do not say, the cell reads
 *    NOT_STATED and the table footnote explains what that means. "We could not
 *    find it" is not the same claim as "it does not exist" and must not be
 *    printed as one.
 *
 * 3. Do not cite anyone's review scores, ratings or customer counts, ours or
 *    theirs. Social proof is not a product difference and arguing about a
 *    competitor's is a bad look.
 *
 * 4. Do not claim that Claude's or ChatGPT's built-in connectors are read-only
 *    or draft-only. Claude's Gmail connector sends, replies and forwards, with
 *    an approval prompt by default (support.claude.com article 10166901). That
 *    page carries no date, so do not print one for when sending arrived.
 *
 * 5. The ranking is ours and the page says so. We are #1 against the criteria
 *    in `method`, and those criteria are printed before the list so a reader
 *    can disagree with the weighting rather than guess at it. Every entry,
 *    ours included, carries a `cons` list, and the places a competitor beats
 *    us stay on the page. A list we win every line of reads as an
 *    advertisement, and a reader who checks one line and finds it slanted
 *    stops believing the other nine.
 *
 * 6. Keep it short. Every entry is a verdict, a price, its strengths, its
 *    weaknesses, and who it is for. If a sentence is not one of those five
 *    things, it belongs on another page or nowhere.
 *
 * 7. No tool counts, ours or anyone's. Every server groups its tools
 *    differently, our own count changes with releases, and a stale number here
 *    is exactly what answer engines repeat. The test fails on "<number> tools".
 *
 * 8. Our own facts come from this repository, never from memory: prices from
 *    src/lib/stripe/plans.ts and messages/en/pricing.json (copy the pricing
 *    page's wording for the Free plan exactly), scopes from the live
 *    /.well-known/oauth-authorization-server, residency from
 *    messages/en/security.json. There is one region, Stockholm, with mail
 *    processed live in US East. There is no region picker.
 */

/** Date of the last substantive edit to this page. Feeds the visible "Updated" line, JSON-LD dateModified and the sitemap. */
export const PAGE_UPDATED = '2026-10-20';

/** First published (under the old slug, /email-mcp-servers-compared). */
export const DATE_PUBLISHED = '2026-09-08';

/** Cell marker: the public pages we checked did not say either way. */
export const NOT_STATED = 'Not stated';

export const PATH = '/best-email-mcp-servers';

/** The slug this page used until 12 September 2026. Kept for the redirect. */
export const LEGACY_PATH = '/email-mcp-servers-compared';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** '2026-10-20' -> '20 October 2026'. Parsed by hand so no timezone can shift the day. */
export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * Every page we read to write this. Printed on the page, not merely tracked in
 * a comment: a comparison a reader cannot check is an advertisement.
 */
const SOURCE_ITEMS = [
  { label: 'Mailbox MCP pricing, plan limits and directory listings', url: 'https://mailbox-mcp.com/pricing/', checkedOn: '2026-10-20' },
  { label: 'Mailbox MCP security: storage, permission levels, send confirmation', url: 'https://mailbox-mcp.com/security/', checkedOn: '2026-10-20' },
  { label: 'Mailbox MCP privacy policy: server location', url: 'https://mailbox-mcp.com/privacy/', checkedOn: '2026-10-20' },
  { label: 'Mailbox MCP providers, Microsoft and Gmail connection, calendar', url: 'https://mailbox-mcp.com/', checkedOn: '2026-10-20' },
  { label: 'Mailbox MCP in the ChatGPT app directory', url: 'https://chatgpt.com/plugins/plugin_asdk_app_6a96d5e9880c8191aa2a97ec908b4f39', checkedOn: '2026-10-20' },
  { label: 'anymailmcp pricing, permissions, hosting and storage', url: 'https://anymailmcp.com/', checkedOn: '2026-10-20' },
  { label: 'anymailmcp supported providers', url: 'https://anymailmcp.com/providers', checkedOn: '2026-10-20' },
  { label: 'MailMCP pricing and plan limits', url: 'https://mailmcp.io/en/pricing', checkedOn: '2026-10-20' },
  { label: 'MailMCP features, protocol and contacts', url: 'https://mailmcp.io/en/features', checkedOn: '2026-10-20' },
  { label: 'MailMCP privacy policy, storage and hosting', url: 'https://mailmcp.io/en/legal/privacy', checkedOn: '2026-10-20' },
  { label: 'MailMCP guide to adding it to ChatGPT', url: 'https://mailmcp.io/en/use-cases/imap-connector-chatgpt', checkedOn: '2026-10-20' },
  { label: 'Mailopoly pricing', url: 'https://www.mailopoly.com/pricing/', checkedOn: '2026-10-20' },
  { label: 'Mailopoly MCP: providers, sign-in, sending, directories', url: 'https://www.mailopoly.com/mcp/', checkedOn: '2026-10-20' },
  { label: 'Mailopoly privacy policy: storage, region, AI providers', url: 'https://www.mailopoly.com/privacy/', checkedOn: '2026-10-20' },
  { label: 'Mailopoly Inbox in the ChatGPT app directory', url: 'https://chatgpt.com/plugins/plugin_asdk_app_6a2e4ae9228881919b13aeb3f87ca03e', checkedOn: '2026-10-20' },
  { label: 'Composio pricing, limits and plan features', url: 'https://composio.dev/pricing', checkedOn: '2026-10-20' },
  { label: 'Composio toolkit catalogue', url: 'https://composio.dev/toolkits', checkedOn: '2026-10-20' },
  { label: 'Composio guide to installing it in ChatGPT', url: 'https://composio.dev/toolkits/zoho_mail/framework/chatgpt', checkedOn: '2026-10-20' },
  { label: 'Fastmail MCP server help article', url: 'https://www.fastmail.help/hc/en-us/articles/15869557281295', checkedOn: '2026-10-20' },
  { label: 'Zoho Mail MCP getting started', url: 'https://www.zoho.com/mail/help/mcp/getting-started.html', checkedOn: '2026-10-20' },
  { label: 'Google Gmail MCP server setup (Developer Preview)', url: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server', checkedOn: '2026-10-20' },
  { label: 'Hostinger Mail API and MCP', url: 'https://www.hostinger.com/mail-api', checkedOn: '2026-10-20' },
  { label: 'Wh1isper/mcp-email-server', url: 'https://github.com/Wh1isper/mcp-email-server', checkedOn: '2026-10-20' },
  { label: 'Wh1isper/mcp-email-server 1.11.0 release notes: per-account permissions', url: 'https://github.com/Wh1isper/mcp-email-server/releases/tag/1.11.0', checkedOn: '2026-10-20' },
  { label: 'codefuturist/email-mcp', url: 'https://github.com/codefuturist/email-mcp', checkedOn: '2026-10-20' },
  { label: 'Claude Google Workspace connectors (Gmail send, reply, forward)', url: 'https://support.claude.com/en/articles/10166901-use-google-workspace-connectors', checkedOn: '2026-10-20' },
  { label: 'Nylas MCP server documentation', url: 'https://developer.nylas.com/docs/dev-guide/mcp/', checkedOn: '2026-10-20' },
  { label: 'AgentMail', url: 'https://www.agentmail.to/', checkedOn: '2026-10-20' },
  { label: 'Our own OAuth authorisation server metadata', url: 'https://mcpemails.com/.well-known/oauth-authorization-server', checkedOn: '2026-10-20' },
];

/** The oldest read date across every source, as ISO. The page's "read on" claim. */
export const CHECKED_ON_ISO = SOURCE_ITEMS.map((s) => s.checkedOn).sort()[0];

/** The same date, as prose. */
export const CHECKED_ON = formatDate(CHECKED_ON_ISO);

export const SOURCES = {
  title: 'Sources',
  sub: `Each page below was read on the date shown. The oldest read is ${CHECKED_ON}.`,
  items: SOURCE_ITEMS,
};

export const meta = {
  title: 'Best email MCP servers in 2026',
  description:
    'Every hosted email MCP server AI assistants recommend, compared on price, providers, permissions, storage and ChatGPT app directory listing: MCPEmails, Mailbox MCP, anymailmcp, MailMCP, Mailopoly, Composio, provider-run servers, open source and built-in connectors.',
};

export const hero = {
  eyebrow: 'Ranked, sourced, dated',
  titleLine1: 'The best email MCP',
  titleLine2: 'servers in 2026',
  lead:
    'Every way to give Claude, ChatGPT or Cursor a real mailbox, ranked: five hosted services, an agent tool platform, the servers mail providers run themselves, two you run yourself, and the built-in connectors.',
  updatedLabel: 'Updated',
  meta0: `Third-party figures read on ${CHECKED_ON} or later`,
  meta1: 'Every claim links to its source',
  meta2: 'Each entry lists its weaknesses',
};

/** The TL;DR block. Written to be quotable verbatim by an assistant answer. */
export const quickPicks = {
  title: 'The short version',
  items: [
    { label: 'Best overall', name: 'MCPEmails', why: 'several mailboxes behind one MCP URL, scoped OAuth, and a hold on our server before anything sends.' },
    { label: 'Best with a calendar', name: 'Mailbox MCP', why: 'mail, calendar and an address book, listed in the ChatGPT app directory.' },
    { label: 'Cheapest for 3 to 5 mailboxes', name: 'anymailmcp', why: 'EUR 4.99 a month for five IMAP mailboxes, hosted in the EU, with CalDAV and CardDAV.' },
    { label: 'Best for one mailbox, long term', name: 'MailMCP', why: 'EUR 1.99 a month per mailbox on a 24-month term, hosted in France.' },
    { label: 'Best as a full email app', name: 'Mailopoly', why: 'a unified inbox app whose MCP server comes with every plan.' },
    { label: 'Best for multi-tool agents', name: 'Composio', why: 'email is one of 1,500+ toolkits behind a single gateway.' },
    { label: 'Best on Fastmail or Zoho alone', name: 'Your provider\'s own MCP server', why: 'free to use, run by the company that holds your mail.' },
    { label: 'Best to self-host', name: 'Wh1isper/mcp-email-server', why: 'local, multi-account, per-account permissions, no hosted party.' },
  ],
};

/** Ranking criteria. Printed before the list so the weighting is arguable. */
export const method = {
  title: 'How we ranked them',
  body: `Five criteria, weighted in this order: mailboxes and providers reached, what it does with your credentials and your mail, what it costs as mailboxes are added, whether you can move off it, and setup effort. We build the first entry and the weighting is ours, so disagree with it if you like. Every third-party figure was read at its source on ${CHECKED_ON} or later, and each source at the foot of the page shows the day it was read. Where a public page did not answer, we say so rather than guess.`,
};

/**
 * The ranked list.
 *
 * `us: true` marks our own entry: the view tints it and labels it, and the
 * JSON-LD ItemList uses the same order. Every entry needs `cons`. See rule 5.
 */
export const entries = [
  {
    rank: 1,
    name: 'MCPEmails',
    tag: "Editor's pick",
    us: true,
    href: '/signup',
    verdict:
      'Puts several mailboxes from different providers behind a single MCP URL, authorises the connection with scoped OAuth rather than a mailbox credential, and can hold outbound mail on our server until a person approves it.',
    price: 'Free: 1 inbox, 150 email actions a month, first 3 days uncounted. Personal is $9 a month for 3 inboxes ($86.40 a year), Pro is $19 a month for up to 10 ($182.40 a year), and Business is $39 a month with 10 included and $3 a month for each extra. Paid plans bill monthly or yearly.',
    pros: [
      'Outlook and Microsoft 365 over Microsoft Graph with Sign in with Microsoft; Gmail with a Google app password; Fastmail, iCloud, Yahoo, Zoho, Yandex and any IMAP mailbox with an app password. Several at once, one URL.',
      'OAuth 2.1 with dynamic client registration, S256 PKCE and 9 permission scopes: a connection without the send scope cannot be talked into sending, by you or by a hostile email.',
      'An approval hold per inbox, enforced on our server rather than left to the AI app, on every plan including Free. No message content stored.',
      'The same code is open source under AGPL-3.0, with a Docker Compose stack to run it yourself.',
    ],
    cons: [
      'No calendar, and no stored address book: contacts are scanned live out of recent mail. Mailbox MCP, anymailmcp and MailMCP all do calendars or contacts.',
      'Not yet in the ChatGPT app directory. Our app is in review, so for now you add us as a custom connector. Mailbox MCP and Mailopoly are already listed.',
      'For three to five mailboxes, anymailmcp is cheaper, and for one mailbox on a long term, MailMCP is.',
      'One region: data stored in Stockholm, mail processed live in US East. No security certification of our own.',
    ],
    bestFor: 'Anyone with more than one mailbox, or who wants to bound what an agent may do with it.',
  },
  {
    rank: 2,
    name: 'Mailbox MCP',
    href: 'https://mailbox-mcp.com/',
    verdict:
      'A hosted email MCP server run from London by BSolve IT Limited, with calendar and address book tools next to the mail. It is in the ChatGPT app directory, and its pricing page says Anthropic lists it too.',
    price: 'Free: 5 MCP calls per mailbox in any rolling 24 hours. Pro is GBP 34.99 + VAT a year per mailbox (GBP 2.92 a month), up to 1,000 calls a day; there is no monthly option. Team Access is extra, from GBP 119.99 + VAT a year.',
    pros: [
      'Microsoft 365 and Outlook.com over a Microsoft sign-in, Gmail with an app password, iCloud and any IMAP host.',
      'Calendar (Microsoft 365, Google Calendar or CalDAV) and address book tools, which we do not have.',
      'Three permission levels per connection: Read only, Draft and file, or Send and delete. Messages are not copied into their database.',
      'Listed in the ChatGPT app directory (since 1 October 2026, per its pricing page), and Cyber Essentials certified.',
    ],
    cons: [
      'Sends are confirmed by your AI app, not held on their server: their security page calls the destructive marking "a hint, not a rule", and an "always allow" setting removes it.',
      'Annual billing only, per mailbox, so three mailboxes are GBP 104.97 + VAT a year.',
      `A self-host path is ${NOT_STATED.toLowerCase()}.`,
    ],
    bestFor: 'One or two mailboxes where calendar and contacts matter, and people who want to install from the ChatGPT directory.',
  },
  {
    rank: 3,
    name: 'anymailmcp',
    href: 'https://anymailmcp.com/',
    verdict:
      'A hosted email MCP server for any IMAP mailbox, sometimes written Anymail MCP, with CalDAV calendars and CardDAV contacts, hosted in the EU. The lowest price here for a handful of mailboxes.',
    price: 'Free: 1 mailbox, 15 calls a day, 45 a week, 150 a month. Solo is EUR 4.99 a month excl. VAT for up to 5 mailboxes with no call caps. Team is EUR 29.99 a month excl. VAT for everyone on your company domain.',
    pros: [
      'Up to five mailboxes for less than one of ours costs on Personal.',
      'CalDAV calendars, tasks and CardDAV contacts alongside mail.',
      'Read-only, read and organize, or full access, chosen per mailbox and enforced on their servers. Message contents are not stored.',
      'Servers and data in the European Union.',
    ],
    cons: [
      'Outlook.com and Microsoft 365 are not on its providers page, and no Microsoft sign-in is described.',
      `An approval hold before sending is ${NOT_STATED.toLowerCase()}.`,
      'We did not find it in the ChatGPT app directory.',
    ],
    bestFor: 'Several IMAP mailboxes outside Microsoft, on the smallest monthly bill.',
  },
  {
    rank: 4,
    name: 'MailMCP',
    href: 'https://mailmcp.io/',
    verdict:
      'A hosted MCP email server run from Paris, hosted in France, with CalDAV on Pro and a CardDAV address book. Priced per mailbox, with commitment and volume tiers.',
    price: 'Free: 1 mailbox, 5 MCP calls a day. Pro starts at EUR 7.99 per mailbox a month, EUR 2.99 a month on a 12-month term, or EUR 1.99 a month on a 24-month term (500 AI actions a day). Higher tiers go to 6,000 actions a day, with 15% off from the 5th mailbox and 20% from the 10th.',
    pros: [
      'Hosting in France on LWS servers that are ISO 27001 certified, and a stated position that data stays in the EU.',
      'The cheapest per-mailbox price here on a long commitment.',
      'Any IMAP and SMTP mailbox, over OAuth2 with PKCE. No email content stored.',
    ],
    cons: [
      'Billed per mailbox, so each extra mailbox adds its full price before the volume discount starts.',
      'The free tier is 5 MCP calls a day, which one triage run will use up.',
      'Its own ChatGPT guide adds it as a custom connector in Developer mode, and a Microsoft sign-in is not mentioned.',
    ],
    bestFor: 'One mailbox, EU hosting, and a willingness to commit for a year or two.',
  },
  {
    rank: 5,
    name: 'Mailopoly',
    href: 'https://www.mailopoly.com/',
    verdict:
      'Not only an MCP server: an AI email app with a unified inbox across Gmail, Outlook, iCloud, Yahoo and IMAP, whose MCP server is included on every plan. It is in the ChatGPT app directory, and its own site says it is in Claude\'s directory too.',
    price: 'No free plan; a 7-day trial on email plans, no card. Single is USD 6.99 a month or USD 4.89 a month billed annually for 1 account, Duo USD 8.99 for 2, Unlimited USD 11.99 for 5. Prices are set by region.',
    pros: [
      'Gmail, Outlook, iCloud, Yahoo and IMAP, plus Slack, Teams, WhatsApp and other channels on its Pro and Business plans.',
      'Calendar events and tasks from the same connection.',
      'In the ChatGPT app directory as Mailopoly Inbox, over OAuth 2.1.',
    ],
    cons: [
      'Your mail is imported and stored in your Mailopoly account, and its privacy policy says email content may be sent to third-party AI providers.',
      'Data is stored mainly in Australia, with some US services, and it offers no EU-only storage.',
      'Sending is marked confirm-first for the AI app to honour; a hold on its own server is not described.',
    ],
    bestFor: 'People who want a new email app with AI built in, and are happy for it to keep a copy of their mail.',
  },
  {
    rank: 6,
    name: 'Composio',
    href: 'https://composio.dev/',
    verdict:
      'Not really an email server: an agent tool platform with 1,500+ toolkits and a managed MCP gateway, of which email is a handful. The right answer to a different question.',
    price: 'Hobby is free: 100,000 tool calls and 50,000 triggers a month, 3 team members. Pro is $29 a month including $29 of usage credit, then $0.0003 a tool call. These prices apply to signups from 15 August 2026.',
    pros: [
      'One gateway and one auth layer for Gmail, Outlook, Salesforce, Linear, Slack, GitHub and 1,500+ more.',
      'By far the most generous free tier here, if tool calls are your unit.',
      'Its own guide installs it from the ChatGPT plugin marketplace.',
    ],
    cons: [
      'We found no generic IMAP toolkit: the catalogue URL for one returns "not found", so a mailbox at a small host or iCloud is not obviously covered.',
      `Message storage and data residency are ${NOT_STATED.toLowerCase()} on the pages we read.`,
    ],
    bestFor: 'Agents where email is one tool among many and you are already building on an SDK.',
  },
  {
    rank: 7,
    name: 'Your mail provider\'s own MCP server',
    href: 'https://www.fastmail.help/hc/en-us/articles/15869557281295',
    verdict:
      'Some providers now run their own: Fastmail, Zoho Mail, Hostinger Mail, and Google for Gmail in preview. Each reaches only that provider\'s mailboxes, and each is free to try if you already use it.',
    price: 'Zoho says its MCP is free on free and paid Zoho Mail plans; Hostinger includes it on every plan; Fastmail and Google state no separate price.',
    pros: [
      'Fastmail (api.fastmail.com/mcp): OAuth with separate read, write and send access, across mail, contacts and calendars.',
      'Zoho Mail: send, reply, labels, flags and folders over OAuth 2.0. Hostinger Mail: read, send and search with an API key, and a Hostinger Mail app in the ChatGPT directory.',
      'Run by the company that already holds your mail, so no third party joins the chain.',
    ],
    cons: [
      'One provider each. If you have a Fastmail and an iCloud mailbox, that is two setups, and we found no official server from Apple or Yahoo.',
      'Google\'s Gmail MCP is a Developer Preview: it drafts but has no send tool, and needs your own Google Cloud project and OAuth client.',
      'Fastmail\'s does not reach attachments, and in Claude it connects one Fastmail account only.',
    ],
    bestFor: 'People whose mail lives with one of those providers and nowhere else.',
    linkLabel: 'Fastmail\'s MCP help article',
  },
  {
    rank: 8,
    name: 'Wh1isper/mcp-email-server',
    href: 'https://github.com/Wh1isper/mcp-email-server',
    verdict:
      'A tidy, actively maintained local server: multi-account IMAP and SMTP, installed with uvx, configured through a local UI. Zero vendor.',
    price: 'Free and BSD-3-Clause. You pay for the machine it runs on.',
    pros: [
      'Multi-account, on Windows, macOS and Linux, with no hosted party in the path.',
      'Since 1.11.0, per-account permission classes (draft, organize, delete, send, append), and an empty list makes an account read-only.',
      'Your credentials and your mail never leave your machine.',
    ],
    cons: [
      'Single user, single machine. A second device means setting it up again.',
      'Long-lived mailbox credentials on the machine it runs on, and no human approval step before a send.',
    ],
    bestFor: 'One person, one machine, managing their own credentials. Often still listed under its old path, ai-zerolab/mcp-email-server.',
  },
  {
    rank: 9,
    name: 'codefuturist/email-mcp',
    href: 'https://github.com/codefuturist/email-mcp',
    verdict:
      'The largest local feature surface here: scheduling, an IDLE watcher with rule-based triage, and calendar extraction from messages, over stdio or Streamable HTTP.',
    price: 'Free and LGPL-3.0, on npm as @codefuturist/email-mcp.',
    pros: [
      'Does more out of the box than any other self-hosted option, including rule-based triage on new mail.',
      'Experimental OAuth2 for Gmail and Microsoft 365, not just app passwords.',
      'Can run as a networked Streamable HTTP server as well as locally.',
    ],
    cons: [
      'Attachment downloads capped at 5 MB, the tightest limit here.',
      'The feature surface is the configuration burden. Expect to spend time on it.',
    ],
    bestFor: 'Self-hosters who want everything and will read the README to get it.',
  },
  {
    rank: 10,
    name: 'Built-in Claude and ChatGPT connectors',
    href: 'https://support.claude.com/en/articles/10166901-use-google-workspace-connectors',
    verdict:
      'Worth being accurate about, because other comparison pages are not: Claude\'s Gmail connector sends, replies and forwards, and asks for your approval before each by default. It is not draft-only.',
    price: 'Included with that vendor\'s app.',
    pros: [
      'Nothing to install, configure or pay for separately.',
      'Sends, replies and forwards, with an approval prompt in front of it.',
    ],
    cons: [
      'It only works inside that one vendor\'s app. Your setup does not move to Cursor, to an SDK agent, or to the next model you try.',
      'Coverage is the provider list that vendor chose, mainly Gmail and Microsoft 365, not every mailbox you own. Claude\'s Gmail connector reads attachment metadata only.',
    ],
    bestFor: 'People with one AI app and one mainstream mailbox, who expect that to stay true.',
    // "Visit Built-in Claude and ChatGPT connectors" is not a sentence. This
    // entry is a category rather than a product, so its outbound link names the
    // page it actually goes to.
    linkLabel: "Claude's Gmail connector help",
    moreHref: '/native-connectors-vs-mcp',
    moreLabel: 'Native connectors vs MCP, in full',
  },
];

/** Column headings for the summary table, in order. */
export const columns = [
  { key: 'us', label: 'MCPEmails', featured: true },
  { key: 'mailboxmcp', label: 'Mailbox MCP', featured: false },
  { key: 'anymailmcp', label: 'anymailmcp', featured: false },
  { key: 'mailmcp', label: 'MailMCP', featured: false },
  { key: 'mailopoly', label: 'Mailopoly', featured: false },
  { key: 'selfhosted', label: 'Self-hosted', featured: false },
];

export const tableSub = 'The five hosted services, and running it yourself. Composio and the provider-run servers answer different questions, so they stay in the list above.';

/**
 * The summary table. Short cells on purpose: the detail is in `entries`, and a
 * table nobody can scan is a table nobody reads.
 *
 * `us` cells are verifiable from this repository: see rule 8.
 */
export const rows = [
  {
    label: 'Billed per',
    us: 'Plan, with inboxes included. Business adds $3/mo per mailbox past 10.',
    mailboxmcp: 'Mailbox, plus optional Team Access per account.',
    anymailmcp: 'Account (up to 5 mailboxes), or company domain on Team.',
    mailmcp: 'Mailbox, with discounts from the 5th.',
    mailopoly: 'Number of email accounts; Business per seat.',
    selfhosted: 'Nothing. Your own machine.',
  },
  {
    label: 'Free tier',
    us: '1 inbox, 150 email actions a month, first 3 days uncounted.',
    mailboxmcp: '5 calls per mailbox in any 24 hours.',
    anymailmcp: '1 mailbox, 15 calls a day, 150 a month.',
    mailmcp: '1 mailbox, 5 MCP calls a day.',
    mailopoly: 'No free plan. 7-day trial.',
    selfhosted: 'Unlimited.',
  },
  {
    label: 'Cheapest paid',
    us: '$9/mo or $86.40/yr for 3 inboxes.',
    mailboxmcp: 'GBP 34.99 + VAT/yr per mailbox. Annual only.',
    anymailmcp: 'EUR 4.99/mo excl. VAT for up to 5 mailboxes.',
    mailmcp: 'EUR 7.99/mailbox/mo, or EUR 1.99/mo on 24 months.',
    mailopoly: 'USD 6.99/mo, or USD 4.89/mo yearly, for 1 account.',
    selfhosted: 'No licence fee.',
  },
  {
    label: 'Outlook and Microsoft 365 by Microsoft sign-in',
    us: true,
    mailboxmcp: true,
    anymailmcp: 'Not on its providers page.',
    mailmcp: 'Outlook listed as IMAP. Sign-in not mentioned.',
    mailopoly: true,
    selfhosted: 'codefuturist: experimental OAuth2.',
  },
  {
    label: 'Any IMAP mailbox',
    us: true,
    mailboxmcp: true,
    anymailmcp: true,
    mailmcp: true,
    mailopoly: true,
    selfhosted: true,
  },
  {
    label: 'Permission levels',
    us: '9 permission scopes per connection or key.',
    mailboxmcp: 'Read only, draft and file, or send and delete.',
    anymailmcp: 'Read-only, read and organize, or full, per mailbox.',
    mailmcp: NOT_STATED,
    mailopoly: 'Scoped OAuth 2.1 sign-in.',
    selfhosted: 'Wh1isper: per-account classes.',
  },
  {
    label: 'Send held on the server for approval',
    us: 'Per inbox, on every plan.',
    mailboxmcp: 'No. Your AI app confirms.',
    anymailmcp: NOT_STATED,
    mailmcp: 'Scheduled sends reviewable; nothing stated for others.',
    mailopoly: 'No. Your AI app confirms; drafts for review.',
    selfhosted: 'No.',
  },
  {
    label: 'Message content stored',
    us: 'No. Scheduled and held sends only, encrypted.',
    mailboxmcp: 'No, per their security page.',
    anymailmcp: 'No. Opt-in watch keeps headers 7 days.',
    mailmcp: 'No, per their privacy policy.',
    mailopoly: 'Yes. Mail is imported into your account.',
    selfhosted: 'On your own disk.',
  },
  {
    label: 'Where it runs',
    us: 'Stored in Stockholm; mail processed live in US East.',
    mailboxmcp: 'London, UK. Cyber Essentials.',
    anymailmcp: 'European Union.',
    mailmcp: 'France, on an ISO 27001 certified host.',
    mailopoly: 'Mainly Australia, some US. No EU-only option.',
    selfhosted: 'Wherever you put it.',
  },
  {
    label: 'Calendar and contacts',
    us: 'Live contact lookup. No calendar.',
    mailboxmcp: 'Calendar and address book.',
    anymailmcp: 'CalDAV and CardDAV.',
    mailmcp: 'CalDAV on Pro, CardDAV.',
    mailopoly: 'Calendar events and tasks.',
    selfhosted: 'Varies by project.',
  },
  {
    label: 'In the ChatGPT app directory',
    us: 'Not yet. In review.',
    mailboxmcp: 'Listed.',
    anymailmcp: 'Not found.',
    mailmcp: 'Not found. Added in Developer mode.',
    mailopoly: 'Listed, as Mailopoly Inbox.',
    selfhosted: 'No. Added by hand.',
  },
  {
    label: 'Run the same code yourself',
    us: 'Yes. AGPL-3.0, Docker Compose.',
    mailboxmcp: NOT_STATED,
    anymailmcp: NOT_STATED,
    mailmcp: NOT_STATED,
    mailopoly: NOT_STATED,
    selfhosted: 'That is the whole proposition.',
  },
];

export const tableFootnote = `"${NOT_STATED}" means the pages we read did not answer that question, not that the capability is missing. "Not found" means we looked for a ChatGPT app directory listing on ${CHECKED_ON} and did not find one. Tool counts are absent on purpose: every server groups its tools differently, so a bigger number is not a better server.`;

export const faq = {
  // No eyebrow: every section heading on this page is a plain .providers-h2
  // with a .providers-sub under it, and one section wearing an extra label
  // above its title was part of what made the page look assembled from parts.
  title: 'Before you pick one',
  sub: 'Including the answers that do not flatter us.',
  items: [
    {
      q: 'Which email MCP server is best?',
      a: 'MCPEmails, for most people: several mailboxes behind one MCP URL, a scoped OAuth connection instead of a shared mailbox credential, a hold on our server before an agent can send, and an AGPL-3.0 self-host path if you want off. Pick Mailbox MCP if you want calendar and contacts too, anymailmcp for the lowest price on up to five IMAP mailboxes, MailMCP for one mailbox on a long EU-hosted term, Mailopoly if you want a whole new email app, and Wh1isper/mcp-email-server if you want no hosted party at all.',
    },
    {
      q: 'How do I connect iCloud or Yahoo mail to ChatGPT or Claude?',
      a: 'The built-in connectors in ChatGPT and Claude are built around Gmail and Microsoft 365, and we found no official MCP server from Apple or Yahoo, so you need a third-party server. Create an app password at your provider, connect the mailbox to a hosted server such as MCPEmails, Mailbox MCP, anymailmcp, MailMCP or Mailopoly, then add that server to ChatGPT or Claude. Mailbox MCP and Mailopoly can be installed from the ChatGPT app directory; MCPEmails, for now, is added as a custom connector while our directory app is in review.',
    },
    {
      q: 'Which of these are in the ChatGPT app directory?',
      a: `On ${CHECKED_ON} we found Mailbox MCP and Mailopoly (as Mailopoly Inbox) listed, and Composio's own guide installs it from the plugin marketplace. MCPEmails has an app in review and is not listed yet. We did not find anymailmcp or MailMCP; MailMCP's guide adds it as a custom connector in Developer mode. A directory listing means OpenAI reviewed the app; it is not a security certification.`,
    },
    {
      q: 'anymailmcp and MailMCP are cheaper. Why would I pay more?',
      a: 'For some mailbox counts they are, and we say so above. anymailmcp is EUR 4.99 a month for up to five mailboxes, and MailMCP is EUR 1.99 a month for one mailbox if you commit for 24 months. Ours is $9 a month for three, or $19 a month for up to ten. What the price buys here is Microsoft sign-in for Outlook and Microsoft 365, an approval hold on our server, and open source code you can run yourself. If you need none of those, buy theirs.',
    },
    {
      q: 'Does my provider have its own MCP server?',
      a: 'Fastmail, Zoho Mail and Hostinger Mail run their own, and Google has a Gmail MCP server in Developer Preview that drafts but cannot send. Each reaches only that provider\'s mailboxes. We found none from Apple (iCloud) or Yahoo. If all your mail is at one of those providers, its own server is worth trying first; if you have mailboxes in several places, a server like ours puts them behind one URL.',
    },
    {
      q: 'What about Nylas, AgentMail, or sending APIs like Resend and Mailgun?',
      a: 'They answer different questions. Nylas is a developer API: its MCP server authenticates with a Nylas API key, and you connect each mailbox to your Nylas application yourself. AgentMail creates new inboxes for agents rather than connecting the one you already have. Resend, Mailgun and similar services send transactional or marketing mail from your app and do not read a personal inbox.',
    },
    {
      q: 'Do I hand over my email password?',
      a: 'For Outlook, no: you sign in with Microsoft and we hold a revocable OAuth token. Gmail connects with a Google app password, and everywhere else you create a provider-issued app password, revocable at your provider without involving us. Either credential is encrypted at rest with AES-256-GCM, and your AI client never sees it: the MCP connection is its own OAuth 2.1 authorisation with its own scopes.',
    },
    {
      q: 'Can an agent send email without me seeing it first?',
      a: 'Only if you let it. Any inbox can require human approval before outbound mail is dispatched, and the hold is on our server, so an agent prompt-injected by a hostile message still cannot get mail out of your account, whatever the AI app is set to allow. Scopes are the second layer: a connection without the send scope cannot send.',
    },
    {
      q: 'Is my mail stored anywhere?',
      a: 'No. Messages are fetched live on each call and dropped once the response is sent, with no copy of any body, subject, attachment or contact. The exceptions are a message you schedule and a message held for your approval, which are kept encrypted until they go. Mailbox MCP, anymailmcp and MailMCP state the same no-storage position; Mailopoly imports and keeps your mail.',
    },
  ],
};

export const ctaBand = {
  title: 'Try it against whatever you are comparing it to',
  sub: 'One inbox free, no card. If one of the alternatives above fits you better, use that instead.',
  ctaPrimary: 'Connect an inbox',
  ctaSecondary: 'Read the docs',
};
