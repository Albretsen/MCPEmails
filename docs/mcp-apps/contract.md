# MCP App — data contract (v1)

**Owner: the orchestrating session. Every phase agent reads this file and does not change it
unilaterally.** If you need a shape changed, say so in your report and stop; do not fork the shape.

This defines the wire payloads exchanged between the MCP Emails server and the single `ui://` review-card
resource. It is deliberately narrow: the card renders exactly these fields and nothing else.

Related: `phase-0-protocol-findings.md` (protocol-level facts) and the plan at
`~/.claude/plans/jazzy-wobbling-yeti.md`.

---

## 0. Identifiers

| Name | Value |
| --- | --- |
| Resource URI | `ui://mcpemails/review-card.<build id>.html` |
| Legacy resource URI | `ui://mcpemails/review-card.html` — still served, never advertised |
| Resource mimeType | `text/html;profile=mcp-app` |
| Generated Deno module | `supabase/functions/mcp-server/ui/review-card.html.ts` (exports `REVIEW_CARD_HTML`) |
| Frontend source | `apps/mcp-app/` |

**The resource URI carries a build fingerprint** (changed 2026-09-16): the first 12 hex of
SHA-256 over the bundle, emitted by `codegen.mjs` as `REVIEW_CARD_BUILD_ID`. A changed bundle is
therefore a URI no host has seen, and an unchanged bundle keeps its URI.

This is not decoration. Claude's host caches the resource by URI and holds it across tool calls
and across a full OAuth re-authorization, so while the URI was a fixed string a card deploy could
not reach anyone already connected — measured in production, see `CONCEPT-draft-editor.md` §13.
`phase-0-protocol-findings.md` Q4 called for exactly this ("strong `ETag`-style versioning in the
URI … so hosts that *do* cache can do so safely") and v1 shipped without it.

The bare `ui://mcpemails/review-card.html` is still answered, with the *current* bundle, for
clients holding a `tools/list` from before the change. It appears in no listing and no tool
`_meta`, so nothing new can acquire it.

**A card deploy usually no longer requires reconnecting the connector** (since 2026-09-16), and
the exceptions below are not edge cases. The server declares `tools.listChanged: true` and sends
`notifications/tools/list_changed` on the first card-bearing `tools/call` after the build id moves;
the client re-reads `tools/list` and picks up the new URI. MCP 2025-06-18, Tools § *List Changed
Notification*, and its message-flow diagram is exactly this case.

A stateless POST-only server can still send one, because Streamable HTTP allows it to ride on the
response to a request the client is already making: "If the server initiates an SSE stream: … The
server MAY send JSON-RPC requests and notifications before sending the JSON-RPC response. These
messages SHOULD relate to the originating client request." So the notification is emitted ahead of
the tool result whose card is the stale thing. No session id, nothing held open.

The notification also fires when nothing about the BUNDLE changed but the listing did. Hiding the
draft editor card changes no bytes, so the build id does not move, and the invalidation is carried
instead by a sentinel (`'stale'`, `CARD_LISTING_STALE`) written into `api_keys.card_build_notified`
for every key in the workspace. Three places write it: `PATCH /api/inboxes/[id]`, `PATCH
/api/workspaces/[id]`, and `invalidateCardListings()` in the MCP server itself, which is how the
card turns *itself* off via `draft_editor_hide`. The next card-bearing call notifies and re-records
the real build id.

Five things it does **not** reach, all of them real populations rather than theoretical ones:

- **A connected client that only makes non-card-bearing tool calls.** `decideBuildNotification`
  opens with `if (!input.cardBearingTool) return { notify: false, record: null }`, so a client that
  lives on `email_read`, `email_search_and_move`, `inbox_list` and the rest is never told the
  listing moved, however long it stays connected. This is deferral rather than permanent loss — the
  invalidation is still sitting on the key and is delivered whenever a `draft` call finally
  happens — but so is the second item below, and the wait is unbounded. It is real rather than
  theoretical: `cd74d874` was created 2026-09-16 18:09:32.72Z and used repeatedly for over five
  hours (`last_used_at` 23:18:56.37Z at a 23:21:01Z read) with `card_build_notified` still NULL.
  A NULL there means the key made no card-bearing `tools/call` in all that time — which is this
  population's defining behaviour — and no `tools/list` either. The same row is the one named
  further down as the single row the watershed's placement is worth.
- **A client that does not offer `text/event-stream` in `Accept` is never notified at all.** The
  notification rides on an SSE stream, and a client that asked for `application/json` must get
  JSON. It sees the new card at its next reconnect and not before.
- **A second live connection on the same API key.** The state is per key, not per connection, and
  the transport is POST-only with no session id. Whichever connection makes the first card-bearing
  call consumes the invalidation; the other keeps its cached listing until a later change raises
  the sentinel again. This bites a **static API key pasted into more than one client** — an OAuth
  connection holds its own `api_keys` row, so two OAuth connections never share one. (A token
  rotation does *not* belong on this list: the `refresh_token` grant updates that one row in
  place, leaving `created_at` and `card_build_notified` alone, so a sentinel written before a
  refresh is still there after it.)
- **A client that abandons the stream.** The compare-and-swap that claims the notification commits
  *before* `sseResponse` writes a byte. If the client disconnects, a proxy drops the response, or
  the isolate dies mid-write, the column already reads "delivered" and that invalidation is lost
  for that key until the next change raises the sentinel again. Committing from inside the stream
  instead would re-introduce the duplicate-notification race it was added to close.
- **A re-mounted cell from an older conversation.** It replays the URI recorded when its tool call
  happened, which is a stored record rather than a live listing. No notification can reach it, and
  old conversations keep their old card.

One population it *does* reach, and only since 2026-09-16: **keys that connected before the column
existed** read NULL for a reason the code used to misread as "nothing cached", when in fact they
hold a full cached listing that was never recorded. They are told apart from genuinely new keys by
`created_at` and `last_used_at`, get exactly one notification each, and then behave normally. On
2026-09-16 22:54Z that was 58 keys across 48 workspaces, counted under the authentication filter
(`deleted_at is null AND (expires_at is null OR expires_at > now())`) — the only filter worth
quoting, since an expired key can never be notified.

The reasoning for every one of those, with the production measurements, is in
`supabase/functions/mcp-server/card-build-notify.ts`.

CSP for the resource is **empty on every axis** — the card talks to the world only through
`app.callServerTool`:

```json
{ "csp": { "connectDomains": [], "resourceDomains": [], "frameDomains": [], "baseUriDomains": [] },
  "prefersBorder": false }
```

---

## 1. Card envelope

Every payload the card renders — whether pushed as a tool result or fetched via `callServerTool` — is a
single object with a discriminator. The card switches on `card`.

```jsonc
{
  "schema_version": "review-card-v1",
  "card": "outbound_review" | "bulk_plan" | "receipt",
  "dashboard_url": "https://mcpemails.com/dashboard/approvals",  // absolute, always present
  "state": "pending" | "sent" | "scheduled" | "rejected" | "expired" | "decided_elsewhere"
         | "executed" | "cancelled" | "error",
  // exactly one of the following, matching `card`:
  "outbound": { ... },   // §2
  "plan":     { ... },   // §3
  "receipt":  { ... },   // §4
  "provider": { ... },   // §5 — present on outbound_review and bulk_plan
  "actor": {             // who may act, resolved server-side
    "can_decide": true,
    "reason": null       // e.g. "viewer_role" | "not_pending" | "expired" when can_decide is false
  }
}
```

`schema_version` is mandatory. The card refuses to render an unknown version and shows a
"update your connector" message rather than guessing.

`dashboard_url` is **envelope-level and absolute**, and every envelope carries it. It sits here rather
than only on the receipt for a specific reason: the unsupported-schema screen is precisely when the card
cannot read the rest of the envelope, and precisely when it most needs to offer a way out. A
receipt-level-only field would be unreachable there. The card must never hold an origin of its own — it
ships inside the edge function, so a hardcoded origin is deployment config baked into a build artifact.

**Gating is an explicit opt-in, never capability sniffing.** Earlier drafts of §3 said a plan is returned
"when the client is UI-capable". Phase 0 proved that is undetectable — the reference host renders apps
while sending `capabilities: {}` with no `extensions` key. Behaviour branches on per-inbox settings, all
defaulting to off, so a client that has not opted in sees byte-identical behaviour to today. The two
gates key on different columns and the distinction matters:

| Surface | Column | Effect when off |
|---|---|---|
| outbound (`email_compose`, `draft`, `schedule`) | `send_approval_required` | the send is not held, so no envelope exists and `_meta.ui` is withheld at `tools/list` |
| bulk (`email_delete`, `email_organize`) | `bulk_review_mode = 'plan'` | no plan is produced and `_meta.ui` is withheld at `tools/list` |

`send_review_mode` is **not** a gate. It selects the wording of the pending-approval `message` (inline
names the one-click `review_url`, dashboard points at the dashboard) and does not decide whether a card
is offered: a held send returns the envelope under either mode. The failure direction matters: a
wrongly-fired capability guess would
divert a scripted integration into a plan it cannot execute, so it deletes nothing and silently lapses.

### Degradation rule
Tool results MUST always carry meaningful `content` text alongside `structuredContent`, so a non-UI
client sees the same facts in prose. The card is an enhancement, never the only channel.

**This rule and §2 pull against each other, and §2 wins.** `content` is what reaches the model;
`structuredContent` is what reaches the card. So a payload carrying a decrypted body must **not** be
mirrored into `content` — which is exactly what the codebase's `jsonOk()` helper does. Hand-write a
body-free summary for `content` on any tool that returns message content. Do not reach for `jsonOk` there.

---

## 2. `outbound` — the send under review

Returned **by the gated send itself** (`email_compose` / `draft` / `schedule`, whenever
`queueSendApproval` holds the send), and by the app-only tools `approval_review`, `approval_update` and
`approval_schedule`. See §2a for the held-send response, which is a superset rather than a bare envelope.

**Contains decrypted body content and must never be placed in model context.** It travels in
`structuredContent` only; the `content` text is written separately in every case. The card calls
`ui/update-model-context` after a decision with a summary that deliberately omits the body.

```jsonc
{
  "approval_id": "uuid",
  "operation": "email_send" | "email_reply" | "email_forward" | "draft_send" | "schedule_create",
  "created_at": "2026-08-05T10:00:00Z",
  "expires_at": "2026-08-06T10:00:00Z",
  "send_at": null,                      // ISO string when operation is schedule_create or user scheduled it
  "review_url": "https://mcpemails.com/approvals/<uuid>",  // §6 — the Approve button opens this

  "identity": {                          // the sending inbox — from InboxRow
    "inbox_id": "uuid",
    "email_address": "you@example.com",
    "display_name": "Asgeir",
    "provider": "gmail" | "outlook" | "imap",
    "service": "fastmail" | "icloud" | null
  },

  "recipients": {
    "to":  ["a@x.com"],
    "cc":  [],
    "bcc_count": 0                       // count only, never the addresses
  },

  "subject": "…",
  "body": {
    "text": "…",                         // always present; the card renders this first
    "html": "…" | null,                  // sanitized in-app before render, behind a toggle
    "truncated": false                   // true when the server clipped an oversized body
  },

  "attachments": [
    { "filename": "q3.pdf", "size_bytes": 184320, "mime_type": "application/pdf" }
  ],

  "signature": {                         // what will be appended at send time
    "will_append": true,
    "source": "manual" | "gmail_import" | null,
    "preview_text": "—\nAsgeir, MCP Emails"
  },

  "requested_by": {                      // provenance of the agent that asked
    "api_key_name": "Claude",
    "client_name": "claude-ai" | null
  }
}
```

**Body size:** the server clips `body.text` / `body.html` at 64 KB each and sets `truncated: true`. The
card shows a "view full message in dashboard" link (`ui/open-link`) in that case.

---

## 2a. The held-send response

**A send that is held for approval returns the envelope directly.** This is the response
`email_compose` (send / reply / forward), `draft` (send) and `schedule` (create) produce whenever
`queueSendApproval` holds the request, i.e. whenever the sending inbox has `send_approval_required`.

### Why it is not just the envelope

An earlier version of this document assumed the model would call `approval_review` after seeing a
`pending_approval` result, and the card would render from that. It never happened, and it could not:

* the held send returned a flat `{status:"pending_approval", approval_id, inbox_id, review_url, message}`
  object with no `schema_version`, so `classifyResult` in `apps/mcp-app/src/store.ts` classified it
  `"foreign"` and the card rendered nothing (correctly: see §1's degradation rule);
* `approval_review` is `visibility: ["app"]`, which the card only calls from an already-rendered card;
* nothing in the `message` text asked the model to make the call, and adding such an instruction would
  violate the rule against writing model directives into tool output.

So the card rendered only if it was already rendered, and the `tools/list` gate that stamps `_meta.ui`
onto exactly the keys that can hold a send gated nothing.

### The shape

`structuredContent` is the pending-approval keys **plus** the §1 envelope, merged at the top level:

```jsonc
{
  // the published pending-approval keys, unchanged
  "status": "pending_approval",
  "approval_id": "uuid",
  "inbox_id": "uuid",
  "review_url": "https://mcpemails.com/approvals/<uuid>",
  "message": "This reply has not been sent. …",
  "send_at": "2026-09-01T09:00:00Z",   // schedule_create only

  // the §1 envelope, merged on top
  "schema_version": "review-card-v1",
  "card": "outbound_review",
  "state": "pending",
  "dashboard_url": "https://mcpemails.com/dashboard/approvals",
  "outbound": { … },                    // §2
  "provider": { … },                    // §5
  "actor": { "can_decide": true, "reason": null }
}
```

A superset rather than a replacement, for two reasons. The pending-approval keys are a published output
contract and callers already read them off `structuredContent`. And `isEnvelope` is structural: it
requires only `schema_version` and `card`, and ignores unknown top-level keys, so a merged payload
renders exactly as a bare envelope would.

**The two key sets are disjoint, and that is load-bearing.** A collision would silently drop one side.
`mcp-app-approvals.test.ts` asserts the disjointness and asserts that the merged object has exactly the
sum of both key counts; do not add `state`, `dashboard_url` or `card` to the pending payload, and do not
add `status` or `message` to the envelope.

### The two channels

`content` carries the **pending-approval payload alone**, pretty-printed: byte-for-byte what this path
returned before the card existed. The envelope goes only to `structuredContent`.

This is why the held-send path does not use `index.ts#jsonOk`, which puts one object in both. §7's
strongest claim, that no new information is exposed to the model by this feature, stays literally true
rather than approximately true. `outboundSummaryText` is deliberately *not* substituted for the payload's
own `message`: that helper is written for `approval_review`, where the model is asking about an approval
it may know nothing else about, whereas here the `message` already says what happened and what to do next.

### Per-operation body disclosure

The envelope's body field differs by operation, and the reasoning differs with it:

| Operation | `outbound.body` | Reasoning |
| --- | --- | --- |
| `email_send`, `email_reply`, `email_forward` | the caller's body | The model supplied it in the same request. Returning it to the card discloses nothing it did not just write. For a reply or a forward the snapshot holds the *new* body only; the quoted original is never in it. |
| `schedule_create` | the caller's body | Same: `schedule_create`'s payload is built from the tool's own `to`/`subject`/`body` arguments. |
| `draft_send` | `null` | The snapshot holds only a `draft_id`; the message lives with the provider (`contentLivesWithProvider`). A dashboard-authored draft the model has never seen therefore stays unseen, in both channels. |

In every case the body is kept out of `content`, so none of it reaches model context on this path.

### Failure behaviour

Building the envelope must never turn a queued send into an error: the approval row is already written,
and the call sites' `catch` reports "no email was sent". So a failure degrades to exactly the old
pending-approval payload, the send stays queued, and the card renders nothing, which is the pre-card
behaviour.

---

## 3. `plan` — a bulk operation awaiting execution

Returned in place of execution by `email_delete` (`delete_batch`, `search_and_delete`) and
`email_organize` (`move_batch`, `search_and_move`) when the client is UI-capable.

**The scope is server-held.** The card only ever echoes `plan_id`; it cannot widen, narrow, or restate
the selection.

```jsonc
{
  "plan_id": "uuid",
  "operation": "email_delete" | "email_organize",
  "action": "delete_batch" | "search_and_delete" | "move_batch" | "search_and_move",
  "expires_at": "2026-08-05T10:15:00Z",   // short TTL, 15 min

  "inbox": { "inbox_id": "uuid", "email_address": "you@example.com", "provider": "gmail" },

  "scope": {
    "kind": "explicit_ids" | "search",
    "description": "unread from news@ received before 2026-07-01",  // human-readable, server-rendered
    "folder": "INBOX",
    "destination": "Archive" | null       // move operations only
  },

  "match_count": 128,
  "sample": [                              // max 5, newest first — enough to recognise a mistake
    { "from": "news@example.com", "subject": "Weekly digest", "date": "2026-07-30T08:12:00Z" }
  ],
  "sample_truncated": true
}
```

`match_count` is the **exact** count the server will act on, not an estimate. If the provider cannot
give an exact count cheaply, the server must resolve ids before creating the plan.

---

## 4. `receipt` — terminal state

```jsonc
{
  "outcome": "sent" | "scheduled" | "rejected" | "expired" | "decided_elsewhere"
           | "executed" | "cancelled" | "failed",
  "headline": "Sent to a@x.com",           // server-authored, already localised
  "detail": "Delivered via Gmail API at 10:04.",
  "affected_count": 1,                     // messages sent, deleted, or moved
  "dashboard_url": "https://mcpemails.com/dashboard/approvals" | null,
  "error_code": null                       // set when outcome is "failed"
}
```

**Absolute URLs, always.** An earlier draft had `dashboard_path`, a bare path. `ui/open-link` requires an
absolute URL, which forced the card to hardcode an origin — baking deployment config into a shipped
artifact and duplicating `NEXT_PUBLIC_APP_URL`. The server already has `APP_URL`; it builds the full URL.
The same applies to §2's truncated-body affordance: send a `full_message_url`, not a path.

`state: "error"` (envelope) and `outcome: "failed"` (receipt) describe the same condition from two levels.
Both are emitted; the card accepts either.

`actor.reason` is enumerated, not free text: `"viewer_role" | "expired" | "not_pending" | "wrong_workspace"`.
Cards render an explicit message per value and a generic fallback for anything unrecognised.

---

## 5. `provider` — which capability will actually be used

Built from `getProviderCapabilities()` and `COMPATIBILITY_PROFILES` (search for them; earlier drafts of
this file cited line numbers that have since drifted). This is the "explain what will really happen"
block; it is the reason the card is more honest than a generic confirm dialog.

**Correction (2026-08-05):** an earlier draft said send caveats come from `COMPATIBILITY_PROFILES.notes`.
They do not — every note in that map is about search, folders, or delete semantics, and there is not one
send-relevant line. `COMPATIBILITY_PROFILES` is the right source for **bulk** caveats only. Send caveats
are authored in `sendProviderBlock` (`mcp-app-approvals.ts`), and the approve page's
`providerRouteFor` (`apps/web/src/lib/approvals/review.ts`) must describe the same delivery in the same
words — the card and the page disagreeing about how mail will be sent would be worse than either being
vague.

```jsonc
{
  "label": "Gmail API",                     // "Gmail API" | "Microsoft Graph" | "IMAP + SMTP"
  "route": "users.messages.send",           // the concrete call, or "SMTP submission · smtp.fastmail.com:465"
  "caveats": [                              // 0-3 lines, drawn from COMPATIBILITY_PROFILES.notes
    "Delete moves the message to Trash. Permanent delete is not available on Gmail.",
    "A move adds the destination label and removes INBOX; other labels remain."
  ]
}
```

Caveats are selected by operation, not dumped wholesale: a send card shows send-relevant notes only.

---

## 6. Security model — read this before writing any handler

**`_meta.ui.visibility` is a host UI hint, not an authorisation boundary.** Phase 0 proved it: the
reference host filters app-only tools out of the model's picker in its own application code, the SDK
exports visibility helpers and never calls them, and the server receives an app-originated `tools/call`
that is byte-identical to a model-originated one — same origin, same headers, same bearer token. A plain
SDK client called an `["app"]`-only tool successfully. See `phase-0-protocol-findings.md` Q2.

A server-issued token does not rescue this either: the model can call whichever tool hands out the token.
**Nothing the card can do, the model cannot also do.** Design accordingly.

So authority is split by reversibility:

| | Where it happens | Why |
| --- | --- | --- |
| **Approve a send** | Authenticated web page, opened via `ui/open-link` | Irreversible and exfiltration-capable. Requires a browser session the agent cannot have. |
| **Reject a send** | Inline, in the card | Fail-safe. Worst case from a hostile call is that an email doesn't go out. |
| **Execute a bulk plan** | Inline, in the card | Recoverable (provider Trash), and strictly better than today's zero-confirmation behaviour. |
| **Edit / schedule a pending send** | Inline, in the card | Neither sends anything; the send still needs the authenticated approve. |

### The approve path

The tool result for a gated send includes `review_url`:

```
https://mcpemails.com/approvals/<approval_id>
```

**No signed token, no secret.** A bare id is deliberate: a signed URL sitting in model context would itself
be a bearer capability. Here the id is useless without an authenticated session and an owner/admin role, so
it is safe for the model to hold. The card renders Approve as a button that calls `ui/open-link` with this
URL; `apps/web/app/approvals/[id]/` is a focused one-click review page reusing the existing
`PATCH /api/approvals` logic.

**Server invariant to enforce:** `approval_decide` accepts `decision: "reject"` only. `"approve"` is
rejected unconditionally at the tool layer, whatever the caller claims. Approve exists on exactly one code
path, and that path requires a Supabase session. Make this explicit in code and in a comment — it is the
single load-bearing rule of this feature.

### Tools

`approval_review` is no longer the card's entry point: a held send returns the envelope itself (§2a), and
these tools are what the card calls *after* it has rendered.

All carry `_meta.ui = { resourceUri: <the §0 fingerprinted URI>, visibility: ["app"] }` — the
`visibility` is set because well-behaved hosts will keep these out of the model's picker, which is worth
having. It is a tidiness measure, **not** a control. Audit-logged, non-billable (absent from
`BILLABLE_TOOL_NAMES`).

| Tool | Arguments | Returns |
| --- | --- | --- |
| `approval_review` | `{ approval_id }` | envelope, `card: "outbound_review"` |
| `approval_decide` | `{ approval_id, decision: "reject", note? }` | envelope, `card: "receipt"` |
| `approval_update` | `{ approval_id, subject?, body_text?, body_html? }` | envelope, `card: "outbound_review"` (re-encrypted) |
| `approval_schedule` | `{ approval_id, send_at }` | envelope, `card: "outbound_review"` with `send_at` set |
| `bulk_execute` | `{ plan_id }` | envelope, `card: "receipt"` |
| `bulk_cancel` | `{ plan_id }` | envelope, `card: "receipt"` with `outcome: "cancelled"` |

**A `body_text` edit owns the HTML part too.** This paragraph used to specify something that was never
built, and the gap shipped the exact trap it was written to prevent: `approval_update` accepted
`body_html`, wrote the two parts independently, and a `body_text`-only edit left the HTML part carrying
the pre-edit wording. Most mail clients render the HTML part, so the tool reported success, the reviewer
believed they had corrected the message, and the recipient read the sentence they had replaced. Confirmed
against production 2026-09-09 and fixed the same day.

Server behaviour, as built:

- `body_text` **and** `body_html` in one call: both are stored as given. A caller that sends HTML has
  said what the HTML should say.
- `body_html` alone: the text part is left alone, as before.
- `body_text` alone, on a message that carries an HTML part: the HTML part is **regenerated** from the
  new text (escaped, newlines to `<br>`), through the same synthesis `applySignature` uses when it builds
  an HTML alternative for a text-only send (`signature-compose.ts#plainTextBodyToHtml`). Both parts then
  say what the reviewer typed. Regenerating beats the clear-and-flag rule this paragraph used to specify:
  clearing drops the message to text/plain and loses the pair, and `format_changed` was a flag no card
  ever rendered. The visible cost is that a rich signature comes back as its plain-text form after an
  edit, which is a smaller harm than sending replaced wording.

**The signature is not re-applied on an edit,** because the new text already carries whatever signature is
going out: an `email_send` snapshot is signed before it is stored (so the reviewer edits signed text), and
a reply/forward/schedule snapshot is signed at dispatch. Adding one at edit time would double it in both
cases.

**`bulk_cancel` exists so cancelling is auditable.** Letting the plan lapse via its 15-minute TTL is
fail-safe but invisible server-side: no record that a human looked at a destructive operation and said
no. That is exactly the event worth having in the audit log.

Every handler independently re-verifies: the record is still `pending`, it belongs to the calling key's
workspace, and `expires_at` has not passed. Assume every one of these can be called by a hostile agent and
make sure that is merely useless rather than harmful.

Failure responses use the envelope with `state: "expired" | "decided_elsewhere" | "error"` and a populated
`receipt`, so the card always has something coherent to render.

---

## 7. Model-context discipline

This is a **context-hygiene** property, not a security guarantee — the distinction matters and we must not
market it as more than it is. Since the model can call `approval_review` itself, the body is not sealed away
from it. What we get is that the normal flow does not *re-inject* the message into the conversation, and the
bulk sample rows never enter it at all.

| Default flow puts in model context | Kept out of the default flow |
| --- | --- |
| "A send to a@x.com is awaiting approval in the card above." | Decrypted body text and HTML |
| Post-decision summary via `ui/update-model-context` (outcome, recipient count, subject) | bcc addresses |
| Bulk plan match count and scope description | The message sample rows |

The **model-visible** half of the tool result for a gated send is unchanged from before this feature:
the flat pending-approval payload, which carries only what `queueSendApproval` already puts in
`send_approvals.summary` (to, cc, bcc_count, subject, attachment_count) plus `review_url` and a prose
`message`. **No new information is exposed to the model by this feature.** That claim is accurate and is
the one to lead with.

The envelope added in §2a travels in `structuredContent` only, and `structuredContent` is the card
channel. Note the honest caveat that applies to the whole feature: some hosts may show `structuredContent`
to the model too, and the model can call `approval_review` for the same body regardless. This is context
hygiene, not a boundary, and it is worth having and worth not overselling.

---

## 8. `draft_editor` — an unsent draft the user can edit in the card (v1, internal only)

Added 2026-09-16 by the orchestrating session. Background and rationale:
`CONCEPT-draft-editor.md`. This section is the binding v1 shape; the concept's lineage table,
conflict rule and launcher are NOT in v1.

### Gate

`workspaces.draft_editor_enabled boolean not null default false`. When false, the `draft`
tool behaves byte-for-byte as before in both channels and carries no `_meta.ui` at
`tools/list`. When true, `draft` is listed with `reviewCardToolMeta()` unconditionally (a draft
result always has something to render), and the results below carry an envelope in
`structuredContent` only. `content` is unchanged on every path. Internal workspaces are those in
`public.internal_accounts`; the migration that adds the column sets it true for them.

### Envelope

```jsonc
{
  "schema_version": "review-card-v1",
  "card": "draft_editor",
  "state": "editing",                       // terminal states are delivered as card: "receipt"
  "dashboard_url": "https://mcpemails.com/dashboard",
  "draft": {
    "draft_id": "Drafts:2",                 // the CURRENT id; on IMAP it changes on every save
    "id_is_stable": false,                  // false on IMAP: the card MUST adopt every returned id
    "origin": "create" | "reply" | "update" | "read" | "save",
    "last_saved_at": "2026-09-16T10:04:00Z",
    "last_saved_by": "agent" | "user",      // "user" only when the last write was draft_editor_save
    "identity": { "inbox_id", "email_address", "display_name", "provider", "service" },   // §2 Identity
    "recipients": { "to": ["a@x"], "cc": [], "bcc": [] },   // full bcc: the author's surface
    "subject": "…",
    "body": { "text": "…", "html": "…" | null, "truncated": false },   // 64 KB clip as §2
    "attachments": [ { "filename", "size_bytes", "mime_type" } ],       // display only
    "signature": { "embedded": true | false },   // whether the stored text already carries it
    "in_reply_to": { "message_id": "INBOX:42", "subject": "…", "from": "…" } | null,
    "can_send": true | false                // key has send:email AND at least one recipient
  },
  "provider": { "label": "IMAP + SMTP", "route": "APPEND to Drafts", "caveats": [] },   // §5 shape
  "actor": { "can_edit": true, "reason": null }   // reason: "viewer_role" | "wrong_workspace" | "not_found"
}
```

Everything in `draft` is hostile input (subjects and reply metadata come from third parties);
the card neutralises at the boundary as it does for §2.

### Where it is emitted

| Path | `structuredContent` when gated in | `content` |
| --- | --- | --- |
| `draft{action:"create"|"reply"|"update"}` success | today's payload keys **plus** the envelope, merged at top level exactly as §2a (disjoint key sets, asserted by test) | unchanged |
| `draft_read`, `draft_editor_save` | envelope alone | a short body-free summary line |
| `draft{action:"send"}` not held | today's `{draft_id, message_id, sent_at}` **plus** `card: "receipt"`, `outcome: "sent"` | unchanged |
| `draft{action:"send"}` held | the §2a held-send shape, unchanged | unchanged |
| `draft{action:"delete"}` | today's `{draft_id, deleted}` **plus** `card: "receipt"`, `outcome: "discarded"` | unchanged |

Building the envelope must never turn a successful draft operation into an error: a failure
degrades to today's payload, exactly as §2a's failure rule.

### Tools (app-only, `appOnlyReviewCardToolMeta()`, audit-logged, non-billable)

| Tool | Arguments | Returns |
| --- | --- | --- |
| `draft_read` | `{ inbox_id?, inbox?, draft_id }` | `card: "draft_editor"`, `origin: "read"`; needs `manage:drafts` **and** `read:email` |
| `draft_editor_save` | `{ inbox_id?, inbox?, draft_id, to?, cc?, bcc?, subject?, body_text? }`, at least one field | `card: "draft_editor"`, `origin: "save"`, `last_saved_by: "user"`, the NEW `draft_id` |

`draft_editor_save` rules, all load-bearing:

* **Never applies a signature.** The text the user saw already carries whatever will go out.
* **Never writes the HTML part independently.** When `body_text` is given and the stored draft
  has an HTML part, the HTML part is regenerated from the new text with
  `signature-compose.ts#plainTextBodyToHtml`, the same rule `approval_update` follows.
* **Omitted fields are kept.** Unlike `draft{action:"update"}`, which requires `body`, an omitted
  field means "leave it as stored". The server reads the stored draft first and merges.
* **Refuses rather than drops attachments.** `imapUpdateDraft` and `gmailUpdateDraft` rebuild the
  MIME from parameters and carry no attachment parts. A save on a draft that has attachments on
  IMAP or Gmail returns `state: "error"` with `receipt.error_code: "draft_has_attachments"` and
  changes nothing. Outlook (PATCH) may proceed.
* **Recipients are validated** as `draft` validates them; an invalid address returns
  `error_code: "invalid_recipients"` and changes nothing.
* Stale or missing ids return `error_code: "draft_not_found"`; the card then offers Refresh.

Both tools re-verify: the inbox belongs to the calling key's workspace and is in its
`inbox_ids` allowlist, the workspace is gated in, and the scopes above. A hostile caller can do
nothing here that `draft{action:"update"}` and `email_read` could not already do (see
`CONCEPT-draft-editor.md` §6).

### Model context

After a successful save the card calls `ui/update-model-context` with a complete, body-free
statement of the draft's current state (the spec says each call overwrites the last):

> User edited draft Drafts:3 in the editor at 10:04. Subject: "…". To 1, cc 1, bcc 0. Body 412
> words. Current draft_id is Drafts:3.

After send or discard it sends the receipt headline, as the outbound card does.

### Teardown

On `ui/resource-teardown` a dirty editor calls `draft_editor_save` before replying to the
request. The host is required to wait for that reply (spec: "SHOULD wait for a response before
tearing down the resource (to prevent data loss)").

### As built (server)

Implemented 2026-09-16. Server side only; the card is `apps/mcp-app/`.

**Tools.** `draft_read` and `draft_editor_save`, defined in
`supabase/functions/mcp-server/mcp-app-drafts.ts`, registered after the `bulk_*` tools with
`appOnlyReviewCardToolMeta()`, listed unconditionally, absent from `BILLABLE_TOOL_NAMES` and from
`IDEMPOTENT_OUTBOUND_OPERATIONS`. Both declare `requiredScope: "manage:drafts"` and no `altScopes`.

**Error codes**, all delivered as a `card: "receipt"` envelope with `state: "error"`,
`outcome: "failed"` and `isError: true` — never a JSON-RPC error: `invalid_arguments`,
`insufficient_scope`, `inbox_not_found`, `draft_editor_disabled`, `draft_not_found`,
`invalid_recipients`, `draft_has_attachments`, `provider_error`. The not-found and
wrong-workspace cases are byte-identical, so neither tool is an existence oracle.

**Gate.** `workspaces.draft_editor_enabled`, read per call and fail-closed
(`workspaceDraftEditorEnabled` in `index.ts`), and resolved once more at `tools/list` as a third
`ReviewCardGates` member. `draft` moved out of `REVIEW_CARD_TOOL_NAMES` into
`DRAFT_EDITOR_CARD_TOOL_NAMES`; `email_compose` and `schedule` stay on the outbound gate.

Deviations, all small and all deliberate:

* **`draft.in_reply_to` is populated on `origin: "reply"` only.** §8 types its `message_id` as a
  server message id (`"INBOX:42"`), and a stored draft carries only the original's RFC
  `In-Reply-To` header, which is not one. `draft_read` therefore returns `null` rather than a value
  the card would render as openable and could not open. Threading is preserved across a save
  regardless: the headers are read and written back untouched.
* **`receipt.outcome: "discarded"` is new to §4's enum,** which §8 asks for. Its envelope `state` is
  `"cancelled"` — §1 has no `"discarded"`, and a draft that was withdrawn before it went anywhere is
  what `"cancelled"` already means there for a lapsed plan.
* **A receipt's `actor` carries `can_decide: false`, not `can_edit`.** `card: "receipt"` is a shape
  the outbound and bulk cards already produce and the card reads one field for all three;
  `can_edit` belongs to the `draft_editor` envelope alone.
* **`draft_editor_save` takes no `body_html`.** The editor is a plain-text surface, and the HTML part
  is only ever regenerated from `body_text`. A card able to write arbitrary HTML into outgoing mail
  is a larger thing than v1 needs.
* **`draft_read` requires `read:email` inside its handler,** not through `altScopes`: the dispatch
  layer ORs `requiredScope` with `altScopes`, so it can express "one of these" and not "both".
  Same pattern as `executeSendDraft`'s `send:email` re-check.
* **The Outlook `draft{action:"reply"}` path returns today's payload with no envelope.** It creates
  the draft through Graph's `createReply`, so the handler never holds the composed body the envelope
  builder needs. This is the §8 degradation rule firing, not a failure.
