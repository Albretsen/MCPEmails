# OpenAI plugin submission: tool annotation justifications

The reasoning behind the annotation justification fields of the plugin
submission portal, one block per advertised tool.

Each portal field is a single line capped at **200 characters**, so what is
actually submitted is a condensed form of the matching bullet below. Condense,
never contradict: the portal shows the reviewer the scanned boolean beside your
sentence, and a sentence arguing for a different value is the specific failure
the review calls out ("describing the tool as functionally read-only in the
justification doesn't make the tool read-only").

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

The values below are generated from the live server, not transcribed by hand;
`tool-surface.test.ts` fails if any of them drifts from what this file claims.

Rules applied throughout:

- **readOnlyHint true** only where the tool strictly fetches. Anything that can
  create, update, delete, send or enqueue, in any mode or through any default,
  is false.
- **destructiveHint true** where an outcome cannot be undone: mail destroyed, a
  folder or rule removed, or a message delivered to someone outside the account.
- **openWorldHint true** only where the tool can reach a party outside the one
  connected mailbox.

Every tool operates on exactly one mailbox that the account owner connected
themselves, under a per-key scope grant, and no tool can reach another
workspace's mail.

---

## inbox_list (readOnly: true, destructive: false, openWorld: false)

- **readOnly true:** returns the list of mailboxes already connected to this
  workspace, with their addresses and capabilities. It connects nothing, changes
  no settings and touches no message.
- **destructive false:** it is a read; nothing can be lost by calling it.
- **openWorld false:** the answer comes from this workspace's own records. No
  mail provider is contacted at all.

## email_read (readOnly: true, destructive: false, openWorld: false)

- **readOnly true:** list, read, batch read, search, attachment download, text
  extraction and raw source. Every action fetches. As of 2026-09-16 the tool
  advertises no argument that writes: `mark_as_read`, the one that did, was
  removed, and a call that still sends it has it ignored and is told so in the
  result.
- **destructive false:** nothing it does removes or alters a message. Reading an
  attachment copies bytes out; it does not detach them.
- **openWorld false:** it reads the single mailbox the user connected. It
  fetches nothing from the public internet, and remote images and links in a
  message body are stripped by the sanitizer rather than followed.

## email_organize (readOnly: false, destructive: false, openWorld: false)

- **readOnly false:** it moves, copies, archives and sets read/flagged state.
- **destructive false:** every advertised action acts only on message ids the
  caller passed explicitly, and each one is undone by another call: a move back,
  an unarchive, an unflag. Nothing is deleted here (deletion is `email_delete`)
  and nothing is sent. The one action that acted on everything a search matched
  was deliberately moved out of this tool into `email_search_and_move`, which
  carries destructive: true, so a routine triage call cannot inherit a sweep's
  blast radius.
- **openWorld false:** it rearranges mail inside the connected mailbox and
  transmits nothing out of it.

## email_search_and_move (readOnly: false, destructive: true, openWorld: false)

- **readOnly false:** it moves messages.
- **destructive true:** it acts on every message a caller-supplied filter
  matches, which the caller has not enumerated and may not have seen. A filter
  that is wider than intended moves mail the user did not mean to touch, at a
  scale a per-id call cannot reach. The individual moves are reversible, but the
  set is not knowable in advance, so the tool is flagged and clients prompt.
  Safeguards: the filter must name at least one criterion (an empty filter is
  refused rather than treated as "everything"), the destination folder must
  already exist, and the result lists every message id that moved.
- **openWorld false:** the search and the move both happen inside the connected
  mailbox.

## email_delete (readOnly: false, destructive: true, openWorld: false)

- **readOnly false:** it deletes mail.
- **destructive true:** by definition, and for the search-driven action for the
  same reason as `email_search_and_move`. On Gmail and Outlook a delete lands in
  the provider's Trash and is recoverable for a period; that is a mitigation, not
  a reason to under-state the hint, and on plain IMAP servers the message can be
  expunged outright.
- **openWorld false:** it destroys mail inside the connected mailbox and reaches
  nothing outside it.

## email_compose (readOnly: false, destructive: true, openWorld: true)

- **readOnly false:** it sends mail.
- **destructive true:** a delivered message cannot be recalled. This covers
  send, reply and forward. Safeguards, stated because the review asks what they
  are: the mail goes out through the user's own SMTP credentials from their own
  address; an inbox can be set to `send_approval_required`, which holds every
  send for a human decision instead of delivering it; and an
  `idempotency_key` collapses a retried call rather than sending twice.
- **openWorld true:** the recipients are arbitrary parties outside the account.

## folder_list (readOnly: true, destructive: false, openWorld: false)

- **readOnly true:** lists the folders and labels that exist, with the ids the
  write tools take. It creates nothing, not even implicitly.
- **destructive false:** it is a read.
- **openWorld false:** the folder tree of the one connected mailbox.

## folder (readOnly: false, destructive: true, openWorld: false)

- **readOnly false:** it creates, renames and deletes folders and labels.
- **destructive true:** `delete` is irreversible and no provider offers an undo.
  On Gmail deleting a label strips it from every message carrying it; on IMAP
  deleting a mailbox removes the messages in it. Create and rename are
  reversible, but the hint is per tool and the delete governs.
- **openWorld false:** folders exist inside the connected mailbox.

## draft_list (readOnly: true, destructive: false, openWorld: false)

- **readOnly true:** lists unsent drafts.
- **destructive false:** it is a read.
- **openWorld false:** drafts live in the connected mailbox and are not
  transmitted by listing them.

## draft (readOnly: false, destructive: true, openWorld: true)

- **readOnly false:** it creates, edits, sends and deletes drafts.
- **destructive true:** two independent reasons. `delete` permanently discards
  an unsent draft, and `send` delivers it, which cannot be undone. The same
  `send_approval_required` hold and idempotency key apply as on `email_compose`.
- **openWorld true:** `send` delivers to recipients outside the account. The
  other actions stay inside the mailbox, but the hint is per tool and the widest
  action governs.

## schedule_list (readOnly: true, destructive: false, openWorld: false)

- **readOnly true:** lists sends that are queued, with the id `cancel` takes.
- **destructive false:** it is a read.
- **openWorld false:** the queue is this workspace's own data; nothing is
  transmitted by reading it.

## schedule (readOnly: false, destructive: true, openWorld: true)

- **readOnly false:** it queues a send and cancels a queued one.
- **destructive true:** a scheduled send is a delivery with a delay. `cancel`
  works only while the send is still pending, so once the queue fires the
  outcome is exactly as irreversible as an immediate send. Safeguards: the
  message is validated at create time so an invalid send is never queued, the
  queued item is visible in `schedule_list` for its whole life, and cancel is
  available until the send window.
- **openWorld true:** the recipients are outside the account.

## signature_get (readOnly: true, destructive: false, openWorld: false)

- **readOnly true:** returns the stored signature and the sender display name.
- **destructive false:** it is a read.
- **openWorld false:** the signature is stored by this service against the
  inbox; reading it contacts no provider.

## signature_set (readOnly: false, destructive: false, openWorld: false)

- **readOnly false:** it writes the stored signature and display name.
- **destructive false:** it replaces one settings field on one inbox. It sends
  nothing, deletes no mail, and the previous text is restored by another call
  with it. The signature only ever affects mail sent later, through the sending
  tools, which carry their own destructive flag.
- **openWorld false:** the write is to this service's own record for the inbox.

## automation_read (readOnly: true, destructive: false, openWorld: false)

- **readOnly true:** lists rules, reads one in full, returns run history, and
  dry-runs a filter. The dry run is explicitly a preview: it reports what a
  filter matches right now, applies nothing, sends nothing, and does not claim
  any message in the deduplication ledger, so a later real run is unaffected.
- **destructive false:** nothing here changes a rule or a mailbox.
- **openWorld false:** the rules are this workspace's own rows and the preview
  searches the connected mailbox.

## automation (readOnly: false, destructive: true, openWorld: true)

- **readOnly false:** it creates, edits, enables, disables and deletes
  unattended triage rules.
- **destructive true:** `delete` removes a rule, and an enabled rule then acts
  on the mailbox on a schedule with no model and no human in the loop, which is
  the widest effect any tool here has. Safeguards: a rule is created DISABLED
  and enabling is always a separate explicit call; deleting mail is not an
  available rule action and is refused; the cadence is a fixed ladder, not a
  free integer; every rule carries a per-run message cap (default 25, maximum
  200) so one bad filter cannot run away before a human sees the run log; the
  rule runs as the API key that created it and can never do more than that key
  may do.
- **openWorld true:** a rule's action can be `{type: "forward", to: [...]}`,
  which addresses recipients outside the mailbox. Such a forward is always held
  for human approval regardless of the inbox's approval setting, but that is a
  safeguard on the delivery, not a reason to tell a client the tool is confined
  to the account.

## contact_search (readOnly: true, destructive: false, openWorld: false)

- **readOnly true:** it searches correspondents already present in the connected
  mailbox's own message headers. It stores no contact record and writes nothing.
- **destructive false:** it is a read.
- **openWorld false:** the corpus is the connected mailbox. No directory, no
  public lookup, no third-party enrichment.

## approval_review (readOnly: true, destructive: false, openWorld: false)

- **readOnly true:** returns one pending send that is waiting for a human
  decision, so it can be shown in the review card. It neither approves nor
  sends.
- **destructive false:** it is a read.
- **openWorld false:** the pending send is this workspace's own queued row.

## approval_decide (readOnly: false, destructive: false, openWorld: false)

- **readOnly false:** it writes the decision onto the pending send.
- **destructive false:** the only decision this tool can take is REJECT. It
  prevents a delivery that has not happened, which is the fail-safe direction,
  and it destroys nothing: the request stays in the approval record with status
  `rejected`, visible in the dashboard. Approving a held send is a human action
  in the product's own UI and is not exposed as a tool at all.
- **openWorld false:** nothing leaves the service; the effect is that a message
  does not.

## approval_update (readOnly: false, destructive: false, openWorld: false)

- **readOnly false:** it edits the subject, body or recipients of a send that is
  waiting for approval.
- **destructive false:** it edits a queued item that has not been delivered.
  Nothing that has left the system is changed, no stored mail is touched, and
  the edit itself still has to clear human approval before anything is sent.
- **openWorld false:** the edit is to a pending row held by this service.

## approval_schedule (readOnly: false, destructive: false, openWorld: false)

- **readOnly false:** it sets the delivery time of a pending send.
- **destructive false:** it changes when an approved send would go out, not
  whether it goes out, and another call changes it back. It cannot approve or
  send.
- **openWorld false:** the change is to a pending row held by this service.

## bulk_execute (readOnly: false, destructive: true, openWorld: false)

- **readOnly false:** it applies a bulk plan the user previewed.
- **destructive true:** the plan it runs can be a bulk delete. That the delete
  lands in Trash on Gmail and Outlook is a mitigation, not a reason to
  under-state the hint. Safeguards: nothing can be executed that was not first
  produced as a preview plan listing the exact messages; the plan is scoped to
  one workspace and expires; and executing an unknown or already-run plan id is
  refused.
- **openWorld false:** the plan acts on mail inside the connected mailbox.

## bulk_cancel (readOnly: false, destructive: false, openWorld: false)

- **readOnly false:** it writes the cancellation onto the pending plan.
- **destructive false:** it discards a preview that was never applied, so no
  mail is affected at all. Same fail-safe direction as `approval_decide`.
- **openWorld false:** the plan is this workspace's own row.
