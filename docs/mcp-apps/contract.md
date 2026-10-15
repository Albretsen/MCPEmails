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
  },
  "diagnostics": true    // OPTIONAL, internal only, `true` or absent (see below)
}
```

`schema_version` is mandatory. The card refuses to render an unknown version and shows a
"update your connector" message rather than guessing.

There are two values since 2026-10-13. `review-card-v1` is every envelope in this document
except one. `review-card-v2` is the §8 `draft_editor` envelope **with a deferred body**, which
only `draft{action:"create"|"reply"|"update"}` emits. It exists so that a card bundle built
before the body was deferred hits the refusal above instead of drawing an editable empty body;
§8 "Deferred body" has the argument. A current card accepts both.

`dashboard_url` is **envelope-level and absolute**, and every envelope carries it. It sits here rather
than only on the receipt for a specific reason: the unsupported-schema screen is precisely when the card
cannot read the rest of the envelope, and precisely when it most needs to offer a way out. A
receipt-level-only field would be unreachable there. The card must never hold an origin of its own — it
ships inside the edge function, so a hardcoded origin is deployment config baked into a build artifact.

`diagnostics` is an **optional, internal-only** envelope field, `true` or absent. When present the card
renders one row of protocol facts under the content: host name and version, display mode, whether a
tool result / tool input / stored envelope arrived, two timings, the handshake attempt count, and
accepted/foreign message counters. It carries no mail content; the only attacker-influenced string in it
is the dispatched tool name, neutralised and sliced to 64 characters.

It exists because Phase 0's questions about the real host cannot be answered from outside the frame. It
is **off unless the server says otherwise**, and the server says so only for a workspace with
`workspaces.card_diagnostics` (applied 2026-09-17, default false, seeded to the 12 workspaces our own
accounts own). The flag has its own column rather than riding on `draft_editor_enabled`, for a reason
worth keeping: the outbound and bulk cards are gated by `send_approval_required` and `bulk_review_mode`,
which are *customer* opt-ins, so the line as first shipped reached 7 non-internal workspaces, and gating
it on the draft editor's rollout flag would reach every workspace that feature ever rolls out to.

The server stamps it in one place, `card-diagnostics.ts`, called once at the end of `tools/call` dispatch
rather than threaded through the six envelope builders, so a new card kind is gated the day it ships.
`structuredContent` only: §8 pins `content` byte-for-byte, and this is a rendering hint for one iframe.

**The server flag is the only source in a shipped card.** The card also honours a
`VITE_CARD_DIAGNOSTICS=1` build flag, which a production build does not carry. An earlier draft had a
third source, a `mcpemails.card.diag` key in the card's own `localStorage`, and it was removed on
2026-09-17: it was the only input to the decision that we do not author, any same-origin page could
write it, and whether Claude's sandbox gives each MCP App its own origin is a host detail the card
cannot read from inside the frame.

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

### Empty-frame rule (2026-10-12)

**The card never renders an empty tree, and never reports a height of 0.** Every state it can be in —
before the handshake, waiting for a result, a result that is not ours, a cancelled call, a handshake that
failed, a remount with nothing remembered — renders at least one line.

This replaces the rule it shipped with, which was the opposite: render nothing, let `.card:empty {
display: none }` collapse the shell, and let the host's own message text carry the result. That rested on
a premise about the host that is false. Measured in Claude on 2026-10-12: the host keeps its "Widget from
…" header and an empty container around a frame that reports height 0. So an empty tree is not an absent
card, it is a thin sliver under a header that promises a card — which reads as a card that failed to
load, on operations that all succeeded.

Three consequences, all of them things a future change must not quietly undo:

* **A quiet line, never a warning.** These states are not failures and must not be dressed as ones. The
  shape is the same one-line header every other nothing-to-show state uses, with a neutral dot and the
  dashboard link when one is known: `MCP Emails: no preview for this result.`, `… cancelled.`,
  `… not shown here.`, `… nothing to show here.` The label is the dispatched tool name when the host
  sends `toolInfo` and the product name when it does not, which in Claude is always.
* **`observeSize()` starts at mount, not after the handshake.** It used to start inside connect()'s
  `.then()`, so the two states that exist *because* the handshake did not succeed were the two the host
  was never told a height for. One `size-changed` now goes out before `ui/initialize` completes; it is a
  notification, so a host that is not ready drops it exactly as it drops the `ui/initialize` sent in the
  same tick.
* **A frame that gets no animation frames still reports.** The measurement needs layout, so it was
  scheduled on `requestAnimationFrame` alone — and an unpainted frame gets none, which left `scheduled`
  stuck true so that later ResizeObserver callbacks returned early too. A timer now runs alongside the
  frame request and whichever arrives first wins.

Pinned by `apps/mcp-app/harness/card-render.test.mjs`, which evaluates the real `main.tsx` in jsdom and
asserts on `.card` having children rather than on a pixel height, because jsdom has no layout and
`.card:empty` is the actual collapse mechanism.

**The one case this makes slightly worse, knowingly.** A user who hides the editor for *one* of several
inboxes still gets `_meta.ui` on the tool (it is per-tool, not per-inbox), so that inbox's drafts now
show `no preview for this result.` where they used to show nothing. The host draws its header over that
frame either way, so the opt-out was never fully silent; one honest line is better than an empty box
under a widget header. A key whose every reachable inbox hides the editor still loses `_meta.ui` at
`tools/list` and mounts no card at all.

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
  `"foreign"` and the card rendered nothing (correctly, under the rule of the day; since 2026-10-12 a
  foreign result renders one quiet line instead — see §1's empty-frame rule);
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
pending-approval payload and the send stays queued, which is the pre-card behaviour for the *result*.
The card, which has no envelope to read, reports one line (§1's empty-frame rule) rather than the
nothing it rendered until 2026-10-12.

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
| A draft write's payload (`draft_id`, subject, recipients) and one sentence saying a card exists | The draft body the write stored (result `_meta`, §8) |
| `draft_read`'s plain read, body included, **when the model calls it** | |

The **model-visible** half of the tool result for a gated send is unchanged from before this feature:
the flat pending-approval payload, which carries only what `queueSendApproval` already puts in
`send_approvals.summary` (to, cc, bcc_count, subject, attachment_count) plus `review_url` and a prose
`message`. **No new information is exposed to the model by this feature.** That claim is accurate and is
the one to lead with.

The envelope added in §2a travels in `structuredContent` only, and `structuredContent` is the card
channel. Note the honest caveat that applies to the whole feature: some hosts may show `structuredContent`
to the model too, and the model can call `approval_review` for the same body regardless. This is context
hygiene, not a boundary, and it is worth having and worth not overselling.

**The draft editor acts on that caveat rather than only stating it (2026-10-13).** A
`draft{action:"create"|"reply"|"update"}` result no longer carries the body in `structuredContent`
at all: it rides in the result's `_meta`, which a host forwards to the view and does not render into
the conversation (§8 "Deferred body"). The model wrote that body itself one call earlier, and on a
reply it also quotes a third party, so repeating it bought nothing and cost context on every write.

**And one read is deliberately in the default flow.** `draft_read` puts the draft, body included,
in `content`. That is not a leak of the rule above, it is the rule's other half: the model is the
party asking. Once a user can edit a draft in the card, the model's own copy of the text is stale,
and a model with no way to read the current text overwrites the user's edit on its next update. The
result is marked `untrusted_content: true` like every other read. The held-send body (§2) is still
not re-injected by default.

---

## 8. `draft_editor` — an unsent draft the user can edit in the card (v1, internal only)

Added 2026-09-16 by the orchestrating session. Background and rationale:
`CONCEPT-draft-editor.md`. This section is the binding v1 shape; the concept's conflict rule and
launcher are NOT in v1. The lineage table was added 2026-10-13 (see "Draft lineage" below).

### Gate

`workspaces.draft_editor_enabled boolean not null default false`. When false, the `draft`
tool behaves byte-for-byte as before in both channels and carries no `_meta.ui` at
`tools/list`. When true, `draft` is listed with `reviewCardToolMeta()` unconditionally (a draft
result always has something to render), and the results below carry an envelope in
`structuredContent`. The FIRST `content` block is unchanged on every path; a create, reply or
update result that carries an editor envelope gains a second one (see "Model context" below).
Internal workspaces are those in
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
    "resolved_from": "Drafts:1",            // present only when the caller asked with an OLDER id of this draft
    "revision": 2,                          // lineage revision; present only when an open line names the draft.
                                            // The card sends it back as base_revision (see "Draft lineage")
    "id_is_stable": false,                  // false on IMAP: the card MUST adopt every returned id
    "origin": "create" | "reply" | "update" | "read" | "save",
    "last_saved_at": "2026-09-16T10:04:00Z" | null,   // when the draft was last SAVED; never the time of a read
    "last_saved_by": "agent" | "user" | null,         // who saved last; null when not known
    "identity": { "inbox_id", "email_address", "display_name", "provider", "service" },   // §2 Identity
    "recipients": { "to": ["a@x"], "cc": [], "bcc": [] },   // full bcc: the author's surface
    "subject": "…",
    "body": { "text": "…", "html": "…" | null, "truncated": false,
              "formatting_removed": true },   // 64 KB clip as §2; formatting_removed: save only; see "Deferred body"
    "attachments": [ { "filename", "size_bytes", "mime_type" } ],       // display only
    "signature": { "embedded": true | false, "rich": true },   // embedded: the stored text carries it;
                                            // rich (only when true): the HTML part carries the formatted block
    "in_reply_to": { "message_id": "INBOX:42", "subject": "…", "from": "…" } | null,
    "threaded": true | false,               // answers a message, on EVERY path; see the deviations note
    "can_send": true | false                // key has send:email AND at least one recipient
  },
  "provider": { "label": "IMAP + SMTP", "route": "Saved to your Drafts folder", "caveats": [] },   // §5 shape, read by a person
  "actor": { "can_edit": true, "reason": null }   // reason: "viewer_role" | "wrong_workspace" | "not_found"
}
```

Everything in `draft` is hostile input (subjects and reply metadata come from third parties);
the card neutralises at the boundary as it does for §2.

### Where it is emitted

| Path | `structuredContent` when gated in | `content` |
| --- | --- | --- |
| `draft{action:"create"|"reply"|"update"}` success | today's payload keys **plus** the envelope, merged at top level exactly as §2a (disjoint key sets, asserted by test), **body deferred**, `schema_version: "review-card-v2"` | block 1 unchanged; block 2 is the one-sentence card notice |
| `draft_read` | envelope alone, body inline, v1 | the plain read below, as JSON (body included) |
| `draft_editor_save` | envelope alone, body inline, v1 | a short body-free summary line |
| `draft_read` when NOT gated in, or hidden | no envelope: the plain read below | the same plain read, as JSON |
| `draft{action:"send"}` not held | today's `{draft_id, message_id, sent_at}` **plus** `card: "receipt"`, `outcome: "sent"` | unchanged |
| `draft{action:"send"}` held | the §2a held-send shape, unchanged | unchanged |
| `draft{action:"delete"}` | today's `{draft_id, deleted}` **plus** `card: "receipt"`, `outcome: "discarded"` | unchanged |

Building the envelope must never turn a successful draft operation into an error: a failure
degrades to today's payload, exactly as §2a's failure rule.

### Deferred body (2026-10-13)

On the three model-initiated rows above (`create`, `reply`, `update`) the body is not in
`structuredContent`. The result looks like this, with everything not shown exactly as in the
envelope above:

```jsonc
{
  "content": [
    { "type": "text", "text": "{\"untrusted_content\":true,\"draft_id\":\"Drafts:2\",…}" },   // unchanged
    { "type": "text", "text": "Hosts that render MCP Apps cards show this draft to the user in an editable card, where the user can change it, and draft_read returns the current text." }
  ],
  "structuredContent": {
    "schema_version": "review-card-v2",
    "card": "draft_editor",
    "draft": {
      "version": "1:…",          // computed from the REAL body, as before
      "body": { "text": null, "html": null, "truncated": false, "deferred": true }
      // …
    }
    // …
  },
  "_meta": {
    "mcpemails/draft_body": { "text": "…", "html": "…" | null, "truncated": false }   // the same clipped values
  }
}
```

| Channel | Carries | Reaches |
| --- | --- | --- |
| `content[0]` | the draft payload JSON, byte for byte as before the card existed | the model |
| `content[1]` | one sentence of fact: a card exists, the user can edit there, `draft_read` has the current text | the model |
| `structuredContent` | the envelope with `body.deferred: true` and no body text | the card, and on some hosts the model |
| `_meta["mcpemails/draft_body"]` | `{ text, html, truncated }`, the 64 KB clip | the card |

Rules, all load-bearing:

* **The card reads `_meta` first.** If the key is absent (a host that drops result `_meta`, or
  one that replays a stored result without it) it calls `draft_read`, which returns the body
  inline.
* **`draft.version` is computed before the split,** from the clipped body the write stored. It is
  NOT guaranteed to equal the version a later `draft_read` reports for the same untouched draft:
  that holds only when the provider hands back the body it was given. IMAP and Gmail do for the
  messages this server builds (base64 parts round-trip the text). Outlook does not: Exchange
  rewrites the stored HTML and `draft_read` derives the text from it, so the read's version
  differs from the write's on every HTML draft. The card therefore must not require a match, and
  does not: on equal versions it grafts the fetched body under the original envelope, and on any
  mismatch it adopts the `draft_read` answer whole (`store.ts#acceptDeferredBody`).
* **`deferred: true` and `review-card-v2` always travel together.** Either one without the other
  is the unsafe pair. Both are set in one function, `draftCardToolResult`, and nowhere else.
* **`draft_read` and `draft_editor_save` are not deferred** and stay on v1. They are the card's own
  calls (and, for `draft_read`, the model's deliberate one), and an older bundle understands them.
* **Receipts are untouched.** Send and delete return `card: "receipt"` on v1 with no `_meta` and no
  second `content` block.

**Why v2, and why only here.** A card bundle built before this change reads
`draft.body.text ?? ""` and knows nothing about `deferred` or result `_meta`. Given a deferred
envelope on v1 it would draw an *editable empty body* over a draft that has one. And an old bundle
does meet a new result: the host caches the card by URI (§0), the URI arrives through a
`tools/list` the client read at connect, §0 lists five populations a deploy never re-lists, and
even a client that IS notified mounts the first post-deploy result from the listing it held when it
made the call. A stale fingerprinted URI is not re-served either: `resources/read` answers only
the current fingerprint and the bare legacy URI, so a host renders an old bundle from its cache or
not at all.

Every bundle ever shipped answers an unknown `schema_version` the same way: `isSupportedVersion`
is an equality test against `"review-card-v1"`, and a miss renders "Update the MCP Emails
connector" with the envelope-level `dashboard_url` (§1) before any editor is drawn. So the deferred
envelope is published under a version old bundles do not know, and the unsafe rendering becomes
that screen. Bumping the shared constant instead would put that screen over every held send and
every bulk plan for clients that have not re-listed, for envelopes that did not change.

The cost, stated: a client holding a pre-2026-10-13 bundle sees the update screen in place of the
editor for model-written drafts until it re-lists. The draft itself is written either way, and
`draft_read` from that old bundle (its Refresh and restore paths) still works.

**The card must accept both versions.** `apps/mcp-app/src/contract.ts#isSupportedVersion`.

### Tools (audit-logged, non-billable)

| Tool | `_meta.ui.visibility` when gated in | Arguments | Returns |
| --- | --- | --- | --- |
| `draft_read` | `["model", "app"]` | `{ inbox_id?, inbox?, draft_id }` | `structuredContent`: `card: "draft_editor"`, `origin: "read"`, body inline, plus top-level `untrusted_content: true`. `content`: the plain read as JSON. Needs `manage:drafts` **and** `read:email` |
| `draft_editor_save` | `["app"]` | `{ inbox_id?, inbox?, draft_id, base_revision?, to?, cc?, bcc?, subject?, body_text? }`, at least one field | `card: "draft_editor"`, `origin: "save"`, `last_saved_by: "user"`, the NEW `draft_id` and `revision`, body inline |
| `draft_editor_hide` | `["model", "app"]` | `{ inbox_id?, inbox?, scope, hidden? }` | `card: "receipt"`, `state: "cancelled"` |

With the gate shut none of the three carries `_meta` (see "As built"), so a host lists them as
ordinary tools.

**`draft_read` is model-callable while the card is on (2026-10-13, owner's decision).** It was
`["app"]`. A user who edits a draft in the card changes text the model can no longer see:
`draft_list` returns no body, the write results return none, and the model's own copy predates the
edit. So `draft_read` is listed to the model, its description leads with that use, and its
`content` is the plain read in **both** gate states, byte for byte the same. `structuredContent`
still differs by state: the editor envelope with the gate open, the plain payload with it shut. It
keeps `resourceUri`, so a model-initiated read mounts the card with the envelope; the card's own
calls (restore, Refresh, the deferred-body fallback) are unchanged. Since 2026-10-15 that mounted
card is one line with "Open editor" rather than a second full editor (see "Card activity notes").

With the gate open that `structuredContent` also carries `untrusted_content: true` at the top
level, beside the envelope's own keys. It holds a subject, recipients and a body that on a reply
quote a third party, and some hosts show it to the model, so it is marked like the plain read in
`content` is. The card's `isEnvelope` ignores extra top-level keys. It is added by `runDraftRead`
and not by the envelope builder, because a draft write merges its payload's own flag over the
envelope and the two key sets must stay disjoint.

**`draft_editor_hide` is model-callable too (2026-10-13).** It was `["app"]`, and three statements
disagreed about it: the card's copy says the card "can be brought back by asking in this chat", the
server instructions listed it as app-only ("The host drives them, not you"), and the listing kept it
out of the model's picker. With the card hidden there is no card left to click, so the model
calling this tool with `hidden:false` is the only way back the copy can mean. It is now
`["model", "app"]`, it is out of the instructions' APP-ONLY sentence, and its description opens
with when to call it. Nothing about what it can do changed; the hostile-caller analysis in
`runDraftEditorHide` already assumed a model calls it. `draft_editor_save` stays `["app"]`.

**A read that fails is not a draft that is gone (2026-10-13).** The Gmail and Outlook editor
readers returned null for every non-OK status but 401, so a 429 or a 500 came back as
`draft_not_found` and a model could reasonably recreate a draft that was still there. They now
return null only for 404 and for a 400 (a draft id of the wrong shape, which on both APIs is how a
malformed id is refused); anything else throws and is answered `provider_error`, "could not be
read, nothing was changed". All three callers (`draft_read`, `draft_editor_save`, a body-less
`draft` update) take that path.

`draft_editor_save` rules, all load-bearing:

* **Never applies a signature.** The text the user saw already carries whatever will go out.
* **Never writes the HTML part independently.** When `body_text` is given and the stored draft
  has an HTML part, the HTML part is regenerated from the new text with
  `signature-compose.ts#plainTextBodyToHtml`, the same rule `approval_update` follows.
  **Except the rich signature (2026-10-13).** When the stored HTML part carries our
  `mcpemails-signature` block, the text is split at the signature and only the person's words are
  regenerated; the block the draft already had is kept byte for byte, and the `-- ` delimiter never
  reaches the HTML (`signature-compose.ts#rebuildHtmlKeepingSignature`). When the signature lines
  themselves were edited (or the body was cleared, or the HTML would exceed the limit) the formatting
  cannot be kept honestly: no HTML part is written, and the save's envelope carries `body.html: null`
  and `body.formatting_removed: true`. The card must then stop offering a formatted view, and may say
  why. `signature.rich: true` tells the card in advance that editing the signature lines will do this.
  The signature is found by its `-- ` delimiter line plus its text. A match on the text lines alone
  (Outlook hands the text part back without the delimiter) counts only when the STORED text part had
  no delimiter line either; otherwise deleting `-- ` and the signature, then signing off with the same
  words (a one-line signature such as a first name), put the rich block back (review 2, 2026-10-13).
* **A save that changes nothing writes nothing.** When every field equals what is stored (line
  endings aside), the stored draft is answered as a save without a provider write.
* **A save never follows an old id, and never writes over a newer revision (2026-10-13 review).**
  A save against an OLDER id of the draft, or with a `base_revision` other than the line's current
  revision, is refused with `error_code: "draft_changed"` and writes nothing. The check runs twice:
  before the stored draft is read, and again immediately before the provider write. The failed
  receipt carries no copy of the draft (until review 2 it carried an unused `current`): the card's
  "Load the newer version" is a `draft_read`. See "Draft lineage".
* **Omitted fields are kept.** An omitted field means "leave it as stored". The server reads the
  stored draft first and merges. `draft{action:"update"}` required `body` when this was written;
  since 2026-10-13 it may omit it, and then runs this same merge (see below).
* **Refuses rather than drops attachments.** `imapUpdateDraft` and `gmailUpdateDraft` rebuild the
  MIME from parameters and carry no attachment parts. A save on a draft that has attachments on
  IMAP or Gmail returns `state: "error"` with `receipt.error_code: "draft_has_attachments"` and
  changes nothing. Outlook (PATCH) may proceed.
* **Refuses rather than drops anything else (2026-10-13).** Attachments were one case of several.
  The parser keeps the first text/plain and the first text/html and has no slot for any other
  part that is not a named file, so these passed the attachment check and were silently absent
  from the rebuilt message: a second text part, an inline image with a Content-ID and no filename,
  a text/calendar alternative, a signature part, an embedded message, a multipart that cannot be
  split, and `format=flowed` text (whose soft line breaks would be written back as hard ones). A
  Reply-To that cannot be written back verbatim counts too. Any of them on IMAP or Gmail returns
  `error_code: "draft_not_rebuildable"`, naming the parts, and changes nothing
  (`draft-rebuild.ts`). Outlook reports none and may proceed.
* **What "kept" means.** On IMAP and Gmail the write is a rebuild, so what is kept is the decoded
  body TEXT, the HTML string, the recipients, the subject, Reply-To, In-Reply-To and References.
  The rebuilt message has a new Message-ID and Date, From written from the inbox's identity,
  base64 UTF-8 parts whatever the stored encoding was, and none of the stored message's other
  headers (X-* fields, priority, a read-receipt request). A draft with no Subject header keeps an
  empty subject rather than acquiring the readers' "(no subject)" placeholder. No description says
  the draft is kept "exactly", and `draft-rebuild.test.ts` pins both halves against real MIME.
* **An empty list clears, on every provider.** `cc: []` removes the Cc. On Outlook it did not until
  2026-10-13: the PATCH omitted every empty list, Graph kept the stored value, the save reported
  success, and Send delivered to the address the user had removed. An empty list is now sent as
  `[]` when the caller supplied that field, and still omitted when it did not.
* **Recipients are validated** as `draft` validates them; an invalid address returns
  `error_code: "invalid_recipients"` and changes nothing. A non-string or blank entry is invalid
  too: nothing is ever dropped silently.
* Missing ids return `error_code: "draft_not_found"`; the card then offers Refresh. An OLDER id of
  a draft is not missing, but it is not writable either: see "Draft lineage".

Both tools re-verify: the inbox belongs to the calling key's workspace and is in its
`inbox_ids` allowlist, the workspace is gated in, and the scopes above. A hostile caller can do
nothing here that `draft{action:"update"}` and `email_read` could not already do (see
`CONCEPT-draft-editor.md` §6).

**`draft{action:"update"}` without `body` (2026-10-13).** `update` used to refuse a call with no
`body`, so every model update was a body overwrite, and after a card edit the body it overwrote
with was the model's older text. Now:

* `body` omitted: the stored body text is kept. The write goes through
  `mcp-app-drafts.ts#applyDraftPatch`, the function `draft_editor_save` runs, so the save rules
  above apply unchanged, including what "kept" means: no signature (so none is doubled), the HTML
  part, Reply-To and threading headers carried through, an explicit `[]` clearing a list, and on
  IMAP and Gmail a refusal that changes nothing for a draft with attachments
  (`draft_has_attachments`) or with any other part the rebuild would drop
  (`draft_not_rebuildable`).
* **The envelope needs `read:email`.** A full-body update's envelope is built from the body the
  caller just supplied. This one is built from the body that was STORED, and `update` needs only
  `manage:drafts`, and on IMAP a draft id is any `folder:uid`. So a key without `read:email` gets
  the plain payload and nothing else: no envelope, no `_meta`, no second `content` block. The
  write is still made. `draft_read` requires `read:email` for the same reason.
* `threaded` in the payload is computed as the full-body path computes it. In particular it is
  false on Outlook, where Graph's `conversationId` is set on every message and is not evidence of
  a reply.
* At least one of `to`, `cc`, `bcc`, `subject`, `body` must be present. `html_body` without
  `body` is refused, as is `body: ""`. All three refusals happen before the inbox is resolved.
* `body` given: the full-body path, unchanged. The body replaces the stored one and the signature
  is embedded on it (`include_signature: false` to skip).
* It is the `draft` tool, so it needs no editor gate and works in every workspace. Failures are
  `draft_update:` text results, not receipts; success is the same
  `{ draft_id, subject, updated_at, threaded }` payload plus, when gated in, the deferred envelope.
* Only the per-action `required` list changed (`["draft_id"]`). No advertised type moved, so a
  client holding the cached schema keeps working.

**`draft_read` without the editor (2026-10-02).** "The workspace is gated in" decides the SHAPE
of a `draft_read` answer, not whether there is one. When the workspace is not rolled out, or the
editor is hidden for the workspace or for the inbox the call resolved to, `draft_read` keeps
every other check (both scopes, the inbox and its allowlist) and returns a plain read instead of
an envelope, as one object in `content` (JSON text) and in `structuredContent`:

```json
{
  "draft_id": "Drafts:2",
  "inbox_id": "8f1f2a3c-0000-4000-8000-000000000001",
  "to": ["Billing <billing@example.com>"],
  "cc": [],
  "bcc": [],
  "subject": "Re: Invoice 1042",
  "body_text": "Thanks, paid today.",
  "body_truncated": false,
  "attachments": [{ "filename": "receipt.pdf", "size_bytes": 20480, "mime_type": "application/pdf" }],
  "attachment_count": 1,
  "signature_embedded": false,
  "threaded": true,
  "untrusted_content": true
}
```

* **It is not an envelope.** No `schema_version`, no `card`, no `state`, no `dashboard_url`, and
  no `_meta.ui` on the result. The card's `isEnvelope` therefore rejects it and `classifyResult`
  reports it as foreign, which is what keeps a hidden editor hidden: a restoring cell cannot
  render an editor from it and ends on its one-line fallback, and a Refresh in an editor that is
  still open keeps the editor and its unsaved text and shows a notice. `draft_editor_save` is
  still refused in those states, so a hidden editor still cannot write. Since 2026-10-12 "hidden"
  means one quiet line rather than an empty frame; see the last paragraph of §1's empty-frame rule
  for why that is the better of the two for an opt-out the host draws a header over regardless.
* **Why a read and not a refusal.** With the gate shut the tool carries no `_meta.ui`, so a host
  lists it to the model as an ordinary tool. It is the only tool that returns one draft's body
  (`draft_list` and the draft writes return none), so the refusal left a model with no way to
  read a draft back. Measured before the change: 174 calls from 29 customer workspaces, none
  answered.
* **Read-path rules apply.** `untrusted_content: true` always, including on an empty draft.
  Subject, recipients, filenames and MIME types are neutralised; the body is not. `body_text` is
  chosen the way `email_read` chooses it (`preferredBodyText`), so an HTML-only draft still reads
  as text; the HTML part is not returned. The body is clipped at 64 KB like the envelope's, with
  `body_truncated: true` and `body_total_chars` when it is. `attachments` is metadata for at most
  25 files and never bytes; `attachment_count` is the real number.
* **Failures are unchanged in every state:** the same `card: "receipt"` error envelopes with the
  same codes (`insufficient_scope`, `inbox_not_found`, `draft_not_found`, `provider_error`,
  `invalid_arguments`). Only `draft_editor_disabled` and `draft_editor_hidden` are no longer
  produced by `draft_read`.

### Model context

**What the server tells the model.** A create, reply or update result that carries an editor
envelope has a second `content` block, one sentence, stating a fact and asking for nothing:

> Hosts that render MCP Apps cards show this draft to the user in an editable card, where the user
> can change it, and draft_read returns the current text.

No envelope, no block: a workspace that is not gated in, a hidden inbox, the Outlook reply path
and a failed envelope build all return exactly the one block they always did. Send and delete
receipts get none either. The `draft` tool description carries the matching sentence, worded so it
is true with the editor off ("Where the draft editor card is on, …"), and both `draft` and
`draft_list` point at `draft_read` for a draft's text.

**What the card tells the model.** After a successful save the card calls `ui/update-model-context` with a complete, body-free
statement of the draft's current state (the spec says each call overwrites the last):

> The user saved edits to a draft in the MCP Emails card at 2026-10-13T10:04:00Z. Its current
> draft_id is Drafts:3. Subject: "…". To 1, cc 1, bcc 0. Body 412 words. The body now differs
> from the text the agent last wrote, and draft_read returns the current text.

A save that left the body alone ends "This save did not change the body." instead, unless an
earlier save in the same card changed it.

After send, discard, hide, a held send, or a failure of any of them, it sends a full statement
of the same kind rather than the receipt headline: each call overwrites the last, so a bare
"Sent" would have no draft to refer to. Every line names the draft id, the subject and the
recipient counts, says what happened to the draft, and quotes the server's own words on a
failure. `apps/mcp-app/src/model-context.ts` is the single definition of the wording, and
`harness/model-context.test.mjs` pins it.

### Card activity notes (QA 2026-10-15)

**The defect.** In Claude the model never saw the card's `ui/update-model-context` lines. After a
save in the card Claude reported the old subject and recipients; after a send from the card it
said "No, I never sent it", and when asked to send it the server refused (`draft_already_sent`).
Nothing went out twice, but the user was told two contradictory things.

**What was checked about the request.** Method `ui/update-model-context`, params
`{ content: ContentBlock[], structuredContent? }`, a JSON-RPC request with an id: exactly the
2026-01-26 specification. What was not: the card sent it only when `ui/initialize` returned
`hostCapabilities.updateModelContext`, and the published 2026-01-26 `HostCapabilities` interface
does not list that field at all (only ext-apps' `McpUiHostCapabilities` type does), while the
reference SDK's `App.updateModelContext` sends without checking. Nothing in this repository ever
recorded what Claude advertises, so whether the gate was the cause is not known. Since 2026-10-15
the card sends whether or not the capability is advertised (a host without the method answers
-32601, which is swallowed), and the internal diagnostics line shows `mctx cap|nocap ok/failed/sent`,
which answers the question the next time an internal card is looked at in Claude. Even a host
that accepts it may defer it to the next user message (the spec allows that), so it cannot be the
only channel.

**The server channel.** Every card action reaches the server as a tool call, and a tool result
is the one thing every host shows the model. So:

* `draft_editor_save` that WROTE something, and `draft{action:"send"}` with `base_revision` that
  sent (the card's path; the dispatcher's re-run of an approved send and the web client are
  excluded), insert a row into `public.draft_card_activity` (migration
  `20261015220000_draft_card_activity.sql`): the API key the call came in on, draft id, line,
  revision, action, time, the NAMES of the fields a save changed and recipient COUNTS. No subject,
  address or body. A discard is not recorded: `draft{action:"delete"}` carries nothing that tells
  the card's call from the model's.
* **Per key.** Only a call on the SAME API key claims a row. A save in Claude's card is not news
  to another client (ChatGPT, a script) on another key that touches the inbox first.
* **On the MCP path only.** The claim runs in `handleToolsCall` after dispatch, not in
  `dispatchExecutor`: client-api runs the same executors for the web client, where the rows would
  be claimed and the note never attached. client-api never calls `handleToolsCall`, so the web
  client never claims (pinned in `card-activity.test.ts`); no first-party marker is read, which
  keeps client-api's `mcp-neutral` count of those reads unchanged. Rows the web client's key
  records are never claimed and expire after 7 days.
* The model's next successful `draft_list`, `draft{action:"create"|"reply"|"update"}` or
  `draft{action:"send"}` WITHOUT `base_revision` for that key and inbox claims the unreported rows
  of the last 24 hours in one `UPDATE … RETURNING` (so each is told once) and carries one server
  note through `result-notes.ts` (a trailing `content` block and `structuredContent.notes`), e.g.:

  > Since the last draft result for this inbox, the MCP Emails draft editor (the card in which the
  > user can edit, save and send a draft) recorded these changes, which may not appear in this
  > conversation. At 2026-10-15T11:58:00Z draft Drafts:7 was saved, changing the subject and To.
  > Its recipients are now to 2, cc 0, bcc 0. At 2026-10-15T11:59:30Z draft Drafts:8 was sent. It
  > is no longer a draft and that draft_id no longer resolves. draft_read returns a saved draft's
  > current subject, recipients and text.

  `content[0]` is untouched (the payload JSON is not `structuredContent`'s mirror, so
  `attachResultNote` leaves it alone); the deferred-body row's `content[1]` notice stays second.
  Never on a call the card itself makes (`draft_read`, `draft_editor_*`, `draft_delete`, a send
  with `base_revision`): the host does not show the model those results, so the note would be
  claimed and never read, and `draft-failure.ts#textRefusalCode` reads every text block of a
  card's `draft` answer.
* **It never says a person did it.** `base_revision` is in the model-visible `draft` schema, and
  `draft_editor_save`'s `["app"]` visibility is a host hint. A card's call arrives through the host
  with the same credentials and JSON-RPC shape as a model's, so no request carries a signal the
  model cannot forge, and narrowing the advertised schema to make one is not allowed. The note
  therefore says what was recorded ("was saved", "was sent", "the draft editor recorded") and never
  "the user did". That is true whoever called, and it is enough to stop "I never sent it".
* Fail soft: without the table nothing is recorded or noted and every tool answers as before, so
  the migration and the function can deploy in either order. Every insert also deletes rows older
  than 7 days in EVERY workspace; because that runs on every insert, the backlog it meets is only
  what expired since the previous one.
* `card-activity.ts` holds the rules, the wording and the PostgREST store
  (`postgrestCardActivityStore`); `card-activity.test.ts` pins them, the store's filters against a
  recording client, the save and read wiring through `runDraftEditorSave` / `runDraftRead`, and
  the `index.ts` wiring. `supabase/tests/draft_card_activity.sql` pins the table.

**Tool descriptions.** `draft` (both surfaces' create) and `draft_read` now say that the user can
save, send or discard a draft in the card without the model being told, and to call `draft_read`
before stating a draft's current subject, recipients or whether it was sent.

**The sent receipt.** `detail` is `Accepted by the mail server for delivery.`
(`DRAFT_SENT_RECEIPT_DETAIL`): "Delivered" claimed more than is known (that QA message went to
spam), and naming the provider repeated the label the card's footer already shows. The card
rewords a stored `Delivered via ….` the same way (`format.ts#receiptDetail`), for replays.

**A model's `draft_read` mounts one line, not a second editor.** `draft_read` keeps its
`resourceUri` (the card's own calls to it must keep working, and whether Claude lets an app call
a tool with no `_meta.ui` is not established). A card whose MOUNTING result is a pushed draft
envelope with `origin: "read"` (`store.ts#mountedForRead`; the card's own reads come back as
answers, never as the push) renders `components/DraftReadLine.tsx`: `Draft: <subject>  to <first>
+N` with **Open editor**, which draws the full editor in place. One line, never empty (§1). Pinned
by `harness/card-render.test.mjs`.

### Teardown

On `ui/resource-teardown` a dirty editor calls `draft_editor_save` before replying to the
request. The host is required to wait for that reply (spec: "SHOULD wait for a response before
tearing down the resource (to prevent data loss)").

### Draft lineage (2026-10-13)

`public.draft_lineage` (migration `20261013120000_draft_lineage.sql`) records every id one draft
has had, so an older id resolves to the current one. Rows are written when a draft is created,
replied, updated, saved in the editor, or has its recipients rewritten at send time, and the line
is closed when the draft is sent or deleted. Ids, a revision, who wrote last and when; no content.

* **Reads follow the line; card writes do not (2026-10-13 review).** `draft_read` (the card's
  Refresh and its re-read after a lost answer) and the MODEL's `draft{action:"update"|"send"|"delete"}`
  accept any id of the line, act on the current one, and return the current id (`draft_id`; the
  envelope adds `resolved_from` when it differs from the id asked for). `content` is unchanged in
  shape. A write that comes FROM THE CARD does not follow: `draft_editor_save`, and
  `draft{action:"send"}` called with `base_revision`, are refused with `error_code:
  "draft_changed"` when the id is an older id of the line, or when `base_revision` differs from the
  line's revision. Nothing is written or sent. The lost-save case still works: the card re-reads
  with `draft_read` after a lost answer and adopts the current id and revision before it writes
  again.
* **`revision` / `base_revision`.** The envelope's `draft.revision` is the line's revision (1 on
  create, +1 on every write through this server), present only when an open line names the draft.
  The card sends it back as `base_revision` on every save and send, `0` when it had none (a line
  that exists by then means something wrote the draft since). It is the lineage counter rather than
  the content `version`: a write's own `version` is computed from what was sent to the provider,
  and a provider hands content back normalised (Outlook rewrites the HTML), so comparing versions
  would refuse ordinary Save-and-send. A draft edited in a mail client outside these tools does not
  move the revision; that hazard is as before. A lineage read that fails never refuses on revision.
* **Revisions are computed in the database, atomically (review 2, 2026-10-13).** Every write goes
  through `public.draft_lineage_record` (same migration): under a per-inbox advisory transaction
  lock it decides the line, writes `max(revision) + 1`, and returns whether the line had moved since
  the caller resolved it (`contended`). `UNIQUE (inbox_id, line_id, revision)` backs it; it fits both
  line shapes (IMAP adds a row per write, Gmail and Outlook move one row's revision up in place).
  Before, the edge function read the head and wrote head + 1, so two writers that read revision N
  both wrote N+1 and a card holding N+1 passed its check against content it never saw. A contended
  record is still written, but its writer is given no revision to vouch for (the save's envelope
  carries the revision the card loaded, the model's update carries none): the line is past it, so
  that card's next save or send is refused and it re-reads. Service role only; `anon` and
  `authenticated` can neither execute it nor touch the table. A database without the function fails
  soft (nothing recorded), like a database without the table.
* **The window that remains, stated.** The check and the provider write cannot be one atomic step
  (the provider is not our database). The card's save checks as late as it can (immediately before
  the provider write) and every writer's record says whether another write was recorded since its
  read. What is left: a model update and a card save whose provider writes overlap. The later
  provider write wins in the mailbox, and the server cannot tell which that was; the record of the
  second to be recorded is contended, so neither the card nor the model is told a revision that
  vouches for the mailbox's content, and the card's next action re-reads. The card's write can
  therefore overwrite a concurrent model update (or the reverse) without either being refused at
  that moment; nothing is ever SENT on a stale revision. A draft written outside these tools (a mail
  client) does not move the revision at all.
* **`base_revision: 0` is "no recorded revision", not "unknown".** A card whose lineage read failed
  (the envelope then has no `revision`) sends `0`, and once the lineage answers again its next write
  is refused as `draft_changed` although nothing changed; "Load the newer version" re-reads and the
  editor carries on. Treating `0` as "do not check" would be the unsafe reading: a draft that had no
  line when the card loaded it and was then rewritten by the model would pass. The spurious refusal
  is the accepted cost.
* **A line closed by a send is never sent or rewritten again.** `draft{action:"send"|"update"}`
  refuse it with log code / `error_code: "draft_already_sent"`, whoever calls (model, card, or an
  approved re-run): on IMAP the post-send delete is best-effort, so the sent draft's copy can still
  be in Drafts under the same id. The close records that case as `closed_reason: "sent_kept"`.
  `content` for the refusal is a new sentence (`draft_send: draft <id> was already sent. Nothing
  was sent again.`); in a gated workspace a failed receipt with the same code rides in
  `structuredContent`. `draft_read` and `draft_editor_save` keep answering a closed line with
  `draft_not_found` and a receipt that says which of sent / discarded happened.
  **Since 2026-10-15 both say when it was sent, never who** (see "Card activity notes"): the
  refusal reads `draft_send: draft <id> was already sent at <closed_at>. Nothing was sent again.`
  (the old sentence when the lineage has no time). A `draft_read` / `draft_editor_save` of a line
  closed by a SEND now has its own `content` (`Draft <id> was already sent at <closed_at>. It is no
  longer a draft, so this draft_id no longer resolves. Nothing was changed.`); the code
  and the card's receipt are unchanged. A line closed by a delete keeps the not-found sentence.
* **An id the mailbox has given to another message (UIDVALIDITY reset, a mail client) is that
  message.** Where the lineage would redirect an id, or call it closed, the server first asks the
  mailbox whether the id itself still names a message (only on those rare paths). If it does, it is
  treated as a draft with no line: never redirected to another draft, and never reported "already
  sent" unless the line is `sent_kept`, whose message IS the copy of what was sent.
* A send from the card with `base_revision` that is refused as `draft_changed` carries the same
  failed-receipt shape (the card re-reads to load the newer version).
* **An approved held send sends the version that was approved, or nothing (review 2).** A held
  send is queued with the RESOLVED id (so its summary and its re-run name the current draft rather
  than the stale id the caller held) and ALWAYS with a `base_revision`: the line's revision when it
  was queued, else the caller's own, else `0`. The post-approval re-run keeps that id (it does not
  follow the line) and is checked against that revision like a card send, so a draft rewritten
  after the approval was asked for is refused as `draft_changed` on every provider; before, on Gmail
  and Outlook, where the id never moves, it sent whatever the draft said at approval time. A model's
  own send still carries no `base_revision` and may follow the line. The refused re-run marks the
  scheduled send `error` with an `error_detail` written for the approver ("Not sent. The draft was
  changed after this send was approved, ... Review the draft and send it again.";
  `draft-send-plan.ts#approvedSendRefusalDetail`, likewise for `draft_not_found` and
  `draft_already_sent`), and the caller's idempotency record settles as failed with that code.
* **A send-time recipient override is a write (review 2).** `draft{action:"send"}` with `to`/`cc`/`bcc`
  rewrites the stored recipients first and records that in the line every time, also on Gmail and
  Outlook where the id does not move; it used to record only a moved id, which left the draft at its
  old revision with new recipients, and a card at that revision could then Send to people it never
  showed after the model's send was held or failed (`draft-send-plan.ts#applyRecipientOverride`).
* **An IMAP id the server never confirmed is not recorded.** When an APPEND answers without
  APPENDUID and the Message-ID search finds nothing, the draft write still returns `<folder>:0`, as it
  always has. That id names no message and every such write would share it, so it is never written
  into a line (`draft-lineage.ts#draftIdIsRecordable`): the write stands, the line stays where it was.
* Fail soft: a lineage read that fails resolves the id to itself, and a write that fails is logged
  and dropped. The function works without the table (deploy order does not matter).
* Reads report the last save, not themselves: `last_saved_at` / `last_saved_by` come from the line
  (else the mailbox's own timestamp, with `last_saved_by: null`). A Refresh no longer claims a save.
* Tenancy: every lookup is filtered by workspace AND the inbox the call resolved to.

**`draft{action:"send"}` refuses an unusable recipient override (2026-10-13).** `to`/`cc`/`bcc` given at
send time are validated like every other send path (a bare address or `Name <address>`; blanks are
ignored as before). An entry that is not an address, or not a string, fails with log code
`invalid_recipient` before anything is rewritten or sent, instead of being dropped or written as given.

### As built (server)

Implemented 2026-09-16. Server side only; the card is `apps/mcp-app/`.

**Tools.** `draft_read` and `draft_editor_save`, defined in
`supabase/functions/mcp-server/mcp-app-drafts.ts`, registered after the `bulk_*` tools with
`appOnlyReviewCardToolMeta()` (since 2026-09-16 attached per key at `tools/list` rather than in the
registry, and since 2026-10-13 `draft_read` gets `["model", "app"]` instead), listed unconditionally, absent from `BILLABLE_TOOL_NAMES` and from
`IDEMPOTENT_OUTBOUND_OPERATIONS`. Both declare `requiredScope: "manage:drafts"` and no `altScopes`.

**Error codes**, all delivered as a `card: "receipt"` envelope with `state: "error"`,
`outcome: "failed"` and `isError: true` — never a JSON-RPC error: `invalid_arguments`,
`insufficient_scope`, `inbox_not_found`, `draft_editor_disabled`, `draft_not_found`,
`invalid_recipients`, `draft_has_attachments`, `provider_error`, and since 2026-10-13
`draft_changed` (`draft_editor_save` only; see "Draft lineage"). `draft{action:"send"|"update"}`
add `draft_already_sent`, and `draft{action:"send"}` with `base_revision` adds `draft_changed`, as
`isError` text results that carry the same failed receipt in a gated workspace.
Every other `draft{action:"send"|"delete"}` refusal is still a bare `isError` sentence for the model
(draft not found, sending quota, a mailbox to reconnect, the approval queue unavailable, refused
before transmission). The card reads that as an answer, not as a lost one
(`draft-failure.ts#textRefusalCode`, review 2): it says in a person's words that nothing was sent and
leaves Send on (only "not found" holds the editor until a re-read). A send the server calls
`delivery_status: "unknown"` / "may or may not have been delivered", and any sentence the card does not
recognise as one of these, stays a lost answer: re-read, and Send off until the person says so. The not-found and
wrong-workspace cases are byte-identical, so neither tool is an existence oracle.
**Receipt copy is for a person (2026-10-13).** `receipt.headline` / `receipt.detail` are written in
plain words (no scope, tool or argument names, no protocol jargon); `error_code` is unchanged and
`content` keeps the model-facing wording byte for byte.
(`draft_read` produces neither `draft_editor_disabled` nor `draft_editor_hidden`: it answers with
the plain read above instead. `draft_editor_save` still returns both, and `draft_editor_hide`
still returns `draft_editor_disabled`.)

**Gate.** `workspaces.draft_editor_enabled`, read per call and fail-closed
(`workspaceDraftEditorEnabled` in `index.ts`), and resolved once more at `tools/list` as a third
`ReviewCardGates` member. `draft` moved out of `REVIEW_CARD_TOOL_NAMES` into
`DRAFT_EDITOR_CARD_TOOL_NAMES`; `email_compose` and `schedule` stay on the outbound gate.

**Each flag read is retried once (2026-10-12).** Fail-closed is the right answer for a column that does
not exist yet — a hand-deployed function landing before its migration must behave as it did yesterday,
not 500 — and it was the wrong answer for the failure these readers actually meet. On 2026-10-12 at
16:13:51Z PostgREST answered `readInboxDraftEditorHidden` with a `502 Bad Gateway`: the draft was written
fine, the result carried no envelope, and the user got a card-less widget frame. A 502 is over in
milliseconds, so `flag-read-retry.ts#readFlagWithOneRetry` asks once more after 150 ms before the caller
falls back. One retry, not a loop: this runs inside a draft write the user is waiting on, and a flag that
fails twice is treated exactly as before. A retry that then succeeds logs
`draft_editor_gate_read_retried` / `draft_editor_inbox_flag_read_retried`, which is how often this is
happening in production.

Deviations, all small and all deliberate:

* **`draft.in_reply_to` is populated on `origin: "reply"` only.** §8 types its `message_id` as a
  server message id (`"INBOX:42"`), and a stored draft carries only the original's RFC
  `In-Reply-To` header, which is not one. `draft_read` therefore returns `null` rather than a value
  the card would render as openable and could not open. Threading is preserved across a save
  regardless: the headers are read and written back untouched. **`draft.threaded` says so** on every
  path: true when the draft answers a message, whether that is known by server id (reply) or by the
  RFC header a read or an update carried. It exists because `in_reply_to` flipping from an object
  to `null` between a reply and the following update read as "threading lost" and made an agent
  delete a good draft to recreate it (2026-09-17). The plain `draft{action:"update"}` payload carries
  the same `threaded` flag.
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

### As built (2026-10-13) — the model-facing text around the editor

Server side; the card half is `apps/mcp-app/`. An audit of everything a model reads about the
draft editor found it described a surface the model could not use: it was never told a card
existed, could not read a draft back, and could not update one without overwriting the body.

* **Deferred body.** `draftCardToolResult` splits an editor envelope: body to
  `_meta["mcpemails/draft_body"]`, `structuredContent.draft.body` to the `deferred` marker,
  `schema_version` to `review-card-v2` (`DEFERRED_BODY_SCHEMA_VERSION`). One function, so the
  three handlers in `index.ts` did not change shape. `buildDraftEditorEnvelope` still returns the
  body inline and on v1, which is what `draft_read` and `draft_editor_save` publish.
* **`draft_read` for the model.** `reviewCardMetaForListing` hands it
  `modelAndAppReviewCardToolMeta()` (`DRAFT_EDITOR_MODEL_VISIBLE_TOOL_NAMES`). Its `content` is
  `JSON.stringify(buildPlainDraftRead(...))` in both gate states; the body-free summary line is
  now `draft_editor_save`'s alone.
* **Body-optional update.** `applyDraftPatch` is the old body of `runDraftEditorSave`, moved out
  and returning a `kind` instead of a receipt. `runBodylessDraftUpdate` (same module) is the whole
  of a body-less update after inbox resolution: the merge, the payload, and the `read:email` and
  editor-gate decision about the envelope. `executeBodylessDraftUpdate` in `index.ts` only words
  its failures as `draft_update:` lines. Tested behaviourally with injected providers, and
  end to end against real MIME in `draft-rebuild.test.ts` (parse, patch, build, parse).
* **A second `content` block** (`DRAFT_CARD_NOTICE`) on editor-envelope results only.
* **Wording.** `DRAFT_CARD_OUTPUT_SCHEMA.state` lists `cancelled`, which discard and hide have
  always emitted. The server instructions name `approval_*` as a held send, `bulk_*` as a bulk
  plan and `draft_editor_save` as app-only, and list `draft_read` with the reads. The `draft`
  description says when to use it against `email_compose`. `draft_editor_hide`'s description says
  when it is for, and the four human-facing strings that spelled out a tool call
  (`scope:"…"`, `hidden:false`) now say what a person does, which is ask in the chat. The UI
  resource description names the draft editor.

**On the per-operation surface (OpenAI clients, PR #88, merged the same day).** That listing has
no `draft` tool: the five draft writes are `draft_create`, `draft_reply`, `draft_update`,
`draft_send` and `draft_delete`, each carrying `_meta.ui` on the same `drafts` gate
(`PER_OPERATION_CARD_TOOL_NAMES.drafts`). They are the same handlers, so everything in this
section holds there unchanged: the deferred body and `review-card-v2`, the second `content` block,
the `read:email` rule on a body-less update, and `body` being optional on `draft_update`
(`required: ["draft_id"]`). The editor's own three tools are listed from the same definitions with
the same visibility on both surfaces (`draftEditorOwnToolMeta`): `draft_read` and
`draft_editor_hide` `["model", "app"]`, `draft_editor_save` `["app"]`. What differs is prose only.
The `draft_create`, `draft_update` and `draft_list` descriptions there carry the audit's sentences
under that surface's names (`email_send` sends now, not `email_compose`; `draft_update`, not "the
draft tool's 'update'"), through the legacy definitions and `per-operation-wording.ts`, and the
per-operation instructions say `draft_read` reads one draft in full.

One annotation moved because the two changes met: `draft_editor_hide` is `destructiveHint: true`.
#88's rule is that false is for purely additive writes and that being reversible does not justify
it; that rule was not applied to the card-only tools, and this one stopped being card-only.
`draft_editor_save` is still app-only and still `false` (#88's open question stands), and
`draft_update` was already `true`, with or without a body.

Not changed, deliberately: `draft_read` stays out of `BILLABLE_TOOL_NAMES`; the full-body update
still rebuilds an IMAP or Gmail draft from fields with none of the refusals above, as it always
has (only the partial write refuses), and still writes "(no subject)" when it keeps the subject of
a draft that has none; and `CONCEPT-draft-editor.md` still records "update requires body" as the
2026-09-16 observation it was.

**Merged with main on 2026-10-15** (draft lineage, the rich signature, embedded signature images,
the card's QA passes). Three things that meeting decided:

* **The partial write keeps main's rules and adds this section's.** `applyDraftPatch` is main's
  `draft_editor_save` merge (the rich-signature rebuild, `formatting_removed`, the no-op save that
  writes nothing) plus the refusals above. Lineage stays with the callers: the editor's
  `draft_changed` checks run inside it as hooks, in the places main put them, and a body-less
  `draft` update resolves the line in `index.ts` like the full-body one and records its write as
  the agent's, so the card's next save is checked against the new revision.
* **Our own embedded signature images are not a rebuild blocker.** An inline image whose
  Content-ID is one of ours (`signature-images.ts#urlFromSignatureCid`) is re-attached by the
  transport from its `cid:`, or turned back into its https URL. Without this exemption every save
  of a draft written with `signature_embed_images` on would have been refused.
* **The hide and hidden-editor texts keep the exact call for the model.** Main gives the person a
  separate copy (`draftFailure`'s person text, and `App.tsx#hiddenDetail` in the card), so the
  "ask in this chat" rewrite of the model-facing strings was not carried.

On the card, a replayed deferred envelope is read once: main's replay check re-reads it with
`draft_read`, which brings the body inline, and the deferred fetch waits for that read.

Known and left as is: with a host that drops result `_meta`, a key that lacks `read:email` sees
the card's body-failed line after a successful create, reply or full-body update, because the
card's fallback `draft_read` is refused with `insufficient_scope`. The draft is written and the
model's result is unaffected.

### As built (card) — unsaved edits across a reload (review 2, 2026-10-13)

`unsaved.ts` keeps the fields a person changed and has not saved in `sessionStorage`, so a reload of
the page puts them back. Two rules were added by the second review:

* **Scoped to the card.** An entry is matched on the inbox, any id the editor held for the draft,
  AND the card's scope: `persist.ts#cardKey`, the identity of the tool call the card was mounted for
  (`i<id>` from `hostContext.toolInfo`, else a salted hash of the tool name and arguments, which the
  host re-sends on every mount, a host MUST). A reload of the same cell has the same scope and gets
  its edits back; a second card on the same draft (on Gmail every card of a draft shares its id)
  starts from the stored draft. Two calls with byte-identical arguments share a scope, and so does
  every card under a host that sends neither `toolInfo` nor arguments; that is the behaviour before.
* **Checked for conflicts.** An entry keeps a fingerprint of each edited field as the server had it
  when the edit was made. A restored field whose server copy has changed since, at mount or when the
  verifying re-read arrives, raises the editor's existing conflict notice ("This draft was changed
  somewhere else ... Use the newer version"), prefixed with "Your unsaved edits from earlier were put
  back." A field changed on the server that the person did not edit simply takes the server's value.

### As built (card): which state wins (QA 2, 2026-10-13)

* **One notice about the person's edits, and only while saving is possible.** "Your unsaved edits were
  put back" and "saving will replace the newer version" are chosen in one place
  (`draft-failure.ts#editsNotice`): none when the card is read only or the draft is `unverified` (the
  notice that says why saving is off already says the text is still here), and a conflict is only
  claimed against a copy that has been checked.
* **"Use the newer version" reads first.** It calls `draft_read` and drops the local edits only once
  that read is on screen. It used to adopt whatever envelope the card held, which on a remount could be
  the result the card was mounted with.
* **Send follows the edit.** Off with no recipient in To, Cc or Bcc on screen, or with text in an
  address field that is not an address. `can_send: false` over a stored draft with no recipients says
  nothing about the key, so adding one turns Send on; the server still refuses a key without send access.
* **A draft that has ended is one line.** Discard answered `draft_not_found` (or `draft_already_sent`)
  ends on a receipt, like a discard that worked. The automatic check of a replayed mount does the same
  when the server says the line was closed (sent or discarded), and a card that had already ended on a
  receipt keeps showing it while the replay is checked, going back to an editor only if the read
  returns a live draft. A check the person asked for keeps the editor (it may hold text to copy) and
  shows when it was last checked.
* **An older card folds.** `store.ts#supersededBy`: a `draft_read` answer with a higher `revision` than
  the card held, `last_saved_by: "agent"`, means a later `draft` call wrote it and mounted its own card.
  The older card shows "A newer version of this draft is below." with "Edit here anyway". Never while
  it holds unsaved edits. No host message tells a card about a later call, so this is found on the reads
  the card already makes (remount, Refresh, a refused save) plus one silent `draft_read` when focus
  comes back into a card whose last answer is older than 30 s. The person's own saves never count. Not
  detected: a newer card the person then saved in (last writer is the user), and a host that sends a
  remounted card no result.
* **Ending while fullscreen asks for inline.** Any receipt, the folded line and the "no longer in
  Drafts" line request `inline` once on arrival.
* **A slow write says so.** After 4 s of a pending save or send the line under the buttons reads
  "Still saving. Gmail can take a moment." in place of the word count, so nothing moves.

### As built (card) — the sent message stays on screen

Added 2026-09-17, card side only. No new field, no new tool, no new server read.

`draft{action:"send"}` returns a `card: "receipt"` envelope, and the card used to render that
the way it renders every other receipt: one line, "Sent." Everything the user had just
written left the screen at the moment they most wanted to read it back, and the only
remaining copy was in a Sent folder the card cannot open. It was the most common complaint
about the editor.

The receipt still wins. `store.ts#carrySentDraft` copies the `draft` payload the card was
already holding onto the incoming receipt envelope, and `components/SentMessage.tsx` renders
it read-only underneath the receipt's own headline, detail and dashboard link.

Deliberately narrow, in all four directions:

* **Only onto a departure.** `outcome: "sent" | "scheduled"`, and never `state: "error"`
  (`store.ts#isDepartedReceipt`, which both the merge and the render read so they cannot
  drift). A discard stays one line: the user asked for the draft to go away, and pinning a
  read-only copy under "Draft discarded" would be the card arguing with them.
* **Only from a live editor**, never from a restore stub, which is empty by design.
* **Never over a server-sent `draft`.** The server sends none today; if it ever does, its
  copy is the better one.
* **Nothing is stored.** `persist.ts#redact` keeps a `draft` for a `draft_editor` card only,
  so a receipt carrying one still persists as an outcome word and a neutral headline. The
  message lives in the frame's memory for as long as the user is looking at it and no
  longer, which is also why a REMOUNT of a sent card is still one line — the draft is gone
  at the provider and there is nothing left to re-request. Pinned by hardening.mjs
  ("and the sent message is still not written to storage").

One server-side change went with it: the send receipt's `detail` no longer embeds a
timestamp. It read `Delivered via IMAP + SMTP at 2026-09-17T08:04:11.394Z.` — an ISO string
inside an English sentence, which is not what §4's own example (`"at 10:04"`) ever asked
for. The server has no timezone and no locale to render a send time in and the card does, so
the sentence now says only where it went (`Delivered via IMAP + SMTP.`, since 2026-10-15
`Accepted by the mail server for delivery.`, see "Card activity notes") and the card formats
the time from `sent_at`, which the §8 merge already publishes at the top level of the same
payload. Its headline is the bare word `Sent` for the same reason: in the card it sits beside
the sender address, where a full stop read as a stray mark.

### As built (card) — "Show" on the line a draft ends on (2026-10-14)

Card side only. No new field, no new tool, no server storage.

A draft card that ends is one line: "Sent", "Draft discarded.", "This draft was already sent.". The
line now has a **Show** link on the right (a disclosure button with `aria-expanded`), which opens the
message read-only in place (`components/SentMessage.tsx`, the same view a send has always opened) and
**Hide** folds it back. Focus stays on the toggle; Hide in fullscreen also asks for inline.

* **Open on arrival only after the person's own Send** in this card, as before. A discard, and every
  reopened card, starts folded.
* **Only a copy the card can stand behind** (`ended.ts#EndedCopy`): the draft it held when its own Send
  was answered (Send writes unsaved changes first, so that is what went out), or the draft as it was on
  screen when the person pressed Discard, unsaved changes included and named ("It includes changes that
  were never saved: the subject."). Discard that finds the draft already gone keeps the same copy and
  says it is the card's ("What was sent may differ."). Never the tool result the card was mounted with:
  on a reopened chat that is the assistant's original text.
* **No copy, no Show.** A send or delete the assistant made (its own card), a draft found sent or deleted
  elsewhere on reopen, and a reopen in another tab or on another device stay one line with no link.
* **Kept in `sessionStorage`, not `localStorage`** (`mcpemails.ended.v1`), for the reason `persist.ts`
  keeps no content and under the rules `unsaved.ts` set: plain text only (no HTML part), scoped to the
  card (`persist.ts#cardKey`) and its inbox, 24 h TTL, at most 10 entries of 200,000 characters. Leaving
  a chat and coming back in the same tab, or reloading, keeps it; a new tab does not. The localStorage
  stub is unchanged, and `storage-audit.mjs` section 4 pins both halves.
* **Discarded copies offer Copy text** (the shared `ui.tsx#useCopy`, the editor's "Copied" that reverts).
* **A reopened card holds its receipt until the check settles.** It used to drop to the editor for one
  render when the check answered "not found" (`unverified`), drawing the assistant's original text for
  a frame; the receipt is now held for as long as `priorReceipt` is.

Pinned by `apps/mcp-app/harness/draft-ended.test.mjs`.
