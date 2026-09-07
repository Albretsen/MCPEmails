# PLAN: the multi-mailbox business segment

Status: planning document. Nothing here is implemented.
Written 2026-09-07. All figures verified against live prod (`npx supabase db query --linked`) on 2026-09-07.

---

## 0. Naming trap, stated once

Internal plan id `solo` IS customer-facing **"Pro"** ($15/mo, $144/yr, unlimited inboxes, `maxMembers: 1`).
Internal plan id `pro` IS customer-facing **"Team"** ($79/mo).
Internal `personal` IS "Personal" ($5/mo, $48/yr, 3 inboxes).
See `apps/web/src/lib/stripe/plans.ts:23` and the catalogue at `apps/web/src/lib/stripe/plans.ts:151-305`.

A funnel row reading `solo_year` and a Stripe invoice line reading "MCP Emails Pro" are the same thing. This document uses the customer-facing names and marks the internal id when it matters.

---

## 1. Executive summary

The thesis is **half right, and the half that is wrong matters more than the half that is right.**

**Right:** there is a measurable, statistically separable business segment, and it is where essentially all the revenue is. Defining it as *"the workspace has connected at least one mailbox on a custom (non-consumer) domain"* gives 105 of 266 connected workspaces. That segment converts at **7.6% versus 1.2%** (Fisher exact p = 0.016), activates at **82% versus 63%** (p = 0.0014), is **66% versus 48%** active at 7 days (p = 0.0079), runs **5.5x the action volume**, and supplies **8 of 10 paying customers and $62 of ~$72 monthly MRR (86%)**. At the paywall the gap is starker still: **6 of 23 (26%)** business-shaped workspaces that hit the inbox cap went on to pay, against **2 of 53 (3.8%)** of everyone else (p = 0.008).

**Wrong:** the claim that this segment "naturally expands the inbox-count value metric" does not survive measurement. Across the product's entire history, **83% of all inboxes are connected within one hour of signup and only 2% are ever added after day 7**. Restricting to workspaces that were *never capped* (grandfathered or paid, so adding later was always permitted), the picture barely changes: 78% on day one, 95% by day seven, **six inboxes in total ever added after day 7**. massif did not grow from 3 to 9 over five days. It connected 8 mailboxes between 19:24 and 20:20 on 2026-09-02 (a 56 minute burst), added a ninth the next day, and has added nothing since.

So the correct reframe is: **inbox count is a setup-time decision, not an expanding one.** The metric can *reach* higher values in this segment (massif 9, one grandfathered account 7, four at 5), but it does not *grow*. The prior memory claim that the metric "cannot expand" ([[project_funnel_benchmarks_20260902]]) is right about the mechanism and wrong about the conclusion it drew: the fix is not to find an expanding metric, it is to **get the first purchase priced correctly in the first hour**, because that is the only hour that exists.

**The loudest counter-evidence, which must not be buried:** massif, the single largest sale and the anecdote this whole thesis rests on, has **2 billable actions ever**, last activity 2026-09-03, and `last_sync_at IS NULL` on 8 of its 9 inboxes. It paid $144 for a year and then stopped. If that is the segment's modal behaviour rather than an outlier, this is a high-conversion, high-churn segment and the annual billing is the only thing hiding it.

**n is brutal.** 10 paying customers. The oldest has been paying 9 days. Real churn is zero, but zero churn over nine days is not retention data. Every conversion-rate comparison in this document rests on 8 versus 2 payers. The engagement and activation comparisons rest on n = 105 versus 161 and are much better supported.

---

## 2. Baseline: what is actually true today

Verified 2026-09-07 against prod.

| Metric | Value |
| --- | --- |
| Workspace rows ever created | 423 |
| Not soft-deleted | 404 |
| External (excluding `bjellanda@gmail.com` and `hello@mcpemails.com`) | 399 |
| External **and** has at least one live inbox | 266 |
| Live inboxes | 343 |
| Completed checkouts, all time | 11 |
| Active external paying customers | 10 |
| Normalised MRR | ~$72 to $75 |
| Real customer churn | **0** (the one `canceled` row is `bjellanda+test@gmail.com`) |
| Non-owner workspace members, ever | **0** (404 `workspace_members` rows, all owners) |
| Owners with more than one workspace | **1** (Asgeir) |

Completed checkouts by plan, from `product_funnel_events`:

| category | n | first | last |
| --- | --- | --- | --- |
| `personal_month` | 6 | 2026-08-29 | 2026-09-05 |
| `personal_year` | 2 | 2026-08-29 | 2026-09-01 |
| `solo_month` (Pro) | 2 | 2026-09-05 | 2026-09-07 |
| `solo_year` (Pro) | 1 | 2026-09-02 | 2026-09-02 |
| `pro_*` (Team) | **0** | | |

Note the correction to the brief: the "one churn" is Asgeir's own test account, not a customer. Real churn is 0 of 10, but so is elapsed time.

### The full paying roster

Internal accounts excluded. `plan` is the internal id.

| owner | plan | inboxes (live) | inbox domains | providers | billable actions | last action | signed up | paid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `justincox@pacificwest.com` | personal | 3 (at cap) | 2 | yahoo | **2862** | 09-07 | 07-22 | 09-01 |
| `kirill@unconditional.studio` | personal | 3 (at cap) | 3 | gmail, icloud | 902 | 09-07 | 08-27 | 08-27 |
| `photo@orbispro.com` | personal | 3 (at cap) | 1 | yandex | 844 | 09-07 | 09-05 | 09-05 |
| `darylhawkins1@gmail.com` | personal | 1 | 1 | icloud | 202 | 09-07 | 08-29 | 08-29 |
| `catchdeepie@gmail.com` | personal | 2 | 2 | generic imap | 41 | 09-06 | 09-05 | 09-05 |
| `mazent@me.com` | personal | 1 | 1 | icloud | 35 | 09-05 | 08-31 | 08-31 |
| `claudiu@creatifsociety.com` | personal | 2 | 2 | generic imap | 34 | 09-04 | 09-01 | 09-01 |
| `mohsinkazi1983@yahoo.com` | **solo (Pro)** | 4 | 4 | gmail, yahoo, zoho | 29 | 09-07 | 09-07 | 09-07 |
| `damian@meetdmri.com` | **solo (Pro)** | **1** | 1 | generic imap | 44 | 09-05 | 08-26 | 09-05 |
| `finanzas@massif.mx` | **solo (Pro)** | **9** | 2 | generic imap, gmail | **2** | **09-03** | 09-02 | 09-02 |

Read that table carefully before accepting the thesis. Of the three Pro sales:

- **massif** is the departmental case, and it is the least engaged account in the roster.
- **`damian@meetdmri.com`** bought Pro (unlimited inboxes) while running **one** inbox. He did not buy inbox count.
- **`mohsinkazi1983@yahoo.com`** has 4 inboxes across 4 *different* domains (yahoo personal, `biosciglobal.net`, gmail, `bclean.ca`). That is a multi-business individual, which is the persona Pro's copy already describes ("each side business"), not a departmental business.

So "Pro sells to departmental businesses" is currently **n = 1**.

---

## 3. Segment definition and size

### 3.1 The four candidate signals, tested

I built a classifier over `workspaces` joined to `auth.users` and `inboxes`, with a consumer-domain list of 120 free mail domains and a role-prefix list of 90 department words. Full SQL in §3.4.

Comparison is restricted to the **266 external workspaces that connected at least one inbox**, because three of the four signals are only observable after a connect and comparing them against 133 workspaces that never connected would smuggle the connect step into the result.

| Signal | matches | n | paying | conv | activated | avg actions | median | active 7d | avg inboxes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **D. any inbox on a business domain** | yes | **105** | **8** | **7.6%** | 82% | **715** | 29 | **66%** | 1.64 |
| | no | 161 | 2 | 1.2% | 63% | 131 | 9 | 48% | 1.02 |
| B. owner email on a custom domain | yes | 76 | 6 | 7.9% | 75% | 411 | 28 | 63% | 1.47 |
| | no | 190 | 4 | 2.1% | 69% | 341 | 14 | 52% | 1.18 |
| A. owner email is a role address | yes | 15 | 2 | 13.3% | 87% | 115 | 6 | 73% | 1.87 |
| | no | 250 | 8 | 3.2% | 70% | 336 | 16 | 54% | 1.23 |
| E. connects via generic IMAP | yes | 105 | 4 | 3.8% | 77% | 683 | 21 | 61% | 1.52 |
| | no | 161 | 6 | 3.7% | 66% | 151 | 15 | 52% | 1.10 |

Two-sided Fisher exact on the conversion contrasts:

| contrast | p |
| --- | --- |
| D, paying 8/105 vs 2/161 | **0.0159** |
| B, paying 6/76 vs 4/190 | 0.0348 |
| A, paying 2/15 vs 8/250 | 0.1035 (not significant) |
| D, activation 86/105 vs 102/161 | **0.0014** |
| D, active-7d 69/105 vs 78/161 | **0.0079** |
| paywall reached then paid, biz 6/23 vs 2/53 | **0.0081** |

### 3.2 What each signal is actually worth

**Signal D wins and should be the operational definition.** It is the only one that is significant on conversion, activation and retention simultaneously, it has the largest effect size, and it has a usable n. Definition to adopt:

> **Business segment** = a workspace with at least one live inbox whose email domain is not on the consumer free-mail list.

Size today: **105 of 266 connected external workspaces (39%)**, and 111 of 399 external workspaces if you count business-domain *signups* whether or not they connected.

**Signal A (role address) does not hold up, and it is a trap.** It looked spectacular at first (752 average actions) until I noticed the cohort contained `hello@mcpemails.com`, our own operational account with 10,307 actions. Excluded, the role-address cohort's average actions **collapse from 752 to 115 and the median from 14 to 6, both below the non-role group** (336 / 16). Role addresses connect more inboxes (1.87 vs 1.23) and convert at a higher rate, but they **use the product less**. Two of the fifteen paid; p = 0.10; do not treat this as established. It is a useful *marketing* targeting signal and a poor *value* signal.

**Signal E (generic IMAP) separates engagement but not payment.** 683 vs 151 average actions, 61% vs 52% active at 7 days, but conversion is 3.8% vs 3.7%: identical. This is a real correction to [[project_acquisition_ranking_20260831]], which ranked generic IMAP the best cohort on retention. That still holds. It just does not follow that they buy. Generic IMAP is a *retention* channel and, so far, not a *revenue* channel on its own; it becomes one only when the mailbox is on a business domain (86% of generic-IMAP inboxes are, which is why D and E overlap on 82 of 105 workspaces).

**Signals C and F (multi-inbox) are tautological and must be discarded.** "Workspaces with 2 or more live inboxes convert at 22.6%" is not a finding, it is the paywall. Free caps at 1 inbox, so the only ways to hold 2+ are to be grandfathered or to pay. Proof:

| cohort | n | paying |
| --- | --- | --- |
| all workspaces with 2+ live inboxes | 31 | 7 |
| of which grandfathered (`unlimited_inboxes`) | 24 | **0** |
| of which not grandfathered | 7 | **7 (100%)** |

Anyone quoting a multi-inbox conversion rate is quoting the cap back at themselves.

### 3.3 Revenue concentration

Monthly-normalised MRR of $72 (annual plans amortised; `kirill` carries a one-off `THANKSKIRILL` coupon in year one):

| slice | payers | MRR | share |
| --- | --- | --- | --- |
| **has a business-domain inbox (D)** | 8 | **$62** | **86%** |
| owner on a custom domain (B) | 6 | $45 | 63% |
| 2+ live inboxes | 7 | $47 | 65% |
| role address (A) | 2 | $17 | 24% |

39% of the connected base produces 86% of revenue. That is the single strongest number in this document.

### 3.4 The SQL

Classifier (written to a scratch file and concatenated ahead of each analysis query, because `supabase db query` does not support `\i`):

```sql
create temp view seg as
with consumer_domains as (
  select unnest(array[
    'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.co.in','yahoo.fr','yahoo.de',
    'yahoo.es','yahoo.it','yahoo.ca','yahoo.com.br','yahoo.com.au','ymail.com','rocketmail.com',
    'icloud.com','me.com','mac.com','outlook.com','outlook.es','outlook.fr','outlook.de',
    'outlook.com.br','hotmail.com','hotmail.co.uk','hotmail.fr','hotmail.es','hotmail.it',
    'hotmail.de','live.com','live.co.uk','live.nl','msn.com','aol.com',
    'proton.me','protonmail.com','pm.me','yandex.com','yandex.ru','ya.ru','mail.ru','bk.ru',
    'inbox.ru','list.ru','gmx.com','gmx.de','gmx.net','web.de','t-online.de','freenet.de',
    'zoho.com','fastmail.com','fastmail.fm','hey.com','duck.com','tutanota.com','tuta.io',
    'mailfence.com','posteo.de','runbox.com','migadu.com',
    'qq.com','163.com','126.com','sina.com','naver.com','daum.net','hanmail.net','rediffmail.com',
    'comcast.net','verizon.net','att.net','sbcglobal.net','cox.net','charter.net','bellsouth.net',
    'earthlink.net','optonline.net','roadrunner.com','frontier.com',
    'btinternet.com','sky.com','virginmedia.com','talktalk.net','orange.fr','free.fr','laposte.net',
    'wanadoo.fr','sfr.fr','bbox.fr','libero.it','virgilio.it','alice.it','tin.it','tiscali.it',
    'terra.com','uol.com.br','bol.com.br','ig.com.br','globo.com',
    'online.no','hotmail.no','live.no','telenor.no','ziggo.nl','telenet.be','xs4all.nl','home.nl',
    'planet.nl','seznam.cz','wp.pl','onet.pl','o2.pl','interia.pl','abv.bg','mail.com','email.com',
    'usa.com','gmx.co.uk','yopmail.com','mailinator.com'
  ]) as d
),
role_prefixes as (
  select unnest(array[
    'info','contact','contacto','hello','hola','hi','admin','administracion','office','mail','email',
    'team','sales','ventas','venta','support','soporte','help','billing','facturacion','facturas',
    'finanzas','finance','accounts','accounting','contabilidad','photo','photos','foto','marketing',
    'press','prensa','media','hr','rrhh','jobs','careers','recruit','noreply','no-reply','donotreply',
    'service','services','servicio','orders','pedidos','shop','store','booking','bookings','reservas',
    'reservations','reception','recepcion','front','frontdesk','desk','enquiries','enquiry',
    'inquiries','general','main','all','staff','operations','ops','logistica','logistics','compras',
    'purchasing','legal','it','tech','webmaster','postmaster','abuse','projects','proyect','proyectos',
    'realestate','clientes','customers','cs','crm','newsletter','news','events','eventos','partners',
    'biz','business','company','empresa','dev','api','data','studio','agency'
  ]) as p
)
select
  w.id as ws_id, w.owner_id, w.created_at, w.plan, w.deleted_at, w.acquisition_source,
  u.email as owner_email,
  lower(split_part(u.email,'@',1)) as local_part,
  lower(split_part(u.email,'@',2)) as owner_domain,
  -- A: role address
  (lower(regexp_replace(split_part(u.email,'@',1),'[^a-zA-Z-]','','g'))
     in (select p from role_prefixes)) as sig_role,
  -- B: custom (non-consumer) owner domain
  (lower(split_part(u.email,'@',2)) not in (select d from consumer_domains)) as sig_custom_domain,
  (select count(*) from inboxes i
     where i.workspace_id=w.id and i.deleted_at is null) as inbox_live,
  (select count(*) from inboxes i where i.workspace_id=w.id) as inbox_ever,
  -- C: 2+ live inboxes sharing one domain
  coalesce((select max(c) from (
     select count(*) c from inboxes i
     where i.workspace_id=w.id and i.deleted_at is null
     group by lower(split_part(i.email_address,'@',2))) x),0) as max_same_domain,
  -- D: any live inbox on a non-consumer domain   <-- THE definition
  exists (select 1 from inboxes i where i.workspace_id=w.id and i.deleted_at is null
     and lower(split_part(i.email_address,'@',2)) not in (select d from consumer_domains))
     as sig_biz_inbox,
  -- E: generic IMAP
  exists (select 1 from inboxes i where i.workspace_id=w.id and i.deleted_at is null
     and i.service='generic') as sig_generic_imap,
  (select count(*) from action_usage a
     where a.workspace_id=w.id and a.billable) as billable_actions,
  (select max(a.occurred_at) from action_usage a where a.workspace_id=w.id) as last_action_at,
  exists (select 1 from user_billing ub where ub.user_id=w.owner_id
     and ub.subscription_status in ('active','trialing') and ub.plan<>'free') as paying,
  (select ub.plan from user_billing ub
     where ub.user_id=w.owner_id and ub.subscription_status is not null limit 1) as billing_plan
from workspaces w
join auth.users u on u.id=w.owner_id;
```

The signal comparison in §3.1:

```sql
with b as (
  select * from seg
  where deleted_at is null
    and owner_email not like 'bjellanda%'
    and owner_email <> 'hello@mcpemails.com'   -- our own ops account, 10,307 actions
    and inbox_live >= 1
),
sig as (
  select 'A role address' k, sig_role v, * from b
  union all select 'B custom owner domain', sig_custom_domain, * from b
  union all select 'D business-domain inbox', sig_biz_inbox, * from b
  union all select 'E generic IMAP inbox', sig_generic_imap, * from b
)
select k signal, v matches, count(*) n,
  count(*) filter (where paying) paying,
  round(100.0*count(*) filter (where paying)/count(*),1) conv_pct,
  count(*) filter (where billable_actions>0) activated,
  round(avg(billable_actions)::numeric,0) avg_actions,
  percentile_cont(0.5) within group (order by billable_actions)::int med_actions,
  count(*) filter (where last_action_at > now()-interval '7 days') a7d,
  round(avg(inbox_live)::numeric,2) avg_inbox
from sig group by k, v order by k, v desc;
```

The endogeneity check that killed the multi-inbox signal:

```sql
with b as (select * from seg where deleted_at is null and owner_email not like 'bjellanda%')
select
  count(*) filter (where inbox_live>=2) all_multi,
  count(*) filter (where inbox_live>=2 and paying) all_multi_paying,
  count(*) filter (where inbox_live>=2 and exists (
     select 1 from user_usage_entitlements e
     where e.user_id=b.owner_id and e.unlimited_inboxes)) grandfathered,
  count(*) filter (where inbox_live>=2 and paying and exists (
     select 1 from user_usage_entitlements e
     where e.user_id=b.owner_id and e.unlimited_inboxes)) grandfathered_paying
from b;
```

---

## 4. Testing the expansion claim

This is where the thesis breaks, so the method matters.

### 4.1 When are inboxes actually connected?

All 365 inboxes ever created by external non-internal workspaces, bucketed by offset from workspace creation:

| bucket | inboxes | share |
| --- | --- | --- |
| within 1 hour of signup | 304 | **83%** |
| same day | 33 | 9% |
| day 2 to 7 | 21 | 6% |
| day 8 to 30 | 4 | 1% |
| after day 30 | 3 | 0.8% |

The obvious objection is that Free caps at 1 inbox, so later additions are *forbidden*, not merely unobserved. So the test has to be run on workspaces that were **never capped**: grandfathered (`user_usage_entitlements.unlimited_inboxes`) or on a paid plan.

| bucket, uncapped cohort only | inboxes | share |
| --- | --- | --- |
| within 1 hour of signup | 64 | 59% |
| same day | 20 | 19% |
| day 2 to 7 | 18 | 17% |
| day 8 to 30 | 4 | 4% |
| after day 30 | 2 | 2% |
| **total** | **108** | |

**78% on day one, 95% by day seven, six inboxes ever added after day seven, in the whole cohort, across the product's entire history.** The cap is not the explanation. Inbox count is chosen at setup.

```sql
with b as (
  select *, exists(select 1 from user_usage_entitlements e
     where e.user_id=seg.owner_id and e.unlimited_inboxes) gf
  from seg where deleted_at is null
    and owner_email not like 'bjellanda%' and owner_email <> 'hello@mcpemails.com'
)
select case
   when i.created_at <= b.created_at + interval '1 hour' then '1. within 1 hour'
   when i.created_at <= b.created_at + interval '1 day'  then '2. same day'
   when i.created_at <= b.created_at + interval '7 days' then '3. day 2-7'
   when i.created_at <= b.created_at + interval '30 days' then '4. day 8-30'
   else '5. after day 30' end bucket,
 count(*) inboxes_added, count(distinct i.workspace_id) workspaces
from inboxes i join b on b.ws_id = i.workspace_id
where b.gf or b.paying          -- drop this line for the all-workspaces version
group by 1 order by 1;
```

### 4.2 Every late addition, named

The complete list of inboxes ever added more than 7 days after signup:

| offset | owner | added | paying |
| --- | --- | --- | --- |
| day +12 | `tor.jetix16@gmail.com` | `torstein@vikse.dev` | no (grandfathered, 40,314 actions) |
| day +13 | `stadlerus.media@gmail.com` | `mb@cybercore.cc` | no (grandfathered) |
| day +21 | `hoangkhaihoan190298@gmail.com` | a second gmail | no (grandfathered) |
| day +23 | `info@globaleconcepts.com` | `info@titanorelabs.com` | no (grandfathered, 637 actions) |
| day +42 | `justincox@pacificwest.com` | `cox@westpacific.net` | **yes, Personal** |
| day +42 | `justincox@pacificwest.com` | `westcoastdesign123@yahoo.com` | **yes, Personal** |
| day +47 | `contact@baptistejeannerod.com` | own domain | no |

One data point supports the pay-then-expand story: `justincox` paid on 09-01 and added two mailboxes on 09-02, day 42 of his account. That is the only paid expansion event in the product's history. n = 1.

### 4.3 What massif actually did

The anecdote, from `inboxes.created_at`:

```
09-02 19:24:08  finanzas@massif.mx        (signup + first inbox)
09-02 20:02:06  proyect@massif.mx
09-02 20:02:52  realestate@massif.mx
09-02 20:05:55  facturas@massif.mx
09-02 20:06:30  administracion@massif.mx
09-02 20:07:22  mesmenjaud@massif.mx
09-02 20:17:48  hola@massif.mx
09-02 20:20:29  jcp@massif.mx
09-03 17:19:10  admonmassif@gmail.com
```

Eight mailboxes in 56 minutes, six of them unambiguously departmental (`finanzas`, `proyect`, `realestate`, `facturas`, `administracion`, `hola`), plus two named-person mailboxes and one Gmail. Then nothing for four days.

The persona claim in [[project_first_pro_sale_massif_20260902]] is confirmed exactly: one operator, many company mailboxes. The *expansion* framing is not. "Grew from 3 to 9 since paying" is true only in the sense that the paywall interrupted a setup session that was always going to end at 9.

**And 8 of the 9 inboxes have `last_sync_at IS NULL`. The workspace has 2 billable actions, ever.** The best customer by revenue is, by usage, the worst.

### 4.4 Does being business-shaped predict more inboxes at all?

Cleanest possible test: restrict to the uncapped cohort (no censoring in either direction) and compare inbox counts.

| cohort (uncapped, at least 1 inbox) | n | avg inboxes | median | max | needing 4+ |
| --- | --- | --- | --- | --- | --- |
| business-domain owner | 12 | 3.42 | 3 | 9 | 4 |
| consumer-domain owner | 15 | 3.27 | 3 | 7 | 4 |
| has a business-domain inbox | 24 | 3.46 | 3 | 9 | 8 |
| consumer inboxes only | 3 | 2.33 | 2 | 3 | 0 |

**3.42 versus 3.27 is nothing.** With no cap in the way, business-shaped users connect the same number of mailboxes as everyone else. What differs is the tail: the maximum (9) and the second-highest (7) are both business accounts, and 8 of the 24 accounts holding a business inbox need 4 or more.

The full uncensored demand curve, uncapped workspaces with 2+ inboxes (n = 24, consistent with the n = 25 recorded in [[project_pro_repriced_15_20260901]]):

| inboxes | workspaces |
| --- | --- |
| 2 | 9 |
| 3 | 9 |
| 4 | 1 |
| 5 | 4 |
| 7 | 1 |
| 9 | 1 (massif, paid) |

**75% of real multi-inbox demand fits inside Personal's 3-inbox cap.** The cap is not misplaced for the median. It is misplaced for the tail, and the tail is where the money is: massif alone is 17% of MRR.

### 4.5 Verdict on expansion

| claim | verdict |
| --- | --- |
| "Departmental businesses are a distinct, higher-value segment" | **Supported** (p = 0.016 on conversion, p = 0.0014 on activation, 86% of MRR) |
| "The inbox value metric cannot expand" ([[project_funnel_benchmarks_20260902]]) | **Mechanically right, strategically misleading.** It can reach 9. It just does not grow after hour one. |
| "This segment naturally expands the inbox metric over time" | **Not supported.** 95% of all inbox connections happen inside seven days even when nothing prevents later ones. |
| "massif went 3 to 9, that is expansion" | **Refuted.** It went 1 to 9 in 56 minutes and has been flat for four days. |
| "More inboxes means more engagement" | **Not in this segment.** massif: 9 inboxes, 2 actions. |

**Strategic consequence:** stop looking for expansion mechanics. Optimise the first hour. A customer who lands on the right tier at setup is worth more than any number of upgrade nudges shipped afterwards, because after day 7 the account's inbox count is effectively frozen.

---

## 5. Evidence against the thesis

Stated as fairly as I can make it.

**5.1 The flagship customer does not use the product.** massif: 9 inboxes, 2 billable actions, 8 of 9 mailboxes never synced, silent since 2026-09-03. It bought annual, so it will not visibly churn until 2027-09-02. If setup-then-abandon is the segment's pattern, the annual billing is concealing a retention problem for twelve months.

**5.2 Role addresses convert but do not engage.** Excluding our own `hello@mcpemails.com`, role-address workspaces average 115 billable actions with a median of 6, against 336 / 16 for everyone else. The most "obviously business" signal is the weakest usage signal in the set.

**5.3 Half of business-shaped signups never reach value.** Of 111 external business-domain signups: 31 (28%) never connected an inbox at all, 19 (17%) connected and never made a billable call, 48 (43%) were active in the last 7 days, 6 (5.4%) pay. The segment is better than baseline, not good in absolute terms.

**5.4 Two of three Pro sales are not departmental.** `damian@meetdmri.com` bought unlimited inboxes while holding one. `mohsinkazi1983@yahoo.com` holds 4 inboxes on 4 different domains, which is the "each side business" persona Pro's existing copy already targets. The departmental Pro sale is n = 1.

**5.5 The Personal 3-inbox cap has fired once, ever.** One `paywall_reached` row with `category='personal'`, on 2026-09-06, from `justincox@pacificwest.com` (3/3 inboxes, 2,862 actions, the heaviest paying user in the product). **He did not upgrade to Pro.** The single best-qualified Personal-to-Pro prospect in existence saw the offer and declined. `photo@orbispro.com` is also at 3/3 with 844 actions and has not tried a fourth.

**5.6 Retention is untested.** Zero real churn, and the oldest paying account is nine days old. There is no retention data yet, only an absence of it.

**5.7 The confound I cannot remove.** "Has a business-domain inbox" correlates with "is a competent technical operator who got IMAP working". `inbox_connection` failure rates are heavy (333 generic-IMAP failure events across 75 workspaces). Some of the 6.3x conversion gap could be a competence gradient rather than a willingness-to-pay gradient. Distinguishing them requires an experiment, not a query.

---

## 6. Positioning: what the site says now, and what would change

Every customer-facing string frames the buyer as **one person with several mailboxes of their own**. There is no departmental language anywhere.

### 6.1 What is there now

**Homepage** (`apps/web/messages/en/home.json`, rendered via `apps/web/components/marketing/Sections.jsx`):

- `:18-20` hero: `"Give your AI"` / `"agent an"` / `"inbox."` (singular)
- `:21` lead: `"Connect Gmail, iCloud, Fastmail, or any IMAP inbox once..."`
- `:126` `"Priced by inbox, not by usage."`
- `:127` `"Free connects one inbox. Personal connects three. Pro connects every mailbox you own. Team adds people, roles, and a separate workspace per client."`

The "Real prompts" grid is hardcoded and untranslated at `apps/web/components/marketing/Sections.jsx:587-618`, and it is the single most consumer-coded surface on the site:

- `:589` `"What was the wifi password Alex sent me last week?"`
- `:594` `"Unsubscribe me from every newsletter I haven't opened in 3 months"`
- `:599` `"Reply to the landlord and say rent's coming Friday"`
- `:614` `"What did the doctor's office say about my appointment?"`

The code comment at `Sections.jsx:580-586` states the intent: everyday inbox chores, not developer jargon. A business operator running `facturas@` and `ventas@` reads that grid and concludes this is a personal-email toy.

**Pricing page** (`apps/web/messages/en/pricing.json`, rendered by `apps/web/components/marketing/PricingClient.jsx`):

- `:9` `"Three inboxes, $5."`
- `:11` lead: `"...Free covers one inbox. Personal covers three for $5 a month. Pro covers every mailbox you own. Team adds people, roles, and a separate workspace per client."`
- `:39` Personal: **`"Three mailboxes for one person: work, personal, and one more."`**
- `:52` Pro: **`"Every mailbox you own, in one agent. Work, personal, and each side business."`**
- `:64` Team: `"Shared inboxes for a team, with a separate workspace per client or business."`
- `:165` FAQ: `"Personal is one person with three connected inboxes... Pro is still one person, with no inbox limit at all... Team is for more than one person..."`
- `:169` FAQ: `"What if I need a fourth inbox?"` answered with `"A fourth moves you to Pro at $15 a month"`
- `:140` comparison table hardcodes `"Just you"` for Free, Personal **and** Pro (`PricingClient.jsx:79`)

**In-app paywall** (`apps/web/messages/en/dashboardChrome.json`):

- `:163` `"You were about to connect another inbox. Pro removes the limit for $15 a month: work, personal, and every side business on the same agent."`
- `:169` `"You were about to connect another inbox. Personal takes you to three for $5 a month: work, personal, and one more."`
- `apps/web/messages/en/dashboard.json:137` `"Free connects one mailbox. Personal takes you to three for $5 a month, so work and personal can share the same agent."`

The word "own" does the damage. `finanzas@massif.mx` is not a mailbox Laura *owns*, it is one she *operates*. "Work, personal, and one more" describes a life, not a company.

**The one exception**, and it is buried in a modal: `apps/web/messages/en/dashboardChrome.json:209` `"IMAP and SMTP connect straight to your mail server, with no third-party consent screen in the way. Use this for a work mailbox, a custom domain, or any provider not listed here."` That sentence is the only place in the entire product that speaks to this buyer, and you only see it after choosing IMAP inside the connect modal.

**Existing persona page:** `apps/web/app/[locale]/for/founders/page.js`, copy at `apps/web/messages/en/forFounders.json:10`: `"You are the support team, the sales team, and the founder..."`. Closest thing we have, still singular-inbox framed (`"connects your inbox"`).

### 6.2 What would change

Ranked by cost, cheapest first. None of these are implemented.

1. **Rewrite two plan descriptions to name company mailboxes** (`pricing.json:39` and `:52`, mirrored at `home.json:146` and `:159`, plus 4 other locales). Personal becomes something like "Three mailboxes for one person or one small team: work, personal, or your first company address." Pro becomes "Every mailbox your business runs, on one agent: finance, sales, support, info, and your own." That single change moves Pro from a lifestyle plan to a business plan without touching a line of product code.
2. **Rewrite the two paywall bodies** (`dashboardChrome.json:163`, `:169`, and `dashboard.json:137`, `:138`) to lead with the departmental case, since 26% of business-shaped paywall hits convert versus 3.8% of the rest. This is the highest-leverage copy surface we have, and it currently sells "work and personal".
3. **Replace two of the five "Real prompts"** at `Sections.jsx:587-618` with departmental prompts that our own tools actually do, for example a triage across `ventas@` and `info@` or a forward from `facturas@` to the accountant. Keep the everyday tone; change the mailbox.
4. **Build a `/for/business` persona page** modelled on `/for/founders`, headline on the actual job: one operator, every company mailbox, one agent. This is the page to point acquisition at.
5. **Stop hardcoding `"Just you"` for Pro** in the comparison table (`PricingClient.jsx:79`). It is technically accurate about seats and actively wrong about the buyer we want. Reword the row to "seats" versus "mailboxes" so a business reading the table does not conclude Pro excludes them.

Do **not** rewrite Team yet. See §8.

---

## 7. Product changes, ranked by evidence

### 7.1 Should Personal's 3-inbox cap move? No.

**Evidence says leave it.** 75% of uncensored multi-inbox demand (18 of 24) fits inside three. The cap has fired exactly once in the product's history. Moving it to 5 would give away revenue from the 18 who fit, in exchange for capturing the 6 who do not, and those 6 are precisely the ones worth $15 rather than $5.

The cap is not in the wrong place. **The routing to it is.** `apps/web/src/lib/billing/inbox-cap-offer.mjs:31` implements "the cheapest plan that clears the cap that was just hit", which sends every Free workspace to Personal. That is right for a consumer adding mailbox #2. It is wrong for `finanzas@massif.mx`, who was blocked at mailbox #2 and needed nine. She was offered $5/3-inboxes, abandoned it at 19:52, abandoned Team at 19:54, found the pricing page at 19:56, and bought Pro annual at 19:57. **The product routed her to the wrong tier and the pricing page rescued the sale.** The cohort review called the pricing page "a leak" ([[project_cohort_review_20260902]], 0/15 at the time). For this segment it was the only working path.

**Recommendation (evidence: strong on mechanism, n = 1 on outcome):** make the offer conditional on segment rather than only on cap. When the blocked workspace's existing inbox is on a business domain, show both Personal and Pro side by side instead of Personal alone. Do not remove Personal from the panel: 6 of 10 customers bought it.

### 7.2 The paywall only sells monthly. Fix that first.

Both cap surfaces hardcode the monthly interval:

- `apps/web/components/dashboard/Pages.jsx:1196` calls `checkoutStartHref(offer.plan, false)`
- `apps/web/components/dashboard/ConnectModal.jsx:2094` calls `checkoutStartHref(upgradeCopy.plan, false)`
- signature at `apps/web/src/lib/billing/upgrade-intent.mjs:31`: the second argument is `annual`

Three of the eleven completed checkouts were annual, and **annual is 43% of committed revenue** ($144 + $48 + $48 against a $25/mo monthly book). The largest single sale in the product's history was annual and could not have been made from the paywall. This is a one-line-per-surface change with a directly observed reason to make it.

**Recommendation (evidence: strong).** Offer a monthly/annual toggle at the cap, or at minimum an annual link beside the monthly CTA.

### 7.3 Is the Personal-to-Pro upgrade path discoverable? Yes, and that is not the problem.

Contrary to the framing in the brief, the path exists in three places:

1. The inbox-cap notice and modal, via `inboxCapOffer` returning `solo` for any cap above 1 (`inbox-cap-offer.mjs:31`), rendered at `Pages.jsx:1169` and `:1213`.
2. Billing section upgrade cards, `Pages.jsx:4577-4580`, which filter to `planRank(plan.id) > currentRank`, so a Personal subscriber sees Pro and Team. The comment at `Pages.jsx:4564-4572` records this as a deliberate fix for exactly the Stripe Customer Portal limitation noted in [[project_personal_tier_rollout]]: the portal on this account cannot switch plans, so in-app cards are the only expansion path.
3. The sidebar, which upsells Team only (`apps/web/components/dashboard/Sidebar.jsx:203`).

The cap notice fired once and did not convert. **Discoverability is not the bottleneck; there is almost nobody to discover it.** Only two workspaces have ever reached 3/3 inboxes on Personal. Building more upgrade surfaces optimises a funnel with n = 2.

**Recommendation (evidence: moderate).** Do not invest here. The upgrade path is adequate for its traffic. Revisit if the at-cap Personal population exceeds ~10.

### 7.4 What onboarding asks: nothing useful.

There is no onboarding wizard. `apps/web/src/lib/onboarding/state.ts:7` defines exactly three actions (`started`, `client_selected`, `provider_selected`). `apps/web/app/api/onboarding/route.ts:15` persists which MCP client and which email provider. The visible flow is a two-step checklist (`apps/web/components/dashboard/Pages.jsx:545-650`): connect an inbox, connect your MCP client.

**Onboarding never asks how many mailboxes the user intends to connect, and never asks whether they are personal or company mailboxes.** Every segment number in this document had to be inferred from email domains after the fact.

**Recommendation (evidence: strong on cost, unproven on lift).** Add one question to the client-selection step: "How many mailboxes will you connect?" with buckets 1 / 2-3 / 4-9 / 10+, plus an optional "personal / company / both". Store it on `workspaces`. This is the cheapest possible instrument for the 30-day test in §9, it is prospective rather than inferred, and it lets the connect modal route the cap offer correctly on the *first* block rather than the second. Caution from [[project_funnel_benchmarks_20260902]]: field-removal studies show single-digit effects, so do not expect the question itself to lift conversion. It is instrumentation, not a lever.

### 7.5 Investigate massif's dead mailboxes. Highest urgency, smallest scope.

8 of 9 inboxes with `last_sync_at IS NULL`, 2 billable actions ever, silent since 2026-09-03, on an annual plan. Either the connections are broken (in which case there is a bug affecting the highest-value configuration we ship) or the customer never wired up their MCP client. Both are fixable and both are worth a support email. This is the only customer whose full annual revenue is at stake and the only one whose failure mode we cannot currently name.

### 7.6 Stale $29 price fallbacks

Canonical Pro price is $15 (`apps/web/src/lib/stripe/plans.ts:248-249`). Three rendered fallbacks still say $29:

- `apps/web/components/marketing/PricingClient.jsx:45-47` (`monthly: 29, annual: 23`)
- `apps/web/components/marketing/Sections.jsx:821` (`price: '$29'`)
- `apps/web/components/dashboard/Pages.jsx:4260-4262` (`monthlyPrice: 29, yearlyAnnualTotal: 276`)

These are overridden by live Stripe prices at render, so they should not be visible. But `apps/web/messages/en/pricing.json:177` hardcodes `"Pro is $144 a year ($12 a month)"` while `PricingClient.jsx:46` would render `$23` on the same page if the Stripe lookup ever fell back. [[project_pro_repriced_15_20260901]] already warns that a correct-looking price does not prove the env var is right, because fallback and live value coincided at the time. They no longer coincide. Worth a cleanup pass.

---

## 8. Acquisition: where more of these people are

### 8.1 Correction first

The brief states that `generic_imap` "has NO landing page" and that six consumer provider pages exist. **That was true on 2026-08-31 and is not true now.** `apps/web/src/lib/connect/providers.mjs:38-51` defines slug `imap`, name "Generic IMAP", wave 1, all five locales, and `apps/web/src/lib/connect/release.mjs:26-37` released wave 1 on 2026-08-31. `/connect/imap` is live and has already produced 2 signups. There are 106 provider pages total, of which 22 (waves 1 and 2) are live today; wave 2 released this morning.

### 8.2 Which mail hosts this segment actually uses

Every live inbox on a non-consumer domain, grouped by IMAP host family, with its release wave:

| host family | inboxes | workspaces | page status |
| --- | --- | --- | --- |
| plain `mail.<company-domain>` / `imap.<domain>` | **79** | **61** | `/connect/imap`, live (wave 1) |
| IONOS | 12 | 11 | live (wave 1) |
| OAuth, no host recorded | 9 | 8 | n/a |
| Yandex | 8 | 6 | live (wave 1) |
| Google Workspace | 8 | 7 | `/connect/gmail`, live |
| Hetzner | 6 | 2 | live (wave 2, today) |
| Zoho | 5 | 4 | live (wave 1) |
| Namecheap | 3 | 3 | **wave 3, 2026-09-14** |
| shared US hosts (Bluehost, SiteGround, etc.) | 3 | 2 | waves 2 to 4 |
| one.com | 2 | 2 | **wave 3** |
| OVH | 2 | 2 | **wave 3** |
| Hostinger | 2 | 2 | **wave 3** |
| STRATO | 2 | 2 | **wave 3** |

Two conclusions:

**(a) `/connect/imap` is the segment's page and it is already live.** More than half of all business-domain mailboxes are on a host with no consumer brand at all, just `mail.<their-own-domain>`. Its current copy (`apps/web/src/lib/connect/content/en/imap.json:25`, `"Give your AI agent the inbox you already have, whoever hosts it"`, and `:38`, `"The free plan connects one inbox, forever."`) is a *technical* pitch, not a departmental one. Rewriting that one page to lead with "connect every mailbox your company runs" is the single highest-leverage acquisition edit available, and it needs no new route.

**(b) The wave schedule is sorted wrong for this thesis.** The business hosts we can observe demand for (Namecheap, one.com, OVH, Hostinger, STRATO) sit in wave 3 (2026-09-14), the cPanel and self-host categories in waves 3 to 4, and Microsoft 365 / Zimbra / mailcow in wave 9 (2026-10-26). Meanwhile consumer ISP pages (Comcast, Cox, Verizon, BigPond) occupy wave 6. The staging rationale in `release.mjs:4-24` is sound (crawl budget, learning loop, blast radius) and I am not proposing to abandon it, only to **re-sort the remaining waves by observed business-host demand**, promoting the hosting and cPanel categories ahead of the ISP ones. This is a data-file edit, not new content.

### 8.3 What the existing channels deliver

Attributed landing pages, external workspaces:

| landing | signups | with a business inbox | paid |
| --- | --- | --- | --- |
| (unattributed) | 247 | 79 | 10 |
| `/` | 78 | 23 | 3 |
| `/connect/yahoo` | 15 | 3 | **0** |
| `/connect/icloud` | 11 | 1 | **0** |
| `/connect/gmail` | 6 | 0 | **0** |
| `/blog/connect-claude-to-email` | 5 | 2 | 1 |
| `/connect/ionos` | 3 | **2** | 0 |
| `/connect/gmx` | 3 | 1 | 0 |
| `/connect/imap` | 2 | 1 | 0 |

Consumer provider pages work as SEO and produce no revenue: 32 signups across yahoo, icloud and gmail, 4 business inboxes, zero paying. `/connect/ionos` produced 3 signups of which 2 were business, on a page four days old. Small n, right direction.

By source, the split is stark:

| source | consumer-domain signups | business-domain signups |
| --- | --- | --- |
| unattributed | 159 | 88 |
| direct | 57 | 15 |
| `organic_google` | **45** | **3** |
| other | 20 | 2 |
| reddit | 6 | 3 |

**Organic search is 94% consumer.** This is the number that should reorder the SEO plan: [[project_seo_verdict_20260831]] found 0 of 29 organic signups paid, and this is why. We rank for consumer email queries. Nobody searching "connect gmail to claude" runs `facturas@`.

Geography: business signups cluster in `.com` (49), `.uk` (8), `.de` (7), `.net` (5), `.br` (4), `.nl` (4). The German cluster is real and recent: five `.de` role-address signups in the week of 2026-08-31 alone (`duplexgaragen24.de`, `skulturkollektiv.de`, `kantfolie.de`, `archimedes-gs.de`, `briana-beauty.de`), and IONOS, Hetzner and STRATO are all German hosts. Nothing in that cluster has converted yet, so treat it as a lead, not a market.

### 8.4 Ranked acquisition actions

1. Rewrite `/connect/imap` for the departmental buyer (largest observed cohort, page already live, no new route).
2. Re-sort waves 3 to 10 by observed business-host demand; promote hosting and cPanel ahead of consumer ISP.
3. Build `/for/business` and link it from the homepage and `/connect/imap`.
4. Stop investing in consumer provider SEO. 32 signups, zero revenue.
5. Watch the German SMB cluster; do not act on it yet.

---

## 9. The Team tier question

### 9.1 The facts

- Team ($79/mo, internal id `pro`) has **never had a completed checkout**. Ever.
- It has had **9 `checkout_started` events across 8 external workspaces** between 2026-08-16 and 2026-09-07, plus one failure row for `pro_year`.
- **Zero non-owner workspace members have ever existed.** 404 rows in `workspace_members`, all with `user_id = owner_id`. Verified directly.
- **One owner has more than one workspace, and it is Asgeir.** So Team's second differentiator, "a separate workspace per client or business" (`pricing.json:64`), also has zero usage.
- Its remaining differentiators are SSO, audit log and priority support (`plans.ts:281-286`), none of which anyone has asked for.

### 9.2 The interesting part

Two of the eight who started a Team checkout are `finanzas@massif.mx` (2026-09-02) and `mohsinkazi1983@yahoo.com` (2026-09-07). **Both then bought Pro instead, on the same day.** These are the two highest-inbox-count customers in the product. They looked at the tier whose name suggests "for a business", recoiled at $79, and stepped down to $15.

Two others were consumers with one inbox who clicked the most expensive card. One (`info@tmlbyg.dk`) is a role address that started a Team checkout on 2026-08-27, never connected a single inbox, and never paid.

So the eight Team attempts break down as roughly: two real business buyers who were mispriced down, one business buyer who never activated, and five people who clicked the wrong card.

### 9.3 Recommendation: reposition, do not reprice, do not retire

**Do not reprice Team on mailboxes.** Pro already sells unlimited mailboxes at $15. A mailbox-priced Team would either undercut Pro or duplicate it, and there is no observed customer who wants unlimited mailboxes *and* would pay more than $15 for them. massif at 9 mailboxes pays $12/mo effective. There is no evidence of price-insensitive mailbox demand.

**Do not retire it either.** It costs nothing to keep, it does not appear to be blocking anything, and its presence gives Pro a ceiling to look cheap against. Both of our largest customers passed *through* Team on the way to Pro. That is a functioning decoy, not a broken product. Two of three Pro sales involved reading the Team card first.

**Reposition it as a genuine upper tier that is not confusable with Pro.** The concrete problems are:

1. **The name lies about the axis.** "Team" means people. Our buyers do not have people, they have mailboxes. The tier that says "business" on it must not be the tier priced on seats.
2. **It is the widest step on the ladder.** $5 to $15 to $79 is a 5.3x jump into a capability nobody has ever used. That is why it converts at 0 of 8.
3. **Its actual value (SSO, audit log, priority support) is compliance, not capability**, and no prospect has asked for compliance.

Reposition means: rename the display value away from "Team", reframe the feature list around governance and multi-entity operation rather than seats, and above all **make the pricing table stop implying that a business belongs on it**. Right now a business reading `pricing.json:165` learns that Personal and Pro are "one person" and Team is "for more than one person", so a company with five departmental mailboxes and one operator reads that table and concludes it belongs on the $79 tier. It does not. It belongs on Pro. That misdirection is measurable: it is 8 abandoned checkouts and two rescued only because the customers persisted.

**Confidence: moderate on "do not reprice on mailboxes" (Pro already occupies that space, and we have zero evidence of demand above $15). Low on the specific renaming, which is a judgement call, not a measurement.**

---

## 10. What to measure in the next 30 days

Instrument first (§7.4 onboarding question, plus a stored `segment` classification), then watch these. Thresholds are set so that a null result is as legible as a positive one.

| # | Metric | Baseline today | Confirm the thesis | Refute the thesis |
| --- | --- | --- | --- | --- |
| 1 | Business-segment (signal D) share of new paying customers | 8 of 10 (80%) | **7 of the next 10 or more** | 4 or fewer of the next 10 |
| 2 | Business-segment conversion, connected workspaces | 7.6% (8/105) | holds at 6% or better with n rising past 150 | falls below 4% |
| 3 | Non-business conversion | 1.2% (2/161) | stays under 2% | rises above 4%, which would mean D is noise |
| 4 | Pro (`solo`) sales in 30 days | 3 all time, 2 in the last 3 days | **5 or more**, and 3 or more with 3+ inboxes at purchase | 1 or fewer |
| 5 | Pro sales that are departmental (2+ mailboxes on ONE company domain) | 1 (massif) | **3 or more**, moving this off n=1 | still 1 |
| 6 | massif reactivation: billable actions in the 30 days from 2026-09-07 | 2 all time | **50 or more** | still under 10, which makes the flagship a setup-and-abandon |
| 7 | Business-segment 30-day retention (active in the trailing 7 days at day 30) | 66% at 7 days | **55% or better at 30 days** | under 35% |
| 8 | Paying customers still active at day 30 | untestable (oldest is 9 days) | **9 of 10 or better** | 7 or fewer |
| 9 | Inboxes added after day 7 of a workspace's life | 7 ever (2% of all) | 8 or more new ones in 30 days would genuinely reopen the expansion question | 2 or fewer, confirming the metric is frozen at setup |
| 10 | Personal customers reaching the 3-inbox cap | 1 ever | 4 or more, which makes the Personal-to-Pro path worth building | 1 or 2, meaning do not invest there |
| 11 | Annual share of new checkouts (after adding the annual option at the cap) | 3 of 11 (27%) | 40% or better | under 20% |
| 12 | `/connect/imap` signups whose first inbox is a business domain | 2 signups, 1 business | **10+ signups, 60%+ business** | fewer than 5 signups |
| 13 | Team (`pro`) completed checkouts | 0 of 9 started | any completion at all is new information | still 0, which settles §9 |

**Decision rule.** If metrics 1, 2 and 4 all clear their thresholds, commit to the segment: rewrite positioning, re-sort the connect waves, build `/for/business`. If 1 and 2 clear but 6 fails (massif stays dead), the segment converts and does not retain, and the priority becomes activation for business accounts, not more acquisition. If 4 fails while 1 clears, the segment is real but Personal absorbs it, and Pro's problem is routing, not price.

**A caution about all of the above.** At the current rate (roughly 100 signups and 5 paying customers per week), 30 days adds perhaps 20 payers. Metric 1 will have a confidence interval of roughly plus or minus 25 percentage points. Treat every threshold as a tripwire for a closer look, never as a result.

---

## 11. Open questions for the founder

Separated deliberately from my conclusions above. I do not have answers to these.

1. **Has anyone spoken to massif?** They paid $144, connected 9 departmental mailboxes in an hour, and 8 of them have never synced. I cannot tell from the database whether the integration is broken or the customer walked away. This is the single highest-value unknown in the business and one email answers it.

2. **Is `photo@orbispro.com` blocked right now?** 3 of 3 inboxes on Personal, 844 billable actions in two days, all three mailboxes on one company domain (`orbispro.eu`: `info@`, `mike@`, `milan@`), never seen the cap. Do they have a fourth mailbox they want? If yes, this is the segment's clean test case and the answer costs one email.

3. **Why did `justincox@pacificwest.com` decline Pro?** He hit the 3-inbox cap on 2026-09-06 with 2,862 billable actions, the heaviest use in the paying base, and did not upgrade. Price, or does three genuinely suffice? This is the only Personal-to-Pro data point that exists.

4. **Why did `damian@meetdmri.com` buy Pro with one inbox?** He paid $15/mo for unlimited mailboxes and connected one. If he bought for the 5x rate limit or the analytics rather than inbox count, then Pro's value proposition is not what its copy says, and that changes §6 materially.

5. **Do you want to convert the grandfathered cohort?** 21 workspaces hold business-domain inboxes, average 3.29 mailboxes, average 2,298 billable actions, 14 active in the last 7 days, and pay $0 permanently. One of them (`9c55625e`) has 40,314 billable actions, more than every paying customer combined. [[project_grandfather_blocked_willing_buyers]] records that revoking a grandfather block produced a full-price sale in 2h15m. The commitment in [[project_inbox_repricing_2026_08_19]] is "unlimited inboxes free forever" and I am not proposing to break it. But nothing stops us selling them something they do not already have.

6. **Is the German SMB cluster a coincidence?** Five `.de` role-address signups in one week, plus IONOS, Hetzner and STRATO as the top named business hosts. None converted. Is there a referral source, a directory listing or a forum thread behind it? Attribution is NULL on all of them, so the database cannot say.

7. **What is Personal actually for now?** 6 of 10 customers bought it and it is described as "work, personal, and one more". If the business segment is the strategy, is Personal the on-ramp to Pro, or is it a separate consumer product we keep because it converts? The answer decides whether §6.2's rewrite touches Personal at all.

8. **Would you take a lower-margin, higher-touch route?** The two clearest segment members (massif, orbispro) both look like they would benefit from setup help. At $144/yr that is not economic at scale, but at n = 10 customers it might be the fastest way to learn whether the product actually delivers for a departmental business, before committing the positioning to it.

---

## 12. Appendix: how these numbers were produced

All queries run from the repo root as:

```
npx supabase db query --linked -f <file>.sql
```

`--linked` is mandatory. Without it the CLI silently runs against an empty local database and returns confident wrong answers.

Query files are in the session scratchpad. Every analysis query was run by concatenating the `seg` view definition (§3.4) ahead of it, since `supabase db query` does not accept `\i`. All queries are read-only. PostgREST truncates row-returning selects at 1000 rows silently, so every count is a SQL aggregate rather than a client-side count.

Exclusions applied consistently and stated wherever they matter:

- `owner_email LIKE 'bjellanda%'` removes Asgeir's own workspaces, including the comped `pro` workspace `4bff20c8` (5 inboxes, 1,180 actions) and the test account whose cancellation is the product's only `canceled` billing row.
- `owner_email <> 'hello@mcpemails.com'` removes our own operational mailbox, which carries 10,307 billable actions and is a role address. Leaving it in inflates the role-address cohort's average actions from 115 to 752 and would have produced exactly the wrong conclusion in §3.2. Any future analysis of role addresses must exclude it.
- `deleted_at IS NULL` on `workspaces` and `inboxes` throughout.

Fisher exact tests were computed locally on the 2x2 tables, two-sided, from the counts shown in §3.1.
