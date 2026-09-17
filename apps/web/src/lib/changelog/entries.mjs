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
  /* ── September 2026 ────────────────────────────────────────── */
  {
    date: '2026-09-17',
    kind: 'fixed',
    title: 'A forward now carries the original exactly',
    body:
      'Forwarding relays the original message byte for byte: its HTML, inline images, attachments and MIME structure arrive as they were sent, under your note and the usual forwarded-message header. Until now a forward was flattened to plain text on every provider. Originals up to 25 MB, and as_attachment sends the whole original as a .eml instead.',
  },
  {
    date: '2026-09-17',
    kind: 'changed',
    title: 'Automations no longer accept a provider-native raw query',
    body:
      'An automation filter could carry raw, a query string handed straight to the mail provider in its own dialect. A rule re-runs unattended every fifteen minutes for months, and nothing on that path can tell a working raw query from a broken one, so it was also a way past the rule that a filter must state at least one condition: a raw value of ALL counted as a condition and then matched the whole mailbox. The field is now refused where a rule is saved and again where it runs, with an error that says the refusal is deliberate rather than a gap. No stored rule used it, so no existing automation changes what it does, and the interactive search tools still take raw.',
  },
  {
    date: '2026-09-17',
    kind: 'fixed',
    title: 'Nothing unattended acts on a disconnected inbox',
    body:
      'Scheduled sends, held bulk plans and automation runs each loaded their inbox by id alone, so a mailbox disconnected, revoked or expired after the work was queued could still be used. All three now require an active inbox, the same check every ordinary tool call makes. A scheduled send against such an inbox fails with a reason shown on the dashboard, and an automation reports the inbox as unavailable instead of claiming it no longer exists.',
  },
  {
    date: '2026-09-17',
    kind: 'improved',
    title: 'A draft update says whether it is still threaded',
    body:
      'Updating a reply draft returned no reply-to reference, which read as though the thread had been lost when the headers were carried through all along. Draft results now carry a threaded flag on every path, true when the draft answers a known message.',
  },
  {
    date: '2026-09-17',
    kind: 'changed',
    title: 'Invites are re-checked when they are accepted',
    body:
      'An invite is valid for seven days and was checked only when it was sent. Accepting one now re-checks that the workspace still has a seat free on its plan and still exists, so a workspace that left the Team plan in between cannot gain a member through an invite already in flight.',
  },
  {
    date: '2026-09-16',
    kind: 'added',
    title: 'Restrict the connector to your own email domain',
    body:
      'The OAuth server can now say, for a given token, which verified email address it was issued to, through a userinfo endpoint and the openid and email scopes. A ChatGPT Business or Enterprise admin can use that to limit the connector to accounts on their own domain. These scopes grant no mail permission, and the consent screen states in one line that the account\'s address is included.',
  },
  {
    date: '2026-09-16',
    kind: 'changed',
    title: 'Tool annotations match what the tools do',
    body:
      'The hints a client uses to decide when to ask before running a tool were corrected. Only the four tools that can reach someone outside your own mailbox (compose, draft send, schedule and automation) are marked open-world, and anything that sends is marked destructive, because a delivered message cannot be recalled. Reading a message no longer marks it as read, so email_read stays a read-only tool; the old mark_as_read argument is accepted and ignored, and the result points at the flag action of email_organize instead.',
  },
  {
    date: '2026-09-16',
    kind: 'fixed',
    title: 'Automations: one connection per run, and a time budget that holds',
    body:
      'A recurring rule opened a fresh IMAP connection for every matched message, which providers that cap simultaneous connections punished. A run now uses one connection. A rule with many matches could also run past the time allowed and be cut off part way with the rest dropped; it now stops at a message boundary, records what it did and picks up the remainder on the next run. A destination folder the provider had confirmed is no longer reported as missing when a single move is refused.',
  },
  {
    date: '2026-09-14',
    kind: 'fixed',
    title: 'A folder called Spam is Spam, not Junk',
    body:
      'Folder names were run through an alias table before every operation, so a mailbox with a real Spam folder and no Junk got a Junk-not-found error, and a move or copy addressed to Spam reported success and landed in Junk. An exact folder name or id now wins over the role reading on every provider, and deleting resolves the mailbox\'s real Trash folder instead of assuming one named Trash.',
  },
  {
    date: '2026-09-14',
    kind: 'changed',
    title: 'IMAP search covers the Inbox unless you widen it',
    body:
      'On generic IMAP, a search with no folder filter looks in the Inbox. Fanning out across every mailbox is one serial search per folder and ran past the time a search is allowed to take, so it is no longer the default. Name the folders you want in include_folders, such as your archive or your sent mail, to search wider. Gmail and Outlook still search every folder.',
  },
  {
    date: '2026-09-14',
    kind: 'fixed',
    title: 'Switch between monthly and annual billing',
    body:
      'A subscriber who chose annual billing was told they were already on that plan and nothing happened, in either direction, because the check read the tier and never looked at the interval. Both directions work now, quoted before anything is charged like any other plan change. Switching restarts the billing period, and the confirmation says so instead of promising the renewal date will not move.',
  },
  {
    date: '2026-09-13',
    kind: 'changed',
    title: 'Free includes 150 email actions a month',
    body:
      'A Free workspace gets 150 billable email actions per calendar month. The first seven days after signing up are not counted, so a first week is never cut short, and there is no daily cap. Every workspace that already existed is exempt for good. The dashboard shows where you stand against the allowance, an email goes out at 80 percent and again at the limit, and an automation that meets the limit pauses with a stated reason and resumes on the 1st. Paid plans are unchanged.',
  },
  {
    date: '2026-09-12',
    kind: 'fixed',
    title: 'ChatGPT can connect',
    body:
      'Connecting from ChatGPT died at the consent screen with "Client metadata could not be verified". ChatGPT states the ways it can authenticate as a list and also carries the older single-value field beside it, which names a method this server does not accept; only that older field was being read. The list now decides. A client that can authenticate only in a way we do not support is still refused.',
  },
  {
    date: '2026-09-11',
    kind: 'fixed',
    title: 'Looking up a correspondent with a read-only connection',
    body:
      'Searching your contacts required a contacts permission of its own, which a connection granted reading alone does not hold, so the lookup an assistant reaches for before composing was refused. Reading mail now covers it. It returns only the names and addresses already carried on the messages that connection can read.',
  },
  {
    date: '2026-09-09',
    kind: 'changed',
    title: 'Reading and writing are separate tools',
    body:
      'Five tools each mixed a listing with the writes beside it, so a client had to ask permission to list your folders as though it were about to delete one. The advertised surface is now 22 tools with none of them mixed, which lets the reading half be allowed once and stop prompting. Nothing the server accepts changed, so a client connected before the split keeps working exactly as it did.',
  },
  {
    date: '2026-09-09',
    kind: 'changed',
    title: 'Consent asks for reading first',
    body:
      'The first screen a new user saw asked for all nine permissions at once, sending and deleting included, before a single message had been read. It now asks for reading alone and asks for the rest at the moment something actually needs one, carrying forward everything already granted rather than replacing it.',
  },
  {
    date: '2026-09-09',
    kind: 'fixed',
    title: 'An approved send goes out as edited, and signed once',
    body:
      'Editing the plain text of a held message before approving it left the formatted version of that message untouched, and the formatted version is what most mail clients display, so a recipient could be shown the wording from before the edit. Both now stay in step. Approved sends also carried the signature twice, and now carry it once.',
  },
  {
    date: '2026-09-08',
    kind: 'added',
    title: 'Setup guides for 77 email providers',
    body:
      'Each provider page carries the IMAP and SMTP host, port and transport security measured against that provider\'s own server, plus the date it was last checked, rather than settings copied from a forum post.',
  },
  {
    date: '2026-09-08',
    kind: 'improved',
    title: 'Connecting an inbox',
    body:
      'Ten changes across the connect flow. Choosing a provider advances at once instead of pausing for two seconds. A mailbox at your own domain now finds its own mail servers, from the records the domain publishes and a public provider database, rather than needing the host and port looked up by hand. Host and port sit on one row instead of the port hiding under Advanced. Nine separate refusals that all read "Connection failed. Please try again." each say what actually happened, and an expired session offers the way back to sign-in. A check that takes forty seconds now shows progress, and if you close the window before it finishes the answer still reaches you.',
  },
  {
    date: '2026-09-08',
    kind: 'added',
    title: 'A status page, this changelog, and setup guides per client',
    body:
      'Four pages the site was missing. /status is built from the monitor that runs against the product every few minutes, with real 30-day arithmetic and a day left grey rather than green when it was not measured. This changelog. Setup instructions for 13 MCP clients, each step taken from the product rather than guessed at. And a dated comparison against the other email MCP servers, with where we lose stated before the pitch.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Choose the sender name on each inbox',
    body:
      'Set the name recipients see on outgoing mail per connected inbox, from the inbox settings or through the signature tool. A preview shows the exact From line before you save.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Attach a file straight from another message',
    body:
      'An attachment can now be added to a new email by pointing at the message it came from, so the file never has to travel through the conversation to be re-sent. The server fetches the bytes itself.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Forward up to 50 messages in one call',
    body:
      'Forwarding takes a list of messages instead of one. Results are reported per message, so a batch where one message fails still tells you which of the others went out.',
  },
  {
    date: '2026-09-07',
    kind: 'fixed',
    title: 'A forward that never left now says so',
    body:
      'When a forward fails before anything is transmitted, the result reports it as not sent and the retry is safe with the same idempotency key. Attachments the reader could not carry are no longer quietly left off a forward.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Billing notifications',
    body:
      'Email when a renewal payment needs attention, when a saved card is about to expire, and when a subscription changes or ends, so nothing about your subscription happens silently.',
  },
  {
    date: '2026-09-07',
    kind: 'improved',
    title: 'Annual billing offered where you upgrade',
    body:
      'The upgrade prompt inside the app now shows the annual price next to the monthly one, and every account can move to any paid plan from the pricing page.',
  },
  {
    date: '2026-09-07',
    kind: 'fixed',
    title: 'Long-time users can buy a plan',
    body:
      'A workspace holding the unlimited-inboxes grant from the August pricing change was refused at checkout for Personal, on the reasoning that a plan naming three inboxes must be a downgrade from unlimited. The grant lifts the inbox ceiling and nothing else, and it survives onto a paid plan, so Personal raises everything else and is now purchasable.',
  },
  {
    date: '2026-09-01',
    kind: 'added',
    title: 'Connect Gmail with an app password',
    body:
      'Gmail now connects the same way as iCloud, Yahoo, Zoho and Fastmail: a Google app password, no consent screen. Signing in with Google is still offered, and mailboxes already connected that way are untouched.',
  },
  {
    date: '2026-09-01',
    kind: 'fixed',
    title: 'Send from an inbox\'s own address on any provider',
    body:
      'Naming a mailbox\'s own address as the sender was accepted only on Gmail and read as a Send As request everywhere else. It now works on every provider, and a different address is still refused where the provider cannot verify it.',
  },
  {
    date: '2026-09-01',
    kind: 'fixed',
    title: 'Long subject lines with accents read correctly',
    body:
      'A subject that arrives in several encoded parts, which is how any long non-ASCII subject travels, is reassembled without stray spaces appearing inside words.',
  },
  {
    date: '2026-09-01',
    kind: 'improved',
    title: 'Clearer failures, faster IMAP',
    body:
      'Provider failures are reported with a specific reason instead of one generic error, an action name that differs only in case or separator is understood rather than refused, and an abandoned IMAP connection is dropped instead of holding up the next call.',
  },
  {
    date: '2026-09-01',
    kind: 'changed',
    title: 'Analytics window matches your plan',
    body:
      'Usage charts and the audit log show the history window your plan includes, and the dashboard names that window instead of always saying 30 days. Nothing is deleted; the window only limits what is displayed.',
  },
  {
    date: '2026-09-01',
    kind: 'changed',
    title: 'Pro is now $15 a month',
    body:
      'Pro drops from $29 to $15 a month, and from $276 to $144 a year. At $29 the step up from Personal was close to six times the price to go from three mailboxes to five, which is not what those two mailboxes are worth. Personal stays at $5 and Team is unchanged. No subscription was on the old prices.',
  },
  /* ── August 2026 ───────────────────────────────────────────── */
  {
    date: '2026-08-31',
    kind: 'improved',
    title: 'Every tool declares the shape of its result',
    body:
      'All 16 MCP tools publish an output schema, so a client can rely on the structured result each one returns instead of parsing prose.',
  },
  {
    date: '2026-08-31',
    kind: 'fixed',
    title: 'Sending through hosts that refuse cloud senders',
    body:
      'Some mail hosts reject submissions from cloud providers as a matter of policy. Those hosts are now reached over a non-cloud route, with the mail session encrypted end to end and an automatic fall back to a direct connection.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'Moving mail out of Trash restores it',
    body:
      'On Gmail, moving a message out of Trash or Spam into a real folder now clears that pending-deletion state, so the message is genuinely restored rather than filed and still on a purge clock.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'A folder name means the same thing to every tool',
    body:
      'Folders and labels can be addressed by name, by id or by a common alias anywhere they are accepted. An unrecognised one fails with a message that names the value and points at the folder listing.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'Bcc on Gmail',
    body:
      'Bcc recipients are carried on Gmail sends, replies, forwards and drafts.',
  },
  {
    date: '2026-08-30',
    kind: 'added',
    title: 'Provider compatibility reference',
    body:
      'The providers page now documents how to connect each provider, sign-in method, IMAP and SMTP settings and what commonly breaks, alongside the capability table, with a visible last-verified date.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'Inviting a teammate works',
    body:
      'Every invite was refused with a message saying the workspace already held its maximum of one member, on every plan, Team included. The check could not read the workspace\'s real plan and fell back to the most restrictive one, so nobody could ever add anybody. A plan that cannot be read is now an error rather than a silent fall back to Free. The inbox routes also gained the role check they were missing, so a viewer can no longer connect, disconnect or reconfigure a mailbox in someone else\'s workspace.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'Downloading an attachment that is not text',
    body:
      'Taking a PDF, or the original message, succeeded here and then reached the assistant as though the call had been made wrong, with nothing to fall back on. Images and audio keep their own blocks, text keeps the form that works, and everything else now travels beside the filename, type and size rather than in a wrapper the client was discarding. The original message carries a checksum over the same bytes, so what was decoded can be verified.',
  },
  {
    date: '2026-08-29',
    kind: 'added',
    title: 'Who is behind MCP Emails',
    body:
      'A new About page, and the legal entity, organisation number and registered address in the Terms and Privacy pages. You are handing over mailbox access, so the site now says exactly who is on the other end and what happens if the person maintaining it stops.',
  },
  {
    date: '2026-08-29',
    kind: 'added',
    title: 'Purchase confirmation email',
    body:
      'A confirmation after checkout naming the plan, the amount and the billing interval.',
  },
  {
    date: '2026-08-29',
    kind: 'improved',
    title: 'A plan change shows the amount first',
    body:
      'Switching plan asks for confirmation and shows what you will be charged before anything is billed.',
  },
  {
    date: '2026-08-29',
    kind: 'improved',
    title: 'Connecting an IMAP mailbox',
    body:
      'The connect form works out the transport from the port instead of asking you to choose between SSL and STARTTLS, failures explain what actually went wrong, and the whole form can be completed from the keyboard.',
  },
  {
    date: '2026-08-27',
    kind: 'added',
    title: 'Personal: three inboxes for $5 a month',
    body:
      'A plan between Free and Pro, at $5 a month or $48 a year: three connected inboxes, one person, and twice the per-minute ceiling of Free. Free, Pro and Team keep their prices and their limits.',
  },
  {
    date: '2026-08-25',
    kind: 'fixed',
    title: 'Search dates without a timezone',
    body:
      'The since and before filters accept a date and time with no timezone and read it as UTC, instead of refusing the call.',
  },
  {
    date: '2026-08-25',
    kind: 'fixed',
    title: 'Automations keep running on OAuth connections',
    body:
      'A scheduled rule created from an OAuth connection stopped running once its access token rotated. Rules now follow the authorisation itself, which does not rotate.',
  },
  {
    date: '2026-08-25',
    kind: 'improved',
    title: 'The upgrade offer when an inbox is over the limit',
    body:
      'Connecting a mailbox above your plan limit shows the upgrade panel, in your own language, instead of a generic form error about your credentials.',
  },
  {
    date: '2026-08-24',
    kind: 'fixed',
    title: 'Sending from Exchange and Microsoft 365 over SMTP',
    body:
      'Authentication now negotiates the mechanism the server advertises. Exchange and Microsoft 365 mailboxes never offered the one that was assumed, which made sending impossible and reported a correct password as wrong.',
  },
  {
    date: '2026-08-20',
    kind: 'added',
    title: 'Labels on every provider',
    body:
      'Applying a label works as a Gmail label, an Outlook category or an IMAP keyword. Where a name has to be adjusted to fit a provider\'s rules, you are told the name that was actually applied.',
  },
  {
    date: '2026-08-20',
    kind: 'improved',
    title: 'Very long emails come back in readable pieces',
    body:
      'A long message body is returned in bounded pieces, each reporting the true total and the exact point to resume from, so nothing is skipped or repeated. Ordinary mail is returned exactly as before.',
  },
  {
    date: '2026-08-19',
    kind: 'added',
    title: 'Automations: recurring triage that runs without you',
    body:
      'A saved search plus one action, on a schedule, with a record of what it did to every message. No model is in the unattended loop: mail is matched, never interpreted. Deleting is not an available action, a forward always goes to the approval queue, and a reply only ever writes a draft.',
  },
  {
    date: '2026-08-19',
    kind: 'added',
    title: 'Use it from Claude Desktop, Cursor, Cline and Windsurf',
    body:
      'npx -y mcpemails bridges the hosted server to clients that can only launch a local command. No dependencies, Node 18 or newer, and your key is only ever sent in the authorization header.',
  },
  {
    date: '2026-08-19',
    kind: 'changed',
    title: 'Plans are priced on connected inboxes',
    body:
      'Pricing moved from how many actions you take to how many mailboxes you connect, which is the thing people actually run out of. Everyone using the product at the time kept unlimited inboxes.',
  },
  {
    date: '2026-08-19',
    kind: 'improved',
    title: 'Change plan from the dashboard',
    body:
      'Switching plan or billing interval happens in place, with the difference settled on your next invoice, instead of sending you to a portal that could not make the change.',
  },
  {
    date: '2026-08-19',
    kind: 'improved',
    title: 'The usage meter warns you before the limit',
    body:
      'The action allowance is labelled for what it is, turns amber at 80 percent, and at the limit reports what is actually happening to your calls rather than guessing.',
  },
  {
    date: '2026-08-18',
    kind: 'fixed',
    title: 'Large IMAP messages and attachments',
    body:
      'Reading a very large message or pulling several big attachments no longer risks the connection dropping mid-response.',
  },
  {
    date: '2026-08-13',
    kind: 'fixed',
    title: 'Yandex mailboxes connect',
    body:
      'Yandex does not implement the shortened login handshake, and its refusal of the command was being reported as a rejection of your password. Both the handshake and the message are fixed.',
  },
  {
    date: '2026-08-10',
    kind: 'added',
    title: 'Approve a held send from its own page',
    body:
      'A send waiting for approval gets a review page showing the full message, with approve and reject. Clients that support MCP apps show the same review card inline.',
  },
  {
    date: '2026-08-10',
    kind: 'added',
    title: 'Setup guide that remembers where you stopped',
    body:
      'The dashboard keeps your setup progress, so a half-finished connection is still visible and resumable when you come back.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Approval before an agent sends anything',
    body:
      'Turn on approval for an inbox and every send, reply, forward, draft send and scheduled send is held. The agent gets a pending result, and a person in the workspace decides.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Read an attachment as text, or take the original message',
    body:
      'An attachment can be returned as readable text without handing the file itself to the model, for text, CSV, HTML, JSON and text-layer PDFs. The complete original message can also be downloaded as a portable .eml file. Extraction never runs embedded code and never does OCR.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Safe retries for outbound mail',
    body:
      'Send with an idempotency key and retrying the same request within 24 hours cannot produce a second email.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Guided workflows and per-inbox compatibility profiles',
    body:
      'Clients that support MCP prompts can offer built-in routines for triage, open-loop review, reply drafting, organising and scheduled-send review; a prompt never grants a permission and never runs on its own. Each inbox also reports a versioned profile marking every operation exact, different or unavailable on that provider.',
  },
  /* ── July 2026 ─────────────────────────────────────────────── */
  {
    date: '2026-07-28',
    kind: 'fixed',
    title: 'Drafts on a mailbox that does not call its folder Drafts',
    body:
      'Creating or listing a draft guessed at four English folder names, so a mailbox that names the folder in another language, or nests it under another folder, failed outright with a provider error. The real folder is now found by asking the mailbox, and created only if it genuinely is not there.',
  },
  {
    date: '2026-07-28',
    kind: 'fixed',
    title: 'An organize-only key can flag and archive',
    body:
      'Flagging a message and archiving one asked for permission to send mail, which neither does. Both now ask for the folder permission their sibling actions ask for, so a key deliberately granted organizing rights and withheld sending rights can use them.',
  },
  {
    date: '2026-07-23',
    kind: 'fixed',
    title: 'The signature editor saves again',
    body:
      'Every save from the signature editor, in both rich text and HTML source mode, failed with an empty error, because the sanitizer that save path runs crashed on load in production. Saving works again, and the reply-mode selector no longer pushes the Save button off the edge of the screen.',
  },
  {
    date: '2026-07-21',
    kind: 'fixed',
    title: 'IMAP search covers every folder',
    body:
      'A search with no folder filter looked only in the Inbox on IMAP, so older mail in Sent or Archive returned nothing. It now fans out across every selectable mailbox and merges the results by date.',
  },
  {
    date: '2026-07-21',
    kind: 'added',
    title: 'HTML source mode in the signature editor',
    body:
      'Paste a signature exported from another mail client, including the table-based layouts most generators produce, and it survives intact.',
  },
  {
    date: '2026-07-09',
    kind: 'added',
    title: 'Self-hosting, under AGPL-3.0',
    body:
      'The server is licensed AGPL-3.0 and ships as a container stack you can run against your own database, using the same code as the hosted service. The self-hosting page covers the one-command install and where the two paths differ.',
  },
  {
    date: '2026-07-08',
    kind: 'added',
    title: 'Rich signature editor',
    body:
      'Formatting, headings, lists, links, colour and hosted logo images, with a live preview of exactly what gets appended to your mail.',
  },
  {
    date: '2026-07-07',
    kind: 'added',
    title: 'Copy a message into another folder',
    body:
      'Messages can be duplicated into a second folder instead of only moved, one at a time or in a batch, on IMAP, Outlook and Fastmail.',
  },
  {
    date: '2026-07-01',
    kind: 'fixed',
    title: 'Sending a draft requires permission to send',
    body:
      'Sending a draft was gated on the permission to manage drafts rather than the permission to send, so a key granted drafts alone could put mail on the wire without the consent composing a message has always required. Sending a draft now requires send:email. Reported by an outside researcher.',
  },
  /* ── June 2026 ─────────────────────────────────────────────── */
  {
    date: '2026-06-24',
    kind: 'added',
    title: 'Security and trust page',
    body:
      'A page setting out what is accessed and what is stored, alongside a security.txt, the list of subprocessors and a vulnerability disclosure safe harbour.',
  },
  {
    date: '2026-06-24',
    kind: 'fixed',
    title: 'Connecting a client while signed out',
    body:
      'Starting a connection from a client such as Cursor or VS Code while signed out lost most of the request on the trip through sign-in and came back with "Missing code_challenge". The whole request now survives that round trip, and opening a stale authorization link no longer errors the page.',
  },
  {
    date: '2026-06-23',
    kind: 'added',
    title: 'Per-inbox email signatures',
    body:
      'A signature per connected mailbox, appended by the server on every send, reply, forward, draft and scheduled send, on every provider. On a reply it sits after your text and before the quoted thread, and a reply mode stops it repeating down a thread.',
  },
  {
    date: '2026-06-23',
    kind: 'added',
    title: 'Setup pages for the app-password providers',
    body:
      'Step-by-step connect pages for Gmail, Fastmail, iCloud, Yahoo, Zoho and Yandex, each with that provider\'s real steps and its verified settings.',
  },
  {
    date: '2026-06-23',
    kind: 'improved',
    title: 'Scheduled sends encrypted at rest',
    body:
      'The contents of a scheduled message are encrypted in the database until it goes out.',
  },
  {
    date: '2026-06-16',
    kind: 'added',
    title: 'Download one attachment at a time',
    body:
      'Fetch a single attachment by position or filename, up to 25 MB, returned as a file the client can preview or save rather than as text in the conversation.',
  },
  {
    date: '2026-06-16',
    kind: 'fixed',
    title: 'Reconnecting an inbox opens that inbox\'s own form',
    body:
      'Reconnect sent every mailbox to the Fastmail app-password form whatever the mailbox actually was, with the address and host left blank, so a password manager could fill a different account\'s login and quietly bind the address to the wrong mailbox. Reconnect now opens the form for the mailbox\'s real provider, with the address, host and ports filled in and locked so only the password is re-entered, and a connection that would attach a second address to a login already in use is refused.',
  },
  {
    date: '2026-06-04',
    kind: 'changed',
    title: 'Fewer tools, and deleting mail asks first',
    body:
      'Related actions were folded into one tool each instead of one tool per verb, leaving nine. Deleting is a tool of its own, marked destructive, so a client asks before it runs. Search results come back newest first instead of in the order the server happened to store them, Gmail reports exact unread and total counts where it can rather than an estimate, and a send can be scheduled further than a year out.',
  },
  {
    date: '2026-06-01',
    kind: 'fixed',
    title: 'Fastmail mailboxes stop asking to be reconnected',
    body:
      'A Fastmail mailbox connected with an app password was driven over Fastmail\'s JMAP interface, which refuses an app password scoped to mail, so a perfectly healthy mailbox kept reporting that it needed reconnecting. Fastmail now runs over IMAP and SMTP like the other app-password providers, and existing mailboxes were moved across without anyone reconnecting. Signing in through Fastmail itself is gone; an app password is the way in.',
  },
  /* ── May 2026 ──────────────────────────────────────────────── */
  {
    date: '2026-05-29',
    kind: 'added',
    title: 'Connect any mailbox over IMAP',
    body:
      'A mailbox no longer has to be at a provider with a button of its own. Enter the IMAP and SMTP details of any server and it connects, with the settings filled in for you on iCloud, Yahoo, Zoho and Yandex. Mail goes out through your own provider, from your own address.',
  },
  {
    date: '2026-05-29',
    kind: 'added',
    title: 'Five languages',
    body:
      'The marketing site, the docs and the dashboard in English, Norwegian, Spanish, French and Chinese.',
  },
  {
    date: '2026-05-26',
    kind: 'added',
    title: 'Workspaces, with teammates',
    body:
      'A workspace can hold more than one person. Invite a teammate by email, they accept from the link, and a role decides what they can change. Connected inboxes and API keys belong to the workspace rather than to one login.',
  },
  {
    date: '2026-05-26',
    kind: 'added',
    title: 'MCP Emails is live',
    body:
      'Connect a mailbox and work it from an AI assistant: list your inboxes, list and read messages, search, send and reply. Gmail connects with Google sign-in, Fastmail with an app password. Claude connects over OAuth straight from claude.ai; anything else uses an API key from the dashboard.',
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
