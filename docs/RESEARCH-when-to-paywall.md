# Research: is the paywall hitting too early?

Question asked 2026-09-09. All production figures verified that day against prod with
`npx supabase db query --linked`. Every "external" figure excludes `@mcpemails.*`,
`bjellanda*`, `@example.com` and the `internal_accounts` table.

Companion to `docs/RESEARCH-500-action-cap.md` (same day), which asks what a *second*
paywall should look like. This one asks whether the paywall we already have is in the
right place.

---

## 0. Answer

**Yes in clock time. No in damage. And that is the wrong worry.**

The only live paywall is the one-inbox cap on Free. It fires a median of **42 seconds**
after the user connects their first mailbox, and **before the first tool call in 51 of
97 cases**. By any normal freemium rule that is far too early.

But it is not hurting anyone measurably. Against the same-era cohort, walled workspaces
**activate more** (74.2% vs 67.3%), **retain more** (71.0% vs 57.7%), and **convert 3.4x
better** (6.5% vs 1.9%). Seven of the thirteen paying workspaces were walled before they
paid, and the median gap from wall to payment is **11.2 minutes**. This gate is currently
the largest single revenue mechanism in the product.

The reason early firing does not hurt is structural: **it is a gate, not a wall.** It
never takes anything away. The user keeps a fully working single-inbox product, so the
worst case is a declined request, not a dead agent. That is exactly the property the
proposed action cap does *not* have, which is why the two must be judged differently.

The real finding is the inverse of the question. **95 of 157 active free workspaces (61%)
never meet any paywall at all**, including 11 running over 500 actions a month and 6
running over 1,000. The gate is not too early. It is too narrow.

Recommendation: do not delay or widen the inbox gate. Fix the 5.1% impression-to-checkout
leak, and treat the second-inbox trial as an A/B test rather than a change.

---

## 1. What the paywall actually is

Since the 2026-08-19 repricing there is exactly one customer-facing limit:
`PLANS.free.limits.maxInboxes = 1` (`apps/web/src/lib/stripe/plans.ts`).

Everything else on Free is uncapped in practice:

| Limit | Free value | Ever hit? |
|---|---|---|
| `maxInboxes` | **1** | **182 events, 97 workspaces** |
| `maxMonthlyToolCalls` | 5,000 (silent abuse ceiling) | never, `usage_limit_events` has 0 rows |
| `maxApiKeys` | Infinity | n/a |
| `maxDailyBurstCalls` | Infinity, enforced nowhere | n/a |
| `maxRequestsPerMinute` | 60 | fair-use only |

All 182 `paywall_reached` rows carry `connection_type = 'first_connect'`, so every one is
the inbox cap. The action ceiling has never refused a single call in the product's life.

The surface is the upgrade panel in `ConnectModal.jsx`, instrumented since 2026-08-29 via
`useInboxPaywallView` -> `POST /api/analytics/paywall`. It carries a direct checkout CTA,
not just a link to `/pricing`.

---

## 2. It fires absurdly early. This part of the instinct is correct.

External workspaces that have hit the gate (n = 97):

| Measure | Value |
|---|---:|
| Median signup to wall | **10 minutes** |
| p25 / p75 signup to wall | 3 min / 33 min |
| **Median first-inbox-connect to wall** | **42 seconds** |
| Within 15 min of connecting inbox #1 | **75 of 97** |
| Within 1 hour of signup | 78 of 97 |
| Within 24 hours of signup | 91 of 97 |
| Walled **before** their first tool call | **51 of 97** |
| Walled having **never** made a tool call | 24 of 97 |

The 42-second median is the number that matters. This is not an *expansion* gate that
catches a growing user six weeks in. It is a **setup interruption**. People arrive
intending to connect several mailboxes, connect the first one, reach straight for the
second, and are shown a price before the product has done anything for them.

Fifty-one users were quoted a price before they had any evidence the thing works.

---

## 3. It is not measurably hurting anyone. This part of the instinct is wrong.

Cohort restricted to workspaces created on or after 2026-08-29, so every row lived its
whole life with the beacon running and the same gate in force.

| Cohort | n | Activated | Retained (7d) | Converted |
|---|---:|---:|---:|---:|
| **Hit the inbox gate** | 93 | **74.2%** | **71.0%** | **6.5%** |
| Connected 1 inbox, never gated | 52 | 67.3% | 57.7% | 1.9% |
| Never connected an inbox | 40 | 10.0% | 7.5% | 2.5% |

Walled users beat unwalled users on every axis, including the two the "too early" worry
predicts they would lose: activation and retention.

Splitting the walled population by whether the gate preceded their use of the product:

| Segment | n | Retained 7d | Converted | Median actions |
|---|---:|---:|---:|---:|
| A. Walled, never used the product at all | 24 | 0% | 0% | 0 |
| B. Walled **before** first tool call, used it later | 51 | **94.1%** | 9.8% | 25 |
| C. Walled **after** using the product | 22 | **100%** | 13.6% | 36 |

Segment B is the direct test. Fifty-one people were shown a price before they had used
anything, and 94% of them were still active last week. Being asked early did not stop
them; they simply carried on with one inbox.

Segment A is the loss candidate: 24 users gated at a 9-minute median who never made a
call. But 25.8% of gated users never activate, against **32.7%** of the never-gated
control. The gate is on the *better* side of that comparison.

**Caveat, stated plainly.** All of this is confounded by selection. Reaching for a second
mailbox is itself an intent signal, so gated users would be expected to out-perform even
if the gate did nothing. The honest reading is not "the gate helps" but "there is no
evidence of harm, and clear evidence of revenue."

---

## 4. What the gate is worth

Every external paying workspace, against the gate:

| | Workspaces |
|---|---:|
| Paying (external) | 13 |
| **Walled before paying** | **7** |
| Median wall to payment | **11.2 minutes** |

Seven of thirteen customers passed through this panel on their way to Stripe, and the
ones who buy do it about eleven minutes later. Whatever else is true, this is the highest
converting surface in the product and the only one that reliably produces revenue.

Conversion is strongly segmented by who is behind the address:

| Domain type | Walled | Converted |
|---|---:|---:|
| **Business domain** | 35 | **14.3%** |
| Consumer (gmail, yahoo, icloud, ...) | 62 | 4.8% |

That matches the standing pattern: revenue here comes from day-zero intent on business
domains.

---

## 5. Where it does leak

The panel is seen far more often than it is acted on.

| Step | Count | Rate |
|---|---:|---:|
| Panel impressions | 175 | |
| Distinct workspaces | 97 | |
| **Workspaces hitting it repeatedly** | **41** | 42% |
| Viewed pricing after being gated | 38 | 39% |
| **Started checkout after being gated** | **9** | **9.3% of workspaces, 5.1% of impressions** |
| Completed checkout | 8 | **89% of starts** |

Checkout itself is not the problem: 8 of 9 who start, finish. The leak is entirely
upstream. **Forty-one workspaces asked for a second inbox more than once and did not
buy.** That is repeated, explicit, unconverted demand sitting in front of a panel that
already has a one-click checkout button on it.

Weak supporting signal for the "cold ask" theory, small n, offered as such:

| Time from signup to gate | n | Converted |
|---|---:|---:|
| < 10 min | 48 | 6.3% |
| 10 to 60 min | 30 | 10.0% |
| 1 to 24 h | 13 | 0.0% |
| > 1 day | 6 | **33.3%** |

Directionally the warmer ask converts better, but n = 6 in the best bucket. This is a
hypothesis worth testing, not a finding worth shipping on.

---

## 6. The actual gap: 61% of active free users are never asked for anything

Active external free workspaces (action in the last 7 days): **157**. Of those, **95 have
never hit any paywall**, because they run one inbox and the action ceiling is unreachable.

| 30-day billable actions | Workspaces | Avg active days | Total actions |
|---|---:|---:|---:|
| 0 | 6 | 1.7 | 0 |
| 1 to 49 | 37 | 4.6 | 781 |
| 50 to 249 | 28 | 10.1 | 3,386 |
| 250 to 499 | 13 | 16.6 | 4,425 |
| **500 to 999** | **5** | 16.2 | 3,674 |
| **1,000+** | **6** | 14.5 | **13,981** |

Eleven active workspaces run 500+ actions a month and are never asked for a cent. Six of
them run 1,000+, averaging 2,330 actions each across 14.5 active days. Thirteen more are
grandfathered into unlimited inboxes and can never meet the inbox gate at all.

The one-inbox gate can only ever reach people who want a second mailbox. Everyone who is
happy with one, however heavily they use it, is outside its reach permanently. That is the
population `RESEARCH-500-action-cap.md` is about, and it is the real answer to "when
should a user be paywalled": **at a second point that the current gate structurally cannot
see.**

---

## 7. Is the offer the right size?

Inboxes actually in use, by plan:

| Plan | Workspaces | Avg inboxes | Max | Over 3 inboxes |
|---|---:|---:|---:|---:|
| Free (active) | 157 | 1.17 | 7 (grandfathered) | 5 |
| **Personal** ($5, cap 3) | 7 | **2.43** | 3 | 0 |
| **Pro** ($15, unlimited) | 3 | **6.67** | 9 | 3 |
| Team ($79, unlimited) | 3 | 1.33 | 3 | 0 |

Personal buyers sit at 2.43 of their 3 allowed inboxes, so the cap is snug but not
binding, and the ladder to Pro at 6.67 is real rather than theoretical. `inboxCapOffer`
routing every gated Free workspace to Personal is defensible: nobody has yet hit the
Personal cap and churned upward. No change indicated.

---

## 8. Recommendation

**1. Do not raise Free to two inboxes, and do not delay the gate.** It produces 7 of 13
customers with an 11-minute median close. Giving away the second inbox defers exactly the
buyers who currently convert fastest, in exchange for a warmer ask that the data supports
only at n = 6.

**2. Work the leak, not the timing.** Forty-one workspaces asked twice or more and did not
buy; only 39% ever reached pricing; 89% of those who start checkout finish. Everything
worth winning is between the impression and the click. Concretely: the second and third
impression should not be the identical first-impression panel, and a gated user who
returns days later is a different person from one gated 42 seconds in.

**3. Test the second-inbox trial as an experiment, not as a change.** "Connect it now, it
works for N days, then choose" is the one intervention that addresses the genuine problem
in section 2 (51 people quoted a price with zero evidence). The downside is real and
specific: it defers the 11-minute closers. The A/B system shipped 2026-09-03 already
supports running this at 50/50 on new free workspaces, and this is exactly the kind of
decision it was built for. Do not ship it as a blanket change.

**4. The priority is the second paywall, not this one.** 61% of active free users, and
every one of the 11 heavy ones, are permanently outside the only gate that exists. That is
worth more than any refinement of the inbox panel. Ship it in the shape
`RESEARCH-500-action-cap.md` recommends (1,000/month, or 500/month with a ~50/day
sub-cap), and note that its argument about lockout timing does **not** transfer from this
gate: the inbox gate is early and harmless because it withholds, while an action cap is
late and dangerous because it revokes.

---

## Sources

Production: `product_funnel_events` (182 `paywall_reached` rows, beacon live 2026-08-29),
`workspaces`, `users`, `inboxes`, `action_usage`, `user_billing`,
`user_usage_entitlements`, `internal_accounts`. All aggregated in SQL, because PostgREST
truncates row-returning selects at 1,000 rows silently.

Code: `apps/web/src/lib/stripe/plans.ts`, `apps/web/src/lib/plans/check-inbox-limit.ts`,
`apps/web/src/lib/analytics/billing-funnel.ts`,
`apps/web/src/lib/analytics/use-inbox-paywall.mjs`,
`apps/web/components/dashboard/ConnectModal.jsx`.

Related: `docs/RESEARCH-500-action-cap.md`, `docs/PLAN-monetize-action-volume.md`.
