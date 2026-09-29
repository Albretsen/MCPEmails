# MEASURE: the business-domain segment changes (2026-09-29)

How to read out the PR that recommends Pro to business-domain workspaces, asks
them for a second work mailbox, and points the site and the /connect pages at
the company-mailbox operator. Run it 2 to 4 weeks after the deploy.

## What shipped, and who sees it

| Change | Who | Where |
| --- | --- | --- |
| Inbox cap offers Pro first, badged Recommended, Personal outlined beside it | Business-shaped Free workspaces only | Connect modal paywall, Inboxes page notice |
| Optional "Add your other work mailboxes" row in the getting-started guide | Business-shaped workspaces with exactly 1 inbox | Overview |
| Pro badge reads "Recommended for company mailboxes" | Business-shaped workspaces | Settings, Billing |
| Hero line and pricing line to /for/business, operator FAQ | Everyone (marketing) | /, /pricing |
| "Every <host> mailbox on one agent" block + FAQ | Visitors of 42 business/hosting/cPanel/self-hosted /connect pages | /connect/* |
| New pages | Search traffic | /connect/google-workspace, /blog/multiple-email-accounts-in-claude-and-chatgpt |

"Business-shaped" is `isBusinessShapedWorkspace()` in
`apps/web/src/lib/segment/consumer-domains.mjs`: a connected mailbox on a
non-consumer domain, or the owner's own signup email on one. Consumers see no
product change.

## Before you read anything

1. **Apply the migration** `20260929140000_acquisition_email_segment.sql` in
   production. Until it is applied, the segment stamp and the prompt beacon
   fail quietly (logged, never user-facing) and record nothing.
2. **Backfill the segment** for workspaces created before the deploy, so the
   pre-period has a segment too. From `apps/web`, with prod env loaded:

   ```bash
   node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/backfill-email-segment.mjs
   ```

   That is a dry run (counts only). Add `--apply` to write.
3. **Write down the deploy date** and use it as `ship` below.
4. **Check for a confounder.** The Personal price change (PR #32, $5 to $9)
   moves the same paywall. If both ship in the same window, a before/after
   number on business workspaces mixes the two. Read the business segment
   AGAINST the consumer segment (the Pro-first change touches only business;
   the price change touches both), or ship them a read-out apart.

## Baseline (production, signups since 2026-08-01, internal excluded)

| | signups | paying | rate |
| --- | --- | --- | --- |
| Business domain | 222 | 17 | 7.7% |
| Consumer domain | 587 | 14 | 2.4% |

Business domains were 27% of signups, 55% of payers, and 7 of 10 Pro buyers.
87% of payers held two or more inboxes.

**n warning.** About 25 business signups a week. Four weeks is about 100
business signups and, at baseline, 7 or 8 payers. A difference of a few
points is inside the noise. Treat the thresholds below as tripwires for a
closer look, not as results.

## What would count as working

| # | Metric | Baseline | Working | Not working |
| --- | --- | --- | --- | --- |
| 1 | Business signups paying within 14 days | ~7.7% | 9% or better | under 6% |
| 2 | Pro share of business first purchases | 7 of 17 business payers bought Pro | half or more | unchanged or lower |
| 3 | Business workspaces with 2+ inboxes by day 7 | measure pre-period with query C | up | flat |
| 4 | Prompt click-through (clicked / shown) | new | 15% or better | under 5% |
| 5 | Guardrail: business first tool call within 24h | measure pre-period with query E | within 3 points of pre | drops more than 5 points |
| 6 | Guardrail: consumer conversion | 2.4% | unchanged (or explained by the price change) | drops with no other cause |
| 7 | Signups landing on /connect/google-workspace, the new post, and the 42 business-host pages | query F | any business signups from the new pages | none after 4 weeks |

## Queries

Run with `npx supabase db query --linked -f <file>.sql` from the repo root.
`--linked` is mandatory: without it the CLI queries an empty local database.
Run them one at a time, never in parallel. Replace `2026-10-01` with the real
deploy date everywhere.

### A. Conversion by segment, pre vs post

```sql
with params as (select timestamptz '2026-10-01' as ship, interval '28 days' as win),
w as (
  select w.id, w.created_at, w.acquisition_email_segment as seg,
         case when w.created_at >= p.ship then 'post' else 'pre' end as period
  from workspaces w join auth.users u on u.id = w.owner_id, params p
  where w.deleted_at is null
    and not public.growth_is_internal_email(u.email)
    and w.created_at >= p.ship - p.win and w.created_at < p.ship + p.win
)
select period, seg, count(*) as signups,
       count(*) filter (where b.paid_at < w.created_at + interval '14 days') as paid_14d,
       round(100.0 * count(*) filter (where b.paid_at < w.created_at + interval '14 days') / nullif(count(*), 0), 1) as pct
from w left join billing_funnel_by_workspace b on b.workspace_id = w.id
group by 1, 2 order by 2, 1 desc;
```

### B. Which plan business workspaces bought first

```sql
with params as (select timestamptz '2026-10-01' as ship, interval '28 days' as win)
select case when e.occurred_at >= p.ship then 'post' else 'pre' end as period,
       w.acquisition_email_segment as seg,
       split_part(e.category, '_', 1) as plan,   -- solo = Pro, personal = Personal, pro = Team
       count(distinct e.workspace_id) as workspaces
from product_funnel_events e
join workspaces w on w.id = e.workspace_id
join auth.users u on u.id = w.owner_id, params p
where e.stage = 'checkout_completed'
  and not public.growth_is_internal_email(u.email)
  and e.occurred_at >= p.ship - p.win and e.occurred_at < p.ship + p.win
group by 1, 2, 3 order by 2, 1 desc, 3;
```

### C. Two or more inboxes by day 7

```sql
with params as (select timestamptz '2026-10-01' as ship, interval '28 days' as win)
select case when w.created_at >= p.ship then 'post' else 'pre' end as period,
       w.acquisition_email_segment as seg,
       count(*) as signups,
       count(*) filter (where (select count(*) from inboxes i
                                where i.workspace_id = w.id
                                  and i.created_at < w.created_at + interval '7 days') >= 2) as two_plus_by_d7
from workspaces w join auth.users u on u.id = w.owner_id, params p
where w.deleted_at is null and not public.growth_is_internal_email(u.email)
  and w.created_at >= p.ship - p.win and w.created_at < p.ship + p.win
group by 1, 2 order by 2, 1 desc;
```

### D. The onboarding prompt: shown, clicked, and what followed

```sql
with shown as (
  select workspace_id, min(occurred_at) as at from product_funnel_events
  where stage = 'multi_inbox_prompt' and outcome = 'started' group by 1
), clicked as (
  select workspace_id, min(occurred_at) as at from product_funnel_events
  where stage = 'multi_inbox_prompt' and outcome = 'success' group by 1
)
select count(*) as shown,
       count(c.workspace_id) as clicked,
       count(*) filter (where exists (select 1 from product_funnel_events e
                                      where e.workspace_id = s.workspace_id and e.stage = 'paywall_reached'
                                        and e.occurred_at >= s.at)) as reached_paywall_after,
       count(*) filter (where (select count(*) from inboxes i where i.workspace_id = s.workspace_id) >= 2) as has_two_plus_now,
       count(b.paid_at) filter (where b.paid_at >= s.at) as paid_after
from shown s
left join clicked c using (workspace_id)
left join billing_funnel_by_workspace b on b.workspace_id = s.workspace_id;
```

### E. Guardrail: activation within 24 hours

```sql
with params as (select timestamptz '2026-10-01' as ship, interval '28 days' as win)
select case when w.created_at >= p.ship then 'post' else 'pre' end as period,
       w.acquisition_email_segment as seg,
       count(*) as signups,
       count(*) filter (where exists (select 1 from product_funnel_events e
                                      where e.workspace_id = w.id and e.stage = 'first_tool_call'
                                        and e.occurred_at < w.created_at + interval '24 hours')) as tool_call_24h
from workspaces w join auth.users u on u.id = w.owner_id, params p
where w.deleted_at is null and not public.growth_is_internal_email(u.email)
  and w.created_at >= p.ship - p.win and w.created_at < p.ship + p.win
group by 1, 2 order by 2, 1 desc;
```

If `first_tool_call` rows turn out to be sparse, use
`analytics_first_tool_reported_at` on `workspaces` instead.

### F. Signups from the new and upgraded pages

About half of all signups carry no attribution at all, so read these as
ratios, never as totals.

```sql
with params as (select timestamptz '2026-10-01' as ship)
select w.acquisition_landing_path as landing,
       w.acquisition_email_segment as seg,
       count(*) as signups,
       count(b.paid_at) as paid
from workspaces w
join auth.users u on u.id = w.owner_id
left join billing_funnel_by_workspace b on b.workspace_id = w.id, params p
where w.deleted_at is null and not public.growth_is_internal_email(u.email)
  and w.created_at >= p.ship
  and (w.acquisition_landing_path in ('/connect/google-workspace', '/blog/multiple-email-accounts-in-claude-and-chatgpt',
                                      '/connect/ionos', '/connect/zoho', '/connect/namecheap', '/connect/strato',
                                      '/connect/migadu', '/connect/office365', '/connect/imap', '/for/business')
       or w.acquisition_landing_path like '/connect/%')
group by 1, 2 order by 3 desc;
```

For search itself, check Google Search Console for impressions and clicks on
/connect/google-workspace and the new post (GSC days are Pacific time, and the
latest day is preliminary).

## Decision rule

- **1 and 2 both move and 5 holds:** keep it, and consider showing Pro first
  at the Personal-to-Pro step on the pricing page for business visitors too.
- **2 moves but 1 does not:** the recommendation shifts the mix toward Pro
  without adding buyers. Revenue per business payer still rises; check that
  refunds and early cancellations on Pro did not rise with it.
- **1 falls:** Pro-first is scaring off business buyers who would have bought
  Personal. Revert the order in `inboxCapOffer` (one function) and keep the
  prompt.
- **4 is under 5%:** the prompt is noise. Remove the row; the paywall change
  stands on its own.
- **5 drops:** the prompt is pulling people away from wiring up their client.
  Move it out of the guide to after the first tool call.
