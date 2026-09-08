/**
 * Copy and facts for /email-mcp-servers-compared.
 *
 * Deliberately not a next-intl namespace, for the same reason the provider
 * landing copy is not (see src/lib/connect/content.mjs): the root layout hands
 * every loaded namespace to NextIntlClientProvider, so anything under
 * `messages/` is serialised into the HTML of every marketing page. This page's
 * copy is several kilobytes of comparison prose that no other page needs.
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
 * 5. Rows where a competitor wins stay in. A table we win every line of reads
 *    as marketing, and a reader who checks one row and finds it slanted stops
 *    believing the other nine.
 */

/** The date every third-party claim on this page was last read at its source. */
export const CHECKED_ON = '8 September 2026';

/** Cell marker: the public pages we checked did not say either way. */
export const NOT_STATED = 'Not stated';

export const PATH = '/email-mcp-servers-compared';

export const meta = {
  title: 'Email MCP servers compared: mcpemails, MailMCP, Composio, self-hosted',
  description:
    'A dated, sourced comparison of the MCP email servers available in September 2026. Pricing, mailbox coverage, authentication, data residency, and where each one is the better choice.',
};

export const hero = {
  eyebrow: 'Email MCP servers, side by side',
  titleLine1: 'Every email MCP server,',
  titleLine2: 'compared honestly',
  lead:
    'There are now several ways to give an AI agent a real mailbox: a hosted MCP email server, a general-purpose agent tool platform, or an open-source server you run yourself. This page lays out what each one actually costs and does, with a link to the page we read it on and the date we read it.',
  answer:
    'The short version. Pick MailMCP if EU-only hosting under an ISO 27001 certified provider is a hard requirement, or if you want a calendar and address book in the same server. Pick Composio if email is one of many tools your agent needs and you are building on an SDK. Run an open-source server yourself if you want zero vendor and do not mind operating it. Pick mcpemails if you want several mailboxes behind one MCP URL, a scoped OAuth connection instead of handing over mailbox credentials, an approval hold before your agent can send, and the option to self-host the same code later.',
  meta0: `All third-party figures read on ${CHECKED_ON}`,
  meta1: 'Sources linked on every claim',
  meta2: 'Rows we lose are still in the table',
};

/**
 * The honesty preamble. This is not decoration: the page's whole value is that
 * a reader can check it, so the method has to be stated before the table.
 */
export const method = {
  title: 'How to read this page',
  body: `Prices and features move. Every number here about MailMCP, Composio, or an open-source project was read on their own site or repository on ${CHECKED_ON} and is linked at the bottom of this page. Amounts are printed in the currency each company charges in, with no conversion, because an exchange rate would be a number nobody publishes. Where their public pages do not answer a question, the cell says so instead of guessing. Where a competitor is plainly better, the row stays in and we say why.`,
};

/** Column headings for the main table, in order. */
export const columns = [
  { key: 'us', label: 'mcpemails', featured: true },
  { key: 'mailmcp', label: 'MailMCP', featured: false },
  { key: 'composio', label: 'Composio', featured: false },
  { key: 'selfhosted', label: 'Self-hosted open source', featured: false },
];

/**
 * The main table.
 *
 * `us` cells are verifiable from this repository: prices from
 * src/lib/stripe/plans.ts, the OAuth metadata from
 * app/.well-known/oauth-authorization-server, the storage and residency lines
 * from the /security page, self-hosting from self-host/.
 */
export const rows = [
  {
    label: 'What you are charged for',
    us: 'The workspace. Inboxes are included in the tier.',
    mailmcp: 'Each mailbox, individually.',
    composio: 'Tool calls and trigger events.',
    selfhosted: 'Nothing. You pay for the machine it runs on.',
  },
  {
    label: 'Free tier',
    us: '1 inbox, 60 requests per minute, no daily call cap.',
    mailmcp: '1 mailbox, 5 MCP calls per day.',
    composio: '100,000 tool calls and 50,000 trigger events per month, 3 team members.',
    selfhosted: 'Unlimited, on your own hardware.',
  },
  {
    label: 'Cheapest paid entry',
    us: '$5 a month for 3 inboxes, or $48 a year.',
    mailmcp: 'EUR 7.99 per mailbox per month, or EUR 35.88 per mailbox for a year.',
    composio: '$29 a month, which includes $29 of usage credit.',
    selfhosted: 'No licence fee.',
  },
  {
    label: 'Any IMAP or SMTP mailbox',
    us: true,
    mailmcp: true,
    // Not a bare "no": the honest statement is what we looked for and did not
    // find, on a catalogue page that lists 1,500+ toolkits.
    composio: 'Gmail and Outlook through their own APIs. No generic IMAP toolkit in the catalogue we read.',
    selfhosted: true,
  },
  {
    label: 'Provider-native API path',
    us: 'Gmail over the Gmail API, everything else over IMAP and SMTP.',
    mailmcp: 'IMAP and SMTP for every provider.',
    composio: 'Per-provider API toolkits, including Gmail and Outlook.',
    selfhosted: 'IMAP and SMTP. XOAUTH2 for Gmail and Microsoft 365 in one project, marked experimental.',
  },
  {
    label: 'How the MCP connection itself is authorised',
    us: 'OAuth 2.1: dynamic client registration, S256 PKCE, and 9 separate scopes.',
    mailmcp: 'OAuth2 with PKCE over Streamable HTTP.',
    composio: 'A managed MCP gateway with OAuth handled by the platform.',
    selfhosted: 'Usually none. The server runs locally as your user.',
  },
  {
    label: 'Message content stored on the server',
    us: 'No. Fetched live per call and dropped when the response is sent. Messages you schedule are the one exception and are encrypted until they go out.',
    mailmcp: 'No. Their privacy policy states no email content is stored and that transit is direct over IMAP and SMTP.',
    composio: NOT_STATED,
    selfhosted: 'Whatever the project does, on your disk.',
  },
  {
    label: 'Data residency and certification',
    us: 'EU (Frankfurt) or US (Virginia), chosen at signup. No ISO 27001 certification of our own.',
    mailmcp: 'France only, on an ISO 27001 certified host. Their stated position is that data never leaves the EU.',
    composio: NOT_STATED,
    selfhosted: 'Wherever you put it.',
  },
  {
    label: 'Calendar and address book',
    us: 'No calendar. Contacts are scanned live out of recent mail, with no stored address book.',
    mailmcp: 'CalDAV calendar and a CardDAV address book in the same server.',
    composio: 'Google Calendar and 1,500+ other toolkits.',
    selfhosted: 'Varies by project. One extracts calendar invitations from mail.',
  },
  {
    label: 'Run the same code yourself',
    us: 'Yes. The server is AGPL-3.0 and ships as a Docker Compose stack.',
    mailmcp: 'Hosted service.',
    composio: 'Hosted platform.',
    selfhosted: 'That is the entire proposition.',
  },
];

export const tableFootnote = `"${NOT_STATED}" means the public pages we read on ${CHECKED_ON} did not answer that question. It is not a claim that the capability is missing. Tool counts are deliberately absent from this table: every server groups its tools differently, ours included, so the numbers are not comparable and a bigger one is not better.`;

/**
 * The section that makes the rest of the page credible. If you are tempted to
 * soften one of these, re-read rule 5 at the top of the file.
 */
export const theyWin = {
  eyebrow: 'Where we lose',
  title: 'Three things the alternatives do better',
  sub: 'Every comparison page claims a clean sweep. Here are the cases where you should pick something else.',
  items: [
    {
      tag: 'Compliance',
      h: 'MailMCP has the stronger EU story',
      p: 'MailMCP is a Paris company hosting in France on an ISO 27001 certified provider, and states that data never leaves the EU. We let you pick an EU region at signup, but the company is Norwegian, the site runs on a global edge network, and we hold no certification of our own. If your procurement process asks for a certificate, they have one and we do not.',
    },
    {
      tag: 'Entry price',
      h: 'One mailbox on an annual plan is cheaper there',
      p: 'A single mailbox on MailMCP costs EUR 35.88 for a year. Our cheapest paid tier is $48 a year, and it covers three inboxes rather than one. Different currencies, but not close enough for the exchange rate to change the answer: if you have exactly one mailbox and want the smallest annual bill, theirs is smaller. The shapes only diverge as mailboxes are added, because their bill multiplies per mailbox and ours does not.',
    },
    {
      tag: 'Breadth',
      h: 'Composio is a different, larger product',
      p: 'Composio is an agent tool platform with 1,500+ toolkits, of which email is a handful. If your agent also needs Salesforce, Linear, Slack and GitHub behind one gateway, comparing it to an email server is the wrong comparison, and we are the wrong answer. Where the comparison does hold: it reaches email through per-provider APIs, and we found no generic IMAP toolkit in its catalogue, so a mailbox at a small host or a company Exchange server is not obviously covered.',
    },
  ],
};

export const weWin = {
  eyebrow: 'Where we are different',
  title: 'Four things this server is built around',
  sub: 'Each of these is checkable in the public repository or in your own dashboard, not a positioning statement.',
  items: [
    {
      tag: 'Consent',
      h: 'An approval hold on outbound mail, per inbox',
      p: 'Any inbox can be switched to hold every outbound message until a human approves it, and the hold survives whatever the agent was told by the mail it just read. This is the setting that makes it reasonable to let an agent near a mailbox that matters. It is a property of the inbox, not of your MCP client, so it holds regardless of which client is connected.',
    },
    {
      tag: 'Scopes',
      h: 'Nine scopes, not one all-or-nothing token',
      p: 'The MCP connection is authorised with OAuth 2.1, dynamic client registration and S256 PKCE, and the token carries only the scopes you granted. A connection with read and search but no send scope cannot be talked into sending, by you or by a hostile email. Every scope is listed in our published authorisation server metadata, so you can read the whole set before you connect anything.',
    },
    {
      tag: 'Reach',
      h: 'Gmail through the Gmail API, not IMAP',
      p: 'Gmail connects with Google sign-in and runs over the Gmail API, so labels, threads and search behave the way Gmail actually behaves rather than the way IMAP approximates them. Fastmail, iCloud, Yahoo, Zoho, Yandex and any other IMAP mailbox connect with a provider-issued app password. Several of them can sit behind the same MCP URL at once.',
    },
    {
      tag: 'Exit',
      h: 'The same code, on your own machine, under AGPL-3.0',
      p: 'The server is public and self-hostable as a Docker Compose stack. That is a real exit, not a gesture: if the hosted service ever stops suiting you, the thing you were using keeps running on your own infrastructure. It also means the claims on this page about what we store are auditable rather than promised.',
    },
  ],
};

/** Short, sourced profiles. Each one ends with the case for choosing it. */
export const profiles = {
  eyebrow: 'The field',
  title: 'Who else is building this',
  items: [
    {
      name: 'MailMCP',
      url: 'https://mailmcp.io/',
      blurb:
        'A hosted MCP email server run from Paris, connecting any IMAP and SMTP mailbox and adding a CalDAV calendar, a CardDAV address book, an HTML signature generator, and scheduled sending. Billing is per mailbox: a free tier of one mailbox and 5 MCP calls a day, then EUR 7.99 per mailbox per month, or EUR 35.88 per mailbox for a year. Hosting is in France on an ISO 27001 certified provider. Attachments are capped at 10 MB per file, 25 MB per message, and 10 files.',
      bestIf:
        'Best if EU-only hosting is non-negotiable, if you want calendar and contacts in the same server, or if you have exactly one mailbox and want the cheapest annual bill.',
    },
    {
      name: 'Composio',
      url: 'https://composio.dev/',
      blurb:
        'An agent tool platform with 1,500+ toolkits and a managed MCP gateway, of which email is a small part. Gmail and Outlook are reached through their own APIs with OAuth. Free covers 100,000 tool calls and 50,000 trigger events a month with 3 team members; Pro is $29 a month including $29 of usage credit, then $0.0003 a tool call; Enterprise adds SSO and SCIM. We found no generic IMAP toolkit in its catalogue.',
      bestIf:
        'Best if email is one of many tools your agent needs and you want one platform and one auth layer for all of them.',
    },
    {
      name: 'Wh1isper/mcp-email-server',
      url: 'https://github.com/Wh1isper/mcp-email-server',
      blurb:
        'A BSD-3-Clause, multi-account IMAP and SMTP MCP server for Windows, macOS and Linux, installed with uvx and configured through a local UI. Actively maintained. Directories often still list it under its former path, ai-zerolab/mcp-email-server, which redirects here.',
      bestIf:
        'Best if you want a local, single-user server with no hosted party involved and are comfortable managing credentials on your own machine.',
    },
    {
      name: 'codefuturist/email-mcp',
      url: 'https://github.com/codefuturist/email-mcp',
      blurb:
        'An LGPL-3.0 IMAP and SMTP MCP server published on npm as @codefuturist/email-mcp, exposing 47 tools, 7 prompts and 6 resources, plus scheduling, an IMAP IDLE watcher with rule-based triage, calendar extraction from messages, and experimental OAuth2 for Gmail and Microsoft 365. Attachment downloads are capped at 5 MB.',
      bestIf:
        'Best if you want the largest local feature surface and are willing to configure it yourself.',
    },
  ],
};

/**
 * The native-connector question, answered without repeating the stale claim.
 * Links to the existing /native-connectors-vs-mcp page rather than restating
 * it here.
 */
export const nativeNote = {
  title: 'What about the built-in Gmail and Outlook connectors',
  body: 'Worth being accurate about, because other comparison pages are not. Since 18 August 2026, Claude\'s Gmail connector sends, replies and forwards on paid plans, with an approval prompt by default. It is no longer draft-only, and anyone still telling you it is has not rechecked. The remaining differences are about coverage, portability between clients, and how much control you have over what the agent may do. We wrote those up separately.',
  linkLabel: 'Read: native connectors vs MCP',
};

export const faq = {
  eyebrow: 'Questions',
  title: 'The obvious objections',
  sub: 'Including the ones that do not flatter us.',
  items: [
    {
      q: 'MailMCP is cheaper. Why would I pay more?',
      a: 'For one mailbox on an annual plan, they are cheaper, and we say so above rather than hiding it. The shapes differ: they charge per mailbox, we charge per workspace. Their annual bill for three mailboxes is three times EUR 35.88; our Personal tier is $48 a year whether you connect one inbox or three, and Pro is $144 a year for as many as you own. If you only ever want one mailbox and price is the deciding factor, buy theirs.',
    },
    {
      q: 'Do I hand over my email password?',
      a: 'For Gmail, no: you sign in with Google and we hold a revocable OAuth token. For Fastmail, iCloud, Yahoo, Zoho, Yandex and generic IMAP, you create a provider-issued app password, which you can revoke at your provider without involving us. Either credential is encrypted at rest with AES-256-GCM. Separately from that, the connection between your AI client and our server is its own OAuth 2.1 authorisation with its own scopes, so a client never sees the mailbox credential at all.',
    },
    {
      q: 'Is my mail stored anywhere?',
      a: 'No. Messages are fetched live on each call and dropped once the response is sent, with no copy of any body, subject, attachment or contact. The one deliberate exception is a message you ask the agent to schedule, which has to be held until its send time and is encrypted while it waits. MailMCP states the same no-storage position for their service. This is not a point of difference between us, and we are not going to pretend it is.',
    },
    {
      q: 'Can the agent send email without me seeing it first?',
      a: 'Only if you let it. Any inbox can require a human approval before outbound mail is dispatched, and with that on, an agent that has been prompt-injected by a hostile message still cannot get mail out of your account. Scopes are the second layer: an API key without the send scope cannot send regardless of what any message tells the model.',
    },
    {
      q: 'Why not just run an open-source server myself?',
      a: 'If you are one person on one machine and happy to manage credentials and updates yourself, that is a genuinely good answer, and two of the projects above are well maintained. A hosted server earns its keep when you want the same mailboxes reachable from several MCP clients and devices, when several people share them, when you want an audit log and an approval queue, or when you would rather not have long-lived mailbox credentials sitting in a config file. Our code is AGPL-3.0 and self-hostable, so choosing us now does not close the do-it-yourself door later.',
    },
    {
      q: 'How current are these numbers?',
      a: `Every third-party figure on this page was read at its source on ${CHECKED_ON}, and each source is linked below. Pricing and features change without notice, so if you are about to make a decision on one of these numbers, click through and check it. If you find something here that has gone out of date, tell us and we will fix it.`,
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
 * Every page we read to write this. Printed on the page, not just tracked in a
 * comment: a comparison a reader cannot check is an advertisement.
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
