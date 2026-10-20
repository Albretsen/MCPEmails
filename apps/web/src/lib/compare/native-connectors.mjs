/**
 * Facts, sources and dates for /native-connectors-vs-mcp. The prose lives in
 * ./native-connectors/<locale>.json; this file holds what must be the same in
 * every language: the source URLs, the date each was read, and the table's
 * shape.
 *
 * Deliberately not a next-intl namespace, for the reason given in
 * src/lib/connect/content.mjs: everything under `messages/` is serialised into
 * every marketing page, and this page's copy is only needed here. The nav and
 * footer labels stay in `messages/<locale>/compare.json` under `links`.
 *
 * ---------------------------------------------------------------------------
 * RULES FOR EDITING THIS PAGE
 * ---------------------------------------------------------------------------
 * 1. Every claim about Claude, ChatGPT or a mail provider's own MCP server is
 *    backed by an entry in SOURCES, read on its `checkedOn` date. Change a
 *    claim, re-read its source, move the date. These products changed three
 *    times between May and October 2026, and an undated "they cannot do X"
 *    turns into a false statement about a real company without us touching it.
 *
 * 2. Never write an absence as fact. Where the pages we read do not say, the
 *    cell reads "not stated" (NOT_STATED below), and the footnote explains it.
 *
 * 3. Keep the two kinds of "native" apart. Claude's and ChatGPT's connectors
 *    live inside one AI app. A mail provider's own MCP server (Fastmail, Zoho,
 *    Google's Gmail MCP) works in any MCP client but reaches one provider.
 *    Claims true of one kind are usually false of the other.
 *
 * 4. No tool counts. Our count changes with releases and every server groups
 *    its tools differently. Name what the tools do instead.
 *
 * 5. Do not print the date Anthropic shipped Gmail send. No Anthropic page
 *    states it; the help article is undated.
 */

/** The date every third-party claim on this page was last read at its source (ISO). */
export const CHECKED_ON = '2026-10-19';

/** First published, for JSON-LD. The route was added on this date. */
export const DATE_PUBLISHED = '2026-05-29';

/** Last content change, for JSON-LD and the sitemap. */
export const DATE_MODIFIED = '2026-10-20';

export const PATH = '/native-connectors-vs-mcp';

/** Cell marker, resolved to `table.notStated` in each locale. */
export const NOT_STATED = 'notStated';

/**
 * Every page the third-party claims rest on. Labels are translated in the
 * locale files under `sources.items.<id>`; the URL and the date are not.
 */
export const SOURCES = [
  { id: 'claudeGoogle', url: 'https://support.claude.com/en/articles/10166901-use-google-workspace-connectors', checkedOn: '2026-10-19' },
  { id: 'claudeGmailListing', url: 'https://claude.com/connectors/gmail', checkedOn: '2026-10-19' },
  { id: 'claudeM365', url: 'https://support.claude.com/en/articles/12542951-enabling-and-using-the-microsoft-365-connector', checkedOn: '2026-10-19' },
  { id: 'chatgptReleaseNotes', url: 'https://help.openai.com/en/articles/6825453-chatgpt-release-notes', checkedOn: '2026-10-19' },
  { id: 'chatgptApps', url: 'https://help.openai.com/en/articles/11487775-apps-in-chatgpt', checkedOn: '2026-10-19' },
  { id: 'fastmailMcp', url: 'https://www.fastmail.help/hc/en-us/articles/15869557281295', checkedOn: '2026-10-19' },
  { id: 'zohoMcp', url: 'https://www.zoho.com/mail/help/mcp/getting-started.html', checkedOn: '2026-10-19' },
  { id: 'googleGmailMcp', url: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server', checkedOn: '2026-10-19' },
];

/**
 * The comparison table. Columns: Claude's and ChatGPT's built-in connectors,
 * a mail provider's own MCP server, and us. A cell is `true` (check), `false`
 * (dash), NOT_STATED, or a key under `table.values` in the locale file.
 */
export const TABLE_ROWS = [
  { key: 'reach', apps: 'reachApps', provider: 'reachProvider', us: 'reachUs' },
  { key: 'several', apps: false, provider: false, us: true },
  { key: 'send', apps: true, provider: 'sendProvider', us: true },
  { key: 'organize', apps: 'organizeApps', provider: 'organizeProvider', us: true },
  { key: 'schedule', apps: NOT_STATED, provider: NOT_STATED, us: true },
  { key: 'approval', apps: 'approvalApps', provider: NOT_STATED, us: 'approvalUs' },
  { key: 'portable', apps: false, provider: true, us: true },
];

export const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];

/** Copy for one locale, or null if that locale has no translation. */
export async function getNativeContent(locale) {
  if (!LOCALES.includes(locale)) return null;
  const mod = await import(`./native-connectors/${locale}.json`);
  return mod.default;
}
