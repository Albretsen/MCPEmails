# Concept: edit drafts in the MCP App card

Status: concept, nothing built. Written 2026-09-16, verified the same day (§12).
Reads with `contract.md` (the review card's wire contract) and `phase-0-protocol-findings.md`.
Spec cited: MCP Apps SEP-1865, `specification/2026-01-26/apps.mdx` in modelcontextprotocol/ext-apps.

---

## 1. Why this is worth doing

Drafts are the second most used write path on the server, and most of them never come back.
`activity_log`, last 30 days, workspace 4bff20c8 excluded. The names are dispatch names: the
wire tool is `draft{action}` and the log records the legacy action name (`dispatchName`,
`index.ts` ~26107, ~26189).

| Action | Calls | Workspaces |
| --- | ---: | ---: |
| email_send | 3,188 | 95 |
| draft create | 1,241 | 63 |
| draft reply | 258 | 45 |
| draft update | 315 | 34 |
| draft send | 343 | 22 |
| draft delete | 260 | 24 |

By provider: 1,556 draft calls on IMAP inboxes (71 workspaces), 572 on Gmail (7 workspaces),
none on Outlook. About 1,500 drafts are written by an agent each month. Only 343 are sent
through us, and only 315 are ever revised through us. The rest are finished in a mail client,
or abandoned. That gap is the product: the agent writes, the human wants to fix two sentences
and send, and today the only ways to do that are "tell the model to rewrite it" (slow, lossy,
and `update` overwrites the whole body) or "go find it in the mail client" (leaves the
conversation).

The review card already proves the mechanics: a card renders from `structuredContent`, calls
app-only tools through `callServerTool`, requests fullscreen, and can hand facts back to the
model with `ui/update-model-context`. It even has a subject and body edit panel
(`OutboundReview.tsx`, `approval_update`), and §12 confirms that round trip works against the
current reference host. A draft editor is the same shape pointed at a draft instead of a held
send, plus the two things a draft needs that a held send does not: editable recipients, and a
Send button.

## 2. What the user sees

1. The user says "draft a reply to Anna declining the meeting". The model calls
   `draft{action:"reply"}` as it does today.
2. Under the model's text, the host mounts the card with a **draft editor**: From (the inbox),
   To / Cc / Bcc as editable chips, Subject, Body, and a footer: `Save changes`, `Send`,
   `Discard draft`, `Open in fullscreen`.
3. The user fixes the wording inline and clicks **Save**. The card writes the draft back to
   the provider and tells the model, in one factual line, that the user edited it.
4. The user clicks **Send**. What happens next is exactly today's `draft{action:"send"}`:
   * inbox without `send_approval_required`: the draft goes out, the card flips to the
     existing receipt (`card: "receipt"`, `outcome: "sent"`);
   * inbox with `send_approval_required`: the send is held, and the card flips to the
     existing outbound review card, whose Approve button opens the authenticated page.
5. If the user does nothing, the draft sits in Drafts as it does today. The card is an
   affordance on top of the same draft, never a second copy.

The same card can be reached later: `draft_list` results carry an `Open` button per draft
the agent wrote, which fetches the body and renders the editor.

## 3. Wire shape

One new card kind on the existing resource, `ui://mcpemails/review-card.html`. Same envelope,
same `schema_version`, one more discriminator value.

**Skew between card and server is possible and must be designed for.** The spec says a host
"MAY prefetch and cache UI resource content" (Resource Discovery). The reference host v2.0.0
re-reads the resource on every tool call (§12, two calls produced two `resources/read`), but
a caching host will run yesterday's card against today's server. That is what
`schema_version` and the card's "unknown version" screen are for; a new card kind must be
additive within `review-card-v1`, and a card that meets an unknown `card` value must show
the same "update your connector" fallback it shows for an unknown version.

```jsonc
{
  "schema_version": "review-card-v1",
  "card": "draft_editor",
  "state": "editing",                       // new state; terminal states reuse "sent" etc.
  "dashboard_url": "https://mcpemails.com/dashboard",
  "draft": {
    "draft_id": "Drafts:2",                 // the CURRENT id; on IMAP it changes per save
    "origin": "create" | "reply" | "update" | "read",
    "revision": 3,                          // server-side counter, see §5
    "last_saved_at": "2026-09-16T10:04:00Z",
    "last_saved_by": "agent" | "user",
    "identity": { … },                      // §2 Identity from contract.md, the sending inbox
    "recipients": { "to": [...], "cc": [...], "bcc": [...] },   // full bcc here, unlike outbound
    "subject": "…",
    "body": { "text": "…", "html": "…" | null, "truncated": false },
    "attachments": [ { "filename", "size_bytes", "mime_type" } ],   // display only in v1
    "signature": { "embedded": true, "source": "manual" | "gmail_import" | null },
    "in_reply_to": { "message_id": "INBOX:42", "from": "…", "subject": "…" } | null,
    "id_is_stable": false                   // false on IMAP: the card must adopt every returned id
  },
  "provider": { "label": "IMAP + SMTP", "route": "APPEND to Drafts", "caveats": [...] },
  "actor": { "can_edit": true, "can_send": true, "reason": null }
}
```

`bcc` is full here where the outbound card carries only a count. The outbound card hides bcc
because the reviewer may not be the author. A draft editor is the author's surface: you cannot
edit a field you cannot see.

**Channels stay split as in contract §2a.** `content` keeps today's create / reply / update
payload byte for byte (`draft_id`, `subject`, `to`, `created_at`, `untrusted_content`). The
envelope goes to `structuredContent` only. The body is the model's own text on create and
reply, so nothing new reaches the model on those paths.

## 4. Tools

The card calls three tools. All three carry `appOnlyReviewCardToolMeta()` (the same
`visibility: ["app"]` hint the `approval_*` tools carry), are audit-logged and non-billable,
and re-verify inbox ownership and scope on every call.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `draft_read` | `{ inbox_id, draft_id }` | `card: "draft_editor"`, body fetched from the provider |
| `draft_editor_save` | `{ inbox_id, draft_id, expected_revision, to?, cc?, bcc?, subject?, body_text? }` | `card: "draft_editor"` with the new `draft_id` and `revision` |
| `draft{action:"delete"}` (existing) | `{ inbox_id, draft_id }` | `card: "receipt"`, `outcome: "discarded"` |

Send is **not** a new tool. The card calls the existing `draft{action:"send"}`, which already
does the right thing per inbox (§2 step 4). This keeps contract §6's invariant literally true:
the card gains no power the model did not already have, and the single irreversible action
that is held off-channel (approving a held send) stays there.

Why `draft_editor_save` rather than the card calling `draft{action:"update"}`:

* **`body` is required.** Verified live: an update with only `subject` is refused with
  "arguments.body is required". The editor must be able to fix a subject or add a Cc without
  re-sending the body.
* **Signature.** `update` embeds the signature on every call. The editor shows the user the
  stored body, signature included, so a save must write that text as-is or the signature
  doubles. `draft_editor_save` never applies a signature, the same rule `approval_update`
  follows.
* **HTML part.** A `body_text` save on a draft with an HTML part regenerates the HTML from
  the text through `plainTextBodyToHtml`, exactly the fix `approval_update` needed on
  2026-09-09 (`mcp-app-approvals.ts` ~1227). Never write the two parts independently.
* **Last writer.** The tool name is how the server learns "a person typed this". Phase 0 Q2
  means the server cannot tell an app call from a model call, so this is a hint at the same
  trust level as `visibility`, not a control. The harm when it is wrong is a clobbered draft
  the user is looking at, which is acceptable.

`draft_read` is what lets `draft_list` become a launcher. `imapGetDraft`, `gmailGetDraft` and
`outlookGetDraft` already exist in `index.ts`; the tool is a thin envelope over them.

## 5. The IMAP id problem, and the conflict rule

On IMAP every save rewrites the message, so the draft gets a new UID and a new `draft_id`.
Verified live on demo@ (Migadu IMAP): create returned `Drafts:1`, update returned `Drafts:2`,
and a second update with `Drafts:1` was refused as stale. In production, 17 of the 19
`draft update` calls that failed with `draft_not_found` in the last 30 days were on IMAP
inboxes. A human editing in the card makes this worse: the model holds the old id in context,
the user saves twice, the model's next update fails on a stale id, and it may recreate the
draft from its own stale copy.

Fix it server-side with a **draft lineage** table, written on every create, reply, update and
editor save:

```
draft_lineage(workspace_id, inbox_id, root_id, draft_id, revision, written_by, subject,
              body_sha256, created_at)
```

Three things fall out of it:

1. **Stale ids resolve.** Every draft action and the two editor tools accept any id in the
   lineage and act on the current one. The "reusing the previous id will fail" warning can
   go. This is worth shipping alone.
2. **Human edits win.** `draft_editor_save` carries `expected_revision`. If the lineage has
   moved on, the card gets `state: "conflict"` with both versions and offers "keep mine" or
   "reload theirs". A model `update` on a draft whose latest revision was
   `written_by: "user"` is refused with an `isError` result carrying the current subject and
   body, so the model re-issues from what the person actually wrote instead of overwriting
   it. Same pattern as the cap rejection: an `isError` tool result, not a JSON-RPC error.
3. **`draft_read` is scoped** to ids present in the lineage. See §6 for what that does and
   does not buy.

Lineage rows expire with the retention window of the plan (30/90/365 days), and a send or a
delete closes the line.

## 6. What a hostile agent gets

Assume every app-only tool is called by a prompt-injected model, as contract §6 requires.

| Tool | Worst case | Why it is acceptable |
| --- | --- | --- |
| `draft_editor_save` | Overwrites a draft | `update` already does this. Visible in the card and in Drafts. Reversible by the user. |
| `draft_read` | Reads a draft body | **Not new information on IMAP or Outlook.** Verified live: `email_read{action:"read"}` with a draft's id returns the full draft body on IMAP, because a draft id there is a folder:uid pair like any message id; Outlook draft ids are Graph message ids and read the same way. Only Gmail keeps draft ids separate from message ids. So the lineage restriction on `draft_read` is for Gmail parity and tidiness, and it requires `read:email` as `draft_reply` does. It is not a boundary and must not be described as one. |
| `draft{action:"send"}` via the card | Sends | Unchanged from today, including the approval hold. |
| `draft{action:"delete"}` via the card | Deletes a draft | Unchanged from today. |

Model-context discipline after a user edit: the card calls `ui/update-model-context` with
facts only, never text the model must act on:

> User edited draft Drafts:2 in the editor at 10:04. Subject unchanged. Body now 412 words,
> was 380. Recipients: added cc anna@x.com. Current draft_id is Drafts:3.

Not the body. Two spec facts shape this. "Each request overwrites the previous context sent
by the View", so the line must be a complete statement of the draft's current state, not a
delta from the last line. And the host "MAY defer until next user message", so the model
learns of the edit on the user's next turn, which is fine: the next thing the user does is
usually click Send. Note that the existing review card sends **no** context line after
`approval_update` (`App.tsx#run` is called without one), so this is new behaviour, not a
port.

## 7. The card itself

* **Layout.** Inline mode shows recipients, subject, the first ~12 lines of body and the
  footer. `ui/request-display-mode: "fullscreen"` gives a real compose surface; the card
  asks for it when the user focuses the body. The spec requires the View to declare
  `availableDisplayModes` at `ui/initialize`; our bridge already declares
  `["inline", "fullscreen"]`, and the request round-trips on the reference host (§12).
* **Recipients.** Chips with add/remove and address validation in the card. No autocomplete
  in v1: `contact_search` is billable and a tool call per keystroke is the wrong shape.
* **Body.** Plain-text textarea. HTML drafts render read-only behind the existing sanitised
  toggle; editing HTML in a card is out of scope. Saving text regenerates the HTML (§4).
* **Reply context.** For a reply, a collapsed "Replying to" line (from, subject, date) from
  `in_reply_to`. The stored reply body already contains the quoted original inline
  (verified: "Probe reply body line.\n\nOn Tue, 15 Sep 2026 …, demo@ wrote:\n> this is a
  test"), so the editor shows the quote as ordinary body text. No quote folding in v1.
* **Attachments.** Listed, not editable. **Today's `update` already drops them on IMAP and
  Gmail**: `imapUpdateDraft` and `gmailUpdateDraft` rebuild the MIME from the call's
  parameters through `buildDraftMime`, which has no attachment parts, and only
  `outlookUpdateDraft` is a PATCH that leaves them alone. Drafts we create have no
  attachments, so this only bites a draft someone attached to in their mail client. The
  editor must not inherit it: `draft_editor_save` re-attaches the existing parts on IMAP and
  Gmail. Test it.
* **Dirty state.** Save is disabled until something changed. Send with unsaved changes saves
  first, then sends, as one card action with two tool calls; if the save fails the send does
  not run.
* **Unsaved edits on teardown.** The spec has `ui/resource-teardown`: the host "MUST send
  this notification before tearing down the UI resource, for any reason" and "SHOULD wait
  for a response before tearing down the resource (to prevent data loss)". Verified: the
  reference host sends it on close and our bridge answers it. So the editor saves a dirty
  draft in its teardown handler before replying, which is the mechanism for not losing a
  half-typed edit. `sessionStorage` is a secondary net only: the spec requires
  `allow-same-origin` on the sandbox so storage exists, but "state persistence and
  restoration" is explicitly deferred in the spec, so nothing guarantees a remount reads it.
* **Staleness.** `last_saved_at` plus a Refresh action (`draft_read`). The provider can be
  edited outside between calls; `untrusted_content` already says so.
* **Everything is hostile input.** Subjects and reply metadata come from third parties.
  `neutralizeDeep` at the boundary, no `innerHTML`, as the review card does today.

## 8. Gating and cost

`_meta.ui` is per tool, and the reference host mounts and fetches the 53 KB bundle for every
result of a tool that carries it (§12). The review card gates its tools per key because an
ungated send produces nothing the card can render. A draft tool is different: every
successful create, reply and update **always** has a draft to show, so the card is never a
skeleton. Stamp `_meta.ui` unconditionally on the consolidated `draft` tool, and add
`draft_list` once the launcher exists.

The wire surface is the 8 consolidated tools. Verified live: `tools/list` returns `draft` and
`draft_list`, and calling `draft_create` by name is refused with "Unknown tool". The
metadata therefore goes on `draft` and nowhere else. The `_meta` gate in
`reviewCardMetaForListing` already lists `draft` under the outbound gate; it must move to an
unconditional stamp for this tool, while `email_compose` and `schedule` keep their gate.

Two costs to name:

* ~1,500 draft results a month means ~80 MB of bundle egress a month. Negligible.
* Hosts without MCP Apps ignore `_meta.ui` and see byte-identical `content`. That is the
  degradation rule, and it is the whole gate. A `draft_editor` boolean per workspace,
  default on, is cheap insurance if a host turns out to render the card badly.

`_meta.ui.visibility` is enforced by the host, per spec: "Host MUST NOT include tools in the
agent's tool list when their visibility does not include `model`" and "Host MUST reject
`tools/call` requests from apps for tools that don't include `app`". Verified: the reference
host's picker hides the four `approval_*` tools. It remains a host rule, not a server one;
contract §6 stands.

## 9. Phases

1. **Lineage + stale-id resolution.** Table, write on every draft path, resolve on read.
   Ships value with no card at all (the IMAP id footgun goes away), and everything after
   depends on it.
2. **Read-only editor.** `draft_read`, the envelope on create/reply/update, the card
   rendering with Save disabled. Proves the mount and the model-context line.
3. **Save.** `draft_editor_save` with the signature, HTML and attachment rules, conflict
   handling, the update-model-context line, save-on-teardown. This is the feature.
4. **Send and Discard.** Card wiring to existing `draft{action:"send"|"delete"}`, the flip
   into receipt or outbound review.
5. **Launcher.** `_meta.ui` on `draft_list`, an Open button per lineage draft.

## 10. How we will know it worked

The hypothesis is that agent-written drafts die because finishing them means leaving the
conversation. Watch, per month, split by signup cohort as usual:

* share of draft create + reply that end in a draft send within 7 days (baseline from §1:
  roughly 343 of 1,500);
* `draft_editor_save` calls and distinct workspaces;
* `draft update` calls carrying a stale id, which should go to zero after phase 1.

If saves happen but sends do not move, the editor is a nicer viewer and the gap is somewhere
else.

## 11. Open questions

* Does Claude's host keep the iframe mounted across the model's next turn, and does it cache
  the resource? The reference host does neither, and the spec allows both. Save-on-teardown
  covers the first; `schema_version` covers the second. Confirm on the real host before
  phase 3.
* Should Send in the card, on an inbox without approval, ask a second time? Today the model
  sends without asking and a human click is strictly more consent than that, so no. Revisit
  if the card ever runs in a shared or kiosk context.
* Attachments on create: the card cannot add them (CSP is empty on every axis and there is
  no upload channel). Attach-by-reference from a message is the only realistic path and it
  belongs to a later phase.

## 12. Verification log (2026-09-16)

**Spec.** Read `specification/2026-01-26/apps.mdx` at ext-apps `6d9bdc7` (v2.0.0). Quoted
above: tool-result is sent "when tool execution completes (if the View is displayed during
tool execution)"; update-model-context overwrites and may be deferred; display modes are
inline / fullscreen / pip and the View declares which it supports; visibility rules are host
MUSTs; resource caching is a host MAY; state persistence and restoration are deferred;
sandbox MUST have `allow-scripts` and `allow-same-origin`; `ui/resource-teardown` is a
request the host waits on.

**Reference host, live.** Cloned ext-apps v2.0.0 into the scratchpad, built `basic-host`,
ran it against `apps/mcp-app/harness/fixture-server.mjs` in the Browser pane (launch
entries `mcp-app-fixture` and `mcp-app-host` in the git-ignored `.claude/launch.json`; the
host entry points at the scratchpad checkout and will not survive it). Observed:

* the card mounted from `fx_outbound_gmail`, received `tool-input` and `tool-result`;
* `Details` sent `ui/request-display-mode {mode: fullscreen}` and the host honoured it;
* the edit panel's Save sent `tools/call approval_update` from inside the iframe with the
  edited `body_text`, and the fixture answered; no model-context update followed (see §6);
* two tool calls produced two `resources/read` of 53,254 bytes: the v2 host declares an
  `appHtmlCache` and never reads it;
* the picker listed 15 fixture tools and none of the four `visibility: ["app"]` tools;
* Close sent `ui/resource-teardown` (id 0) and the card replied with a result.

**Production, live.** Minted a one-hour key scoped to `demo@mcpemails.com` (Migadu IMAP,
`manage:drafts` + `read:email`), called the edge function over HTTP, deleted the key and
confirmed 401. Observed: `tools/list` is the 8 consolidated tools with `_meta` absent on
`draft`; create → `Drafts:1`; `draft_list` returns subject and recipients, no body;
`email_read{action:"read"}` on `Drafts:1` returns the full body; update → `Drafts:2`;
update with `Drafts:1` → `isError` "no longer exists … returns a NEW draft_id"; update
without `body` → "arguments.body is required"; reply stores the quote inline; every probe
draft deleted, Drafts empty afterwards. The demo inbox has `signature_enabled` but no
signature text, so signature embedding was confirmed in code only
(`applyReplyForwardSignature`, `include_signature` on create).

**Found along the way, not fixed.** `OutboundReview.tsx:359` still says "The HTML version is
kept as is." The server has regenerated the HTML part from `body_text` since 2026-09-09
(`mcp-app-approvals.ts` ~1227), so the card's copy contradicts what actually happens.
