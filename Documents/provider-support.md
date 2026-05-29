# Email Provider Support — Status & Development Plan

Status: draft · Last updated: 2026-05-29

This document records **what email providers MCPEmails supports today** and lays
out a development plan for adding a **generic IMAP/SMTP connector** plus
first-class presets for **iCloud, Yahoo, Zoho, and Yandex**.

---

## 1. Current state

MCPEmails connects a user's mailbox and exposes it over MCP so AI assistants can
read, search, send, and reply to email through API-key-scoped tools. Every
provider has **two independent halves** that must both work:

- **Connect-time** (Next.js app, `apps/web`) — validate the credential and
  persist an `inboxes` row.
- **Serve-time** (Supabase edge function `supabase/functions/mcp-server`, Deno) —
  the MCP tools (`list_inbox`, `read_email`, `search_emails`, `send_email`,
  `reply_to_email`) dispatch on `inbox.provider`.

| Provider | Connect-time | Serve-time | Credential | Code |
|---|---|---|---|---|
| **Gmail** | OAuth 2.0 | Gmail REST API | `oauth_*` | `auth/gmail/*`, `email-providers/gmail.ts`, edge fn Gmail cases |
| **Outlook** | OAuth 2.0 (MS Identity `common` tenant — personal + work/school) | Microsoft Graph | `oauth_*` | `auth/outlook/*`, `email-providers/outlook.ts`, edge fn Outlook cases |
| **Fastmail** | OAuth 2.0 **or** app password | **JMAP over HTTP** (Bearer for OAuth, HTTP Basic for app password) | `oauth_*` or `imap_password` | `auth/fastmail/*`, `api/inboxes/fastmail-app-password`, `email-providers/fastmail.ts`, edge fn Fastmail/JMAP cases |
| **Generic IMAP** | ❌ none | ❌ none | — | schema-ready only (see below) |

### What already exists for IMAP (but is not wired up end-to-end)

- **Schema is ready.** `inboxes.provider` permits `'imap'`
  (`CHECK (provider IN ('gmail','outlook','fastmail','imap'))`,
  `20260526000004_enum_check_constraints_retention_and_index.sql:13`) and the
  table has `imap_host / imap_port / imap_tls / smtp_host / smtp_port /
  smtp_tls / imap_password` columns
  (`20260524000000_create_initial_schema.sql:99-106`).
- **A Node IMAP engine exists** at `apps/web/src/lib/email/imap.ts`
  (full connect → auth → fetch/search/store → logout, both `XOAUTH2` and
  `PLAIN`). **But it is only used at connect-time for validation** — it is a
  Node `tls` implementation and does **not** run in the Deno edge function.
- **The Fastmail app-password route** (`api/inboxes/fastmail-app-password/route.ts`)
  is the working template for an IMAP `PLAIN` validate-then-upsert flow.

---

## 2. The core gap (the one thing every new provider needs)

The edge function serves Fastmail via **JMAP**, an HTTP protocol Fastmail offers.
**iCloud, Yahoo, Zoho, and Yandex do not offer JMAP** — they are IMAP + SMTP
only. Therefore:

> **Serving any non-JMAP IMAP provider requires a real IMAP client (for
> read/search/list) and a real SMTP client (for send/reply) running inside the
> Deno edge function.** This is the largest work item and is shared by all four
> new providers. Build it once; every preset rides on top of it.

The Node engine in `apps/web/src/lib/email/imap.ts` is a faithful reference but
must be **ported to Deno** (`Deno.connectTls` instead of Node `tls`). There is
currently **no SMTP client anywhere** in the codebase — Gmail/Outlook/Fastmail
all send through their vendor APIs — so the SMTP client is net-new.

---

## 3. Design decisions

1. **One transport, many brands.** Route all new IMAP providers through a single
   `provider = 'imap'` value (already constraint-allowed, no provider enum
   migration needed). The edge function then needs only **one** new `case 'imap'`
   per tool instead of four. Per-row `imap_host/imap_port/smtp_host/smtp_port`
   already carry everything the edge function needs at serve-time — it never has
   to know the brand.
2. **Brand is UX metadata.** Add a nullable `service` column
   (`'icloud' | 'yahoo' | 'zoho' | 'yandex' | 'generic' | null`) purely for the
   dashboard label/icon and to drive host-preset selection at connect-time.
   Additive migration; does not touch the `provider` constraint.
3. **Host-preset registry.** A single shared constant maps `service` →
   `{ imap_host, imap_port, smtp_host, smtp_port, smtp_security }`. Used by the
   connect routes; the resolved hosts are persisted on the row.
4. **Auth = app password (SASL `PLAIN`) for v1** across all four. All four
   require the user to enable 2FA and generate an app-specific password.
   `XOAUTH2` (offered by Yahoo and Yandex) is **deferred** — Yahoo XOAUTH2 needs
   partner approval, and app passwords work immediately.
5. **SMTP must support both transports.** Implicit TLS on 465 **and** STARTTLS on
   587. iCloud's SMTP is `587 / STARTTLS`; the others can use `465 / implicit
   TLS`. The new SMTP client must handle both.

---

## 4. Verified provider settings

All settings below were verified against vendor documentation (2026). All
require **2FA + an app-specific password**; the user's main password will not
work in a third-party client.

| Service | IMAP host:port | SMTP host:port / security | Notes |
|---|---|---|---|
| **Generic IMAP** | user-supplied | user-supplied | Catch-all: corporate/hosted/ISP mail. User enters host/port. |
| **iCloud** | `imap.mail.me.com:993` (TLS) | `smtp.mail.me.com:587` **STARTTLS** | Username may need to be the **full** email. App-specific password from appleid.apple.com. |
| **Yahoo** | `imap.mail.yahoo.com:993` (TLS) | `smtp.mail.yahoo.com:465` (TLS) | Max **5** simultaneous connections. App password (2FA). XOAUTH2 exists but needs partner approval — deferred. |
| **Zoho** | `imap.zoho.com:993` (TLS) | `smtp.zoho.com:465` (TLS) | **Region-dependent host**: `.eu`, `.in`, `.com.au`, `.jp`, etc. Must let user pick region or override host. |
| **Yandex** | `imap.yandex.com:993` (TLS) | `smtp.yandex.com:465` (TLS) | User must **manually enable IMAP** in Yandex settings first. App password (2FA). XOAUTH2 supported — deferred. |
| _(existing) Fastmail_ | `imap.fastmail.com:993` | `smtp.fastmail.com:465` | Served via JMAP, not this path. Listed for reference. |

---

## 5. Development plan (phased)

> **Status (2026-05-29): Phases 0–5 complete and shipped.** The `service` column
> migration is applied to the remote DB, the MCP edge function (with the Deno
> IMAP + SMTP clients and `mime.ts`) is deployed, and all five tools dispatch
> `provider='imap'`. Connect routes (`/api/inboxes/app-password`,
> `/api/inboxes/imap`) and the ConnectModal are wired for iCloud, Yahoo, Zoho
> (with region selector), Yandex, and the generic connector. Sent-folder
> `APPEND` after SMTP send and `/api/inboxes/[id]/check` health checks both work
> for `provider='imap'`. **Not yet runtime-tested against live mailboxes.**
> Deferred by design: XOAUTH2 for Yahoo/Yandex (app passwords work today).

### Phase 0 — Shared foundation ✅
- **Migration**: add `service text` (nullable) to `inboxes`; backfill existing
  Fastmail app-password rows to `service = NULL` (untouched). No change to the
  `provider` check constraint.
- **Preset registry**: new shared constant
  `apps/web/src/lib/email-providers/imap-presets.ts` mapping `service` →
  host/port/security (the table in §4). Mirror the same constant into the edge
  function if it ever needs brand display.
- **Generalize connect-time validation**: extract the Fastmail app-password
  route's `validateImapAppPassword` into a reusable
  `validateImapCredential({ host, port, email, password })` helper so every
  preset and the generic connector share one validated path.
- **UI**: extend `ConnectModal.jsx` provider grid to include the new options and
  a generic "IMAP/SMTP" card; add a credentials sub-step (host/port fields shown
  only for generic). Add `ProviderLogo` kinds for icloud/yahoo/zoho/yandex.

### Phase 1 — Edge-function IMAP + SMTP client (the big one) ✅
- **Port the IMAP engine to Deno**: new module
  `supabase/functions/mcp-server/imap.ts` (use `Deno.connectTls`), covering
  `SELECT / UID FETCH / UID SEARCH / UID STORE / LIST / LOGOUT` and `AUTH PLAIN`
  (reuse the logic in `apps/web/src/lib/email/imap.ts` as the reference).
- **New SMTP client**: `supabase/functions/mcp-server/smtp.ts` supporting
  implicit TLS (465) and STARTTLS (587), `AUTH PLAIN`, `MAIL FROM / RCPT TO /
  DATA`. Build the RFC 5322 message (reuse the existing message-building used by
  the Gmail/Outlook send paths). After a successful send, `APPEND` a copy to the
  Sent folder via IMAP (nice-to-have, do it for parity with API providers).
- **Wire dispatch**: add a `case 'imap':` to each tool's `switch
  (inbox.provider)` (`list_inbox` ~2512, `read_email` ~3611, plus `search_emails`,
  `send_email`, `reply_to_email`). Decrypt `imap_password`, open an IMAP/SMTP
  session against the row's stored host/ports, map errors to the existing
  `McpEmailsError` codes. Update the "Supported providers: gmail, outlook,
  fastmail" fallback strings.
- **Reuse retry logic**: connection-limit retry/back-off already exists for
  Fastmail; apply it generically (Yahoo's 5-connection cap makes this essential).

### Phase 2 — Generic IMAP/SMTP connector ✅
- **Route**: `POST /api/inboxes/imap` — accepts `email`, `password`, `imap_host`,
  `imap_port`, `smtp_host`, `smtp_port`, `smtp_security`; validates via the Phase-0
  helper; upserts with `provider='imap'`, `service=NULL`.
- **UI**: generic card reveals host/port fields; sensible defaults (993 / 465).

### Phase 3 — iCloud + Yahoo presets ✅
- **Route**: `POST /api/inboxes/app-password` (parameterized) — body `{ service,
  email, password }`; looks up hosts from the preset registry; validates; upserts
  `provider='imap'`, `service`.
- **iCloud**: STARTTLS path must be exercised here (587). Try full-email username;
  document the local-part fallback.
- **Yahoo**: copy must point the user to Yahoo app-password generation; respect
  the 5-connection limit.

### Phase 4 — Zoho ✅
- Same route as Phase 3 with a **region selector** since the IMAP/SMTP host
  varies by data center. `ZOHO_REGIONS` (com / eu / in / com.au / jp / ca) is in
  the preset registry; the ConnectModal shows a region dropdown for Zoho and the
  app-password route resolves the region-correct host before validating/persisting.

### Phase 5 — Yandex ✅
- Same route. The preset hint instructs the user to **enable IMAP in Yandex
  settings** first and generate an app password. XOAUTH2 deferred.

---

## 6. Testing & deployment

- **Per-provider matrix**: connect (happy path), wrong password (`AUTH_FAILED`),
  `list_inbox`, `read_email`, `search_emails`, `send_email`, `reply_to_email`,
  Sent-folder append, expired/revoked credential → inbox marked `error`.
- **Connection limits**: verify retry/back-off under Yahoo's 5-connection cap.
- **`/api/inboxes/[id]/check`**: extend the health check to cover `provider='imap'`.
- **Edge-function deploy** (per project convention): deploy via the CLI with
  `npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb
  --no-verify-jwt`. Do **not** use the Supabase MCP deploy tool. Keep IMAP/SMTP
  in separate modules so `index.ts` stays manageable (already ~7,300 lines).

---

## 7. Out of scope — not connectable

These cannot be supported by a cloud service and must not be offered:

| Provider | Reason |
|---|---|
| **Proton Mail** | No server-reachable IMAP. Requires **Proton Bridge**, a paid local desktop app that exposes IMAP only on the user's own machine. |
| **Tuta (Tutanota)** | No IMAP/SMTP; proprietary end-to-end-encrypted protocol. |
| **HEY (hey.com)** | No IMAP/POP/SMTP by design. |

---

## 8. Risks & notes

- **Biggest risk is Phase 1**, not the presets. The presets are thin once the
  Deno IMAP/SMTP client exists; almost all real engineering is the transport
  layer and its error mapping.
- **SMTP deliverability**: sending as the user over their provider's SMTP is
  correct for SPF/DKIM (mail originates from the provider), but test that the
  `From` matches the authenticated account or sends are rejected.
- **Industry trend**: providers are tightening app-password/basic-auth over IMAP
  in favor of OAuth (Microsoft consumer basic-auth retires Mar–Apr 2026 — which
  is why Outlook already uses OAuth/Graph here). Where a provider offers
  `XOAUTH2` (Yahoo, Yandex), plan a later migration from app password to OAuth.
- **Zoho region detection** is the fiddliest preset; default to `.com` with an
  explicit region picker rather than guessing.
