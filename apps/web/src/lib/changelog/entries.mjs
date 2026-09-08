/**
 * Public changelog entries.
 *
 * WHY A DATA MODULE. This is the same shape the site already uses for its
 * other dated collection (src/lib/blog/posts.js) and its per-provider copy
 * (src/lib/connect/content): content lives in a plain module under src/lib,
 * imported by the one page that needs it, never in `messages/`. Anything in
 * `messages/` is handed to NextIntlClientProvider and serialised into the HTML
 * of every marketing page, so a changelog that grows every week would be paid
 * for on the home page forever. Adding an entry is a one-object edit here.
 *
 * WHAT BELONGS HERE. Only work that actually shipped, described in the terms a
 * customer experiences it in. Never a roadmap item, never a placeholder, never
 * an internal change (admin dashboards, tooling, docs, refactors). Dates are
 * the date the work landed on main, ISO-8601, so they serialise straight into
 * <time> and JSON-LD.
 *
 * Entries are written in English and served in every locale. They are terse
 * release notes about a fast-moving product; a stale machine translation of a
 * line about SMTP AUTH is worse than the English line. The page chrome around
 * them is localized (see ./copy.mjs).
 *
 * Order does not matter: the page sorts by date, newest first.
 */

/** Entry kinds. `kind` decides the badge; the label per locale is in copy.mjs. */
export const KINDS = ['added', 'improved', 'fixed', 'changed'];

/** @type {{ date: string, kind: 'added'|'improved'|'fixed'|'changed', title: string, body: string }[]} */
export const ENTRIES = [
  /* ── September 2026 ─────────────────────────────────────────── */
  {
    date: '2026-09-08',
    kind: 'added',
    title: 'Setup guides for 77 email providers',
    body: 'Each provider page carries the IMAP and SMTP host, port and transport security measured against that provider\'s own server, plus the date it was last checked, rather than settings copied from a forum post.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Choose the sender name on each inbox',
    body: 'Set the name recipients see on outgoing mail per connected inbox, from the inbox settings or through the signature tool. A preview shows the exact From line before you save.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Attach a file straight from another message',
    body: 'An attachment can now be added to a new email by pointing at the message it came from, so the file never has to travel through the conversation to be re-sent. The server fetches the bytes itself.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Forward up to 50 messages in one call',
    body: 'Forwarding takes a list of messages instead of one. Results are reported per message, so a batch where one message fails still tells you which of the others went out.',
  },
  {
    date: '2026-09-07',
    kind: 'fixed',
    title: 'A forward that never left now says so',
    body: 'When a forward fails before anything is transmitted, the result reports it as not sent and the retry is safe with the same idempotency key. Attachments the reader could not carry are no longer quietly left off a forward.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Billing notifications',
    body: 'Email when a renewal payment needs attention, when a saved card is about to expire, and when a subscription changes or ends, so nothing about your subscription happens silently.',
  },
  {
    date: '2026-09-07',
    kind: 'improved',
    title: 'Annual billing offered where you upgrade',
    body: 'The upgrade prompt inside the app now shows the annual price next to the monthly one, and every account can move to any paid plan from the pricing page.',
  },

  {
    date: '2026-09-01',
    kind: 'added',
    title: 'Connect Gmail with an app password',
    body: 'Gmail now connects the same way as iCloud, Yahoo, Zoho and Fastmail: a Google app password, no consent screen. Signing in with Google is still offered, and mailboxes already connected that way are untouched.',
  },
  {
    date: '2026-09-01',
    kind: 'fixed',
    title: 'Send from an inbox\'s own address on any provider',
    body: 'Naming a mailbox\'s own address as the sender was accepted only on Gmail and read as a Send As request everywhere else. It now works on every provider, and a different address is still refused where the provider cannot verify it.',
  },
  {
    date: '2026-09-01',
    kind: 'fixed',
    title: 'Long subject lines with accents read correctly',
    body: 'A subject that arrives in several encoded parts, which is how any long non-ASCII subject travels, is reassembled without stray spaces appearing inside words.',
  },
  {
    date: '2026-09-01',
    kind: 'improved',
    title: 'Clearer failures, faster IMAP',
    body: 'Provider failures are reported with a specific reason instead of one generic error, an action name that differs only in case or separator is understood rather than refused, and an abandoned IMAP connection is dropped instead of holding up the next call.',
  },
  {
    date: '2026-09-01',
    kind: 'changed',
    title: 'Analytics window matches your plan',
    body: 'Usage charts and the audit log show the history window your plan includes, and the dashboard names that window instead of always saying 30 days. Nothing is deleted; the window only limits what is displayed.',
  },

  /* ── August 2026 ────────────────────────────────────────────── */
  {
    date: '2026-08-31',
    kind: 'improved',
    title: 'Every tool declares the shape of its result',
    body: 'All 16 MCP tools publish an output schema, so a client can rely on the structured result each one returns instead of parsing prose.',
  },
  {
    date: '2026-08-31',
    kind: 'fixed',
    title: 'Sending through hosts that refuse cloud senders',
    body: 'Some mail hosts reject submissions from cloud providers as a matter of policy. Those hosts are now reached over a non-cloud route, with the mail session encrypted end to end and an automatic fall back to a direct connection.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'Moving mail out of Trash restores it',
    body: 'On Gmail, moving a message out of Trash or Spam into a real folder now clears that pending-deletion state, so the message is genuinely restored rather than filed and still on a purge clock.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'A folder name means the same thing to every tool',
    body: 'Folders and labels can be addressed by name, by id or by a common alias anywhere they are accepted. An unrecognised one fails with a message that names the value and points at the folder listing.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'Bcc on Gmail',
    body: 'Bcc recipients are carried on Gmail sends, replies, forwards and drafts.',
  },
  {
    date: '2026-08-30',
    kind: 'added',
    title: 'Provider compatibility reference',
    body: 'The providers page now documents how to connect each provider, sign-in method, IMAP and SMTP settings and what commonly breaks, alongside the capability table, with a visible last-verified date.',
  },
  {
    date: '2026-08-29',
    kind: 'added',
    title: 'Who is behind MCP Emails',
    body: 'A new About page, and the legal entity, organisation number and registered address in the Terms and Privacy pages. You are handing over mailbox access, so the site now says exactly who is on the other end and what happens if the person maintaining it stops.',
  },
  {
    date: '2026-08-29',
    kind: 'added',
    title: 'Purchase confirmation email',
    body: 'A confirmation after checkout naming the plan, the amount and the billing interval.',
  },
  {
    date: '2026-08-29',
    kind: 'improved',
    title: 'A plan change shows the amount first',
    body: 'Switching plan asks for confirmation and shows what you will be charged before anything is billed.',
  },
  {
    date: '2026-08-29',
    kind: 'improved',
    title: 'Connecting an IMAP mailbox',
    body: 'The connect form works out the transport from the port instead of asking you to choose between SSL and STARTTLS, failures explain what actually went wrong, and the whole form can be completed from the keyboard.',
  },
  {
    date: '2026-08-25',
    kind: 'fixed',
    title: 'Search dates without a timezone',
    body: 'The since and before filters accept a date and time with no timezone and read it as UTC, instead of refusing the call.',
  },
  {
    date: '2026-08-25',
    kind: 'fixed',
    title: 'Automations keep running on OAuth connections',
    body: 'A scheduled rule created from an OAuth connection stopped running once its access token rotated. Rules now follow the authorisation itself, which does not rotate.',
  },
  {
    date: '2026-08-25',
    kind: 'improved',
    title: 'The upgrade offer when an inbox is over the limit',
    body: 'Connecting a mailbox above your plan limit shows the upgrade panel, in your own language, instead of a generic form error about your credentials.',
  },
  {
    date: '2026-08-24',
    kind: 'fixed',
    title: 'Sending from Exchange and Microsoft 365 over SMTP',
    body: 'Authentication now negotiates the mechanism the server advertises. Exchange and Microsoft 365 mailboxes never offered the one that was assumed, which made sending impossible and reported a correct password as wrong.',
  },
  {
    date: '2026-08-20',
    kind: 'added',
    title: 'Labels on every provider',
    body: 'Applying a label works as a Gmail label, an Outlook category or an IMAP keyword. Where a name has to be adjusted to fit a provider\'s rules, you are told the name that was actually applied.',
  },
  {
    date: '2026-08-20',
    kind: 'improved',
    title: 'Very long emails come back in readable pieces',
    body: 'A long message body is returned in bounded pieces, each reporting the true total and the exact point to resume from, so nothing is skipped or repeated. Ordinary mail is returned exactly as before.',
  },
  {
    date: '2026-08-19',
    kind: 'added',
    title: 'Automations: recurring triage that runs without you',
    body: 'A saved search plus one action, on a schedule, with a record of what it did to every message. No model is in the unattended loop: mail is matched, never interpreted. Deleting is not an available action, a forward always goes to the approval queue, and a reply only ever writes a draft.',
  },
  {
    date: '2026-08-19',
    kind: 'added',
    title: 'Use it from Claude Desktop, Cursor, Cline and Windsurf',
    body: 'npx -y mcpemails bridges the hosted server to clients that can only launch a local command. No dependencies, Node 18 or newer, and your key is only ever sent in the authorization header.',
  },
  {
    date: '2026-08-19',
    kind: 'changed',
    title: 'Plans are priced on connected inboxes',
    body: 'Pricing moved from how many actions you take to how many mailboxes you connect, which is the thing people actually run out of. Everyone using the product at the time kept unlimited inboxes.',
  },
  {
    date: '2026-08-19',
    kind: 'improved',
    title: 'Change plan from the dashboard',
    body: 'Switching plan or billing interval happens in place, with the difference settled on your next invoice, instead of sending you to a portal that could not make the change.',
  },
  {
    date: '2026-08-19',
    kind: 'improved',
    title: 'The usage meter warns you before the limit',
    body: 'The action allowance is labelled for what it is, turns amber at 80 percent, and at the limit reports what is actually happening to your calls rather than guessing.',
  },
  {
    date: '2026-08-18',
    kind: 'fixed',
    title: 'Large IMAP messages and attachments',
    body: 'Reading a very large message or pulling several big attachments no longer risks the connection dropping mid-response.',
  },
  {
    date: '2026-08-13',
    kind: 'fixed',
    title: 'Yandex mailboxes connect',
    body: 'Yandex does not implement the shortened login handshake, and its refusal of the command was being reported as a rejection of your password. Both the handshake and the message are fixed.',
  },
  {
    date: '2026-08-10',
    kind: 'added',
    title: 'Approve a held send from its own page',
    body: 'A send waiting for approval gets a review page showing the full message, with approve and reject. Clients that support MCP apps show the same review card inline.',
  },
  {
    date: '2026-08-10',
    kind: 'added',
    title: 'Setup guide that remembers where you stopped',
    body: 'The dashboard keeps your setup progress, so a half-finished connection is still visible and resumable when you come back.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Approval before an agent sends anything',
    body: 'Turn on approval for an inbox and every send, reply, forward, draft send and scheduled send is held. The agent gets a pending result, and a person in the workspace decides.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Read an attachment as text, or take the original message',
    body: 'An attachment can be returned as readable text without handing the file itself to the model, for text, CSV, HTML, JSON and text-layer PDFs. The complete original message can also be downloaded as a portable .eml file. Extraction never runs embedded code and never does OCR.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Safe retries for outbound mail',
    body: 'Send with an idempotency key and retrying the same request within 24 hours cannot produce a second email.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Guided workflows and per-inbox compatibility profiles',
    body: 'Clients that support MCP prompts can offer built-in routines for triage, open-loop review, reply drafting, organising and scheduled-send review; a prompt never grants a permission and never runs on its own. Each inbox also reports a versioned profile marking every operation exact, different or unavailable on that provider.',
  },

  /* ── July 2026 ──────────────────────────────────────────────── */
  {
    date: '2026-07-21',
    kind: 'fixed',
    title: 'IMAP search covers every folder',
    body: 'A search with no folder filter looked only in the Inbox on IMAP, so older mail in Sent or Archive returned nothing. It now fans out across every selectable mailbox and merges the results by date.',
  },
  {
    date: '2026-07-21',
    kind: 'added',
    title: 'HTML source mode in the signature editor',
    body: 'Paste a signature exported from another mail client, including the table-based layouts most generators produce, and it survives intact.',
  },
  {
    date: '2026-07-09',
    kind: 'added',
    title: 'Self-hosting, under AGPL-3.0',
    body: 'The server is licensed AGPL-3.0 and ships as a container stack you can run against your own database, using the same code as the hosted service. The self-hosting page covers the one-command install and where the two paths differ.',
  },
  {
    date: '2026-07-08',
    kind: 'added',
    title: 'Rich signature editor',
    body: 'Formatting, headings, lists, links, colour and hosted logo images, with a live preview of exactly what gets appended to your mail.',
  },
  {
    date: '2026-07-07',
    kind: 'added',
    title: 'Copy a message into another folder',
    body: 'Messages can be duplicated into a second folder instead of only moved, one at a time or in a batch, on IMAP, Outlook and Fastmail.',
  },

  /* ── June 2026 ──────────────────────────────────────────────── */
  {
    date: '2026-06-24',
    kind: 'added',
    title: 'Security and trust page',
    body: 'A page setting out what is accessed and what is stored, alongside a security.txt, the list of subprocessors and a vulnerability disclosure safe harbour.',
  },
  {
    date: '2026-06-23',
    kind: 'added',
    title: 'Per-inbox email signatures',
    body: 'A signature per connected mailbox, appended by the server on every send, reply, forward, draft and scheduled send, on every provider. On a reply it sits after your text and before the quoted thread, and a reply mode stops it repeating down a thread.',
  },
  {
    date: '2026-06-23',
    kind: 'added',
    title: 'Setup pages for the app-password providers',
    body: 'Step-by-step connect pages for Gmail, Fastmail, iCloud, Yahoo, Zoho and Yandex, each with that provider\'s real steps and its verified settings.',
  },
  {
    date: '2026-06-23',
    kind: 'improved',
    title: 'Scheduled sends encrypted at rest',
    body: 'The contents of a scheduled message are encrypted in the database until it goes out.',
  },
  {
    date: '2026-06-16',
    kind: 'added',
    title: 'Download one attachment at a time',
    body: 'Fetch a single attachment by position or filename, up to 25 MB, returned as a file the client can preview or save rather than as text in the conversation.',
  },
];

/** Entries newest first. */
export function getEntries() {
  return [...ENTRIES].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * Entries grouped into months, newest month first, each month newest first.
 * The key is `YYYY-MM`; the page formats the label for the active locale, so
 * no month name is hardcoded here.
 */
export function getEntriesByMonth() {
  const months = new Map();
  for (const entry of getEntries()) {
    const key = entry.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(entry);
  }
  return [...months.entries()].map(([key, entries]) => ({ key, entries }));
}

/** The date of the most recent entry, for `dateModified` in structured data. */
export function getLatestDate() {
  return getEntries()[0]?.date ?? null;
}
