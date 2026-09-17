# OpenAI plugin submission: tool annotation justifications

The reasoning behind the annotation justification fields of the plugin
submission portal, one block per advertised tool.

Each tool block has two parts:

1. **Submitted text.** Three lines, one per hint, each at most 200 characters.
   This is the artefact that ships. Copy it into the portal field by field,
   verbatim.
2. **Reasoning.** The long-form bullets. They are why the boolean is what it
   is, for us and for anyone auditing the submission later. They are **not**
   what goes in the portal.

Condense, never contradict: the portal shows the reviewer the scanned boolean
beside your sentence, and a sentence arguing for a different value is the
specific failure the review calls out ("describing the tool as functionally
read-only in the justification doesn't make the tool read-only"). A shorter
sentence that overclaims is worse than a long one that does not.

## The short strings ship. Do not re-condense by hand

Until 2026-09-16 this file held only the long-form bullets, and the sentence
actually pasted into the portal was condensed by hand at submission time. That
put the text a reviewer reads outside version control, on a submission that had
already been rejected once for exactly the class of mismatch that arrangement
invites. Nineteen of the long bullets were over the field limit, some by three
times, so every one of those was rewritten live in a browser field with nothing
checking it.

So: **the `Submitted text` lines are the deliverable.** Paste them unchanged.
If one will not fit, or stops being true, edit it here and re-run the test, do
not shorten it in the portal. `annotation-justifications.test.ts` enforces that
every advertised tool has all three, that each is non-empty and within the cap,
that the doc's tool set still matches the live tool surface, that no write
tool's submitted text calls itself a read, that every `error_code` the doc
quotes is one the server can emit, that a submitted string promises a dashboard
control only where this tree actually has one, and that the reversal
`draft_editor_hide`'s `destructiveHint: false` rests on is still unconditional
in the code. `tool-surface.test.ts` separately pins the three booleans against
the server.

**On the cap.** 200 characters is what this file has always claimed, and it is
what the test enforces. It could not be re-verified for this revision: the only
place the limit is stated is the portal itself, and v1.0.2 is in review, where
an edit reverts the submission to draft. Treat 200 as the budget. If the portal
turns out to allow more, the strings below are still valid; if it allows less,
they all have to be cut and the test constant moved.

**Why this file exists.** MCPEmails v1.0.0 was rejected on 2026-09-15 with "one
or more of the tool's annotations do not appear to match the tool's behaviour,
confirm the annotations are explicitly set to true or false (not null) for each
tool, and include a clear justification for why the hint is set". Two things
caused it, and both are fixed in the server rather than argued around in the
justification, which the review rules explicitly do not allow ("describing the
tool as functionally read-only in the justification doesn't make the tool
read-only"):

1. `openWorldHint` was a blanket `true` on all 17 mail tools, on the reasoning
   that they all reach an external email provider. The published rule says the
   opposite: set it **false** when the tool "is limited to a bounded private
   account or workspace, even when that service is externally hosted". One
   connected mailbox is such an account. It is now true only for the four tools
   that can address recipients outside it.
2. `destructiveHint` was `false` on `email_compose` and `schedule`, which send
   mail. The rule counts "sending messages ... you can't undo" as irreversible.
   Both are now true.

Plus one schema change: `email_read` advertised `mark_as_read`, which wrote the
\Seen flag at the provider from inside a `readOnlyHint: true` tool. The argument
was retired (2026-09-16) instead of the hint being flipped. It is still accepted
on the wire, because MCP clients cache tools/list for the life of a connection,
but it is dropped before validation and the result says so. Marking a message
read is `email_organize { action: "flag", flag_action: "read" }`, which is
annotated as the write it is.

The booleans in each heading are transcribed from the server by hand and then
pinned: `tool-surface.test.ts` fails if any of them drifts from what the
registry publishes, and if this file documents a tool `tools/list` does not
advertise, or misses one it does.

Rules applied throughout:

- **readOnlyHint true** only where the tool strictly fetches. Anything that can
  create, update, delete, send or enqueue, in any mode or through any default,
  is false.
- **destructiveHint true** where an outcome cannot be undone: mail destroyed, a
  folder or rule removed, or a message delivered to someone outside the account.
- **openWorldHint true** only where the tool can reach a party outside the one
  connected mailbox.

Every tool operates on mailboxes the account owner connected themselves, under
a per-key scope grant and the key's own inbox allowlist, and no tool can reach
another workspace's mail. All but two act on a single inbox per call, and both
exceptions are bounded sets of the workspace's own accounts rather than anything
outside it. `contact_search` scans, when no inbox is named, every inbox the key
may reach up to a hard cap of ten (`CONTACT_SEARCH_MAX_INBOXES`; truncation is
reported in the result). `inbox_list` enumerates them by definition, and for
each GMAIL inbox among them it makes one live call to that account's own sendAs
settings — see its block, which is the one place in this file a
`openWorldHint: false` tool touches a provider at all.

---

## inbox_list (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** Returns the mailboxes already connected to this workspace, with their addresses and capabilities. It connects nothing, changes no setting and touches no message.
- **destructiveHint:** It is a read. Nothing can be lost by calling it.
- **openWorldHint:** Only this workspace's own records, plus a Gmail inbox's own sendAs settings so its verified send-as addresses are listed. No party outside the connected accounts is contacted.

**Reasoning.**

- **readOnly true:** returns the list of mailboxes already connected to this
  workspace, with their addresses, provider, display name and capabilities. It
  connects nothing, changes no settings and touches no message.
- **destructive false:** it is a read; nothing can be lost by calling it.
- **openWorld false:** almost all of it is this workspace's own records. One
  provider call is made and must be stated rather than rounded away: for each
  GMAIL inbox the handler calls `listGmailSenderIdentities`, which is a live
  `GET https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs` for that
  connected account, so the listing can report the addresses Google has actually
  made usable as a From. It is not gated on `include_capabilities`, and
  non-Gmail inboxes make no network call at all. The hint stays FALSE because
  the reached service is the connected mailbox's own provider, acting on the
  account the owner connected — the published rule's "bounded private account,
  even when that service is externally hosted" — and not a third party. What
  changes is the sentence: "no mail provider is contacted at all" was written
  before this call was checked, and it was not true.

## email_read (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** Every action fetches: list, read, read_batch, search, attachment, extract, original. It advertises no argument that writes; mark_as_read, the one that did, was removed on 2026-09-16.
- **destructiveHint:** Nothing it does removes or alters a message. Reading an attachment copies the bytes out; it does not detach them from the message.
- **openWorldHint:** It reads one connected mailbox and fetches nothing else. Remote image sources are stripped out of an HTML body by the sanitizer, and a link comes back as text that is never followed.

**Reasoning.**

- **readOnly true:** the advertised actions are `list`, `read`, `read_batch`,
  `search`, `attachment`, `extract` and `original`. Every one fetches. As of
  2026-09-16 the tool advertises no argument that writes: `mark_as_read`, the
  one that did, was removed, and a call that still sends it has it ignored and
  is told so in the result.
- **destructive false:** nothing it does removes or alters a message. Reading an
  attachment copies bytes out; it does not detach them.
- **openWorld false:** it reads the single mailbox named on the call. It fetches
  nothing from the public internet. `sanitizeEmailHtml` rebuilds an HTML body
  from an allow-list in which the only permitted image `src` values are `cid:`
  and inline base64 data URIs for the RASTER types (`png`, `gif`, `jpeg`,
  `jpg`, `webp`, `bmp`; `data:image/svg+xml` is deliberately not among them),
  so no remote image reference survives to be fetched by anything downstream. An `http(s)` or `mailto` `href` IS kept, as
  text in the returned markup: the server never follows it, and no tool here
  can.

## email_organize (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes: move, move_batch, copy, copy_batch, archive, and set read or flagged state, always on message ids the caller passed explicitly.
- **destructiveHint:** Nothing is deleted or sent, and it only touches ids the caller named. A move is undone by a move back, a flag by the opposite flag, an archive by a move back; a copy leaves the original.
- **openWorldHint:** It rearranges mail inside the connected mailbox and transmits nothing out of it.

**Reasoning.**

- **readOnly false:** the advertised actions are `move`, `move_batch`, `copy`,
  `copy_batch`, `flag` and `archive`.
- **destructive false:** every advertised action acts only on message ids the
  caller passed explicitly, and none of them destroys mail. A move is undone by
  a move back, a flag by the opposite `flag_action`, an archive by moving the
  message back to the inbox; a copy adds a duplicate and leaves the original
  untouched (there is no inverse action for a copy, but nothing is lost by one).
  Nothing is deleted here (deletion is `email_delete`) and nothing is sent. The
  one action that acted on everything a search matched was deliberately moved
  out of this tool into `email_search_and_move`, which carries destructive:
  true, so a routine triage call cannot inherit a sweep's blast radius.
  `search_and_move` is still ACCEPTED under this name for clients that cached
  the old enum before 2026-09-09, and is not advertised; a client connecting
  today cannot see it.
- **openWorld false:** it rearranges mail inside the connected mailbox and
  transmits nothing out of it.

## email_search_and_move (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It moves messages.
- **destructiveHint:** It moves every message a caller-supplied filter matches, a set the caller never enumerated. Safeguards: an empty filter is refused, the move is capped at 500, and every moved id is reported.
- **openWorldHint:** The search and the move both happen inside the connected mailbox.

**Reasoning.**

- **readOnly false:** it moves messages.
- **destructive true:** it acts on every message a caller-supplied filter
  matches, which the caller has not enumerated and may not have seen. A filter
  that is wider than intended moves mail the user did not mean to touch, at a
  scale a per-id call cannot reach. The individual moves are reversible, but the
  set is not knowable in advance, so the tool is flagged and clients prompt.
  Safeguards: the filter must name at least one criterion or a raw query (an
  empty one is refused with "Provide at least one search criterion", not treated
  as "everything"), the call is bounded by `limit` (schema maximum 500; the
  handler's own default is the same 500, so there is no advertised `default`
  keyword to read) with `has_more` saying whether matches were left behind, and
  the result reports per-message outcomes. The destination is resolved before
  the search runs, so an unresolvable one fails fast. It is NOT true that the
  destination must already exist: `resolveFolderId` is called non-strict here,
  and for the `archive` alias on IMAP that means `createIfMissing`, so a
  destination of "archive" creates the mailbox when it is missing rather than
  refusing (deliberate — it makes a move-to-archive behave like `archive`
  instead of leaking a raw TRYCREATE). Creating an empty mailbox destroys
  nothing, so it does not move the hint, but the safeguard was overstated and
  is not claimed any more.
- **openWorld false:** the search and the move both happen inside the connected
  mailbox.

## email_delete (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It deletes mail.
- **destructiveHint:** Destroys mail, including a search-driven sweep over a set the caller never enumerated. Landing in Trash on Gmail and Outlook is a mitigation, and on IMAP permanent:true bypasses Trash entirely.
- **openWorldHint:** It destroys mail inside the connected mailbox and reaches nothing outside it.

**Reasoning.**

- **readOnly false:** it deletes mail. Advertised actions: `delete`,
  `delete_batch`, `search_and_delete`.
- **destructive true:** by definition, and for `search_and_delete` for the same
  reason as `email_search_and_move` (it acts on a matched set, not on ids the
  caller listed; an empty filter is refused there too). By default a delete
  moves the message to Trash, which on Gmail and Outlook is recoverable for a
  period; that is a mitigation, not a reason to under-state the hint. On IMAP
  `permanent: true` hard-deletes, bypassing Trash. Stated per provider because
  it is not uniform: a provider whose capability is `trash_vs_expunge:
  "trash"` — Gmail and Outlook — REFUSES `permanent: true` up front rather than
  honouring it, so on those two every delete lands in Trash. An earlier
  revision said flatly that `permanent: true` bypasses Trash, which read as a
  claim about all three providers and was true of one.
- **openWorld false:** it destroys mail inside the connected mailbox and reaches
  nothing outside it.

## email_compose (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It sends mail: send, reply and forward.
- **destructiveHint:** A delivered message cannot be recalled. Safeguards: it sends from the user's own connected account, an inbox can hold every send for human approval, and idempotency_key collapses a retry.
- **openWorldHint:** The recipients are arbitrary parties outside the account.

**Reasoning.**

- **readOnly false:** it sends mail. Advertised actions: `send`, `reply`,
  `forward`.
- **destructive true:** a delivered message cannot be recalled. This covers
  send, reply and forward. Safeguards, stated because the review asks what they
  are: the mail goes out through the user's own connected account, from their
  own address (the Gmail and Graph send APIs for those providers, the user's own
  SMTP credentials for IMAP); an inbox can be set to `send_approval_required`,
  which holds every send for a human decision instead of delivering it; and an
  `idempotency_key` collapses a retried call rather than sending twice.
- **openWorld true:** the recipients are arbitrary parties outside the account.

## folder_list (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** Lists the folders and labels that exist, with the ids the write tools take. It creates nothing, not even implicitly.
- **destructiveHint:** It is a read. No folder, label or message is changed.
- **openWorldHint:** The folder tree of the one connected mailbox.

**Reasoning.**

- **readOnly true:** lists the folders and labels that exist, with the ids the
  write tools take. It creates nothing, not even implicitly.
- **destructive false:** it is a read.
- **openWorld false:** the folder tree of the one connected mailbox.

## folder (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It creates, renames and deletes folders and labels.
- **destructiveHint:** delete is irreversible and no provider offers an undo. On Gmail it strips the label from every message carrying it; on IMAP the messages inside the mailbox can go with it.
- **openWorldHint:** Folders and labels exist inside the connected mailbox.

**Reasoning.**

- **readOnly false:** it creates, renames and deletes folders and labels.
- **destructive true:** `delete` is irreversible and no provider offers an undo.
  On Gmail deleting a label strips it from every message carrying it; on IMAP
  deleting a mailbox issues DELETE against it and the messages inside can be
  lost with it. Create and rename are reversible, but the hint is per tool and
  the delete governs.
- **openWorld false:** folders exist inside the connected mailbox.

## draft_list (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It lists unsent drafts.
- **destructiveHint:** It is a read. No draft is changed, deleted or sent.
- **openWorldHint:** Drafts live in the connected mailbox and are not transmitted by listing them.

**Reasoning.**

- **readOnly true:** lists unsent drafts.
- **destructive false:** it is a read.
- **openWorld false:** drafts live in the connected mailbox and are not
  transmitted by listing them.

## draft (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It creates, replies, updates, sends and deletes unsent drafts.
- **destructiveHint:** Two reasons: delete permanently discards an unsent draft, and send delivers it, which cannot be undone. The same approval hold and idempotency key apply as on email_compose.
- **openWorldHint:** send delivers to recipients outside the account. The other actions stay inside the mailbox, but the hint is per tool and the widest action governs.

**Reasoning.**

- **readOnly false:** advertised actions are `create`, `reply`, `update`, `send`
  and `delete`.
- **destructive true:** two independent reasons. `delete` permanently discards
  an unsent draft, and `send` delivers it, which cannot be undone. The same
  `send_approval_required` hold and idempotency key apply as on `email_compose`.
- **openWorld true:** `send` delivers to recipients outside the account. The
  other actions stay inside the mailbox, but the hint is per tool and the widest
  action governs.

## schedule_list (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It lists sends that are queued or sending, with the id cancel takes.
- **destructiveHint:** It is a read. No queued send is changed, cancelled or brought forward.
- **openWorldHint:** The queue is this workspace's own data; nothing is transmitted by reading it.

**Reasoning.**

- **readOnly true:** lists sends with status `pending` or `sending`, with the id
  `cancel` takes.
- **destructive false:** it is a read.
- **openWorld false:** the queue is this workspace's own data; nothing is
  transmitted by reading it.

## schedule (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It queues a send and cancels a queued one.
- **destructiveHint:** A scheduled send is a delivery with a delay: once it fires it is as irreversible as an immediate send. It is validated at create time, listed while pending, and cancellable until it fires.
- **openWorldHint:** The recipients are outside the account.

**Reasoning.**

- **readOnly false:** it queues a send and cancels a queued one.
- **destructive true:** a scheduled send is a delivery with a delay. `cancel`
  works only while the send is still pending, so once the queue fires the
  outcome is exactly as irreversible as an immediate send. Safeguards: the
  message is validated at create time so an invalid send is never queued, the
  queued item is visible in `schedule_list` for as long as it is pending, and
  cancel is available until the send window.
- **openWorld true:** the recipients are outside the account.

## signature_get (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** Returns the stored signature in HTML and text, whether it is enabled, its reply mode and source, and the sender display name.
- **destructiveHint:** It is a read. Nothing is written.
- **openWorldHint:** The signature is stored by this service against the inbox; reading it contacts no mail provider.

**Reasoning.**

- **readOnly true:** returns the stored signature (HTML and plain text), whether
  it is enabled, its reply/forward mode, its source, and `sender_name`, the
  display name recipients see in the From header.
- **destructive false:** it is a read.
- **openWorld false:** the signature is stored by this service against the
  inbox; reading it contacts no provider.

## signature_set (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes the stored signature, its enabled and reply-mode settings, and the sender display name.
- **destructiveHint:** It replaces signature settings on one inbox. It sends nothing and deletes no mail, and another call carrying the previous text restores it. It only affects mail sent later.
- **openWorldHint:** The write is to this service's own record for the inbox.

**Reasoning.**

- **readOnly false:** it writes the stored signature (text and/or HTML), its
  enabled flag, its reply/forward mode and the sender display name.
- **destructive false:** it replaces settings fields on one inbox. It sends
  nothing, deletes no mail, and another call carrying the previous text restores
  it. The signature only ever affects mail sent later, through the sending
  tools, which carry their own destructive flag. One side effect is worth
  stating rather than hiding: setting a signature marks its source `manual`,
  which stops Gmail auto-import for that inbox from then on. Nothing is
  destroyed by that, but it is not undone by re-writing the text.
- **openWorld false:** the write is to this service's own record for the inbox.

## automation_read (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It lists rules, reads one in full, returns run history and dry-runs a filter. The dry run applies nothing, sends nothing and claims no message in the deduplication ledger.
- **destructiveHint:** Nothing here changes a rule or a mailbox.
- **openWorldHint:** The rules are this workspace's own rows and the preview searches the connected mailbox.

**Reasoning.**

- **readOnly true:** advertised actions are `list`, `get`, `runs` and `preview`:
  list rules, read one in full, return run history, and dry-run a filter. The
  dry run is explicitly a preview: it reports what a filter matches right now,
  applies nothing, sends nothing, writes no run row, and does not claim any
  message in the `triage_seen_messages` deduplication ledger, so a later real
  run is unaffected.
- **destructive false:** nothing here changes a rule or a mailbox.
- **openWorld false:** the rules are this workspace's own rows and the preview
  searches the connected mailbox.

## automation (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It creates, updates, enables, disables and deletes unattended triage rules.
- **destructiveHint:** delete removes a rule, and an enabled rule acts on the mailbox on a schedule with no human in the loop. Rules are created disabled, may never delete mail, and cap each run (default 25, max 200).
- **openWorldHint:** A rule's action can be a forward to addresses outside the mailbox. Such a forward is always held for human approval, but that is a safeguard on delivery, not confinement to the account.

**Reasoning.**

- **readOnly false:** advertised actions are `create`, `update`, `enable`,
  `disable` and `delete` on unattended triage rules.
- **destructive true:** `delete` removes a rule, and an enabled rule then acts
  on the mailbox on a schedule with no model and no human in the loop, which is
  the widest effect any tool here has. Safeguards: a rule is created DISABLED
  and enabling is always a separate explicit call; deleting mail is not an
  available rule action and is refused (the closed set is move, label,
  mark_read, forward, draft_reply); the cadence is a fixed ladder
  (15/30/60/180/360/720/1440 minutes), not a free integer; every rule carries a
  per-run message cap (default 25, maximum 200) so one bad filter cannot run
  away before a human sees the run log; and the rule runs as the API key that
  created it and can never do more than that key may do.
- **openWorld true:** a rule's action can be `{type: "forward", to: [...]}`,
  which addresses recipients outside the mailbox. Such a forward stops at an
  approval row and is always held for a human decision regardless of the inbox's
  approval setting, but that is a safeguard on the delivery, not a reason to
  tell a client the tool is confined to the account.

## contact_search (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** A header-only scan of recent mail in the inboxes this key may reach. There is no stored contact list: it reads message headers, stores no contact record and writes nothing.
- **destructiveHint:** It is a read. No message, folder or setting is changed.
- **openWorldHint:** The corpus is the inboxes this key may reach. No directory, no public lookup, no third-party enrichment.

**Reasoning.**

- **readOnly true:** it searches correspondents already present in message
  headers, as a bounded header-only scan of a recent window. There is no stored
  contact list; it stores no contact record and writes nothing.
- **destructive false:** it is a read.
- **openWorld false:** the corpus is the connected mailboxes themselves. Note
  that unlike every other tool here it scans EVERY inbox the key may reach when
  `inbox_id` is omitted, which is the point of it ("who do I email most about
  X?"). Precisely: the workspace's active, key-accessible inboxes in creation
  order, capped at ten (`CONTACT_SEARCH_MAX_INBOXES`), with the result saying so
  when there were more. That is still a bounded set of the workspace's own connected accounts,
  which is exactly what the rule calls a bounded private workspace. No
  directory, no public lookup, no third-party enrichment.

## approval_review (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** Returns one pending send that is waiting for a human decision, so the review card can show it. It neither approves nor sends.
- **destructiveHint:** It is a read. The pending send is unchanged by looking at it.
- **openWorldHint:** The pending send is this workspace's own queued row.

**Reasoning.**

- **readOnly true:** returns one pending send that is waiting for a human
  decision, so it can be shown in the review card. It neither approves nor
  sends; approving requires the signed-in review page at `review_url`.
- **destructive false:** it is a read.
- **openWorld false:** the pending send is this workspace's own queued row.

## approval_decide (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes the decision onto a pending send.
- **destructiveHint:** decision accepts only "reject". It prevents a delivery that has not happened and destroys nothing: the request stays on record as rejected. Approving needs the signed-in review page.
- **openWorldHint:** Nothing leaves the service; the effect is that a message does not.

**Reasoning.**

- **readOnly false:** it writes the decision onto the pending send.
- **destructive false:** the only decision this tool can take is REJECT: the
  `decision` enum has one member and "approve" is refused at the handler as well
  as the schema. It prevents a delivery that has not happened, which is the
  fail-safe direction, and it destroys nothing: the request stays in the
  approval record with status `rejected`, visible in the dashboard. Approving a
  held send is a human action in the product's own UI, requiring a signed-in
  owner or admin, and is not exposed as a tool at all.
- **openWorld false:** nothing leaves the service; the effect is that a message
  does not.

## approval_update (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It edits the subject or body of a send that is waiting for approval. Recipients cannot be changed here.
- **destructiveHint:** It edits a queued item that has not been delivered. No stored mail is touched, and the edit still has to clear human approval before anything is sent. A body_text edit regenerates the HTML part.
- **openWorldHint:** The edit is to a pending row held by this service.

**Reasoning.**

- **readOnly false:** it edits the subject or body of a send that is waiting for
  approval. Besides `approval_id` it takes `subject`, `body_text` and
  `body_html` only: the recipient list is NOT editable here, and
  `additionalProperties: false` refuses an attempt.
- **destructive false:** it edits a queued item that has not been delivered.
  Nothing that has left the system is changed, no stored mail is touched, and
  the edit itself still has to clear human approval before anything is sent.
  Unless `body_html` is supplied in the same call, a `body_text` edit
  regenerates the HTML part from that text — where the held snapshot has one;
  a send that was queued as plain text stays plain text, and an oversized
  regeneration drops the part rather than writing it — so the two parts of the
  message cannot disagree. That is the fix for the 2026-09-09 incident in which they
  were written independently and the recipient read the sentence the reviewer
  believed they had replaced.
- **openWorld false:** the edit is to a pending row held by this service.

## approval_schedule (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It sets the delivery time of a pending send.
- **destructiveHint:** It changes when an approved send would go out, not whether it goes out, and another call changes it back. It cannot approve or send.
- **openWorldHint:** The change is to a pending row held by this service.

**Reasoning.**

- **readOnly false:** it sets the delivery time of a pending send.
- **destructive false:** it changes when an approved send would go out, not
  whether it goes out, and another call changes it back. Nothing is queued until
  a human approves it, and this tool cannot approve or send.
- **openWorld false:** the change is to a pending row held by this service.

## bulk_execute (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It applies a bulk plan the user previewed.
- **destructiveHint:** The plan it runs can be a bulk delete; landing in Trash on Gmail and Outlook is a mitigation, not a reason to under-state it. Only a previewed, frozen, unexpired plan runs, and only once.
- **openWorldHint:** The plan acts on mail inside the connected mailbox.

**Reasoning.**

- **readOnly false:** it applies a bulk plan the user previewed.
- **destructive true:** the plan it runs can be a bulk delete. That the delete
  lands in Trash on Gmail and Outlook is a mitigation, not a reason to
  under-state the hint. Safeguards: it takes `plan_id` and nothing else
  (`additionalProperties: false`, so a caller cannot even appear to pass
  message_ids, a folder or a permanent flag); nothing can be executed that was
  not first produced as a preview plan listing the exact frozen set of messages;
  the plan is scoped to one workspace, expires 15 minutes after creation, and
  runs at most once; and an unknown, expired, cancelled or already-run plan id
  is refused.
- **openWorld false:** the plan acts on mail inside the connected mailbox.

## bulk_cancel (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes the cancellation onto a pending plan.
- **destructiveHint:** It discards a preview that was never applied, so no mail is affected at all. Same fail-safe direction as approval_decide's reject.
- **openWorldHint:** The plan is this workspace's own row.

**Reasoning.**

- **readOnly false:** it writes the cancellation onto the pending plan.
- **destructive false:** it discards a preview that was never applied, so no
  mail is affected at all. Same fail-safe direction as `approval_decide`.
- **openWorld false:** the plan is this workspace's own row.

## draft_read (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It fetches one unsent draft so the draft editor card can show it. Nothing is written and nothing is sent.
- **destructiveHint:** It changes nothing at all.
- **openWorldHint:** The draft is inside the connected mailbox. It needs read:email as well as manage:drafts, because on IMAP and Outlook a draft id is a message id email_read already returns to the same key.

**Reasoning.**

- **readOnly true:** it fetches one unsent draft so the draft-editor card can
  show it. Nothing is written and nothing is sent.
- **destructive false:** it changes nothing at all.
- **openWorld false:** the draft is inside the connected mailbox. It also
  requires `read:email` on top of `manage:drafts`, because on IMAP and Outlook a
  draft id is a message id and `email_read` already returns the same body to the
  same key. That is a consistency rule, not a boundary.
- **When the card is switched off.** Two switches, kept apart, each with its
  own error code, and both refuse before anything is read. `workspaceGate`
  returns `workspaces.draft_editor_enabled` (our rollout) and
  `workspaces.draft_editor_hidden` (the user's opt-out) as SEPARATE fields
  rather than one ANDed boolean, and `gateDraftTool` additionally reads
  `inboxes.draft_editor_hidden` for the inbox the call resolved to. A workspace
  that is not rolled out is refused with `error_code: draft_editor_disabled`;
  a card the user switched off, at EITHER the workspace or the inbox grain, is
  refused with `error_code: draft_editor_hidden` — a distinct code, because "we
  have not offered you this" and "you turned this off" are different facts.
  Either way nothing is read: no decrypted body, no envelope, only the refusal.
  The per-inbox flag did not refuse this tool until 2026-09-16, which let the
  card's restore-recovery path re-open a live editor for an inbox the user had
  switched off. It does now.
- **What the same flags do to `tools/list`.** This tool is LISTED
  unconditionally; what it loses is `_meta.ui`, on the same `drafts` gate
  `draft` uses — the workspace must be rolled out and not hidden
  (`workspaceDraftEditorEnabled` ANDs those two), and the inboxes the key can
  reach must not ALL be hidden (`allReachableInboxesHideDraftEditor`). In the
  mixed case (some hidden, some not) the metadata stays, and a hidden inbox
  instead gets no envelope from `draft` — which is the only mail tool on this
  gate (`DRAFT_EDITOR_CARD_TOOL_NAMES` has one member).
  `email_compose` and `schedule` are on a DIFFERENT gate:
  `REVIEW_CARD_TOOL_NAMES` rides `gates.outbound`, which reads
  `send_approval_required` and never looks at `draft_editor_hidden`. None of
  that is a permission boundary; the refusal above is.

## draft_editor_save (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It saves the fields a person edited in the draft editor.
- **destructiveHint:** Overwrites an unsent draft, as draft's own update already does, and transmits nothing. A real body_text edit also regenerates the HTML part from that text, replacing any rich HTML there.
- **openWorldHint:** The draft stays in the connected mailbox. Sending it still goes through the draft tool, including its approval hold.

**Reasoning.**

- **readOnly false:** it saves the fields a person edited in the draft editor.
- **destructive false, and the loudest thing it does stated first:** when
  `body_text` is supplied, DIFFERS from the stored text, and the stored draft
  has an HTML part, that HTML part is REGENERATED from the new plain text
  through `plainTextBodyToHtml`. Whatever
  markup was in it is gone, and a rich HTML signature comes back as its
  plain-text form. That is a real loss of formatting, and it is deliberate: the
  alternative is the 2026-09-09 `approval_update` failure, where the two parts
  were written independently, most clients rendered the stale HTML, and the
  recipient read the sentence that had been replaced. Between losing formatting
  and silently sending wording the user replaced, this tool loses the
  formatting. It is still annotated `destructiveHint: false` because what it
  overwrites is an UNSENT draft in the user's own mailbox, which
  `draft{action:"update"}` already overwrites, and because nothing is
  transmitted and no stored mail is touched. The regenerated part is DROPPED,
  leaving the message text/plain, in two cases: when it would exceed the HTML
  body limit (escaping can multiply the input), and when it is empty — a
  cleared body should leave a message with no HTML part, not one carrying an
  empty `text/html`. Either way the message still says exactly what the user
  typed. Two narrowings of when the regeneration fires at all, both deliberate
  and both verified in the code on this branch: a `body_text` that matches the
  stored text MODULO LINE ENDINGS is treated exactly like an omitted one and
  the stored HTML part is carried through untouched (a `<textarea>` normalises
  to CRLF on submit, so an untouched body was being read as an edit and
  flattening a rich HTML part, and on IMAP moving the draft id, because every
  save appends and expunges); but a stored `body_text` that is EMPTY has
  nothing for a supplied body to be equal to, so on such a draft ANY supplied
  string is a change, the empty one included. BOTH shapes of empty count:
  `null` (no text part at all) and, since 2026-09-17, `""` as well — `mime.ts`
  parses a text/plain part that is present and empty to `""`, not `null`, and
  comparing that shape by equality carried the stored rich HTML through an
  explicit clear, which is the exact harm this whole rule exists to prevent.
  The line-ending exemption therefore applies only where there IS a stored text
  part for the line endings to differ from. A genuine body edit still regenerates, and
  that trade-off is not softened by a character. Other safeguards: omitted fields are
  left as stored rather than blanked; recipients are validated with the same
  validator as `email_compose` before anything is written; no signature is
  applied, so a saved draft cannot end up with two; and a draft that carries
  attachments is refused outright on IMAP and Gmail (whose updates rebuild the
  MIME from parameters and would drop them) rather than being rebuilt without
  them, while Outlook, whose update is a field PATCH, may proceed.
- **openWorld false:** the draft stays in the connected mailbox. Sending it
  still goes through `draft`, including its approval hold.
- **When the card is switched off.** Same gate as `draft_read`, with the same
  two codes. Not rolled out is `draft_editor_disabled`; switched off by the
  user, at the WORKSPACE grain or at the grain of the INBOX this call resolved
  to, is `draft_editor_hidden`. The refusal happens before the stored draft is
  read, so nothing is read and nothing is written. As with `draft_read`, the
  per-inbox flag did not refuse this tool until 2026-09-16.

## draft_editor_hide (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes a display preference: inboxes.draft_editor_hidden for one mailbox, or workspaces.draft_editor_hidden for all of them.
- **destructiveHint:** Nothing is lost and nothing is sent; it only decides whether the draft editor card renders. Drafts and every other tool behave identically, and hidden:false sets it back at either scope.
- **openWorldHint:** It writes one column in the caller's own workspace. The inbox is resolved through the same gate every other draft tool uses, so it can only address a mailbox this key may already use.

**Reasoning.**

- **readOnly false:** it writes a display preference,
  `inboxes.draft_editor_hidden` for one mailbox or
  `workspaces.draft_editor_hidden` for all of them. `scope` is required and has
  no default; `hidden` defaults to true.
- **destructive false:** nothing is lost and nothing is sent. It changes only
  whether the draft editor card is rendered; drafts, sending and every other
  tool behave identically either way, and the result of a draft call is the same
  text it has always been.
- **How it is reversed, precisely — and this is the `destructiveHint: false`
  argument, nothing else.** The same call with `hidden: false` restores the
  card, at BOTH scopes, because this tool is the only one that passes
  `allowWhileHidden: true` to the shared gate, and it passes it
  UNCONDITIONALLY, in both directions. So the tool that writes the opt-out
  column never consults the opt-out column. That is the whole mechanism, and it
  was not true before 2026-09-16: the gate used to AND the rollout flag with the
  workspace opt-out into one boolean, so a workspace-scope hide disabled the
  only tool that could undo it, and `hide{scope:"workspace", hidden:false}` came
  back `draft_editor_disabled`. Everything that does real work still gates:
  `scope` must be `"inbox"` or `"workspace"`, the inbox is resolved through the
  key's own allowlist, the workspace must be rolled out, and workspace grain
  needs owner or admin. The ONLY check `allowWhileHidden` skips is the opt-out
  itself, and this is the only tool that passes it — `draft_read` and
  `draft_editor_save`, which do return a body and do rewrite a draft, still pay
  it. A side effect of skipping it: this tool no longer answers "is the editor
  hidden?" through its error code, and no longer pays for the per-inbox read.
- **And there is now a second way back, in the dashboard.** The tool reversing
  itself is the argument above and carries the annotation on its own; this is an
  additional route, not a replacement for it, and it is narrower than the tool
  in two ways. It is a screen, so only a signed-in human reaches it, never a
  key; and each grain has its own role rule. Both controls render only for a
  workspace that is rolled out. The workspace-wide switch lives in Settings and
  is editable by an owner or an admin only — a member or a viewer still SEES it,
  read-only with the reason stated, so the card's absence stays explainable. The
  per-inbox switch lives in the inbox detail modal and is editable by an owner,
  an admin or a member; a viewer gets it read-only. The workspace switch WINS:
  while it is off, the inbox control reports itself locked rather than offering
  a toggle that would change nothing, and the stored per-inbox choice is kept so
  turning the workspace back on restores it. Same two columns the tool writes,
  through `PATCH /api/workspaces/[id]` and `PATCH /api/inboxes/[id]`, and the
  screen's arithmetic is the server's, written down once in
  `apps/web/src/lib/drafts/editor-preference.ts`. See the note at the end of
  this block for which branch that is on.
- **Why idempotent — a SEPARATE property, argued separately.** Conflating
  reversibility with idempotence is how an annotation gets written that the
  spec does not support, so: reversibility says another call can undo this, and
  is the `destructiveHint: false` argument above. `idempotentHint: true` is the
  MCP spec's narrower claim that repeating THIS call with THESE arguments has no
  ADDITIONAL EFFECT ON THE ENVIRONMENT. It holds because the write is an
  assignment and not an increment or an append: `setDraftEditorHidden(scope,
  target, hidden)` sets one boolean column to a literal, so the state after N
  identical calls is the state after one, with nothing accumulated and nothing
  else touched. Since 2026-09-16 the RESPONSE matches the effect too — a
  repeated `hide{hidden: true}` is no longer refused, because the unconditional
  `allowWhileHidden` removed the only check that could refuse it — so a client
  retrying a timed-out call gets the same receipt rather than an error. That is
  a nicety; the hint would be correct either way, since it is about effect.
- **Authorization: `manage:drafts` at both grains, plus owner or admin at
  workspace grain.** The scope argument is the same as before — `manage:drafts`
  already lets a caller rewrite a draft's entire body, so a preference about how
  that draft is DISPLAYED cannot sensibly be harder to change than the draft.
  That reasoning is sound at inbox grain, where the blast radius is the caller's
  own mailbox, and it does not carry to workspace grain, where the blast radius
  is every colleague's screen. The dashboard had already decided this about the
  same column (`PATCH /api/workspaces/[id]` writes
  `workspaces.draft_editor_hidden` only for an owner or an admin), so since
  2026-09-16 the tool matches it: `scope: "workspace"` looks up the caller's
  `workspace_members.role` and refuses anything but `owner` or `admin` with
  `error_code: insufficient_role`, telling them to use `scope: "inbox"` or to
  ask an owner or admin. The check runs AFTER the gate, so it cannot be used as
  a rollout oracle, and it applies in BOTH directions: un-hiding for everyone is
  as much a decision about other people's screens as hiding is. The role comes
  from `api_keys.created_by`; a key without one, or a role lookup that fails,
  reads as `null` and is refused rather than waved through. `scope: "inbox"`
  pays no role lookup at all.
- **openWorld false:** it touches one column in the caller's own workspace and
  reaches nothing outside it. The inbox is resolved through the same
  `resolveInboxArg` every other mail tool uses, which applies both the workspace
  filter and the key's `inbox_ids` allowlist, so it can only ever address a
  mailbox the calling key is already allowed to use, and both writes are scoped
  by `workspace_id` as well as by id.

> **The dashboard promise: both halves of this note have now changed, in
> opposite directions.**
>
> Two rounds of this document carried an open code defect here. It is closed,
> and the fact that made it a defect has also gone away. Recording both, because
> a reader of an older revision will otherwise take the old note at face value.
>
> **1. The promise is gone from the code.** `draft_editor_hide`'s advertised
> description — the text `tools/list` publishes and the model reads — used to
> end "The person can also change this in the dashboard", and five other
> user-visible strings in `mcp-app-drafts.ts` made the same offer: both branches
> of the `draft_editor_hidden` refusal, the `insufficient_role` refusal, the
> `provider_error` refusal, and the hide receipt's way-back line. All six were
> rewritten. Re-verified on this branch: the advertised description now ends
> "Hiding or showing it for the WHOLE workspace changes it for every member, so
> that scope needs a workspace owner or admin; one inbox needs no extra role",
> and each refusal names the tool route instead. `mcp-app-drafts.test.ts` holds
> it there from both sides — one test walks every string in every advertised
> tool definition (description, `inputSchema`, `outputSchema` and `annotations`,
> not just the top-level description), another drives every `draftFailure` /
> `invalidArgs` / `draftNotFound` site and all five success envelopes through
> the real dispatcher and walks every string in each result. The only carve-outs
> are for the `dashboard_url` field describing itself and for naming that
> identifier.
>
> **2. A dashboard control now exists.** It shipped on `feat/draft-editor-toggle`
> → `toggle/round2` (`c39b3de`): a workspace-wide switch in Settings and a
> per-inbox switch in the inbox detail modal, in all five locales
> (`en`, `es`, `fr`, `nb`, `zh`), over the same two columns the tool writes. Who
> can reach it, and the workspace switch overriding the inbox one, are set out in
> the reversal bullet above. Be exact about branch state: those files are NOT in
> `apps/web` on this branch. `grep -rniI draft_editor apps/web` here still
> matches only `app/api/workspaces/[id]/route.ts`,
> `app/api/inboxes/[id]/route.ts` and the generated `src/types/database.types.ts`.
> The control is real and merged-pending, not shipped-here.
>
> **What this changes for the annotation: nothing.** `destructiveHint: false`
> rests on the reversal, and since 2026-09-16 the tool reverses itself at both
> scopes without help. That was already enough before the dashboard existed and
> is still the argument; the dashboard is a second route, and the submitted text
> deliberately does not mention it. A reviewer cannot see our dashboard, and a
> justification that leans on a screen they cannot check is weaker than one that
> describes the tool in front of them, not stronger.
>
> **What is now a CODE change, and is not made here.** Those six strings and
> three code comments say a dashboard control does not exist ("as of 2026-09-17
> `grep -rni draft_editor apps/web` matches two API routes and the generated
> types"). Once the toggle branches merge that is stale, and the comments
> themselves name the six strings to revisit. Nothing becomes FALSE to a user by
> merging — the tool route the strings offer keeps working, and an omission is
> not a false promise, which is why this is not a submission blocker — but the
> strings should re-offer the dashboard and the comments should stop asserting
> its absence. Do that in `mcp-app-drafts.ts`, in the merge that brings the
> control in. Not here, and not before it lands: re-offering a screen that is
> not deployed yet is the original defect with the sign flipped.
>
> **Previously recorded here and now FIXED, kept only so a reader of an older
> revision is not misled.** The other code issue this note used to carry — "at
> `scope: "workspace"` the hide disables the tool that would undo it" — landed as
> a fix on 2026-09-16, along with the `draft_editor_hidden` error code and the
> owner/admin check at workspace grain. All three are in the server this revision
> was written against and are described above.
