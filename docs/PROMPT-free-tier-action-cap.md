> **SUPERSEDED 2026-09-12** by `docs/PLAN-free-action-cap-150.md`: the number is 150/month, the first 7 days are uncounted, there is NO daily sub-cap, NO A/B, and every workspace existing at launch is exempt. The mechanics below (isError result, `_meta` fields, declarative copy, fail-open) still apply.

# Put a real action allowance on the Free tier

You are building the **second paywall**. MCPEmails has exactly one today (the
one-inbox cap on Free), and 61% of active free workspaces can never meet it,
because they are content with a single mailbox and the action ceiling is
unreachable. Your job is to close that hole.

Work in `/Users/asgeiralbretsen/Repositories/MCPEmails`. This is a LIVE product
with paying customers. Confirm with the user before any deploy, any push, any
migration applied to production, and before enforcement is switched on.

Read these first, in this order. They contain the analysis; do not re-derive it:

1. `docs/RESEARCH-500-action-cap.md` - what number, and why the shape matters more
2. `docs/RESEARCH-when-to-paywall.md` - why the existing gate is fine and this one is needed
3. `docs/PLAN-monetize-action-volume.md` - the original 2026-09-07 design

---

## The decision already made

**Free gets a metered action allowance. Paid tiers do not.** Their existing
`maxMonthlyToolCalls` numbers stay exactly what they are today: silent abuse
ceilings that are never sold and never named in customer-facing copy.

**Ship 500/month WITH a ~50/day sub-cap.** The daily sub-cap is not optional
polish, it is the thing that makes 500 safe:

- 500/month bare has a median time-to-lockout of **2.4 days after signup**, and
  26% of workspaces that reach it do so within 24 hours. That is 28 dark days
  during the evaluation window.
- With a ~50/day sub-cap the fastest possible exhaustion becomes 10 days, and a
  single busy afternoon costs the user that day only.
- Every competitor with a working free tier pairs a monthly number with a daily
  one (anymailmcp 15/day, AgentMail 100/day).

`PlanLimits.maxDailyBurstCalls` already exists in `apps/web/src/lib/stripe/plans.ts`.
It is `Infinity` on every tier and enforced nowhere. The field is there; the
enforcement is not.

**If the daily sub-cap turns out to be more work than it is worth, ship
1,000/month flat instead and say so.** Do not ship a bare 500/month. That is the
one option the research rules out.

---

## Sizing context, so you do not have to re-measure

Active external free workspaces, 30-day billable actions: p50 = 41, p75 = 189,
**p90 = 478**, p95 = 853, max = 4,288. Median 7.2 billable actions per session,
p90 39.5.

At current signup volume: **~40 workspaces/month arrive at 500**, ~11 at 1,000.
Right now 11 active free workspaces run 500+/month and 6 run 1,000+ (13,981
actions between those 6), all free, forever.

The cap has **zero** cost-avoidance justification. Total external free volume is
~46k calls/month, well under a dollar of marginal infrastructure. It is purely a
conversion instrument and should be judged only on conversion and churn.

---

## What already exists (read before writing anything)

**Enforcement, `supabase/functions/mcp-server/index.ts`:**

- `BILLABLE_TOOL_NAMES` (~line 2355). Every tool except `inbox_list` is billable.
  Triage operations and automation management are already in the set.
- `SHADOW_ACTION_CAPS` (~line 2423): `free: 5_000, personal: 25_000, solo: 100_000,
  pro: 500_000`. Must stay in step with `maxMonthlyToolCalls` in `plans.ts`.
- `actionLimitResponse()` (~line 2587). The whole gate. Order of operations:
  kill switch `USAGE_ENFORCEMENT_DISABLED` -> non-billable tool -> workspace
  lookup -> `comped_scale` entitlement exemption -> `workspace_usage_exemptions`
  exemption -> cap lookup -> `resolveUsageBillingWindow()` -> `reserve_action_usage`.
  It **fails open** when the reservation subsystem errors. Keep that.
- `usageLimitResult()` returns an **`isError: true` tool result**, not a JSON-RPC
  error, with structured fields under `_meta["com.mcpemails/usage_limit"]`. This
  is deliberate and correct per the MCP spec: quota exhaustion is a tool
  EXECUTION error, which clients SHOULD hand to the model. Do not turn it back
  into a protocol error.
- A cap rejection also writes `activity_log`, which keeps a retry-looping client
  under both throttles. Do not remove that.

**Database:**

- `reserve_action_usage(p_workspace_id, p_tool_name, p_meter_version, p_cap,
  p_period_start, p_period_end)`. Takes an advisory xact lock, sweeps expired
  reservations, counts `action_usage` (billable, matching meter version, inside
  the window) UNION `action_usage_reservations`, refuses at `>= p_cap`, otherwise
  inserts a reservation expiring in 15 minutes. **This is where the daily window
  goes.** One extra count against a day window, under the lock you already hold.
- `finalize_action_usage_reservation(p_reservation_id, p_succeeded)`.
- `record_usage_limit_event` writes both `usage_limit_events` and a
  `product_funnel_events` row with `stage = 'paywall_reached'` and
  `connection_type = NULL`. The inbox gate writes `'first_connect'`, so the two
  paywalls stay separable in `billing_funnel_by_workspace` with **no schema
  change**. Preserve that distinction.
- Windows: Free uses a UTC calendar month (`calendarMonthUsageWindow`); paid
  workspaces resolve from Stripe's stored cycle.
- `usage_limit_events` has **0 rows, ever**. Nothing here has ever fired in
  production. You are the first.

---

## The four things that will bite you

### 1. Automations are metered but not gated. This is the largest piece of work.

`supabase/functions/mcp-server/triage-engine.ts` calls `writeActionUsage` but
**never calls `actionLimitResponse`**. Verify this yourself; it is the single
most important fact in this document.

So today a Free workspace's automations consume the allowance and would run
straight past it. Both possible fixes are real work:

- Gate them, and an unattended rule stops with **no agent in the loop** to read
  the `isError` text. The user's experience is that mail silently stops being
  triaged.
- Do not gate them, and the allowance leaks.

`triage_move` alone is 6,395 actions from **9 workspaces**, averaging 710 each.
Every one of those 9 breaches a 500/month cap on automation alone. Whatever you
choose, **suspension must be visible**: an email, a dashboard state, and an
`automation_runs` entry that says why. A silent stop is the worst outcome
available and is worse than not shipping.

### 2. The no-upsell doctrine inverts, for Free only.

`supabase/functions/mcp-server/usage-limit-message.ts` is built on an explicit
premise stated in its header comment: the ceiling is **not** a paywall, nothing
in the file may sell or upsell, and `pricing_url` was deliberately removed from
`_meta` because "paying does not buy a bigger allowance."

For Free that stops being true the day you ship. For Personal, Pro and Team it
stays true. So this file needs **two** messages, chosen by plan, and the header
comment needs rewriting to say which premise applies where. Getting this wrong
in either direction is a false statement to a customer:

- Free hitting 500 and being told "contact support, paying will not help" sends
  a willing buyer away.
- Pro hitting 100,000 and being told "upgrade for more actions" sells something
  that does not exist.

Keep everything else in that file. The "retrying will not help" sentence stops
agent retry loops and works on models that never see the numeric code. Keep the
declarative framing with no imperatives aimed at the model: an instruction to a
model inside a tool response is mechanically indistinguishable from prompt
injection by the server operator, which this product's security posture exists
to refuse.

### 3. The Free allowance becomes public copy.

`plans.ts` currently says `maxMonthlyToolCalls` "must never appear on the pricing
page, in plan feature lists, in the dashboard, or in the docs." That instruction
now applies only to the paid tiers. Free's number has to appear on `/pricing`,
in `PLANS.free.features`, in the dashboard usage view, and in the docs, or you
are enforcing a limit you never disclosed. Update the comment so the next
session is not misled by it.

Per-page copy must not go into `messages/` (next-intl namespaces ship to every
page), and `'<'` in ICU renders literally in production, so reword rather than
escape.

### 4. Existing users.

Decide and **confirm with Asgeir before implementing**: does this apply to all
free workspaces, or only to those created after a cut date? The 2026-08-19
repricing grandfathered every pre-existing user into unlimited inboxes
permanently via `user_usage_entitlements.unlimited_inboxes`, and that is the
precedent people will expect. Applying a cap retroactively to the 11 active
heavy users is the highest-risk action in this whole piece of work, and 6 of
them run 1,000+ actions a month.

`workspace_usage_exemptions` already exists and is consulted before the ceiling.
It is the right mechanism if you grandfather.

---

## Definition of done

1. Free has a monthly allowance and a daily sub-cap, enforced atomically in
   `reserve_action_usage` under the existing advisory lock.
2. Paid tiers behave exactly as they do today.
3. The refusal message is plan-aware: Free gets a route to Personal at $5, paid
   tiers get the unchanged fair-use text.
4. Automations either respect the cap with visible suspension, or are explicitly
   and deliberately exempt, documented either way.
5. The allowance is disclosed in `/pricing`, plan features, dashboard and docs.
6. `usage_limit_events` and the `paywall_reached` funnel row both fire, and the
   action-cap rows stay distinguishable from the inbox-gate rows.
7. Capped and rate-limited calls are **excluded from success-rate math**, or the
   kiosk reliability panel will read a working cap as an outage.
8. Verified in production against a real workspace that actually hits the cap.

---

## Operational notes

- **Migrations:** never `db push`. Use `npx supabase db query -f <file>` then
  `npx supabase migration repair`. Check `git status` and `database.types.ts`
  first: peer sessions collide on migrations.
- **Edge function deploy:** `npx supabase functions deploy mcp-server
  --project-ref swvaxorwumispmjaaszb --no-verify-jwt`.
- **Testing:** a deploy does NOT refresh this session's connector schema. Mint a
  temporary API key and call the edge function over HTTP to test new behaviour.
- **Kill switch:** `USAGE_ENFORCEMENT_DISABLED=true` disables enforcement
  entirely. It is a kill switch, not a rollout flag; enforcement is ON unless
  something says otherwise. Do not invert it.
- **Queries:** aggregate in SQL. PostgREST truncates row-returning selects at
  1,000 rows silently. Supabase rpc calls need `.bind(supabase)`.
- **Do not re-add** the `checkout-core.ts` 409 that refused `personal` from
  grandfathered users. It was removed 2026-09-07 for good reasons written out in
  full at the callsite.
- Exclude `@mcpemails.*`, `bjellanda*`, `@example.com` and the
  `internal_accounts` table from every production figure you quote.

## Ship it in stages

Enforcement last. Land the daily window, the plan-aware message, the automation
decision and the public copy while the cap is still effectively unreachable, so
that switching the number down is a one-line change you can revert in seconds.
