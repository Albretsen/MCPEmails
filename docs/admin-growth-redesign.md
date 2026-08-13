# /admin/growth redesign: improvement plan

Status: **built 2026-08-13, phases 1 to 5.** Written first as a proposal against
the old `apps/web/app/admin/growth/page.tsx` (302 lines, single server
component). See "Implementation status" at the bottom for what actually shipped,
what changed during the build, and what is still open.

Measurements in this document were taken from the production database on
2026-08-13 via PostgREST with the service-role key (read only).

---

## 0. What is wrong today, in one paragraph

The page is one `force-dynamic` server component that pulls **103,841 raw
`activity_log` rows** over the wire, 1,000 at a time, in a **sequential** loop
(≈104 round trips), then aggregates them in Node on every single request. Nothing
renders until the slowest query finishes, nothing is cached, and one failing
query throws and kills the whole page. On top of that it renders 12 summary
numbers with no history, no trend and no target, so a number like "active
workspaces (7d): 31" carries no information about whether that is good.

---

## 1. Load performance

### 1.1 Root cause (measured)

| Cost | Detail |
| --- | --- |
| `fetchActivities()` | 103,841 rows / 1,000 per page = **104 sequential HTTP round trips** to PostgREST. At 150-300 ms each this alone is 15-30 s. |
| Transfer | ~100k rows × 4 columns serialized as JSON, parsed in the Node runtime, then thrown away after aggregation. |
| `activeInWindow()` | Called once per rendered day (28×) plus 4× for weeks, each call scanning every workspace's full timestamp array. O(days × workspaces × events). |
| `export const dynamic = 'force-dynamic'` | No caching whatsoever. A page reload repeats all of the above. |
| Single await barrier | `Promise.all` of five fetches, then everything renders at once. Time to first byte = time of the slowest query. |

### 1.2 Fix, in three layers (do all three, in this order)

**Layer A: push aggregation into Postgres.** Roughly 100k rows should never cross
the network. Add `SECURITY DEFINER` RPCs that return tens of rows instead:

- `growth_daily_metrics(p_days int)` returns one row per UTC day: new workspaces,
  technical activations, value activations, active-7d, active-28d, calls,
  successes, errors, rate-limited.
- `growth_engagement_bands(p_days int)` returns the active-days and session
  distributions (the session boundary logic, 30 min gap, moves into SQL with a
  window function; keep `buildSessions` in TS only for the unit tests).
- `growth_retention_curve()` returns the value-activation cohort curve.
- `growth_provider_funnel(p_days int)` returns the per-provider connect funnel.

Expected effect: the dominant cost drops from ~104 round trips to 1, and from
~100k rows to well under 500.

**Layer B: streaming SSR with per-section Suspense.** The shell, header and any
cheap query (workspaces, inboxes, plan mix, Gmail cap) render immediately; each
expensive section becomes its own `async` server component wrapped in
`<Suspense fallback={<SkeletonX />}>`. This is the pattern the dashboard already
uses (`apps/web/app/dashboard/loading.js` +
`apps/web/components/dashboard/Skeletons.jsx`), so add a
`components/admin/GrowthSkeletons.jsx` in the same style and reuse the `.sk`
shimmer class.

Order sections so the cheap, high-value ones stream first: Gmail cap and hero
cards, then funnels, then the heavy activity-derived charts.

**Layer C: cache with an explicit refresh.** Historic days never change. Wrap
each section fetch in `unstable_cache` with a 10-15 minute TTL and a per-section
tag, drop `force-dynamic`, and add a "Refresh data" button wired to a server
action calling `revalidateTag`. Show an "as of HH:MM UTC" stamp per section so a
cached number is never mistaken for a live one.

**Layer D (later, optional but recommended): a nightly rollup table.**
`growth_daily_metrics_snapshot` written by pg_cron (the project already uses
`cron.schedule` in six migrations). This makes the page nearly free *and* solves
the retention-window bug in 1.3.

### 1.3 Bug found while measuring: the 180-day window does not exist

`HISTORY_DAYS = 180`, but `activity_log` is purged at **90 days** by the
`activity-log-retention` cron
(`supabase/migrations/20260526000004_...sql`). The oldest row today is
2026-05-25 (80 days), so nothing has been lost *yet*, but from roughly
2026-08-23 onward every retention denominator that reads `activity_log` will
start silently shrinking, and long-horizon retention will quietly become
unmeasurable. Activation timestamps are already durable on `workspaces`; the
*return* side is not. Fix by persisting the daily rollup (Layer D) or by
honestly capping the page at 90 days and saying so.

### 1.4 Resilience

`fetchActivities` throws on error, which today takes down the entire page. With
per-section Suspense, add `error.tsx` per section (or a small `<SectionError>`
boundary) so a broken billing view does not hide working retention numbers.

---

## 2. Gmail OAuth 100-user cap tracker

### 2.1 What is actually being capped

The OAuth client requests four restricted Gmail scopes at once
(`gmail.readonly`, `gmail.send`, `gmail.modify`, `gmail.settings.basic`, see
`apps/web/app/auth/gmail/route.ts:45`). The app is **published but unverified**
(evidence: an inbox created 2026-05-29 refreshed its token on 2026-08-13, i.e.
76 days, so the client is not in Testing mode, where refresh tokens die after 7
days). A published, unverified app with restricted scopes is limited to **100
distinct Google accounts that have ever granted consent**, and the count is
**cumulative**: revoking access or deleting the inbox does not give a slot back.
Lifting it requires Google verification plus the CASA security assessment (the
"AL1" tier), which takes weeks of calendar time, not days.

### 2.2 Where we stand (measured 2026-08-13)

| Metric | Value |
| --- | --- |
| Distinct Gmail addresses ever connected | **40** |
| Still connected (not soft-deleted) | 28 |
| Currently `active` | 26 |
| First Gmail grant | 2026-05-28 |
| Implied burn rate | ~40 grants in ~11 weeks ≈ **15-16 per month** |
| Naive projection to 100 | **≈ December 2026**, sooner if signups keep accelerating |

Note the projection is a floor, not a ceiling: Google counts a grant the moment
consent is given, so a user who consented and then failed before the inbox row
was written consumes a slot we cannot see. The authoritative number lives in the
Google Cloud Console OAuth consent screen.

### 2.3 What to build

**A dedicated "Gmail OAuth headroom" card, pinned at the top of the page**
(cheap query, so it streams in the first paint):

- Big number `40 / 100` with a progress bar that changes colour at 60 and 80.
- Sub-line: grants in the last 30 days, and the projected exhaustion month
  computed from the trailing 60-day rate.
- A lead-time warning that fires at 60 grants: "start CASA AL1 now, verification
  takes weeks and the cap does not pause for it."
- Click-through drawer with: cumulative grants line chart against a 100
  threshold marker, grants per month bars, and the split of live vs deleted vs
  revoked (so it is obvious that deletions do not free slots).

**A small manual reconciliation input.** Add `admin_oauth_cap_snapshots`
(`recorded_at`, `provider`, `google_reported_users`, `note`) that you fill in
from the Cloud Console occasionally. The card then shows both "our floor: 40"
and "Google reported: N as of <date>", and the gap between them is itself a
useful signal (it measures consent-then-fail).

**Sit the consent-abandonment number right next to it.** `oauth_states` rows are
deleted on success and never cleaned up otherwise, so leftover rows are
abandoned consent attempts (61 rows currently; the 2026-07-28 audit measured
~59% all-time Gmail abandonment). That leak and the cap have the same root cause,
the unverified-app interstitial, so showing them together makes the case for
verification in one glance.

**Privacy contract:** the header promises no email addresses or IDs are
displayed. Counting distinct addresses server-side and rendering only an integer
keeps that promise. Do not render the addresses.

---

## 3. Charts

No chart library is installed, and the project has a deliberate low-dependency
habit (it hand-rolled its own HTML sanitizer to avoid one). Recommendation:
**hand-rolled inline SVG server components**, no client JS, no dependency. Build
six primitives in `components/admin/charts/`:

`Sparkline`, `BarSeries` (with optional stacking), `LineChart` (with a threshold
marker), `ProgressMeter`, `FunnelBars`, `CohortHeatmap`.

Rules: size with `viewBox` + `preserveAspectRatio` so they scale; colours from
the existing CSS variables so light/dark keeps working; `role="img"` plus a
`<title>`; and every chart gets a `<details>` "show numbers" table underneath so
the exact values are never lost.

Charts worth having, in priority order:

1. **Signups vs value activations**, daily bars over 90 days with a 7-day moving
   average line. This is the single chart that answers "is the top of the funnel
   growing".
2. **Active workspaces (7d and 28d rolling)**, two lines. The health chart.
3. **Cumulative workspaces**, one line. The "does it feel like progress" chart.
4. **Retention curve**: percentage of value-activated workspaces still active at
   week 1, 2, 3, 4, 8, 12.
5. **Cohort heatmap**: signup week on the Y axis, weeks-since on the X axis,
   cell = percentage still active. This is the only view that shows whether a
   product change moved retention.
6. **Gmail cap**: cumulative grants against the 100 line (see section 2).
7. **Tool calls stacked by status** (success / error / rate_limited) with a
   success-rate line overlaid, 90 days.
8. **Provider mix and MCP client mix** as horizontal bars instead of the two
   current two-column tables.
9. **Cap utilization histogram**, replacing the current band table.

Every summary card also gets a 30-day sparkline behind or beneath the number.

---

## 4. Funnels

Four funnels, each rendered with the same `FunnelBars` component showing absolute
count, percentage of the previous step, and percentage of the top of funnel.

**4.1 Acquisition to activation** (data already in `product_funnel_events`):
signup → `onboarding_started` → `provider_selected` → `inbox_connection` success
→ `credential_created` → `technical_activation` → `value_activation`. Add a
per-step drop-off column, because the absolute counts alone hide where the loss
is.

**4.2 Per-provider connection funnel.** Attempts → successes → failure reasons,
split by provider. This is the view that would have exposed Yandex (2 workspaces,
21 `auth_failed` attempts, 0 successes) months earlier. Include an explicit
"left for the provider and never returned" step derived from leftover
`oauth_states` rows, since OAuth abandonment leaves no `product_funnel_events`
row at all and is therefore invisible to funnel 4.1.

**4.3 Billing funnel** (exists, needs work). Keep the stages, but:
- add a step-to-step conversion percentage column,
- drop the "Meaning of zero" prose column (it was scaffolding for a page that was
  all zeros; the conversion column now carries the same information),
- add a stage 0, "eligible to pay", meaning workspaces at 80 percent or more of
  their plan cap, which is the population that *could* have been paywalled,
- respect the page-wide window selector instead of always being all-time, with
  all-time available as one of the window options.

**4.4 Retention funnel.** Restate the four current retention percentages as a
curve (see 3.4) plus two blunt numbers that are more actionable than any ratio:
**one-and-done count** (activated, used it on exactly one day, never returned)
and **at-risk count** (was active, nothing for 14 days). The 2026-07-28 audit had
to compute the one-and-done number by hand; it belongs on the page.

---

## 5. Clickable cards and historical context

The core complaint, "I have no reference for what a good number is", is fixed at
two levels.

**Level 1, on the card itself, no click needed.** Every `Stat` gains:
- a 30-day sparkline,
- a delta versus the previous equivalent period (`▲ 12% vs prior 7d`), coloured
  by direction, with the direction of "good" declared per metric (for cap-hit
  rate, up is good; for checkout failures, down is good),
- an optional target from a small hard-coded `GROWTH_TARGETS` map, rendered as
  "target 15/wk" under the number.

**Level 2, the drill-down.** Cards become buttons that open a detail view
containing: the full 90-day series as a chart, current value versus the 7 / 28 /
90-day average, the observed min and max with their dates, the precise
definition and the SQL-level meaning, and the breakdown table behind the number.

Implementation: keep the headline number server-rendered. On click, open a
route-intercepted modal (`app/admin/growth/@modal/(.)metric/[key]/page.tsx`) or,
simpler to start, a client drawer that fetches
`GET /api/admin/growth/metric/[key]?window=90d` guarded by `requireAdmin`. Either
way the series loads on demand, so drill-downs never slow the initial page.

Start with drill-downs for: active workspaces, new workspaces, value
activations, Gmail cap, billable actions, and each billing funnel stage.

---

## 6. What to remove or demote

| Remove / change | Why |
| --- | --- |
| The 28-row **daily metrics table** | 8 columns × 28 rows of small integers. Replaced by charts 1, 2 and 7. Keep it behind a `<details>` "show raw daily numbers" for when you need exact figures. |
| **Technical activation** column in the daily and weekly tables | At this volume it moves in lockstep with value activation. Keep it in funnel 4.1, where the gap between the two is the point, and off the summary tables. |
| The "**Meaning of zero**" column in the billing funnel | See 4.3. |
| Three stacked **4-card stat grids** (12 cards) above the fold | A wall of numbers with no hierarchy. Cut to one hero row of 4-5 (Gmail cap, active 7d, new 28d, value activations 28d, paid workspaces), with the rest moved next to the section they explain. |
| **Sessions / active workspace**, **successful sessions**, **active-day bands**, **session bands** | Four different renderings of the same "how often do they come back" question. Collapse to one engagement chart plus the one-and-done and at-risk counts from 4.4. |
| **Cap-hit rate** as a top-level card | Structurally near-zero while enforcement is a 5 percent cohort. Demote it into the billing section, where the caveat can sit next to it. |
| `MixTable` header "**Workspaces / inboxes**" | Ambiguous unit. Each table should name its own unit. |
| **Returning older cohorts** appearing in both the weekly table and a stat card | Duplicate. Keep one. |

---

## 7. Other improvements worth doing

1. **Window selector**, `?window=28d|90d|all`, plus a "compare to previous
   period" toggle. URL-driven so it stays a server component and links are
   shareable.
2. **Reliability panel.** Today the only quality signal is an aggregate success
   rate. Add top failing tools and an `error_code` breakdown from `activity_log`.
   Systemic provider breakage shows up here first.
3. **Freshness stamps.** With per-section caching, each section needs its own
   "as of" timestamp, otherwise cached and live numbers are indistinguishable.
4. **Alerts, reusing the existing system-notify pipeline.** Three cheap, high
   value triggers: Gmail grants ≥ 60; any `checkout_started` failure with
   `error_category = 'price_not_configured'` (an unset env var makes a plan
   silently unbuyable and looks exactly like disinterest); any provider with
   ≥ 5 attempts and 0 successes in 7 days (the Yandex signature).
5. **Tests.** `retention.test.ts` already exists. Any aggregation moved into SQL
   needs a fixture test, and the TS helpers that remain should keep theirs, so
   the two implementations cannot drift.
6. **Keep the privacy contract explicit.** The page states no names, addresses or
   IDs are shown. The 2026-08-13 audit needed named accounts and had to go
   around the page to get them. Decide deliberately: either keep this page
   aggregate-only and accept that account-level questions happen in SQL, or add a
   separate, access-logged operator view. Do not quietly erode this page.
7. **Empty and small-n honesty.** At 116 workspaces, a percentage over a
   denominator of 3 is noise. Render ratios with denominators under ~10 as
   `3 of 7` rather than `43%`.

---

## 8. Suggested phasing

| Phase | Content | Why this order |
| --- | --- | --- |
| **1** | Suspense sections + skeletons, drop `force-dynamic`, add caching and refresh, per-section error boundaries. | Fixes the felt problem immediately without touching any metric definition. |
| **2** | Gmail cap card and drawer, plus the `oauth_states` abandonment number. | Highest business urgency: the cap is 40 percent consumed and verification has weeks of lead time. |
| **3** | `growth_daily_metrics` RPC, removing the 104-round-trip fetch. Charts 1, 2, 3, 7 on top of it. | Real speed fix plus the charts that need the rollup anyway. |
| **4** | Funnel rework (4.1-4.4), removals from section 6. | Once the page is fast, make it say something. |
| **5** | Clickable cards, deltas, targets, drill-down API. | Depends on the series from phase 3. |
| **6** | Nightly rollup table + retention-window fix, alerts, reliability panel. | Longer horizon, and it protects retention metrics before the 90-day purge starts biting around 2026-08-23. |

## 9. Files this will touch

- `apps/web/app/admin/growth/page.tsx` (split into `page.tsx` shell +
  `sections/*.tsx` async server components)
- `apps/web/components/admin/GrowthSkeletons.jsx` (new)
- `apps/web/components/admin/charts/*.tsx` (new)
- `apps/web/app/api/admin/growth/metric/[key]/route.ts` (new)
- `apps/web/src/lib/analytics/retention.ts` and `retention.test.ts`
- `apps/web/styles/admin-growth.css`
- `supabase/migrations/` (RPCs, `admin_oauth_cap_snapshots`, optional rollup
  table and cron job)

---

## 10. Implementation status (2026-08-13)

Phases 1 to 5 are built. Phase 6 (nightly rollup table, alerts) is not.

### What shipped

| Area | Where |
| --- | --- |
| 11 reporting RPCs + `admin_oauth_cap_snapshots` | `supabase/migrations/20260813140000_growth_analytics_rpcs.sql`, **applied to production** |
| Row-shape contract | `apps/web/src/lib/analytics/growth-types.ts` |
| Cached data layer, tagged, non-throwing | `apps/web/src/lib/analytics/growth-queries.ts` |
| Current-state inventory queries | `apps/web/src/lib/analytics/growth-inventory.ts` |
| Metric catalogue + pure helpers + tests | `apps/web/src/lib/analytics/growth-metrics.ts`, `growth-metrics.test.mjs` (23 tests, `npm run test:growth`) |
| Drill-down API | `apps/web/app/api/admin/growth/metric/[key]/route.ts` |
| Chart primitives (inline SVG, no dependency) | `apps/web/components/admin/charts/` |
| Page shell, 9 streamed sections, skeletons, drawer | `apps/web/app/admin/growth/page.tsx`, `apps/web/components/admin/` |

### Measured result

`growth_daily_metrics(90)` returns in **0.28s**; all 13 reporting calls together
take about 2.1s, against 104 sequential PostgREST pages before. The page shell
and the Gmail cap card paint immediately, and each section streams in behind its
own skeleton.

### Decisions taken during the build that differ from the plan above

1. **Retention curve week 1 was tautological.** The formula in section 4.4
   made week 1 cover days 0 to 6, which necessarily contains the activation
   event itself, so it read 38 of 38. Corrected to days 1 to 7. The curve now
   reads 67, 41, 36, 29, 35, 36, 33, 40 percent for weeks 1 to 8.
2. **The activation funnel's middle stages are partly synthetic.** Client
   selection and connection verification were only instrumented on 2026-08-05,
   and the 20260805010000 backfill set late timestamps without earlier ones.
   The funnel is forced monotonic, which manufactures those two stages for
   older workspaces. The section says so on the page rather than hiding it.
3. **The Gmail cap warning is driven by time, not by the count.** A rule based
   only on grants used reported "ok" at 40 of 100 while the remaining 60 slots
   were about four months from gone. Verification plus CASA take weeks, so the
   level now escalates when the runway is shorter than the process.
4. **`summariseSeries` takes an aggregate.** Reducing every series with a mean
   made the drawer disagree with the card it opened from (card 34 active
   workspaces, drawer 23.6). Rolling windows and cumulative series now read at
   their endpoint, per-day counts sum, rates average.
5. **The dead Fastmail OAuth row is filtered out** of the abandonment table.
   Those are stale nonces from a flow removed in June 2026, and they rendered
   as a 100 percent abandonment rate for something nobody can reach.
6. **A `threshold` is not a `target`.** Google's 100 user cap is drawn on the
   drill-down chart as an externally imposed wall, in a separate field, so it
   is never labelled as something the team is aiming for.

### Still open

- **Phase 6**: the nightly `growth_daily_metrics_snapshot` rollup and the three
  alerts (Gmail grants at 60, `price_not_configured` checkout failures, a
  provider with attempts and no successes). The 90-day retention purge starts
  biting around 2026-08-23, so the rollup is the time-sensitive one.
- **Not deployed to Vercel.** The database migration is live; the web app is
  built, linted, tested and browser-verified locally only.
- `apps/web/src/lib/analytics/retention.ts` is now orphaned: the rewritten page
  was its only consumer. Delete it or make it an enforced spec, but do not
  leave it as-is.
- The reliability panel immediately surfaced its first real finding: JSON-RPC
  `-32602` (invalid params) is the top failure across `email_list`,
  `email_search`, `email_read` and `email_compose`, 278 failures in 28 days.
  That is clients calling tools with arguments the server rejects, not a
  provider fault, and it is worth its own investigation.

---

## 11. Second pass (2026-08-13, after first review)

Seven changes from operator feedback on the shipped page.

1. **Gmail cap demoted.** It was the first thing on the page and dominated it.
   It is an operational ceiling, not a growth metric, so it moved to the bottom
   and lost the big number, the prose and the warning block. What remains is a
   compact meter, a facts row, and a small amber pill beside the heading when
   the runway is short.
2. **"5 paid workspaces" was false.** Every one of them was comped.
   `workspaces.plan` reads `pro` for a comp and a purchase alike, because both
   paths write the same column. New `growth_revenue_counts()` treats an
   unexpired `comped_scale` entitlement as not-revenue: the page now reads
   **0 paying customers, 8 comped, 108 free**. `paidWorkspaces` and the
   plan-column mix were deleted from the inventory module outright rather than
   left for a future caller to reach for.
3. **Double borders removed.** Chart primitives already render their own card,
   so the `.growth-panel` wrappers were drawing a second border inside the
   first. Charts now sit directly in the section.
4. **Prose moved behind question marks.** A new `InfoDot` reveals the
   explanation on hover or focus, with no JavaScript: it is a sibling element
   shown by `:focus-within`, and the trigger is a real button linked by
   `aria-describedby`. Section blurbs, metric definitions and the funnel
   caveats all live there now.
5. **Error codes are explained in place.** `src/lib/analytics/error-codes.ts`
   maps every JSON-RPC and application code to what it means and who to look at
   first. Hovering `-32602` in the reliability table now says "invalid params,
   the model is calling the tool wrongly, not the mailbox failing".
6. **New section: Active accounts.** The roster the page never had. One row per
   workspace with a successful call in the window, most recent first, with
   plan, comped and internal tags, last active, active days, sessions, calls,
   success rate, inboxes and providers. Four summary numbers above it:
   active accounts, sticky accounts (four or more active days), external share
   of calls, and median active days.
7. **Privacy contract updated, not quietly broken.** This roster names
   workspaces and owner email addresses, deliberately, at the owner's request.
   The page header now says exactly that instead of continuing to promise that
   no names or addresses appear. Nothing else changed: no credentials, message
   content, subjects, recipients or IP addresses are exposed anywhere.

### Bug found and fixed during this pass

The info dot inside a clickable stat card put a `<button>` inside a `<button>`,
which is invalid HTML: the parser unnests it and React hydration then fails
against a tree the server never produced. Cards became a `<div>` with a
full-bleed hit-area button behind the content, so the whole card stays
clickable and the dot is a real sibling control.

### What the roster immediately showed

53 active accounts in 28 days, but only **7 percent of calls come from an
external, non-comped account**: the volume is dominated by our own and comped
accounts. The median external account has **one** active day. 11 of 48 external
accounts are active on four or more days.

---

## 12. Third pass: the roster becomes a real table (2026-08-13)

Fifty-three rows, most of them accounts that tried the product once, is not a
useful default. The Active accounts table now:

- **Opens filtered to accounts that came back**, meaning more than one active
  day in the window. `All` is one click away and shows everyone.
- **Shows exactly one page of ten** when collapsed, and paginates in place. The
  wrapper holds a fixed minimum height so a short final page does not make the
  rest of the page jump. Expanding renders the whole filtered set and hides the
  pager.
- **Sorts on any column header**, with the direction toggling on a second
  click. Numbers and dates open largest-first, text opens A to Z. Ties break on
  workspace id so rows do not shuffle between renders.
- **Has a search field** matching owner email, workspace name, provider and
  plan. Changing filter, search or sort returns to page one.

All of it runs client-side over the array the server already fetched: at this
scale the roster is a few kilobytes and a round trip per keystroke would be
slower than the sort.

**Definition change.** "Sticky" (four or more active days) is now "Returned"
(more than one active day), used by both the summary card and the table filter
so the page has exactly one meaning for it. The number moved from 11 to 25.

### Bug found during this pass

The summary card read **0 returned** while the table's own filter found 25. The
shared `STICKY_MIN_ACTIVE_DAYS` constant was exported from the `'use client'`
table module, and a value imported from a client module into a Server Component
does not arrive as the value: React hands the server a client reference, so the
comparison ran against `undefined` and matched nothing. Constants both sides
need now live in `components/admin/growth/roster.ts`, outside the client
boundary. Worth remembering: this fails silently, with no type error and no
runtime warning.
