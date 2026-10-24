# EUR prices + Stripe Tax: Stripe-side launch runbook

Decided 2026-10-24, launch 2026-12-07 together with Pro $19. EUR prices are
VAT-inclusive with the same digits as the USD price they attach to (Personal
9 / 86.40, Pro 15 / 144 and 19 / 182.40, Business 39 / 374.40, extra mailbox
3 / 28.80, Japan sending route 108 a year). No NOK, no GBP. Existing EU
subscribers keep their USD amount and move to a USD twin price marked
tax-inclusive, so the VAT comes out of what they already pay.

This covers the Stripe configuration only. The code switches
(`STRIPE_AUTOMATIC_TAX`, `STRIPE_EUR_PRICES`, `STRIPE_PMC_ID`) are described
where they are read. Nothing here was run against live with `--apply` by the
PR that added it.

## Automatic launch (the default path)

Nobody has to do anything on 2026-12-07. A dispatcher turns the launch on by
itself once Stripe is ready, and stays off, with an email, while it is not.

- **Who runs it.** pg_cron (migration `20261025120000_eur_launch_cron`) calls
  `POST /api/internal/eur-launch/dispatch` every hour from 2026-12-07 00:00
  Oslo for 14 days, so an OSS registration that only lands by its 2026-12-10
  deadline still launches within the hour. A cleanup job removes the cron
  jobs on 2026-12-21.
- **Before the date** the route returns `outside_window` and reads nothing.
- **Preflight, read-only, every run until it passes:**
  1. `tax_registrations`: an active `oss_non_union` registration AND an
     active Norway registration.
  2. `webhook_events`: at least one enabled webhook endpoint receives
     `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed` and `charge.dispute.created`
     (or `*`). Every enabled endpoint counts, because the live one may be an
     ingress proxy that forwards to us.
  3. `payment_methods`: the payment method configuration Checkout uses
     (`STRIPE_PMC_ID`, else the account default) offers `sepa_debit`.
  4. `prices`: every sold price id is set in Vercel and is the USD price the
     catalogue says, and either already has `currency_options.eur` inclusive
     at the same digits or has no EUR option yet. This includes the Pro V2
     prices (`STRIPE_PRICE_SOLO_MONTHLY_V2`, `STRIPE_PRICE_SOLO_YEARLY_V2`),
     because Pro sells them from 2026-12-08: an unset V2 variable fails the
     check. `STRIPE_PRICE_JAPAN_ROUTE_YEARLY` is checked and given EUR 108
     only if it is set in Vercel.

  Any failure: nothing is written anywhere, and the owner gets ONE email a
  day (system-notify, event `billing.eur_launch`) listing each failed check
  and what to do. Checkout keeps selling USD without Stripe Tax.
- **Launch, when all four pass:** the same work as
  `eur-currency-options.mjs --apply` (EUR options, missing USD
  `tax_behavior=exclusive`, product tax codes), then the `eur_launch_live`
  row in `public.pricing_switches` is set true, then the "EUR launch live"
  email. Checkout, `/api/geo` and the pricing pages read that row (cached
  60 s, `src/lib/stripe/eur-launch.ts`) and treat `STRIPE_EUR_PRICES` and
  `STRIPE_AUTOMATIC_TAX` as on. No redeploy: a page built before the launch
  re-reads the clock in the browser and asks `/api/geo`.
- **Legacy EU swap,** in the same dispatcher, only once the flag is true:
  EU subscribers move to a USD inclusive twin (created when missing, with
  `metadata.twin_of`) with `automatic_tax` on, at most 25 per run, then the
  next run continues. `plans.ts` resolves a twin from its own
  `metadata.twin_of`, so `STRIPE_PRICE_TWINS` is no longer required; it still
  works and still wins, and setting it later helps a cold process that sees a
  bare price id. A failed swap emails once a day and never turns the launch
  off. When a run finds nothing left, it sets `eur_launch_swap_done`.

The same checks by hand, read-only, any day (no `--apply` exists for it):

```bash
cd apps/web
node scripts/stripe-eur/eur-launch-preflight.mjs --prices ../../Documents/stripe-eur/prices.live.json --live
```

Result on 2026-10-24 (live): `payment_methods` passes; `tax_registrations`
(no registration yet), `webhook_events` (the three SEPA events are not on the
endpoint) and `prices` (Pro V2 ids not set yet) fail. All three are expected
to be fixed before 2026-12-07; until they are, the launch stays off.

**Force it on early (manual override).** Set `STRIPE_EUR_PRICES=true` and
`STRIPE_AUTOMATIC_TAX=true` in Vercel (Production) and redeploy, AFTER the EUR
options exist (step 2 of the manual order below). The env switches work on
any date and do not need the flag. Never write `eur_launch_live` by hand: it
means "the preflight passed", and before the date it is ignored anyway.

**Roll back.** `STRIPE_FORCE_USD=true` in Vercel (Production) and redeploy.
It beats the env switches and the flag: every session is USD with no Stripe
Tax, and the pages show USD. Leave the flag as it is.

**Re-run the dispatcher by hand** (for example right after fixing a failed
check, instead of waiting for the next hour). Take the secret from the
`DISPATCH_SECRET` variable in Vercel; never paste it into a file or a commit:

```bash
curl -s -X POST https://mcpemails.com/api/internal/eur-launch/dispatch \
  -H "X-Dispatch-Secret: $DISPATCH_SECRET"
# preflight only, any date, writes nothing:
curl -s -X POST 'https://mcpemails.com/api/internal/eur-launch/dispatch?dry_run=1' \
  -H "X-Dispatch-Secret: $DISPATCH_SECRET"
```

The answer's `mode` is one of `outside_window`, `preflight_failed` (with
`failed` and `checks`), `launch_failed`, `launched`, `already_live` (with the
swap counts) or `dry_run`.

**Follow-ups the dispatcher cannot do.** The Free-cap upgrade line in the MCP
server (`FREE_CAP_UPGRADE_PRICE` in
`supabase/functions/mcp-server/usage-limit-message.ts`) still says "$9 per
month". It cannot follow a database flag cheaply and stays correct for USD
buyers; reword it in a later edge-function deploy. The changelog has no
future-dated entries, so the "pay by SEPA Direct Debit or iDEAL" entry is
added on or after the launch day by whoever sweeps the changelog.

The manual order below still works and is the fallback if the dispatcher is
ever unavailable.

## Scripts

All in `apps/web/scripts/stripe-eur/`, run from `apps/web`. Each one is a
dry run unless you pass `--apply`, and runs in test mode unless you pass
`--live`. Running one twice is safe: anything already in place is skipped.

| Script | What it does |
|---|---|
| `eur-currency-options.mjs` | Adds `currency_options[eur]` (inclusive) to every sold price, sets `tax_behavior=exclusive` on sold USD prices still `unspecified`, sets `tax_code=txcd_10000000` on MCPEmails products without one |
| `legacy-eu-inclusive-twins.mjs` | Creates a USD inclusive twin of every price an EU subscriber is billed on, and writes the `{twinId: originalId}` mapping |
| `legacy-eu-inclusive-swap.mjs` | Moves EU subscriptions onto the twins (`proration_behavior=none`) and turns on `automatic_tax`. Prints counts only |

How they reach Stripe: if `STRIPE_SECRET_KEY` is set, plain fetch to
api.stripe.com (the key's mode must match `--live`). Otherwise the Stripe CLI
with its logged-in profile (`stripe get|post ... [--live]`). The npm SDK is
not used, so the scripts do not depend on its pinned API version.

Price ids come from these env vars, or from a `--prices file.json` holding
the same names (`{"STRIPE_PRICE_SOLO_MONTHLY": "price_..."}`):

- Sold, required: `STRIPE_PRICE_PERSONAL_MONTHLY_V2`, `STRIPE_PRICE_PERSONAL_YEARLY_V2`,
  `STRIPE_PRICE_SOLO_MONTHLY`, `STRIPE_PRICE_SOLO_YEARLY`, `STRIPE_PRICE_BUSINESS_MONTHLY`,
  `STRIPE_PRICE_BUSINESS_YEARLY`, `STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY`,
  `STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY`
- Sold, optional: `STRIPE_PRICE_SOLO_MONTHLY_V2`, `STRIPE_PRICE_SOLO_YEARLY_V2` (Pro $19,
  set once the prices exist), `STRIPE_PRICE_JAPAN_ROUTE_YEARLY` (script-only; the route
  is sold from the Dashboard)
- Legacy, for the subscription filter: `STRIPE_PRICE_PERSONAL_MONTHLY`,
  `STRIPE_PRICE_PERSONAL_YEARLY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY`
  (plus the ids hardcoded in `plans.ts`)

Keep the prices file, the twin mapping and every dry-run log under
`Documents/stripe/` (gitignored). They are account data. The scripts refuse
to write into a tracked path.

## Facts checked in test mode (2026-10-24)

- **A currency option cannot be removed or changed once it is added.**
  `currency_options[eur]=` returns "cannot be unset", `currency_options=`
  returns "You cannot unset currency_options", and changing the EUR
  `unit_amount` returns "attempting to update an immutable field for an
  existing currency". Sending the same values again is accepted and changes
  nothing.
- **Rollback is therefore in code, not in Stripe:** set `STRIPE_FORCE_USD=true`
  and redeploy. Checkout then passes `currency: 'usd'` on every session and
  drops the EUR and Stripe Tax additions. Turning `STRIPE_EUR_PRICES` off is
  NOT a rollback: it only stops forcing EUR for the six non-euro EU countries,
  and Stripe keeps localizing euro-area buyers into EUR for as long as the
  currency option exists. To change an EUR amount later: create a new price with the
  right options, point the env var at it, and archive the old one (its
  subscribers keep billing on it).
- `tax_behavior` on a price, and on each currency option, is fixed once it is
  `inclusive` or `exclusive` (Stripe API reference, Prices update).
- Setting the top-level `tax_behavior=exclusive` and adding the EUR option in
  one call works on a price that was `unspecified`.
- `currency_options` only appears on a price retrieved with
  `expand[]=currency_options`. Without it every price looks like it has no
  EUR option.
- Adding EUR takes effect in Checkout at once for EU visitors (Checkout
  localizes by itself when every line item has the currency and, with Stripe
  Tax, a `tax_behavior` for it).

## Pro $19 V2 prices (not in live yet)

`STRIPE_PRICE_SOLO_MONTHLY_V2` and `STRIPE_PRICE_SOLO_YEARLY_V2` do not exist
in live mode yet. When they are created they must carry
`currency_options[eur]` at creation: `tax_behavior=inclusive`, same digits as
the USD amount (19 USD gets 19 EUR), and `tax_behavior=exclusive` on the USD
price itself. A currency option cannot be removed or changed later, so a
wrong EUR amount means a new price, not an edit. If one slips through, the
rollback is the same as above: `STRIPE_FORCE_USD=true`.

## Order on launch day (manual fallback)

1. **Before:** Stripe Tax registrations exist (`oss_non_union` at least; plan
   section 4.6 steps 1 to 3). Check:
   `stripe get /v1/tax/registrations --live -d status=active`.
2. Products and the four `unspecified` prices. These are part of the
   currency-options run and change nothing for buyers while no session sends
   `automatic_tax`. Dry run first, read it, then apply:

   ```bash
   cd apps/web
   node scripts/stripe-eur/eur-currency-options.mjs --prices ../../Documents/stripe/prices.live.json --live | tee ../../Documents/stripe/eur-options.$(date +%F).txt
   node scripts/stripe-eur/eur-currency-options.mjs --prices ../../Documents/stripe/prices.live.json --live --apply
   ```

   Expect `pricesWithProblems: 0`. A problem line means the env id is not the
   price the catalogue sells. Fix the id, never the script.
   Run this only once the web code that shows EUR is deployed: EU visitors
   see EUR in Checkout from this moment.
3. Set `STRIPE_AUTOMATIC_TAX=true` in Vercel and redeploy. Then run one live
   EUR checkout on a test workspace and refund it.
4. Twins (no effect on anyone until the swap):

   ```bash
   node scripts/stripe-eur/legacy-eu-inclusive-twins.mjs --prices ../../Documents/stripe/prices.live.json --live
   node scripts/stripe-eur/legacy-eu-inclusive-twins.mjs --prices ../../Documents/stripe/prices.live.json --live --apply
   ```

   It prints `STRIPE_PRICE_TWINS='{...}'`. Put that value in Vercel
   (Production) and redeploy **before step 5**. `plans.ts` resolves a twin to
   its original's plan and interval through this one variable, so the
   webhook, plan changes and the mailbox add-on keep working on twin prices.
   Never remove a pair from it while a subscription bills on the twin.
5. Swap (accountant answer 5 must be in):

   ```bash
   node scripts/stripe-eur/legacy-eu-inclusive-swap.mjs --prices ../../Documents/stripe/prices.live.json --live
   node scripts/stripe-eur/legacy-eu-inclusive-swap.mjs --prices ../../Documents/stripe/prices.live.json --live --apply
   ```

   It refuses `--apply` with zero registrations or a dry-run mapping. It skips
   a subscription with a schedule, an item with no twin, or a customer whose
   Stripe Tax location is not `supported`. Read the `skipped` line: each
   skipped subscription stays on its exclusive price without automatic tax,
   which is exactly today's state.
6. Check: one swapped subscription's upcoming invoice
   (`stripe get /v1/invoices/upcoming -d subscription=... --live`) shows the
   same total as before, with tax included.

## Rehearsal (test mode)

Same commands without `--live`, with a `Documents/stripe/prices.test.json`
pointing at test-mode prices. Use `test+location_DE@example.com`-style emails
for checkouts. The test account has no Stripe Tax registration unless you add
one there, so the swap script will refuse `--apply` until you do.

Not yet checked against Stripe, so check it in the rehearsal: Checkout keeps
`adaptive_pricing[enabled]=true` while it also sends `currency` (`eur` for SE,
PL, CZ, DK, HU and RO, `usd` under `STRIPE_FORCE_USD`). Create one session of
each kind and confirm Stripe accepts it and shows the currency you expect.
