# Usage-based pricing support runbook

## Scope and authority

Use this runbook for user-level `comped_scale` usage entitlements. Support may
prepare evidence and create a request; only the approved service/admin path may
write, reverse, or expire an entitlement. Never modify `user_billing.plan`,
`workspaces.plan`, a Stripe subscription, or `workspaces.grandfathered` to
grant or remove comped access.

Every request must have a ticket ID, affected `user_id`, reason, requester,
operator, timestamp, and before/after effective-entitlement evidence. Never
put email content, recipients, or tool arguments in a ticket.

## Granting Scale access

1. Confirm the customer identity and resolve the owner `user_id`; list all
   owned workspaces for the ticket.
2. Check whether an active entitlement already exists. If it is
   `comped_scale`, do not overwrite it; add the ticket to its audit trail.
3. Select the source: `migration`, `support`, or `promotion`. For migration,
   attach the approved CSV row and query revision. For support/promotion,
   record the approving authority and explicit expiry, if any.
4. Use the phase-2 admin grant path to create an immutable `comped_scale` row
   with `granted_at`, `granted_by`, `reason`, `source`, and `expires_at`.
   Permanent grants use a null `expires_at`.
5. Verify the effective-plan read path for every owned workspace returns
   “Scale — comped” and unlimited actions, while the billing view continues to
   show the underlying Stripe subscription truthfully.
6. Tell the customer whether the grant is permanent or its exact expiry. Never
   describe it as a Stripe subscription upgrade.

## Reversing or expiring a grant

Do not delete grants. A reversal requires the migration owner (for migration
grants) or the original approving authority (for support/promotion grants), a
ticket, and a documented reason. Use the admin audit path to set the recorded
expiry/reversal state, then verify the normal plan and cap resolve correctly in
all owned workspaces. A permanent migration grant is not reversible merely
because a Stripe subscription changes or is cancelled.

## Temporary workspace exemption

Use a workspace exemption only for a time-bounded incident or support case;
it bypasses action-cap enforcement for that workspace without changing Stripe,
the workspace plan, or a user's permanent entitlement. Create and revoke it
through the admin-only `/api/admin/usage-exemptions` endpoint. A ticket ID,
reason, operator, and explicit expiry are required for every grant. Revoke it
as soon as the incident is resolved; do not delete the record.

## Answering customer questions

- **What counts?** One successful billable MCP `tools/call` in the published
  allow-list. Failures, provider/auth problems, rate limits, dashboard work,
  OAuth, API-key management, and `inbox_list` do not count.
- **When does usage reset?** At the customer’s billing-period boundary shown in
  the usage view, not at midnight UTC.
- **Why am I on Scale?** Check the entitlement record. State its reason and
  permanence/expiry; do not expose internal query data beyond the customer’s
  own aggregate usage.
- **Did my Stripe plan change?** No. A comped entitlement changes effective
  product access only; the billing portal shows the actual paid subscription.

## Stripe webhook incident procedure

1. Do not alter or delete an entitlement while diagnosing a webhook issue.
2. Capture the Stripe event ID, customer ID, event type, received time, and
   `stripe_webhook_events` result. Confirm signature verification and whether
   the event was rejected as stale or duplicate.
3. Compare the expected Stripe price ID with the frozen configured price IDs.
   A price mismatch is an incident, not a reason to remap a customer manually.
4. Replay the event only through Stripe’s supported replay mechanism after
   recording the ticket. Verify `user_billing.plan` and workspace projections
   update normally, and the active `comped_scale` entitlement remains intact.
5. If an effective-access regression is possible, disable cap enforcement
   before repair, preserve the meter ledger, and escalate to engineering. Do
   not attempt retroactive action charges.

## Phase-0 verification checklist

- Snapshot current Stripe price IDs, products, intervals, currencies, and
  active states.
- Test checkout, portal, and renewal once for each configured paid price; the
  resulting price ID must be unchanged.
- Export and hash the legacy-grandfathered snapshot without editing it.
- Confirm rendered Free, Agent, and Scale labels in the pricing page and
  dashboard. Internal `solo`/`pro` IDs are expected in requests and code.
