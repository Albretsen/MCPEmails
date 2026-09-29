# Google Ads test, 4,000 NOK (plus 4,000 NOK promo credit)

Written 2026-09-29. The point of this test is to **buy measurements**, not
customers. At our prices, break-even is roughly 2 to 4 NOK per click
(about $130 twelve-month value per payer, 3 to 7% signup-to-paid, about 4%
click-to-signup). Niche searches will likely cost 5 to 20 NOK. Expect around
500 clicks, around 20 signups and 0 to 2 sales. That is enough to learn cost
per click, which queries exist, and how many ad clickers sign up and connect a
mailbox. It is not enough to prove ads are profitable.

## What the site does for ad traffic (shipped with this doc)

- A click is recorded as **`google_ads`**, not `organic_google`, when the
  landing URL carries Google's auto-tagging click id (`gclid`, `gbraid`,
  `wbraid`), or `utm_source=google_ads`, or `utm_source=google&utm_medium=cpc`.
  Only the presence of the click id is read; its value is never stored. See
  `isGoogleAdsClick` in `apps/web/src/lib/acquisition-context.mjs`.
- `supabase/migrations/20260929190000_acquisition_source_google_ads.sql` must be
  **applied before the first ad runs**. Without it, the CHECK constraint rejects
  the value, or the signup trigger silently NULLs it.
- The growth board shows the channel as "Google Ads".
- Attribution is first touch for 30 days. Someone who found us organically and
  later clicks an ad stays organic. Ads are undercounted slightly, never
  overcounted.

**No Google tag, by decision.** The privacy policy promises a cookieless site
with no advertising cookies and no consent banner. The Google Ads conversion tag
sets advertising cookies, so adding it would need a consent banner (Consent
Mode v2) and a policy change. That is why bidding stays on Maximize Clicks and
results are read from our own database (below), not from the Ads UI. Revisit
only if ads pass the test and smart bidding becomes worth a banner.

## Campaign setup

| Setting | Value |
|---|---|
| Type | **Search only.** Not Performance Max, Display or Demand Gen. |
| Networks | Untick **Search Partners** and **Display Network**. |
| Bidding | Maximize Clicks, max CPC **15 NOK**. |
| Budget | About **100 NOK/day**. Check the promo deadline in Billing > Promotions (usually 60 days from the first ad) and make sure 4,000 NOK is spent before it. |
| Locations | US, UK, CA, AU, IE, NO, SE, DK, FI, DE, NL. "Presence: people in or regularly in". |
| Languages | English |
| Auto-tagging | **On** (Account settings). This is what `gclid` detection relies on. |
| Final URL suffix | `utm_source=google_ads&utm_medium=cpc&utm_campaign=product` (a backup in case auto-tagging is switched off; campaign names are bucketed, so the raw value is never stored). |
| Match types | Phrase and exact only. No broad match. |

### Ad groups, keywords, landing pages

Each ad group lands on its own page, so `acquisition_landing_path` tells the
groups apart in the read-out.

| Ad group | Keywords (phrase/exact) | Final URL |
|---|---|---|
| Claude | connect claude to gmail, claude email integration, claude gmail, claude outlook, claude read my email | `/blog/connect-claude-to-email` (22% of its signups pay, the best page on the site) |
| ChatGPT | chatgpt email connector, chatgpt gmail, chatgpt outlook, connect chatgpt to email | `/blog/connect-chatgpt-to-email` |
| MCP | email mcp server, gmail mcp, outlook mcp, imap mcp, mcp email | `/` |
| Providers | fastmail mcp, icloud mcp, yahoo mail ai, fastmail ai assistant | `/connect/fastmail`, `/connect/icloud`, `/connect/yahoo` (one ad group each if budget allows) |

**Negative keywords (account level):** jobs, job, career, course, tutorial,
what is, python, sdk, api key, github, download, open source, self hosted, free
download.

### Ad copy rules

- Lead with the multi-inbox angle: people who buy connect several mailboxes.
- Allowed claims: works in ChatGPT, Claude, Cursor and other MCP clients; Gmail,
  Outlook and any IMAP account; free plan.
- **Do not claim** SOC 2, any certification, a region choice, an Enterprise
  tier, or a specific price (Personal is moving from $5 to $9 in PR #32, so any
  price in an ad would go stale).

## Pass/fail, decided before launch

Read at the end of the spend (about 8,000 NOK including the credit). Take the
cost from the Ads UI and the counts from query A.

| Metric | Pass | Kill |
|---|---|---|
| Cost per **activated** signup (first tool call within 7 days) | under 150 NOK | over 400 NOK |
| CPC per ad group | under 5 NOK: keep | over 15 NOK: pause the group |
| Sales | any is a bonus; 1 or 2 are too few to judge | |

After 7 days, pause any keyword with spend and zero signups, and add any
irrelevant search terms from the Search terms report as negatives.

## Read-out queries

Set `start` to the day the first ad ran.

### A. Ad signups, activation and sales per landing page

```sql
with params as (select timestamptz '2026-10-01' as start)
select w.acquisition_landing_path as landing,
       count(*) as signups,
       count(*) filter (where exists (select 1 from product_funnel_events e
                                      where e.workspace_id = w.id and e.stage = 'first_tool_call'
                                        and e.occurred_at < w.created_at + interval '7 days')) as activated_7d,
       count(*) filter (where (select count(*) from inboxes i where i.workspace_id = w.id) >= 2) as two_plus_inboxes,
       count(b.paid_at) as paid,
       count(*) filter (where w.acquisition_email_segment = 'business') as business_domain
from workspaces w
join auth.users u on u.id = w.owner_id
left join billing_funnel_by_workspace b on b.workspace_id = w.id, params p
where w.deleted_at is null
  and not public.growth_is_internal_email(u.email)
  and w.acquisition_source = 'google_ads'
  and w.created_at >= p.start
group by 1 order by signups desc;
```

### B. Ads against the organic Google baseline over the same window

```sql
with params as (select timestamptz '2026-10-01' as start)
select w.acquisition_source as source, count(*) as signups,
       count(*) filter (where exists (select 1 from product_funnel_events e
                                      where e.workspace_id = w.id and e.stage = 'first_tool_call'
                                        and e.occurred_at < w.created_at + interval '7 days')) as activated_7d,
       count(b.paid_at) as paid
from workspaces w
join auth.users u on u.id = w.owner_id
left join billing_funnel_by_workspace b on b.workspace_id = w.id, params p
where w.deleted_at is null
  and not public.growth_is_internal_email(u.email)
  and w.acquisition_source in ('google_ads', 'organic_google')
  and w.created_at >= p.start
group by 1;
```

If `first_tool_call` rows turn out to be sparse, use
`workspaces.analytics_first_tool_reported_at` instead, as in
`MEASURE-business-domain-segment-20260929.md`.

## Before the first ad runs

1. Merge this branch and apply the migration (check the constraint afterwards:
   `select pg_get_constraintdef(oid) from pg_constraint where conname = 'workspaces_acquisition_source_check';`
   must list `google_ads`).
2. In Google Ads: turn auto-tagging on and set the final URL suffix.
3. Open one ad's final URL with `?gclid=test` in a private window, sign up with
   a throwaway address, and check the new workspace's `acquisition_source` is
   `google_ads`. Delete that workspace afterwards.
