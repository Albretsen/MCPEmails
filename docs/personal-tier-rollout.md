# Build and ship the Personal tier

You are the **orchestrator** for this piece of work. Your job is to plan, delegate, integrate, verify and deploy. It is **not** to read every file yourself.

This feature touches four layers (Stripe, Postgres, the Next.js app, and marketing copy in five locales) and finishes in production. If you do the reading and editing yourself you will run out of context somewhere around the third locale and start making mistakes in the parts that matter most. Delegate aggressively.

---

## 1. What you are building

A fourth pricing tier called **Personal**, sitting between Free and Pro.

MCPEmails prices on connected inboxes. Today the ladder is Free (1 inbox) then Pro ($29, unlimited). That is a cliff: 18 of the 25 workspaces with more than one inbox have exactly two or three, and they are being asked for $29 to add a second mailbox when the market rate for a mailbox is about $5. Personal exists to give that population a price they can say yes to, and to convert free users into people with a card on file. Getting the first dollar is the goal; ARPU is not.

### Locked decisions

Do not renegotiate these. If you believe one is wrong, say so and stop; do not quietly substitute your own number.

| | Value |
|---|---|
| Internal plan id | `personal` |
| Display name | Personal |
| Monthly | $5.00 (`monthlyPriceCents: 500`) |
| Yearly | $48.00 (`yearlyPriceCents: 4800`), a 20% discount, consistent with Pro and Team |
| Connected inboxes | 3 |
| Members | 1 |
| Position in the ladder | Between `free` and `solo` |
| Free, Pro, Team | **Unchanged.** Prices, limits and copy all stay as they are. |

### Plan limits to add to `PLANS.personal`

```
maxInboxes: 3
maxDailyBurstCalls: Infinity
maxMonthlyToolCalls: 25_000     // silent abuse ceiling, NEVER appears in customer-facing copy
maxApiKeys: Infinity
maxMembers: 1
billingPortalEnabled: true      // it is a paid plan and must be self-cancellable
analyticsEnabled: true
maxRequestsPerMinute: 120
analyticsRetentionDays: 30
teamRolesEnabled: false
ssoEnabled: false
auditLogEnabled: false
supportTier: 'email'
```

`maxMonthlyToolCalls` is an abuse ceiling, not a feature. It must not appear on the pricing page, in the plan feature list, in the dashboard or in the docs. This rule already exists in `plans.ts`; keep it.

### Naming trap

The internal ids do not match the display names and never have. `solo` is sold as **Pro**, `pro` is sold as **Team**. Adding `personal` is the first id that matches its own name, which makes it easy to mistype the others. Every time you touch a plan id, check which one you actually mean.

---

## 2. How to run this as an orchestrator

**Keep in your own context:** the locked decisions above, the phase plan, what each subagent reported, and the integration state. That is all.

**Push to subagents:** all file reading, all editing, all searching, all test running, all locale work.

**Brief each subagent properly.** They start cold. A brief that says "add the Personal tier to the pricing page" will produce something wrong. A good brief names the exact files, restates the locked values the agent needs, states what "done" looks like, and says what to report back.

**Ask for terse reports.** Tell each subagent to reply with a short structured summary (files changed, decisions made, anything surprising, anything it could not do) and explicitly *not* to paste file contents or diffs at you. You are protecting your own context window; a subagent that dumps three files into your lap has defeated the point.

**Run independent work in parallel.** Recon agents, the five locale agents, and the exploratory review can all run at once. Anything that edits the same file must be serialized.

**Suggested agent types:** `Explore` for read-only recon and codebase sweeps, `general-purpose` for anything that edits or runs commands. Use your judgment; these are suggestions, not a rule.

**Verify integration yourself.** After each phase, run the build and the relevant tests before moving on. Do not take a subagent's word that something compiles. Subagents sometimes report success on work that does not build, so treat their reports as claims to check, not facts.

---

## 3. Phases

Phases are ordered by dependency, not by ceremony. Stripe first because everything downstream needs the price IDs. Database before app code because the CHECK constraints will reject writes the moment a checkout succeeds. Beyond that, use your judgment about what to combine or split.

### Phase 0: Recon (parallel, read-only)

Before anything is written, send out two or three `Explore` agents in parallel:

- **Plan-id sweep.** Find every place in the repo that enumerates plan ids or branches on them: TypeScript, SQL migrations, Deno edge functions, JSX, JSON message bundles, admin components, scripts. The known list is in section 4, but it was assembled by hand and is probably incomplete. Ask for a file-and-line list, nothing more.
- **Pricing-claim sweep.** Find every customer-facing string anywhere in the repo that asserts a price, an inbox allowance, or the shape of the ladder. Marketing pages, docs, blog posts, `meta` descriptions, JSON-LD, README, `llms-install.md`, OG images, the self-host docs. Prices are quoted in more places than anyone expects.
- **Grandfathering path.** Confirm how `unlimited_inboxes` flows through `effective_workspace_plan` and `resolvePlanLimits`, and where the dashboard decides whether to show an upgrade prompt.

Reconcile what comes back against section 4 and build your real work list from the union.

### Phase 1: Stripe

Create a **Personal** product with two recurring prices, $5/month and $48/year.

- Do **test mode** yourself, autonomously.
- **Confirm with the owner before creating live-mode prices.** This project is in production with real subscribers. Creating a live price is not destructive, but it is outward-facing and the owner should see the numbers before they exist in their Stripe account.
- The Stripe MCP is unreliable here (`net::ERR_FAILED`). Use the REST API with the secret key from `apps/web/.env.local`, or the Stripe CLI with `--live` for live mode.
- Add `STRIPE_PRICE_PERSONAL_MONTHLY` and `STRIPE_PRICE_PERSONAL_YEARLY` to Vercel for production, preview and development. **Production env is write-only** (`vercel env pull` returns empty for prod), so record the price IDs somewhere readable before you set them.
- Add both prices to the Customer Portal configuration's allowed product set. If you skip this, Personal customers cannot self-serve an upgrade to Pro, which is the whole expansion path.

### Phase 2: Database

Write **new** migration files. Never edit a migration that has already been applied.

Known work (verify against the Phase 0 sweep):

- `workspaces.plan` CHECK constraint from `20260526000004_enum_check_constraints_retention_and_index.sql`, currently `IN ('free','solo','pro','enterprise')`. Add `'personal'`. **This one blocks everything**: without it the webhook cannot write the plan and a paid checkout silently fails.
- `billing_funnel_events` plan CHECK from `20260813100000_add_billing_funnel_events.sql`.
- `record_usage_limit_event` from `20260819160000_fix_record_usage_limit_event_return.sql`. The expression `CASE WHEN p_plan IN ('solo','pro') THEN p_plan ELSE 'free'` records every Personal customer as a free user.
- `growth_active_workspaces` from `20260813170000_growth_active_workspaces.sql`. `paying_workspaces` and `paying_owners` filter on `plan IN ('solo','pro')`. Add `'personal'`, and add a `paying_personal` counter alongside the existing `paying_solo` so the new tier is visible on its own.
- The action-ceiling map in `20260819090000_growth_inventory_rpcs.sql`.
- `user_billing.plan` is plain `text` with no CHECK, so no migration is needed, but the plan-projection logic that picks a user's best plan across workspaces needs a `personal` branch ranked above `free` and below `solo`.

Apply through the Supabase CLI, not the Supabase MCP (the MCP is unreliable for this). Migration history has diverged from remote, so push the single new migration rather than the whole folder.

### Phase 3: Application code

Known touch points, all verified to exist:

| File | What |
|---|---|
| `apps/web/src/lib/stripe/plans.ts` | Add `'personal'` to the `PlanId` union and the catalogue entry. Insert it **between** `free` and `solo`: the pricing page renders in `Object.values(PLANS)` order. |
| `apps/web/src/lib/billing/upgrade-intent.mjs` | `PAID_PLANS = new Set(['solo','pro'])`. Miss this and the Personal CTA on the pricing page silently does nothing. |
| `apps/web/app/api/stripe/checkout/route.ts` | Rejects any planId that is not `solo` or `pro` (around line 66). |
| `apps/web/app/api/stripe/webhook/route.ts` | Same validation, around line 240. |
| `apps/web/src/lib/analytics/product-funnel.ts` | `BillingPlanCategory` union. |
| `apps/web/src/lib/analytics/billing-funnel.ts` | Plan union and the coercion helper. |
| `apps/web/components/admin/growth/ActiveAccountsTable.tsx` | Sort rank and the display label mapping. |
| `supabase/functions/mcp-server/usage-limit-message.ts` | `PLAN_DISPLAY_NAMES` map, so the model never sees the internal slug. |

`resolvePlanLimits` and `getPlanLimits` need no change. Grandfathering and the unknown-plan fallback are already generic. Confirm that rather than assuming it.

### Phase 4: Copy, five locales

Locales are `en`, `nb`, `es`, `fr`, `zh`. This is the phase most likely to eat your context, so delegate it hard: one subagent per locale, running in parallel, each with the full English source text and the locked values in its brief.

- `apps/web/components/marketing/PricingClient.jsx`: add the fourth card, then add a `personal:` value to **every row of the comparison table**. Six sections, roughly 25 rows. A missing value renders blank rather than failing, so this needs checking by eye, not by build.
- `apps/web/messages/<locale>/pricing.json`: `plans.personal.{name,desc,cta,features}`, `comparison.personal`, and new value strings for the three-inbox allowance, 30-day analytics history and the Personal burst rate.
- **The hero no longer describes the ladder.** `hero.titleLine1` / `hero.titleLine2` currently read "One inbox, free." / "Every inbox, $29." Rewrite in all five locales. Something in the spirit of "One inbox, free. / Three for $5." but write it properly per locale, do not machine-translate a pun.
- `meta.title` and `meta.description` name the old three-tier ladder and the $29 price in every locale.
- Whatever the Phase 0 pricing-claim sweep turned up outside `pricing.json`.

House style: **no em dashes anywhere.** Use commas, colons, periods or parentheses. Check the generated copy before you accept it.

### Phase 5: Layout

`.price-grid` goes from three cards to four. Check desktop, tablet and mobile. Check the comparison table still scrolls horizontally inside its own container with the extra column and does not push the page body sideways.

Use the browser preview tools to look at it. Take screenshots at a few widths and actually examine them. Do not ask the owner to check it for you.

### Phase 6: Exploratory review (open-ended, and the point of doing this properly)

**This phase is deliberately not a checklist.** Send out one or two agents with a broad remit and let them find things.

Things worth looking for, as prompts rather than a list to tick off:

- Copy anywhere in the repo that is now wrong, misleading or stale. Not only about Personal: the sweep will surface unrelated errors, and those are worth fixing or at least reporting. Past examples in this codebase include marketing claiming capabilities that were gated off, docs listing tool names that had been renamed, and blog posts using superseded plan naming.
- Places that branch on plan and will silently misbehave rather than error. The `IN ('solo','pro')` pattern is the known shape of this bug, but look for the general case: any code that treats "not a plan I recognise" as "free".
- Anywhere a Personal customer would be shown something meant for a free user, or an upsell for something they already have.
- Grandfathered users being offered Personal. They already hold `unlimited_inboxes` permanently, so buying Personal would be a downgrade they pay for. Nobody should ever see that offer.
- Anything about the four-inbox step that reads badly. That is the new cliff ($5 to $29) and the copy around it should be honest.

Report what you find. Fix what is clearly in scope and low risk. For anything larger or debatable, tell the owner rather than deciding unilaterally.

### Phase 7: Verification

Run these yourself, do not delegate the final pass:

```bash
npm run lint -w apps/web && npm run build -w apps/web
```

```bash
npm run test:plans -w apps/web && npm run test:inbox-limit -w apps/web && npm run test:billing -w apps/web && npm run test:growth -w apps/web
```

Deno tests for the edge function live under `supabase/functions/`. Run the full suite; the baseline is roughly 266 Deno tests and 31 harness tests passing.

Existing tests assert the old three-plan shape and **will** fail. Read each failure and decide whether the test encodes a rule that still holds (fix the code) or an assumption the new tier invalidates (update the test). Do not blanket-update tests to make them green.

Add coverage for the new behaviour: a Personal workspace is capped at 3 inboxes, a grandfathered user on Personal is still uncapped, and `personal` resolves to the right display name.

**Exploratory testing is expected here too.** Beyond the scripted suites, actually exercise the flow: sign up as a fresh non-grandfathered user, connect one inbox, hit the cap, walk the upgrade path, complete a test-mode checkout, confirm the plan lands in the database and the cap moves to three, then connect a fourth inbox and confirm it is refused with sensible copy. That end-to-end walk is worth more than any unit test here.

### Phase 8: Deploy

Deploying is outward-facing and this project has live subscribers. **Confirm with the owner before the production deploy**, and show them what is going out.

- Pushing to `Albretsen/MCPEmails` needs `gh auth switch --user Albretsen`; the default active account gets a 403. Vercel and Supabase deploys do not need GitHub auth.
- **Merge to `main` and deploy from `main`.** Concurrent sessions share this repository. Deploying from a stale worktree silently reverts other people's live work, and duplicate migration versions get skipped permanently.
- Web: `vercel --prod --yes` (project `mcp-emails-web`).
- Edge function: `npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt`. Never use the Supabase MCP deploy tool, it silently deploys the wrong content.
- Migrations before the app deploy, so the app never writes a plan the database will reject.

### Phase 9: Post-deploy verification

Prove it works in production rather than assuming:

- The pricing page renders four cards in all five locales, with correct prices from live Stripe.
- A live-mode checkout for Personal completes and the webhook writes `plan = 'personal'`.
- The Customer Portal offers an upgrade from Personal to Pro.
- A Personal workspace is capped at three inboxes and a fourth is refused with the localised message.
- Personal appears as **paying** on `/admin/growth` and on the kiosk, not as free.

Note that `getPrices` caches live Stripe prices for one hour via `unstable_cache`, falling back to the static cents in `plans.ts`. A price shown wrong immediately after deploy may just be the cache. Keep the static values in sync with Stripe so the fallback is never wrong.

---

## 4. Known traps

These have all bitten this codebase before.

1. **Silent plan coercion.** Two RPCs and one view treat any plan outside `('solo','pro')` as free. Personal customers would pay and still show up as free in every growth metric. Grep for `IN ('solo', 'pro')` across `supabase/migrations` before shipping, not after.
2. **`Object.values(PLANS)` order** drives the pricing page column order. Insert `personal` in the right place in the object literal.
3. **Grandfathering.** All 176 pre-existing users hold `unlimited_inboxes`, which widens `maxInboxes` to Infinity on any plan. None of them will ever buy Personal, and none should be shown it. The addressable population on day one is the 48 non-grandfathered single-inbox workspaces plus new signups.
4. **PostgREST truncates every row-returning select at 1000 rows with no error**, and a larger `.limit()` does not help. If you write anything that counts or aggregates rows, do it in SQL or page with `.range()`.
5. **Shared worktree.** Other sessions may be working in this repo right now. Check `git status` and recent commits before you deploy.
6. **Docker Desktop on this machine wedges roughly daily.** If you touch the self-host stack and Docker hangs, the only fix is a full `pkill` of every docker process then a restart, not a normal restart.

---

## 5. Definition of done

- Personal is live, purchasable, and enforced at three inboxes for non-grandfathered users.
- Pro and Team are byte-for-byte unchanged in price and limits.
- All five locales are consistent, and no page anywhere still describes the old three-tier ladder.
- Personal counts as paying in every internal metric.
- Lint, build and the full test suite pass.
- You have walked the signup-to-cap-to-checkout-to-cap flow yourself in production or a production-equivalent environment.
- You have reported back on anything the exploratory phase turned up that you did not fix.

---

## 6. Where judgment is yours

The locked decisions in section 1 and the traps in section 4 are firm. Almost everything else is a starting point.

Split the phases differently if the work suggests it. Add subagents where a phase is bigger than it looks. Skip a step that turns out to be unnecessary and say why. If the Phase 0 recon shows the plan-id sweep is much larger than section 3 implies, restructure around what you found rather than working through a list you now know is wrong.

If something genuinely blocks you, do everything that does not depend on it first, then come back with a specific question. Do not stop the whole rollout on one ambiguity, and do not guess on anything involving live Stripe or a production deploy.
