# Pro cap at 10 + Business plan: cutover runbook

Decided 2026-10-19. Pro (`solo`, $15/mo, $144/yr) is capped at 10 connected
mailboxes for new customers; every workspace on Pro at the cutover keeps
unlimited. Team (`pro`) is replaced by Business: $39/mo ($374.40/yr) including
10 mailboxes, plus $3/mo ($28.80/yr) per extra mailbox, unlimited people.

Everything below is done by hand, in this order. Nothing here was run against
production by the PR that added it.

## 0. Before you start

- The PR is green and approved, but NOT merged yet (merging deploys the web).
- `git rev-list --left-right --count HEAD...origin/main` is `0 0` in the
  worktree you deploy the edge function from (after the merge, step 2).

## 1. Migration (no customer-visible change)

```bash
npx supabase db query --linked -f supabase/migrations/20261019150000_pro_inbox_cap_and_business.sql
npx supabase migration repair --status applied 20261019150000 --linked
```

It adds `workspaces.pro_unlimited_inboxes_exempt`, the `pricing_switches`
table with `pro_inbox_cap` seeded **off**, the fourth column on
`effective_workspace_plan()`, `usage_limit_events.limit_kind` +
`record_inbox_cap_event()`, and the `paywall_clicked` funnel stage. With the
switch off, every Pro workspace resolves to unlimited, exactly as today.

Check:

```sql
SELECT key, enabled FROM public.pricing_switches;            -- pro_inbox_cap | f
SELECT count(*) FROM public.usage_limit_events WHERE limit_kind <> 'actions';  -- 0
```

## 2. Stripe live objects

Create with the dashboard or the CLI (needs a live key with write access; the
CLI's stored live key is read-only). All prices `tax_behavior=exclusive`, USD.

| Object | Amount | Interval | Nickname | Metadata |
|---|---|---|---|---|
| Product "MCPEmails Business" | | | | `plan_id=pro` |
| Base price | 3900 | month | `Business-Monthly` | `plan_id=pro`, `value_metric=base` |
| Base price | 37440 | year | `Business-Yearly` | `plan_id=pro`, `value_metric=base` |
| Per-mailbox price | 300 | month | `Business-Mailbox-Monthly` | `plan_id=pro`, `value_metric=mailbox` |
| Per-mailbox price | 2880 | year | `Business-Mailbox-Yearly` | `plan_id=pro`, `value_metric=mailbox` |

Product description (shown on Checkout): "10 mailboxes included, $3 a month for
each extra. Unlimited members with roles, admins approve held sends, several
workspaces on one subscription."

```bash
stripe products create --live --name "MCPEmails Business" \
  --description "10 mailboxes included, \$3 a month for each extra. Unlimited members with roles, admins approve held sends, several workspaces on one subscription." \
  -d "metadata[plan_id]=pro"
# PROD=prod_...
for args in "3900 month Business-Monthly base" "37440 year Business-Yearly base" \
            "300 month Business-Mailbox-Monthly mailbox" "2880 year Business-Mailbox-Yearly mailbox"; do
  set -- $args
  stripe prices create --live --product "$PROD" --currency usd --unit-amount "$1" \
    -d "recurring[interval]=$2" --nickname "$3" -d tax_behavior=exclusive \
    -d "metadata[plan_id]=pro" -d "metadata[value_metric]=$4"
done
```

Do NOT archive the $79 / $756 Team prices: their ids stay in
`STRIPE_PRICE_PRO_MONTHLY/YEARLY` and resolve to Business as legacy ids.
Do the same in test mode for local development.

## 3. Env vars (Vercel, Production)

| Name | Value |
|---|---|
| `STRIPE_PRICE_BUSINESS_MONTHLY` | Business-Monthly price id |
| `STRIPE_PRICE_BUSINESS_YEARLY` | Business-Yearly price id |
| `STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY` | Business-Mailbox-Monthly price id |
| `STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY` | Business-Mailbox-Yearly price id |

Keep `STRIPE_PRICE_PRO_MONTHLY/YEARLY` (now legacy Team). A Business checkout
refuses with `price_not_configured` until all four are set, so set them before
the web deploy.

## 4. Web deploy, then the mcp-server edge function

Merge the PR (the push to `main` is the web deploy; Vercel promotes after
`CI passed`). Verify:

```bash
curl -sI https://mcpemails.com/api/analytics/paywall-click | grep -i x-matched-path
curl -s https://mcpemails.com/pricing | grep -c "Business"
```

Then deploy mcp-server from a clean worktree at the merged SHA (it now names
`pro` "Business" and filters `usage_limit_events` on `limit_kind = 'actions'`;
the column exists since step 1):

```bash
npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt --use-api
```

## 5. Cutover: backfill + switch the cap on

Run once, right after the web deploy is live:

```bash
npx supabase db query --linked -f docs/sql/pro-cap-cutover.sql
```

In one transaction it marks every workspace whose plan is Pro now (including
past_due, unpaid, cancel-at-period-end, and drifted rows whose owner's
`user_billing` says Pro) as exempt, then turns `pro_inbox_cap` on. Re-running
is a no-op once the switch is on, so it can never exempt a post-cutover buyer.
Write down the timestamp it prints: it is the read-out's cutover.

## 6. Verify in production

- `SELECT plan, count(*) FILTER (WHERE pro_unlimited_inboxes_exempt) FROM workspaces WHERE deleted_at IS NULL GROUP BY 1;`
  matches the number of Pro workspaces before the cutover.
- An existing Pro customer's billing panel says "Your Pro plan keeps unlimited
  connected inboxes."
- A test account bought on Pro after the cutover (test card in test mode, or a
  comp-free self-addressed account) is refused at the 11th connect and shown
  the Business offer; a `usage_limit_events` row with `limit_kind='inboxes'`
  appears, and a `paywall_clicked` funnel row on clicking the button.
- A Business test subscription with 11+ mailboxes shows a second subscription
  item with quantity = mailboxes - 10.

## Kill switch

Turn the cap off for everyone immediately, no deploy:

```sql
UPDATE public.pricing_switches SET enabled = false, updated_at = now() WHERE key = 'pro_inbox_cap';
```

Make it permanent for everyone capped so far (so turning the switch back on
later cannot re-cap them):

```sql
UPDATE public.workspaces SET pro_unlimited_inboxes_exempt = true
 WHERE plan = 'solo' AND NOT pro_unlimited_inboxes_exempt;
```

The pricing copy still says "10 mailboxes" until a copy change ships; with the
switch off that under-promises, it never over-promises.

## The rule

Track the first 20 capped buyers. If more than 40% neither buy Business nor
stay on Pro within 14 days of hitting the cap, flip the kill switch.

```bash
npx supabase db query --linked -f docs/sql/pro-cap-readout.sql
```

The last row is the verdict (`wait`, `keep the cap`, or `FLIP THE KILL SWITCH`).

## Billing behaviour (Business add-on)

- Quantity = max(0, non-deleted inboxes across all workspaces the subscription
  owner owns - 10). Synced after each connect, inbox delete and workspace
  delete, and on every Business `customer.subscription.*` webhook.
- Adding a mailbox past ten: `always_invoice`, the prorated remainder is billed
  at once (same rule as plan changes).
- Removing one: `proration_behavior: none`. No credit; the lower quantity bills
  from the next renewal.
- Pro to Business, Business to Pro and interval switches go through the
  existing two-call confirmation. The quote and the swap send the same items,
  add-on included, and the dialog says how many extra mailboxes the figure
  includes.

## Known gaps

- A Business customer who moves back to Pro keeps any mailboxes above ten
  already connected (only new connects are capped). Same as Personal today.
- Count-then-insert is not atomic: two simultaneous connects at 10 can both
  pass. The add-on sync bills whatever ends up connected.
- A Pro owner cannot create a second workspace (create_workspace requires
  Business), so "opened another workspace" in the read-out mostly means a
  new account on the same business domain.
