# Paywall to checkout audit

Written 2026-09-09. Scope: the inbox-cap paywall, the paywall to pricing handoff,
and the pricing to checkout click. No code was changed.

## Headline

**The funnel is not broken. Two quiet days are two quiet days.**

The 42-hour hole is inside normal variance for this funnel at this volume, and
every mechanism that could have swallowed a click has been ruled out by
construction rather than by assumption. The most important question the brief
asked (did the click handler throw before the POST?) has a definitive answer:
**it cannot, because there is no click handler and no POST.** Both paywall CTAs
are plain `<a href>` elements pointing at a GET route, and for every one of the
22 workspaces paywalled on 09-08 and 09-09, every server-side branch that could
refuse them writes a funnel row before returning. Zero rows therefore means zero
clicks, not a swallowed click.

That said, the walk from the wall to the card form does have real defects. They
did not cause this gap, and fixing them is not an emergency, but they are the
places where the money path is worse than it should be.

### Why the gap is not statistically interesting

| population | base rate | this window | P(observed) |
|---|---|---|---|
| workspaces shown the paywall, checkout started within 48h | **9 of 81 = 11.1%** all-time before 09-08, stable weekly (12.5% / 9.7% / 6.3%) | 22 distinct workspaces, 0 clicks | **7.5%** |
| pricing views followed by a checkout within 48h | **18 of 140 = 12.9%** | 11 workspaces viewed pricing, 0 clicks | **22.0%** |

Neither is significant at any conventional threshold. There is precedent in the
same table: the week of 2026-08-17 had **19 pricing views and zero checkouts**,
and the product recovered without a fix. The elevated paywall count on 09-08/09
is elevated impressions, not elevated intent: it tracks a normal signup day, and
23 impressions at an 11% click rate has an expected value of 2.4 clicks, so
observing 0 is an ordinary draw.

### The cohort was real, which is the one genuinely good sign

All 22 workspaces paywalled on 09-08/09-09 were clean, live free accounts: one
active inbox each, **17 of 22 had already made a real tool call**, all
`plan=free`, none grandfathered. This was not junk traffic being shown a price.

More encouraging: **11 of the 22 went and looked at the plans**, most within
minutes of being stopped (0, 0, 0, 1, 1, 1, 2, 3, 11, 12, 12, 20 minutes). The
paywall is doing its job as a motivator. Half the people it refuses immediately
go to find out what it costs. The loss is entirely on the far side of that jump.

---

## Verdict per hop

| hop | verdict | evidence |
|---|---|---|
| **1. The paywall itself** | **Working**, with one qualification | Fires reliably, copy is true and specific, prices the cheapest plan that clears the cap ($5 Personal for a 1-inbox cap, `inbox-cap-offer.mjs`), and 11 of 22 people it stopped went straight to the plans. Qualification: it fires very early (median ~5 min after inbox #1), and **5 of 22 had never made a single tool call** when they were shown a price. |
| **2. Paywall to pricing** | **Degraded** | The offer is thrown away at the jump. `upgrade_url` is the bare constant `'/pricing'` at every producer, carrying no plan, no interval and no return path, and `/pricing` preselects **annual** while the paywall deliberately preselects **monthly**. The person told "$5/mo" lands on a page whose Personal card reads "$4 a month, billed $48/year". |
| **3. Pricing to checkout** | **Working** | Verified end to end against production. No path found that can silently fail to produce a Stripe URL for the audited cohort. |

---

## Defects, ordered by plausible revenue cost

### D1. The offer does not survive the jump to /pricing, and the interval flips under the buyer

- **Files:** [`ConnectModal.jsx:3310`](../apps/web/components/dashboard/ConnectModal.jsx:3310) and [`Pages.jsx:1257`](../apps/web/components/dashboard/Pages.jsx:1257) (the "Compare all plans" links), [`check-inbox-limit.ts:170`](../apps/web/src/lib/plans/check-inbox-limit.ts:170) (`upgrade_url: '/pricing'`), [`PricingClient.jsx:335`](../apps/web/components/marketing/PricingClient.jsx:335) (`useState(true)`, annual preselected).
- **What a user experiences:** they are stopped mid-connect and told, precisely, "Personal takes you to three for $5 a month" with a button reading "Upgrade to Personal, $5/mo" and Monthly selected. They click "Compare all plans" instead of the buy button. They arrive at a generic four-plan marketing page with **Annual preselected**, where Personal now reads "$4 a month" with "Billed $48/year" underneath, nothing is highlighted, nothing remembers they were trying to add a mailbox, and the $5 figure they had just accepted is nowhere on the page. They have to re-make a decision they already made, against a different number and a 12-month commitment.
- **How confirmed:** read every `upgrade_url` producer (all six are the same constant string). Fetched the live production `/pricing` and confirmed the server-rendered CTAs are annual-only. Confirmed the annual default in a real browser and that toggling to Monthly correctly rewrites all three hrefs. Confirmed from the funnel that 11 of the 22 paywalled workspaces made exactly this jump within minutes and none went further.
- **Honesty about causation:** this is a **mechanism argument, not a measured loss**. The annual default has been live since 808d71d on 08-20, through weeks that converted fine, so it cannot be what changed on 09-08. I could not confirm that it stopped anyone. What I can confirm is that this is the only defect sitting on the path 11 of 22 people actually walked during the window under audit.

### D2. The sidebar upsell sells the $79/mo plan with the price never shown and no instrumentation

- **File:** [`Sidebar.jsx:221`](../apps/web/components/dashboard/Sidebar.jsx:221), `checkoutStartHref('pro', false)`.
- **What a user experiences:** a free user opens the workspace dropdown, sees a menu row reading "New workspace / Workspaces are a Team feature. Upgrade", clicks it, and lands on a Stripe hosted page for **Team at $79/month**. The price is stated nowhere in the product before Stripe. There is no interval choice, so annual is unreachable from here. Every other paid CTA in the product puts the price in the button ("Upgrade to Personal, $5/mo").
- **How confirmed:** read the component and the copy key; confirmed `pro.monthlyPriceCents = 7900` in `plans.ts:288`. Confirmed against the funnel that this surface writes no `paywall_reached` row, so its impressions and its conversion are invisible: it is not measurable today whether it sells anything or repels people.
- This is the one CTA in the product where a single click moves someone from a menu to a $79 commitment with no number in between.

### D3. The paywall reaches 23% of its audience before the product has done anything for them

- **File:** the gate itself, `showLimitPanel` at [`ConnectModal.jsx:868`](../apps/web/components/dashboard/ConnectModal.jsx:868).
- **What a user experiences:** 5 of the 22 (`09aa68fb`, `0f9ac5a6`, `1d915b77`, `7f4348de`, `d7213f59`) were shown a price 2 to 27 minutes after connecting their first inbox and **had still never made a single tool call**. They were asked to pay before the product had delivered anything.
- **How confirmed:** joined `paywall_reached` against `workspaces.analytics_first_inbox_connected_at` and `analytics_first_tool_used_at`. 12 of 22 hit the wall within 10 minutes of inbox #1, 6 of them within 1 minute.
- **Explicitly not a recommendation to change the timing.** `RESEARCH-when-to-paywall.md` and the prior finding that this timing produces 7 of 13 customers stand. This is recorded as the qualification on hop 1's verdict, not as a fix. If timing is ever revisited, this subgroup (shown a price with zero tool calls) is the segment to carve out, not the 42-second delay.

### D4. The modal's "Compare all plans" link drops the user's locale

- **File:** [`ConnectModal.jsx:3310`](../apps/web/components/dashboard/ConnectModal.jsx:3310), a plain `<a href="/pricing">`.
- **What a user experiences:** a Norwegian user at the paywall clicks "Sammenlign alle planer" and lands on the **English** `/pricing`, not `/nb/pricing`.
- **How confirmed:** the sibling surface at [`Pages.jsx:1257`](../apps/web/components/dashboard/Pages.jsx:1257) uses a locale-aware `<Link>` for the identical link and carries a comment explaining exactly why ("Locale-aware Link, unlike the checkout CTA below"). The modal did not get the same treatment. The reasoning in that comment (plain `<a>` is required only for the *checkout* href, to avoid prefetching Stripe sessions) does not apply to `/pricing`, which the comment itself says is safe to prefetch.
- Small, but it is a one-line inconsistency on the revenue path, and it is the surface a non-English buyer is most likely to be reading carefully.

### D5. Four checkout exits write no funnel row, which is why this audit was necessary

- **File:** [`checkout-core.ts`](../apps/web/src/lib/stripe/checkout-core.ts). The `recordAttempt` latch is created at line 330. Four terminal returns happen above it: `unauthenticated` (274), `invalid_plan` (285), `invalid_interval` (292), `workspace_not_found` (313).
- **What this costs:** no revenue directly, but it makes "zero `checkout_started`" permanently ambiguous. The comment on the latch states the invariant "no exit below can leave an attempt untraced". That is true, and it is also the wrong half of the function: four exits *above* it leave an attempt untraced. A user whose session lapsed between seeing the wall and clicking the button is bounced to `/login` and leaves no trace anywhere.
- **How confirmed:** read the control flow; confirmed against production that an anonymous `GET /api/stripe/checkout/start?plan=bogus&interval=month` returns `303` to `/login` and writes nothing.
- For this audit it turned out not to matter (see below: this cohort provably cannot hit any of the four), but the next time this question is asked it will cost another day.

---

## The one thing to fix first

**D1: carry the offer through the jump.** Make `upgrade_url` plan-aware and
interval-aware (`/pricing?plan=personal&interval=month`) and have `PricingClient`
honour those parameters, seeding the toggle and highlighting the card instead of
defaulting to annual for someone who arrived from a monthly quote.

Why it beats the others:

- It is **the only defect on the path people actually walked** in the window
  under audit. 11 of 22 made this exact jump, within minutes, and stopped there.
  D2 is off the main path (a dropdown menu item), D3 is explicitly out of bounds
  without new evidence, D4 affects a subset of a subset, and D5 costs diagnosis
  rather than money.
- It is the only defect where the product **contradicts itself in front of the
  buyer**. Everything else is an omission; this one shows the same person two
  different prices for the same plan, minutes apart, and asks them to reconcile
  it. The monthly default at the paywall was a deliberate decision (see the
  comment at `UpgradeIntervalChoice.jsx`) taken precisely so a $5 gesture never
  silently becomes a $48 one. `/pricing` undoes that decision for anyone who
  takes the secondary link.
- It is cheap and it is reversible, and unlike a timing change it risks nothing
  that is currently working.

Do **not** treat this as an outage response. There is no outage. If the next
week converts at the usual ~11%, that is the expected outcome with or without
this fix, and D1 should be judged over a longer window than two days.

---

## What I ruled out, so nobody repeats it

**On the gap being a break:**

- **Nobody clicked, versus the click failing.** Settled, definitively. Both paywall CTAs (`ConnectModal.jsx:3326`, `Pages.jsx:1276`) are plain `<a href>` to `GET /api/stripe/checkout/start`. There is no `onClick`, no `fetch`, no `preventDefault`, and therefore nothing that can throw before a request is made. The only client-side checkout path in the product is `handleUpgrade` in `Pages.jsx:4558` (the in-dashboard billing card), which was not the surface these users were on.
- **A silent 409 for this cohort.** Impossible. All 22 workspaces have **no `user_billing` row, no `user_usage_entitlements` row, exactly one owned workspace, and that workspace is the oldest owned one**. Every 409 branch (`comped`, `already_on_plan`, `already_on_plan_interval`, `plan_not_self_service`) requires a billing row or an entitlement. If any of them had clicked, `runCheckout` would have reached Stripe and written a success row.
- **`workspace_not_found` swallowing the attempt.** Impossible for the same reason: the resolver takes the oldest active owned workspace, which exists and matches for all 22.
- **`price_not_configured`.** Would have written a `failure` row. There are none: the last recorded failures anywhere are two `subscription_exists` rows from 08-29.
- **The checkout route being dead.** Alive. Verified in production: `plan=personal&interval=month`, `personal/year` and `solo/month` all return `303` to `/login?redirect=...` with the intent preserved and `Cache-Control: private, no-store, max-age=0`.
- **`ceb8e95` (09-07 20:47, the commit that reshaped every paywall CTA and added the interval switch).** Not the cause. A `personal_month` checkout started at **23:06 that same evening**, after it was live. The dry spell also begins before the next ConnectModal changes (`a12b586` and `ab8d0e0`, both 09-08 afternoon): paywalls with no checkouts already exist at 00:46, 02:07, 07:18, 08:05 and 09:45 on 09-08.
- **`e8bef0c`.** Confirmed the brief's finding: landed 09-09 16:28, after the gap had started.
- **The interval toggle resetting or failing to rewrite the CTA.** Verified in a real browser on production `/pricing`: clicking Monthly correctly rewrites all three buy hrefs from `interval=year` to `interval=month`.
- **The deployed bundle differing from the repo.** The live `/pricing` HTML emits exactly the hrefs the source produces.
- **`personal_month` being rejected by the funnel's category CHECK constraint.** It is allowed; migration `20260827100000_add_personal_plan.sql:57` added `personal_month` and `personal_year`. (Worth recording because the original `20260813100000` constraint does **not** contain them, and every inbox-cap checkout targets `personal`, so a stale constraint would have made the entire paywall invisible in the funnel.)
- **The `/api` path being locale-rewritten by the i18n proxy.** It is not. `/api/*` is absent from `MARKETING_PATHS` and falls to the Supabase session branch, which passes it through.
- **The anonymous `/signup?redirect=` fallback stranding a signed-in buyer.** It does not: `/signup` is an auth path, so `updateSession` bounces an authenticated visitor straight to the `redirect` target, which is the checkout route. A stale `user` state on the CDN-cached pricing page is therefore harmless.

**On instrumentation, so the numbers are not re-derived wrong:**

- `paywall_reached` is not deduped server-side. Row counts are roughly 2x people. Every figure in this document counts **distinct `workspace_id`**.
- `pricing_viewed` records **signed-in users only**; anonymous `/pricing` traffic is deliberately not in this table. The 7 to 11 daily "pricing views" are all logged-in users.
- The Inboxes-page cap notice deliberately fires **no** paywall beacon, so `paywall_reached` undercounts total impressions of the offer. This is intentional and documented at `Pages.jsx:1193`.
- `inboxes.status` is `active`, never `connected`. A predicate on `'connected'` returns zero for every healthy inbox in the database and will make an entire cohort look broken.

## What I could not do

I did not drive the authenticated paywall in a browser. Signing in requires
entering credentials and creating a test account requires creating an account,
neither of which I perform. Everything above about the authenticated surfaces is
established from the source, from production HTTP behaviour on the unauthenticated
half of each route, and from the production database, and I have flagged the one
place (D1's causal claim) where that leaves a hypothesis rather than a finding.

A single manual walk of the signed-in flow, on a free account with one inbox,
clicking both "Compare all plans" links and both buy buttons at both interval
settings, would confirm or kill D1 and D4 in about five minutes.
