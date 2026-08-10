# Phase 0: usage-based pricing migration contract

**Status:** approved for implementation. This document is the source of truth
for the migration contract until it is superseded by a dated amendment.

## Immutable compatibility boundary

- Public plan names are **Free**, **Agent**, and **Scale**. Their internal plan
  IDs remain `free`, `solo`, and `pro`, respectively.
- Existing `STRIPE_PRICE_SOLO_MONTHLY`, `STRIPE_PRICE_SOLO_YEARLY`,
  `STRIPE_PRICE_PRO_MONTHLY`, and `STRIPE_PRICE_PRO_YEARLY` values are frozen.
  Do not create replacement Stripe prices or migrate subscriptions for this
  rollout.
- Keep `/api/stripe/checkout`, `/api/stripe/portal`, and
  `/api/stripe/webhook` routes and their `solo`/`pro` mapping unchanged.
- Do not change, clear, or repurpose `workspaces.grandfathered` in phase 0.
  It remains historical migration input until phase 2 verifies the user-level
  entitlement backfill.
- Existing paid customers retain their Stripe price IDs and renewal dates. A
  public display-name change does not alter the Stripe subscription.

## Meter and eligibility rules

The first enforcement release will use these action caps per billing-period
window, not a UTC calendar month:

| Effective plan | Internal ID | Cap |
| --- | --- | ---: |
| Free | `free` | 2,500 actions |
| Agent | `solo` | 50,000 actions |
| Scale | `pro` | 300,000 actions |

An action is one successful `tools/call` operation for a workspace whose tool
name is in the versioned billable-tool allow-list. Every included call has a
quantity of one in meter version 1. Failed calls, provider outages,
authentication errors, rate-limited calls, dashboard actions, OAuth, API-key
management, and `inbox_list` have a quantity of zero. The ledger must not
store email content, recipients, or tool arguments.

The shadow period ends at the explicit UTC timestamp supplied to the approved
query. A user qualifies for a permanent `comped_scale` entitlement when either
of these applies:

1. They are in the verified legacy-comped input; or
2. Across all owned workspaces, they have at least one successful billable
   action in `[shadow_end - 14 days, shadow_end)`, and the greater of their
   rolling-30-day actions and their prior-complete-30-day actions is strictly
   greater than the cap for their otherwise-normal plan.

The otherwise-normal plan is the maximum normal plan across the user's active
owned workspaces and `user_billing.plan` (`pro` > `solo` > `free`). No
operator may select candidates based on identity, revenue, or observed names.
`workspaces.grandfathered` is an input only for the verified legacy-comped
list; it does not itself define migration eligibility.

## Approved candidate query

The only approved candidate-generation query is
[phase-0-comped-grant-candidates.sql](phase-0-comped-grant-candidates.sql).
It is read-only and must run with a service/admin read role only after phase 1
has created and validated `action_usage`. Bind `shadow_end` once and save the
exact value, query revision, row count, and SHA-256 of the exported CSV in the
migration record. Do not edit the query during review; amend this contract
instead.

## Approved CSV schema

The only import/review schema is
[phase-0-comped-grant-candidates.schema.csv](phase-0-comped-grant-candidates.schema.csv).
It contains IDs and aggregate counts only; it must never contain email content,
tool arguments, recipients, or customer revenue. The eligibility query emits
one row per user. `review_status` and reviewer fields are deliberately empty on
export and are completed during the controlled review in phase 2.

## Required evidence before moving to phase 1

1. Record a Stripe catalogue snapshot containing each configured price ID,
   Stripe product ID, currency, interval, active state, and retrieval time.
2. In Stripe test mode, use one customer on each existing paid price to start
   checkout for that same price, open the billing portal, and renew. Record
   the pre- and post-test price IDs; they must match.
3. Preserve a read-only export/count of `workspaces.grandfathered`, keyed by
   workspace and owner, without changing data.
4. Run the public-copy check described in the support runbook. No rendered plan
   name may be Solo, Team, or Pro; internal slugs may remain in code and URLs.

## Change control

Any cap, activity-window, allow-list, query, or CSV-schema change requires an
amendment to this document, a migration-owner approval, and a new query
revision. Changing a Stripe product, price, checkout route, webhook mapping,
or a legacy-grandfathered value is outside this phase and requires a separate
approved change.
