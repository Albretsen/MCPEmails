#!/usr/bin/env bash
# Environment overrides that make a purchase test safe to run.
#
# THE POINT OF THIS FILE: apps/web/.env.local points NEXT_PUBLIC_SUPABASE_URL at
# the PRODUCTION Supabase project (swvaxorwumispmjaaszb). Running the dev server
# without these overrides and then buying a plan writes a fabricated
# subscription into the real workspaces table and fabricated rows into
# product_funnel_events, which is the same table the growth analysis reads.
# There is no undo for that: the funnel numbers would be quietly wrong forever.
#
# Next.js does not overwrite variables that are already present in process.env,
# so exporting them here beats anything in .env.local. Source this file, do not
# copy its contents into .env.local.
#
# Usage:  source scripts/stripe-test/env.sh

# ---- Database: LOCAL, never prod -------------------------------------------
export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
export SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
# Some routes read the non-public aliases; keep them consistent.
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY"

export NEXT_PUBLIC_APP_URL="http://localhost:3000"

# ---- Stripe TEST catalogue that mirrors the live 2026-08-19 repricing -------
# Created 2026-08-23. Amounts and tax_behavior match the live prices exactly,
# so a checkout here exercises the real numbers ($29/$276/$79/$756, exclusive).
# The env var names lag the customer-facing names by one rename: SOLO_* is the
# tier sold as "Pro", PRO_* is the tier sold as "Team". Same as live.
export STRIPE_PRICE_SOLO_MONTHLY="price_1U7e5fARrgumc6cqTSoO0UqL"   # Pro  $29/mo
export STRIPE_PRICE_SOLO_YEARLY="price_1U7e5fARrgumc6cqf5PLgEu0"    # Pro  $276/yr
export STRIPE_PRICE_PRO_MONTHLY="price_1U7e5gARrgumc6cqL6Wl3QpU"    # Team $79/mo
export STRIPE_PRICE_PRO_YEARLY="price_1U7e5gARrgumc6cqAaZWJEpa"     # Team $756/yr

# Dedicated TEST portal configuration, shaped like the live one
# (bpc_1U6D4JARrgumc6cqsL9BChNE): cancel at period end, no in-portal plan
# switching, because this account silently drops
# features.subscription_update.products through the API.
export STRIPE_PORTAL_CONFIGURATION_ID="bpc_1U7e5sARrgumc6cqkqzeXa7y"

# STRIPE_SECRET_KEY / NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY are already the
# sk_test_/pk_test_ pair in .env.local, so they are deliberately not overridden.
#
# STRIPE_WEBHOOK_SECRET is NOT set here. `stripe listen` mints a fresh signing
# secret per session and prints it; export that one in the shell that runs the
# dev server, otherwise every webhook fails signature verification and the plan
# never activates.

echo "stripe-test env loaded:"
echo "  Supabase : $NEXT_PUBLIC_SUPABASE_URL  (LOCAL - prod is untouched)"
echo "  App URL  : $NEXT_PUBLIC_APP_URL"
echo "  Prices   : Pro 29/276, Team 79/756 (tax_behavior=exclusive)"
echo "  Portal   : $STRIPE_PORTAL_CONFIGURATION_ID"
if [ -z "${STRIPE_WEBHOOK_SECRET:-}" ]; then
  echo "  WARNING  : STRIPE_WEBHOOK_SECRET unset - run listen.sh and export the whsec_ it prints"
fi
