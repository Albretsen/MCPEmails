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
| Resource URI | `ui://mcpemails/review-card.html` |
| Resource mimeType | `text/html;profile=mcp-app` |
| Generated Deno module | `supabase/functions/mcp-server/ui/review-card.html.ts` (exports `REVIEW_CARD_HTML`) |
| Frontend source | `apps/mcp-app/` |

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
while sending `capabilities: {}` with no `extensions` key. Behaviour branches on a per-inbox setting
(`send_review_mode`, `bulk_review_mode`), both defaulting to off, so a client that has not opted in sees
byte-identical behaviour to today. The failure direction matters: a wrongly-fired capability guess would
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

Returned by the app-only tool `approval_review`. **Contains decrypted body content and must never be
placed in model context.** The tool result goes to the iframe only; the card calls
`ui/update-model-context` afterwards with a summary that deliberately omits the body.

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

All carry `_meta.ui = { resourceUri: "ui://mcpemails/review-card.html", visibility: ["app"] }` — the
`visibility` is set because well-behaved hosts will keep these out of the model's picker, which is worth
having. It is a tidiness measure, **not** a control. Audit-logged, non-billable (absent from
`BILLABLE_TOOL_NAMES`).

| Tool | Arguments | Returns |
| --- | --- | --- |
| `approval_review` | `{ approval_id }` | envelope, `card: "outbound_review"` |
| `approval_decide` | `{ approval_id, decision: "reject", note? }` | envelope, `card: "receipt"` |
| `approval_update` | `{ approval_id, subject?, body_text? }` | envelope, `card: "outbound_review"` (re-encrypted) |
| `approval_schedule` | `{ approval_id, send_at }` | envelope, `card: "outbound_review"` with `send_at` set |
| `bulk_execute` | `{ plan_id }` | envelope, `card: "receipt"` |
| `bulk_cancel` | `{ plan_id }` | envelope, `card: "receipt"` with `outcome: "cancelled"` |

**`body_html` is not editable and has been dropped from `approval_update`.** The card cannot safely
author HTML, so an earlier draft that accepted it produced a trap: editing `body_text` on a message that
has an HTML part left the HTML untouched, so the edit was a **silent no-op on what actually shipped** —
the reviewer would believe they had corrected an email that then went out unchanged. Required server
behaviour: when `body_text` is supplied for a message carrying `body_html`, the server **clears
`body_html`** and returns `body.html: null` with `format_changed: true`. The message then sends as plain
text. The card must warn before committing. Losing formatting is a visible, understood consequence;
a silent no-op is not.

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

The initial tool result for a gated send contains only what `queueSendApproval` already puts in
`send_approvals.summary` today: to, cc, bcc_count, subject, attachment_count, plus `review_url`. **No new
information is exposed to the model by this feature.** That claim is accurate and is the one to lead with.
