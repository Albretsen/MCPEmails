# MCP Emails — Email Signatures (Phased Development Plan)

> **Phased development plan.** Adds per-inbox email signatures that are appended server-side on every send/reply/forward/draft/scheduled message, seeded automatically from Gmail where possible, and editable from both the dashboard and an MCP tool.

## Why this exists (the gap)

No mail backend auto-appends signatures on programmatic send. Gmail `messages.send` (raw MIME), Microsoft Graph `sendMail`, JMAP `Email/send`, and SMTP all transmit exactly the MIME we hand them — the signature you normally see is appended by the Gmail/Outlook **client UI**, not the backend. As a result **mcpemails currently sends every email unsigned**, including from Gmail accounts that already have a signature configured. This plan closes that gap so mail Claude sends looks like mail the user sends.

Key facts driving the design:
- **Gmail exposes the existing signature** via `GET users/me/settings/sendAs/{email}` (returns `signature` as HTML) — so Gmail inboxes can be seeded with zero setup. Requires the `gmail.settings.basic` read scope.
- **Outlook/Graph does NOT expose the signature** (stored client-side, not in the mailbox). IMAP has no signature concept. Those providers are set manually.
- **Conventions:** plain-text delimiter is exactly `-- ` + newline (dash-dash-space-newline); HTML signature wrapped in `<div class="...signature">`; two blank lines before it; always keep an HTML + plain-text pair; table-based HTML layout for Outlook compatibility.

## How to use this checklist

- **Work top-to-bottom.** Tasks are ordered so each only depends on tasks above it. Pick the first unchecked box, complete it fully, check it, move on.
- **Each task is sized for a single agent run.** It names the exact files to touch and the reference code to imitate. Do **not** read all of `index.ts` (~18k lines) — jump to the region named in the task.
- **Acceptance is static** (no end-to-end mailbox testing): type-check passes, the change is wired into the existing registry/pattern, and the code mirrors a working handler.
- **Verification gates** (run what applies):
  - Edge function (Deno): `deno check supabase/functions/mcp-server/index.ts`
  - Web app: `npm run build -w apps/web` and `npm run lint -w apps/web`
  - DB: migration file is present and re-runnable (idempotent `IF NOT EXISTS` / guarded).
- **Deploy is out of scope per task.** Leave deploying (`npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt`) and pushing migrations to the human unless told otherwise.

## Reference points in our code

- **MCP server:** `supabase/functions/mcp-server/index.ts`
  - MIME assembly: `buildMimeMessage()` (~L7935) — the single place all bodies are serialized.
  - Per-provider send: `sendGmailMessage` (~L8102), `sendOutlookMessage` (~L8188), `sendFastmailMessage` (~L8363), `sendImapMessage` (~L5699).
  - Reply/forward body builders: `buildReplyTextBody` (~L9453), `buildForwardedTextBody` (~L9418).
  - Draft create/update/send: `executeCreateDraft` (~L16669), `executeUpdateDraft` (~L16751), `executeSendDraft` (~L16891).
  - Consolidated tool registry & dispatch: ~L3247–3505 (registry), ~L18129–18563 (action routing).
- **Inboxes schema:** `supabase/migrations/20260524000000_create_initial_schema.sql` (table `public.inboxes`, ~L85–131).
- **Scheduled sends:** `supabase/migrations/20260603000001_create_scheduled_sends.sql` (table `public.scheduled_sends`, `payload` jsonb holds the full send args).
- **Web settings UI:** `apps/web/app/` dashboard + inbox management components.

Whenever a task touches a send path, the signature must be applied in the **one shared helper** (Task 2), not duplicated per provider — single injection point is itself an acceptance criterion.

---

## Phase 0 — Storage & foundations

### 1. [x] Migration: signature columns on `inboxes` — done: `20260623120000_inboxes_signature_columns.sql` (6 cols, guarded CHECKs on reply_mode + source); web types updated
**What:** Add per-inbox signature storage. New columns on `public.inboxes`: `signature_html text`, `signature_text text`, `signature_enabled boolean NOT NULL DEFAULT true`, `signature_reply_mode text NOT NULL DEFAULT 'first_only'` (allowed: `always` | `first_only` | `never`), `signature_source text` (`manual` | `gmail_import` | null), `signature_updated_at timestamptz`. Signatures are not secret, so **no encryption** (unlike the `oauth_*`/`imap_password` bytea columns). Add a `CHECK` constraint on `signature_reply_mode`.
**Refs:** `supabase/migrations/20260524000000_create_initial_schema.sql` (inboxes definition); migration idempotency style used across `supabase/migrations/`.
**Acceptance:** New idempotent migration file exists (`ADD COLUMN IF NOT EXISTS`), CHECK constraint guarded. Regenerate types if the repo commits generated types. No code reads the columns yet.

### 2. [x] Central `applySignature()` helper (the single injection point) — done: `composeSignatureBlocks()` + `applySignature()` + `escapeSignatureHtml()` at index.ts ~L7942–8120, pure, honor `include_signature`
**What:** Add one helper in `index.ts` that takes the resolved inbox + the outgoing body params and returns body params with the signature applied. Signature is **not** applied here for replies/forwards quoting (Task 4 handles placement) — this helper handles the plain "new message" case and exposes a reusable `composeSignatureBlocks(inbox)` returning `{ text, html }`. Rules:
- If `signature_enabled` is false or both fields empty → return params unchanged.
- HTML: if `htmlBody` present, append `\n<div class="mcpemails-signature">…signature_html…</div>`. If `signature_html` empty but `signature_text` present, derive minimal HTML from text.
- Text: append `\n\n-- \n` + `signature_text`. If `signature_text` empty, derive a plain-text version by stripping `signature_html`.
- If the caller supplied only `textBody` and a signature has HTML, synthesize an `htmlBody` so HTML clients render the rich sig (mirror how multipart/alternative is already built downstream).
- Respect a per-call `include_signature` flag (Task 6) — if explicitly `false`, no-op.
**Refs:** `buildMimeMessage()` (~L7935) for the text/html duality it must stay compatible with.
**Acceptance:** `composeSignatureBlocks()` and `applySignature()` exist and are pure (no I/O). `deno check` passes. Not yet called from any send path.

### 3. [x] Wire `applySignature()` into all plain-send paths — done: extended `INBOX_SELECT_COLUMNS`/`InboxRow`; injected at `executeSendEmail` dispatch (L10748, covers all 4 providers) + scheduled drain (L18881, at send time). `deno check` + web `tsc` pass
**What:** Call `applySignature()` immediately before `buildMimeMessage()` in the new-message send path so every provider inherits it: Gmail, Outlook, Fastmail, IMAP/SMTP. Confirm the inbox row selected in each send path includes the new signature columns (extend the `select` if needed). Scheduled sends: apply at **send time** (when the worker drains `scheduled_sends`), not at enqueue time, so signature edits take effect — confirm where the scheduled worker rebuilds the message and add the call there.
**Refs:** `sendGmailMessage` (~L8102), `sendOutlookMessage` (~L8188), `sendFastmailMessage` (~L8363), `sendImapMessage` (~L5699); scheduled-send drain logic (search `scheduled_sends` / `status = 'pending'`).
**Acceptance:** All four providers + scheduled path call the single helper. No per-provider signature string duplication. `deno check` passes.

---

## Phase 1 — Replies, forwards, drafts & per-call control

### 4. [x] Signature placement in replies & forwards — done: `applyReplyForwardSignature()` + `bodyAlreadyHasQuoteOrSignature()` (first_only guard) called at top of all 8 reply/forward provider fns; sig lands before quote in text+HTML
**What:** Insert the signature **after the user's new text and before the quoted/forwarded block**, honoring `signature_reply_mode`: `always` = every reply, `first_only` = only when the new body has no existing quote/signature marker yet (avoid double-signing when Claude iterates a thread), `never` = skip. Update `buildReplyTextBody` (~L9453) and `buildForwardedTextBody` (~L9418), plus their HTML equivalents if separate, to take the signature blocks and position them correctly.
**Refs:** `buildReplyTextBody` (~L9453), `buildForwardedTextBody` (~L9418); `composeSignatureBlocks()` from Task 2.
**Acceptance:** Replies/forwards place the sig before the quote in both text and HTML. `first_only` does not double-append within a thread. `deno check` passes.

### 5. [x] Signature in drafts — done: `applySignature()` on `executeCreateDraft`/`executeUpdateDraft`; `executeSendDraft` sends verbatim (commented rule, no re-append)
**What:** Apply the signature when drafts are created/updated so what the user sees in the provider's Drafts folder already contains it (don't re-append on `draft_send`, or it doubles). Decide and document the rule: append on `executeCreateDraft`, leave `executeSendDraft` to send the stored body as-is.
**Refs:** `executeCreateDraft` (~L16669), `executeUpdateDraft` (~L16751), `executeSendDraft` (~L16891).
**Acceptance:** Draft create/update embed the sig once; draft send does not re-append. `deno check` passes.

### 6. [x] Per-call `include_signature` override on `email_compose` and `draft` — done: `INCLUDE_SIGNATURE_PROPERTY` added to send/reply/forward/draft_create/draft_update legacy schemas (surfaces on both consolidated tools), threaded to all call sites, default-true preserved; tool descriptions updated
**What:** Add an optional boolean `include_signature` (default true) to the `email_compose` and `draft` tool input schemas and thread it into `applySignature()`. Document it in the tool descriptions so the agent can suppress the sig for terse one-line replies.
**Refs:** consolidated tool registry (~L3247–3505) and action dispatch (~L18129–18563).
**Acceptance:** Both tools accept `include_signature`; default behavior unchanged when omitted. `deno check` passes.

---

## Phase 2 — Seeding from Gmail (remove setup friction)

> **DEFERRED (2026-06-23):** Phase 2 (Gmail signature auto-import) is backed out of the deploy. It requires the `gmail.settings.basic` sensitive scope + Google OAuth re-verification, which the owner is deferring. The code is preserved (scope removed from the request, `maybeImportGmailSignature` call commented out) for easy re-enable.

### 7. [~] Add `gmail.settings.basic` scope to Gmail OAuth — done: added to `auth/gmail/route.ts` GMAIL_SCOPES + callback `oauth_scope`; privacy copy in 5 locales; architecture doc flags re-verification (sensitive scope) — DEFERRED (backed out of deploy 2026-06-23): requires gmail.settings.basic scope + Google OAuth re-verification; code preserved (scope removed from request, `maybeImportGmailSignature` call commented out) for easy re-enable.
**What:** Add the read-only `https://www.googleapis.com/auth/gmail.settings.basic` scope to the Gmail OAuth request so we can read the user's configured signature. Update the requested-scopes list and any consent/marketing copy that enumerates Google scopes. Note: existing connected users won't have it until they reconnect — handle absence gracefully (Task 8 is best-effort).
**Refs:** Gmail OAuth scope list in the connect flow (`apps/web` connect routes + `index.ts` token handling); `Documents/GOOGLE_OAUTH_VERIFICATION.md` for the verified-scope implications.
**Acceptance:** New scope requested on Gmail connect. Copy/docs updated. Build/lint pass. Flag in the plan that this may require re-running Google OAuth verification.

### 8. [~] Auto-import Gmail signature on connect (best-effort) — done: `maybeImportGmailSignature()` via `withFreshGmailToken`, called lazily from `resolveInboxArg` (first touch); imports only when source=null & fields blank; failures swallowed; never overwrites manual edits — DEFERRED (backed out of deploy 2026-06-23): requires gmail.settings.basic scope + Google OAuth re-verification; code preserved (scope removed from request, `maybeImportGmailSignature` call commented out) for easy re-enable.
**What:** After a Gmail inbox is connected (or on first send if the scope is present and the columns are empty), call `GET users/me/settings/sendAs/{email}`, take the `signature` HTML, store it in `signature_html` (+ derived `signature_text`), set `signature_source = 'gmail_import'`. Best-effort: if the scope is missing or the call fails, log and continue — never block connect. Don't overwrite a signature the user has manually edited (`signature_source = 'manual'`).
**Refs:** Gmail API helpers / token usage in `index.ts` (search Gmail `settings` / `sendAs`); connect completion handler.
**Acceptance:** New Gmail connects pre-populate the signature when the scope is granted; failures are non-fatal; manual edits are preserved. `deno check` passes.

---

## Phase 3 — Management surfaces

### 9. [x] Dashboard: per-inbox signature editor (web) — done: `SignatureEditor` in Pages.jsx (textarea + enabled toggle + reply-mode select) in InboxDetailModal; new `PATCH /api/inboxes/[id]` (auth copied from DELETE, service-role write scoped to id+workspace_id); edits plain text, sets source=manual; 5 locales
**What:** Add a signature section to each inbox's settings in the dashboard: an editable field for the signature (textarea for text; a simple rich/HTML field is acceptable — keep layout table-based and width 320–600px per best practice), an **enabled** toggle, and the reply-mode selector (`always`/`first_only`/`never`). Persist via a new authenticated API route (`apps/web`) that updates the `inboxes` row for an inbox the caller owns. Show the imported Gmail signature as the starting value when present.
**Refs:** existing inbox-management UI and API routes under `apps/web/app/`; UI tokens & `Btn` conventions (see project memory `ui-tokens-and-btn`).
**Acceptance:** Editor renders per inbox, saves, and reflects `signature_source`. Owner-only authorization enforced on the route. `npm run build -w apps/web` and lint pass.

### 10. [x] MCP tool action: set/get signature conversationally — done: consolidated `signature` tool, actions `get`(read:email)/`set`(send:email); `executeGetSignature`/`executeSetSignature` resolve via `resolveInboxArg`, set writes fields + source=manual, returns structuredContent; central scope+activity_log
**What:** Add a `signature` capability so the agent can read and set the signature on request (e.g. "set my signature to …"). Either add `action: get | set` to an inbox/settings tool or a dedicated `signature` tool, mirroring an existing consolidated tool end-to-end: registry entry → scope check (reuse a manage-level scope) → handler → `activity_log` write → JSON-RPC result + `structuredContent`. Setting marks `signature_source = 'manual'`.
**Refs:** consolidated tool shape (~L3247–3505, dispatch ~L18129–18563); imitate an existing action tool such as `folder`/`schedule`.
**Acceptance:** Tool reads and writes the signature for a resolved inbox, logs activity, returns structured output. `deno check` passes.

---

## Phase 4 — Docs, marketing & polish

### 11. [x] Update docs, provider-support matrix, and tool reference — done: `signature` tool + `include_signature` added to DocsClient.jsx; "Signatures" + "Signature import" rows in provider-support.md + ProvidersClient.jsx; how-it-works copy in docs.json across 5 locales; "10 tools"; web build passes
**What:** Document signatures across the public docs/tool reference: that signatures are per-inbox, auto-imported for Gmail, manual for others, applied to send/reply/forward/draft/scheduled, with `include_signature` and reply-mode controls. Update `Documents/provider-support.md` and the `/docs` provider/feature matrix with a "Signature import" row (Gmail: auto; Outlook/IMAP/Fastmail: manual). Sync all 5 marketing locales per existing practice. Keep blog naming consistent with current consolidated tool names.
**Refs:** `Documents/provider-support.md`; docs components under `apps/web/components/marketing/`; locale sync precedent in project memory.
**Acceptance:** Docs + matrix + tool reference describe the feature accurately in all locales. Build/lint pass.

### 12. [ ] (Optional) Launch beat
**What:** Short blog post / changelog: "Claude now signs your emails like you do" — covers Gmail auto-import and one-time setup for other providers. Fits the growth-levers track.
**Refs:** blog authoring recipe in project memory (`growth-active-users-pass`).
**Acceptance:** Draft post in the standard blog format across locales; not a code gate.

---

## Phasing summary

| Phase | Delivers | Independently shippable? |
|------|----------|--------------------------|
| 0 | Storage + central append on new sends | Yes — emails get signed |
| 1 | Replies/forwards/drafts + per-call override | Yes |
| 2 | Gmail auto-import (zero-setup) | Yes — removes friction |
| 3 | Dashboard + MCP management UI | Yes |
| 4 | Docs/marketing/launch | Yes |

Phase 0 alone closes the core gap (Claude-sent mail is signed). Each later phase is additive and can ship on its own.
