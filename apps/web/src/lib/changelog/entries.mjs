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
 * WHAT DOES NOT. Pricing, plans, billing and usage allowances are out, by a
 * decision taken on 2026-09-17: what a plan costs, what it includes, what an
 * allowance is and when it resets is the pricing page's job, and this page
 * carrying its own dated history of it only gives a reader two places to read
 * a number and one of them to get wrong. Fourteen such entries were removed
 * that day. A fix whose subject is something else may still name a plan if it
 * cannot be said otherwise, but the plan is never the news. If you are adding
 * an entry because a price, a tier or a limit moved, it does not go here.
 *
 * HOW LONG. One or two sentences: what changed for the customer, and the old
 * symptom if it was a fix. The mechanism, the root cause and the list of
 * everything that did not change stay in the commit message. A launch may run
 * longer; a bug fix may not.
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
  /* ── October 2026 ──────────────────────────────────────────── */
  {
    date: '2026-10-03',
    kind: 'improved',
    title: 'Faster mailbox reads on IMAP accounts',
    body:
      'Listing a folder, listing folders with their counts and downloading an attachment each make fewer round trips to the mail server. Results are unchanged.',
  },
  {
    date: '2026-10-02',
    kind: 'improved',
    title: 'Tool calls answer about a second sooner',
    body:
      'Account checks now run together instead of one at a time, and records are written after the answer is sent. Most noticeable on quick calls such as listing inboxes or folders.',
  },
  {
    date: '2026-10-02',
    kind: 'fixed',
    title: 'Reading a draft back works',
    body:
      'draft_read was refused outside workspaces with the in-chat draft editor. It now returns the full draft on Gmail, Outlook and IMAP.',
  },
  {
    date: '2026-10-02',
    kind: 'fixed',
    title: 'Folder aliases work on more mailboxes',
    body:
      'sent, trash, spam, drafts and archive now resolve on IMAP mailboxes that use names like "Sent Items" or "Junk E-mail" or keep them under INBOX, and archive on Gmail over IMAP searches All Mail. A folder the server briefly refuses to open says to try again, and an automation whose destination folder was deleted switches itself off after five failed runs.',
  },

  /* ── September 2026 ────────────────────────────────────────── */
  {
    date: '2026-09-26',
    kind: 'added',
    title: 'Outlook and Microsoft 365 inboxes',
    body:
      'Outlook connects with Sign in with Microsoft, over Microsoft Graph, with no app password and no IMAP settings. Personal Outlook.com, Hotmail, Live and MSN accounts connect directly; a work or school account may need an IT admin to approve the app once, and the dashboard gives you a link to send them. Reading, search, sending, drafts, scheduled sends, folders, flags and automations all work, and labels apply as Outlook categories.',
  },
  {
    date: '2026-09-26',
    kind: 'fixed',
    title: 'ChatGPT gets the access its tools need',
    body:
      'ChatGPT does not come back for more access when a tool needs it, so a connection approved as Read-only could never send. The consent screen now opens on Full access for ChatGPT, and you can still narrow it. Creating a folder that already exists now succeeds.',
  },
  {
    date: '2026-09-26',
    kind: 'fixed',
    title: 'A moved message comes back with its new id',
    body:
      'On IMAP a message gets a new id when it moves, and move returned the old one. Move and archive now return new_message_id whenever the server reports it.',
  },
  {
    date: '2026-09-25',
    kind: 'fixed',
    title: 'Connecting a mailbox never replaces one you already have',
    body:
      'Connecting an address that was already connected another way quietly converted the existing inbox. That is now refused and the working inbox is left alone.',
  },
  {
    date: '2026-09-23',
    kind: 'improved',
    title: 'Correct ChatGPT setup steps',
    body:
      'Plus and Pro accounts can add a custom connector too, through developer mode on the web, not only Business, Enterprise and Edu. The steps also now say the connector has to be switched on from the + menu in each new chat.',
  },
  {
    date: '2026-09-23',
    kind: 'improved',
    title: 'More IMAP servers can sign in',
    body:
      'Sign-in now uses LOGIN or CRAM-MD5 when the server does not offer PLAIN, so servers such as EarthLink, online.no, 163.com and aliyun.com can connect.',
  },
  {
    date: '2026-09-23',
    kind: 'improved',
    title: 'Tools accept any argument whose meaning is clear',
    body:
      'Requests are no longer refused over shape alone: a single value where a list is expected, numbers or booleans sent as text, common synonyms such as email_id for message_id, and enum values in any case are all accepted. Anything actually ambiguous is still refused.',
  },
  {
    date: '2026-09-23',
    kind: 'added',
    title: 'Cc and bcc on replies, recipients on draft send',
    body:
      'Replies and reply drafts take cc and bcc on every provider. Sending a draft can set its to, cc and bcc without touching the body or attachments.',
  },
  {
    date: '2026-09-23',
    kind: 'improved',
    title: 'The automation editor names criteria your inbox cannot run',
    body:
      'The dashboard refuses to save an automation whose filter the inbox cannot search on, and says which criterion, instead of letting the rule fail later.',
  },
  {
    date: '2026-09-20',
    kind: 'changed',
    title: 'Search says which criteria it could not apply',
    body:
      'A criterion the provider cannot search on, such as attachments on IMAP, used to be dropped silently. Search now names it in the result notes, and search-and-move and search-and-delete refuse instead.',
  },
  {
    date: '2026-09-20',
    kind: 'fixed',
    title: 'Delete and move report a message that is not there',
    body:
      'On IMAP, deleting, moving or copying a message id that no longer existed was reported as done. These actions now answer message not found for each missing id.',
  },
  {
    date: '2026-09-20',
    kind: 'fixed',
    title: 'Readable previews and contact names',
    body:
      'List and search previews no longer show raw MIME or base64 for messages with attachments, and contact_search returns decoded display names.',
  },
  {
    date: '2026-09-20',
    kind: 'fixed',
    title: 'Copy works on Gmail inboxes connected with an app password',
    body:
      'Tool descriptions said copy never works on Gmail, so assistants refused it where it does work. Copy availability now follows the connection, and inbox_list reports it per inbox.',
  },
  {
    date: '2026-09-20',
    kind: 'fixed',
    title: 'Filtering your inbox list no longer says you have none',
    body:
      'A filter that matched nothing said no mailbox was connected. It now says the filter matched nothing and lists the inboxes you do have. A new service filter finds inboxes by mail service.',
  },
  {
    date: '2026-09-17',
    kind: 'fixed',
    title: 'A forward now carries the original exactly',
    body:
      'Forwards relay the original byte for byte, with its HTML, inline images and attachments, instead of flattening it to plain text. Originals up to 25 MB, and as_attachment sends the original as a .eml instead.',
  },
  {
    date: '2026-09-17',
    kind: 'changed',
    title: 'Automations no longer accept a provider-native raw query',
    body:
      'An automation filter can no longer carry raw, a query passed straight to the mail provider. A raw value could match the whole mailbox, and nothing on the unattended path could check it. No stored rule used it, and the interactive search tools still take raw.',
  },
  {
    date: '2026-09-17',
    kind: 'fixed',
    title: 'Nothing unattended acts on a disconnected inbox',
    body:
      'Scheduled sends, held bulk plans and automation runs now require an active inbox, like every other tool call. Work queued before a mailbox was disconnected fails with a reason instead of running.',
  },
  {
    date: '2026-09-17',
    kind: 'improved',
    title: 'A draft update says whether it is still threaded',
    body:
      'Draft results now carry a threaded flag, true when the draft answers a known message.',
  },
  {
    date: '2026-09-17',
    kind: 'changed',
    title: 'Invites are re-checked when they are accepted',
    body:
      'Accepting an invite now re-checks that the workspace still exists and has room. Before, that was checked only when the invite was sent.',
  },
  {
    date: '2026-09-16',
    kind: 'added',
    title: 'Restrict the connector to your own email domain',
    body:
      'A userinfo endpoint and the openid and email scopes let a ChatGPT Business or Enterprise admin limit the connector to accounts on their own domain. These scopes grant no mail permission.',
  },
  {
    date: '2026-09-16',
    kind: 'changed',
    title: 'Tool annotations match what the tools do',
    body:
      'Only the four tools that can reach someone outside your mailbox are marked open-world, and anything that sends is marked destructive. Reading a message no longer marks it as read; use the flag action of email_organize for that.',
  },
  {
    date: '2026-09-16',
    kind: 'fixed',
    title: 'Automations: one connection per run, and a time budget that holds',
    body:
      'A run now uses one IMAP connection instead of one per matched message. A run that reaches its time limit stops at a message boundary and picks up the rest next time, instead of being cut off part way.',
  },
  {
    date: '2026-09-14',
    kind: 'fixed',
    title: 'A folder called Spam is Spam, not Junk',
    body:
      'An exact folder name or id now wins over an alias, so a mailbox with a real Spam folder is no longer sent to Junk. Deleting uses the mailbox\'s real Trash folder.',
  },
  {
    date: '2026-09-14',
    kind: 'changed',
    title: 'IMAP search covers the Inbox unless you widen it',
    body:
      'On generic IMAP, a search with no folder filter looks in the Inbox, because searching every folder ran past the time limit. Name folders in include_folders to search wider. Gmail and Outlook still search every folder.',
  },
  {
    date: '2026-09-12',
    kind: 'fixed',
    title: 'ChatGPT can connect',
    body:
      'Connecting from ChatGPT failed at the consent screen with "Client metadata could not be verified". Its list of authentication methods is now read correctly.',
  },
  {
    date: '2026-09-11',
    kind: 'fixed',
    title: 'Looking up a correspondent with a read-only connection',
    body:
      'contact_search no longer needs a permission of its own; reading mail covers it. It returns only names and addresses from messages the connection can already read.',
  },
  {
    date: '2026-09-09',
    kind: 'changed',
    title: 'Reading and writing are separate tools',
    body:
      'Tools that mixed a listing with writes are split, so a client can allow the reading half once and stop prompting. 22 tools in all, and clients connected before the split keep working.',
  },
  {
    date: '2026-09-09',
    kind: 'changed',
    title: 'Consent asks for reading first',
    body:
      'The consent screen asks for reading alone, and for the rest when something actually needs it, instead of all nine permissions up front.',
  },
  {
    date: '2026-09-09',
    kind: 'fixed',
    title: 'An approved send goes out as edited, and signed once',
    body:
      'Editing a held message before approving it now updates the formatted version too, which is what most mail clients show. Approved sends no longer carry the signature twice.',
  },
  {
    date: '2026-09-08',
    kind: 'added',
    title: 'Setup guides for 77 email providers',
    body:
      'Each page carries the IMAP and SMTP settings measured against that provider\'s own server, with the date they were last checked.',
  },
  {
    date: '2026-09-08',
    kind: 'improved',
    title: 'Connecting an inbox',
    body:
      'A mailbox at your own domain finds its mail servers automatically. Failures say what actually happened instead of "Connection failed", a slow check shows progress, and choosing a provider no longer pauses for two seconds.',
  },
  {
    date: '2026-09-08',
    kind: 'added',
    title: 'A status page, this changelog, and setup guides per client',
    body:
      '/status is built from the monitor that runs against the product every few minutes. Also new: this changelog, setup instructions for 13 MCP clients, and a dated comparison against the other email MCP servers.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Choose the sender name on each inbox',
    body:
      'Set the name recipients see per inbox, from the inbox settings or the signature tool.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Attach a file straight from another message',
    body:
      'Attach a file to a new email by pointing at the message it came from. The server fetches it, so the file never passes through the conversation.',
  },
  {
    date: '2026-09-07',
    kind: 'added',
    title: 'Forward up to 50 messages in one call',
    body:
      'Forwarding takes a list of messages, with results reported per message.',
  },
  {
    date: '2026-09-07',
    kind: 'fixed',
    title: 'A forward that never left now says so',
    body:
      'A forward that fails before anything is transmitted is reported as not sent and is safe to retry. Attachments that could not be carried are no longer quietly left off.',
  },
  {
    date: '2026-09-01',
    kind: 'added',
    title: 'Connect Gmail with an app password',
    body:
      'Gmail connects with a Google app password, like iCloud, Yahoo, Zoho and Fastmail. Signing in with Google is still offered.',
  },
  {
    date: '2026-09-01',
    kind: 'fixed',
    title: 'Send from an inbox\'s own address on any provider',
    body:
      'Naming a mailbox\'s own address as the sender now works on every provider, not only Gmail.',
  },
  {
    date: '2026-09-01',
    kind: 'fixed',
    title: 'Long subject lines with accents read correctly',
    body:
      'A long non-ASCII subject is reassembled without stray spaces inside words.',
  },
  {
    date: '2026-09-01',
    kind: 'improved',
    title: 'Clearer failures, faster IMAP',
    body:
      'Provider failures give a specific reason, action names are understood whatever their case or separator, and an abandoned IMAP connection no longer holds up the next call.',
  },
  /* ── August 2026 ───────────────────────────────────────────── */
  {
    date: '2026-08-31',
    kind: 'improved',
    title: 'Every tool declares the shape of its result',
    body:
      'All 16 tools publish an output schema, so a client can rely on structured results instead of parsing prose.',
  },
  {
    date: '2026-08-31',
    kind: 'fixed',
    title: 'Sending through hosts that refuse cloud senders',
    body:
      'Mail hosts that reject submissions from cloud providers are now reached over a non-cloud route, encrypted end to end, with a fallback to a direct connection.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'Moving mail out of Trash restores it',
    body:
      'On Gmail, moving a message out of Trash or Spam now restores it, instead of leaving it on a purge clock.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'A folder name means the same thing to every tool',
    body:
      'Folders and labels can be addressed by name, id or common alias everywhere. An unrecognised one fails with a message that names the value.',
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
      'The providers page documents how to connect each provider, its settings and what commonly breaks, with a last-verified date.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'Inviting a teammate works',
    body:
      'Every invite was refused as though the workspace were full. Fixed, and a viewer can no longer connect, disconnect or reconfigure a mailbox in someone else\'s workspace.',
  },
  {
    date: '2026-08-30',
    kind: 'fixed',
    title: 'Downloading an attachment that is not text',
    body:
      'A PDF or other non-text attachment downloaded fine but reached the assistant as an error. It now arrives with its filename, type and size, and the original message carries a checksum.',
  },
  {
    date: '2026-08-29',
    kind: 'added',
    title: 'Who is behind MCP Emails',
    body:
      'A new About page, and the legal entity, organisation number and registered address in the Terms and Privacy pages.',
  },
  {
    date: '2026-08-29',
    kind: 'improved',
    title: 'Connecting an IMAP mailbox',
    body:
      'The connect form works out the transport from the port, explains failures, and can be completed from the keyboard.',
  },
  {
    date: '2026-08-25',
    kind: 'fixed',
    title: 'Search dates without a timezone',
    body:
      'since and before accept a date and time with no timezone and read it as UTC.',
  },
  {
    date: '2026-08-25',
    kind: 'fixed',
    title: 'Automations keep running on OAuth connections',
    body:
      'A rule created from an OAuth connection stopped running once its access token rotated. Rules now follow the authorisation itself.',
  },
  {
    date: '2026-08-24',
    kind: 'fixed',
    title: 'Sending from Exchange and Microsoft 365 over SMTP',
    body:
      'SMTP authentication now uses the mechanism the server advertises. Before, sending failed and a correct password was reported as wrong.',
  },
  {
    date: '2026-08-20',
    kind: 'added',
    title: 'Labels on every provider',
    body:
      'Applying a label works as a Gmail label, an Outlook category or an IMAP keyword. If a name has to be adjusted for the provider, you are told what was applied.',
  },
  {
    date: '2026-08-20',
    kind: 'improved',
    title: 'Very long emails come back in readable pieces',
    body:
      'A long message body is returned in pieces, each with the total and the point to resume from.',
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
      'npx -y mcpemails bridges the hosted server to clients that can only launch a local command. No dependencies, Node 18 or newer.',
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
      'Yandex refused a login shortcut it does not implement, and that was reported as a wrong password. Fixed.',
  },
  {
    date: '2026-08-10',
    kind: 'added',
    title: 'Approve a held send from its own page',
    body:
      'A send waiting for approval gets a review page with the full message, approve and reject. Clients that support MCP apps show the same card inline.',
  },
  {
    date: '2026-08-10',
    kind: 'added',
    title: 'Setup guide that remembers where you stopped',
    body:
      'The dashboard keeps your setup progress, so a half-finished connection can be resumed.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Approval before an agent sends anything',
    body:
      'Turn on approval for an inbox and every send, reply, forward, draft send and scheduled send is held until a person in the workspace decides.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Read an attachment as text, or take the original message',
    body:
      'Text, CSV, HTML, JSON and text-layer PDF attachments can be returned as readable text, and the original message downloaded as a .eml. Extraction never runs embedded code and never does OCR.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Safe retries for outbound mail',
    body:
      'Send with an idempotency key and a retry within 24 hours cannot produce a second email.',
  },
  {
    date: '2026-08-03',
    kind: 'added',
    title: 'Guided workflows and per-inbox compatibility profiles',
    body:
      'Clients that support MCP prompts can offer routines for triage, reply drafting, organising and scheduled-send review. Each inbox also reports which operations are exact, different or unavailable on its provider.',
  },
  /* ── July 2026 ─────────────────────────────────────────────── */
  {
    date: '2026-07-28',
    kind: 'fixed',
    title: 'Drafts on a mailbox that does not call its folder Drafts',
    body:
      'Drafts failed on mailboxes that name the folder in another language or nest it. The real folder is now found by asking the mailbox.',
  },
  {
    date: '2026-07-28',
    kind: 'fixed',
    title: 'An organize-only key can flag and archive',
    body:
      'Flagging and archiving asked for permission to send. They now ask for the folder permission, like the other organize actions.',
  },
  {
    date: '2026-07-23',
    kind: 'fixed',
    title: 'The signature editor saves again',
    body:
      'Every save from the signature editor failed with an empty error. Fixed, and the Save button no longer gets pushed off screen.',
  },
  {
    date: '2026-07-21',
    kind: 'fixed',
    title: 'IMAP search covers every folder',
    body:
      'A search with no folder filter now looks across every folder on IMAP, not only the Inbox.',
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
      'The server is licensed AGPL-3.0 and ships as a container stack you can run against your own database, the same code as the hosted service.',
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
      'Messages can be copied into another folder, one at a time or in a batch, on IMAP, Outlook and Fastmail.',
  },
  {
    date: '2026-07-01',
    kind: 'fixed',
    title: 'Sending a draft requires permission to send',
    body:
      'Sending a draft was gated on the drafts permission rather than the send permission. It now requires send:email. Reported by an outside researcher.',
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
      'Starting a connection from a client such as Cursor or VS Code while signed out failed with "Missing code_challenge". The request now survives the trip through sign-in.',
  },
  {
    date: '2026-06-23',
    kind: 'added',
    title: 'Per-inbox email signatures',
    body:
      'A signature per mailbox, appended by the server to everything it sends, on every provider. A reply mode stops it repeating down a thread.',
  },
  {
    date: '2026-06-23',
    kind: 'added',
    title: 'Setup pages for the app-password providers',
    body:
      'Step-by-step connect pages for Gmail, Fastmail, iCloud, Yahoo, Zoho and Yandex.',
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
      'Fetch a single attachment by position or filename, up to 25 MB, as a file rather than text in the conversation.',
  },
  {
    date: '2026-06-16',
    kind: 'fixed',
    title: 'Reconnecting an inbox opens that inbox\'s own form',
    body:
      'Reconnect sent every mailbox to the Fastmail form with blank fields, where a password manager could fill in a different account. It now opens the right provider\'s form with everything but the password locked.',
  },
  {
    date: '2026-06-04',
    kind: 'changed',
    title: 'Fewer tools, and deleting mail asks first',
    body:
      'Related actions were folded into nine tools. Deleting is a tool of its own, marked destructive, so a client asks before it runs. Search results come back newest first.',
  },
  {
    date: '2026-06-01',
    kind: 'fixed',
    title: 'Fastmail mailboxes stop asking to be reconnected',
    body:
      'Fastmail mailboxes connected with an app password kept reporting that they needed reconnecting. Fastmail now runs over IMAP and SMTP, and existing mailboxes were moved across automatically. An app password is now the only way to connect Fastmail.',
  },
  /* ── May 2026 ──────────────────────────────────────────────── */
  {
    date: '2026-05-29',
    kind: 'added',
    title: 'Connect any mailbox over IMAP',
    body:
      'Enter the IMAP and SMTP details of any server and it connects, with the settings filled in for iCloud, Yahoo, Zoho and Yandex. Mail goes out through your own provider, from your own address.',
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
      'Invite teammates by email, with a role that decides what they can change. Inboxes and API keys belong to the workspace rather than to one login.',
  },
  {
    date: '2026-05-26',
    kind: 'added',
    title: 'MCP Emails is live',
    body:
      'Connect a mailbox and work it from an AI assistant: list, read, search, send and reply. Gmail and Fastmail to start, with Claude connecting over OAuth and other clients using an API key.',
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
