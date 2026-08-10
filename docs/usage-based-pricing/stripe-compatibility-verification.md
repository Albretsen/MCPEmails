# Stripe compatibility verification

**Verified:** 2026-08-03 UTC

This read-only verification confirms the usage-pricing migration preserved the
existing Stripe catalogue and webhook contract. Price IDs are intentionally not
recorded here; the configured environment variables remain the source of truth.

- `STRIPE_PRICE_SOLO_MONTHLY` and `STRIPE_PRICE_SOLO_YEARLY` still bind the
  internal `solo` plan (public name: Agent).
- `STRIPE_PRICE_PRO_MONTHLY` and `STRIPE_PRICE_PRO_YEARLY` still bind the
  internal `pro` plan (public name: Scale).
- All four configured Stripe prices were retrieved successfully, are active,
  are USD, and have their expected monthly or yearly recurring interval.
- `/api/stripe/webhook` continues to resolve Stripe price IDs through
  `getPlanByStripePriceId` and only projects the established `solo` and `pro`
  internal IDs to `user_billing` and owned workspaces.

No Stripe prices, products, subscriptions, checkout routes, portal routes, or
webhook mappings were created, replaced, or modified by this verification.
