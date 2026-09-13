# Plan: 150 email actions per month on Free, first 7 days uncounted

Status: SHIPPED 2026-09-13. Migrations 20260912200000/210000/220000 applied to prod and repaired into the history, edge function deployed (twice: the 80% check became a deduped band after prod verification), web pushed as 4bb3dc7 (Vercel auto-deploy). Written 2026-09-12.
Decision record: `docs/DECISION-free-tier-usage-cap-20260912.md`. Supersedes
`docs/PROMPT-free-tier-action-cap.md` (500 + 50/day) on every number.

## 0. What ships, in one paragraph

Every workspace created after launch gets a Free allowance of **150 billable email
actions per UTC calendar month**. Actions in the workspace's **first 7 days are not
counted**, and enforcement cannot start before day 8. There is **no daily cap** and
**no A/B test**. Every workspace that exists at launch is **exempt for good**, and its
dashboard says so. Paid tiers are unchanged. The allowance is stated on the pricing
page, the dashboard, the docs and the README, and the number a customer reads is by
construction the number that blocks them. Reaching 80% sends an email, reaching 100%
sends another, unattended automations pause visibly instead of dying silently, and
an admin tab shows the whole thing.

## 1. Decisions and assumptions (confirm or correct before Phase 1)

| # | Decision | Assumption made here |
|---|---|---|
| D1 | Allowance 150 / calendar month, Free only | `inbox_list` stays free; the customer-facing word is "email actions" |
| D2 | First 7 days uncounted | Measured from `workspaces.created_at`; the counting window is `max(month start, created_at + 7d)` to month end |
| D3 | Existing users exempt forever | "Existing" = every `workspaces` row present when the migration runs, per workspace, including grandfathered multi-inbox ones. They keep today's behaviour exactly: the silent 5,000 abuse ceiling stays, nobody has ever hit it |
| D4 | Paid tiers unchanged | Their silent ceilings (25k/100k/500k) stay silent; copy says "no monthly action cap (fair use)", never a number |
| D5 | Automations | Gated by the same allowance. On refusal the rule is paused with a visible reason and resumes automatically on the 1st |
| D6 | Emails at 80% and 100% | Transactional, via the existing Resend lifecycle queue, one of each per workspace per month |
| D7 | Enforcement on from the first deploy | Safe because the first workspace that can be capped is 7 days plus 150 actions away; that runway is used to land the email and admin phases |
| D8 | Reviewer / monitor accounts | `directory-review@` and `hello@` predate launch, so D3 covers them; any NEW grader account needs a `comped_scale` entitlement |

## 2. One source of truth for the allowance

Today the window is defined three times (edge `resolveUsageBillingWindow`, web
`billing-window.ts`, `/api/usage`) and the header of `billing-window.ts` records the
bug that produced. The grace window and the exemption would make it four. So:

**New SQL function `public.workspace_action_allowance(p_workspace_id uuid)`**
returning one row: `plan, exempt boolean, cap integer (null = none), period_start,
period_end, grace_ends_at, in_grace boolean, used integer, remaining integer`.
Logic, in order: plan and `created_at` from `workspaces`; `free_action_cap_exempt`;
`comped_scale` entitlement and live `workspace_usage_exemptions` row (both → exempt);
paid plan → Stripe period from `user_billing` with the calendar-month fallback and the
plan's silent cap; free → calendar month, `period_start = greatest(month_start,
created_at + 7 days)`, `in_grace = now() < created_at + 7 days`, cap 150; `used` =
billable `action_usage` rows in `[period_start, period_end)` at meter version 1.
SECURITY DEFINER, service_role only. The edge function, `/api/usage`, the dashboard
page and the admin RPCs all call it. `reserve_action_usage` is unchanged and receives
the function's `cap`, `period_start`, `period_end`.

The two constants (150, 7 days) live in the SQL function and are mirrored as
`FREE_ACTION_ALLOWANCE` / `FREE_ACTION_GRACE_DAYS` in `plans.ts` for copy only, with
a test that the pricing copy and `plans.ts` agree.

## 3. Phases

Each phase is a complete, deployable unit. Order inside a phase: migration → edge
function → env → web (the Personal launch incident, `project_personal_tier_rollout`).

### Phase 1: Schema (one migration)

- `ALTER TABLE workspaces ADD COLUMN free_action_cap_exempt boolean NOT NULL DEFAULT false;`
  then `UPDATE workspaces SET free_action_cap_exempt = true;` in the same migration,
  column comment stating the date and the reason. Same shape as the 05-31
  `grandfathered` column. Add it to `create_workspace()` explicitly as `false` so a
  second workspace made by an existing user is a new workspace.
- `workspace_action_allowance()` as in section 2.
- `record_usage_limit_event()` gains a boolean OUT `first_in_period` (it already knows,
  it writes the funnel row at most once per period).
- `triage_rules`: add `paused_reason text` and `paused_until timestamptz`. Extend
  `triage_rules_due_idx` and the comment. Do not reuse `disabled_reason`, which means
  "5 consecutive failures" and is terminal.
- `billing_email_sends`: extend the GENERATED `category` expression so templates
  `usage_warning_80`, `usage_limit_reached`, `automation_paused_limit` derive
  `transactional`. Add a unique index on `(workspace_id, template, period_start)` (new
  nullable `period_start` column) so the edge function can insert-or-ignore.
- `system_events` column comment: no new events there. Customer mail goes through the
  Resend queue, not `system-notify` (that function mails the operator via our own MCP).
- Apply with `db query -f` + `migration repair` (`feedback_supabase_migration_history_out_of_sync`),
  after checking `git status` and `database.types.ts` for a peer session's migration.
- Tests: SQL-level check of the allowance function against fixture workspaces (grace,
  counting, exempt, paid, comped), run from a node test using the linked DB is not
  available in CI, so keep a `scripts/verify-action-allowance.sql` and run it by hand
  before the edge deploy.

### Phase 2: Edge function enforcement (`supabase/functions/mcp-server`)

- `actionLimitResponse()` (index.ts ~2587): replace the workspace/entitlement/exemption/
  window lookups with one `workspace_action_allowance` call. `exempt` or `in_grace` or
  `cap is null` → allow, no reservation. Otherwise reserve with the returned cap and
  window. Keep the kill switch and the fail-open on RPC error.
- `SHADOW_ACTION_CAPS.free` goes away (the function owns it); the paid entries stay
  and the parity comment with `plans.ts` stays.
- Refusal copy, `usage-limit-message.ts` `buildUsageLimitText`: the text currently says
  "not a billing tier" and points to support. New text, still declarative, still
  numbers-first: used of 150 email actions this month on the Free plan, resets on
  `YYYY-MM-DD`, retrying will not help, the first 7 days were not counted, Personal
  removes the monthly cap for $5/month at `${appOrigin}/pricing?from=usage_cap`,
  current count at `/dashboard/usage`. `_meta["com.mcpemails/usage_limit"]` gains
  `allowance`, `grace_ends_at`, `upgrade_url`. Update `usage-limit-message.test.ts`,
  keep the assertion that the text never addresses the model.
- 80% signal: after a successful reservation, if `used_actions === ceil(0.8 * cap)`
  (the crossing call), insert-or-ignore a `billing_email_sends` row
  (`usage_warning_80`, period_start). 100% signal: when `record_usage_limit_event`
  returns `first_in_period`, insert-or-ignore `usage_limit_reached`. Both are one
  insert on an indexed unique key; both are best-effort and logged on failure.
- Automation path (index.ts ~27271 `triageDeps().meter`, called from
  `triage-engine.ts:1169`): before a rule runs, `claimRule` (~26677) checks the
  allowance for the workspace; if `remaining <= 0` and not exempt/in grace, set
  `paused_reason = 'plan_limit'`, `paused_until = period_end`, skip the run, and
  insert-or-ignore `automation_paused_limit`. `listDueRules` (~26663) and `claimRule`
  both add `AND (paused_until IS NULL OR paused_until <= now())`. Actions a rule does
  take go through `reserve_action_usage` too, so a rule cannot run past the cap
  mid-batch: `meter()` gets a reservation id like the interactive path.
- `logShadowLimitDiagnostic` and `USAGE_SHADOW_WOULD_BLOCK`: delete, the shadow phase
  is over.
- Deploy: `npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt`.
  Verify with a temp key on a freshly created workspace over HTTP
  (`feedback_testing_new_mcp_args_in_prod`): in grace → allowed; then `UPDATE
  workspaces SET created_at = now() - interval '8 days'` on that test workspace and
  insert 150 synthetic billable rows → refused with the new text; delete the test rows.
- Tests: `deno test` for the message; a new `action-allowance.test.ts` for the
  crossing arithmetic (80% at 120, first-in-period) as pure functions.

### Phase 3: Web, dashboard and API (`apps/web`)

- `plans.ts`: `PLANS.free.limits.maxMonthlyToolCalls = 150`; add
  `FREE_ACTION_GRACE_DAYS = 7`; rewrite the "must never appear in customer-facing copy"
  comment to "Free's allowance is public; paid ceilings are not". `PLANS.free.features`
  gains "150 email actions a month, first 7 days uncounted"; `PLANS.personal.features`
  gains "No monthly action cap" as a real delta (it now is one). `plans.test.ts`
  assertions updated; add the copy-parity test.
- `/api/usage/route.ts`: call `workspace_action_allowance`; return
  `{ plan, exempt, in_grace, grace_ends_at, monthly: { used, cap, resets_at, period_start } }`.
  Drop `daily_burst` (never enforced, never shown). `billing-window.ts` is reduced to
  a thin wrapper or deleted; its header comment explains why.
- Dashboard page `app/dashboard/[[...section]]/page.js` (~726-762): fetch the allowance
  server-side and pass it in `planLimits`; remove the "deliberately NOT passed" comment.
- `Pages.jsx` `OverviewPage` (~766): the "Calls this month" tile becomes the allowance
  tile with three states: **grace** ("Trial week: email actions are not counted until
  `date`"), **counting** ("`used` of 150 email actions, resets `date`", bar mirrors the
  inbox bar at ~1313, turns amber at 80%), **exempt** ("Early member: email actions are
  not counted on this workspace"). Paid plans keep the plain count. `UsagePage`
  (~3481): the same bar above the tiles, plus the 80%+ banner with the upgrade CTA
  carrying the offer (`ea7c1ae` pattern) to `/dashboard/settings?upgrade=personal`.
  New `src/lib/billing/usage-cap-offer.mjs` beside `inbox-cap-offer.mjs`.
- `BillingSection` cards (`Pages.jsx` ~4385): Free bullet and Personal delta as above.
- Copy keys in `messages/{en,es,fr,nb,zh}/dashboard.json` (`usage.*`, `billing.plans.*`,
  `overview.*`). Per-page copy stays out of the shared namespaces where it can
  (`feedback_nextintl_namespace_ships_to_client`); no `<` in ICU strings
  (`feedback_nextintl_icu_escape_dev_only`).
- Tests: `node --test` for `/api/usage` shape and the three tile states (mount pattern
  in `feedback_ux_testing_authed_components`); mobile check of the banner
  (`feedback_mobile_check_authed_pages`).

### Phase 4: Pricing, docs, README

- `PricingClient.jsx` usage section (~75-86): new row `actions` with values
  `actions150` ("150 / month, first 7 days uncounted") for Free and `actionsUnlimited`
  ("No monthly cap, fair use") for the three paid tiers. FAQ: rewrite "What counts as
  an MCP call?" (it says plans are not priced by calls, which is now false), rewrite
  "What do I get on the free plan?", add "What happens when I reach 150?" (reads and
  writes are refused until the 1st, automations pause and resume, the dashboard keeps
  working, $5 removes the cap). Same keys in all five `pricing.json` files (they are
  line-aligned, keep them so).
- `DocsClient.jsx` "Rate limits & fair use" (~1454) and `docs.json` `rateLimits.*`,
  `errors.rows.cap`: describe the allowance, the grace week, the refusal text an agent
  will see, and that `inbox_list` is free.
- `README.md` table (~169-181): add "Email actions / month" row; rewrite the paragraph
  at ~185 ("never shown to customers") and the grandfather paragraph at ~187 to say
  workspaces from before 2026-09-xx are exempt.
- Directory listings: the READMEs and descriptions cached at Glama, Smithery, PulseMCP,
  freemcp.space (API re-cache, `project_freemcp_space_listing_20260910`) and the
  Claude Directory submission text say nothing numeric about actions today; re-read
  each for "unlimited" before launch and fix by hand where found.
- Tests: `npm run test:plans`, the pricing snapshot tests if any, `npx tsc --noEmit`,
  and the pre-push build of the staged tree (`feedback_prepush_build_of_staged_tree`).

### Phase 5: Emails (`apps/web/src/lib/email/billing-lifecycle.ts` + dispatcher)

- Three transactional templates: `usage_warning_80` ("120 of 150 email actions used,
  resets `date`, here is what stops at 150 and what does not"), `usage_limit_reached`
  ("150 of 150, refused until `date`, automations paused, $5 removes the cap"),
  `automation_paused_limit` ("rule `name` paused until `date`"). From hello@, same as
  the purchase confirmation. Numbers first, no imperatives, upgrade link with the
  offer parameter, plain-text part included.
- Dispatcher `app/api/internal/billing-lifecycle/dispatch/route.ts`: the new templates
  need `workspace_id` → owner email resolution (today rows are keyed by user); render;
  Resend Idempotency-Key from `(workspace, template, period_start)`. Transactional, so
  no List-Unsubscribe and not suppressible, which is right for "your service is about
  to stop". The 80% mail is a service notice whose primary purpose is account status;
  the upgrade link is secondary, which keeps it out of the marketing category.
- Tests: template render tests beside the existing nine; dispatcher test for the
  workspace-keyed path.

### Phase 6: Admin overview (`/admin/growth`)

- New band "Usage cap" in `app/admin/growth/page.tsx` `BANDS` and a section in
  `components/admin/growth/sections.tsx`, data from a new RPC
  `growth_usage_cap_overview(p_window)` in a migration beside
  `growth_utilization_bands`: counts of new-rule workspaces by state (grace, <50%,
  50-80%, 80%+, capped this period), exempt count, emails queued/sent by template,
  capped → `pricing_viewed` → `checkout_started` → `checkout_completed`, 7-day
  retention capped vs uncapped in the same signup cohort, automation pauses.
- Sub-page `app/admin/growth/usage-cap/page.tsx` on the experiments pattern
  (server-rendered forms, `force-dynamic`): the list of workspaces at 80%+ and capped
  (domain, used, cap, last seen, emails sent, paused rules) and a "grant exemption
  until" form posting to the existing `/api/admin/usage-exemptions`.
- Remove the comment at `page.tsx:74-77` recording that cap measures were removed.
- Kiosk: no change; `/admin/growth` is the kiosk and the new band is a normal band.

### Phase 7: Launch and verification

1. Phase 1 migration applied and repaired; `verify-action-allowance.sql` run.
2. Phase 2 edge deploy; HTTP verification on a fresh workspace as above.
3. Phases 3 and 4 in one web deploy (push to main is a prod deploy,
   `feedback_vercel_git_autodeploy_and_pane_keys`), after the staged-tree build.
4. Confirm on prod: a new signup's overview tile shows the grace state with the right
   date; an existing workspace shows the exempt state; `/pricing` shows the row in all
   five locales; `/api/usage` matches the tile.
5. Phases 5 and 6 within the grace runway (target: before the first post-launch
   workspace reaches day 8).
6. Watch for 14 days: `usage_limit_events` per day, `billing_email_sends` by template,
   the funnel from `paywall_reached` (usage) to checkout, error rate excluding
   4bff20c8 and 6546f334 (`project_user_review_20260910`), and any support mail
   mentioning "limit".
7. Rollback is `USAGE_ENFORCEMENT_DISABLED=true` on the edge function (no redeploy),
   then copy.

## 4. Order of work and size

| Phase | Depends on | Size |
|---|---|---|
| 1 Schema | | half a day |
| 2 Edge enforcement + automation pause | 1 | one day |
| 3 Dashboard + API | 1 | one day |
| 4 Pricing, docs, README, listings | 3 (copy constants) | half a day, plus listing checks by hand |
| 5 Emails | 1, 2 | half a day |
| 6 Admin tab | 1 | half a day |
| 7 Launch | 1-4 (5, 6 follow inside the runway) | half a day |

Phases 1 → 2 → 3 → 4 → 7 are the launch path. Phases 5 and 6 can be built in parallel
with 3 and 4 by a second session if the schema from Phase 1 is committed first (peer
sessions collide on migrations, `feedback_shared_tree_migration_collision`).

## 5. Out of scope, on purpose

- No coupon or outreach to existing heavy users: they are exempt, nothing changes for
  them. Revisit if the exemption is ever narrowed.
- No daily cap, no A/B, no change to paid ceilings, no gating of scheduled sends or the
  approval hold (`project_personal_vs_free_real_deltas`).
- No change to the inbox paywall or `ConnectModal`.
- `inbox_list` stays non-billable and the meter version stays 1.

## Phase 1 result

Written 2026-09-12. Migration file: `supabase/migrations/20260912200000_free_action_cap_150.sql`.
Hand-run checks: `scripts/verify-action-allowance.sql`. NOT applied to production yet
(apply with `db query -f` + `migration repair`, see Phase 7). The whole file was
dry-run twice inside one rolled-back transaction on the local stack (PG 17, with
20260902130000 applied first, since local was at 20260829120000): every branch of
the allowance function, the boolean return, the email insert-or-ignore, the keyed
CHECK and a second apply all behaved as specified.

### What the migration does

1. `workspaces.free_action_cap_exempt boolean NOT NULL DEFAULT false`, backfilled
   `true` for every row present at apply time, soft-deleted included. The backfill is
   inside a DO block that only runs when the column is created by that apply, so a
   re-run cannot exempt post-launch workspaces. `create_workspace(p_name)` needs no
   change: it inserts with an explicit column list, so a second workspace made by an
   early member gets the default `false`.
2. `public.workspace_action_allowance(p_workspace_id uuid)` RETURNS TABLE
   `(plan text, owner_id uuid, exempt boolean, exempt_reason text, cap integer,
   period_start timestamptz, period_end timestamptz, grace_ends_at timestamptz,
   in_grace boolean, used integer, remaining integer)`, plpgsql STABLE SECURITY
   DEFINER, service_role only. No row for an unknown id. `exempt_reason` is
   `'early_member' | 'comped' | 'exemption' | NULL`, in that precedence. Exempt rows
   carry `cap NULL, remaining NULL, grace_ends_at NULL, in_grace false` and the
   current UTC month with its `used` count for display. Paid: Stripe period when
   live, else the UTC month; cap 25000/100000/500000 for personal/solo/pro, 5000
   otherwise. Free: cap 150, `grace_ends_at = created_at + 7 days`,
   `period_start = least(greatest(month_start, grace_ends_at), period_end)`; when
   grace runs past month end `period_start = period_end` and `used = 0`. `used` is a
   row count over billable `action_usage` at meter_version 1, matching
   `reserve_action_usage`. Constants `c_free_cap = 150` and `c_grace = 7 days` sit at
   the top of the body; `plans.ts` mirrors them as `FREE_ACTION_ALLOWANCE` /
   `FREE_ACTION_GRACE_DAYS` (Phase 3/4 adds those).
3. `public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz)`
   now RETURNS `boolean` (was `TABLE(funnel_row_written boolean)`), true only on the
   call that wrote the once-per-period `paywall_reached` row. Same parameters, same
   body, same REVOKE/GRANT. Phase 2 note: over PostgREST the `.rpc()` result is now a
   bare `true`/`false` in `data`, not `[{ funnel_row_written }]`. The edge function
   currently ignores the result, so nothing is broken by the change itself.
4. `triage_rules.paused_reason text NULL` and `paused_until timestamptz NULL`, with
   comments (`'plan_limit'` is the only reason). `triage_rules_due_idx` is NOT
   changed: `now()` is not IMMUTABLE and a `paused_until IS NULL` predicate would
   drop a paused rule from the index for good. Phase 2 must add
   `paused_until IS NULL OR paused_until <= now()` to both `listDueRules()` and
   `claimRule()` in the edge function's `triageStore` (index.ts around line 26660),
   and the pause write is `UPDATE triage_rules SET paused_reason = 'plan_limit',
   paused_until = <allowance.period_end>`. The resume needs no write.
5. `billing_email_sends`: `workspace_id uuid NULL REFERENCES workspaces ON DELETE
   CASCADE`, `period_start timestamptz NULL`, `stripe_customer_id` made NULLABLE, new
   CHECK `billing_email_sends_keyed (stripe_customer_id IS NOT NULL OR workspace_id
   IS NOT NULL)`, the `template` CHECK extended with `usage_warning_80`,
   `usage_limit_reached`, `automation_paused_limit`, the GENERATED `category` column
   dropped and re-added (nothing depended on it) so those three derive
   `transactional`, and
   `CREATE UNIQUE INDEX billing_email_sends_workspace_template_period_idx ON
   billing_email_sends (workspace_id, template, period_start) WHERE workspace_id IS
   NOT NULL`. The existing `payload jsonb NOT NULL DEFAULT '{}'` column is the place
   for the template's numbers; no new jsonb column was added.
6. Grants: `workspace_action_allowance` EXECUTE to service_role only.

### Email queue insert shape (Phase 2 edge function, Phase 5 dispatcher)

The edge function queues a usage email with one INSERT, insert-or-ignore on the new
index. `recipient` is NOT NULL and must be resolved at queue time from
`users.email` for the workspace owner (`workspace_action_allowance().owner_id`),
exactly as the Stripe-keyed rows freeze the address they were queued to.

```sql
INSERT INTO public.billing_email_sends
  (workspace_id, user_id, recipient, template, scope_key, send_after, period_start, payload)
VALUES
  ($1,                          -- workspace_id  uuid, the metered workspace
   $2,                          -- user_id       uuid, workspaces.owner_id
   $3,                          -- recipient     text, users.email of the owner, NOT NULL
   'usage_warning_80',          -- template      one of the three usage names
   $4,                          -- scope_key     text NOT NULL: period_start as ISO 8601
                                --               for the two usage_* templates, the
                                --               triage rule id for automation_paused_limit
   now(),                       -- send_after    due immediately (next 5-minute tick)
   $5,                          -- period_start  timestamptz, allowance.period_start
   $6)                          -- payload       jsonb, see below
ON CONFLICT (workspace_id, template, period_start) WHERE workspace_id IS NOT NULL
DO NOTHING;
```

Do NOT use the Supabase JS `upsert(..., { onConflict: 'workspace_id,template,period_start' })`
form for these rows. PostgREST emits `ON CONFLICT (workspace_id, template,
period_start)` without the index's `WHERE workspace_id IS NOT NULL`, and Postgres
then cannot infer the partial index: verified locally, it fails with `42P10 there is
no unique or exclusion constraint matching the ON CONFLICT specification`. The edge
function must use a plain `.from('billing_email_sends').insert(row)` and treat error
code `23505` (duplicate key on
`billing_email_sends_workspace_template_period_idx`) as "already queued this
period", not as a failure. Leave `stripe_customer_id` NULL (the keyed CHECK accepts
a row with only `workspace_id`). `category` is generated. Every other column has a
default. Suggested `payload` keys, read by the Phase 5 composer:
`{ "used": 120, "cap": 150, "period_end": "<ISO>", "plan": "free",
"rule_name": "<only for automation_paused_limit>", "rule_id": "<same>" }`. The
dispatcher (Phase 5) must accept `stripe_customer_id NULL` rows (its `QueueRow`
type says `string`), resolve nothing further, and build the Resend Idempotency-Key
from `(workspace_id, template, period_start)`.

### Not done, on purpose

- `database.types.ts` not regenerated (other agents own that after the apply).
- No local `migration up`; the local stack stays at 20260829120000.
- `triage_rules_due_idx` unchanged, reasons above.
- No `system_events` change (the plan says none).

## Build result (2026-09-13)

Phases 1 to 6 are implemented in the working tree by six sub-agents plus a final pass;
nothing has been applied to prod, deployed, committed or pushed.

- Migrations (apply in this order, then `migration repair`): `20260912200000_free_action_cap_150.sql`
  (schema + `workspace_action_allowance()` + `record_usage_limit_event()` boolean +
  `triage_rules.paused_*` + `billing_email_sends` workspace keying),
  `20260912210000_growth_usage_cap_rpc.sql` (admin RPCs), `20260912220000_utilization_bands_respect_free_allowance.sql`
  (the older utilization band no longer divides exempt or trial-week workspaces by 150).
  All three dry-run clean on the local stack inside a rolled-back transaction.
- Edge function: `deno check` clean, 930 tests. Enforcement reads the allowance function; before
  the migration exists in prod it fails open (no enforcement, no crash), so the deploy order
  migration then edge function is mandatory.
- Web: `tsc` clean, full `npm test` chain 29 suites green (new `test:allowance`, `test:growth`
  extended). Production build of the exported tree: see the session report.
- Deviations from the plan text: D3 is implemented as "exempt = not metered at all" (no silent
  5,000 ceiling for early members; the 60 rpm limit remains their abuse brake). Paid plans get no
  80%/100% email (a silent ceiling must stay silent). The paused-automation email is one per
  workspace per month, not per rule, and its copy says so. The dashboard banner CTA goes straight
  to `/api/stripe/checkout/start?plan=personal&interval=month&offer=usage_cap`; the emails go to
  `/dashboard/settings?upgrade=personal&interval=month&offer=usage_cap` (reader may be signed out).
- Copy outside the phases fixed in the final pass: `apps/web/public/llms.txt` (two generations
  stale), homepage `pricing.title` + `sub` in five locales, `/best-email-mcp-servers` free-tier
  lines, `docs/claude-directory-submission.md` note. Remaining by-hand items are in
  `docs/CHECKLIST-listing-copy-action-cap.md`.

## Phase 7 result (2026-09-13)

1. Migrations applied in order with `db query --linked -f` and `migration repair --status applied`;
   prod afterwards: 513 workspaces `free_action_cap_exempt = true`, 0 false, all four new functions
   present, `record_usage_limit_event` returns boolean, both `triage_rules` and both
   `billing_email_sends` columns present.
2. Edge function deployed. HTTP verification on a synthetic workspace owned by hello@ (no comp),
   created 8 days back, temp key scoped read/search/contacts, tool `contact_search`:
   allowance row cap 150 / used 0; call allowed; 150 synthetic rows + 2 real -> refusal text
   "Monthly allowance reached: 152 of 150 ..." with `_meta` fields; retry still refused with ONE
   `paywall_reached` funnel row and one `usage_limit_reached` queue row; `created_at = now()` ->
   in_grace true and the call allowed again. The 80% email did NOT queue on the first pass because
   `isWarningCrossing` was a strict equality on the 120th reservation and synthetic rows stepped
   over it; changed to `used >= 120 && used < 150` with the queue's unique index as the dedupe,
   redeployed, retested: one `usage_warning_80` row after two in-band calls. Workspace, key and
   every dependent row deleted; the key returns 401.
3. Web: isolated production build of the exported tree exit 0, commit 4bb3dc7 pushed to main.
   Left uncommitted on purpose: two video-studio files and six unrelated PROMPT docs.
4. Still by hand: `docs/CHECKLIST-listing-copy-action-cap.md` (directory listings), and the Stripe
   side needs nothing (no coupon in this design).

## Dummy-account test (2026-09-13, after launch)

Account `bjellanda+captest@gmail.com` (user e1f165c8, workspace b89d4d6b, slug
`bjellanda-captest`, listed in `internal_accounts`), created through the auth admin API and
signed in through the product's own magic-link flow (the sign-in email was read from the
owner's Gmail via the MCP connector, since an admin-generated link lands with an implicit
token hash that neither the homepage nor the login page consumes).

Verified end to end in the Browser pane and over HTTP:
- new workspace is metered (`free_action_cap_exempt = false`), overview tile "Trial week: no
  cap until 20 Sept 2026", `/api/usage` `in_grace: true`;
- API key created in the dashboard, `contact_search` allowed during grace;
- `created_at` moved 8 days back: tile "0 of 150", then 121 of 150 amber with the Usage page
  bar and the 80% banner, `usage_warning_80` queued;
- 150 of 150: tool refusal text, tile "Cap reached, refused until 1 Oct 2026", Usage page
  "This month's allowance is used up", `usage_limit_reached` queued, one `usage_limit_events`
  row;
- both emails SENT by the 12:10 UTC dispatcher run (Resend ids stored) and received in Gmail
  from hello@ with subjects "121 of 150 email actions used this month" and "150 of 150 email
  actions used, paused until 2026-10-01";
- "Upgrade to Personal, $5/mo" opened a live Stripe checkout for Personal monthly (not paid).
- API key revoked from the dashboard afterwards.

Not covered: the automation pause (needs a connected inbox and a rule; unit-tested only).

The account is left capped on purpose (150 synthetic `action_usage` rows, tool `email_read`,
occurred 2026-09-13). To reset it: `delete from action_usage where workspace_id =
'b89d4d6b-6c89-4bad-9290-d7b0c931bec5'` and `update workspaces set created_at = now()` (or
leave `created_at` so it stays metered), and delete its `billing_email_sends` rows if the
emails should fire again next period.
