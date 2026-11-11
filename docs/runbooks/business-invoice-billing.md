# Runbook: an annual Business subscription paid by invoice

Internal. For a company that wants to pay Business yearly by bank transfer against an invoice instead of by card. Self-service Checkout does not offer this; it is set up by hand in Stripe. No customer data belongs in this file or in any commit.

Do every step in the Stripe sandbox first if you have not done it before (`scripts/stripe-staging-setup.mjs` builds the same catalog there).

## Before you start

You need, from the customer (by email, never pasted into the repo):

- the email address of the MCPEmails account that will own the subscription (the workspace owner);
- the legal company name, billing address and org number (and the VAT number if they are VAT registered);
- how many people will use it, and whether their purchase order number must be on the invoice.

Then look up the owner:

1. Find the user id: `select id from auth.users where email = '<address>'` with `npx supabase db query --linked`.
2. Find the Stripe customer: `select stripe_customer_id, plan, stripe_subscription_id from user_billing where user_id = '<id>'` (same command). If the owner already has an active subscription, stop: a second subscription would bill them twice. Change the existing one instead (step 4, "Existing card subscription").
3. No customer id yet: the customer is created on their first checkout. Ask them to sign in once, or create the customer in the Dashboard with the owner's email and add `user_id = <id>` under Metadata. The webhook finds the owner from that metadata or from `user_billing.stripe_customer_id`.

## 1. Company name and org number on the customer

In the Dashboard, open the customer.

1. Edit the customer details: **Name** = legal company name; fill in the **Billing address**. The name is what the invoice prints as the buyer.
2. **Tax IDs**, Add: for a Norwegian company registered for VAT choose type `no_vat` and enter the number as `123456789MVA`. For an EU company use its `eu_vat` number. Stripe prints the tax ID on every invoice.
3. A Norwegian company that is NOT VAT registered has an org number but no tax ID Stripe accepts. Add it under **Invoice settings**, Custom fields: name `Org.nr.`, value the nine digits. Custom fields print on every invoice for this customer.
4. A purchase order number goes in the same place (`PO`), or on the single invoice under its own custom fields.

Self-service buyers can now enter the company name and tax ID themselves: every Checkout collects them (`tax_id_collection`, `src/lib/stripe/tax-switch.ts` `checkoutPaperworkParams`), and Checkout writes them back onto the customer.

## 2. Pick the prices

| What | Price (env var in Vercel) | Quantity |
| --- | --- | --- |
| Business per person, yearly, while `pricing_switches.business_seat_pricing` is on | `STRIPE_PRICE_BUSINESS_SEAT_YEARLY` (lookup key `business_seat_year`, $278.40 a person) | people, at least 2 |
| Business flat, yearly, while the switch is off | `STRIPE_PRICE_BUSINESS_YEARLY` ($374.40) | 1 |
| Company-wide mailboxes over the included 10 | `STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY` ($28.80 each) | mailboxes over 10, or leave it out |

Read the price ids from Vercel, never type them from memory. Never use a founder price for an invoiced deal and never archive one.

## 3. Create the subscription

Dashboard: **Subscriptions**, Create subscription.

1. Customer: the owner's customer.
2. Add the plan price from the table, with the quantity. Add the mailbox line only if they already have more than 10 company-wide mailboxes; the app adds or adjusts it by itself later.
3. **Payment**: choose **Email invoice to the customer to pay manually** (`collection_method = send_invoice`). Payment terms: 14 days unless agreed otherwise.
4. **Metadata**: `user_id = <owner's user id>`. Required: the webhook maps the subscription to the owner from it, and without it the plan may not reach their workspaces.
5. Leave the start date as today and billing yearly. Leave automatic tax off unless `STRIPE_AUTOMATIC_TAX` is on in production (then turn it on, so the invoice matches what Checkout would charge).
6. Create. Stripe finalises and emails the first invoice.

CLI equivalent (test mode first; the live CLI key cannot write, use the Dashboard for live):

```
stripe subscriptions create \
  --customer cus_... \
  -d "items[0][price]=price_..." -d "items[0][quantity]=3" \
  -d collection_method=send_invoice -d days_until_due=14 \
  -d "metadata[user_id]=<owner user id>"
```

## 4. Existing card subscription

To move an existing Business subscriber to invoices: open their subscription, **Update subscription**, change **Payment** to "Email invoice", set the payment terms, and save without changing the price. Nothing is charged; the next renewal is invoiced. To also switch monthly to yearly, let them do it from the dashboard billing page first (it quotes the proration), then change the collection method.

## 5. Check it worked

1. `select plan, subscription_status, stripe_subscription_id from user_billing where user_id = '<id>'`: `pro`, `active`, the new subscription id. The subscription is `active` while the invoice is open, so they have Business from today.
2. Their workspaces show Business in the dashboard.
3. Vercel logs for `/api/stripe/webhook` show `customer.subscription.created` handled without an unmapped-price line.

## How the bill moves afterwards

- Per person: when a member or admin connects their first mailbox, the app raises the quantity and Stripe invoices the prorated rest of the year at once (`always_invoice`); with `send_invoice` that is a separate emailed invoice. When someone leaves or loses their last mailbox, the quantity falls (never below 2) and the unused rest is credited on the next invoice. See `apps/web/src/lib/stripe/business-seats.ts`.
- Company-wide mailboxes past 10 are added to the mailbox line the same way (`mailbox-addon.ts`).
- An unpaid invoice past its terms turns the subscription `past_due`, then follows the account's retry and cancellation settings. They keep Business while it is `past_due` or `unpaid`.
- The renewal is invoiced automatically a year later; nothing to do.

## Refunds and corrections

Use a credit note on the invoice (Dashboard, invoice, **Create credit note**), never a manual edit of a paid invoice. To re-issue an invoice with corrected company details: update the customer (step 1), void the open invoice if it is unpaid, or for a paid one add an out-of-band credit note and issue a new invoice marked paid.

EHF (Norwegian e-invoicing) is not set up yet and is owed before 2027-01-01. Until then, send the PDF.
