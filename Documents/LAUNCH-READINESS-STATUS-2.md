# mcpemails.com — Launch Readiness, Status Report #2

_Generated 2026-06-03, after the first remediation pass. Supersedes the "fixed this round" section of [LAUNCH-READINESS-REVIEW.md](LAUNCH-READINESS-REVIEW.md)._

## Executive status

Of the P0 launch blockers from report #1, **most are fixed in code and several are already live in production.** Two things gate the remaining work, and both trace to the **same root cause**: there is **unfinished concurrent work in `supabase/functions/mcp-server/index.ts`** (an `inboxId → inbox` parameter rename that was only half-applied) which (a) blocks the edge-function deploy and (b) is mixed into the uncommitted working tree.

| # | Blocker | Code | Prod state |
|---|---|---|---|
| Cron (scheduled sends) | Re-architected to Supabase Vault, no superuser needed | ✅ | ✅ **LIVE & verified** (`/dispatch` → HTTP 200) |
| DB migrations (billing model, webhook ledger, workspace gate, oauth scopes, cron) | 5 migrations | ✅ | ✅ **APPLIED to prod** |
| Vercel prod Stripe (live keys + 4 price IDs) | n/a | — | ✅ **Confirmed present** in Production scope |
| Gmail/Outlook verification warning (toggleable, 5 langs) | ✅ | ⏳ in working tree, not deployed |
| Privacy `gmail.modify` + AI/agent disclosure (5 langs) | ✅ | ⏳ not deployed |
| Billing: per-user subscription, dunning grace, webhook idempotency, paid-features-for-all + workspace gate | ✅ | ⏳ **app not deployed** (DB side IS live — see ⚠️ below) |
| MIME + IMAP header injection | ✅ | ❌ **NOT live** — edge deploy blocked by concurrent refactor |
| Open redirect | ✅ | ⏳ not deployed |
| OG social card | ✅ | ⏳ not deployed |
| Google verification | n/a | ✅ **submitted** (per founder) |

Legend: ✅ done · ⏳ done but needs commit + deploy · ❌ blocked.

---

## ⚠️ Two things that need attention now

### 1. The edge-function security fix is blocked by unfinished concurrent work
`deno check supabase/functions/mcp-server/index.ts` fails with **11 errors**, all `Cannot find name 'inboxId'` (TS2552/TS2304), from an in-progress rename where `inboxId` → `inbox` (`const inbox = await resolveInbox(inboxId, …)`) was applied to the declaration but not the call sites/messages. Clusters at:
- `index.ts:5251, 5258, 5336`
- `index.ts:6326, 6333, 6407, 6428`
- `index.ts:8521, 8528, 8587, 8626`

Until this compiles, the edge function can't be deployed, so the **CRLF MIME/IMAP injection fix is not live.** The currently-deployed (older) edge function still works for the cron dispatch and auth — only the new security hardening is pending.

→ **Action:** finish the `inboxId→inbox` refactor, `deno check`, then `npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt`. (I deliberately did not touch this concurrent work — it appears to be actively edited and would collide.)

### 2. DB migrations are live ahead of the web app deploy — a temporary, low-impact mismatch
The new billing model lives in the DB now (`user_billing` is the source of truth; `create_workspace()` gates the "add another workspace" action on `user_billing.plan='pro'`). But the **deployed** web app still runs the **old webhook**, which writes `workspaces.plan` and does **not** populate `user_billing`.

- Existing paying customers: **fine** — migration `20260606000000` backfilled `user_billing` from existing workspace rows.
- Signup / first workspace: **fine** — created by the `handle_new_user()` trigger (direct INSERT), not the gated RPC. Verified.
- The only gap: a brand-new Team subscriber who subscribes *during this window* (old webhook) gets `workspaces.plan='pro'` but no `user_billing` row, so the "add another workspace" button would deny them until the new app ships. Narrow and self-healing once deployed.

→ **Action:** deploy the web app to close the window. Nothing is broken for existing users in the meantime.

---

## Remaining manual / follow-up items

1. **Finish the concurrent refactor + deploy edge function** (item ⚠️1 above) — required to make the injection fix live.
2. **Commit + deploy the web app.** All the web fixes (warning UX, legal copy, billing, open-redirect, OG card) are uncommitted. **Review `git diff` first** — the tree also contains concurrent work: `AuthorizeApp.jsx` (+220), `authorize/page.js`, `auth.json` ×5, `theme.css`, and the new `search-translate.ts`. Decide what ships together; don't blind-`checkout` those files (you'd lose in-progress work).
3. **Wire the checkout 409.** The new checkout returns `409 {error_code:'subscription_exists', portal:true}` when a user already has an active sub — the frontend should redirect to the billing portal instead of showing raw error text.
4. **Verify `customer.subscription.created` is enabled** on the live Stripe webhook endpoint (newly handled).
5. **Microsoft publisher verification** — still pending (the warning UX covers it for now).
6. **Untrack** `supabase/.temp/` and commit the new migration files.

## Not yet addressed (from report #1 — your call whether pre- or post-launch)
- Account deletion doesn't revoke provider OAuth grants (Terms says it does) — **L-H1**
- "30-day deletion of all personal data" promise vs soft-delete reality — **L-H2**
- Refund-terms contradiction (Pricing FAQ vs Terms §5.4) — **L-H3**
- GDPR legal-entity identity (real entity + address + org no.) — **L-H5**
- Inbox credential columns SELECTable by all workspace members — **M-M1**
- `/api/mcp` proxy: no rate limit + `?key=` logged — **S-M3**
- `favicon.ico` missing

---

## Verification evidence
- `cd apps/web && npx tsc --noEmit` → **exit 0** (clean).
- All 20 touched message catalogs (`privacy/terms/auth/dashboardChrome` × 5 locales) → **valid JSON**.
- `npx supabase migration list --linked` → all 5 new migrations present Local + Remote.
- `SELECT public.dispatch_scheduled_sends();` → no skip warning; `net._http_response` shows `/dispatch` → **HTTP 200** `{"dispatched":0,...}`; last 3 cron runs `succeeded`.
- `vercel env ls production` → `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_{SOLO,PRO}_{MONTHLY,YEARLY}` all present.
