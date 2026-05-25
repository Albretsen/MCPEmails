# Stripe Products and Prices Setup Needed

## What I need from you

Create three products in your Stripe dashboard — **Free**, **Pro**, and **Enterprise** — with the prices listed below, then copy the resulting `price_...` IDs into `.env.local`.

## Why

The Stripe SDK is installed and the `stripe_customer_id` column is live in the database. The next steps (checkout session, webhook handler, Customer Portal) all require real Stripe price IDs to reference. These IDs can only be created by a human with access to the Stripe account.

## Step-by-step instructions

### 1. Log in to the Stripe dashboard

Go to https://dashboard.stripe.com and make sure you are in **Test mode** (toggle in the top-left).

---

### 2. Create the Pro product

1. Click **Products** in the left sidebar → **+ Add product**
2. Fill in:
   - **Name**: `MCPEmails Pro`
   - **Description**: `For power users and small teams who rely on email automation.`
3. Under **Pricing**, add two prices:

   | Field | Monthly | Yearly |
   |---|---|---|
   | Pricing model | Standard | Standard |
   | Price | $19.00 | $152.00 |
   | Billing period | Monthly | Yearly |
   | Currency | USD | USD |

4. Click **Save product**.
5. Copy the two `price_...` IDs shown under each price.

---

### 3. Create the Enterprise product

1. Click **+ Add product** again
2. Fill in:
   - **Name**: `MCPEmails Enterprise`
   - **Description**: `Unlimited scale for teams with advanced compliance needs.`
3. Under **Pricing**, add two prices:

   | Field | Monthly | Yearly |
   |---|---|---|
   | Pricing model | Standard | Standard |
   | Price | $99.00 | $792.00 |
   | Billing period | Monthly | Yearly |
   | Currency | USD | USD |

4. Click **Save product**.
5. Copy the two `price_...` IDs.

*(The Free plan has no Stripe price — it's the default when no subscription exists.)*

---

### 4. Add the price IDs to `.env.local`

Open `apps/web/.env.local` and set:

```env
STRIPE_PRICE_PRO_MONTHLY=price_...       # from step 2 — monthly
STRIPE_PRICE_PRO_YEARLY=price_...        # from step 2 — yearly
STRIPE_PRICE_ENTERPRISE_MONTHLY=price_... # from step 3 — monthly
STRIPE_PRICE_ENTERPRISE_YEARLY=price_... # from step 3 — yearly
```

Also make sure these are set (from Stripe dashboard → Developers → API keys):

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...          # from step 5 below
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

---

### 5. Set up the Stripe webhook (local dev)

The webhook handler (`/api/webhooks/stripe`) will be implemented in the next agent run. To test it locally:

1. Install the Stripe CLI: https://stripe.com/docs/stripe-cli
2. Run: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
3. Copy the signing secret printed (starts with `whsec_`) into `STRIPE_WEBHOOK_SECRET` in `.env.local`.

For production, add a webhook endpoint in the Stripe dashboard pointing to `https://mcpemails.com/api/webhooks/stripe` and subscribe to:
- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

---

## What happens next

Once the price IDs are in `.env.local`, the next agent run will implement:
- The Stripe Checkout session (upgrade button → Stripe-hosted checkout)
- The webhook handler (sync subscription status to the database)
- The Customer Portal link (billing self-service in dashboard settings)
