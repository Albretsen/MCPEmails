# Code Audit Fixes

Pre-launch fix list derived from the full code audit. Check off each item as it is fixed and merged.

---

## Stop-the-Launch

- [x] **Activity log partition overflow** — Migration `20260526000001_activity_log_future_partitions.sql` creates partitions through 2027-12 and installs a pg_cron job (`ensure-activity-log-partitions`) that auto-creates 3 months ahead on the 1st of every month.
- [x] **`.env` committed to repo** — Verified `.env` was never committed to git history (audit was a false positive). `.gitignore` already covers it correctly. No action needed.
- [x] **SOLO Stripe tier prices missing from `.env.example`** — Added `STRIPE_PRICE_SOLO_MONTHLY` and `STRIPE_PRICE_SOLO_YEARLY` to `.env.example` in the Stripe section.

---

## Security

- [x] **State nonce reuse in `/authorize`** — `storeStateNonce()` now uses `insert` (not upsert). Duplicate `(session_id, state_hash)` rows throw an error, enforced by the existing `UNIQUE` constraint. The authorize page's error boundary surfaces this to the user.

- [x] **In-memory rate limiting on OAuth endpoints** — Migration `20260526000002_rate_limit_buckets.sql` creates a `rate_limit_buckets` table and atomic `rate_limit_check()` Postgres function. New `src/lib/rate-limit.ts` helper wraps the RPC. Both `/api/oauth/token` and `/api/oauth/register` now use it — rate limiting is consistent across all Vercel instances.

- [x] **No session/IP binding on email-provider OAuth callbacks** — All three callbacks (`/auth/gmail/callback`, `/auth/fastmail/callback`, `/auth/outlook/callback`) now call `supabase.auth.getUser()` at the top and return `session_expired` if no valid session exists. After finding the state row they also assert `oauthState.user_id === user.id`, returning `session_mismatch` if they differ. Defense-in-depth on top of the existing RLS policy.

- [x] **No Content-Security-Policy** — Added comprehensive CSP to `vercel.json` (production) and `next.config.js` (local dev): `default-src 'self'`, `script-src` with Stripe, `img-src` with Supabase/Google/GitHub avatars, `connect-src` with Supabase WebSocket, `frame-src` for Stripe, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.

- [x] **CSRF key reuse** — Introduced `CSRF_SECRET` env var (separate from `ENCRYPTION_KEY`). Updated `csrf.ts` `getKey()` to use it, added to `.env.example` with generation instructions, and added to `REQUIRED_ALWAYS` in `next.config.js`.

- [x] **Auto-approval in `/authorize` skips user interaction** — Removed the silent GET redirect for pre-consented scopes. Now always renders the consent UI; passes `preApproved={true}` to `AuthorizeApp` which shows a green banner: "You've previously authorized this app. Confirm below to issue a new token."

- [x] **No rate limiting on `POST /api/api-keys`** — Added per-workspace rate limiting (max 20 creations/hour) using `checkRateLimit('api-keys:create:<workspaceId>', 20, 3_600_000)` after workspace resolution, before the plan cap check.

- [x] **`ENCRYPTION_KEY` only length-validated** — Added startup check in `next.config.js` that rejects all-same-byte and ascending/descending sequential keys. Updated `.env.example` to document the strong-randomness requirement.

- [x] **No disabled-client check at token exchange** — In `/api/oauth/token`, immediately after `createServiceRoleClient()` and before any grant-type branch, re-queries `oauth_clients` for `deactivated_at` and returns `invalid_client` if the client is missing or deactivated. Applies to both `authorization_code` and `refresh_token` grants.

---

## Backend / Database

- [x] **IMAP support is schema fiction** — Removed generic IMAP from all marketing copy (Sections.jsx, PricingClient.jsx, DocsClient.jsx). Supported providers are now accurately listed as Gmail, Outlook, and Fastmail only. Dead schema columns (`imap_host`, `imap_port`, `imap_tls`) retained as reserved for future implementation.

- [x] **`manage:drafts` and `manage:folders` scopes are unimplemented** — Removed from `VALID_SCOPES` in `authorize/page.js` and `api/oauth/authorize/route.ts`, removed from `SCOPE_META` in `authorize/page.js`, and narrowed the `requiredScope` union type in the edge function. Clients can no longer request these scopes.

- [ ] **Multi-user workspace schema** — Design and migrate a full collaborator model:
  - `workspace_invites` table (token, email, role, expires_at, accepted_at)
  - `POST /api/workspaces/invite` — send invite email, store token
  - `GET /api/workspaces/invite/[token]` — accept page
  - `POST /api/workspaces/invite/[token]/accept` — consume token, create `workspace_members` row
  - `DELETE /api/workspaces/members/[userId]` — remove member
  - `PATCH /api/workspaces/members/[userId]` — change role
  - Dashboard UI for managing members and pending invites
  - RLS policies that grant members access scoped to their role

- [x] **No CHECK constraints on enum columns** — Migration `20260526000004` adds constraints on `workspaces.plan` (`free|solo|pro|enterprise`), `inboxes.provider` (`gmail|outlook|fastmail|imap`), `inboxes.status` (`pending|active|error|revoked`), `activity_log.status` (`success|error|rate_limited` — propagated to all partitions), `oauth_states.provider`, and `oauth_auth_codes.code_challenge_method` (`S256` only). `workspace_members_role_check` was already present from migration 000003.

- [x] **No retention policy on activity log** — Migration `20260526000004` schedules pg_cron job `activity-log-retention` running daily at 02:00 UTC: `DELETE FROM activity_log WHERE created_at < now() - INTERVAL '90 days'`. Window is documented as `ACTIVITY_LOG_RETENTION_DAYS` constant in the migration.

- [x] **`oauth_refresh_tokens` missing index on `expires_at`** — Migration `20260526000004` adds `oauth_refresh_tokens_expires_at_idx` on `(expires_at)`. Verified in DB.

---

## Frontend / UX

- [x] **No loading state on API key creation** — Added `creating` boolean state to `KeysPage`. `handleCreate` sets/clears it with try/finally. Header "New key" button shows "Creating…" + refresh icon while in-flight; empty-state "New key" button is disabled. Both buttons disabled during creation to prevent double-submit.

- [x] **Icon-only buttons missing `aria-label`** — Added `aria-label="Refresh inbox"` to the ghost refresh button and `aria-label="Disconnect inbox"` to the ghost trash button in the inboxes table (`Pages.jsx`).

- [x] **Theme toggle missing `aria-label`** — Added `aria-label="Toggle theme"` to the theme toggle in `AuthShared.jsx` and `AuthorizeApp.jsx` (both have `ThemeBtn` components). Sidebar has no theme toggle.

- [x] **Email label truncation without tooltip** — Added `title={inbox.email_address}` to the truncated label `<div>` in `InboxToggle` inside `AuthorizeApp.jsx`.

- [x] **Hardcoded legal page dates** — Created `src/lib/legal-config.js` exporting `LAST_UPDATED` and `EFFECTIVE_DATE`. Both `app/privacy/page.js` and `app/terms/page.js` now import from it; local declarations removed.

- [x] **Optimistic inbox label shows placeholder** — Replaced `address || (label + "@example.com")` with `address || label` in `App.jsx`. For Fastmail (the only sync path), `address` and `label` are both the real email; the `@example.com` suffix is never constructed.

---

## Code Quality / Tech Debt

- [ ] **`typescript.ignoreBuildErrors: true`** — Identify and fix the underlying PostgREST/Supabase type mismatch that is being suppressed. Remove `ignoreBuildErrors` so the CI build fails on real TypeScript errors.

- [ ] **Stripe SDK 4 major versions behind (v17 → v22)** — Upgrade `stripe` package. Review the v18–v22 migration guides; the constructor signature, webhook verification, and several resource APIs changed. Update all usages in `/api/stripe/`.

- [ ] **Manual error tracking system** — Create an `app_errors` Supabase table and a server-side `captureError(err, context)` helper that writes to it. The helper must accept an optional `severity` field and structured `context` object. Design the interface so it can be swapped for Sentry by changing the helper's internals without touching call sites. Add a simple admin view or Supabase dashboard query to review errors.

- [ ] **`@supabase/ssr` 4 minor versions behind (0.6.1 → 0.10.3)** — Upgrade and run the full auth flow locally (password login, Google OAuth, GitHub OAuth, magic link, callback) to confirm nothing regressed.

- [ ] **React 18 → 19 and Next 15 → 16** — Upgrade in a single PR. Run the Next.js codemods (`npx @next/codemod`). Test all pages, middleware, and server actions. This is a significant upgrade — allocate time for it.

- [ ] **`skipLibCheck: true` in `tsconfig.json`** — Remove it. Fix any type errors that surface in `.d.ts` files from dependencies. If a third-party package has unfixable type errors, document the specific package and pin the exception narrowly.

- [ ] **Missing `Cross-Origin-Opener-Policy` and `X-Permitted-Cross-Domain-Policies` headers** — Add to the `headers` block in `vercel.json`:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `X-Permitted-Cross-Domain-Policies: none`
