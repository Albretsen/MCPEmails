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

## Order on launch day

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
