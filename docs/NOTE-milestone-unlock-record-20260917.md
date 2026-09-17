# Where the recorded milestone days came from

**2026-09-17.** `/admin/growth` showed eighteen milestones under "Reached, day
unknown". The panel was right to refuse them a date: it only dates a rung its
own inputs can walk back to, and Stripe is read as a snapshot, the lifecycle
RPC returns counts rather than a history, a streak is a length rather than an
event, and `activity_log` is purged at 90 days.

None of that made the days unknowable. Each one was one query away, in a table
the milestone panel does not read. This note is what was run, against
production, and what came back. The answers live in
`apps/web/src/lib/analytics/growth-milestone-record.ts`; this file is the
working that produced them.

Every query excludes internal accounts the same way the board does, through
`growth_is_internal_email` with `internal_account_emails()` and
`internal_account_domains()`.

---

## Money: MRR and paying customers

Stripe holds the real prices, and the production `STRIPE_SECRET_KEY` cannot be
read from a laptop (`vercel env pull` returns it empty; the local key is a test
key). So the money series was rebuilt from `user_billing` start dates priced at
the list prices in `src/lib/stripe/plans.ts`: Personal $5/mo and $48/yr, Pro
(`solo`) $15/mo and $144/yr, normalised to a month exactly as
`monthlyFromInterval` does.

```sql
with subs as (
  select u.email, b.plan,
         b.current_period_start as started_at,
         case
           when b.plan = 'personal' then case when b.current_period_end - b.current_period_start > interval '300 days' then 400 else 500 end
           when b.plan = 'solo'     then case when b.current_period_end - b.current_period_start > interval '300 days' then 1200 else 1500 end
           when b.plan = 'pro'      then case when b.current_period_end - b.current_period_start > interval '300 days' then 6300 else 7900 end
           else 0 end as monthly_minor
  from public.user_billing b
  join public.users u on u.id = b.user_id
  where b.subscription_status = 'active'
    and b.plan <> 'free'
    and not public.growth_is_internal_email(u.email)
)
select row_number() over (order by started_at) as n,
       (started_at at time zone 'utc')::date as day,
       plan,
       monthly_minor,
       sum(monthly_minor) over (order by started_at rows between unbounded preceding and current row) as cum_mrr
from subs order by n;
```

| n | day | plan | +MRR | MRR after |
|---|-----|------|------|-----------|
| 1 | 2026-08-29 | personal year | 400 | 400 |
| 2 | 2026-08-29 | personal month | 500 | 900 |
| **3** | **2026-08-31** | personal month | 500 | **1400** → crosses $10 |
| 4 | 2026-09-01 | personal year | 400 | 1800 |
| 5 | 2026-09-01 | personal month | 500 | 2300 |
| **6** | **2026-09-02** | solo year | 1200 | **3500** → crosses $25 |
| 7 | 2026-09-05 | personal month | 500 | 4000 |
| 8 | 2026-09-05 | personal month | 500 | 4500 |
| **9** | **2026-09-05** | solo month | 1500 | **6000** → crosses $50 |
| 10 | 2026-09-07 | solo month | 1500 | 7500 |
| 11 | 2026-09-13 | solo month | 1500 | 9000 |
| 12 | 2026-09-14 | personal year | 400 | 9400 |
| **13** | **2026-09-14** | solo month | 1500 | **10900** → crosses $100 |
| 14-20 | 2026-09-14 … 2026-09-16 | mixed | | 16400 |

**Two checks that the reconstruction matches Stripe.** At subscription 17 the
running total is exactly $139.00, the MRR read off the live board on 2026-09-15
and recorded that day. Summing the same subscriptions as charges rather than as
MRR gives $403, the cash Stripe had collected all time on the same date. Both
would break if any external subscription carried a coupon; none does.

Paying customers is the same ordering, counted rather than summed: number 1 on
2026-08-29, number 5 on 2026-09-01, number 10 on 2026-09-07.

## People: reached a mailbox

`growth_lifecycle_counts` counts live workspaces carrying
`onboarding_value_activated_at`. That column is durable, so the crossings are
just the Nth of them in time.

```sql
with a as (
  select (onboarding_value_activated_at at time zone 'utc')::date as d,
         row_number() over (order by onboarding_value_activated_at) as n
  from public.workspaces
  where onboarding_value_activated_at is not null and deleted_at is null
)
select (select d from a where n = 50) as a50,
       (select d from a where n = 100) as a100,
       (select d from a where n = 250) as a250,
       (select count(*) from a) as total;
```

50 on **2026-08-11**, 100 on **2026-08-21**, 250 on **2026-09-11**, 310 in
total. Re-running without the `deleted_at` filter (313 rows) moves none of the
three days, so workspaces deleted since do not change the answer.

## People: active in a week

`active_7d` is distinct workspaces with a successful call in a rolling seven
day window, so the series has to be rebuilt day by day from `activity_log`.

```sql
with days as (
  select generate_series(date '2026-06-19', date '2026-09-17', interval '1 day')::date as d
), acts as (
  select distinct workspace_id, (created_at at time zone 'utc')::date as d
  from public.activity_log where status = 'success'
), rolling as (
  select d.d,
         (select count(distinct a.workspace_id) from acts a where a.d between d.d - 6 and d.d) as active_7d
  from days d
)
select (select min(d) from rolling where active_7d >= 50) as first_50,
       (select min(d) from rolling where active_7d >= 100) as first_100;
```

50 on **2026-08-17**, 100 on **2026-08-31**. The log starts on 2026-06-19 (the
90 day purge horizon) and the rolling figure there is 3, so neither crossing is
an artefact of the window opening.

## People and usage: signup streaks and record days

Both come from the same all-time daily signup series the board already reads,
just walked for events it does not look for.

```sql
with s as (
  select day, new_users
  from public.growth_user_signup_days(400, public.internal_account_emails(), public.internal_account_domains())
), runs as (
  select day, new_users, sum(case when new_users = 0 then 1 else 0 end) over (order by day) as grp from s
), streak as (
  select day, grp,
         case when new_users > 0 then row_number() over (partition by grp order by day) else 0 end as run_len
  from runs
)
select (select min(day) from streak where run_len >= 7) as streak_7,
       (select min(day) from streak where run_len >= 14) as streak_14,
       (select min(day) from streak where run_len >= 30) as streak_30,
       (select min(day) from s where new_users >= 10) as day_10,
       (select min(day) from s where new_users >= 25) as day_25;
```

A run of daily signups first reached 7 on **2026-06-28**, 14 on **2026-08-15**
and 30 on **2026-08-31**. The first day with 10 or more signups was
**2026-08-10**; with 25 or more, **2026-09-07**. The 400 day window opens on
2025-08-14 and the first signup ever is 2026-05-26, so nothing is cut off at the
start. The run rule matches `streak()` in `growth-records.ts`: consecutive days
with at least one signup.

## Reliability: 30 days serving calls

This is the one entry that is a lower bound.

```sql
with days as (
  select generate_series(date '2026-06-19', date '2026-09-17', interval '1 day')::date as d
), hits as (
  select d.d,
         exists (select 1 from public.activity_log a
                 where a.status = 'success' and (a.created_at at time zone 'utc')::date = d.d) as served
  from days d
), grp as (
  select d, served, sum(case when served then 0 else 1 end) over (order by d) as g from hits
), runs as (
  select d, case when served then row_number() over (partition by g order by d) else 0 end as run_len from grp
)
select (select min(d) from runs where run_len >= 30) as first_30,
       (select min(d) from hits where not served) as first_gap;
```

The run reaches 30 on **2026-07-18**, measured from 2026-06-19, the oldest day
the purged log still holds. Calls were certainly being served before that, so
the true crossing is that day or earlier, never later. Also worth keeping: the
only day since 2026-06-19 with no successful call at all is **2026-07-29**.

Durable evidence of service before the log window is too sparse to push the
start earlier: between 2026-05-26 and 2026-06-18 only seven days carry a
first-activation, a first tool use or a scheduled send, so no unbroken earlier
run can be proved.

---

## What is not recorded, and why

`mrr-25000` and up, `paying-25` and up, `activated-500`, `active-7d-250`,
`signup-streak-60` and the rest are not here because they have not happened.
When they do, they will land in the undated pile until someone reruns the
relevant query above and adds a line to the record. The pile is still rendered
for exactly that reason.
