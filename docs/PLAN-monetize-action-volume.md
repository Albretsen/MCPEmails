# Plan: monetize action volume

Status: PROPOSAL. Nothing here is implemented.
Author: research pass, 2026-09-07.
All production figures re-verified against prod on 2026-09-07 via `npx supabase db query --linked`.

---

## 0. Executive summary

The premise is right and the sizing is wrong.

Right: the inbox paywall structurally cannot bill a single-inbox heavy user, and there are real single-inbox heavy users. Confirmed.

Wrong: the addressable pool is not "231 single-inbox free workspaces, 23 of them heavy". At any defensible monthly action allowance the pool of workspaces that would actually be pushed to a decision is **13 to 20 today**, not 231. Of the 231 single-inbox free workspaces, 77 have done zero billable actions in 30 days and another 106 have done fewer than 50.

But the stock is the wrong number to plan against. The right number is the **flow**. In the last fully matured signup cohort (week of 2026-08-17, n=61, all past 14 days of age), 16% crossed 250 billable actions inside their first 14 days and 10% crossed 500. At the current 118 signups/week that is roughly **12 to 19 workspaces per week arriving at a volume-shaped decision point that today has no decision attached to it**. That is the case, and it compounds.

Two further findings materially change the design:

1. **Four of the six constraints in the brief are already solved or are stated inaccurately.** The 5% hash cohort gate and the existing-workspace exclusion were both deleted (`supabase/functions/mcp-server/index.ts:2417-2430`); enforcement is already ON for every workspace behind a kill switch. Replay double-counting is already handled by a reserve/finalize protocol (`reserve_action_usage` / `finalize_action_usage_reservation`). The action cap *does* have a hot-path re-check; it is the inbox cap that does not. See section 4.

2. **The single most dangerous thing about this project is not the cap. It is `apps/web/src/lib/stripe/checkout-core.ts:400`.** That guard still 409s `personal` for any user with `unlimited_inboxes = true`. Adding an action wall to Free while that guard stands recreates, exactly, the failure documented in `project_grandfather_blocked_willing_buyers.md`: a user hits a wall and the cheapest exit is refused. Six of the 36 heaviest free workspaces hold that flag.

Recommendation in one line: **do not sell actions. Add an action allowance to Free only, route it to the paywall ladder that already exists, and keep paid tiers effectively unlimited.** This is what the closest competitor does, and it adds no second pricing axis.

---

## 1. The case, in numbers

### 1.1 Where your figures were right, wrong, and incomplete

| Your figure | Verified | Verdict |
|---|---|---|
| 423 workspaces total | 423 rows; **404 not soft-deleted**, 403 distinct owners | Right, with a caveat |
| 118 signups last 7d vs 86 prior | 118 / 86 | **Exactly right** |
| 10 paying customers | 11 active subscriptions, one of which is `bjellanda@gmail.com` on Team since 2026-06-03 | **Right** (10 external) |
| ~$75/mo MRR | $75.00/mo external, monthly-normalized (see 1.2) | **Exactly right** |
| Only 1 churn ever | 1 canceled row, and it is `bjellanda+test@gmail.com` | **External churn is zero**, not one |
| 231 free workspaces with exactly 1 inbox | 231 | **Exactly right** |
| 22 free workspaces with 2+ inboxes | 22 | **Exactly right** |
| 140 free active in last 7d | 139 by any call, **127 by billable call** | Right on the loose definition |
| 23 single-inbox free with 100+ actions in 7d | 23 by any call, **22 by billable** | Right on the loose definition |
| 25,923 free billable actions in 7d | 25,915 by any call, **19,268 billable** | **Not billable.** See 1.3 |
| `usage_limit_events` has 0 rows, ever | 0 rows | Right, but the reason is not what you think. See 1.5 |
| `action_usage` ~85k rows | **127,485 rows** (97,317 billable). 85,444 is the billable total for the last 30 days | Understated |

Two things your framing omits entirely:

- **134 of the 387 free workspaces (35%) have zero live inboxes.** They are not "happy with one mailbox"; they never connected one. They are unreachable by an inbox paywall and an action paywall alike.
- **The heaviest free workspace in production is yours.** `hello` (owner `hello@mcpemails.com`) recorded 8,646 billable actions in 30 days, the single largest free-plan figure. Every number in this document excludes `@mcpemails.*`, `bjellanda*` and `@example.com` owners. Excluding them removes the entire 5,000+ bucket from the free distribution.

### 1.2 Revenue, reconciled

11 active rows in `user_billing`. Interval inferred from `current_period_end - current_period_start`.

| Internal plan | Sold as | Interval | Count | Monthly-normalized |
|---|---|---|---:|---:|
| `personal` | Personal $5 / $48yr | monthly | 5 | $25.00 |
| `personal` | Personal | yearly | 2 | $8.00 |
| `solo` | **Pro** $15 / $144yr | monthly | 2 | $30.00 |
| `solo` | **Pro** | yearly | 1 | $12.00 |
| `pro` | **Team** $79 | monthly | 1 | ($79.00, this is you) |
| | | | **10 external** | **$75.00/mo** |

Your $75/mo is exact once your own Team subscription is excluded. Note the shape: **7 of 10 paying customers bought Personal**, the $5 tier. The realistic ARPU for anything the new allowance converts is $5, not $15.

### 1.3 The `inbox_list` gap, and why it matters

`inbox_list` is the only non-billable tool in meter version 1 (`supabase/functions/mcp-server/index.ts:2274-2276`). It is 30,168 of 127,485 ledger rows, and **26% of all free-tier call volume in the last 7 days** (25,915 total calls, 19,268 billable).

This is not an accounting nit. Any allowance you publish will be spent against the billable count while the user's client is making a quarter again as many calls they cannot see. Whatever number goes on the pricing page has to be described as "email actions", and `inbox_list` has to stay free, or the meter and the user's mental model diverge on day one.

### 1.4 The distribution (this is the evidence for the threshold)

30-day billable actions per **external** free workspace, 2026-09-07. n = 379.

| Bucket | Workspaces | of which 0 inboxes | 1 inbox | 2+ inboxes | Actions in bucket |
|---|---:|---:|---:|---:|---:|
| 0 | 204 | 125 | 77 | 2 | 0 |
| 1-9 | 42 | 2 | 38 | 2 | 176 |
| 10-49 | 55 | 3 | 49 | 3 | 1,463 |
| 50-99 | 22 | 0 | 19 | 3 | 1,502 |
| 100-249 | 23 | 0 | 19 | 4 | 4,088 |
| 250-499 | 17 | 0 | 14 | 3 | 6,089 |
| 500-999 | 9 | 0 | 6 | 3 | 6,375 |
| 1,000-1,999 | 4 | 0 | 3 | 1 | 5,738 |
| 2,000-2,999 | 1 | 0 | 1 | 0 | 2,121 |
| 3,000+ | 2 | 0 | 2 | 0 | 7,725 |

Percentiles among the **175 active** external free workspaces: p50 = 39, p75 = 185, p90 = 481, p95 = 828, p99 = 3,496, max = 4,229.

Concentration among active free workspaces: top 1 = 12.0% of free volume, top 5 = 37.2%, top 10 = 51.6%, top 20 = 67.5%.

Your thesis holds on shape: **30 of the 36 heaviest free workspaces run exactly one inbox.** The inbox paywall genuinely cannot see them. But read the left column honestly. 204 of 379 are at zero.

### 1.5 Why `usage_limit_events` is empty

Not because the meter has never run. The meter runs on every billable call and has written 97,317 rows. It is empty because the Free ceiling is **5,000 actions per calendar month** (`index.ts:2320-2325`, mirroring `plans.ts:160`) and the highest any external free workspace has ever reached in 30 days is **4,229**. Nobody has crossed it. The infrastructure is not unproven, it is untriggered, which is a materially better starting position.

### 1.6 The flow, which is the actual case

Cohort analysis by signup week, external free workspaces, measuring cumulative billable actions in the **first 14 days** and counting only cohorts that have fully matured past 14 days:

| Cohort week | Signups | Matured | Active | >=150 in 14d | >=250 | >=500 | >=1,000 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-03 | 23 | 23 | 8 | 3 (13%) | 1 | 1 | 0 |
| 2026-08-10 | 44 | 44 | 29 | 8 (18%) | 4 | 1 | 0 |
| **2026-08-17** | **61** | **61** | **37** | **14 (23%)** | **10 (16%)** | **6 (10%)** | **2 (3.3%)** |
| 2026-08-24 | 72 | 6 | 2 | (immature) | | | |

The 2026-08-17 cohort is the largest fully-matured one and the best estimator. Applied to the current run rate of 118 signups/week:

- an allowance reachable at ~250 actions/14 days catches **~19 workspaces/week**
- at ~500/14 days, **~12 workspaces/week**
- at ~1,000/14 days, **~4 workspaces/week**

Median time from signup to crossing 1,000 cumulative billable actions, among the 12 workspaces that ever did: **15.5 days** (mean 24.6). So an allowance set near 1,000/month bites in about half a billing period for the people it is aimed at, which is fast enough to matter and slow enough not to feel like a bait and switch.

**This is the case.** Not 231 stranded workspaces, but a recurring weekly flow of roughly a dozen volume-shaped users who currently reach no decision point at all, against an installed base where 10 people have ever paid.

### 1.7 What free-tier volume is actually made of

Billable tool mix, external free workspaces, 30 days:

| Tool | Actions | Share |
|---|---:|---:|
| `email_search` | 8,949 | 25.4% |
| `triage_move` | 6,054 | 17.2% |
| `email_list` | 5,263 | 14.9% |
| `email_read` | 2,418 | 6.9% |
| `email_attachment` | 1,658 | 4.7% |
| `email_send` | 1,570 | 4.4% |

`triage_move` is the unattended automation path (`index.ts:2261-2265`). **Eight free workspaces generate all 6,054 of those actions**, an average of 757 each. Automations are a concentrated, unattended volume driver sitting exactly on top of the heavy segment. This is a design constraint, not a footnote: see 5.4.

---

## 2. The pricing design

### 2.1 The decision: an allowance, not a meter

**Do not sell actions.** Do not add overage. Do not add a tier.

The allowance is a **second reason to leave Free**, routed into the ladder that already exists. Free becomes "1 inbox **and** 1,000 email actions per month". Every paid tier stays what it is today: an inbox count, plus an action ceiling so far above real use that it is invisible and is never named in customer copy.

Rationale:

- **It creates no second axis.** A customer never has to reason about actions when choosing between Personal, Pro and Team, because actions do not vary between them in any way they will encounter. Actions only ever answer one question: "have you outgrown Free?"
- **It matches the competitor.** anymailmcp (verified 2026-09-07) gates its free tier at "15 calls/day · 45/week · 150/month" with 1 mailbox, and its paid tiers at EUR 4.99 (5 mailboxes) and EUR 29.99 are **unlimited calls**. They use call volume purely as a free-tier trigger. Your figure of 15/45/150 was correct.
- **It is the only version that does not require Stripe work.** No new price, no metered price, no usage records pushed to Stripe, no invoice reconciliation, no dunning surface for a variable amount. Given `project_billing_lifecycle_emails.md` only just shipped, adding a variable invoice amount now is a bad trade.
- **Overage on a $5 ARPU product is not worth building.** The realistic incremental revenue is single-digit dollars per account. The support and billing surface is not.

### 2.2 The number

Recommended Free allowance: **1,000 billable email actions per calendar month.**

Justification, each traceable to section 1.4 and 1.6:

- p95 of active free workspaces is 828. A 1,000 allowance leaves **~95% of active free workspaces untouched**, which is the correct property for something whose purpose is to identify the exception, not to tax the norm.
- It is **25x the median active free workspace** (p50 = 39). Nobody exploring the product will see it.
- 7 external free workspaces exceed it on a full 30-day actual; 13 exceed it on a 7-day run rate. The cohort model says ~4/week arrive above it. That is a real but absorbable support surface for a solo operator.
- It is **6.7x more generous than anymailmcp's 150/month**, so it remains a defensible "most generous free tier in the category" claim rather than a retreat.
- Median time-to-cross is 15.5 days, comfortably inside one billing period, so the first month a user crosses it is also the month they can act on it.

Alternatives I considered and rejected, with the evidence:

| Allowance | Free workspaces above (30d actual / 7d run-rate) | Cohort capture rate | Why not |
|---|---|---|---|
| 250/mo | 33 / ~30 | ~16%/14d | Catches the p75-p90 band. These are people evaluating the product, not people extracting value from it. Highest churn risk, worst word of mouth. |
| 500/mo | 16 / 20 | ~10%/14d | Defensible, and the right fallback if 1,000 under-converts. Sits at p90. |
| **1,000/mo** | **7 / 13** | **~3.3%/14d** | **Recommended.** Sits just above p95. |
| 2,500/mo | 2 / ~9 | ~0% | Too high to move anyone this quarter. Only 2 external workspaces have ever exceeded it. |

The choice between 1,000 and 500 is the one genuine open question on the number, and it should be settled by Stage 2 data, not now. See section 7.

### 2.3 What the paid tiers get

No change to any price. No change to any inbox limit.

| Internal id | Sold as | Price | Inboxes | Action allowance (new customer-facing) | Silent ceiling (`maxMonthlyToolCalls`, unchanged) |
|---|---|---|---|---|---|
| `free` | Free | $0 | 1 | **1,000/month** | (the allowance is the ceiling) |
| `personal` | Personal | $5 / $48yr | 3 | Unlimited | 25,000 |
| `solo` | **Pro** | $15 / $144yr | Unlimited | Unlimited | 100,000 |
| `pro` | **Team** | $79 / $756yr | Unlimited | Unlimited | Unlimited members, 500,000 |

"Unlimited" on paid is honest at these ceilings. Personal's 25,000 is **5.9x** the busiest month any external workspace has ever recorded (4,229) and **25x** the new Free allowance. The single heaviest account in production, `tor.jetix16@gmail.com` at 31,898 actions in 30 days, would exceed Personal's ceiling, but that account is `comped_scale` and exempt before the ceiling is consulted (`index.ts:2496-2498`). If a paying Personal customer ever approaches 25,000 the correct answer is a support conversation, which is what `workspace_usage_exemptions` and `/api/admin/usage-exemptions` already exist for.

### 2.4 The conversion target

A free workspace at the allowance is offered **Personal at $5**, not Pro. Same routing as `inboxCapOffer` uses today. Reasons: 7 of 10 existing customers chose Personal; the user's demonstrated need is volume, not mailboxes, and Personal is the cheapest thing that removes the volume limit; and pricing-page evidence in `project_cohort_review_20260902.md` says the in-modal button converts (3/3) while the pricing page does not (1/16).

Expected revenue, stated honestly and pessimistically: ~12 qualifying workspaces/week at a 10-20% conversion rate at $5 is **$6 to $12 of new MRR per week**, i.e. roughly $25 to $50/mo added per month. Against a $75/mo base that is a meaningful multiple over a quarter and a rounding error over a week. Do not expect this to be visible before Stage 3.

---

## 3. What is already built (read this before planning any work)

The brief significantly understates the existing system. Verified in code today:

| Component | Location | State |
|---|---|---|
| Billable-tool allow-list (45 tools; only `inbox_list` is free) | `index.ts:2252-2272` | Live |
| Ledger write | `index.ts:2277-2305` | Live, 127,485 rows |
| Per-plan ceilings (edge copy) | `index.ts:2320-2325` | Live |
| Per-plan ceilings (web copy) | `plans.ts:160, 201, 236, 276` | Live |
| Billing-window resolution (Stripe period for paid, calendar month for free) | `index.ts:2327-2363` | Live |
| **Atomic reserve/finalize with advisory lock** | `reserve_action_usage`, `finalize_action_usage_reservation` (migration `20260803040000_add_atomic_action_reservations.sql`) | Live |
| Cap rejection as `isError` tool result with `_meta` payload | `index.ts:2449-2482` | Live |
| Cap rejection copy | `supabase/functions/mcp-server/usage-limit-message.ts:95-115` | Live |
| Rejection ledger + once-per-period funnel row | `record_usage_limit_event` | Live, 0 rows |
| Comped exemption | `index.ts:2496-2498` | Live, 8 holders |
| Per-workspace exemption + admin API | `workspace_usage_exemptions`, `apps/web/app/api/admin/usage-exemptions/route.ts` | Live |
| Kill switch | `USAGE_ENFORCEMENT_DISABLED=true`, `index.ts:2492` | Live, off |
| Customer usage endpoint | `apps/web/app/api/usage/route.ts` | Live |

**The 5% hash cohort and the existing-workspace exclusion no longer exist.** `index.ts:2417-2430` states plainly that both gates were deleted because a limit covering 5% of new signups and none of the estate stops nothing. Enforcement is currently ON for every workspace, at ceilings nobody reaches.

The practical consequence: **this project is a number change and a copy change, not a systems build.** That is a much better position than the brief assumes, and it should make the team more, not less, careful about the parts that are genuinely new.

---

## 4. The six constraints, answered

### 4.1 Grandfathering

**Finding: the 2026-08-19 grandfather is already inbox-only, by construction.** `resolvePlanLimits` (`plans.ts:347-360`) lifts `maxInboxes` and nothing else when `unlimitedInboxes` is set; `maxMonthlyToolCalls` continues to come from the base plan. `plans.test.ts:89` asserts exactly this: a grandfathered Free user still has `maxMonthlyToolCalls === 5_000`. So an action allowance applies to grandfathered users **today, with zero code changes**. This is not a loophole to close, it is the existing behaviour.

**Finding: the cohort is 26 users, not 151.** `d09afee` (2026-09-01) revoked the grant for the 151 users at 0-1 live inboxes and kept it for 25; one later support grant brings it to 26. Of those 26, six appear in the 36 heaviest free workspaces: `christian@anetzberger.eu` (1,371 actions/30d), `christianmeier504@gmail.com` (828), `bianka.groenewolt@werkraum-landsberg.de` (691), `info@globaleconcepts.com` (637), `herwingunawan.work@gmail.com` (417), `ota@bolognarooms.com` (362). Only one of those six exceeds the proposed 1,000 allowance on a 30-day actual; three exceed it on a 7-day run rate.

**Decision: the allowance applies to grandfathered users. The promise was about inboxes and was written down as being about inboxes.** But two things are mandatory, and the second one is the single most important item in this plan.

1. **Runway, not a cliff.** Before enforcement reaches the free tier, grant every one of the 26 a `workspace_usage_exemptions` row with `expires_at` set 60 days out, via the existing admin route, and email them individually. They get two full billing periods of unchanged behaviour and a dated, named notice. `plans.ts:54-57` must be amended so it no longer implies the grant covers anything but inboxes.

2. **`checkout-core.ts:400` must be resolved BEFORE the allowance ships.** That guard returns a 409 `grandfathered_personal` for any `unlimited_inboxes` user attempting to buy Personal. It exists for a good reason (Personal's 3 inboxes is a downgrade from unlimited). But once Free has an action wall, Personal stops being a downgrade for these users: it is the only thing that removes the wall. A grandfathered user who hits the action allowance today would be told to upgrade and then refused at checkout. That is `project_grandfather_blocked_willing_buyers.md` happening a second time, in the same code path, for the same reason. **Fix: when the caller holds `unlimited_inboxes`, allow the `personal` checkout and preserve `unlimited_inboxes` through the purchase, so they buy the volume and keep the mailboxes.** This is a small change and it is a hard blocker on the rest of the plan.

### 4.2 "The cap has no re-check anywhere"

**This is true of the inbox cap and false of the action cap.**

The inbox cap runs only in `checkInboxLimit` (`apps/web/src/lib/plans/check-inbox-limit.ts:55`), called from the five connect paths only. Nothing revalidates it afterwards, so a workspace that downgrades keeps its inboxes. That is a real gap and it is out of scope here.

The action cap is re-checked **on every billable tool call**, inside `reserve_action_usage`, under `pg_advisory_xact_lock(hashtextextended(workspace_id))`, counting committed ledger rows plus live reservations in the same transaction. There is no drift window and no need for a sweep, cron or DB constraint. Enforcement runs in exactly one place: that RPC, called from `actionLimitResponse` (`index.ts:2484-2523`).

### 4.3 The `isError` transport

Already correct and already documented at length (`usage-limit-message.ts:1-31`, `index.ts:2437-2448`). The rejection is a successful JSON-RPC response with `isError: true`, text in `content[0].text`, machine-readable fields under `_meta["com.mcpemails/usage_limit"]`. Any new message rides the same function. No transport work.

**But the copy is now wrong for the free tier and must fork.** The current text says "This limit is an automated safeguard against runaway usage, not a billing tier" and points at `hello@mcpemails.com`. For a paid workspace hitting 25,000, that stays exactly right. For a free workspace hitting 1,000, it becomes a false statement. `buildUsageLimitText` needs a `variant` parameter:

- **Free variant**: states used/allowance/reset date, states that retrying will not help, names Personal at $5/month as the plan without the limit, links `/pricing`, and re-states the two facts that stop a support ticket: no mail is deleted, no inbox is disconnected.
- **Paid variant**: unchanged, verbatim.

The rules in the file header stay binding for both: declarative facts only, no imperatives aimed at the model, nothing appended to successful results.

### 4.4 Replay billing

**Already addressed, better than the brief suggests.** The reserve/finalize protocol means:

- A reservation is taken *before* the tool runs and counts against the cap immediately, so concurrent calls cannot overshoot.
- `finalize_action_usage_reservation(id, succeeded)` deletes the reservation and writes an `action_usage` row **only if the call succeeded**. A failed or errored call is refunded automatically.
- Orphaned reservations (edge function died mid-call) expire after 15 minutes and are swept on the next `reserve_action_usage` for the same workspace.

The residual gap is narrow and worth naming: an **idempotent replay** of an outbound operation (same `idempotency_key`, collapsed by `outbound_idempotency` and returned from `idempotency-replay.ts`) still passes through `actionLimitResponse` and takes a reservation, so a client that retries a send three times after a dropped connection is charged three actions for one email. At 1,000 free actions this is noise. **Proposed fix, small and worth doing in the same release: when a call resolves as `idempotent_replay: true`, finalize its reservation with `succeeded = false`** so the replay is refunded and the original send is the only charge. One line at the replay return site, plus a test.

### 4.5 The rollout gate

**Already gone.** `index.ts:2417-2430` deleted both the 5% deterministic hash cohort and the created-after-date restriction, on the correct reasoning that they were the shape of a paywall rollout applied to an abuse ceiling. What remains is `USAGE_ENFORCEMENT_DISABLED`, a kill switch that is off by default.

**Decision: do not reintroduce a hash cohort.** It was removed for good reasons and re-adding it would mean two different free tiers running simultaneously, which is a support and copy problem out of proportion to the information gained at n=118/week. Stage the rollout by **plan-and-tenure segment** instead (section 6), which is legible to a user reading a dated email and legible to you reading a funnel.

### 4.6 Migrations

`git status` on 2026-09-07 shows no untracked or modified migrations, and `apps/web/src/types/database.types.ts` is clean against HEAD. The last migration is `20260903120000_experiments.sql`. No peer work is in flight and the table space is clear.

Workflow, per `feedback_supabase_migration_history_out_of_sync.md`: **never `db push`**. Apply with `npx supabase db query --linked -f supabase/migrations/<file>.sql`, then `npx supabase migration repair --status applied <version>`, then regenerate `database.types.ts`. Re-check `git status` and `database.types.ts` immediately before applying, because that check is only valid at the moment it is run.

---

## 5. The technical plan

### 5.1 Deploy order

The convention here is migration, then edge function, then env vars, then web deploy. This project needs one deviation, called out in Stage 1: **the checkout fix must be live in production before any user can hit the new allowance**, otherwise the wall exists and the exit does not.

### 5.2 Files and tables that change

**Migration** (one file, `supabase/migrations/20260908######_free_action_allowance.sql`):

- No schema change is required. `action_usage`, `action_usage_reservations`, `usage_limit_events`, `workspace_usage_exemptions` and `user_usage_entitlements` all already have the right shape.
- The only DDL worth considering is an index check: confirm `action_usage` has a composite index on `(workspace_id, billable, meter_version, occurred_at)`. `reserve_action_usage` runs this count on **every billable tool call**, and it is about to become a query that actually returns non-trivial counts for real workspaces rather than always scanning a handful of rows. Verify with `EXPLAIN` against the largest workspace (`tor-jetix16`, 31,898 rows in 30 days) before shipping. **I have not verified the current index set; do this first.**
- Data: the 26 runway exemptions. Prefer the existing `/api/admin/usage-exemptions` route over raw SQL so `granted_by`, `reason` and `ticket_id` are populated and support can see them.

**Edge function** (`supabase/functions/mcp-server/`):

| File | Change |
|---|---|
| `index.ts:2320-2325` | `SHADOW_ACTION_CAPS.free`: `5_000` -> `1_000`. This is the entire enforcement change. |
| `index.ts` (replay site) | Finalize the reservation with `succeeded = false` on `idempotent_replay`. |
| `usage-limit-message.ts:95` | Add the free/paid variant fork described in 4.3. |
| `usage-limit-message.test.ts` | Cases for both variants. Assert the free variant names Personal and `/pricing`; assert the paid variant is byte-identical to today. |

Deploy with `npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt` (`feedback_edge_function_deployment.md`).

**Web** (`apps/web/`):

| File | Change |
|---|---|
| `src/lib/stripe/checkout-core.ts:400` | **Blocker.** Allow `personal` for `unlimited_inboxes` holders, preserving the grant. |
| `src/lib/stripe/plans.ts:160` | `free.maxMonthlyToolCalls`: `5_000` -> `1_000`. Must move in lockstep with the edge copy. |
| `src/lib/stripe/plans.ts:83-94` | Rewrite the "SILENT ABUSE CEILING / must never appear in customer-facing copy" comment. It is about to be false for Free and still true for paid. |
| `src/lib/stripe/plans.ts:54-57` | Amend the grandfathering paragraph to say the grant is inbox-only. |
| `src/lib/stripe/plans.ts:182-189` | Free `features[]`: add "1,000 email actions a month". |
| `src/lib/stripe/plans.ts:218-224, 258-264, 298-305` | Paid `features[]`: add "Unlimited email actions". |
| `app/pricing/**` | Comparison table row for actions; a short "what counts as an action" note stating that `inbox_list` is free. |
| `app/api/usage/route.ts:24-29` | The docblock says the monthly row "must never be presented as something a customer can buy more of". False for Free after this change. |
| `app/dashboard/[[...section]]/page.js` | A visible meter for free workspaces. **Today there is no `/dashboard/usage` route**, yet `usage-limit-message.ts:114` sends users to `${appOrigin}/dashboard/usage`. Either build that section or change the link. Shipping a limit that points at a 404 is not acceptable. |
| `src/lib/analytics/growth-queries.ts:290-312` | The comment says a workspace at 60% of ceiling "is not a customer about to convert". After this change that is exactly what a free workspace at 60% is. |
| `docs/` and `README.md` | Anywhere that claims unlimited free usage. |

**Env vars**: none new. `USAGE_ENFORCEMENT_DISABLED` already exists as the kill switch.

### 5.3 Counter, reset, and the hot path

**Where the counter lives**: nowhere. There is no counter. `reserve_action_usage` computes `count(*)` over `action_usage` in the billing window plus live reservations, inside an advisory lock, per call. There is no cached value to drift.

**How it resets**: it does not reset, the window moves. Free uses the UTC calendar month (`calendarMonthUsageWindow`, `index.ts:2334`); paid uses the Stripe period from `user_billing`. `/api/usage` computes the same boundaries independently (`route.ts:99-106`), which is a **drift risk worth noting**: two implementations of one rule. Worth unifying eventually; not a blocker.

**On "how do we check enforcement on the hot path without adding a query per tool call": we already add five.** `actionLimitResponse` performs, per billable call: a `workspaces` select, a `user_usage_entitlements` select, a `workspace_usage_exemptions` select, a `user_billing` select for paid plans, and the `reserve_action_usage` RPC, followed by a finalize RPC after the tool runs. That is 5-6 round trips per tool call today, and it is the honest answer to the question.

Two optimizations, both optional and neither on the critical path:

1. **Collapse the three pre-checks into one RPC.** `effective_workspace_plan` already exists and already resolves plan, `comped_scale` and `unlimited_inboxes` in one call (used by `checkInboxLimit`). Extending it to also return the exemption state and folding it into `reserve_action_usage` would take 5-6 round trips to 2. Do this **only if** the index check in 5.2 shows latency is a problem.
2. **Do not add a cache.** A per-instance cache on an edge function with unpredictable instance lifetime, guarding a limit that must be exact at the boundary, buys milliseconds and costs correctness.

**How the user is told**, in three places:

1. **In the agent**, at the moment of refusal: the free variant of `buildUsageLimitText`, riding the existing `isError` result. This is the only channel that reliably reaches a user whose entire interaction is through an MCP client.
2. **In the dashboard**, before refusal: a meter reading "X of 1,000 actions, resets <date>" for free workspaces, plus an in-context Personal offer at 80%. The 80% state is the conversion surface; the 100% state is damage control.
3. **By email**, before refusal: at 80% of allowance, once per period. The lifecycle email infrastructure shipped 2026-09-07 (`project_billing_lifecycle_emails.md`) and this is a new event on it.

Point 3 is not optional. A user whose automation stops overnight with no warning is a churned user and a support ticket. See 5.4.

### 5.4 The automation problem

`triage_move` is 17.2% of free-tier volume, generated by **8 workspaces averaging 757 actions each**. Automations run unattended, on a cadence, with no model in the loop (`project_automations_unattended_triage.md`). When one of them hits the allowance:

- there is no agent session to receive the `isError` text, so the primary notification channel does not exist;
- the failure is silent from the user's side: mail simply stops being triaged;
- the user's most likely conclusion is that the product broke, not that they hit a limit.

**Required, not optional:** when an automation run is refused for `usage_limit_reached`, disable the rule (or mark it suspended), record the reason, and send the owner an email naming the rule and the allowance. An automation that fails silently for two weeks is worse for retention than no allowance at all. This is the single largest piece of genuinely new work in the project and it should be scoped before Stage 3, not after.

---

## 6. Staged rollout with kill criteria

The kill switch throughout is `USAGE_ENFORCEMENT_DISABLED=true` on the edge function, which lifts enforcement globally in one deploy while leaving metering intact. Per-workspace relief is `workspace_usage_exemptions` via the existing admin route.

### Stage 0 (blocking prerequisites, ~2 days)

Ship, in this order, with the allowance still at 5,000 so nothing changes for anyone:

1. `checkout-core.ts:400` fix. Verify by minting a test grandfathered user and completing a Personal checkout end to end.
2. `EXPLAIN` on `reserve_action_usage` against `tor-jetix16`. Add the composite index if missing.
3. Build `/dashboard/usage` (or repoint the link).
4. The 26 runway exemptions, plus their notification email.

**Kill criterion**: a grandfathered test user cannot complete a Personal checkout. Do not proceed.

### Stage 1: measure at the real number (7 days, zero enforcement)

Set `USAGE_SHADOW_WOULD_BLOCK=true` and set the shadow diagnostic's threshold to 1,000 while leaving `SHADOW_ACTION_CAPS.free` at 5,000. Ship the copy fork and the dashboard meter, with the meter reading against 1,000 and clearly labelled as taking effect on a stated date.

**Measure**: how many distinct workspaces log `usage_shadow_would_block` in 7 days; how many are grandfathered; how many are running automations; how many support emails arrive from the meter being visible.

**Kill criterion**: more than 25 distinct workspaces would block in 7 days. That is more than 2x the cohort model predicts and means the distribution moved. Raise the number and re-measure rather than proceeding.

### Stage 2: enforce for new free workspaces only (14 days)

Enforce 1,000 for free workspaces created on or after the launch date. This is a tenure gate, not a hash gate: it is explicable in one sentence to any user who asks, and it means nobody's existing deal changes.

Implementation: a `created_at >= LAUNCH_DATE` condition in `actionLimitResponse`, read from an env var so the date is changeable without a code edit.

**Measure**: `usage_limit_events` rows and distinct workspaces; the once-per-period `paywall_reached` funnel rows; `paywall_reached` to checkout to paid conversion; support volume; 7-day retention of blocked workspaces vs the matched cohort above 500 actions from before launch.

**Kill criteria**, any one of which stops the rollout:
- more than 3 support contacts per week attributable to the allowance;
- fewer than 5% of blocked workspaces start a checkout within 7 days (the wall is producing friction without producing decisions);
- 7-day retention of blocked workspaces falls more than 15 points below the matched pre-launch cohort;
- any blocked workspace turns out to be a paying customer or a comped account (an exemption bug: stop immediately).

**Success criterion to proceed**: at least one completed Personal purchase attributable to `paywall_reached` with `category = 'free'` in the volume path, and no kill criterion tripped.

### Stage 3: extend to existing free workspaces (14 days)

Only after Stage 2 passes, and only after the automation-suspension work in 5.4 is shipped.

Requires a dated notice by email to every free workspace with more than 250 actions in the trailing 30 days, at least 14 days before the date, naming their own current number. The 26 grandfathered exemptions are still live at this point and expire after this stage, not during it.

**Kill criteria**: the Stage 2 criteria, plus any single day with more than 10 newly blocked workspaces (indicates the estate is denser above 1,000 than the sample suggested).

### Stage 4: settle the number (30 days)

With two full billing periods of real data, decide 1,000 vs 500 on evidence: blocked-workspace count, conversion rate per blocked workspace, and support cost per blocked workspace. Change the number in exactly one direction per decision, and never while another pricing change is in flight.

---

## 7. Risks, stated honestly

**Cannibalization of the inbox paywall.** Low, and worth stating precisely. The two gates address disjoint populations: 30 of the 36 heaviest free workspaces have exactly one inbox and are invisible to the inbox gate; the inbox gate fires on workspaces attempting a second connection, which is a different event. The real risk is not revenue cannibalization but **attention cannibalization**: a user who sees two limits may read the product as stingy where they previously read it as generous. Mitigation is that Free stays 6.7x more generous on volume than the nearest competitor and should say so.

**Backlash from users who have been unmetered for months.** This is the genuine one, and there is no version of this project that avoids it. 175 active free workspaces have never seen a limit. The 36 heaviest have built habits, and eight have built automations, on the assumption of unlimited volume. Staging by tenure means new users never experience a change, only a limit that was always there; existing users get a dated notice and, if grandfathered, 60 days. That reduces the harm without eliminating it. **Accept that some of the 36 will leave.** They are worth roughly $0 today, and the information from watching them respond is worth more than their silence.

**Support load on a solo operator.** The load is not the blocked users, it is the 80%-warning users, who arrive earlier and in greater number. Budget for it: at 118 signups/week and a ~10% rate above 500 actions, roughly 12 warning emails/week by Stage 3. The kill criterion of 3 contacts/week is deliberately tight because support is the binding constraint here, not engineering.

**Changing the deal for people already using the product.** This is what happened on 2026-08-19 with inboxes and it produced `project_grandfather_blocked_willing_buyers.md`: 151 users were protected into being unable to pay. The specific failure was not the change, it was that the protection and the purchase path contradicted each other. **The lesson applies directly and is why `checkout-core.ts:400` is Stage 0 and not a footnote.** Every wall this project builds must have a working door before it exists.

**Automations failing silently.** Covered in 5.4. This is the highest-severity product risk and the largest piece of new work.

**Two copies of the cap constant.** `index.ts:2320` and `plans.ts:160` are independent literals that must agree. They agree today. Nothing enforces it, and after this change the dashboard meter and the enforcement point would silently disagree if one moved. A test asserting equality is cheap; there is no shared module between the Deno edge function and the Next app, so the test is the only available mechanism.

**The `inbox_list` gap.** A user's client makes ~26% more calls than the meter counts. That is generous in the user's favour and therefore safe, but it means the number in a client's own logs will never match the dashboard. The docs must say so.

**Measurement risk in this document.** 297 of 379 external free workspaces were created within the last 30 days, so their 30-day figures are partial windows and understate steady-state volume. This is why section 1.6 leads with cohort and run-rate rather than raw 30-day counts. If steady-state volume per workspace is materially higher than the first 14 days suggest, every "workspaces above threshold" number here is a floor, and 1,000 will catch more people than predicted. Stage 1 exists to find that out before anyone is blocked.

---

## 8. Decided vs open

### Already decided in this document (challenge these if you disagree)

1. Actions are a **Free-tier gate**, not a product. No overage, no metered Stripe price, no fifth tier.
2. Paid tiers are sold as **unlimited actions**; the existing `maxMonthlyToolCalls` values stay as invisible abuse ceilings.
3. The conversion target from the action wall is **Personal at $5**, matching `inboxCapOffer`.
4. The grandfather grant is **inbox-only** and the action allowance applies to those 26 users, with a 60-day exemption runway and an individual email.
5. **No hash cohort.** Stage by tenure (new free workspaces first), which is explicable to a user.
6. `checkout-core.ts:400` is a **hard blocker**, shipped before anything else.
7. Idempotent replays are **refunded** by finalizing their reservation as failed.
8. Automations must be **suspended with notice**, not failed silently, before Stage 3.

### Open, for you to decide

1. **1,000 or 500 per month?** 1,000 touches 7 workspaces on 30-day actuals and ~13 on run rate; 500 touches 16 and 20. 1,000 is the safer first move and 500 is the one that produces more decisions. My recommendation is to launch at 1,000 and settle this at Stage 4 with real conversion data, but launching at 500 is defensible if you would rather learn faster and accept more churn.
2. **Calendar month, or rolling 30 days?** Calendar month is what the code does today and is easier to explain. Rolling 30 days is harder to game and matches how a user experiences their own usage. Changing it is a larger job than the allowance itself. Recommendation: keep calendar month, revisit never unless gaming appears.
3. **Does `tor.jetix16@gmail.com` stay comped?** One account is 31,898 actions in 30 days, roughly 37% of all billable volume on the platform, on a permanent free Team grant. This is not part of the allowance project (they are comped and exempt by design) but it is the single largest cost line in the business and the plan would be incomplete for not naming it. A conversation, not a code change.
4. **Does `gary@eidon.com` stay comped?** 1,946 actions/30d on a **single inbox** with `comped_scale`. This is the exact archetype the whole project is aimed at, and he is permanently exempt from it. There are 8 comped accounts; it is worth reviewing which of them were granted for reasons that still apply.
5. **Do you want the 80% warning email at all in Stage 2?** It softens the wall and costs a lifecycle-email integration. Omitting it in Stage 2 gives a cleaner read on how much of the conversion comes from the wall itself, at the cost of a worse first experience for ~12 users. I would ship it; the cleaner experiment is not worth the worse product.
6. **Should `inbox_list` stay non-billable?** It is 26% of free call volume. Making it billable would let a smaller headline number produce the same effective pressure, at the cost of a less honest-feeling meter. Recommendation: keep it free, but this is a real lever if 1,000 proves too loose.

---

## Appendix: reproducing these figures

All queries were run read-only against production with `npx supabase db query --linked -f <file>`. The `--linked` flag is mandatory; without it the CLI silently targets an empty local database and returns wrong answers. Every "external" figure applies this exclusion:

```sql
join auth.users u on u.id = w.owner_id
where u.email not ilike '%@mcpemails.%'
  and u.email not ilike 'bjellanda%'
  and u.email not ilike '%@example.com'
```

Without it, the largest free-plan workspace in the dataset is `hello@mcpemails.com` at 8,646 actions, and the largest workspace overall is a comped account at 31,898. Both distort every threshold calculation. Aggregate in SQL rather than selecting rows: PostgREST truncates row-returning selects at 1,000 rows without warning.
