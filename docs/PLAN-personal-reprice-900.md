# Personal $5 → $9 for new customers (2026-09-29)

## Decision

| | Before | After |
|---|---|---|
| Personal monthly | $5 | **$9** |
| Personal yearly | $48 | **$86.40** (12 × $9 less exactly 20%; $7.20 a month) |
| Existing subscribers | | **unchanged**: stay on the $5 / $48 Stripe prices. No migration, no proration, no email. |

Why $9 rather than $8:

- **Per-inbox rate.** $9 is $3.00 an inbox. That is still under both mailbox-count competitors: MailMCP at €2.99 (about $3.50) and Mailbox MCP at £2.92 (about $3.90). The $1.67 we charged left money on the table without winning anything on price.
- **Break-even is forgiving.** At $9, revenue from Personal only falls if Personal conversion drops by more than 44% (1 − 5/9). At $8 the threshold is 37.5%. Buyers are multi-mailbox operators who pay within 11 to 45 minutes, so they are not the price-shopping segment.
- **The ladder still reads.** $9 → $15 means "$6 more for unlimited inboxes", which makes Pro an easier step up from Personal than it was at $5 → $15.
- **Why not whole-dollar annual.** Exactly 20% off a whole-dollar yearly price needs a monthly price that is a multiple of $5, so neither $8 nor $9 can give one. $86.40 keeps the discount exact. $86 would read as 20% but actually be 20.4%.

## Status

**Live since 2026-09-29 17:02 UTC**: PR #32 merged at 16:56:41Z; `main` at `1814c18e` passed CI at 17:02:02Z and was promoted. Stripe: $9/mo `price_1UL49dARrgumc6cqFzJnFjEg`, $86.40/yr `price_1UL4E6ARrgumc6cqRbXQVofW` (retired, still billing: $5 `price_1U9jknARrgumc6cqEoJX6o7d`, $48 `price_1U9jksARrgumc6cqKmbeMHcC`). First full read-out: **2026-11-10** (cutover + 28-day cohort + 14-day window).

## Test design: cutover plus before/after, not an A/B

The A/B system (`experiments` / `experiment_assignments`) is the wrong tool for this change, for two reasons.

1. **Sample size.** At our volume a price A/B cannot finish:

   | What we want to detect (α = 0.05, 80% power) | Paywall workspaces needed | Time at ~266 a month |
   |---|---|---|
   | 30% relative drop in Personal conversion (7.5% → 5.25%) | ~3,700 (1,850 per arm) | ~14 months |
   | Only the 44% break-even drop (7.5% → 4.2%) | ~1,600 (790 per arm) | ~6 months |

2. **A price is not a private variant.** The price is public in many places the experiment cannot branch: the /pricing page (CDN-cached, the same for everyone), JSON-LD, llms.txt, 13 blog posts in 5 locales, the comparison page, the directory listings, and the refusal message the MCP server returns to an agent. A split would show the same person $5 in one place and $9 in another, which is a trust problem, not only a measurement problem.

So the design is a straight cutover, read as a before/after comparison with fixed rules written down before any data arrives. The rules and the query below are that pre-registration. Pro's price does not change, so Pro's conversion serves as a control for traffic drift.

## Read-out

Query: `docs/sql/personal-reprice-readout.sql`. It is read-only; run it once, never in parallel with another production query.

- **Unit.** A workspace, assigned to a cohort by its **first** `paywall_reached` event. Before = the 28 days before the cutover; after = the 28 days from the cutover. Internal accounts are excluded with `growth_is_internal_email`.
- **Window.** Each workspace gets exactly 14 days after its first paywall to start and complete a checkout. A cohort is only read after its window has closed. The first full read is therefore **cutover + 42 days**.
- **Metrics.**
  1. `pct_start_personal`: share of paywall workspaces that started a Personal checkout (price shock shows up here).
  2. `pct_complete_personal`: completed Personal ÷ started Personal (sticker shock at Stripe's page shows up here).
  3. **Primary metric:** `new_mrr_per_paywall_workspace`. New MRR from the first sale in the window, at the price in force when it completed (annual counted as /12), divided by paywall workspaces.
  4. Control: Pro and Team completed ÷ paywall workspaces. If this moved as much as Personal did, the change is traffic, not price.
- **Baseline** (ran 2026-09-29, closed windows only, internal accounts excluded): 119 paywall workspaces, 10 started Personal, 5 paid Personal, 10 paid anything, $96.00 new MRR, **$0.807 per paywall workspace**.

### Decision rule (fixed now)

- **Keep $9** if new MRR per paywall workspace is at or above baseline.
- **Revert to $5** only if both of the following hold: Personal paid conversion fell by more than the 44% break-even, **and** new MRR per paywall workspace fell while the Pro/Team control did not.
- **Otherwise, extend.** Add another 28-day window to both cohorts and read again. With roughly 5 to 10 Personal sales per window, only a drop larger than about 60% is distinguishable from noise in one window. Say so when reporting; don't round a coin-flip up to a result.

### Known confounders

- The **Google Ads test** (`docs/PLAN-google-ads-test-20260929.md`) is due to start around 2026-10-01, inside the "after" window only. The read-out query excludes `acquisition_source = 'google_ads'` workspaces, so both cohorts stay organic and paid traffic can't masquerade as a price effect.
- The **business-domain paywall change (PR #33)** merged on 2026-09-29, the same day as this change. Read both halves split by `workspaces.acquisition_email_segment`: consumer domains isolate the price effect.
- ChatGPT or directory listing changes have moved sales in bursts before (09-13..16). Check `growth_client_mix` / `mcp_client_capabilities` for a spike in either window.

## What changed in code

- `plans.ts`: Personal is 900 / 8640 cents, sold from the new `STRIPE_PRICE_PERSONAL_MONTHLY_V2` / `STRIPE_PRICE_PERSONAL_YEARLY_V2`. The existing unsuffixed pair now holds the **retired** $5 / $48 IDs and is read as Personal's legacy pair (positional: monthly, then yearly). An unset `_V2` never falls back to $5.
- `checkout-core.ts`: a subscriber on a retired price who asks for the same plan and interval gets `already_on_plan_interval` and is never quoted onto $9. Interval and tier changes still work, quoted at the current price.
- Pricing, home and dashboard fallbacks now derive from `PLANS`. They previously still quoted Pro at $29. Per-month amounts are formatted from cents, so $86.40 a year shows as $7.20, not "$7".
- `personal-price-copy.test.ts` extracts every currency amount from all 5 locales, the blog, llms.txt, the README, our side of the comparison page, and the edge function's cap message, and fails on any amount the catalogue does not sell. The next reprice fails CI until the copy follows.
