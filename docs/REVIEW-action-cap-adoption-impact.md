# Review: what a 500/month + 50/day cap does to adoption and growth

Written 2026-09-09 at Asgeir's request, after he accepted 500/50 in principle.
All figures measured against prod that day, external free workspaces only
(excludes `@mcpemails.*`, `bjellanda*`, `@example.com`, `internal_accounts`).

Companion to `docs/RESEARCH-500-action-cap.md` and
`docs/RESEARCH-when-to-paywall.md`. This one asks a question neither of those
asked: what does the cap cost on the adoption and distribution side, as opposed
to what it earns.

---

## 0. Answer

**Do not ship it.** Not at 500/50, and not at any volume number.

The revenue case rested on a population that does not exist. Once each
workspace's first week is excluded, the p95 free user runs **253 actions a
month**, the single heaviest runs **801**, and **zero** workspaces sustain
1,000. Only **2 of 103** matured workspaces sustain more than 500.

Everything the earlier analysis identified as "heavy free users worth
monetising" is an **onboarding burst**, not sustained load. A volume cap
therefore cannot tax sustained use, because there is almost none. It can only
tax evaluation, and it does so hard: **22.7% of everyone who ever activates
would be locked out on day one**, and **48 of the 56** workspaces that ever hit
a 50/day cap hit it inside their first seven days.

The trade is roughly 89 workspaces per month getting a broken agent, almost all
during evaluation, in exchange for an estimated 2.8 conversions per month and
about $17 of MRR. At this stage of the product that is the wrong side of the
trade, and it is worse than it looks because of how an MCP cap is attributed
(section 5).

There is a better second lever sitting unused (section 7).

---

## 1. Sustained free usage barely exists

Censoring-corrected: 103 free workspaces with 21+ days of observed life after
their first 7 days (avg 32 days observed), projected to a 30-day rate.

| Measure | Post-grace monthly rate |
|---|---:|
| p90 | **61** |
| p95 | **253** |
| Max | **801** |
| Workspaces over 500/month | **2 of 103** |
| Workspaces over 1,000/month | **0 of 103** |

Compare the uncorrected figures the cap was designed against: 17 workspaces over
500 and 6 over 1,000. The difference is entirely first-week activity.

This is the finding that decides the question. A 500/month cap applied after a
grace window would touch two workspaces. Applied without one, it touches 17, and
the extra 15 are people still deciding whether the product works.

---

## 2. Day one is the worst-hit day

Day-1 billable actions, 181 activated external free workspaces:

| Percentile | Actions in first 24h |
|---|---:|
| p50 | 18 |
| **p75** | **47** |
| p90 | 132 |
| p95 | 284 |

**p75 of day-one usage is 47, one action under the proposed daily cap.** 41 of
181 workspaces (**22.7%**) would have been refused on their first day; 22
exceeded 100.

For a product whose activation problem is already that 40% never make a tool
call, adding a wall inside the first session is the wrong direction.

---

## 3. The daily cap is an evaluation tax, not a heavy-user tax

Of the 56 workspaces that would ever hit a 50/day cap:

| When they hit it | Workspaces |
|---|---:|
| **Within their first 7 days** | **48** |
| After day 7 | 19 |

At 100/day: 31 ever, only 8 after day 7.

The daily sub-cap was justified in `RESEARCH-500-action-cap.md` as protecting
users from day-2 monthly lockout. It does that. But it lands almost entirely on
the same people it was meant to protect, and it does so earlier.

---

## 4. What 50/day does to the working product

**It is not a sub-cap, it is the binding limit.** Every workspace that blows
500/month also has a day over 50, so the combined rule hits exactly the
daily-cap population: 57 workspaces, against 17 for the monthly rule alone.

**It sits below normal daily usage.** Across 1,171 active workspace-days:
p50 = 9, p75 = 27, **p90 = 73**, p95 = 115, p99 = 374. 50/day sits between p75
and p90 and refuses **14.5% of all active days** and **52% of every billable
action free users take**. 100/day refuses 6.1% of days and 38% of actions.

**It is roughly one session.** Median session is 7.2 billable actions, p90 39.5.
A p90 user gets **one conversation per day**. A single minute of agent work has
reached 68 actions (`email_search`) and 66 (`email_attachment`); one such minute
exhausts the day.

**It breaks automations.** 9 free workspaces run unattended triage. **40.3% of
their automation-days exceed 50 actions on automation alone**, and 5 of the 9
would be capped by their own rules before the human types anything. Unattended
triage is a differentiator we market; on Free it would stop working.

---

## 5. An MCP cap is attributed differently from a web paywall

This is qualitative and it is the reason the numbers above understate the cost.

In a web SaaS, a limit renders as a page with a price and a button. The user
knows they hit a plan boundary. In an MCP server, a limit renders as a tool
returning `isError` in the middle of somebody's conversation with Claude. What
the user experiences is **"the email tool stopped working"**, and attribution
goes to the server's reliability, not to a plan choice.

That distinction matters here specifically because distribution runs through
directories that grade and review servers: Glama grading, Smithery, Docker, the
MCP registry, the Claude Directory, and 77 live connect pages. A reviewer or an
automated grader that trips a cap does not record "generous free tier"; it
records a server that failed mid-task.

**One live dependency worth naming:** `directory-review@mcpemails.com` is on the
**free** plan with a peak day of **182 actions**, 3.6x over a 50/day cap. It
survives only because `actionLimitResponse` checks the `comped_scale`
entitlement before the ceiling. Any future reviewer or grader account created
without that entitlement gets a broken server. `demo@mcpemails.com` is on Team
and is unaffected.

---

## 6. Competitive and marketing position

| Product | Free monthly | Free daily |
|---|---|---|
| anymailmcp | 150 | 15/day |
| **MCPEmails proposed** | **500** | **50/day** |
| AgentMail | 3,000 | 100/day |
| Composio | 20k-100k | none |
| **MCPEmails today** | effectively unlimited | none |

We stay 3.3x better than anymailmcp on both axes and remain defensible. But we
move from "the most generous free tier in the category" to the middle of it,
at exactly the moment the growth plan is directory listings and comparison
pages, including our own `/email-mcp-servers-compared`.

The public plan table in `README.md` (lines 175-177) has no actions row today.
Adding one is required disclosure, and it is the first thing a directory visitor
reads.

Nothing currently promises unlimited actions in customer-facing copy, so there
is no broken promise. `PLANS.free.features` lists inboxes, providers, API keys,
single user, community support. That is the one piece of good news here: the cap
is shippable without retracting a claim.

---

## 7. The lever that is actually sitting unused

`PLANS.personal.features` and `PLANS.solo.features` both advertise **"Scheduled
sends and approvals"** as a paid benefit. `PLANS.free.features` does not.

**Nothing enforces it.** The edge function never consults the plan except for the
action ceiling; `triage-engine.ts` contains no plan check at all. Free workspaces
today get scheduled sends, approvals, and unattended automations, all marketed
as paid features, and 9 of them are actively using automations.

That is a better paywall dimension than volume for three reasons:

1. It is a **capability**, not a meter, so it never breaks a working agent
   mid-task and never produces the attribution problem in section 5.
2. It is **already written on the pricing page**, so enforcing it retracts
   nothing and surprises nobody who read the plan table.
3. It targets **sustained, committed use** by construction. Someone who has set
   up a recurring rule has finished evaluating and has told you what they want.

I have not sized this. It deserves the same treatment the action cap got before
anything is built, and the 9 automation workspaces are a small enough population
that grandfathering them is cheap.

---

## 8. If a volume cap ships anyway

Ranked, best to worst:

1. **500/month, first 7 days uncounted, no daily sub-cap.** Removes the day-one
   lockout and the 52% action tax entirely. Honest disclosure, near-zero
   adoption damage, and near-zero revenue: it would touch 2 workspaces. Ship
   this if the goal is a defensible published limit rather than money.
2. **500/month + 100/day + 7-day grace.** 100/day sits just under p95 and
   refuses 6.1% of days instead of 14.5%; the grace window cuts daily-cap hits
   from 56 workspaces to 8.
3. **1,000/month flat.** What the earlier research recommended. Median
   time-to-lockout 7 days, nobody has ever crossed it in 24 hours.
4. **500/month + 50/day.** The version reviewed here. Do not ship it.

Whatever ships, automations must be excluded from the daily window or given
visible suspension. A silently stopped triage rule is the worst outcome
available and is worse than shipping nothing.

---

## Sources

Production: `action_usage` (billable rows, ledger from 2026-08-03), `workspaces`,
`users`, `user_usage_entitlements`, `workspace_usage_exemptions`,
`product_funnel_events`, `internal_accounts`. Aggregated in SQL throughout:
PostgREST truncates row-returning selects at 1,000 rows silently.

Code: `supabase/functions/mcp-server/index.ts` (`actionLimitResponse`,
`BILLABLE_TOOL_NAMES`, `SHADOW_ACTION_CAPS`),
`supabase/functions/mcp-server/triage-engine.ts`,
`apps/web/src/lib/stripe/plans.ts`, `README.md`.
