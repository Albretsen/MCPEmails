# MCP Emails, Rich Signature Editor (Phased Development Plan)

> **Phased development plan.** Upgrades the signature feature from a plain-text textarea into a proper rich signature editor: HTML formatting (bold, lists, headings, links, colors, alignment) and hosted logo/images, with a live preview. Backend send path already supports HTML signatures, so most of the work is the editor UI, an image-upload path, and input sanitization.

## Context: what exists today

The signature feature shipped 2026-06-23 (see `Documents/signatures-dev-plan.md`), but the editor is text-only. Current state:

- **Editor UI:** `SignatureEditor` in `apps/web/components/dashboard/Pages.jsx` (~L1272 to L1381) is a single `<textarea maxLength=10000>` plus an enabled toggle and a reply-mode `<select>`. It writes only `signature_text`. The save handler lives in `App.jsx` (~L315 to L349).
- **Save route:** `PATCH /api/inboxes/[id]` in `apps/web/app/api/inboxes/[id]/route.ts` (~L186 to L305) accepts only `signature_text`, `signature_enabled`, `signature_reply_mode`. It deliberately clears `signature_html` on text edits and does no sanitization. Stamps `signature_source='manual'`, `signature_updated_at`.
- **DB:** `inboxes` already has `signature_html`, `signature_text`, `signature_enabled`, `signature_reply_mode`, `signature_source`, `signature_updated_at` (migration `20260623120000_inboxes_signature_columns.sql`). No new columns needed for the MVP.
- **Send path (no change needed):** `supabase/functions/mcp-server/index.ts`, `composeSignatureBlocks()` (~L8289), `applySignature()` (~L8335), and the reply/forward variant already inject `signature_html` raw, wrapped in `<div class="mcpemails-signature">`, into the outgoing multipart/alternative body, and derive plain text from HTML via `stripHtmlToText()`.
- **Sanitizers available:** web app has `isomorphic-dompurify@^2.15.0` (installed, unused for signatures), plus `he`, `jsdom`. Edge function has a custom regex `sanitizeEmailHtml()` (~L6405) used for INBOUND email only; it strips external `src`, so it must NOT be applied to signatures.
- **Image/file storage:** none. No Supabase Storage or Vercel Blob usage anywhere. Must be bootstrapped.

## Design decisions (the "reuse, do not build from scratch" reading)

1. **Editor library: TipTap.** The repo has no in-repo editor to reuse, so we adopt TipTap, the established 2026-standard React rich-text editor (ProseMirror based, emits HTML), rather than hand-building a `contenteditable`. Use only the free MIT extensions (StarterKit, Link, Image, TextAlign, TextStyle, Color; Underline; optionally Table). No TipTap Pro / paid extensions. TipTap must run as a client component (`'use client'`), dynamically imported to avoid SSR issues under Next 16 / React 19; pin versions verified against the app's React version.
2. **Images: hosted HTTPS URLs on our own storage.** Per email deliverability best practice, logos are uploaded and hosted (Supabase Storage public bucket), then referenced by URL in `signature_html`. No base64 inlining (Gmail strips large base64) and no CID (fails in webmail). Supabase Storage is chosen over Vercel Blob because the project already runs Supabase with a service-role key; Vercel Blob would add a vendor. 
3. **Sanitization: reuse `isomorphic-dompurify` on input.** Signature HTML is stored and later injected raw into outgoing mail AND rendered in the dashboard preview, so it must be sanitized when it is saved, with a signature-specific allowlist that KEEPS `https` images and safe formatting but removes script/style/event handlers/iframes/SVG. A matching lightweight `sanitizeSignatureHtml()` is added to the edge function for the MCP `signature` tool path (defense in depth), distinct from the inbound `sanitizeEmailHtml()`.

## Non-goals (scope guard)

- No base64 or CID image embedding (hosted URLs only).
- No SVG uploads (XSS vector); raster formats only (png, jpeg, gif, webp).
- No org-wide shared signature templates/management, no signature analytics/tracking pixels.
- Gmail signature auto-import (Phase 2 of the original plan) stays deferred; unrelated to this work.
- No change to the `applySignature`/reply-forward send logic beyond what sanitization requires.

## How to use this checklist

- **Work top-to-bottom.** Each task is sized for a single agent run and names the files to touch.
- **Acceptance is static** unless a preview server is explicitly used: type-check/build passes, the change is wired into the existing pattern, and sanitization/auth gates are present.
- **Verification gates:**
  - Web app: `npm run build -w apps/web` (note: `npm run lint` is repo-wide broken under Next 16; rely on the build).
  - Edge function (Deno): `deno check supabase/functions/mcp-server/index.ts`.
  - DB/storage: migration file present and re-runnable (idempotent / guarded).
- **Deploy is out of scope per task.** Leave deploying (migration push, `npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt`, `vercel --prod`) to the final phase / the owner.

---

## Phase 0, Foundations: sanitization + storage bucket

### 1. [x] Server-side signature HTML sanitizer (web, reuse dompurify) — done: `apps/web/src/lib/sanitizeSignatureHtml.js` (dompurify + afterSanitizeAttributes hook; https-only img, http(s)/mailto links, style filtering; throws on >100KB)
**What:** Add `apps/web/src/lib/sanitizeSignatureHtml.js` (or `.ts`) exporting `sanitizeSignatureHtml(dirtyHtml)` built on the already-installed `isomorphic-dompurify`. Allowlist tuned for signatures: permit `p, br, div, span, strong, b, em, i, u, s, a, ul, ol, li, h1..h4, img, table, thead, tbody, tr, td, th, blockquote, hr, font` and attributes `href, target, rel, src, alt, width, height, style, align, color`. FORBID `script, style, iframe, object, embed, form, svg, math` tags and all `on*` handlers and `javascript:`/`data:` (except allow `data:` NOT for img to avoid huge inline). Enforce: `a[href]` only `http(s)`/`mailto`; `img[src]` only `https:` (and optionally our storage host); add `rel="noopener noreferrer"` to links with `target=_blank`; strip disallowed inline `style` properties (keep color/font/text-align/width/height, drop `position`, `expression(`, url() with javascript). Cap output length.
**Refs:** `isomorphic-dompurify` usage patterns; the edge `sanitizeEmailHtml()` (~L6405 in `index.ts`) for the list of dangerous elements (but note ours KEEPS https img, unlike the inbound one).
**Acceptance:** Pure function, unit-testable, exported. Given `<img src=https://x/y.png>` it is preserved; given `<script>`/`onerror=`/`<svg>`/`src=http://` it is removed or neutralized. `npm run build -w apps/web` passes.

### 2. [x] Supabase Storage bucket for signature assets (migration) — done: `20260708000000_signature_assets_bucket.sql` (public bucket + guarded public-read policy, no anon write)
**What:** Add an idempotent migration creating a public-read storage bucket `signature-assets` (e.g. `insert into storage.buckets (id, name, public) values ('signature-assets','signature-assets', true) on conflict do nothing;`) with a size/mime note. Add RLS/policies on `storage.objects` so public `SELECT` is allowed for this bucket (uploads happen via the service-role client server-side, which bypasses RLS, so no INSERT policy for anon is needed; do not grant anon INSERT). Document the object key convention: `signature-assets/{workspace_id}/{inbox_id}/{uuid}.{ext}`.
**Refs:** existing migration idempotency style in `supabase/migrations/`; Supabase Storage bucket/policy SQL.
**Acceptance:** Migration is re-runnable (guarded), creates a public bucket, and enables public read. No anon write. Present in `supabase/migrations/` (not pushed yet).

### 3. [x] Edge-side `sanitizeSignatureHtml()` for the MCP tool path — done: index.ts L6482; applied at `composeSignatureBlocks` (send-time, all routes) + `executeSetSignature`; preserves https img, `sanitizeEmailHtml` untouched. `deno check` + web build pass
**What:** In `supabase/functions/mcp-server/index.ts`, add a signature-specific sanitizer (regex-based, Deno-compatible, mirroring `sanitizeEmailHtml` structure) that strips `script/style/iframe/object/embed/form/svg`, all `on*` handlers, and `javascript:` URLs, but PRESERVES `https:` `img src` and safe formatting (do not strip external `src` the way `sanitizeEmailHtml` does). Apply it in the MCP `signature` set handler wherever `signature_html` is written, and as a belt-and-suspenders pass in `composeSignatureBlocks()`/`applySignature()` right before the stored HTML is injected. Keep the inbound `sanitizeEmailHtml()` untouched.
**Refs:** `sanitizeEmailHtml()` (~L6405), `composeSignatureBlocks()` (~L8289), `applySignature()` (~L8335), the `signature` tool set handler.
**Acceptance:** New `sanitizeSignatureHtml()` exists and is applied on the tool-set write and at send-time injection; https images survive, scripts/handlers do not. `deno check` passes.

---

## Phase 1, Image upload API

### 4. [x] `POST /api/inboxes/[id]/signature/image` upload route (web) — done: RLS-scoped auth mirrored from PATCH, multipart `file`, png/jpeg/gif/webp only (no svg), <=2MB, service-role upload to `signature-assets`, returns `{ url }` https, 30/10min per-inbox rate cap. Build passes
**What:** New authenticated route that accepts a single image (multipart/form-data or a base64 JSON body, pick what matches the app's fetch patterns). Authorize EXACTLY like the existing `PATCH /api/inboxes/[id]` (caller must own/belong to the workspace that owns the inbox; copy that auth block, do not invent). Validate: content-type in `{png, jpeg, gif, webp}` (reject svg and everything else), byte size `<= 2 MB`. Generate key `signature-assets/{workspace_id}/{inbox_id}/{uuid}.{ext}`, upload via the service-role Supabase client, return `{ url }` (the public URL). Add a basic abuse guard (reuse existing rate-limit plumbing if present, else a simple per-inbox cap).
**Refs:** auth pattern in `apps/web/app/api/inboxes/[id]/route.ts`; service-role client creation used elsewhere in `apps/web/app/api/`; bucket from Task 2.
**Acceptance:** Route rejects unauthorized callers, non-image and >2MB payloads; on success stores to the bucket and returns a public https URL. `npm run build -w apps/web` passes.

### 5. [deferred] (Optional) asset cleanup / delete — DEFERRED 2026-07-08
**What:** `DELETE` support to remove an uploaded asset (owner-scoped), and/or a note documenting that orphaned assets (removed from the signature but left in the bucket) are acceptable for now. Keep minimal; do not build a full GC.
**Refs:** Task 4 route.
**Acceptance:** Either a working owner-scoped delete or an explicit documented deferral. Non-blocking for the feature.

**Decision (deferral):** Deferred as explicitly permitted. Orphaned assets (an image removed from a signature but left in the bucket) are acceptable for now: the bucket is public-read only, objects are small (<= 2 MB, raster), keyed under `{workspace_id}/{inbox_id}/`, and there is no per-file lifecycle to reconcile in the MVP. A safe owner-scoped DELETE also needs careful key ownership validation (the caller-supplied key must be re-checked against the caller's authorized `{workspace_id}/{inbox_id}` prefix to prevent deleting another inbox's asset), which is more surface than this phase warrants. Follow-up options if cleanup is later wanted: (a) an owner-scoped `DELETE /api/inboxes/[id]/signature/image` that only removes keys under that inbox's prefix, and/or (b) a periodic GC that lists bucket objects and drops any not referenced by a live `signature_html`.

---

## Phase 2, Rich text editor UI (TipTap)

### 6. [x] Add TipTap dependencies — done: TipTap v3.27.3 (9 free packages), clean install, React 19 compatible, no peer-dep flags
**What:** Add the free TipTap packages to `apps/web/package.json`: `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `@tiptap/extension-image`, `@tiptap/extension-text-align`, `@tiptap/extension-text-style`, `@tiptap/extension-color`, `@tiptap/extension-underline` (add `@tiptap/extension-table*` only if table layout is wanted). Pin versions that support the app's React version; verify peer deps resolve. No TipTap Pro packages.
**Refs:** `apps/web/package.json`.
**Acceptance:** `npm install` resolves cleanly; `npm run build -w apps/web` still passes (even before the editor is wired). Lockfile updated.

### 7. [x] `SignatureRichEditor` component (client) — done: `SignatureRichEditor.jsx`, forwardRef getHTML()/getText()/isEmpty(), toolbar (bold/italic/underline/heading/lists/align/link/color/image), image upload wired to Phase 1 route, sanitize-on-load+save, scoped CSS in dashboard.css
**What:** New client component (`'use client'`), e.g. `apps/web/components/dashboard/SignatureRichEditor.jsx`, wrapping TipTap with a toolbar: bold, italic, underline, link (add/edit/remove), bullet + numbered list, heading, text color, alignment, and **insert image** (opens file picker, calls the Task 4 upload route, inserts `<img src=publicUrl>` on success with a loading state and error handling). Dynamically import so it does not SSR. Editor initial content = `signature_html` if present, else a simple HTML conversion of `signature_text`, else empty. Expose `getHTML()` and `getText()` to the parent. Match dashboard styling (UI tokens `--bg-surface` etc. and the shared `Btn` component, per project memory; `Btn` drops `style`, use variant/className). Scope the editor CSS so it does not leak.
**Refs:** existing `SignatureEditor` in `Pages.jsx` (~L1272) for props/wiring; dashboard UI token + `Btn` conventions.
**Acceptance:** Component renders, toolbar actions work, image insert round-trips through the upload API, content loads from existing signatures. Build passes. (Optionally verify interactively with the preview server.)

### 8. [x] Swap the textarea for `SignatureRichEditor` in the settings page — done: Pages.jsx swapped (key={inbox.id} remount), save sends signature_html+text, >100KB blocks save with inline error (i18n tooLarge in 5 locales), App.jsx onSave forwards HTML. Build passes
**What:** In `Pages.jsx` `SignatureEditor` (~L1272 to L1381), replace the `<textarea>` with `SignatureRichEditor`, keep the enabled toggle and reply-mode select. On save, compute `html = editor.getHTML()` and `text = editor.getText()`, sanitize `html` client-side (import the Task 1 sanitizer for instant UX; server re-sanitizes authoritatively), enforce a size cap (e.g. 100 KB html), and pass BOTH `signature_html` and `signature_text` to the save handler. Update the `onSave` handler in `App.jsx` (~L315 to L349) and its payload to include `signature_html`. Preserve the Gmail-imported hint behavior.
**Refs:** `Pages.jsx` `SignatureEditor`, `App.jsx` save handler.
**Acceptance:** Editing a signature saves rich HTML + text; switching inboxes reloads correctly; enabled/reply-mode still work. Build passes.

---

## Phase 3, API accepts + sanitizes HTML

### 9. [x] PATCH route accepts and sanitizes `signature_html` — done: `htmlProvided` branch sanitizes+stores (absent→text-clear rules, empty→clear), >100KB→400, source=manual/updated_at preserved, returns persisted html. Needed dynamic import + `serverExternalPackages:['isomorphic-dompurify','jsdom']` in next.config.js. Clean build
**What:** Update `apps/web/app/api/inboxes/[id]/route.ts` (~L212 to L245) to accept `signature_html`: run it through the Task 1 `sanitizeSignatureHtml()`, enforce a max length (e.g. 100 KB), and when provided, STORE it (stop force-clearing `signature_html`). Continue accepting `signature_text` (store the provided text, or derive from the sanitized html if text is omitted). Keep stamping `signature_source='manual'`, `signature_updated_at`. Return the sanitized stored `signature_html` in the response so the client can re-sync to exactly what was persisted.
**Refs:** the PATCH handler (~L186 to L305); Task 1 sanitizer.
**Acceptance:** Posting rich HTML persists a sanitized version; posting malicious HTML persists a neutralized version; text-only clients still work unchanged. Build passes.

---

## Phase 4, Live preview

### 10. [x] Signature preview panel — done: `SignaturePreview` in Pages.jsx, live via editor onChange + mount seed, sanitized `dangerouslySetInnerHTML`, too-large fallback, image-blocked note + faux reply-quote affordance, 4 i18n keys in 5 locales, scoped `.sig-preview` CSS. Build clean
**What:** In the editor UI, add a rendered preview of the signature as it will appear (sanitized HTML via `dangerouslySetInnerHTML` on the Task 1 sanitizer output), and optionally a small "in a reply" mock showing the signature above a quoted block. Note under the preview that some clients (e.g. Gmail) may hide images until the recipient clicks "display images", which is expected for all hosted-image signatures.
**Refs:** Task 7 component; Task 1 sanitizer.
**Acceptance:** Preview reflects edits live and renders images; XSS payloads do not execute in the preview. Build passes. (Optionally verify interactively with the preview server, checking console for errors.)

---

## Phase 5, Docs, verification, deploy

### 11. [x] Update docs, tool reference, provider matrix (5 locales) — done: `tools.signature` desc + `signature_html` param + `providers.notes.signatures` in 5 locales; provider-support.md; no Gmail auto-import claim. Build clean
**What:** Update the public docs / tool reference and marketing to state that signatures now support rich HTML formatting and hosted logo images, editable in the dashboard or via the `signature` MCP tool (which accepts HTML). Note in the provider matrix that images render as hosted URLs across providers and may be image-blocked by default in some clients. Sync all 5 locales (en, es, fr, nb, zh) per existing practice. Update the `signature` tool description if it enumerates accepted fields.
**Refs:** docs components under `apps/web/components/marketing/`; `Documents/provider-support.md`; locale message files.
**Acceptance:** Docs describe rich signatures + images accurately in all locales. Build passes.

### 12. [ ] Full verification and deploy hand-off
**What:** Run all gates: `npm run build -w apps/web`, `deno check supabase/functions/mcp-server/index.ts`, confirm the migration is idempotent. Manually verify the end-to-end flow with the preview server: create a rich signature with a logo, save, reload, confirm persisted HTML, and (if a test inbox is available) send a message and inspect the outgoing HTML contains the hosted `<img>`. Then hand off deploy (migration push, edge function deploy, `vercel --prod`) to the owner, or execute on explicit instruction. Update the relevant memory files.
**Refs:** deploy commands in the "How to use this checklist" section; prior deploy pattern in project memory.
**Acceptance:** All gates green; end-to-end flow verified; deploy steps listed and ready.

---

## Phasing summary

| Phase | Delivers | Notes |
|------|----------|-------|
| 0 | Sanitizer (reuse dompurify) + storage bucket + edge sanitizer | Security + hosting foundation |
| 1 | Image upload API | Enables hosted logos |
| 2 | TipTap editor UI + textarea swap | The visible upgrade |
| 3 | PATCH accepts/sanitizes HTML | Persist rich signatures safely |
| 4 | Live preview | Confidence before sending |
| 5 | Docs + verification + deploy | Ship |

Security note: signature HTML is both rendered in the dashboard and injected into outbound mail, so sanitization on save (Phase 0/3) is a hard requirement, not polish. Hosted-image-only (no base64/CID) and no-SVG are deliberate deliverability and XSS choices.
