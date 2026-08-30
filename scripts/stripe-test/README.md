# Testing the Stripe purchase flow

## The short answer

Test in **Stripe test mode, against the local Supabase, with `stripe listen`
forwarding webhooks**. Do not test purchases against production, and do not test
them in live mode.

Two reasons, and the first is the one that bites:

1. **`apps/web/.env.local` points at the production database.**
   `NEXT_PUBLIC_SUPABASE_URL` is `swvaxorwumispmjaaszb.supabase.co`. Running
   `npm run dev` as-is and buying a plan writes a fake subscription onto a real
   workspace and fake rows into `product_funnel_events`, the same table the
   growth analysis reads. `scripts/stripe-test/env.sh` exists to prevent that;
   real environment variables beat `.env.local`, so sourcing it is sufficient.

2. **Live mode cannot be exercised without moving real money.** A live checkout
   needs a real card and produces a real charge, a real invoice, and real tax
   consequences. What live mode *can* be checked for, safely and read-only, is
   configuration drift, which is the separate audit at the bottom of this file.

Until 2026-08-23 the test-mode catalogue still held the pre-repricing amounts
($12/$49, `tax_behavior=unspecified`), so any test against it validated code
paths but not the actual pricing. It now mirrors live exactly.

## Setup

```bash
npx supabase start
source scripts/stripe-test/env.sh
```

In a second terminal, start the webhook forwarder. It mints a fresh signing
secret per session:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Copy the `whsec_...` it prints into the first terminal, then start the app:

```bash
export STRIPE_WEBHOOK_SECRET=whsec_...
npm run dev
```

Seed a buyer. The account is deliberately created without a
`user_usage_entitlements` row, so it is capped at 1 inbox exactly like a real
post-repricing signup:

```bash
./scripts/stripe-test/seed-user.sh
```

Capture the state after each case:

```bash
./scripts/stripe-test/report.sh "case-1-pro-monthly"
```

## Test cards

| Card | Behaviour |
| --- | --- |
| `4242 4242 4242 4242` | succeeds |
| `4000 0025 0000 3155` | requires 3DS authentication |
| `4000 0000 0000 0002` | declined outright |
| `4000 0000 0000 9995` | insufficient funds |
| `4000 0000 0000 0341` | attaches fine, fails on the *next* charge |

Any future expiry, any CVC, any postcode.

## The matrix

Cases 1–8 are the flow itself. 9–12 need a Stripe **test clock** (create the
customer inside a clock, then advance it) because they depend on time passing.

| # | Case | What it proves | Expected |
| --- | --- | --- | --- |
| 1 | Free → Pro monthly, card succeeds | the happy path | `workspaces.plan='solo'`, `user_billing.subscription_status='active'`, `checkout_completed` recorded |
| 2 | Free → Pro **annual** | the annual preselect (808d71d) sends the yearly price | subscription interval `year`, amount 27600 |
| 3 | Free → Team monthly | second tier maps correctly | `plan='pro'`, amount 7900 |
| 4 | Card declined | no phantom activation | plan stays `free`, no `checkout_completed` |
| 5 | 3DS card, complete the challenge | SCA works — matters for a Norway-based seller billing the EU/UK | activates only after the challenge |
| 6 | 3DS card, **abandon** the challenge | incomplete checkouts don't grant access | plan stays `free` |
| 7 | Pro → Team while subscribed | in-place plan change (6fae083), not a 409 dead end | price swapped on the *existing* subscription, prorations on next invoice, no immediate charge |
| 8 | Cancel via portal | cancel at period end, keep access | `cancel_at_period_end=true`, plan retained until period end |
| 9 | Advance clock past renewal | renewal keeps the plan | new invoice paid, plan unchanged |
| 10 | Renewal fails (`...0341`) | **known gap** — the webhook handles no `invoice.*` events at all, so dunning only surfaces via `customer.subscription.updated` status | observe whether `past_due` downgrades; if nothing happens, that is the gap, not a test failure |
| 11 | Replay a webhook (`stripe events resend <id>`) | idempotency via `stripe_webhook_events` | second delivery is a no-op, no duplicate funnel row |
| 12 | Buy on a **comped** account | the comped guard (ca5e5b8) | refused; a comped account must not be charged for access it already has |
| 13 | Buy on a **grandfathered** user | repricing didn't break existing users | purchase succeeds, `unlimited_inboxes` still true |
| 14 | Connect inbox #2 while on Free | the paywall that has **never fired in production** — `plan_limit` has zero rows ever | 402 with `error_code=inbox_limit_reached`; check whether an upsell is actually shown |
| 15 | Connect inbox #2 after buying Pro | the cap lifts on payment | succeeds |

Case 14 is worth extra attention: it is the one path the repricing depends on
and the one with no production evidence at all.

## What gets recorded

Already instrumented, and captured by `report.sh`:

- `product_funnel_events` — `pricing_viewed` → `checkout_started` (with failure
  reasons: `price_not_configured`, `subscription_exists`, `stripe_error`,
  `no_customer`) → `checkout_completed` (written from the webhook, never the
  client) → `billing_portal_opened`
- `workspaces.plan`, `user_billing`, `user_usage_entitlements`
- `stripe_webhook_events` — the idempotency ledger
- Stripe-side subscriptions and invoices, pulled from the API

Two recording gaps worth knowing before you start:

- **Raw webhook payloads are not stored.** `stripe_webhook_events` keeps only
  `event_id`, `event_type`, `event_created`, `stripe_customer_id`,
  `processed_at`. For post-hoc analysis, Stripe retains full events for 30 days
  via `stripe events list`; `stripe listen` also prints them, so tee it to a
  file if you want a permanent copy.
- **No `invoice.*` handling.** The webhook handles exactly four event types:
  `checkout.session.completed`, `customer.subscription.created`, `.updated`,
  `.deleted`. Failed payments, renewals and dunning are only visible through
  subscription status transitions.

## Live-mode audit (read-only, no purchase)

Separately from the test matrix, confirm live configuration hasn't drifted:

- the four live price ids resolve and carry the expected amounts
  (2900 / 27600 / 7900 / 75600) and `tax_behavior=exclusive`
- `STRIPE_PORTAL_CONFIGURATION_ID` on Vercel is the dedicated
  `bpc_1U6D4JARrgumc6cqsL9BChNE`, not the account default, which belongs to the
  unrelated `Harbor` product
- the live webhook endpoint exists, points at the apex domain, and is returning
  200s
- `getPrices.ts` is rendering current amounts — its `unstable_cache` key must
  include the configured price ids, or the pricing page silently serves stale
  numbers

## Cleanup

Test-mode data can be wiped from the Stripe dashboard. The local database resets
with `npx supabase db reset`. Nothing in this directory touches production.
