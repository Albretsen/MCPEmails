# PLAN: activation lifecycle email

Planning document. Nothing here is implemented. No email has been sent.
Written 2026-09-07. All numbers measured against live production the same day
via `npx supabase db query --linked`, read-only.

---

## 0. Summary of the position this document takes

1. There are not ~46 stalled users a week. There are **52 in the last 7 days**,
   and they fall into eight shapes with wildly different worth. Three shapes
   deserve an email. Five do not.
2. Email cannot compete inside the activation window. 84% of value activations
   happen within one hour of signup and the median staller's entire product
   session is **5.1 minutes long**. But that is not an argument against email,
   it is an argument about what email is *for*: the job is to manufacture a
   second session that would otherwise never exist, not to shorten the first.
3. The natural recovery rate of a workspace still stalled at 24 hours is
   **6.1%** (8 of 131, post-instrumentation cohort). That is the number any
   email has to beat, and it is small enough that a properly powered A/B test
   needs roughly **700 stalls, about 14 weeks** at today's volume. Ship anyway,
   with a holdout, but do not expect a verdict this quarter.
4. Almost all the infrastructure exists. `lifecycle_email_sends` was built on
   2026-09-02 for exactly this and is sitting empty. The dispatcher pattern,
   the Vault secret, the RFC 8058 unsubscribe endpoint and the Resend sender
   are all live as of today. This is roughly a 2 to 3 day build, not a system.
5. One prerequisite is genuinely load-bearing (`auth_reason` on the funnel).
   One "cheap win" from prior analysis (the OAuth first-prompt gap) turns out
   to be **much weaker than believed**, and this document corrects it.

---

## 1. The stall taxonomy, measured

### 1.1 Method

Two cohorts, because they answer different questions.

**Cohort A, "this week"**: all 116 non-deleted workspaces created in the last
7 days, classified on their *all-time* funnel events. This answers "how many
of each shape do we produce per week, right now".

**Cohort B, "clean"**: 276 non-deleted workspaces created between 2026-08-05
and 3 days ago, classified only on events within **24 hours of signup**, then
followed for eventual recovery. The 2026-08-05 floor matters: full funnel
instrumentation landed in `20260802000000_add_truthful_product_funnel_events.sql`,
and a 90-day cohort is contaminated by pre-instrumentation workspaces. Proof:
over 90 days, 82 workspaces have zero funnel events; over the last 30 days,
only 6 of 310 do. Any "never selected a provider" number computed over 90 days
is mostly missing instrumentation, not missing users.

Both count from `product_funnel_events` only.
`workspaces.onboarding_started_at` is not used anywhere in this plan, per the
trap in `project_activation_mechanics_20260902.md`: it is written only when the
browser lands with `firstrun=1` and a fire-and-forget fetch succeeds, so
accounts with a full event trail read as "never started".

### 1.2 The shapes

| Shape | Definition | Cohort A (7d) | Cohort B (33d) | Ever recovered |
|---|---|---:|---:|---|
| A. No events at all | no funnel row within 24h | 6 | 18 | 0 (0%) |
| B. Provider picked, connect never opened | `provider_selected`, no `inbox_connection` | 6 | 6 | 0 (0%) |
| C. Connect opened, nothing submitted | `inbox_connection/started`, no success or failure | (in A/B) | 13 | 1 (7.7%) |
| D1. Credential rejected, never connected | `inbox_connection/failure` + `auth_failed`, no success | 7 | 27 | 0 (0%) |
| D2. Transport failed, never connected | `inbox_connection/failure` + `validation_failed`, no success | (in D1) | 3 | 0 (0%) |
| E. Inbox connected, no MCP credential | `inbox_connection/success`, no `credential_created` | **21** | **34** | 3 (8.8%) |
| F. Credential issued, no tool call | `credential_created`, no `first_tool_call` | 7 | 15 | 2 (13.3%) |
| G. Tool call, no value call | `first_tool_call`, no `value_activation` | 5 | 15 | 2 (13.3%) |
| H. Value activated within 24h | `value_activation` | 64 | 145 | n/a |

Cohort A totals 116 workspaces, 64 activated, **52 stalled**. Cohort B totals
276, 145 activated within 24 hours, **131 stalled at the 24 hour mark, of which
8 ever recovered (6.1%)**.

Signup volume is climbing fast, so the weekly numbers matter more than the
33 day ones: 25, 44, 61, 76, 105 workspaces in the five weeks to 2026-08-31.
Any capacity plan should assume the shapes scale with that.

### 1.3 What each shape actually is

**E is the biggest and the most rescuable.** 21 workspaces this week, 34 in
cohort B. 19 of the 21 have a live, `active` inbox row right now. They proved
their mailbox credentials work and then vanished. The median gap between the
successful connect and their last recorded event is **0.9 minutes**. Only 21 of
40 (60 day window) had ever selected a client. This is not a failure, it is an
interruption: they finished the hard part and closed the tab before the easy
part.

**F and G are the same human state and should be treated as one.** All 15
cohort-B workspaces in G have `analytics_first_tool_name = 'inbox_list'` and
nothing else. `inbox_list` is what an MCP client calls on handshake, not what a
person asks for. So "made a tool call but no value call" is not a distinct human
stall, it is the client saying hello. F and G both mean: connected, credential
in hand, never actually asked their agent to do anything. Combined, 12 a week.

**D1 is a support problem wearing an email costume.** 27 workspaces in cohort B
tried a credential, were rejected, and never connected anything, ever. Zero of
them recovered. Provider breakdown of the cohort-B D1 population:

| Provider | Workspaces | Failed attempts |
|---|---:|---:|
| yahoo | 11 | 30 |
| generic_imap | 11 | 36 (+ 6 more with no phase) |
| icloud | 4 | 8 |
| yandex | 3 | 19 |
| zoho | 1 | 8 |
| gmail | 1 | 7 |

Note the attempts-per-workspace ratio. Yandex: 3 workspaces, 19 attempts. These
people tried hard. They are not disengaged, they are blocked.

**A, B and C are pre-intent.** 0%, 0% and 7.7% recovery on tiny n. A person who
signed up and never picked a provider has told us almost nothing.

### 1.4 The one number that frames everything

Over the same clean cohort, of the 131 workspaces stalled at 24 hours,
**8 ever value-activated (6.1%)**. Widening to 90 days (and accepting the
instrumentation contamination), 200 stalled at 24 hours and 9 recovered (4.5%),
only 2 of them after day 7.

Separately: of stalled workspaces aged at least 8 days, **20 of 108 (18.5%)**
produce *any* funnel event after the 24 hour mark, and 15 (13.9%) after day 7.
So a fifth of them do come back and poke at it. They just do not get anywhere.
That gap, between "returns" (18.5%) and "activates" (6.1%), is the space an
email can work in, and it is also evidence that the blocker is comprehension,
not motivation.

---

## 2. Which stalls get an email, and which get a product fix

| Shape | Weekly volume | Verdict |
|---|---:|---|
| A. No events | ~6 | **No email.** No signal, 0% recovery. Anything we write is a guess. |
| B. Provider only | ~6 | **No email.** Same. n=6 and 0% recovery cannot justify touching the domain reputation. |
| C. Connect opened, nothing submitted | ~3 | **No email.** They saw the form and left. Product: the form is the message. |
| D1. Credential rejected | ~7 | **Conditional email, and mostly a product fix.** See below. |
| D2. Transport failed | ~1 | **No email.** Already fixed in product (2026-08-19 auto-pairing of port and security, `project_connect_flow_imap_first.md`). Residual n=3. |
| E. Inbox connected, no credential | ~21 | **Email. This is the one.** |
| F+G. Credential issued, no real tool call | ~12 | **Email.** |

### 2.1 Why D1 is mostly a product fix

An email that says "finish connecting your inbox" to somebody the UI cannot
accept a correct answer from is worse than silence. Three of the six D1
providers are in exactly that state or close to it:

- **iCloud (4 workspaces).** The IMAP username for iCloud is the *name part* of
  the address, the opposite of every other provider. The connect modal cannot
  accept a username for a branded provider at all: the field is inside the
  `isGeneric &&` block at `apps/web/components/dashboard/ConnectModal.jsx:1809`,
  and the recovery path for the exact classifier verdict that would help is
  gated the same way at `ConnectModal.jsx:927`
  (`if (reason === 'login_username_required' && isGeneric)`). Emailing an iCloud
  user to try again sends them back to a form that structurally cannot take the
  right input. **Do not email iCloud D1 users until that field is ungated.**
- **Yahoo (11 workspaces).** Per `project_connect_flow_imap_first.md`, 100% of
  Yahoo failures are the account password submitted where an app password
  belongs. The in-modal copy was already fixed on 2026-08-19 and Yahoo still
  produces 11 stalled workspaces and 30 failed attempts a month. An email here
  is defensible because the fix is genuinely on the user's side (go to Yahoo,
  generate an app password) and the modal *can* accept the result.
- **Generic IMAP (11 workspaces).** Mixed. Some are wrong passwords, some are
  hosts that do not resolve. Only worth emailing when we can name the reason.

The gate on D1 email is therefore: **we must be able to name the reason, and the
named reason must have a fix reachable in the current UI.** Today we can name
the reason for only 27% of D1 workspaces (9 of 33). That is what makes the
`auth_reason` prerequisite in section 8 load-bearing rather than nice to have.

### 2.2 Product fixes that are adjacent, not prerequisites

Listed so they are not confused with the email work.

- **First value before the credential gate.** The single best-evidenced lever in
  `project_funnel_benchmarks_20260902.md` (Twilio, Sep 2025, holdout-controlled,
  +62% first-message activation, though confounded across 9 changes and vendor
  self-reported). Our analogue: let a signup make a real tool call against
  `demo@mcpemails.com`, which already exists with a 19 message fixture corpus
  (`project_demo_mailbox_for_reviewers.md`), before they fight IMAP auth. This
  attacks the D1 and C populations at source. Calibration from that same memory:
  Plaid, whose entire business is the connect step, publishes 1 to 11% relative
  per change. Expect single digits, not 62%.
- **The suggested first prompt on the OAuth path.** The copy
  ("Summarize my unread email from today.",
  `apps/web/messages/en/dashboard.json:298`) is rendered in exactly one place,
  the API-key reveal modal at `apps/web/components/dashboard/Pages.jsx:2922`.
  OAuth users never see it. **However, this document corrects the prior claim
  that this is a meaningful loss.** Measured over the last 90 days, conditioned
  on `credential_created`:

  | Credential method | Workspaces | Value activated | Rate |
  |---|---:|---:|---|
  | oauth | 183 | 155 | **84.7%** |
  | api_key | 34 | 21 | **61.8%** |

  OAuth users activate 23 points *better* despite never seeing the prompt. The
  gap that matters is the api_key path, which *does* see the prompt and still
  loses 38%. Showing the prompt to OAuth users is a 20 minute change and
  probably harmless, but it is not the win it was written up as, and the plan
  should not be justified on it.
- **The ChatGPT client path.** By selected client over 90 days: Claude 102
  workspaces at 79.4% activation, ChatGPT 49 at 55.1%, Gemini 8 at 37.5%. The
  ChatGPT gap is 24 points on n=49. Worth its own investigation. Not an email.
- **The iCloud username field.** See 2.1.

---

## 3. The timing position

### 3.1 The data

Time from workspace creation to first `value_activation`, last 30 days, n=170:

| Window | Count | Share |
|---|---:|---|
| within 1 hour | 143 | 84.1% |
| 1 to 6 hours | 13 | 7.6% |
| 6 to 24 hours | 7 | 4.1% |
| after 24 hours | 7 | 4.1% |

Median: **16.9 minutes.**

Stalled workspaces, last 30 days, n=135. Time from signup to their *last*
funnel event of any kind:

| Window | Count | Share |
|---|---:|---|
| within 1 hour | 120 | 88.9% |
| 1 to 24 hours | 9 | 6.7% |
| after 24 hours | 6 | 4.4% |

Median: **5.1 minutes.**

### 3.2 What follows

Activation is instant or never, and so is abandonment. The staller's median
total engagement with this product is five minutes.

The tempting conclusion, "email is structurally the wrong tool", is half right
and needs splitting.

**Email is the wrong tool for compressing the first session.** Nothing that
arrives by mail can act inside a five minute window that has already closed by
the time we could safely conclude a stall. Anything that wants to influence
that window has to be in the product, in the connect modal, or in the reveal
modal. Section 2.2 lists what belongs there.

**Email is the only tool available for creating a second session.** The
stalled population is not idle, it is gone: 88.9% of them produce no further
event after their first hour. There is no in-product surface that reaches a
person who has closed the tab. And 18.5% of stalled workspaces do return under
their own steam, which is a strong signal that a well-aimed nudge has something
to work with.

So the timing rule is not "fire the next morning". Firing the next morning is
wrong for a specific measurable reason: by then the person's last interaction is
median 5.1 minutes long and roughly a day old, and the memory of what they were
halfway through is gone. It also throws away the same-evening return, which is
where the intent still lives.

**Position: first touch at signup + 60 minutes, gated on a 45 minute quiet
period.**

- 60 minutes after signup is past 84.1% of all activations, so we are almost
  never interrupting somebody mid-flow.
- The quiet gate ("no funnel event in the last 45 minutes") is the real safety.
  A person who is still clicking must never receive a "you seem stuck" email
  while they are unstuck. This is the same structural idea as the freshness
  re-check in the billing dispatcher
  (`apps/web/app/api/internal/billing-lifecycle/dispatch/route.ts`, the
  `checkFreshness` call): never ask "has enough time probably passed", always
  ask "is this still true, right now".
- A single follow-up at day 3, and then nothing. Recovery after day 7 is 2 of
  200 in the 90 day window. There is no long tail to farm, and a second and
  third nudge into a 1% base rate is how you buy spam complaints on a domain
  that also carries dunning mail.

Recommendation: **ship the T+60min touch only in v1.** Add the day-3 follow-up
in v2 if and only if v1 shows the first touch does anything. One email per
person keeps the reputation cost near zero while the holdout accumulates.

---

## 4. Message-by-message spec

Three messages are specified. **Ship M1 and M2. M3 is blocked on prerequisite
P1 and product fix P3.**

Shared properties for all three:

- Category: `lifecycle` (from `LIFECYCLE_CATEGORIES` at
  `apps/web/src/lib/email/lifecycle.ts:45`). Not transactional. See section 6
  for why, including for M3 where it is arguable.
- Sender: `lifecycleFrom()` (`apps/web/src/lib/email/lifecycle.ts:59`), default
  `Asgeir Albretsen <asgeir@mcpemails.com>`, a real mailbox. Replies land with
  a person, which is the point at this volume.
- Headers: `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
  pointing at `unsubscribeUrl(token, 'lifecycle')`
  (`apps/web/src/lib/email/lifecycle.ts:70`), served by the existing
  `apps/web/app/api/email/unsubscribe/route.ts` (POST at :103, GET at :112).
- Suppression: every rule in section 4.4, checked at send time, never at queue
  time.
- Ledger: one row in `lifecycle_email_sends` keyed
  `(user_id, template, trigger_key)` with `trigger_key = workspace_id`.
- Once per workspace per template, forever. No re-entry.

### 4.1 M1: `activation_inbox_no_credential`

**Population.** Shape E. ~21 a week and growing. Highest volume, second highest
base recovery (8.8%), and the shortest distance to value: they have a working
mailbox already.

**Trigger.** A workspace qualifies when all of the following hold at dispatch
time:

```sql
-- Candidates for activation_inbox_no_credential.
-- Evaluated fresh on every tick. No materialised queue: unlike a Stripe
-- invoice, the whole state lives in our own tables, so it can always be
-- re-derived, and re-deriving is what makes "is this still true" cheap.
WITH agg AS (
  SELECT e.workspace_id,
         bool_or(e.stage = 'inbox_connection' AND e.outcome = 'success') AS connected,
         bool_or(e.stage = 'credential_created')                          AS has_credential,
         bool_or(e.stage IN ('first_tool_call','technical_activation'))   AS any_tool_call,
         bool_or(e.stage = 'value_activation')                            AS activated,
         bool_or(e.stage = 'checkout_completed')                          AS paid,
         max(e.occurred_at)                                               AS last_event_at
    FROM product_funnel_events e
   GROUP BY e.workspace_id
)
SELECT w.id AS workspace_id, w.owner_id, u.email
  FROM workspaces w
  JOIN users u  ON u.id = w.owner_id
  JOIN agg  a   ON a.workspace_id = w.id
 WHERE w.deleted_at IS NULL
   AND a.connected
   AND NOT a.has_credential
   AND NOT a.any_tool_call
   AND NOT a.activated
   AND NOT a.paid
   AND w.created_at <= now() - INTERVAL '60 minutes'   -- the delay
   AND w.created_at >= now() - INTERVAL '7 days'       -- never mail a cold signup
   AND a.last_event_at <= now() - INTERVAL '45 minutes' -- the quiet gate
   AND NOT EXISTS (
         SELECT 1 FROM lifecycle_email_sends s
          WHERE s.user_id = w.owner_id
            AND s.template = 'activation_inbox_no_credential'
       )
 ORDER BY w.created_at
 LIMIT 25;
```

Note what is deliberately absent: any reference to
`workspaces.onboarding_started_at`, `onboarding_stage`, or the
`analytics_*` marker columns. Those are best-effort denormalisations written by
`recordProductFunnelEvent` (`apps/web/src/lib/analytics/product-funnel.ts:42`)
and by the edge function; the events themselves are the source of truth.

**Delay.** 60 minutes after signup, plus the 45 minute quiet gate.

**Exit criteria.** The candidate query is the exit criteria: the row disappears
the moment `credential_created`, any tool call, value activation or a checkout
lands, or the workspace is deleted, or 7 days pass. There is no in-flight
sequence to cancel because there is no materialised queue.

**Subject.** `Your inbox is connected. One step to go.`

**Body intent.** Confirm what they already did (name the provider), state the
one remaining step in one sentence, give the key-creation link, and give the
first prompt verbatim. Do not explain MCP. Do not sell anything. Four sentences
maximum. Draft:

> Your [provider] mailbox connected fine, so the hard part is done.
>
> What is left is one link: create a key at [link], paste the URL into
> [their selected client, or "Claude"], and ask it "Summarize my unread email
> from today."
>
> That is the whole thing. If it does not work, reply to this and tell me what
> you see. I wrote the software, so I will know.
>
> [unsubscribe]

`[their selected client]` comes from the most recent `client_selected` category
for that workspace when one exists (21 of 40 have one), and falls back to
Claude, which is 100 of 178 client selections in the last 30 days.

**The metric.** `credential_created` for that workspace within 72 hours of the
send. One metric, not a dashboard. Base rate to beat, from cohort B shape E
recovery: 8.8% to value activation, and credential creation will be somewhat
higher.

### 4.2 M2: `activation_credential_no_value`

**Population.** Shapes F and G merged. ~12 a week. Highest base recovery
(13.3%). These people have everything and have not asked a question.

**Trigger.**

```sql
WITH agg AS (
  SELECT e.workspace_id,
         bool_or(e.stage = 'credential_created')  AS has_credential,
         bool_or(e.stage = 'value_activation')    AS activated,
         bool_or(e.stage = 'checkout_completed')  AS paid,
         max(e.occurred_at)                       AS last_event_at
    FROM product_funnel_events e
   GROUP BY e.workspace_id
)
SELECT w.id AS workspace_id, w.owner_id, u.email
  FROM workspaces w
  JOIN users u ON u.id = w.owner_id
  JOIN agg  a  ON a.workspace_id = w.id
 WHERE w.deleted_at IS NULL
   AND a.has_credential
   AND NOT a.activated
   AND NOT a.paid
   AND w.created_at <= now() - INTERVAL '60 minutes'
   AND w.created_at >= now() - INTERVAL '7 days'
   AND a.last_event_at <= now() - INTERVAL '45 minutes'
   AND NOT EXISTS (
         SELECT 1 FROM lifecycle_email_sends s
          WHERE s.user_id = w.owner_id
            AND s.template = 'activation_credential_no_value'
       )
 LIMIT 25;
```

`NOT activated` is the whole definition, and it absorbs the `inbox_list`-only
case for free: `value_activation` already requires a resolved inbox id and
`toolName != inbox_list` (`supabase/functions/mcp-server/index.ts:2567-2572`).
This is why F and G do not need separate triggers. It is also why the plan uses
`value_activation` and never `first_tool_call` or `technical_activation`, which
are the same event written twice at
`supabase/functions/mcp-server/index.ts:2556` and `:2558`.

**Delay.** Same: 60 minutes, 45 minute quiet gate.

**Exit criteria.** `value_activation`, checkout, deletion, or 7 days.

**Subject.** `You are connected. Here is the first thing to ask.`

**Body intent.** They have already done the setup, so do not restate it. Give
three concrete prompts, one link to the client guide for their selected client
(the URLs already exist in `apps/web/components/dashboard/Pages.jsx:250-415`),
and an offer to look at their setup. Draft:

> Everything is wired up on our side. [Client] just has not been asked anything
> yet.
>
> Three that work well to start:
> "Summarize my unread email from today."
> "Find the last thing [name] sent me and draft a reply."
> "Move everything from newsletters into an Archive folder."
>
> If [client] cannot see the connector, the setup step people usually miss is
> [one line, client-specific]. Guide: [link].
>
> [unsubscribe]

**The metric.** `value_activation` within 72 hours of the send. Base rate 13.3%.

### 4.3 M3: `activation_connection_failed` (BLOCKED, do not ship in v1)

**Population.** Shape D1, filtered hard. ~7 a week gross, but after the filters
below realistically **2 to 4 a week**.

**Blocked on:** P1 (`auth_reason` on the funnel) and P3 (the iCloud username
field). Shipping this without P1 means we can name the reason for 27% of them
and would have to send a generic "try again" to the rest, which is the exact
email section 2 argues against. Shipping it without P3 means telling iCloud
users to go back to a form that cannot accept the right answer.

**Trigger,** once P1 lands and `product_funnel_events.auth_reason` exists:

```sql
WITH agg AS (
  SELECT e.workspace_id,
         bool_or(e.stage='inbox_connection' AND e.outcome='success') AS connected,
         bool_or(e.stage='inbox_connection' AND e.outcome='failure'
                 AND e.error_category='auth_failed')                 AS auth_failed,
         max(e.occurred_at)                                          AS last_event_at,
         (array_agg(e.auth_reason ORDER BY e.occurred_at DESC)
            FILTER (WHERE e.auth_reason IS NOT NULL))[1]             AS reason,
         (array_agg(e.category ORDER BY e.occurred_at DESC)
            FILTER (WHERE e.stage='inbox_connection'
                      AND e.outcome='failure'))[1]                   AS provider
    FROM product_funnel_events e
   GROUP BY e.workspace_id
)
SELECT w.id, w.owner_id, u.email, a.reason, a.provider
  FROM workspaces w
  JOIN users u ON u.id = w.owner_id
  JOIN agg  a  ON a.workspace_id = w.id
 WHERE w.deleted_at IS NULL
   AND a.auth_failed
   AND NOT a.connected
   AND a.reason IN ('app_password_required','account_password_used','imap_disabled')
   AND a.provider <> 'icloud'          -- until P3 ships
   AND w.created_at <= now() - INTERVAL '60 minutes'
   AND w.created_at >= now() - INTERVAL '7 days'
   AND a.last_event_at <= now() - INTERVAL '45 minutes'
   AND NOT EXISTS (SELECT 1 FROM lifecycle_email_sends s
                    WHERE s.user_id = w.owner_id
                      AND s.template = 'activation_connection_failed');
```

`login_username_required` and `password_rejected` are deliberately excluded.
`login_username_required` is only actionable for generic IMAP today
(`ConnectModal.jsx:927`); `password_rejected` means "we do not know", and an
email that says "your password was wrong, try again" to somebody who already
tried three times is noise.

**Subject.** Reason-specific. `Yahoo will not accept your normal password` /
`Your mail host needs IMAP switched on` / `That looked like an account password`.

**Body intent.** One sentence naming the reason, one sentence with the exact
click path at that provider, one deep link back to the connect modal
pre-filled with the provider. No apology, no marketing.

**The metric.** `inbox_connection` with outcome `success` within 72 hours.
Base rate 0% (0 of 27). Any recovery at all is a win, which also means this is
the one message where a small n could show a real effect quickly.

### 4.4 Suppression rules (apply to all messages, at send time)

Suppression is a first-class gate here, not a filter tacked onto the send list.
It runs in this order and any hit stops the send permanently, writing a
`lifecycle_email_sends` row with `status='skipped'` and a `detail` naming the
rule, so the skip is auditable and the person is never re-evaluated.

1. **`isSuppressed(db, userId, 'lifecycle')`**
   (`apps/web/src/lib/email/lifecycle.ts:97`). Reads `users.unsubscribed_at`
   and `users.unsubscribed_categories`. **Fails closed**: a query error returns
   true and the send is skipped. Reuse this function verbatim. Do not write a
   second opt-out mechanism; the migration comment in
   `20260902130000_billing_lifecycle_emails.sql` explains at length why two
   opt-out systems is worse than either alone.
2. **Missing `unsubscribe_token`.** No token means no working opt-out link,
   which means we do not send. Same fail-closed rule the billing dispatcher
   applies to marketing rows (`dispatch/route.ts`, the `no_unsubscribe_token`
   branch).
3. **The outreach do-not-email list.** Per `project_outreach_suppression_list.md`
   this currently lives only in a memory file, which is not a suppression
   mechanism. **Promote it to a table**, `outreach_suppressions (email, reason,
   added_at)`, seeded by migration, so it can be added to without a deploy.
   Seed from what is actually in prod today:

   | Address | Why |
   |---|---|
   | `sandertorvik2@gmail.com` | owner's friend, stated 2026-06-23 |
   | `bjellanda@gmail.com` (2 workspaces) | owner |
   | `bjellanda+test@gmail.com`, `bjellanda+test2@gmail.com`, `bjellanda+glama-health@gmail.com` | owner test accounts |
   | `tor.jetix16@gmail.com` | comped test |
   | `agentweavetest@gmail.com` | test |
   | `test@email.com`, `test-auth-check@example.com` | test |
   | `seed-test@mcpemails.dev` | seed |
   | `hello@`, `demo@`, `reviewer@`, `directory-review@mcpemails.com` | internal |

   Plus two **pattern rules in code** as a backstop, because a new internal
   account will be created and nobody will remember the table: any address at
   `mcpemails.com` or `mcpemails.dev`, and any address containing `+`.
   The `+` rule will occasionally suppress a legitimate user who uses plus
   addressing. That is the correct trade at this volume.
4. **Address sanity.** Reject anything failing the same regex the billing
   sender uses (`billing-lifecycle.ts`, the `unusable_recipient` branch). One
   live stalled account is at the domain `shugaome.con`, a typo that will hard
   bounce. Every one of the 322 users created in the last 30 days has
   `auth.users.email_confirmed_at` set (magic-link OTP is the primary sign-in
   method per `supabase/config.toml`), so hard-bounce risk is genuinely low,
   but the guard costs nothing.
5. **Frequency cap.** At most **one** activation email per user, ever, across
   all three templates, in v1. Enforced by a `NOT EXISTS` against
   `lifecycle_email_sends` on `user_id` alone, not on `(user_id, template)`.
   This matters because the shapes are sequential: an E-bucket user who gets M1,
   creates a key and then stalls again becomes an F-bucket user, and would
   otherwise get M2 the same afternoon. Only 1 of 403 owners has more than one
   workspace, so a per-workspace cap would be nearly equivalent, but dedupe on
   `user_id` anyway.
6. **Global daily budget.** Hard cap of 40 activation sends in any rolling 24
   hours, counted from `lifecycle_email_sends`. If we ever exceed that,
   something is wrong with the trigger and the correct behaviour is to stop, not
   to mail 400 people.

---

## 5. Technical plan

### 5.1 Reuse map

| Need | Existing thing to reuse | Path |
|---|---|---|
| Scheduling | pg_cron + pg_net + `dispatch_secret` from Vault | `supabase/migrations/20260902130100_schedule_billing_lifecycle.sql` |
| Cron-to-route auth | `X-Dispatch-Secret`, constant-time compare | `apps/web/app/api/internal/billing-lifecycle/dispatch/route.ts` (the `authorised` function) |
| Kill switch pattern | `lifecycleMode()`, read at call time | `apps/web/src/lib/billing/lifecycle-mode.ts` |
| Opt-out read | `isSuppressed()` | `apps/web/src/lib/email/lifecycle.ts:97` |
| Opt-out write, RFC 8058 | `/api/email/unsubscribe` | `apps/web/app/api/email/unsubscribe/route.ts` |
| Unsubscribe URL + token | `unsubscribeUrl()` | `apps/web/src/lib/email/lifecycle.ts:70` |
| Sender identity | `lifecycleFrom()` | `apps/web/src/lib/email/lifecycle.ts:59` |
| Send + idempotency key + List-Unsubscribe headers | `sendBillingLifecycleEmail()` as the template to copy | `apps/web/src/lib/email/billing-lifecycle.ts:1020` |
| HTML shell, footer, escaping | the composer in `billing-lifecycle.ts` (the `footerNote` shell around :490) | same file |
| Ledger / idempotency | **`lifecycle_email_sends`, already created, already empty, already RLS'd** | `supabase/migrations/20260902140000_lifecycle_email_preferences.sql:85` |
| Observability page pattern | `/admin/growth/dunning` | `apps/web/app/admin/growth/dunning/page.tsx` |

The two existing transactional emails, for reference and for the "do not
import lifecycle plumbing into these" rule: `sendInviteEmail`
(`apps/web/src/lib/email/send-invite.ts:33`, from `invites@mcpemails.com`) and
`sendPurchaseConfirmationEmail`
(`apps/web/src/lib/email/purchase-confirmation.ts:311`, from
`hello@mcpemails.com`).

### 5.2 Scheduler choice: pg_cron, not Vercel Cron

Three reasons, in order of weight.

1. **The Vault secret already exists and is proven.** `dispatch_secret` is
   provisioned and three dispatchers already use it. A Vercel Cron would need
   its own auth story or would reuse `DISPATCH_SECRET`, which Vercel Cron cannot
   set as a request header without a wrapper.
2. **There are no Vercel crons on this project and one config trap waiting.**
   The repo-root `vercel.json` is dead because Root Directory is `apps/web`
   (`project_vercel_json_dead_config_owner.md`), and `apps/web/vercel.json` does
   not exist. Introducing the project's first Vercel cron means creating that
   file and discovering whatever it breaks, for no gain.
3. **Consistency of failure mode.** Three dispatchers already fail the same way
   and are debugged the same way. A fourth in a different system is a fourth
   thing to remember at 2am.

**Job:** `dispatch-activation-lifecycle`, `*/15 * * * *`, calling a new
`public.dispatch_activation_lifecycle()` that mirrors
`dispatch_billing_lifecycle` exactly, including the Vault sub-block that
downgrades a missing secret to a WARNING rather than erroring the run.

Fifteen minutes, not five: the tightest deadline in this feature is "60 minutes
after signup", and a quarter hour of jitter against a 60 minute target is
irrelevant. Fewer ticks is less noise in the logs and less contention with the
five-minute billing dispatcher and the one-minute scheduled-send and triage
dispatchers.

**Route:** `POST /api/internal/activation-lifecycle/dispatch`, a new route
rather than a mode on the billing one. The billing dispatcher's whole shape is
"claim a materialised row, re-check it against Stripe, send"; this one is
"query the funnel, claim by ledger insert, send". Bolting a second control flow
onto a route that currently reads cleanly would make both worse. It should
still live in the Next.js app for the same reason the billing one does: Resend,
the templates and the plan copy are all here and none of them exist in Deno.

### 5.3 Why there is no materialised queue

The billing feature materialises the whole sequence at trigger time because its
truth lives in Stripe and re-deriving it means an API call per row. Our truth
lives in `product_funnel_events`, one table we own, so re-deriving is a single
query and is strictly better: a materialised row would need a cancel path for
every exit condition (credential created, tool call, value activation,
checkout, workspace deleted), and every one of those cancel paths is a place to
forget to write the cancel.

Instead: the candidate query *is* the state machine, evaluated fresh every 15
minutes, and it can only ever return people who are stalled right now.

### 5.4 Idempotency

Three layers, each catching what the one above cannot.

1. **Claim-then-send against `lifecycle_email_sends`.** Before composing, insert
   `(user_id, template, trigger_key = workspace_id, email, status='sent')` with
   `ON CONFLICT DO NOTHING`. **A zero-row result means somebody already has this
   email: skip.** This is the primary key doing the work, exactly as the table
   comment describes, and exactly as `stripe_webhook_events` works. Then send.
   Then `UPDATE` the row to `status='failed'` plus `detail` if the send failed,
   or write `provider_message_id` if it succeeded.

   The failure direction is deliberate: a crash between claim and send loses one
   email. That is the correct loss. The table comment already states the rule
   ("Rows with status failed are deliberately KEPT: a failed attempt is still an
   attempt, and a blind retry is how someone gets two copies"). **No retries.**

2. **Resend `Idempotency-Key`.** `${template}-${workspace_id}`, same shape as
   `billing-lifecycle.ts:1074`. This catches the one case layer 1 cannot: a lost
   HTTP response where Resend accepted the message but we never learned it. If
   a future version ever does retry, Resend collapses it.

3. **Redeploy safety.** The candidate query has no memory and no module-scope
   state, so a redeploy mid-tick cannot resend anything: the ledger row is
   already there. The one thing that *is* redeploy-sensitive is the kill switch,
   and it must be a function read at call time, never a `const`, for the reason
   spelled out in `lifecycle-mode.ts`. **And note the operational fact from
   `project_billing_lifecycle_emails.md`: changing `ACTIVATION_LIFECYCLE_EMAILS`
   in Vercel does NOT reach warm functions. It needs
   `vercel redeploy <prod-url>`.** Reading it at call time makes the switch
   testable; it does not remove the redeploy.

### 5.5 Modes

`ACTIVATION_LIFECYCLE_EMAILS`, mirroring `BILLING_LIFECYCLE_EMAILS`:

- `off` (default): the route returns immediately. Safe to schedule the cron
  before the feature is signed off.
- `queue_only`: run the real candidate query against real production data,
  compose every email for real, write **nothing** to the ledger, and return the
  list of `{workspace_id, template, masked_recipient, subject}`. This is how the
  targeting gets reviewed before a human sees an email, and it is the single
  most valuable mode in this plan: it lets the founder read the actual list of
  21 people who would have been mailed this morning and check that none of them
  should not have been.
- `on`: send.

Reuse `maskAddress()` from the billing dispatcher for the report. A cron
response body is not a place for a customer list.

### 5.6 Where sends are logged

`lifecycle_email_sends` is both the idempotency key and the measurement
substrate: `(user_id, template, trigger_key, email, provider_message_id,
status, detail, sent_at)`. Every outcome writes a row, including skips, so the
suppression rules are auditable.

**Gap to close:** unlike `billing_email_sends`, this table has **no retention
job**. Add `activation-email-retention`, daily, deleting rows older than 180
days, matching the billing precedent and the analytics retention policy in
`project_analytics_retention_enforced.md`.

**Observability:** `/admin/growth/activation-email`, copying
`/admin/growth/dunning`. Minimum: sends by template by day, skips by rule,
failures, and the recovery rate of the treated arm versus the holdout.

---

## 6. Compliance and sender reputation

### 6.1 Category: these are lifecycle, not transactional

All three messages carry `List-Unsubscribe` and are suppressible. This is
arguable for M3, where the person did attempt an action and could be said to
have asked for the answer. Send it as lifecycle anyway, for one reason: the
downside is asymmetric. A suppressible email that somebody wanted costs us one
lost activation. A non-suppressible email that somebody did not want costs a
spam complaint on `mcpemails.com`, which is the same domain and the same DKIM
key that delivers dunning mail and purchase receipts.

Do not reuse the billing feature's generated-column trick here. In
`billing_email_sends` the category is derived from the template name by the
database precisely so a transactional template is structurally incapable of
being suppressed. In this feature **everything is suppressible**, so a constant
is correct and clearer. Do not create a second table with a second generated
category column that says the same thing.

### 6.2 Sender reputation is not isolated, and this feature is the test of that

Commit `6201adf` ("docs(billing): stop claiming sender reputation is isolated
when it is not") removed a false claim from the code comments. The facts, from
`project_billing_lifecycle_emails.md`:

- Resend has exactly one verified domain, `mcpemails.com`, one DKIM key.
- Transactional goes from `hello@mcpemails.com`, lifecycle from
  `asgeir@mcpemails.com`. The split buys a reply landing with a person. It buys
  **zero** deliverability insulation, because providers score the domain.
- So a complaint rate on activation email degrades delivery of dunning email,
  purchase confirmations and workspace invites.

Consequences for this plan, all of which are already baked into the specs above:

- One email per person in v1, not a sequence.
- Hard daily cap of 40.
- Prominent opt-out, one click, no confirmation page.
- Named threshold for revisiting: if activation email volume ever exceeds
  **500 sends a month**, move it to a subdomain with its own DKIM. At the
  projected 33 a week it is not worth the DNS, and doing it prematurely just
  starts a cold subdomain with no warming.
- **Never add `include:amazonses.com` to the root SPF record.** Migadu owns the
  root SPF and root MX. Resend uses `send.mcpemails.com` as its custom
  Return-Path, so envelope SPF is evaluated there, and DKIM signs `d=mcpemails.com`
  which aligns with the From header and satisfies DMARC (`p=quarantine`) on its
  own. This is documented in `project_resend_domain_unverified.md` and is the
  single most expensive mistake available in this area.

### 6.3 Bounce and complaint handling does not exist yet

There is no Resend webhook consumer in the repo. Today a hard bounce or a spam
complaint on any of our email produces no state change anywhere. That is
tolerable at two win-backs a month. At 33 activation emails a week to people
who never asked for anything, it is not.

**Add `POST /api/internal/resend/webhook`** handling `email.bounced` (hard only)
and `email.complained`, writing `users.unsubscribed_at`. Verify the Svix
signature. Cost: half a day. This is listed as prerequisite P2.

### 6.4 CAN-SPAM and GDPR

- **CAN-SPAM.** Requires a valid physical postal address in every commercial
  message, a clear opt-out, honoured within 10 business days, and a non-deceptive
  subject line and From. Opt-out and honouring are done (the endpoint writes
  immediately). **The postal address is missing.** `SUPPORT_FOOTER` in
  `apps/web/src/lib/email/billing-lifecycle.ts:523` contains no address, which
  means the two live `winback_*` templates are already non-compliant if anyone
  cares to look. Add the registered address from
  `project_founder_identity_trust.md` (Albretsen Consulting ENK, org 926 646 753,
  Bergen, Norway) to the shared footer, which fixes both features at once.
- **GDPR.** Lawful basis is legitimate interest (Art. 6(1)(f)): the recipient is
  an existing registered user of the service, the message concerns the service
  they signed up for, the frequency is one message, and opting out is one click.
  Write the balancing test down somewhere durable, because "we did the balancing
  test" is only a defence if it exists on paper. The soft opt-in under ePrivacy
  Art. 13(2) also applies: the address was collected in the course of providing
  the service, and every message offers a free opt-out.
  Data minimisation: the composer must never put mailbox contents, credentials,
  a host name or an email address other than the recipient's own into the body.
  Retention: 180 days on `lifecycle_email_sends` (section 5.6).
  Right to erasure: `lifecycle_email_sends.user_id` is
  `ON DELETE CASCADE` already, so a user deletion takes the ledger rows with it.

---

## 7. Measurement plan

### 7.1 Primary metric and baseline

**Primary:** value activation within 7 days of the trigger moment, per stalled
workspace, treated arm versus holdout.

**Baseline:** 6.1% (8 of 131), from cohort B, workspaces stalled at 24 hours.
Per shape: E 8.8%, F 13.3%, G 13.3%, C 7.7%, D1 0%.

### 7.2 The holdout

**50/50, not 90/10.** The base rate is too low for an unbalanced split to
finish this decade. Randomise on a stable hash of `workspace_id` so the
assignment survives redeploys and is recomputable after the fact, and record the
arm in `lifecycle_email_sends.detail` (or a dedicated column) for the treated
arm and in a `status='skipped'` row with `detail='holdout'` for the control. A
holdout that leaves no trace is not a holdout, it is an absence.

The A/B infrastructure from 2026-09-03 already exists
(`project_ab_experiments_system_20260903.md`: tables, `getExperimentVariant`,
`/admin/growth/experiments`, with `value_activation` already a supported
retention goal at `apps/web/src/lib/experiments/constants.ts:40`). Use it rather
than inventing a second assignment mechanism.

### 7.3 Decision threshold, stated up front

To detect a **doubling** of recovery, 6.1% to 12.2%, at 80% power and a 5%
two-sided alpha, requires approximately **349 stalled workspaces per arm, about
700 total**. At the current ~50 stalls a week that is **roughly 14 weeks**,
fewer if signup growth continues at the recent rate (25, 44, 61, 76, 105 in the
five weeks to 2026-08-31).

Say this plainly, because it is the most important sentence in the measurement
section: **this experiment will not produce a trustworthy answer for about a
quarter, and anything read from it before then is noise.** The failure mode to
avoid is looking at week 3, seeing 4 recoveries versus 1, and declaring victory.

Pre-registered rules:

- **One interim look at n=350 total (175 per arm), for futility only.** If the
  treated arm is at or below the control, stop and delete the feature. Do not
  stop early for success.
- **Ship-it threshold at n=700:** treated arm recovery must beat control with
  p < 0.05 one-sided. If it does not, turn the emails off and write up why.
- **Secondary metric, reported but not decisive:** any funnel event within 72
  hours of the send. Base rate is 18.5% (20 of 108), which is higher and
  therefore noisier per unit of signal, not less. It is useful as a sanity
  check that the emails are being read at all, not as a substitute.
- **Operational metrics, monitored weekly from day one and decisive on their
  own:** delivery rate, hard bounce rate, complaint rate, unsubscribe rate.
  **Any complaint rate above 0.1% stops the feature immediately**, regardless of
  the activation numbers, because of the shared-domain problem in 6.2.

### 7.4 What this is worth if it works

Be honest about the size. Of workspaces created since 2026-08-05, 175 value
activated and 9 of those ever completed a checkout: **5.1% value-to-paid**. If
the emails double stalled recovery from 6.1% to 12.2% on 50 stalls a week, that
is about +3 activations a week, about +0.15 paying customers a week, roughly
**+$10 MRR added per month of running**, compounding.

Against a current run-rate around $420 a year that is not nothing. Against the
build cost (2 to 3 days plus prerequisites) it is a reasonable bet. It is not a
growth lever and should not be sold as one. The product fixes in section 2.2
act on 145 activations a week's worth of upstream population and are worth more.

---

## 8. Prerequisites, separated from the email work

| ID | What | Why it blocks | Rough cost |
|---|---|---|---|
| **P1** | Add `auth_reason text` to `product_funnel_events` and a matching `authReason` field on `ProductFunnelEvent`, written at the four `auth_failed` call sites | Without it, M3 can name the reason for only 27% of its population. See below. | **Half a day** |
| **P2** | Resend webhook consumer for `email.bounced` (hard) and `email.complained`, writing `users.unsubscribed_at` | Sending to a population that never asked for mail with no complaint feedback loop is how a shared sending domain gets burned. Section 6.3. | **Half a day** |
| **P3** | Ungate the IMAP username field for branded providers, or at minimum for iCloud (`ConnectModal.jsx:1809`, and the recovery branch at `:927`) | Blocks M3 for iCloud specifically. Also a product fix worth doing on its own. | **1 day** |
| **P4** | Postal address in the shared email footer (`billing-lifecycle.ts:523`) | CAN-SPAM. Also retroactively fixes the two live `winback_*` templates. | **1 hour** |
| **P5** | `outreach_suppressions` table plus migration seeding the 13 known addresses, plus the two pattern rules in code | Section 4.4 rule 3. A memory file is not a suppression mechanism. | **2 hours** |
| **P6** | Retention job on `lifecycle_email_sends`, 180 days | Section 5.6. `billing_email_sends` has one, this does not. | **1 hour** |

P2, P4, P5 and P6 block **M1 and M2** and must land first. P1 and P3 block only
M3.

### 8.1 On P1 specifically: it is cheaper than it looks and worth more than expected

The prior analysis said `auth_reason` is computed five ways
(`apps/web/src/lib/email/auth-failure.ts:36`), shown to the user, and never
written to the funnel, so "why did this connection fail" is unanswerable. That
is true of `product_funnel_events`.

**But it is partly answerable today from somewhere else.** The four connect
routes already pass `authReason` into `captureError`, which lands in
`app_errors.context`:

- `apps/web/app/api/inboxes/imap/route.ts:240` and `:301`
- `apps/web/app/api/inboxes/app-password/route.ts:267` and `:315`
- `apps/web/app/api/inboxes/fastmail-app-password/route.ts:223` and `:254`

Querying `app_errors.context->>'authReason'` for the last 30 days returns real
distributions:

| authReason | Route | Events | Workspaces |
|---|---|---:|---:|
| `password_rejected` | imap | 42 | 12 |
| `account_password_used` | app-password | 29 | 14 |
| `app_password_required` | app-password | 21 | 5 |
| `account_password_used` | imap | 8 | 7 |
| `imap_disabled` | app-password | 5 | 4 |
| `imap_disabled` | imap | 2 | 1 |
| `app_password_required` | imap | 1 | 1 |
| (null) | imap | 11 | 5 |

**Coverage is the problem, not existence.** Of 105 workspaces with an
`auth_failed` funnel event in the last 30 days, only **34 (32%)** have a
recoverable reason in `app_errors`. Of the 33 D1 workspaces specifically, only
**9 (27%)** do. The OAuth callback routes never call `explainAuthFailure` at
all, and `app_errors` is a diagnostic table that was never meant to be joined
against the funnel by workspace id.

So: **do not build M3 on the `app_errors` join.** It is a good enough proof that
the classifier works and that the reasons are real, and a bad foundation for a
production trigger. Do P1, which is one column, one optional field on
`ProductFunnelEvent` (`apps/web/src/lib/analytics/product-funnel.ts:21-38`), and
one added property at four existing call sites that already have the value in
scope. Half a day, and it takes reason coverage from 27% to 100% while also
finally making "did naming the app-password case reduce repeat attempts"
answerable, which is the question the comment at `imap/route.ts:240` says the
field exists to answer.

**Migration collision warning:** per
`feedback_shared_tree_migration_collision.md`, check `git status` and
`database.types.ts` for untracked peer work before adding this migration. The
working tree already has five untracked `docs/PROMPT-*.md` files and modified
growth files.

---

## 9. Open questions for the founder

1. **Do we ship M1 and M2 before P1 and P3, or hold everything for one
   release?** My recommendation is ship M1 and M2 first (they need only P2, P4,
   P5, P6, about a day and a half of prerequisites) and start the holdout clock
   immediately, because the clock is 14 weeks long. M3 follows when P1 and P3
   land.
2. **Is `asgeir@mcpemails.com` the right From for an activation email, or should
   it be `hello@`?** The billing win-backs use `asgeir@` so replies reach a
   person. That is the right instinct here too, but it means these emails share
   a From with marketing win-backs, and a complaint on one is a complaint on
   both. No data either way.
3. **How much personal reply volume are you willing to absorb?** Both drafts end
   with "reply and tell me what you see". At 33 sends a week and, say, a 5% reply
   rate, that is a couple of real support conversations a week. That is probably
   the highest-value thing in this whole plan, and it is also the part that does
   not scale.
4. **Are you comfortable suppressing every address containing `+`?** It will
   catch a small number of real users who use plus-addressing deliberately. The
   alternative is that the next `bjellanda+something@gmail.com` test account
   receives a product email.
5. **The 14 week measurement horizon.** Are you willing to run this for a
   quarter before deciding, or would you rather ship it to 100% with no holdout,
   accept that we will never know whether it worked, and spend the measurement
   effort on the section 2.2 product fixes instead? That is a defensible
   position at this scale and I would not argue hard against it. If you take it,
   say so explicitly now, because a holdout that gets abandoned in week 4 is
   worse than never having one.
6. **ChatGPT at 55.1% activation versus Claude at 79.4% (n=49).** This is a
   bigger measured gap than anything email can address. Should it jump the queue?
7. **Should M1 mention pricing at all?** It must not. But worth confirming: the
   in-modal $5 button converts 3 of 3 and the pricing page 0 of 15
   (`project_cohort_review_20260902.md`), so any link to `/pricing` in an
   activation email is a leak, not a fallback.

---

## Appendix: queries used

All run 2026-09-07 with `npx supabase db query --linked -f <file>`, read-only,
against production. SQL files are in the session scratchpad. Key ones:

- Stage counts, 7 days, distinct workspaces per stage and outcome.
- Stall taxonomy, cohort A (7 day, all-time events) and cohort B (from
  2026-08-05, 24 hour classification, followed for recovery).
- Time to value activation, 30 days, bucketed and median.
- Staller dwell time, 30 days, signup to last event.
- Recovery of workspaces stalled at 24 hours, 90 days and clean cohort.
- Any funnel event after 24 hours and after 7 days among stallers.
- Connect failure breakdown by provider, error category and phase, 30 days and
  D1-only.
- `app_errors.context->>'authReason'` distribution and coverage against
  `auth_failed` funnel events.
- Activation rate by credential method and by selected client, 90 days.
- Value-to-paid rate, cohort from 2026-08-05.
- `auth.users.email_confirmed_at` coverage, 30 days.
- Workspaces per owner.

### Things I am guessing about, flagged

- **The 14 week horizon assumes stall volume stays near 50 a week.** Signups
  grew 25 to 105 a week over five weeks. If that continues the horizon shortens
  a lot. It could also be a spike.
- **The M1 metric base rate.** I quote 8.8% for shape E, which is
  value activation. `credential_created` within 72 hours will be higher and I
  have not measured it, because the natural experiment (stalled E users who
  later create a key) has n=3.
- **The 5.1% value-to-paid rate** is 9 of 175 on a cohort barely a month old.
  Annual subscribers and later conversions are not in it.
- **The reply-rate estimate in open question 3** is a pure guess with no data
  behind it.
- **Whether `app_errors` coverage is 32% because of route coverage or because of
  volume.** I did not chase it down, because the recommendation (do P1, do not
  build on the join) is the same either way.
