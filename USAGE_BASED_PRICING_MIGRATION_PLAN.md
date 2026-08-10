# Usage-based pricing migration plan

## Goal and non-negotiables

Move MCPEmails from unlimited hosted usage to a workspace-level, action-based model. Billing is based on the **total successful actions in a workspace**; it is never based on seats, members, or connected inboxes.

The rollout must preserve the current Stripe catalogue and subscriptions:

| Existing Stripe plan ID | Current public name | New public name | Stripe change |
| --- | --- | --- | --- |
| `free` | Free | Free | None |
| `solo` | Solo | Agent | None |
| `pro` | Team | Scale | None |

The existing `STRIPE_PRICE_SOLO_*` and `STRIPE_PRICE_PRO_*` price IDs remain the source of truth. This release changes product copy, entitlements, and metering; it does **not** replace subscriptions, create a Business tier, or alter a customer's Stripe price. Existing paid customers keep their current price and renewal date.

Two protections are mandatory:

1. A currently active user whose observed usage would exceed a new cap is granted the highest available plan, `pro` / **Scale**, at no charge.
2. A user who is already comped remains comped. A Stripe webhook, cancellation, plan change, or workspace creation must never overwrite that entitlement.

## Target public offer

These are launch hypotheses, not prices to hard-code before the shadow-meter phase validates the distribution.

| Plan | Monthly actions | Copy and capability |
| --- | ---: | --- |
| Free | 2,500 | Explore MCPEmails; core read/search/organize/draft/send; 7-day history; community support. |
| Agent (`solo`) | 50,000 | Production use; scheduled sends and approvals; 90-day history; 300 RPM; email support. |
| Scale (`pro`) | 300,000 | Always-on/shared agent work; roles, audit log, 1-year history; 1,000 RPM; priority support. |

The first release stops work at the cap instead of creating automatic overage charges. That makes the new meter trustworthy. A later release can introduce opt-in spend caps and overage/top-up prices without changing plan IDs.

### Definition of an action

One action is one successful, billable `tools/call` operation for a workspace.

- Do not charge for failed calls, provider outages, authentication errors, rate-limited calls, dashboard actions, OAuth, API-key management, or `inbox_list`.
- Start with a weight of one for every billable successful tool call. Do not price reads and sends differently.
- Keep an explicit, versioned allow-list of billable tool names. Any future weighted operation (for example, a costly hosted extraction feature) must be separately labelled in the UI and docs before it is billable.
- Count against the billing-cycle window, not a UTC calendar month. The usage dashboard and enforcement must use the same start/end timestamps.

This is intentionally simpler than charging per email, per inbox, or per member. It follows the successful-operation convention used by Zapier MCP and the action/credit model used by Composio and Make.

## Entitlement model

`workspaces.plan` remains the projection used by the application and `user_billing` remains the user-level Stripe source of truth. Add an explicit user-level usage entitlement; do not overload `workspaces.grandfathered`.

Suggested table: `user_usage_entitlements`.

| Field | Purpose |
| --- | --- |
| `user_id` (PK/FK) | Applies to every workspace owned by the user. |
| `kind` | `standard` or `comped_scale`. |
| `granted_at`, `granted_by`, `reason` | Immutable operational/audit record. |
| `expires_at` nullable | Null means permanent; launch migration grants are permanent. |
| `source` | `migration`, `support`, or `promotion`. |

Effective plan resolution should work as follows:

1. Resolve the normal `free` / `solo` / `pro` plan from Stripe or the existing workspace projection.
2. Resolve the owner's usage entitlement.
3. When it is active `comped_scale`, return Scale capabilities and unlimited actions, independent of Stripe state. Keep the entitlement user-level so it follows newly created workspaces.
4. Otherwise, enforce the finite action cap for the normal plan.

The existing `workspaces.grandfathered` flag was a broad launch-era unlimited usage escape hatch. Retain it as historical data, but remove it from new action-cap resolution only after the comped-entitlement backfill is verified. It is not precise enough to represent the migration promise and is scoped to a workspace rather than its owner.

## Phase 0 — lock the migration contract

**Deliverables**

- Adopt the plan names **Free**, **Agent**, and **Scale** in all customer-facing copy. Internal IDs remain `free`, `solo`, and `pro`.
- Freeze current Stripe products, prices, checkout routes, webhook mappings, and grandfathered data. No Stripe price replacement or subscription migration is part of this phase.
- Write the exact cap and “active” eligibility rules before querying customer data. Do not select comped users manually after looking at names or revenue.
- Create a support runbook for grants, reversals, customer questions, and Stripe-webhook failures.

**Acceptance criteria**

- A test user on each existing Stripe price can still start checkout, open the billing portal, and renew with the same price ID.
- Public plan labels contain no customer-visible `Solo`, `Team`, or `pro`.
- There is one approved SQL query and one approved CSV schema for the comped-grant list.

## Phase 1 — measure before enforcing

**Product work**

- Add an `action_usage` ledger or a derived daily aggregate keyed by workspace, billing period, and meter version. Do not calculate customer-visible usage by repeatedly counting the full `activity_log` table.
- Populate it from completed MCP calls. Record the tool name, a billable flag, meter version, and the action quantity, but never email content, recipients, or tool arguments.
- Add a read-only dashboard meter: current actions, cap, reset date, projected plan, and the last 30 days of successful billable calls.
- Add internal reports for p50/p80/p95 actions, successful-versus-failed rate, tool mix, and usage by current plan. Use a rolling 30-day view and the prior complete billing period.
- Add a feature flag that calculates whether a request *would* be blocked but never blocks it. Log only aggregate/anonymous diagnostics needed to validate the cap.

**Eligibility snapshot rule**

At the end of the shadow period, a user is migration-eligible for a permanent `comped_scale` grant when both conditions hold:

1. They are active: at least one successful billable action in the final 14 days of the shadow period; and
2. Their higher of (a) shadow-period rolling 30-day actions or (b) the prior completed 30-day period exceeds the cap of the plan they would otherwise have after launch: Free 2,500, Agent 50,000, or Scale 300,000.

Any verified pre-existing comped user is included regardless of activity or measured usage. Store the final, reviewed grant list before changing cap enforcement. The list is user-based: if any workspace owned by the user meets the rule, the user receives Scale across all their owned workspaces.

**Acceptance criteria**

- Usage shown in the dashboard matches the ledger and a sampled set of `activity_log` rows.
- Failed/rate-limited calls and `inbox_list` produce zero actions.
- The planned Free, Agent, and Scale caps have been checked against the p50, p80, and p95 distribution. If the evidence does not support the proposed thresholds, change thresholds before Phase 2, not after enforcement.

## Phase 2 — create and verify protected entitlements

**Data migration**

1. Create `user_usage_entitlements` with RLS that lets users read only their own entitlement; service-role/admin paths own writes.
2. Import all verified legacy comped users as permanent `comped_scale` rows.
3. Run the Phase 1 eligibility query, write candidate grants to a review table or signed CSV, and review row count, owners, and aggregate usage. This is a read-only review; do not modify plans yet.
4. Insert permanent `comped_scale` grants for the approved candidates.
5. Validate that every current comped user and every qualifying active user resolves to unlimited Scale usage in a staging-like read path.
6. Preserve every migration input and resulting grant record for support and auditability.

**Webhook and authorization changes**

- Stripe webhooks may continue to update `user_billing.plan` and `workspaces.plan`, but must never delete, downgrade, or overwrite a `comped_scale` entitlement.
- Checkout and customer-portal flows must display the underlying paid subscription truthfully while entitlement resolution continues to honor the comped grant.
- New workspaces owned by a comped user automatically inherit the effective Scale entitlement.

**Acceptance criteria**

- Cancellation, invoice failure, upgrade, downgrade, and webhook replay tests leave a comped user's effective access unchanged.
- A non-comped user follows the normal plan cap.
- A user who owns multiple workspaces receives consistent effective usage in all of them.

## Phase 3 — ship copy and opt-in visibility (two weeks)

**Customer-facing changes**

- Rename pages, dashboard badges, checkout labels, emails, structured data, README, and help text: `Solo` becomes **Agent** and `Team` becomes **Scale**. Keep only the existing Stripe `solo` and `pro` IDs in code/comments where required for compatibility.
- Update pricing comparison copy to say “actions” and state exactly what counts, what is free, when the period resets, and what happens at the cap.
- Email affected active users before launch. State their exact effective plan: users receiving a grant should be told that their Scale access is comped and permanent; users below a cap should see the date limits begin and their observed action count.
- Do not announce an automatic price increase. Existing Stripe subscriptions retain their price; this change is framed as a clearer product model with protected existing usage.

**Acceptance criteria**

- All public surfaces show the same action allowances and plan names.
- A comped user can see a clear “Scale — comped” status and does not see an upgrade warning.
- Support can reproduce the action count, cap, reset date, and grant reason for any user without inspecting email content.

## Phase 4 — controlled enforcement

**Rollout**

1. Enable caps for 5% of eligible new signups only; keep existing users in shadow mode and all comped users exempt.
2. Observe for seven days: false blocks, failed-action classification, usage latency, support contacts, conversion to Agent/Scale, and webhook errors.
3. Enable for the remaining new signups.
4. Enable for non-comped existing users after the protected-entitlement audit has passed.

At a cap, reject only new billable MCP calls with a stable, machine-readable `usage_limit_reached` response. Include the effective plan, used actions, cap, reset timestamp, and dashboard/pricing URL. Do not revoke inboxes, API keys, or historical access.

**Kill switch and rollback**

- A feature flag disables enforcement globally while leaving metering on.
- A per-user and per-workspace exemption is available to support.
- On a metering or entitlement incident, disable enforcement first, preserve the ledger, and backfill/repair grants before re-enabling. Never attempt to “make up” missed action charges in this launch.

## Phase 5 — optimize and prepare usage revenue

- Measure Free-to-Agent conversion, Agent-to-Scale conversion, action utilization, cap-hit rate, support burden, and retention by action cohort.
- Test only one pricing/cap variable at a time for new users. Preserve existing customers' paid price and comped access.
- If demand supports it, add opt-in action top-ups or an opt-in monthly spend cap with metered overage. The customer must set the cap, see real-time usage, and receive 50%/80%/100% notifications.
- Prefer action bundles and lower per-action prices at Scale over seat charges. Do not introduce Business or Enterprise plans in this project.

## Implementation checklist

- [x] Add entitlement migration, RLS, admin/support audit trail, and tests.
- [x] Add versioned action ledger/aggregate and backfill strategy.
- [x] Update the edge function to classify billable successful calls and enforce the effective cap atomically enough to prevent material overshoot.
- [x] Update `resolvePlanLimits` and every caller to resolve user-level comped access rather than relying solely on `workspaces.grandfathered`.
- [x] Keep current Stripe price IDs and existing webhook plan mapping unchanged.
- [x] Rename public `Solo` → `Agent` and `Team` → `Scale` in messages, marketing, checkout/dashboard copy, metadata, docs, and emails.
- [x] Build customer usage, reset-date, cap, and effective-entitlement views.
- [x] Build internal eligibility, grant, and anomaly reports.
- [x] Exercise end-to-end tests for free cap, Agent cap, Scale cap, comped owner, multiple workspaces, Stripe webhook replay, and rollback.

## Research basis

- [Composio pricing](https://composio.dev/pricing) uses tool-call allowances and decreasing overage rates.
- [Zapier MCP usage](https://help.zapier.com/hc/en-us/articles/45645738385805-How-Zapier-MCP-usage-works) bills successful MCP calls and leaves failed calls free.
- [Make pricing](https://www.make.com/en/pricing) uses action credits, clear allowance visibility, alerts, and optional extra-credit purchase paths.
- [Stripe usage-billing guidance](https://stripe.com/resources/more/usage-based-billing-pros-and-cons-businesses-should-consider) supports a fixed commitment plus visible, capped usage as the safer path to later overage revenue.
