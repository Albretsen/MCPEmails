# OpenAI plugin submission: tool annotation justifications

The reasoning behind every tool annotation an OpenAI client is shown, one block
per tool on the per-operation listing.

**Which listing this is.** Since 2026-10-13 the server lists a ChatGPT or Codex
key one tool per operation (`PER_OPERATION_LISTING` in
`supabase/functions/mcp-server/index.ts`), because OpenAI's scan rejects a tool
that selects its operation through an `action` argument ("Please expose each
model-callable operation upfront as a separate tool"). That listing is what the
portal scans, so it is what this file documents. Every other client is still
listed the consolidated tools (`email_organize`, `draft`, ...), which are not
described here.

**The portal no longer asks for these strings.** Since the move to ZIP upload
the listing comes from the plugin package and the annotations are judged by
the scan alone. The submitted text below is kept, and still tested, because it
is the record of why each boolean is what it is, and the place to answer from
if a reviewer asks.

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
2. `destructiveHint` was `false` on the tools that send mail (then the
   consolidated `email_compose` and `schedule`). The rule counts "sending messages ... you can't undo" as irreversible.
   Both are now true.

Plus one schema change: `email_read` advertised `mark_as_read`, which wrote the
\Seen flag at the provider from inside a `readOnlyHint: true` tool. The argument
was retired (2026-09-16) instead of the hint being flipped. It is still accepted
on the wire, because MCP clients cache tools/list for the life of a connection,
but it is dropped before validation and the result says so. Marking a message
read is `email_flag { flag_action: "read" }`, which is annotated as the write
it is.

The booleans in each heading are transcribed from the server by hand and then
pinned: `tool-surface.test.ts` fails if any of them drifts from what the
registry publishes, and if this file documents a tool `tools/list` does not
advertise, or misses one it does.

Rules applied throughout:

- **readOnlyHint true** only where the tool strictly fetches. Anything that can
  create, update, delete, send or enqueue, in any mode or through any default,
  is false.
- **destructiveHint true** on every write that is not purely additive. That is
  OpenAI's wording as applied by the 2026-10-13 scan: false is for additive
  writes only, an overwrite counts as destructive, and "Being able to undo an
  action does not, by itself, justify setting destructiveHint to false." So it
  is true for mail destroyed or delivered, and also for a move, an archive, a
  flag change, a rename, an overwrite, a cancellation, and an automation's
  update, enable and disable. It is false on exactly six writes, which only
  ever add: `email_copy`, `email_copy_batch`, `folder_create`, `draft_create`,
  `draft_reply` and `automation_create`. `per-operation-surface.test.ts` pins
  that list.
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

## email_list (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It lists recent messages in one inbox, optionally by folder or unread state. It takes no argument that writes.
- **destructiveHint:** It is a read. No message is changed, moved or marked by listing it.
- **openWorldHint:** It reads one connected mailbox and fetches nothing else.

## email_read (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It fetches the full content of one message. It takes no argument that writes; mark_as_read, the one that did, was removed on 2026-09-16.
- **destructiveHint:** Nothing it does removes or alters a message. The read state is left as it was.
- **openWorldHint:** It reads one connected mailbox and fetches nothing else. Remote image sources are stripped from an HTML body by the sanitizer, and a link comes back as text that is never followed.

**Reasoning.**

- **openWorld false:** `sanitizeEmailHtml` rebuilds an HTML body from an
  allow-list in which the only permitted image `src` values are `cid:` and
  inline base64 data URIs for the raster types, so no remote image reference
  survives to be fetched by anything downstream. An `http(s)` or `mailto` `href`
  is kept as text in the returned markup: the server never follows it, and no
  tool here can.

## email_read_batch (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It fetches up to 50 messages by id in one call, with bodies windowed. It takes no argument that writes.
- **destructiveHint:** Nothing it does removes or alters a message.
- **openWorldHint:** It reads one connected mailbox and fetches nothing else. Bodies pass through the same sanitizer as a single read.

## email_search (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It runs a search over one inbox and returns the matching messages. It applies nothing to them.
- **destructiveHint:** It is a read. A search changes no message and no folder.
- **openWorldHint:** The search runs inside the connected mailbox, through that mailbox's own provider.

## email_attachment (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It downloads one attachment of one message.
- **destructiveHint:** Reading an attachment copies the bytes out. It does not detach them from the message.
- **openWorldHint:** The bytes come from the connected mailbox and go only to the caller.

## email_extract (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It returns the readable text of one attachment, without its bytes.
- **destructiveHint:** Nothing is changed. The attachment stays on the message as it was.
- **openWorldHint:** The text is extracted on this server from a file already in the connected mailbox. No outside service is called.

## email_original (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It returns one stored message whole, as a base64 .eml with its sha256.
- **destructiveHint:** It copies the message out. The stored message is not altered or removed.
- **openWorldHint:** The message comes from the connected mailbox and goes only to the caller.

## email_move (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It moves one message, named by id, to another folder or label.
- **destructiveHint:** A move takes the message out of the folder it was in, so it is not additive. On Gmail it also removes the INBOX label. Nothing is deleted, and it acts only on the id the caller passed.
- **openWorldHint:** It acts inside the one connected mailbox and transmits nothing out of it.

**Reasoning.**

- **destructive true:** changed from false on 2026-10-13. The earlier reading
  was that a move is undone by a move back. OpenAI's rule does not accept that
  ("Being able to undo an action does not, by itself, justify setting
  destructiveHint to false") and reserves false for additive writes. A move is
  not additive: the message leaves the folder it was in.

## email_move_batch (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It moves up to 500 messages, named by id, to another folder or label.
- **destructiveHint:** Each move takes a message out of the folder it was in, so it is not additive. Nothing is deleted, it acts only on the ids the caller passed, and every id's outcome is reported.
- **openWorldHint:** It acts inside the one connected mailbox and transmits nothing out of it.

**Reasoning.**

- **destructive true:** the same reasoning as `email_move`, at up to 500 ids a
  call. On an inbox with `bulk_review_mode = 'plan'` the move is planned and
  shown for approval before anything is touched.

## email_copy (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes: it duplicates one message into another folder.
- **destructiveHint:** Purely additive. The copy is a new message and the original stays where it was, unchanged.
- **openWorldHint:** It acts inside the one connected mailbox and transmits nothing out of it.

## email_copy_batch (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes: it duplicates up to 500 messages into another folder.
- **destructiveHint:** Purely additive. Each copy is a new message and every original stays where it was, unchanged.
- **openWorldHint:** It acts inside the one connected mailbox and transmits nothing out of it.

## email_flag (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It sets read, unread, flagged or unflagged on the messages named by id.
- **destructiveHint:** It overwrites the read or flagged state each message had, which is not additive. No message is deleted or moved, and it acts only on the ids the caller passed.
- **openWorldHint:** It acts inside the one connected mailbox and transmits nothing out of it.

**Reasoning.**

- **destructive true:** changed from false on 2026-10-13. It is the mildest
  write on the surface, and the old value rested on the opposite flag undoing
  it, which the rule does not accept. What it does is overwrite a state, and an
  unread mark that is cleared is information the user may not get back (which
  messages they had not yet read).

## email_archive (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It moves one message, named by id, out of the Inbox.
- **destructiveHint:** An archive removes the message from the Inbox, so it is not additive. The message is kept in the archive and nothing is deleted.
- **openWorldHint:** It acts inside the one connected mailbox and transmits nothing out of it.

**Reasoning.**

- **destructive true:** changed from false on 2026-10-13, for the same reason as
  `email_move`: it is a move out of the Inbox.

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

- **readOnlyHint:** It deletes one message, named by id.
- **destructiveHint:** It destroys mail. Landing in Trash on Gmail and Outlook is a mitigation, and on IMAP permanent:true bypasses Trash entirely.
- **openWorldHint:** It destroys mail inside the connected mailbox and reaches nothing outside it.

**Reasoning.**

- **destructive true:** by definition. By default a delete moves the message to
  Trash, which on Gmail and Outlook is recoverable for a period; that is a
  mitigation, not a reason to under-state the hint. On IMAP `permanent: true`
  hard-deletes, bypassing Trash. Gmail and Outlook REFUSE `permanent: true` up
  front rather than honouring it, so on those two every delete lands in Trash.

## email_delete_batch (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It deletes up to 500 messages, named by id.
- **destructiveHint:** It destroys mail, up to 500 messages a call. Landing in Trash on Gmail and Outlook is a mitigation, and on IMAP permanent:true bypasses Trash entirely.
- **openWorldHint:** It destroys mail inside the connected mailbox and reaches nothing outside it.

## email_search_and_delete (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It deletes every message a search matches, up to a limit.
- **destructiveHint:** It destroys a set of messages the caller never enumerated. Safeguards: an empty filter is refused, the sweep is capped at 500, and every deleted id is reported.
- **openWorldHint:** The search and the delete both happen inside the connected mailbox.

**Reasoning.**

- **destructive true:** for the same reason as `email_search_and_move`: it acts
  on a matched set, not on ids the caller listed. An empty filter is refused,
  and `has_more` says whether matches were left behind. On an inbox with
  `bulk_review_mode = 'plan'` the sweep is planned and shown for approval before
  anything is deleted.

## email_send (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It sends a new message.
- **destructiveHint:** A delivered message cannot be recalled. Safeguards: it sends from the user's own connected account, an inbox can hold every send for human approval, and idempotency_key collapses a retry.
- **openWorldHint:** The recipients are arbitrary parties outside the account.

**Reasoning.**

- **destructive true:** a delivered message cannot be recalled. Safeguards,
  stated because the review asks what they are: the mail goes out through the
  user's own connected account, from their own address; an inbox can be set to
  `send_approval_required`, which holds every send for a human decision instead
  of delivering it; and an `idempotency_key` collapses a retried call rather
  than sending twice.

## email_reply (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It sends a reply to an existing message.
- **destructiveHint:** A delivered reply cannot be recalled. Safeguards: it sends from the user's own connected account, an inbox can hold every send for human approval, and idempotency_key collapses a retry.
- **openWorldHint:** The reply goes to the original sender, and with reply_all to every original recipient: parties outside the account.

## email_forward (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It forwards one message, or up to 50, to new recipients.
- **destructiveHint:** A delivered forward cannot be recalled. Safeguards: it sends from the user's own connected account, an inbox can hold every send for human approval, and idempotency_key collapses a retry.
- **openWorldHint:** The recipients are arbitrary parties outside the account, and they receive the original message intact.

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

## folder_create (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes: it creates a folder, or a label on Gmail.
- **destructiveHint:** Purely additive. A new, empty folder is created and no existing folder or message is changed.
- **openWorldHint:** Folders and labels exist inside the connected mailbox.

## folder_rename (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It renames a folder, or a label on Gmail.
- **destructiveHint:** It replaces the folder's name, which is an overwrite: anything that addressed the folder by its old name no longer finds it. No message is deleted or moved.
- **openWorldHint:** Folders and labels exist inside the connected mailbox.

**Reasoning.**

- **destructive true:** changed from false on 2026-10-13. A rename overwrites
  the one name the folder had.

## folder_delete (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It deletes a folder, or a label on Gmail.
- **destructiveHint:** Irreversible, and no provider offers an undo. On Gmail it strips the label from every message carrying it; on IMAP the messages inside the mailbox can go with it.
- **openWorldHint:** Folders and labels exist inside the connected mailbox.

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

## draft_create (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes: it saves a new unsent draft.
- **destructiveHint:** Purely additive. It adds one draft to Drafts and changes no existing draft or message. Nothing is sent.
- **openWorldHint:** The draft is stored in the connected mailbox and is not transmitted to anyone.

## draft_reply (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes: it saves a new unsent reply to an existing message, kept in its thread.
- **destructiveHint:** Purely additive. It adds one draft and leaves the message it answers untouched. Nothing is sent.
- **openWorldHint:** The draft is stored in the connected mailbox and is not transmitted to anyone.

## draft_update (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It replaces fields of an existing unsent draft.
- **destructiveHint:** It overwrites the stored draft with the fields passed, and the previous body and recipients are not kept. Nothing is sent, and only the one draft named by id is touched.
- **openWorldHint:** The draft stays in the connected mailbox and is not transmitted to anyone.

**Reasoning.**

- **destructive true:** changed from false on 2026-10-13. This is the same shape
  as `signature_set`, which the scan flagged: an overwrite of stored text whose
  previous value is not kept. On IMAP the update is a replace of the stored
  message, and the draft_id changes with it.
- **`body` is optional since 2026-10-13, and that does not move the hint.** An
  update that omits `body` keeps the stored body text and overwrites only the
  recipients or subject it names, through the same merge `draft_editor_save`
  runs (`applyDraftPatch`): no signature is applied, the HTML part, Reply-To and
  threading headers are carried through, and a recipient list passed as `[]` is
  cleared. It is still an overwrite of stored fields, so it is still `true`
  under the additive-only rule; the submitted text ("the fields passed") covers
  both forms. On IMAP and Gmail, where the write rebuilds the message, a
  body-less update of a draft with attachments, inline images or other extra
  parts is refused and changes nothing (`draft_has_attachments`,
  `draft_not_rebuildable`). The result's card envelope carries the STORED body,
  so it is attached only for a key that also holds `read:email`.

## draft_send (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It sends a saved draft and removes it from Drafts.
- **destructiveHint:** A delivered message cannot be recalled. The same approval hold and idempotency key apply as on email_send, and a draft with no recipient is refused and left untouched.
- **openWorldHint:** The draft is delivered to its recipients, who are parties outside the account.

**Reasoning.**

- **destructive true:** two reasons. The draft is delivered, which cannot be
  undone, and it is removed from Drafts. The same `send_approval_required` hold
  and idempotency key apply as on `email_send`.

## draft_delete (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It discards an unsent draft.
- **destructiveHint:** It permanently removes the draft. Nothing is sent, and only the one draft named by id is touched.
- **openWorldHint:** The draft is removed from the connected mailbox. Nothing leaves it.

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

## schedule_create (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It queues a message for delivery at a future time.
- **destructiveHint:** A scheduled send is a delivery with a delay: once it fires it is as irreversible as an immediate send. It is validated at create time, listed while pending, and cancellable until it fires.
- **openWorldHint:** The recipients are outside the account.

## schedule_cancel (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It cancels one queued send, named by id.
- **destructiveHint:** It removes a send the user queued, and putting it back means scheduling the message again. Only a send still pending can be cancelled; a sent message is not affected.
- **openWorldHint:** It changes this workspace's own queue. Cancelling transmits nothing; it stops a transmission.

**Reasoning.**

- **destructive true:** changed from false on 2026-10-13. A cancellation removes
  something the user created, and nothing restores it short of scheduling the
  message again.
- **openWorld false:** `schedule_create` is open-world because it queues a
  delivery to outside recipients. Cancelling does the reverse and addresses
  nobody.

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

## signature_set (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes the stored signature, its enabled and reply-mode settings, and the sender display name.
- **destructiveHint:** It overwrites the signature settings on one inbox, and the previous text is not kept. It sends nothing and deletes no mail, and it only affects mail sent later.
- **openWorldHint:** The write is to this service's own record for the inbox.

**Reasoning.**

- **readOnly false:** it writes the stored signature (text and/or HTML), its
  enabled flag, its reply/forward mode and the sender display name.
- **destructive true:** changed from false on 2026-10-13, when OpenAI's scan
  flagged exactly this value ("marked destructiveHint: false, but its behavior
  appears to cause material loss or a hard-to-reverse change"). The old
  justification was that another call carrying the previous text restores it.
  The guideline rules that argument out in so many words, and it was also only
  true for a caller that still had the previous text: the server does not keep
  it. One side effect is worth stating rather than hiding: setting a signature
  marks its source `manual`, which stops Gmail auto-import for that inbox from
  then on, and that is not undone by re-writing the text.
- **openWorld false:** the write is to this service's own record for the inbox.

## automation_list (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It lists the workspace's automation rules with their schedule, action and health.
- **destructiveHint:** It is a read. No rule and no mailbox is changed.
- **openWorldHint:** The rules are this workspace's own rows.

## automation_get (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It returns one automation rule in full, with its filter and failure state.
- **destructiveHint:** It is a read. No rule and no mailbox is changed.
- **openWorldHint:** The rule is one of this workspace's own rows.

## automation_runs (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It returns the recent runs of one automation rule, with their counters.
- **destructiveHint:** It is a read. No rule and no mailbox is changed.
- **openWorldHint:** The run history is this workspace's own data.

## automation_preview (readOnly: true, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It dry-runs a filter and reports what it matches right now. It applies nothing, sends nothing and claims no message in the deduplication ledger.
- **destructiveHint:** Nothing here changes a rule or a mailbox, so a later real run is unaffected.
- **openWorldHint:** The preview searches the connected mailbox and nothing else.

## automation_create (readOnly: false, destructive: false, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It writes: it creates an unattended triage rule.
- **destructiveHint:** Purely additive. It adds one rule, and the rule is created DISABLED, so nothing runs because of this call. No existing rule and no mail is changed.
- **openWorldHint:** The rule's action can be a forward to addresses outside the mailbox. Such a forward is always held for human approval, but that is a safeguard on delivery, not confinement to the account.

**Reasoning.**

- **destructive false:** the one automation write that stays false. Creating
  adds a rule and nothing else, and a rule is created DISABLED: enabling is
  always a separate, explicit call, and that call (`automation_enable`) is the
  one flagged destructive.

## automation_update (readOnly: false, destructive: true, openWorld: true)

**Submitted text.**

- **readOnlyHint:** It changes an automation rule's name, filter, action, cadence or per-run cap.
- **destructiveHint:** It overwrites the stored rule, and the previous filter and action are not kept. An enabled rule then acts on new terms with no human in the loop. Rules may never delete mail, and each run is capped.
- **openWorldHint:** The new action can be a forward to addresses outside the mailbox. Such a forward is always held for human approval, but that is a safeguard on delivery, not confinement to the account.

**Reasoning.**

- **destructive true:** changed from false on 2026-10-13: an overwrite of the
  stored rule.

## automation_enable (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It turns an automation rule on.
- **destructiveHint:** It starts unattended changes to the mailbox on a schedule, with no human in the loop, which is not additive. Rules may never delete mail, and each run is capped (default 25, max 200).
- **openWorldHint:** It flips a flag on one of this workspace's own rules. Any forward the rule later makes is held for human approval.

**Reasoning.**

- **destructive true:** changed from false on 2026-10-13. Enabling is the call
  after which the mailbox changes without anyone watching. The closed set of
  rule actions (move, label, mark_read, forward, draft_reply) and the per-run
  cap bound what it can do; they do not make it additive.

## automation_disable (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It turns an automation rule off.
- **destructiveHint:** It stops unattended triage the user was relying on, so mail the rule handled is left unhandled until someone notices. The rule, its filter and its run history are kept.
- **openWorldHint:** It flips a flag on one of this workspace's own rules and transmits nothing.

**Reasoning.**

- **destructive true:** changed from false on 2026-10-13. It is the least
  destructive of the automation writes and is flagged for the rule's wording
  rather than for a loss of data: a state change, not an addition.

## automation_delete (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It deletes an automation rule.
- **destructiveHint:** It removes the rule, and its filter and action have to be written again to get it back. Run history is kept. No mail is touched by deleting a rule.
- **openWorldHint:** It removes one of this workspace's own rules and transmits nothing.

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

- **readOnlyHint:** It reads one unsent draft and returns it: recipients, subject, body and attachment names. Nothing is written and nothing is sent.
- **destructiveHint:** It changes nothing at all.
- **openWorldHint:** The draft is inside the connected mailbox. It needs read:email as well as manage:drafts, because on IMAP and Outlook a draft id is a message id email_read already returns to the same key.

**Reasoning.**

- **readOnly true:** it reads one unsent draft and returns it. `content` is the
  same plain read in both states (recipients, subject, `body_text`, attachment
  names, `untrusted_content: true`), because the model is this tool's primary
  reader. Where the draft editor card is on, `structuredContent` is the card
  envelope and the card shows it; where it is not, `structuredContent` is that
  same plain payload. Nothing is written and nothing is sent in either case.
- **The card half is marked untrusted too (2026-10-13).** With the card on,
  `structuredContent` is the editor envelope plus a top-level
  `untrusted_content: true`, so the draft's subject, recipients and body are
  flagged in both channels and not only in `content`.
- **A failed read is reported as a failed read.** The Gmail and Outlook
  readers answer "not found" only for a 404 or a malformed-id 400. A 429 or a
  5xx is `provider_error`, "could not be read, nothing was changed", where it
  used to come back as `draft_not_found`.
- **The model is meant to call it (2026-10-13).** With the card on it used to
  be listed `visibility: ["app"]`, and its `content` was a body-free summary
  line. A model then had no way to read a draft the user had edited in the
  card: `draft_list` returns no body and neither does any draft write, so the
  next `draft` update put the model's older text back over the user's. It is
  now listed `visibility: ["model", "app"]` with the card on (and with no
  `_meta` at all with it off, as before), and its `content` carries the text.
  None of the three hints moves: it was already a read that returned the body
  to any caller holding both scopes, and `visibility` was never a boundary.
- **destructive false:** it changes nothing at all.
- **openWorld false:** the draft is inside the connected mailbox. It also
  requires `read:email` on top of `manage:drafts`, because on IMAP and Outlook a
  draft id is a message id and `email_read` already returns the same body to the
  same key. That is a consistency rule, not a boundary.
- **When the card is switched off, or was never switched on.** The same
  read, without the card. `workspaceGate` returns
  `workspaces.draft_editor_enabled` (our rollout) and
  `workspaces.draft_editor_hidden` (the user's opt-out) as SEPARATE fields
  rather than one ANDed boolean, and `gateDraftTool` additionally reads
  `inboxes.draft_editor_hidden` for the inbox the call resolved to. If the
  workspace is not rolled out, or the card is off at EITHER the workspace or
  the inbox grain, this tool returns the draft as a plain payload marked
  `untrusted_content: true`, the same object in `content` and
  `structuredContent`, with no `schema_version`, no `card` and no `_meta.ui`.
  Until 2026-10-02 it refused instead (`error_code: draft_editor_disabled` and
  `error_code: draft_editor_hidden`, which `draft_editor_save` still returns).
  That refusal was a defect rather than a guard: without the drafts gate the
  tool has no `_meta.ui`, so it is listed as an ordinary model-visible tool, it
  is the only tool that returns one draft's body, and every call a model made
  to it was refused. The scopes and the inbox check are unchanged and still
  refuse before anything is read. What the 2026-09-16 fix was for still holds:
  a plain payload is not an envelope, so the card's restore-recovery path
  cannot re-open an editor from it for an inbox the user switched off.
- **What the same flags do to `tools/list`.** This tool is LISTED
  unconditionally; what it loses is `_meta.ui` (resource URI plus
  `visibility: ["model", "app"]`), on the same `drafts` gate
  the five draft writes use (`draft_create`, `draft_reply`, `draft_update`,
  `draft_send`, `draft_delete`) — the workspace must be rolled out and not hidden
  (`workspaceDraftEditorEnabled` ANDs those two), and the inboxes the key can
  reach must not ALL be hidden (`allReachableInboxesHideDraftEditor`). In the
  mixed case (some hidden, some not) the metadata stays, and a hidden inbox
  instead gets no envelope from those draft writes, which are the only mail
  tools on this gate (`PER_OPERATION_CARD_TOOL_NAMES.drafts`).
  The three sends and `schedule_create` are on a DIFFERENT gate:
  `PER_OPERATION_CARD_TOOL_NAMES.outbound` rides `gates.outbound`, which reads
  `send_approval_required` and never looks at `draft_editor_hidden`. None of
  that is a permission boundary; the scope and inbox checks are.

## draft_editor_save (readOnly: false, destructive: false, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It saves the fields a person edited in the draft editor.
- **destructiveHint:** Overwrites an unsent draft, only with what a person typed into the card, and transmits nothing. A real body_text edit also regenerates the HTML part from that text, replacing any rich HTML there.
- **openWorldHint:** The draft stays in the connected mailbox. Sending it still goes through draft_send, including its approval hold.

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
  overwrites is an UNSENT draft in the user's own mailbox, with text a person
  typed into the card themselves, and because nothing is transmitted and no
  stored mail is touched. OPEN QUESTION since 2026-10-13: `draft_update`, the
  model-callable overwrite of the same draft, is now `true` under the
  additive-only rule, and this app-only tool was left `false` because the scan
  that flagged `signature_set` did not flag it and a host that prompts on every
  destructive call would prompt on every Save in the editor. If a later scan
  flags it, the value to change is in `mcp-app-drafts.ts`. The regenerated part is DROPPED,
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
  validator as `email_send` before anything is written; no signature is
  applied, so a saved draft cannot end up with two; and a draft that carries
  attachments is refused outright on IMAP and Gmail (whose updates rebuild the
  MIME from parameters and would drop them) rather than being rebuilt without
  them, while Outlook, whose update is a field PATCH, may proceed.
- **openWorld false:** the draft stays in the connected mailbox. Sending it
  still goes through `draft_send`, including its approval hold.
- **More is refused than attachments (2026-10-13).** On IMAP and Gmail the save
  rebuilds the message from its text, and the rebuild cannot represent an
  inline image, a second text part, a calendar alternative, a signature part or
  `format=flowed` text. Those used to be dropped without a word, because none
  of them is an "attachment" to the parser. Each is now refused with
  `draft_not_rebuildable` and nothing is written, exactly as
  `draft_has_attachments` already worked. This narrows what the tool can
  overwrite and moves none of the three hints. Also since 2026-10-13: a
  recipient list supplied as `[]` is cleared on Outlook as it is elsewhere
  (Graph's PATCH used to keep it), and the stored Reply-To is carried through
  a rebuild.
- **`draft_update` can now do a partial update too (2026-10-13).** It may omit
  `body`, and when it does it runs the same merge this tool runs
  (`applyDraftPatch`): omitted fields kept, no signature, the HTML part carried
  through, and the same two refusals on IMAP and Gmail. The two tools still
  differ in who writes: this one records `last_saved_by: "user"` and is listed
  app-only, `draft_update` is the model's and is `destructiveHint: true`.
- **When the card is switched off.** The same gate `draft_read` reads, but
  here it refuses, with two codes. Not rolled out is `draft_editor_disabled`;
  switched off by the user, at the WORKSPACE grain or at the grain of the INBOX
  this call resolved to, is `draft_editor_hidden`. The refusal happens before
  the stored draft is read, so nothing is read and nothing is written. The
  per-inbox flag did not refuse this tool until 2026-09-16.

## draft_editor_hide (readOnly: false, destructive: true, openWorld: false)

**Submitted text.**

- **readOnlyHint:** It writes a display preference: inboxes.draft_editor_hidden for one mailbox, or workspaces.draft_editor_hidden for all of them.
- **destructiveHint:** It overwrites a stored display preference: whether the draft editor card renders. No mail or draft is changed and nothing is sent; hidden:false sets it back at either scope.
- **openWorldHint:** It writes one column in the caller's own workspace. The inbox is resolved through the same gate every other draft tool uses, so it can only address a mailbox this key may already use.

**Reasoning.**

- **readOnly false:** it writes a display preference,
  `inboxes.draft_editor_hidden` for one mailbox or
  `workspaces.draft_editor_hidden` for all of them. `scope` is required and has
  no default; `hidden` defaults to true.
- **The model is meant to call it (2026-10-13).** With the card on it is listed
  `visibility: ["model", "app"]`; it was `["app"]`. The card tells a person the
  card "can be brought back by asking in this chat", and once the card is
  hidden the model calling this tool with `hidden:false` is the only route that
  sentence can mean, so an app-only listing made the copy false. The server
  instructions no longer list it among the app-only tools. None of the three
  hints moves: `visibility` was never a boundary, and every argument below was
  already written on the assumption that a model calls this.
- **destructive true:** changed from false on 2026-10-13, for two reasons that
  arrived the same day. The additive-only rule the scan applied to
  `signature_set` leaves false for writes that only add, counts an overwrite as
  destructive, and says being able to undo an action does not justify false;
  this tool overwrites a stored setting and its `false` rested on exactly that
  reversibility. And it became model-callable, so it is no longer one of the
  card-only tools that rule was left unapplied to (compare the open question on
  `draft_editor_save`, which is still app-only and still `false`). What the
  write touches is unchanged: nothing is lost from the mailbox and nothing is
  sent. It changes only whether the draft editor card is rendered; drafts,
  sending and every other tool behave identically either way, and the result of
  a draft call is the same text it has always been.
- **How it is reversed, precisely. This was the whole `destructiveHint: false`
  argument; it no longer carries the annotation and is kept because the
  submitted text still states it ("hidden:false sets it back at either
  scope").** The same call with `hidden: false` restores the
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
  spec does not support, so: reversibility says another call can undo this (the
  paragraph above, which used to be the `destructiveHint: false` argument). `idempotentHint: true` is the
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
> **What this changes for the annotation: nothing.** (Written while the hint
> was `false` and rested on the reversal. It is `true` since 2026-10-13, for the
> reasons in the block above; the dashboard has no bearing on that either.)
> Since 2026-09-16 the tool reverses itself at both
> scopes without help. That was already enough before the dashboard existed;
> the dashboard is a second route, and the submitted text
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
