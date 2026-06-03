# mcpemails.com — Pre-Launch Readiness Review

_Generated 2026-06-03. Based on a six-domain parallel review: Security/Auth, MCP server & DB/RLS, Billing/Stripe, Frontend/UX/i18n, Infra/Deploy/Config, Legal/Compliance._

## Verdict

The product is in **good engineering shape** — it builds clean, the OAuth server, encryption-at-rest, API-key handling, and tenant isolation (RLS) are all implemented carefully and correctly. There are **no critical code-security holes** in the auth layer. The launch blockers are concentrated in three areas:

1. **External verification & legal accuracy** (Google restricted-scope verification not started; privacy disclosures don't match what the product does). This is the single biggest gate and has weeks-to-months lead time.
2. **Billing correctness** (revenue leaks + paying customers downgraded on transient payment failures + paid features shipped to everyone).
3. **A few concrete bugs** (MIME/IMAP header injection; scheduled-send cron broken in prod; missing OG image).

Nothing here is insurmountable, but **do not market as generally-available to Gmail users until Google verification is underway.**

---

## P0 — Launch blockers (must fix before public go-live)

### Legal / external verification
- **[L-C1] Google OAuth restricted-scope verification has not been started.** App requests `gmail.readonly`, `gmail.send`, `gmail.modify` (restricted). Until verified + CASA Tier 2 assessment passes: capped at 100 users, scary "unverified app" warning, refresh tokens expire after 7 days (weekly breakage). Lead time weeks–months. → Start now, or launch in disclosed "limited" mode. `GOOGLE_OAUTH_VERIFICATION.md` is a how-to, not a submitted status.
- **[L-M4] Microsoft Publisher Verification not done.** Outlook users see "unverified publisher" warning until MPN + verified domain completed. No CASA/user-cap (easier than Google), but still complete before launch.
- **[L-C2] Privacy Policy omits the `gmail.modify` scope** it actually requests (lists only readonly+send, all 5 locales, `privacy.json` §3.7). Undisclosed restricted scope = near-automatic Google rejection. Add a `gmail.modify` bullet describing label/trash/move/bulk-modify.
- **[L-C3] Privacy/Terms never disclose that email content is sent to the AI provider (Anthropic/Claude).** The entire product streams email bodies to a third-party agent; no legal page mentions Anthropic/Claude or that the AI provider's own privacy terms then govern that content. Material GDPR + Google Limited-Use disclosure gap.

### Billing
- **[B-C1] Inherited "pro" workspaces never get downgraded → permanent free Team access.** `create_workspace()` lets a Team owner spawn extra workspaces that inherit `plan='pro'` with no Stripe subscription; on cancel, only the original workspace reverts to free. Subscribe → create 5 workspaces → cancel → keep 5 Team-tier workspaces forever. (`create_workspace.sql:85`, `webhook/route.ts:309-382`)
- **[B-C2] First dunning event downgrades a paying customer.** `isActive` only accepts `active`/`trialing`; the first `past_due` (card retry in progress, customer still being billed) immediately downgrades to free. Treat `past_due`/`unpaid` as entitled during Stripe's retry window; only downgrade on `subscription.deleted`. (`webhook/route.ts:217-230`)
- **[B-H1] No webhook event idempotency / out-of-order protection.** No `stripe_event_id` dedupe, no timestamp guard — Stripe's out-of-order redelivery can clobber `pro` with stale `free`. Combined with B-C2 this flaps paying users. Add an event-id dedupe table + only-apply-if-newer guard.
- **[B-H2] Documented paid features are shipped to everyone.** `teamRolesEnabled`, `ssoEnabled`, `auditLogEnabled`, `analyticsRetentionDays` are defined but enforced nowhere. The audit-log route has no plan gate (served to Free); usage analytics window ignores retention tier. Since usage is unlimited, these ARE the paid differentiators — selling Team while giving it to Free undermines the model. (`plans.ts:64-75` vs grep)

### Code bugs
- **[M-H1] MIME header injection in outbound mail (HIGH).** `encodeMimeHeaderValue()` returns ASCII verbatim incl. CR/LF; `subject`, attachment `filename` injectable, and `att.mimeType` interpolated completely raw. A prompt-injected agent can inject hidden `Bcc:` to exfiltrate mail. Strip/encode CR/LF before the ASCII fast-path; sanitize `mimeType`. (`mcp-server/index.ts:5885,5983,6057,6060`)
- **[M-H2] IMAP command injection (HIGH).** `quoteImap()` escapes `\`/`"` but not CR/LF; folder names + search query flow into IMAP commands. Agent-controlled `folder`/`query` can run arbitrary IMAP commands (force expunge/delete) on the user's own mailbox. Reject CR/LF in `quoteImap` + inline search quoting. (`imap-client.ts:689`, `index.ts:4261`)
- **[I-1] Scheduled-send cron is live but 100% broken in prod.** pg_cron `dispatch-scheduled-sends` runs every minute, but `app.mcp_server_url` is null and `app.dispatch_secret` is empty on the live DB → every scheduled send silently never sends. Set both DB settings + the Edge Function `DISPATCH_SECRET`, then test.
- **[F-1] `/og.png` does not exist** — every social/Slack/iMessage/X share shows a broken preview card. All pages reference it. Add `public/og.png` (1200×630) or an `opengraph-image.tsx`.

### Infra / config
- **[I-3] Stripe not configured for production.** `.env.vercel` has `ADD_FROM_STRIPE` placeholders for keys/webhook-secret/price-IDs. If those are still placeholders in Vercel prod, checkout 500s. Set live `sk_live_`/`pk_live_`, the live webhook secret, and 4 live price IDs; verify with `vercel env ls production`. (Ties to B-M2/M3: webhook resolves plans from env price IDs — test IDs in a live runtime = no plan ever syncs.)
- **[I-config] Confirm Vercel project root = `apps/web`.** `vercel.json` function paths are relative to `apps/web`; if root is repo root, function overrides + build silently mismatch.
- **[S-H1] Open redirect on login/auth-callback.** `redirect`/`next` guarded only by `startsWith('/')`; `//evil.com` passes and resolves off-site. Amplified because `/authorize` consent funnels through `/login?redirect=...`. Reject `//` and `/\`. (`middleware.ts:62-66`, `auth/callback/route.ts:42`)

---

## P1 — Strongly recommended before launch

### Legal
- **[L-H1] Account deletion doesn't revoke provider OAuth grants** (only nulls local tokens), but Terms §8.5 says grants are revoked — currently false. Reuse the existing per-inbox `revokeGoogleGrant`/`revokeOutlookToken` in delete-account teardown. (Also expected by Google Limited-Use.)
- **[L-H2] "30-day deletion of all personal data" promised, but deletion is soft-only** and `auth.users` (email) is retained indefinitely. Either implement a 30-day hard-delete/anonymize job or revise the policy to state what's actually retained, how long, and why.
- **[L-H3] Refund terms contradict each other.** Pricing FAQ says "full refund within 30 days, no questions asked"; Terms §5.4 says monthly non-refundable + annual only within 14 days. Pick one; in the EEA the public promise tends to bind.
- **[L-H5] GDPR controller identity incomplete.** "MCPEmails, Oslo, Norway" is a brand + city, not a legal entity + registered address + org/VAT no. Add the real entity details.

### Billing
- **[B-M1] No `customer.subscription.created` handler** — subs created outside Checkout (dashboard/portal/API) won't activate until an `updated` fires. Add it, resolving plan by price ID.
- **[B-M2/M3] Verify the 4 live Stripe price IDs are present AND distinct** (`.env.local` shows SOLO monthly/yearly sharing a prefix — confirm distinct). Add a boot assertion + round-trip test. Remove stale `STRIPE_PRICE_ENTERPRISE_*` from `.env.example`.
- **[B-M4] Checkout can double-subscribe.** No-op guard only blocks same-tier; a `pro/month` user can check out `pro/year` → two active subs (double charge). Route plan/interval changes through the portal/`subscriptions.update`; block checkout when an active sub exists. Resolve target workspace by active-workspace cookie, not `owner_id` single().

### Frontend / UX
- **[F-3] `/authorize` consent screen scope list is hardcoded English** for all locales (`SCOPE_META` in `authorize/page.js:30-39`). This is THE conversion + security screen every user hits. Move scope titles/descriptions into `messages/*/auth.json`.
- **[F-2] No `favicon.ico`** (only SVG) — 404s for crawlers/older clients. Trivial add.

### Security / data
- **[M-M1] Encrypted inbox credentials are SELECTable by all workspace members via PostgREST.** `inboxes` SELECT policy returns full row incl. `oauth_*_token`/`imap_password` ciphertext to every member. Matters once Team (multi-member) launches. `REVOKE SELECT` on those columns from `authenticated`; web app reads them via service role only (edge fn already does).
- **[S-M3] `/api/mcp` proxy has no rate limit** and accepts `?key=` (API keys land in CDN/proxy logs + browser history). Add IP rate-limit before forwarding; prefer Authorization header, strip `key`/`api_key` from logs.

### Infra / hygiene
- **[I-9 / S-L] Revoke `EXECUTE` on cron-only SECURITY DEFINER funcs from anon/authenticated** — esp. `dispatch_scheduled_sends()` (anon-callable, fires the HTTP POST trigger).
- **[I-4] `supabase/.temp/` is committed** and churns the tree on every CLI run (it's in the current uncommitted diff). `git rm -r --cached supabase/.temp/` + add to `.gitignore`.

---

## P2 — Polish / post-launch follow-ups

- **[I-2] Distinct prod vs dev `ENCRYPTION_KEY`.** They're currently identical across `.env.local`/`.env.vercel` — a dev-laptop leak would decrypt production tokens. Use a separate prod key (rotation = re-encrypt). Plan secret rotation post-launch.
- **[F-4/F-5] Dashboard Overview activity feed** formats relative time + "unknown inbox" in English regardless of locale (other dashboard pages do it right). Pass raw ISO + localize client-side.
- **[F-8] es `docs.tools.*.title` left in English** while `.desc` is translated (other locales translate both). Decide: translate or keep tool names English everywhere.
- **[F-6] error.js / global-error.js / not-found.js are English-only** (live above locale providers). Acceptable; note for follow-up. Also: not-found primary CTA is "Go to dashboard" — for a public visitor "Back to homepage" is the better primary.
- **[L-M1] Sub-processor list omits Resend, Google, Microsoft** (`privacy.json` §5.1 lists only Supabase/Vercel/Stripe). Add them; consider a versioned sub-processor page for B2B.
- **[L-M2] Reconcile capability docs.** `code-audit-fixes.md` says IMAP/extra scopes were removed; `provider-support.md` + live copy say they're shipped (33 tools). `provider-support.md` also flags IMAP providers as **not yet runtime-tested against live mailboxes** — test before advertising.
- **[S-H1-related / S-L2] Constant-time `/dispatch` secret compare** (`index.ts:16355` uses `!==`; `timingSafeStringEqual` already exists).
- **[B-L1] Handle `invoice.payment_failed`** to email the customer (dunning) instead of the abrupt downgrade.
- **[I-misc] Repo hygiene:** `git rm` the committed `.pending-commit.txt`, `apps/web/.DS_Store`, leftover `apps/web/*.html` mockups + `screenshots/`; expand the 2-line README; pin Node (`"engines": {"node": "20.x"}`); enable Supabase leaked-password protection; move `pg_net` out of `public` schema.
- **[L-L1] Add `/.well-known/security.txt`** (legal pages invite vuln reports but there's no security.txt).
- **[F-7] robots.ts allow-list** is stale vs sitemap (omits `/blog`, `/docs/providers`) — cosmetic.

---

## Current WIP (uncommitted) — ship as one unit
The four modified files are coherent and should be committed together, NOT discarded:
- `oauth/authorize/route.ts` + `AuthorizeApp.jsx` — server-side "at least one scope" validation backstop.
- `mcp-server/index.ts` — moves `list_inboxes` first in `TOOL_REGISTRY` (the documented fresh-connect tool-drop fix).
- These pair with the unapplied migration `20260605000000_widen_dynamic_oauth_client_scopes.sql`.
- (`supabase/.temp/cli-latest` is spurious churn — untrack per I-4.)

Deploy as a unit: commit → `npx supabase db push` the migration → `npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt`.

---

## Confirmed strengths (verified, no action)
- OAuth server: mandatory PKCE-S256 verified server-side, single-use short-lived auth codes, crash-safe refresh rotation, exact redirect_uri match, rate-limited.
- API keys: 256-bit CSPRNG, SHA-256 hashed, shown once, constant-time compare, uniform error to prevent oracles.
- Encryption: AES-256-GCM (random IV + auth tag) for all OAuth tokens & IMAP passwords.
- Tenant isolation: RLS on every tenant table via `my_workspace_ids()`; `resolveInbox` enforces allowlist + workspace match; **the "3-of-7 scopes" bug is fixed** (verified in prod); destructive tools gated by `requireConfirm` + 500-id bulk cap.
- The `proxy.ts` dashboard auth guard is currently **active** (history of being disabled — confirmed intact).
- App builds clean (`next build` + `tsc` 0 errors); strong security headers (HSTS preload, CSP, X-Frame DENY, COOP); no secrets in git history; migrations linear & applied.
- i18n key coverage is **100% across all 5 locales** (the prior docs/scope-key gap is resolved).
