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
 * 1. Every claim about a company other than us names a source URL in SOURCES
 *    and was read on CHECKED_ON. If you change a claim, re-read the source and
 *    move the date. Competitor pricing and feature sets change without notice;
 *    an undated comparison becomes a false statement about a real business on
 *    a schedule we do not control.
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
 *    or draft-only. Anthropic shipped native Gmail send, reply and forward on
 *    18 August 2026. Competitor comparison pages still say otherwise; that is
 *    their error to keep, not ours to repeat.
 *
 * 5. The ranking is ours and the page says so. We are #1 against the criteria
 *    in `method`, and those criteria are printed before the list so a reader
 *    can disagree with the weighting rather than guess at it. Every entry,
 *    ours included, carries a `cons` list, and the places a competitor beats
 *    us stay on the page. A list we win every line of reads as an
 *    advertisement, and a reader who checks one line and finds it slanted
 *    stops believing the other nine.
 *
 * 6. Keep it short. The version of this page that ran until 12 September 2026
 *    rendered at about 2,500 words to cover four products; this one covers six
 *    in under 2,000, and says more. Every entry is a verdict, a price, its
 *    strengths, its weaknesses, and who it is for. If a sentence is not one of
 *    those five things, it belongs on another page or nowhere.
 */

/** The date every third-party claim on this page was last read at its source. */
export const CHECKED_ON = '8 September 2026';

/** Cell marker: the public pages we checked did not say either way. */
export const NOT_STATED = 'Not stated';

export const PATH = '/best-email-mcp-servers';

/** The slug this page used until 12 September 2026. Kept for the redirect. */
export const LEGACY_PATH = '/email-mcp-servers-compared';

export const meta = {
  title: 'Best email MCP servers in 2026',
  description:
    'The six ways to give an AI agent a real mailbox in 2026, ranked. Pricing, mailbox coverage, OAuth scopes and data residency for mcpemails, MailMCP, Composio, the open-source servers and the built-in connectors.',
};

export const hero = {
  eyebrow: 'Ranked, sourced, dated',
  titleLine1: 'The best email MCP',
  titleLine2: 'servers in 2026',
  lead:
    'Six ways to give Claude, ChatGPT or Cursor a real mailbox, ranked: two hosted servers, an agent tool platform, two you run yourself, and the built-in connectors.',
  meta0: `Third-party figures read on ${CHECKED_ON}`,
  meta1: 'Every claim links to its source',
  meta2: 'Each entry lists its weaknesses',
};

/** The TL;DR block. Written to be quotable verbatim by an assistant answer. */
export const quickPicks = {
  title: 'The short version',
  items: [
    { label: 'Best overall', name: 'mcpemails', why: 'several mailboxes behind one MCP URL, scoped OAuth, an approval hold before anything sends.' },
    { label: 'Best for EU compliance', name: 'MailMCP', why: 'France-only hosting on an ISO 27001 certified provider, plus calendar and contacts.' },
    { label: 'Best for multi-tool agents', name: 'Composio', why: 'email is one of 1,500+ toolkits behind a single gateway.' },
    { label: 'Best to self-host', name: 'Wh1isper/mcp-email-server', why: 'local, multi-account, no hosted party involved.' },
    { label: 'Best if you use one AI app', name: 'Built-in connectors', why: 'nothing to run, but it only works inside that vendor.' },
  ],
};

/** Ranking criteria. Printed before the list so the weighting is arguable. */
export const method = {
  title: 'How we ranked them',
  body: `Five criteria, weighted in this order: mailboxes and providers reached, what it does with your credentials and your mail, what it costs as mailboxes are added, whether you can move off it, and setup effort. We build the first entry and the weighting is ours, so disagree with it if you like. Every third-party figure was read at its source on ${CHECKED_ON} and linked at the foot of the page; where a public page did not answer, we say so rather than guess.`,
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
    name: 'mcpemails',
    tag: "Editor's pick",
    us: true,
    href: '/signup',
    verdict:
      'The only one of these that puts several mailboxes behind a single MCP URL, authorises the connection with scoped OAuth rather than a mailbox credential, and can hold outbound mail for a human before it sends.',
    price: 'Free: 1 inbox, 60 requests a minute, no daily call cap. Paid from $5 a month for 3 inboxes ($48 a year). Pro is $15 a month for as many inboxes as you own.',
    pros: [
      'Gmail over the Gmail API with Google sign-in; Fastmail, iCloud, Yahoo, Zoho, Yandex and any IMAP mailbox with an app password. Several at once, one URL.',
      'OAuth 2.1 with dynamic client registration, S256 PKCE and 9 scopes: a connection without the send scope cannot be talked into sending, by you or by a hostile email.',
      'An approval hold per inbox, on every plan including free, and no message content stored.',
    ],
    cons: [
      'No ISO 27001 certificate of our own. You pick an EU or US region at signup, but if procurement wants a certificate, MailMCP has one and we do not.',
      'No calendar, and no stored address book: contacts are scanned live out of recent mail.',
      'For exactly one mailbox on an annual plan, MailMCP is cheaper.',
    ],
    bestFor: 'Anyone with more than one mailbox, or who wants to bound what an agent may do with it.',
  },
  {
    rank: 2,
    name: 'MailMCP',
    href: 'https://mailmcp.io/',
    verdict:
      'A hosted MCP email server run from Paris, with a CalDAV calendar and a CardDAV address book in the same server. The strongest EU compliance story here.',
    price: 'Free: 1 mailbox, 5 MCP calls a day. Then EUR 7.99 per mailbox per month, or EUR 35.88 per mailbox for a year.',
    pros: [
      'France-only hosting on an ISO 27001 certified provider, and a stated position that data never leaves the EU.',
      'Calendar and contacts alongside mail, which nothing else here offers.',
      'Any IMAP and SMTP mailbox, over OAuth2 with PKCE. No email content stored.',
    ],
    cons: [
      'Billed per mailbox, so three mailboxes cost three times one.',
      'The free tier is 5 MCP calls a day, which one triage run will exhaust.',
      'Hosted only. No self-host path if you want off.',
    ],
    bestFor: 'Teams where EU-only hosting is non-negotiable, and anyone with one mailbox who wants the smallest annual bill.',
  },
  {
    rank: 3,
    name: 'Composio',
    href: 'https://composio.dev/',
    verdict:
      'Not really an email server: an agent tool platform with 1,500+ toolkits and a managed MCP gateway, of which email is a handful. The right answer to a different question.',
    price: 'Free: 100,000 tool calls and 50,000 trigger events a month, 3 team members. Pro is $29 a month including $29 of usage credit, then $0.0003 a tool call.',
    pros: [
      'One gateway and one auth layer for Gmail, Outlook, Salesforce, Linear, Slack, GitHub and 1,500+ more.',
      'Gmail and Outlook through their own APIs with OAuth, not IMAP.',
      'By far the most generous free tier here, if tool calls are your unit.',
    ],
    cons: [
      'We found no generic IMAP toolkit in the catalogue we read, so a mailbox at a small host or a company Exchange server is not obviously covered.',
      `Storage and data residency are ${NOT_STATED.toLowerCase()} on the pages we read.`,
    ],
    bestFor: 'Agents where email is one tool among many and you are already building on an SDK.',
  },
  {
    rank: 4,
    name: 'Wh1isper/mcp-email-server',
    href: 'https://github.com/Wh1isper/mcp-email-server',
    verdict:
      'A tidy, actively maintained local server: multi-account IMAP and SMTP, installed with uvx, configured through a local UI. Zero vendor.',
    price: 'Free and BSD-3-Clause. You pay for the machine it runs on.',
    pros: [
      'Multi-account, on Windows, macOS and Linux, with no hosted party in the path.',
      'Actively maintained, and the simpler of the two open-source options to get running.',
      'Your credentials and your mail never leave your machine.',
    ],
    cons: [
      'Single user, single machine. A second device means setting it up again.',
      'Long-lived mailbox credentials in a config file, with no scopes and no approval step before a send.',
    ],
    bestFor: 'One person, one machine, managing their own credentials. Often still listed under its old path, ai-zerolab/mcp-email-server.',
  },
  {
    rank: 5,
    name: 'codefuturist/email-mcp',
    href: 'https://github.com/codefuturist/email-mcp',
    verdict:
      'The largest local feature surface of anything here: 47 tools, 7 prompts and 6 resources, plus scheduling, an IDLE watcher with rule-based triage, and calendar extraction from messages.',
    price: 'Free and LGPL-3.0, on npm as @codefuturist/email-mcp.',
    pros: [
      'Does more out of the box than any other self-hosted option, including rule-based triage on new mail.',
      'Experimental OAuth2 for Gmail and Microsoft 365, not just app passwords.',
      'Extracts calendar invitations out of messages.',
    ],
    cons: [
      'Attachment downloads capped at 5 MB, the tightest limit here.',
      'The feature surface is the configuration burden. Expect to spend time on it.',
    ],
    bestFor: 'Self-hosters who want everything and will read the README to get it.',
  },
  {
    rank: 6,
    name: 'Built-in Claude and ChatGPT connectors',
    href: 'https://claude.com/connectors/gmail',
    verdict:
      'Worth being accurate about, because other comparison pages are not: since 18 August 2026 Claude\'s Gmail connector sends, replies and forwards on paid plans, with an approval prompt by default. It is no longer draft-only.',
    price: 'Included with a paid plan from that vendor.',
    pros: [
      'Nothing to install, configure or pay for separately.',
      'Sends, replies and forwards, with an approval prompt in front of it.',
    ],
    cons: [
      'It only works inside that one vendor\'s app. Your setup does not move to Cursor, to an SDK agent, or to the next model you try.',
      'Coverage is the provider list that vendor chose, not every mailbox you own.',
    ],
    bestFor: 'People with one AI app and one mainstream mailbox, who expect that to stay true.',
    // "Visit Built-in Claude and ChatGPT connectors" is not a sentence. This
    // entry is a category rather than a product, so its outbound link names the
    // page it actually goes to.
    linkLabel: "Claude's Gmail connector",
    moreHref: '/native-connectors-vs-mcp',
    moreLabel: 'Native connectors vs MCP, in full',
  },
];

/** Column headings for the summary table, in order. */
export const columns = [
  { key: 'us', label: 'mcpemails', featured: true },
  { key: 'mailmcp', label: 'MailMCP', featured: false },
  { key: 'composio', label: 'Composio', featured: false },
  { key: 'selfhosted', label: 'Self-hosted', featured: false },
];

/**
 * The summary table. Short cells on purpose: the detail is in `entries`, and a
 * table nobody can scan is a table nobody reads.
 *
 * `us` cells are verifiable from this repository: prices from
 * src/lib/stripe/plans.ts, the OAuth metadata from
 * app/.well-known/oauth-authorization-server, storage and residency from the
 * /security page, self-hosting from self-host/.
 */
export const rows = [
  {
    label: 'Billed per',
    us: 'Workspace. Inboxes included in the tier.',
    mailmcp: 'Mailbox.',
    composio: 'Tool call and trigger event.',
    selfhosted: 'Nothing. Your own machine.',
  },
  {
    label: 'Free tier',
    us: '1 inbox, 60 req/min, no daily cap.',
    mailmcp: '1 mailbox, 5 MCP calls a day.',
    composio: '100,000 tool calls a month.',
    selfhosted: 'Unlimited.',
  },
  {
    label: 'Cheapest paid',
    us: '$5/mo for 3 inboxes, or $48/yr.',
    mailmcp: 'EUR 7.99/mailbox/mo, EUR 35.88/yr.',
    composio: '$29/mo, includes $29 of credit.',
    selfhosted: 'No licence fee.',
  },
  {
    label: 'Any IMAP or SMTP mailbox',
    us: true,
    mailmcp: true,
    // Not a bare "no": the honest statement is what we looked for and did not
    // find, on a catalogue page that lists 1,500+ toolkits.
    composio: 'Gmail and Outlook via their APIs. No generic IMAP toolkit found.',
    selfhosted: true,
  },
  {
    label: 'Several mailboxes, one MCP URL',
    us: true,
    mailmcp: 'Per-mailbox billing.',
    composio: true,
    selfhosted: 'Local config, one machine.',
  },
  {
    label: 'MCP connection authorised by',
    us: 'OAuth 2.1, DCR, S256 PKCE, 9 scopes.',
    mailmcp: 'OAuth2 with PKCE.',
    composio: 'Platform-managed OAuth gateway.',
    selfhosted: 'Nothing. Runs as your user.',
  },
  {
    label: 'Approval hold before sending',
    us: 'Per inbox, on every plan.',
    mailmcp: NOT_STATED,
    composio: NOT_STATED,
    selfhosted: 'No.',
  },
  {
    label: 'Message content stored',
    us: 'No. Scheduled sends only, encrypted.',
    mailmcp: 'No, per their privacy policy.',
    composio: NOT_STATED,
    selfhosted: 'On your own disk.',
  },
  {
    label: 'Residency and certification',
    us: 'EU or US, picked at signup. No ISO 27001.',
    mailmcp: 'France only, ISO 27001 certified host.',
    composio: NOT_STATED,
    selfhosted: 'Wherever you put it.',
  },
  {
    label: 'Calendar and contacts',
    us: 'Live contact lookup. No calendar.',
    mailmcp: 'CalDAV and CardDAV.',
    composio: 'Google Calendar, and 1,500+ tools.',
    selfhosted: 'Varies by project.',
  },
  {
    label: 'Run the same code yourself',
    us: 'Yes. AGPL-3.0, Docker Compose.',
    mailmcp: 'Hosted only.',
    composio: 'Hosted only.',
    selfhosted: 'That is the whole proposition.',
  },
];

export const tableFootnote = `"${NOT_STATED}" means the pages we read on ${CHECKED_ON} did not answer that question, not that the capability is missing. Tool counts are absent on purpose: every server groups its tools differently, so a bigger number is not a better server.`;

export const faq = {
  // No eyebrow: every section heading on this page is a plain .providers-h2
  // with a .providers-sub under it, and one section wearing an extra label
  // above its title was part of what made the page look assembled from parts.
  title: 'Before you pick one',
  sub: 'Including the answers that do not flatter us.',
  items: [
    {
      q: 'Which email MCP server is best?',
      a: 'mcpemails, for most people: several mailboxes behind one MCP URL, a scoped OAuth connection instead of a shared mailbox credential, an approval hold before an agent can send, and an AGPL-3.0 self-host path if you want off. Pick MailMCP if EU-only hosting under an ISO 27001 certified provider is a hard requirement, Composio if email is one of many tools your agent needs, and Wh1isper/mcp-email-server if you want no hosted party at all.',
    },
    {
      q: 'MailMCP is cheaper. Why would I pay more?',
      a: 'For one mailbox on an annual plan they are, and we say so above rather than hiding it. They bill per mailbox, we bill per workspace: three mailboxes there is three times EUR 35.88, ours is $48 a year for three or $144 for as many as you own. If you will only ever want one mailbox, buy theirs.',
    },
    {
      q: 'Do I hand over my email password?',
      a: 'For Gmail, no: you sign in with Google and we hold a revocable OAuth token. Everywhere else you create a provider-issued app password, revocable at your provider without involving us. Either credential is encrypted at rest with AES-256-GCM, and your AI client never sees it: the MCP connection is its own OAuth 2.1 authorisation with its own scopes.',
    },
    {
      q: 'Can an agent send email without me seeing it first?',
      a: 'Only if you let it. Any inbox can require human approval before outbound mail is dispatched, so an agent prompt-injected by a hostile message still cannot get mail out of your account. Scopes are the second layer: a connection without the send scope cannot send, whatever a message tells the model.',
    },
    {
      q: 'Is my mail stored anywhere?',
      a: 'No. Messages are fetched live on each call and dropped once the response is sent, with no copy of any body, subject, attachment or contact. The exception is a message you schedule, which has to be held until its send time and is encrypted while it waits. MailMCP states the same no-storage position, so this is not a point of difference between us.',
    },
  ],
};

export const ctaBand = {
  title: 'Try it against whatever you are comparing it to',
  sub: 'One inbox free, no card. If one of the alternatives above fits you better, use that instead.',
  ctaPrimary: 'Connect an inbox',
  ctaSecondary: 'Read the docs',
};

/**
 * Every page we read to write this. Printed on the page, not merely tracked in
 * a comment: a comparison a reader cannot check is an advertisement.
 */
export const SOURCES = {
  title: 'Sources',
  sub: `Each page below was read on ${CHECKED_ON}.`,
  items: [
    { label: 'MailMCP pricing and plan limits', url: 'https://mailmcp.io/pricing' },
    { label: 'MailMCP features, protocol and attachment limits', url: 'https://mailmcp.io/features' },
    { label: 'MailMCP privacy policy, storage and hosting', url: 'https://mailmcp.io/legal/privacy' },
    { label: 'Composio pricing, limits and plan features', url: 'https://composio.dev/pricing' },
    { label: 'Composio toolkit catalogue', url: 'https://composio.dev/toolkits' },
    { label: 'Wh1isper/mcp-email-server', url: 'https://github.com/Wh1isper/mcp-email-server' },
    { label: 'codefuturist/email-mcp', url: 'https://github.com/codefuturist/email-mcp' },
    { label: 'Claude Gmail connector capabilities', url: 'https://claude.com/connectors/gmail' },
    { label: 'Our own OAuth authorisation server metadata', url: 'https://mcpemails.com/.well-known/oauth-authorization-server' },
  ],
};
