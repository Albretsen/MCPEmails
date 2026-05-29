# Pricing Strategy

## Vision

Maximize adoption. The entire product is free and **unlimited** for everyone — unlimited
inboxes, MCP tool calls, API keys, and team members. We monetize *capabilities and
support* that heavy users and businesses specifically want, never raw usage.

Nobody is ever blocked on volume. The only limit on Free is an infrastructure
**fair-use rate limit** (per-minute burst) that exists purely to protect the platform
from abuse/DoS — not a product quota. Paid tiers raise that ceiling.

> Consequence we accept on purpose: most users will never pay. Conversion rests on
> burst throughput, team/security features, and support — not usage caps.

## Tiers

Three tiers: **Free**, **Solo**, **Team**. (Enterprise removed — we do not offer a
dedicated enterprise support tier. A small "Need something custom? Contact us" link
covers the rare bespoke case.)

| | **Free** ($0) | **Solo** ($12/mo) | **Team** ($49/mo) |
|---|---|---|---|
| Positioning | Everyone | Power users running agents hard | Businesses & teams |
| Inboxes / calls / API keys / members | **Unlimited** | Unlimited | Unlimited |
| All 6 MCP tools + all providers | ✅ | ✅ | ✅ |
| Fair-use rate limit (burst) | ~60 req/min | ~300 req/min | ~1,000 req/min |
| Usage analytics dashboard | Basic (7-day) | Full (90-day) | Full (1-year) |
| Team roles / multiple workspaces | — | — | ✅ |
| SSO (SAML/OIDC) + audit log | — | — | ✅ |
| Support | Community | Email | Priority |
| Free trial | none | none | none |

- **Annual billing:** monthly + annual, ~17% annual discount → Solo $120/yr, Team $490/yr.
- **No free trial** on any tier — the unlimited Free tier *is* the trial.

## Pricing

| Plan | Monthly | Yearly | Stripe (live) |
|---|---|---|---|
| Free | $0 | $0 | none |
| Solo | $12 | $120 | created in live mode |
| Team | $49 | $490 | created in live mode |

## Implementation decisions

- **Internal plan id for "Team" stays `pro`.** Only the display name changes to "Team".
  This avoids a `workspaces.plan` enum/data migration and keeps Stripe metadata,
  checkout validation, and the webhook mapping stable. A full id rename is optional
  future cleanup.
- **`enterprise` plan id is removed** from the catalogue, checkout validation, and the
  webhook plan map. (Expected zero `enterprise` rows in production — verify in Phase 5.)
- Usage limits in `plans.ts` (`maxInboxes`, `maxApiKeys`, `maxMembers`, monthly/daily
  call caps) are all set to `Infinity`, which neutralizes the existing limit-check
  functions without deleting them.
- New per-plan feature flags: `maxRequestsPerMinute`, `analyticsRetentionDays`,
  `teamRolesEnabled`, `ssoEnabled`, `auditLogEnabled`, `supportTier`.

## Rollout phases

1. **Plan definitions & enforcement (code):** rewrite `src/lib/stripe/plans.ts`;
   neutralize `check-inbox-limit` / `check-api-key-limit` / `check-member-limit`;
   remove the "limit reached / upgrade" nudges in the dashboard.
2. **Rate limiting (edge function):** replace the daily/monthly plan-quota check in the
   MCP edge function with a per-plan per-minute ceiling; update
   `Documents/Architecture/rate-limiting-and-quotas.md`.
3. **Marketing & dashboard UI:** pricing page, marketing sections, dashboard billing
   cards, comparison table, FAQ — show "Unlimited", drop Enterprise, rename Pro→Team,
   remove all trial copy.
4. **Stripe (live) + env:** create live Solo/Team products+prices; archive stale live
   prices ($19 Pro, $99 Enterprise); create live webhook at
   `https://mcpemails.com/api/stripe/webhook`; set live env vars in Vercel; drop
   `enterprise` from checkout/webhook routes; remove the trial from the checkout route.
5. **DB:** confirm `workspaces.plan` accepts the tier set; migrate only if a constraint
   blocks removing `enterprise`.

## Grandfathering (legacy users)

Preparation for a future, more aggressive monetization (usage caps) without
breaking trust with launch-era users:

- **`workspaces.grandfathered boolean` column** (migration
  `20260531000000_workspaces_grandfathered.sql`). Backfilled `true` for every
  workspace that existed at launch; new signups default `false`.
- **`resolvePlanLimits(planId, { grandfathered })`** in `src/lib/stripe/plans.ts`
  is now used everywhere plan limits are resolved (dashboard `page.js`,
  `api/usage`, and the three `check-*-limit` helpers). When `grandfathered` is
  true it forces the usage caps (`maxInboxes`, `maxApiKeys`, `maxMembers`,
  monthly/daily call caps) to `Infinity`, regardless of the plan's configured
  caps. Feature flags still follow the plan.
- **Edge function** keeps a frozen `LEGACY_REQUESTS_PER_MINUTE` map; grandfathered
  workspaces resolve their per-minute ceiling from it, so lowering the live
  ceiling for new users later won't affect legacy users.
- **Today this is a no-op** (all plans are already unlimited). To monetize
  aggressively later: set finite usage caps in `PLANS` (and/or reintroduce a
  monthly cap in the edge function's `checkPlanQuota`, exempting `grandfathered`).
  Legacy users are then automatically exempt — no further plumbing needed.
- **ToS:** a fair-use clause (Terms §5.7) reserves the right to introduce usage
  limits on a going-forward basis with 30 days' notice, applying new limits to
  new subscriptions immediately. The marketing "unlimited" language is unchanged.
