# Decision: should Free get a usage cap?

Asked 2026-09-12 after outside advice that "a lot of heavy single-inbox users have no
reason to upgrade". All figures re-measured against prod that day
(`npx supabase db query --linked`), external free workspaces only (excludes
`@mcpemails.*`, `bjellanda*`, `@example.com`, `internal_accounts`).

Companions: `RESEARCH-500-action-cap.md` (09-09, said 500 with a daily sub-cap),
`REVIEW-action-cap-adoption-impact.md` (09-09, said do not ship at any number),
`PLAN-monetize-action-volume.md` (09-07, said 1,000 flat). This memo settles the
disagreement between them.

---

## 0. Verdict

**Yes, add the cap, but only in one shape: 500 billable actions per calendar month on
Free, with the first 7 days after signup uncounted, no daily sub-cap, and enforcement
starting 2026-10-01.** Do not ship the bare 500 (locks people out on day 2) and do not
ship 500 + 50/day (refuses 14.5% of all active days, mostly during evaluation).

The advice is right on direction and wrong on size. "A lot of heavy users" is **5
single-inbox workspaces** that sustain 500+/month after their first week, plus about
**3 new ones per week** at current signup volume. The upside is roughly $10 to $15 of
new MRR per month, compounding. That is small, and it is still worth doing, for three
reasons that do not depend on the money:

1. The 5 are behaving exactly like the top paying customers (who run 1,000 to 3,000
   actions/month) and have **never been shown a price**: none of the three heaviest
   has a `pricing_viewed` or `paywall_reached` row. The inbox gate cannot reach them
   and never will. The 9/12 copy fix closed the last alternative lever (scheduled
   sends and the approval hold stay free by decision).
2. With a 7-day grace the cap only touches sustained use. Evaluation lockout, which
   is the whole case against it in the 09-09 review, disappears by construction.
3. A published Free ceiling is standard in the category (anymailmcp 150/month,
   AgentMail 3,000/month) and gets harder to introduce the larger the estate grows.
   Signups are 119/week and rising.

---

## 1. The pool, measured three ways

**Stock, last 30 days.** 21 external free workspaces at 500+ billable actions, 17 of
them single-inbox. This is the number the advice is looking at, and it is inflated by
first-week bursts: 4 of the top 6 did 90%+ of their volume inside one week and then
went quiet or left (e.g. 3,491 actions in week one, 10 the next; 2,120 in week one,
1 since).

**Sustained, matured 21+ days, first 7 days excluded, projected to 30 days (n = 184,
87 single-inbox).**

| Sustained rate | Workspaces | of which single-inbox |
|---|---:|---:|
| > 250/mo | 15 | 11 |
| > 500/mo | 9 | **5** |
| > 1,000/mo | 3 | 2 |

p95 of the sustained rate is **447/month**, so 500 sits at the p95 boundary. The five
single-inbox workspaces: b05a513f (~2,480/mo, 4 straight weeks of 445 to 778),
05d583c7 (~1,535), ca5a9249 (~720, five straight weeks), 1eb373bd (~570), 512d29ee
(~550). The four multi-inbox ones are grandfathered `unlimited_inboxes` holders; the
grant survives a Personal purchase (see `checkout-core.ts:476-500`), so Personal is a
strict upgrade for them too.

**Flow.** 9 of 184 matured free workspaces (4.9%) sustain 500+. New signups are all
single-inbox now, so use 5 of 184 (2.7%). At 119 signups/week that is ~3 per week,
~13 per month, arriving at a volume-shaped decision that today does not exist.

**Comparison with paying customers, last 30 days:** 3,047 / 1,098 / 1,073 / 380 / 346
/ 237 / 178 / 93 / 41 / 2. The heavy free five sit in the same band as the top three
payers.

---

## 2. Why the 09-09 review's "no" no longer holds

The review made three arguments. Two are answered by the grace window, one by a
decision taken since.

- *"Sustained usage barely exists (2 of 103)."* With three more days and a larger
  matured cohort it is 9 of 184, 5 of them single-inbox. Still small, no longer
  negligible, and it grows with signups.
- *"22.7% of activated users would be refused on day one; 48 of 56 daily-cap hits are
  in week one."* True for 500 + 50/day. Both numbers are zero under 500/month with the
  first 7 days uncounted and no daily cap. The grace window is the whole fix.
- *"There is a better lever: gate scheduled sends and approvals."* Rejected on
  2026-09-12 (commit 597f7ea and `project_personal_vs_free_real_deltas`): those are Free
  features and the approval hold is the safety brake on an agent that sends email. With
  that lever gone, volume is the only dimension left that reaches a single-inbox user.

What the review got right and this memo keeps: an MCP cap renders as "the email tool
stopped working" unless the user has been warned somewhere they can see, and a silently
stopped automation is worse than shipping nothing.

---

## 3. Shape

| Element | Choice | Why |
|---|---|---|
| Allowance | 500 billable actions / UTC calendar month | p95 of sustained use; 3.3x anymailmcp |
| Grace | Actions in the first 7 days after workspace creation do not count | Median time to 500 without it is 2.4 days; with it, evaluation cannot be walled |
| Daily sub-cap | None | 50/day refuses 52% of all free actions and lands on evaluators; the grace window already solves day-2 lockout |
| Paid tiers | Unchanged, silent ceilings stay silent | Personal at $5 is the exit; no new axis |
| `inbox_list` | Stays non-billable | 26% of free call volume; publishing a number the meter does not match breaks trust on day one |
| Warning | Dashboard banner at 80% and an email at 80% and 100% | Attribution: the refusal must be recognisable as a plan boundary, not an outage |
| Automations | Gate them, and on refusal set the rule to a visible "paused: plan limit" state with an email | `runAutomationTool` (cron path, index.ts ~26059) never calls `actionLimitResponse`; the only gate is the tools/call path at ~25625. Left alone, automations run for free above the cap; gated silently, mail stops being triaged with nobody in the chat to read the error |
| Reviewer/grader accounts | `comped_scale` entitlement or `workspace_usage_exemptions` row before launch | `directory-review@` peaked at 182/day |
| Disclosure | Actions row in the pricing table, README plan table, `/docs` | Required before enforcement, and it is what a directory visitor reads first |

Everything else in `PROMPT-free-tier-action-cap.md` still applies (isError tool result,
`_meta` fields, declarative copy, fail-open reservation) except its daily sub-cap
instruction, which this memo withdraws.

---

## 4. Existing users over the limit

**13 free workspaces are already past 500 in September on day 12.** Turning a
calendar-month cap on today locks all 13 for 18 days, and 4 of them signed up between
09-04 and 09-09 and are still evaluating. So:

1. **Enforce from 2026-10-01 00:00 UTC.** Free already uses the UTC calendar month
   (`calendarMonthUsageWindow`), so "reset everyone to count from today" is just a
   start date on the kill switch, no reset code. Announce around 09-22 to everyone
   over 250 this month.
2. **Grace the sustained nine through 2026-10-31** with a `workspace_usage_exemptions`
   row (admin API exists: `apps/web/app/api/admin/usage-exemptions/route.ts`,
   takes `expires_at`). They are the only people who will feel October's cap, and they
   are the ones worth a personal note.
3. **The $5 coupon: yes, for those nine only.** `allow_promotion_codes` is already on
   at checkout (`checkout-core.ts:704`), so a Stripe promotion code for one free month
   of Personal works with zero code. Maximum cost $45. It gets a card on file, which an
   exemption alone does not. Two cautions: the code must be created in the Stripe
   dashboard by hand (live Stripe is unreachable from this Mac), and the confirmation
   email prints the discounted first-period amount as the recurring price (known
   cosmetic bug, `project_personal_tier_rollout`), so the note should state the $5
   renewal price itself. Do not offer it to the burst workspaces; they will not hit
   October's cap and a coupon would only teach them the price is negotiable.
4. Emails are drafts for Asgeir to send, never sent by the tooling.

---

## 5. What to measure after

`usage_limit_events` has 0 rows ever. After 10-01: distinct workspaces hitting the
cap per week, `paywall_reached` (usage) to `checkout_completed` rate, 7-day retention
of capped vs uncapped in the same cohort, and automation pause events. Revisit the
number at the end of November with real conversion data; 1,000 is the fallback if the
retention delta is worse than the conversion gain.

## Sources

Prod queries in the session scratchpad (`q1` to `q7`): `action_usage`, `workspaces`,
`users`, `inboxes`, `internal_accounts`, `user_billing`, `product_funnel_events`,
`workspace_usage_exemptions`. All aggregated in SQL (PostgREST 1,000-row cap).
Code: `supabase/functions/mcp-server/index.ts` (`SHADOW_ACTION_CAPS`,
`calendarMonthUsageWindow`, `actionLimitResponse`, cron dispatch),
`apps/web/src/lib/stripe/plans.ts`, `apps/web/src/lib/stripe/checkout-core.ts`,
`apps/web/app/api/usage/route.ts`, `apps/web/app/api/admin/usage-exemptions/route.ts`.

---

## 6. Addendum, same day: why not much lower than 500?

Asked after seeing mailmcp.io (Free: 1 mailbox, **5 MCP calls/day**; Pro: EUR 2.99 per
mailbox per month, 500 calls/day/mailbox). Goal restated as: maximise MRR.

**500 was the safe number, not the MRR-maximising one.** It sits at p95 of sustained
use so that almost nobody is touched. If the goal is MRR, the evidence points lower.

Matured cohort (21+ days, n = 184), sustained post-grace rate, with 7-day retention:

| Sustained rate/month | Workspaces | Still active this week | Decisions/month at ~500 signups |
|---|---:|---:|---:|
| 0 | 126 | 0% | |
| 1-50 | 25 | 44% | |
| 51-100 | 5 | 40% | |
| **101-150** | 6 | **100%** | cap 100: ~75 |
| 151-250 | 5 | 100% | cap 150: ~60 |
| 251-500 | 8 | 88% | cap 250: ~46 |
| 500+ | 9 | 100% | cap 500: ~25 |

Two facts decide it. **Everyone above 100/month sustained is retained** (27 of 28 active
this week, vs 43% below 100): above 100 is where the habit is, and a habit is what a
paywall can sell to. And **the count of decisions roughly triples between 500 and 100**
while the population stays committed. At the inbox gate's observed 5 to 6% close rate
(the only wall we have ever measured), that is about $6-12/month of new MRR at 500
versus $19-38 at 100, per month, compounding. Every number here is an estimate with no
local conversion evidence, which is what the A/B in section 7 is for.

**Why not 5/day like mailmcp.** With the 7-day grace, week one (51% of all free volume)
is untouched either way, so the question is only what Free is after the trial. The
median post-grace active day is 9.1 actions and the median session 7.2, so 5/day cannot
complete one ordinary conversation; it is a demo tier, and it turns Free into a 7-day
trial in practice. That is a legitimate strategy but a different one: it gives up the
"generous free tier" position that the directory listings and comparison pages sell,
and it makes the MCP attribution problem (section 2) an everyday event instead of an
edge case. The floor I would test is **100/month**; below that the cap is walling
median post-grace use rather than heavy use.

mailmcp's paid pricing is not a reason to move: Personal at $5 for 3 mailboxes is $1.67
per mailbox against their EUR 2.99.

**Revised recommendation:** publish **150/month** (first 7 days uncounted, no daily
cap) and A/B it against 500, see section 7. 150 buys about 20 median sessions a month
after the trial and stays the most generous tier in the category (anymailmcp 150/month
with a 15/day cap, mailmcp 5/day).

## 7. A/B test design

Feasible with the existing system (`apps/web/src/lib/experiments/`, tables
`experiments` / `experiment_assignments` / `experiment_subjects`, panel at
`/admin/growth/experiments`), with three changes to how it is used:

1. **Assign by workspace id, not cookie.** Call `getExperimentVariant('free_action_cap',
   workspace.id)` at workspace creation so 100% of new workspaces are in (the homepage
   video experiment only caught ~36% of signups via cookie). Existing workspaces get no
   assignment and fall through to the published default from 10-01.
2. **Never give less than published.** Publish 150. The test arm silently gets 500 as a
   bonus above the published number. The dashboard usage page and the 80%/100% emails
   must show each workspace its own actual allowance (`/api/usage` reads the cap from
   `plans.ts` today; it needs to read the arm).
3. **Edge function reads the arm.** `actionLimitResponse` looks up
   `experiment_assignments` for the workspace (service role, one indexed read, cached per
   isolate) and substitutes the cap. Kill switch stays: concluding the experiment with a
   winner makes every workspace use that number.

**Power, honestly.** ~60 signups per arm per week. Decisions per week: ~7 in the 150 arm,
~3 in the 500 arm; at 5-10% close that is 0.4-0.7 vs 0.2-0.3 sales per week. Over 8
weeks the revenue difference is 3-6 sales vs 1-2, which is a direction, not a p-value.
What the test CAN settle in 8 weeks (~500 per arm) is the guardrail: a 9-10 point drop
in 14-day retention or activation in the 150 arm would be detectable. So the decision
rule is: fix a stop date (1 December), and keep 150 unless retention in the 150 arm is
worse by more than the sales it added are worth. Do not peek for p<0.05.

## 8. Emails and the admin overview

- **80% email** from the reservation path in `actionLimitResponse`: when a successful
  reservation takes a workspace across 80% of its allowance for the first time in the
  window, write a `usage_notifications` row (workspace, window start, kind) and hand
  `system-notify` a new `usage.warning_80` event, delivered over Resend like the six
  billing lifecycle events. **100% email** hooks the existing once-per-period
  `paywall_reached` write in `record_usage_limit_event`, event `usage.limit_reached`.
  Both are transactional and automated; dedupe is per workspace per billing window.
- **Copy:** numbers first (used, allowance, reset date), what stops and what does not
  (`inbox_list` and the dashboard keep working, automations pause visibly), and the $5
  upgrade link with the paywall offer carried through. Same declarative rule as the
  in-chat refusal text.
- **Admin overview** as a new tab on `/admin/growth`: per arm, workspaces in grace, at
  50-80%, at 80%+, capped this month; emails sent by kind; capped -> pricing_viewed ->
  checkout_started -> paid; 7-day retention of capped vs uncapped in the same cohort;
  automation pauses; and a list of capped workspaces (domain, allowance, used, last
  seen) for manual follow-up. Reads `action_usage`, `usage_limit_events`,
  `usage_notifications`, `product_funnel_events`, `experiment_assignments`.
