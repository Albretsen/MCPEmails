# Research: would a 500 action/month cap on Free help or hurt?

Question asked 2026-09-09. All production figures re-verified that day against prod with
`npx supabase db query --linked`. Every "external" figure excludes `@mcpemails.*`,
`bjellanda*`, `@example.com` and the `internal_accounts` table.

This document answers a narrower question than `docs/PLAN-monetize-action-volume.md`
(2026-09-07), which recommended 1,000/month and left 500 open. It does not re-argue the
design (an allowance on Free only, routed to Personal at $5, paid tiers unlimited). It only
asks whether **500** is the right number, and what it costs in adoption.

---

## 0. Answer

**Direction right, number mis-shaped.** 500/month would produce roughly 3.5x the monetizable
decisions that 1,000 would, at roughly 3x the lockout damage, for an expected gain of about
**$15 to $30 of added MRR per month**. On a $75/mo base that is material, and the adoption
risk in absolute users is small: it walls 14% of activated users, not 60%.

But the binding problem is not the size of the cap. It is the **shape**. The median workspace
that reaches 500 billable actions does so **2.4 days after signup**, and 26% of them reach it
within 24 hours. A calendar-month cap crossed on day 2 means 28 days with the product turned
off, during the evaluation window, before the user has decided whether it is any good. At
1,000 the median is 7.0 days and **nobody** has ever crossed it inside 24 hours.

Recommendation: **do not ship a bare 500/month cap.** Ship either

- **1,000/month** as the 09-07 plan already recommends, or
- **500/month with a ~50/day sub-cap**, which extracts the same pressure from sustained heavy
  users while making day-1 lockout structurally impossible. This is what every competitor with
  a working free tier does (anymailmcp 15/day, AgentMail 100/day).

The second is the higher-revenue option and is defensible. The bare 500/month is the one to
avoid.

---

## 1. What the cap would actually touch

### 1.1 Distribution, 30-day billable actions, external free workspaces (n = 405)

| Bucket | Workspaces | 0 inboxes | 1 inbox | 2+ inboxes | Actions |
|---|---:|---:|---:|---:|---:|
| 0 | 212 | 132 | 78 | 2 | 0 |
| 1-49 | 105 | 5 | 95 | 5 | 1,836 |
| 50-99 | 27 | 0 | 24 | 3 | 2,009 |
| 100-249 | 21 | 0 | 17 | 4 | 3,721 |
| 250-399 | 13 | 0 | 12 | 1 | 3,930 |
| 400-499 | 10 | 0 | 8 | 2 | 4,493 |
| **500-749** | **6** | 0 | 4 | 2 | 3,893 |
| **750-999** | **3** | 0 | 2 | 1 | 2,568 |
| **1,000-1,999** | **4** | 0 | 3 | 1 | 5,281 |
| **2,000+** | **4** | 0 | 4 | 0 | 11,964 |

Percentiles among the 193 active external free workspaces: p50 = 41, p75 = 189, **p90 = 478**,
p95 = 853, p99 = 3,499, max = 4,288.

**500 sits almost exactly on p90.** 1,000 sits just above p95. On 30-day actuals, 500 touches
17 workspaces and 1,000 touches 8.

### 1.2 The forward flow is the number that matters, not the stock

Clean cohort estimator: external workspaces created on or after 2026-08-04 (the ledger's first
day, so no censoring) and matured past 21 days. n = 87, of which 50 activated.

| Threshold crossed in first 21 days | Workspaces | % of signups | % of activated |
|---|---:|---:|---:|
| 250 | 13 | 14.9% | 26% |
| **500** | **7** | **8.0%** | **14%** |
| 1,000 | 2 | 2.3% | 4% |

At the current 114 signups/week (previous week 86, 328 in 30 days) that is:

- **500 → about 40 workspaces per month arriving at the wall**
- **1,000 → about 11 per month**

500 produces 3.5x the decisions. That is the whole case for it, and it is a real case.

### 1.3 Calendar-month reality check

Enforcement for Free uses the UTC calendar month. Actual ledger, external free workspaces:

| Month | Active workspaces | over 250 | over 500 | over 1,000 | Actions |
|---|---:|---:|---:|---:|---:|
| 2026-08 (full) | 119 | 20 | **11** | 3 | 19,316 |
| 2026-09 (9 days) | 148 | 19 | **8** | 3 | 21,353 |

September is running hotter than all of August at day 9. Whatever number ships, the count of
affected workspaces grows with signups, and signups are growing.

---

## 2. The case against 500 specifically

### 2.1 It fires during evaluation, not after adoption

For every external workspace that has ever reached a cumulative threshold, days from signup
(restricted to workspaces created after the ledger start, so no censoring):

| Threshold | Workspaces reached | p25 | **median** | p75 | within 24h | within 3d | within 7d |
|---|---:|---:|---:|---:|---:|---:|---:|
| 250 | 41 | 0.6d | 2.1d | 10.7d | 14 (34%) | 21 (51%) | 28 (68%) |
| **500** | **19** | **1.0d** | **2.4d** | **7.4d** | **5 (26%)** | **11 (58%)** | **14 (74%)** |
| 1,000 | 9 | 2.0d | **7.0d** | 15.5d | **0 (0%)** | 3 (33%) | 5 (56%) |

This is the single most important table in this document, and it is a qualitative difference,
not a quantitative one. **500 is reachable on day one. 1,000 is not, and never has been.**

The published guidance on free-tier design is unanimous on this failure mode: a cap that fires
before the user experiences core value produces abandonment, not conversion. Between 40% and
60% of free signups log in exactly once as it is.

### 2.2 Replaying the real ledger against each cap

Simulation over the actual August + September-to-date ledger, external free workspaces,
calendar-month windows:

| Cap | Workspace-months blocked | Distinct workspaces | Median day of month hit | Earliest | Hit by day 5 | Total workspace-days locked out |
|---|---:|---:|---:|---:|---:|---:|
| **500** | 19 | 16 | day 18 | day 2 | 5 | **291** |
| 1,000 | 6 | 6 | day 8 | day 3 | 2 | 97 |

500 produces **3x the dark days** across **2.7x the workspaces**. Those 291 workspace-days are
days on which someone's email agent simply stopped working.

### 2.3 The heavy users are the retained users

30-day usage band vs. share still active in the last 7 days, external free:

| Band | Workspaces | Still active in 7d |
|---|---:|---:|
| 0 | 212 | 0% |
| 1-249 | 153 | 71% |
| 250-500 | 23 | 83% |
| **501-1,000** | **9** | **78%** |
| **1,000+** | **8** | **100%** |

Volume monotonically predicts retention. Every workspace above 1,000 actions is still active.
The population a 500 cap walls is the population most likely to still be here next month.

### 2.4 The conversion mechanism this cap assumes has never once worked here

Every current external paying customer, usage before purchase:

| Customer | Plan | Signup to buy | Billable actions before buying |
|---|---|---:|---:|
| jus***@company-10.invalid | Personal | 40.9d | 847 |
| pho***@company-09.invalid | Personal | 0.1d | 166 |
| kir***@company-12.invalid | Personal | 0.2d | 150 |
| dam***@company-08.invalid | Pro | 10.2d | 42 |
| cat***@gmail.com | Personal | 0.0d | 17 |
| moh***@yahoo.com | Pro | 0.1d | 16 |
| cla***@company-04.invalid | Personal | 0.0d | 4 |
| dar***@gmail.com | Personal | 0.0d | 3 |
| fin***@company-07.invalid | Pro | 0.0d | 2 |
| maz***@me.com | Personal | 0.0d | 0 |

**Six of ten bought within hours of signing up. Nine of ten bought with fewer than 850
lifetime actions.** Exactly **one of nine** ever exceeded 500 billable actions in a calendar
month before purchasing; **zero** ever exceeded 1,000.

Revenue at MCPEmails has come from day-zero intent on business domains, not from volume
pressure. A 500 cap would have been irrelevant to 9 of the 10 customers who exist. That does
not make it worthless (it is aimed at a segment that has never been asked), but it does mean
the 10-20% conversion assumption in the 09-07 plan is an assumption with no local evidence
behind it, in either direction.

### 2.5 Half the metered volume is the agent orienting itself, not extracting value

Tool mix, external free, 30 days (46k calls, 39.7k billable):

| Tool | Calls | Share | Workspaces |
|---|---:|---:|---:|
| `email_search` | 10,423 | 22.7% | 155 |
| `triage_move` | 6,395 | 13.9% | **9** |
| `inbox_list` (free) | 6,282 | 13.7% | 196 |
| `email_list` | 5,685 | 12.4% | 152 |
| `email_read` | 2,864 | 6.2% | 140 |
| `email_send` | 2,216 | 4.8% | 58 |

`email_search` + `email_list` + `email_read` is **49% of billable free volume**. Those are the
calls an agent makes to answer "what is in my inbox", before anything the user would call a
result happens. Observed intensity, external free, 30 days:

- median **7.2 billable actions per session** (30-minute gap definition), p90 **39.5**
- median 12.7 actions per active day, p90 75.3
- 16 workspaces have had a single day over 250 actions; 3 have had a single day over 500

Independent benchmark: a single Claude conversation now averages 8-15 tool calls. Our 7.2
billable plus ~30% non-billable `inbox_list` lands squarely in that band, so the meter is
measuring the same thing the ecosystem measures.

**At 500/month a p90 user gets about 12 sessions before the wall.** That is not a month of
product, it is a fortnight of light use.

### 2.6 Automations breach 500 with no human in the loop

`triage_move` is 6,395 actions from **9 workspaces**, an average of 710 each. These are
unattended recurring rules. Every one of those 9 breaches a 500 cap on automation alone, with
no agent session present to receive the `isError` refusal text. The user's experience is that
mail silently stops being triaged. The 09-07 plan already flags automation suspension as the
largest piece of new work and a prerequisite for touching existing users; a 500 cap makes it a
prerequisite for touching **new** users too, because the breach arrives inside the first month.

---

## 3. The case for 500 (stated fairly)

1. **It produces 3.5x the decisions.** ~40 workspaces/month at the wall versus ~11. Nothing
   else in the current growth stack creates that many qualified upgrade moments.
2. **It is still generous against the direct competitor.** anymailmcp's free tier is
   1 mailbox and **150 calls/month** (15/day, 45/week). 500/month is 3.3x that.
3. **By published freemium benchmarks, both numbers are loose.** The standard guidance is that
   20-40% of your target market should be satisfied by free, and above 50% means you are too
   generous. At 500, ~91% of *active* free workspaces are still untouched (17 of 193); at 1,000, ~96% are (8 of 193).
   Neither is close to the benchmark. If anything this argues 500 is the conservative choice
   and 250 is the benchmark-aligned one.
4. **Free users above 500 are behaving exactly like paying customers.** 3 of 7 Personal
   subscribers and 2 of 3 Team subscribers exceed 500 actions/30d. A free workspace at 600 is
   not an outlier, it is a customer who has not been asked. That is a good targeting signal.
5. **Cost is not the argument, and admitting that clarifies the decision.** Total external free
   volume is ~46k calls/month. At Supabase edge-function economics that is well under a dollar
   of marginal infrastructure. The cap has **zero** cost-avoidance justification; it is purely a
   conversion instrument, so it should be judged purely on conversion and churn.

---

## 4. Competitive calibration

| Product | Free tier volume | Daily sub-cap | Paid entry |
|---|---|---|---|
| Zapier MCP | ~50 actions/mo (100 tasks, 2/action) | no | ~$29.99/mo |
| anymailmcp | 150 calls/mo, 1 mailbox | **15/day** | EUR 4.99 (5 mailboxes, unlimited calls) |
| **MCPEmails at 500** | **500 actions/mo, 1 inbox** | **none** | **$5 (3 inboxes, unlimited)** |
| **MCPEmails at 1,000** | 1,000 actions/mo, 1 inbox | none | $5 |
| AgentMail | **3,000 emails/mo, 3 inboxes** | **100/day** | $20/mo |
| Composio | 20k-100k tool calls/mo | no | $29/mo |
| MCPEmails today | effectively unlimited (5,000 silent) | none | $5 |

Two things fall out of this table.

**First, both of the caps under discussion are competitively defensible.** 500 beats
anymailmcp by 3.3x; 1,000 by 6.7x. Neither makes MCPEmails the stingy option in the category.

**Second, and more useful: every competitor whose free tier works day to day pairs the monthly
number with a daily one.** anymailmcp gives 15 every day; AgentMail gives 100 every day. Under
either, a user can never lose the product for the rest of the month because of one busy
afternoon. Under a bare 500/month, that is not just possible, it is the median outcome (day
2.4). The competitor with the *smallest* free tier in the table has the *better-shaped* one.

`plans.ts:82` already declares `maxDailyBurstCalls` on every tier. It is `Infinity` everywhere
and enforced nowhere. The field exists; the enforcement does not.

---

## 5. The money, honestly

Inputs, all observed rather than assumed:

- signups: 114 in the last 7 days, 86 the week before, 328 in 30 days, trending up
- cohort crossing rate in the first 21 days: 8.0% at 500, 2.3% at 1,000
- realistic ARPU for whatever this converts: **$5** (7 of 10 existing customers bought Personal)
- conversion rate of a wall-hit: **unknown locally.** No workspace has ever hit any cap
  (`usage_limit_events` has 0 rows, ever). The 09-07 plan's 10-20% is a guess.

| | 500/month | 1,000/month |
|---|---:|---:|
| Workspaces reaching the wall per month | ~40 | ~11 |
| New MRR/month at 10% conversion | $20 | $5.50 |
| New MRR/month at 20% conversion | $40 | $11 |
| Workspace-days of lockout per month (from §2.2) | ~145 | ~48 |
| Share of *activated* users walled | 14% | 4% |

**The entire dispute between 500 and 1,000 is worth about $15 to $30 of added MRR per month.**
On a $75/mo base that is a 20% to 40% monthly growth contribution, which is genuinely
significant in relative terms and rounding error in absolute ones. It is not enough money to
justify accepting a day-2 wall; it is easily enough to justify building a daily sub-cap so the
day-2 wall cannot happen.

---

## 6. Recommendation

**Ship 500/month only with a daily sub-cap. Otherwise ship 1,000/month.**

A 500/month allowance with a ~50/day sub-cap:

- keeps the 3.5x decision volume that makes 500 attractive
- makes day-1 and day-2 lockout arithmetically impossible: the fastest a user can exhaust the
  month becomes 10 days, not 2, and any single day of overuse costs them that day only
- still lets a genuinely heavy user (p90 = 39.5 actions/session) run one full session per day
  every day of the month
- matches the shape both surviving competitors use
- costs one extra window in `reserve_action_usage`, against a field (`maxDailyBurstCalls`) that
  already exists in the plan model

If the daily sub-cap is not worth the work right now, take 1,000 as the 09-07 plan recommends,
and revisit at Stage 4 with real conversion data. The one option to avoid is the bare
500/month cap, which buys about $15/month of expected MRR by turning the product off for its
best-retained users a day and a half after they sign up.

Nothing in this document changes the 09-07 plan's blockers. `checkout-core.ts:400` is still a
hard prerequisite, automation suspension is still the largest new work, and a 500 cap makes
both of them **more** urgent, not less, because they now bite inside a new user's first week.

---

## Sources

Production: `action_usage` (135,196 rows, 103,834 billable, ledger from 2026-08-03),
`workspaces`, `user_billing`, `inboxes`, `internal_accounts`. Queries in
`docs/PLAN-monetize-action-volume.md` appendix style; all aggregated in SQL because PostgREST
truncates row-returning selects at 1,000 rows silently.

External:
- [anymailmcp pricing](https://anymailmcp.com/) (free 15/day, 45/week, 150/month, 1 mailbox)
- [AgentMail pricing](https://www.agentmail.to/pricing) (free 3 inboxes, 3,000 emails/mo, 100/day)
- [Composio pricing](https://composio.dev/pricing)
- [Zapier MCP pricing and limits](https://smesoftwarehelp.co.uk/blog/zapier-mcp-for-small-business/)
- [Freemium model design: free tier limits](https://resources.rework.com/libraries/saas-growth/freemium-model-design)
- [Freemium conversion benchmarks 2026](https://www.artisangrowthstrategies.com/blog/freemium-conversion-rate-benchmarks)
- [The freemium trap: 23 SaaS tools killed free plans in Q1 2026](https://www.getpricepulse.com/blog/the-freemium-trap.html)
- [MCP rate limits: a practical guide for agent builders](https://peliqan.io/blog/mcp-rate-limits-guide/) (8-15 tool calls per conversation)
- [The activation gap](https://atticusli.com/blog/posts/activation-gap-saas-users-aha-moment/)
