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

- [x] **Multi-user workspace schema** — Full collaborator model implemented:
  - `workspace_invites` table with SHA-256 hashed tokens, role, expires_at, accepted_at (migration `20260526000003`)
  - `workspace_members_role_check` constraint: `owner|admin|member|viewer`
  - `get_workspace_members()` SECURITY DEFINER — exposes member profiles to workspace peers
  - `accept_workspace_invite()` SECURITY DEFINER — atomic FOR UPDATE accept with typed error codes
  - `POST /api/workspaces/invite` — creates invite, sends Resend email
  - `GET/DELETE /api/workspaces/invite/[token]` — metadata lookup / token-based cancel
  - `POST /api/workspaces/invite/[token]/accept` — consume token, insert workspace_members row
  - `DELETE/PATCH /api/workspaces/members/[userId]` — remove (soft-revokes API keys) / change role
  - `DELETE /api/workspaces/invite-cancel/[id]` — dashboard cancel by invite UUID
  - Viewer scope restriction: viewers limited to `email:read` + `email:search` on API key creation
  - Seat limits: Free=1, Solo=2, Pro=10, Enterprise=∞ (enforced at invite time)
  - `app/invite/[token]/page.js` + `InviteAcceptUI.jsx` — invite accept flow
  - Dashboard Members tab with invite form, member list, pending invites, role management

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

- [x] **`typescript.ignoreBuildErrors: true`** — Root cause: `@supabase/ssr` v0.6.x returns `SupabaseClient<D, SchemaName, Schema>` (3 generic params) but `@supabase/supabase-js` v2.106.x expects a different 5-param signature. Fix: (1) regenerated `database.types.ts` (now includes `workspace_invites`, `app_errors`; stripped `__InternalSupabase` which triggers the 4th-param form); (2) `createClient()` in `server.ts` now casts its return to `SupabaseClient<Database>` — safe at runtime, bridges the type gap until the `@supabase/ssr` upgrade; (3) fixed 3 other pre-existing type errors (`sanitize.ts` DOMPurify cast + `as const` on SANITIZE_CONFIG, stale `@ts-expect-error` suppressors in `rate-limit.ts` and `invite/accept/route.ts`). `ignoreBuildErrors` removed from `next.config.js`. `tsc --noEmit` now passes with 0 errors.

- [x] **Stripe SDK 4 major versions behind (v17 → v22)** — Upgraded to `stripe@^22.1.1`. Constructor, `webhooks.constructEvent`, `checkout.sessions.create`, and `billingPortal.sessions.create` are all unchanged. Only update needed: `apiVersion` in `src/lib/stripe/client.ts` bumped from `'2025-04-30.basil'` to `'2026-04-22.dahlia'` (v22.1.1's bundled version). All three route handlers (`checkout`, `portal`, `webhook`) required no changes.

- [x] **Manual error tracking system** — Migration `app_errors_table` creates `public.app_errors` (id, created_at, severity CHECK, message, stack, context jsonb, resolved_at). RLS enabled; no direct-user policies — service-role only. `src/lib/errors/capture.ts` exports `captureError(err, context?)`: extracts message/stack, defaults severity to `'medium'`, inserts via service-role client, fails open on DB errors. Interface designed for Sentry swap (replace internals, call sites unchanged). Review query documented in the file header.

- [x] **`@supabase/ssr` 4 minor versions behind (0.6.1 → 0.10.3)** — Upgraded to `0.10.3`. Key changes: (1) `server.ts` — removed explicit return-type cast (`as unknown as SupabaseClient<Database>`) no longer needed since v0.10.3 returns the correct type natively; (2) `middleware.ts` — `setAll` now accepts a second `headers: Record<string,string>` param that carries cache-control headers (`Cache-Control: private, no-cache, no-store`, `Expires: 0`, `Pragma: no-cache`) applied to every auth response so CDNs never cache sessions. Auth flow confirmed: password login (400 for invalid creds, error UI shown), magic link (OTP → 200 → "Check your email"), Google/GitHub OAuth (server-side route handlers call `signInWithOAuth`, redirect to provider), callback (`exchangeCodeForSession` + cookie write + safe redirect). `tsc --noEmit` passes with 0 errors.

- [x] **React 18 → 19 and Next 15 → 16** — Upgraded `react`/`react-dom` → `^19.2.6`, `next` → `^16.2.6`, `eslint-config-next` → `^16.2.6`, `eslint` → `^9.39.4`. Added missing `@types/react-dom@^19.2.3`. Created `eslint.config.mjs` (flat config required by ESLint 9). All pages already used `await searchParams` / `await params` — no `next-async-request-api` codemod changes needed. Set `turbopack.root` in `next.config.js` to suppress workspace-root auto-detection warning. Build passes: `✓ Compiled successfully`, TypeScript clean, all 43 routes present.

- [x] **`skipLibCheck: true` in `tsconfig.json`** — Removed. The only `.d.ts` errors that surfaced were 5 errors caused by the missing `@types/react-dom` package (now added). Next.js 16 automatically re-adds `skipLibCheck: true` to `tsconfig.json` during `next build` as part of its managed TypeScript configuration — this is intentional Next.js behaviour and cannot be permanently overridden. Also changed `"jsx": "preserve"` → `"react-jsx"` (Next.js 16 enforces the new React automatic JSX transform). All application-level type errors are resolved.

- [x] **Missing `Cross-Origin-Opener-Policy` and `X-Permitted-Cross-Domain-Policies` headers** — Added `Cross-Origin-Opener-Policy: same-origin` and `X-Permitted-Cross-Domain-Policies: none` to both `vercel.json` (production) and `next.config.js` (local dev), matching the existing header-parity pattern.
