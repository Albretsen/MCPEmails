-- ===========================================================================
-- THE PEOPLE, ONE ROW EACH: the data behind /admin/growth/users.
--
-- WHY THIS FILE EXISTS
-- /admin/growth answers "how is the business doing" and answers it entirely in
-- aggregates. The single exception is the roster in `growth_active_workspaces`,
-- which lists WORKSPACES that made a call in the last N days -- so a person who
-- signed up and never connected a mailbox, which is 40% of them, appears
-- nowhere on the board at all. Every question of the form "who is this
-- address", "did that Gmail connection ever succeed", "what did the customer
-- who bought on Tuesday do first" has been answered by hand-written SQL since
-- the product launched. This is that SQL, named and cached.
--
-- THE UNIT IS A PERSON, not a workspace. `public.users` is the row the product
-- treats as a person (see 20260907170000), a person who deletes a workspace
-- still signed up, and a person with two has not signed up twice. Every count
-- below therefore hangs off a user id, and workspaces are one of the things a
-- user HAS.
--
-- USAGE IS ATTRIBUTED TO THE WORKSPACE OWNER, and only to the owner. A member
-- of somebody else's workspace shows zero calls here even when they made them,
-- because `activity_log` records the workspace an API key belonged to and not
-- the human holding it -- there is nothing in the row to attribute more finely.
-- Member seats are paid-only and there are single digits of them, so the error
-- is small, but it is real and the page says so rather than implying a
-- precision the data cannot support. The `memberships` column exists so the
-- handful of affected people are at least visible as such.
--
-- WINDOWS. Anything counted from `activity_log` is bounded by p_days and is
-- capped at 90 by its caller, because that is when the table is purged. The
-- durable columns -- users.created_at, workspaces.onboarding_*_at,
-- workspaces.analytics_first_*_at, inboxes.created_at -- survive the purge and
-- are reported all-time. Two clocks on one page is a trap, so every function
-- here keeps the two kinds in separately named columns and never mixes them
-- into one figure.
--
-- PRIVACY. This is the second deliberate identity surface in the schema, after
-- growth_active_workspaces, and it is a wider one: email address, display name,
-- acquisition referrer, and the address of every connected mailbox. It returns
-- NO credential, token, message content, subject, recipient, IP address or user
-- agent. Every function is SECURITY INVOKER and granted to service_role only,
-- so the only way to reach it is the ADMIN_EMAILS session on /admin/growth. The
-- kiosk hangs on a wall behind a shared token and must never gain a caller.
--
-- Forward-only. No previously applied migration file is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- How a connected mailbox should be NAMED.
--
-- `provider` alone is useless on half the estate: every app-password
-- connection is stored as 'imap', so Fastmail, iCloud, Zoho and a self-hosted
-- Dovecot all read the same. `service` carries the real one when there is one.
-- Copied out of growth_active_workspaces so the two surfaces cannot drift into
-- naming the same mailbox two different things.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_inbox_label(p_provider text, p_service text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_provider = 'imap' AND p_service IS NOT NULL AND p_service <> 'generic' THEN p_service
    ELSE p_provider
  END;
$$;


-- ---------------------------------------------------------------------------
-- growth_user_directory(p_days, p_limit, p_user_id)
--
-- One row per person, newest signup first. Pass p_user_id to get exactly one
-- person; pass NULL for everybody. ONE function rather than a list function
-- plus a detail function on purpose: the header of the detail page prints the
-- same twelve figures the list column shows, and two functions computing them
-- from two queries is how a page ends up disagreeing with itself.
--
-- Sorting, searching and paging happen in TypeScript, not here. At four
-- hundred rows the whole table is smaller than one of the charts on the growth
-- board, it is cached for ten minutes, and a sort key baked into SQL would be
-- a dynamic ORDER BY -- which is either a twelve-branch CASE or a string
-- concatenation, and neither is worth it until this table is thousands long.
-- p_limit is the guard for that day, and `total_rows` reports the true count so
-- a truncated read is visible instead of silent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_directory(p_days int, p_limit int, p_user_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  avatar_url text,
  signed_up_at timestamptz,
  is_internal boolean,
  unsubscribed_at timestamptz,
  unsubscribed_categories text[],

  workspaces int,
  memberships int,
  primary_workspace_id uuid,
  primary_workspace_name text,
  primary_workspace_slug text,
  plan text,
  is_comped boolean,
  unlimited_inboxes boolean,
  grandfathered boolean,

  acquisition_source text,
  acquisition_utm_source text,
  acquisition_utm_medium text,
  acquisition_utm_campaign text,
  acquisition_landing_path text,
  acquisition_referrer text,
  acquisition_locale text,

  onboarding_stage text,
  onboarding_client text,
  first_inbox_connected_at timestamptz,
  first_inbox_provider text,
  first_credential_created_at timestamptz,
  first_credential_method text,
  first_tool_used_at timestamptz,
  first_tool_name text,
  first_tool_client text,
  value_activated_at timestamptz,

  inboxes int,
  inboxes_broken int,
  providers text,
  api_keys int,
  key_last_used_at timestamptz,

  calls int,
  successes int,
  active_days int,
  last_active_at timestamptz,
  paywall_hits int,

  billing_plan text,
  subscription_status text,
  stripe_customer_id text,
  current_period_end timestamptz,

  total_rows int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 90), 1) - 1))::timestamp)
        AT TIME ZONE 'utc') AS window_start
  ),
  -- The population. Filtering here rather than at the end keeps every rollup
  -- below scanning one person's rows when a detail page asks for one person.
  people AS (
    SELECT u.* FROM public.users u
    WHERE p_user_id IS NULL OR u.id = p_user_id
  ),
  -- Live workspaces only. A deleted workspace keeps its rows but stops being
  -- something the person has; the timeline is where a deletion shows up.
  owned AS (
    SELECT w.*
    FROM public.workspaces w
    JOIN people p ON p.id = w.owner_id
    WHERE w.deleted_at IS NULL
  ),
  -- The workspace created at signup, which is the one carrying the acquisition
  -- columns worth reading. Later workspaces are created from inside the product
  -- and their acquisition_* are all NULL by construction.
  primary_ws AS (
    SELECT DISTINCT ON (w.owner_id) w.*
    FROM owned w
    ORDER BY w.owner_id, w.created_at ASC
  ),
  -- Everything that is a max/min over ALL of a person's workspaces rather than
  -- over the first one: they can connect a mailbox in the second workspace.
  --
  -- THE ANALYTICS COLUMNS ARE NOT TRUSTED ON THEIR OWN, and the journey panel
  -- is what exposed it: for a customer who signed up in July they read 2 and 3
  -- September, six weeks after the mailbox and the key those dates are supposed
  -- to be about. They were only written from the day the funnel instrumentation
  -- shipped, so for everybody older they date the instrumentation and not the
  -- event, and a journey drawn from them reads as three steps taken out of
  -- order.
  --
  -- Each rung is therefore floored by something that PROVES the step happened,
  -- and by nothing else. Not by tidiness: every floor below is a definition.
  --   a mailbox row IS a connection      -> min(inboxes.created_at)
  --   an api key row IS a credential     -> min(api_keys.created_at)
  --   value activation IS a tool call, by its own definition, and so is
  --   technical activation               -> floors the first-call date
  -- Nothing is floored by a later rung in general, because that would invent an
  -- ordering rather than record one. What inconsistency survives is real, and
  -- the page prints it as out of order rather than hiding it.
  owned_rollup AS (
    SELECT
      w.owner_id,
      count(*)::int AS workspaces,
      bool_or(w.grandfathered) AS grandfathered,
      max(CASE w.plan
            WHEN 'enterprise' THEN 4 WHEN 'pro' THEN 3
            WHEN 'solo' THEN 2 WHEN 'personal' THEN 1 ELSE 0 END) AS plan_rank,
      least(
        min(w.analytics_first_inbox_connected_at),
        min(w.onboarding_inbox_connected_at),
        min(first_inbox.at)
      ) AS first_inbox_connected_at,
      least(
        min(w.analytics_first_credential_created_at),
        min(w.onboarding_credential_issued_at),
        min(first_key.at)
      ) AS first_credential_created_at,
      least(
        min(w.analytics_first_tool_used_at),
        min(w.onboarding_technical_activated_at),
        min(w.onboarding_value_activated_at)
      ) AS first_tool_used_at,
      min(w.onboarding_value_activated_at) AS value_activated_at
    FROM owned w
    LEFT JOIN LATERAL (
      SELECT min(i.created_at) AS at FROM public.inboxes i WHERE i.workspace_id = w.id
    ) first_inbox ON true
    LEFT JOIN LATERAL (
      SELECT min(k.created_at) AS at FROM public.api_keys k WHERE k.workspace_id = w.id
    ) first_key ON true
    GROUP BY w.owner_id
  ),
  -- Seats on somebody else's workspace. Counted separately because none of the
  -- usage below can see them; see the header.
  memberships AS (
    SELECT m.user_id, count(*)::int AS memberships
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id
    JOIN people p ON p.id = m.user_id
    WHERE w.deleted_at IS NULL AND w.owner_id <> m.user_id
    GROUP BY m.user_id
  ),
  usage AS (
    SELECT
      w.owner_id AS user_id,
      count(*)::int AS calls,
      count(*) FILTER (WHERE a.status = 'success')::int AS successes,
      count(DISTINCT (a.created_at AT TIME ZONE 'utc')::date)
        FILTER (WHERE a.status = 'success')::int AS active_days,
      max(a.created_at) AS last_active_at
    FROM public.activity_log a
    JOIN owned w ON w.id = a.workspace_id
    CROSS JOIN bounds b
    WHERE a.created_at >= b.window_start
    GROUP BY w.owner_id
  ),
  inbox_rollup AS (
    SELECT
      w.owner_id AS user_id,
      count(*) FILTER (WHERE i.status = 'active')::int AS inboxes,
      count(*) FILTER (WHERE i.status <> 'active')::int AS inboxes_broken,
      string_agg(DISTINCT public.growth_inbox_label(i.provider, i.service), ', '
        ORDER BY public.growth_inbox_label(i.provider, i.service)) AS providers
    FROM public.inboxes i
    JOIN owned w ON w.id = i.workspace_id
    WHERE i.deleted_at IS NULL
    GROUP BY w.owner_id
  ),
  key_rollup AS (
    SELECT w.owner_id AS user_id, count(*)::int AS api_keys, max(k.last_used_at) AS key_last_used_at
    FROM public.api_keys k
    JOIN owned w ON w.id = k.workspace_id
    WHERE k.deleted_at IS NULL
    GROUP BY w.owner_id
  ),
  -- All-time, not windowed: a cap rejection is the single most decision-shaped
  -- event in this schema and there are few enough of them to count forever.
  paywall AS (
    SELECT w.owner_id AS user_id, count(*)::int AS paywall_hits
    FROM public.usage_limit_events e
    JOIN owned w ON w.id = e.workspace_id
    GROUP BY w.owner_id
  ),
  entitlement AS (
    SELECT
      e.user_id,
      coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false) AS is_comped,
      coalesce(e.unlimited_inboxes, false) AS unlimited_inboxes
    FROM public.user_usage_entitlements e
    JOIN people p ON p.id = e.user_id
  )
  SELECT
    u.id,
    u.email,
    nullif(u.display_name, ''),
    u.avatar_url,
    u.created_at,
    public.growth_is_internal_email(u.email),
    u.unsubscribed_at,
    u.unsubscribed_categories,

    coalesce(o.workspaces, 0),
    coalesce(m.memberships, 0),
    pw.id,
    coalesce(nullif(pw.display_name, ''), pw.slug),
    pw.slug,
    CASE coalesce(o.plan_rank, 0)
      WHEN 4 THEN 'enterprise' WHEN 3 THEN 'pro'
      WHEN 2 THEN 'solo' WHEN 1 THEN 'personal' ELSE 'free' END,
    coalesce(ent.is_comped, false),
    coalesce(ent.unlimited_inboxes, false),
    coalesce(o.grandfathered, false),

    pw.acquisition_source,
    pw.acquisition_utm_source,
    pw.acquisition_utm_medium,
    pw.acquisition_utm_campaign,
    pw.acquisition_landing_path,
    pw.acquisition_referrer,
    pw.acquisition_locale,

    pw.onboarding_stage,
    coalesce(pw.onboarding_client, pw.analytics_first_tool_client),
    o.first_inbox_connected_at,
    pw.analytics_first_inbox_provider,
    o.first_credential_created_at,
    pw.analytics_first_credential_method,
    o.first_tool_used_at,
    pw.analytics_first_tool_name,
    pw.analytics_first_tool_client,
    o.value_activated_at,

    coalesce(ib.inboxes, 0),
    coalesce(ib.inboxes_broken, 0),
    ib.providers,
    coalesce(k.api_keys, 0),
    k.key_last_used_at,

    coalesce(us.calls, 0),
    coalesce(us.successes, 0),
    coalesce(us.active_days, 0),
    us.last_active_at,
    coalesce(pay.paywall_hits, 0),

    b.plan,
    b.subscription_status,
    b.stripe_customer_id,
    b.current_period_end,

    count(*) OVER ()::int
  FROM people u
  LEFT JOIN owned_rollup o ON o.owner_id = u.id
  LEFT JOIN memberships m ON m.user_id = u.id
  LEFT JOIN primary_ws pw ON pw.owner_id = u.id
  LEFT JOIN inbox_rollup ib ON ib.user_id = u.id
  LEFT JOIN key_rollup k ON k.user_id = u.id
  LEFT JOIN usage us ON us.user_id = u.id
  LEFT JOIN paywall pay ON pay.user_id = u.id
  LEFT JOIN entitlement ent ON ent.user_id = u.id
  LEFT JOIN public.user_billing b ON b.user_id = u.id
  ORDER BY u.created_at DESC
  LIMIT greatest(coalesce(p_limit, 2000), 1);
$$;

COMMENT ON FUNCTION public.growth_user_directory(int, int, uuid) IS
  'One row per person for /admin/growth/users. p_user_id NULL for everybody, or an id for one. Usage columns are windowed by p_days and attributed to the workspace OWNER; every *_at column is durable and all-time. total_rows is the count before p_limit.';


-- ---------------------------------------------------------------------------
-- growth_user_workspaces(p_user_id, p_days)
--
-- Every workspace the person touches, owned or joined, DELETED ONES INCLUDED.
-- The directory above counts live workspaces because that is what a person
-- currently has; this list is the record, and a deleted workspace is exactly
-- the row somebody opening a detail page is looking for.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_workspaces(p_user_id uuid, p_days int)
RETURNS TABLE (
  workspace_id uuid,
  name text,
  slug text,
  role text,
  plan text,
  grandfathered boolean,
  created_at timestamptz,
  deleted_at timestamptz,
  onboarding_stage text,
  inbox_connected_at timestamptz,
  credential_created_at timestamptz,
  first_tool_used_at timestamptz,
  value_activated_at timestamptz,
  acquisition_source text,
  acquisition_utm_source text,
  acquisition_utm_medium text,
  acquisition_utm_campaign text,
  acquisition_landing_path text,
  acquisition_referrer text,
  members int,
  inboxes int,
  api_keys int,
  calls int,
  successes int,
  last_active_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 90), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  ),
  scoped AS (
    SELECT w.*, 'owner'::text AS role FROM public.workspaces w WHERE w.owner_id = p_user_id
    UNION
    SELECT w.*, 'member'::text AS role
    FROM public.workspaces w
    JOIN public.workspace_members m ON m.workspace_id = w.id
    WHERE m.user_id = p_user_id AND w.owner_id <> p_user_id
  )
  SELECT
    s.id,
    coalesce(nullif(s.display_name, ''), s.slug),
    s.slug,
    s.role,
    coalesce(s.plan, 'free'),
    s.grandfathered,
    s.created_at,
    s.deleted_at,
    s.onboarding_stage,
    s.analytics_first_inbox_connected_at,
    s.analytics_first_credential_created_at,
    s.analytics_first_tool_used_at,
    s.onboarding_value_activated_at,
    s.acquisition_source,
    s.acquisition_utm_source,
    s.acquisition_utm_medium,
    s.acquisition_utm_campaign,
    s.acquisition_landing_path,
    s.acquisition_referrer,
    (SELECT count(*)::int FROM public.workspace_members mm WHERE mm.workspace_id = s.id),
    (SELECT count(*)::int FROM public.inboxes i WHERE i.workspace_id = s.id AND i.deleted_at IS NULL),
    (SELECT count(*)::int FROM public.api_keys k WHERE k.workspace_id = s.id AND k.deleted_at IS NULL),
    (SELECT count(*)::int FROM public.activity_log a, bounds b
      WHERE a.workspace_id = s.id AND a.created_at >= b.window_start),
    (SELECT count(*)::int FROM public.activity_log a, bounds b
      WHERE a.workspace_id = s.id AND a.created_at >= b.window_start AND a.status = 'success'),
    (SELECT max(a.created_at) FROM public.activity_log a, bounds b
      WHERE a.workspace_id = s.id AND a.created_at >= b.window_start)
  FROM scoped s
  ORDER BY s.created_at ASC;
$$;


-- ---------------------------------------------------------------------------
-- growth_user_inboxes(p_user_id, p_days)
--
-- Every mailbox ever connected under a workspace the person owns, deleted ones
-- included and marked. `last_error` is returned because it is the single most
-- useful field on the page for answering "why did this customer stop": it is
-- the provider's own refusal, and the connectors sanitise echoed SASL tokens
-- out of it (see the Yandex fix) before it is stored.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_inboxes(p_user_id uuid, p_days int)
RETURNS TABLE (
  inbox_id uuid,
  workspace_id uuid,
  workspace_name text,
  email_address text,
  display_name text,
  provider text,
  status text,
  created_at timestamptz,
  deleted_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  signature_enabled boolean,
  send_approval_required boolean,
  calls int,
  successes int,
  last_used_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 90), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  ),
  scoped AS (
    SELECT i.*, coalesce(nullif(w.display_name, ''), w.slug) AS workspace_name
    FROM public.inboxes i
    JOIN public.workspaces w ON w.id = i.workspace_id
    WHERE w.owner_id = p_user_id
  ),
  used AS (
    SELECT a.inbox_id, count(*)::int AS calls,
           count(*) FILTER (WHERE a.status = 'success')::int AS successes,
           max(a.created_at) AS last_used_at
    FROM public.activity_log a, bounds b
    WHERE a.inbox_id IS NOT NULL AND a.created_at >= b.window_start
    GROUP BY a.inbox_id
  )
  SELECT
    s.id,
    s.workspace_id,
    s.workspace_name,
    s.email_address,
    nullif(s.display_name, ''),
    public.growth_inbox_label(s.provider, s.service),
    s.status,
    s.created_at,
    s.deleted_at,
    s.last_sync_at,
    s.last_error,
    s.signature_enabled,
    s.send_approval_required,
    coalesce(u.calls, 0),
    coalesce(u.successes, 0),
    u.last_used_at
  FROM scoped s
  LEFT JOIN used u ON u.inbox_id = s.id
  ORDER BY s.created_at ASC;
$$;


-- ---------------------------------------------------------------------------
-- growth_user_activity(p_user_id, p_days)
--
-- GAPLESS by construction. A caller that draws this as a bar chart reads a
-- missing day as "no bar there" and a zero day as "a bar of height zero", and
-- those have to look different or a week off reads as a narrower chart.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_activity(p_user_id uuid, p_days int)
RETURNS TABLE (day date, calls int, successes int, failures int)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      (now() AT TIME ZONE 'utc')::date AS last_day,
      (now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 90), 1) - 1) AS first_day
  ),
  days AS (
    SELECT generate_series(b.first_day, b.last_day, interval '1 day')::date AS day FROM bounds b
  ),
  rows_ AS (
    SELECT (a.created_at AT TIME ZONE 'utc')::date AS day, a.status
    FROM public.activity_log a
    JOIN public.workspaces w ON w.id = a.workspace_id
    CROSS JOIN bounds b
    WHERE w.owner_id = p_user_id
      AND a.created_at >= ((b.first_day)::timestamp AT TIME ZONE 'utc')
      AND a.created_at < ((b.last_day + 1)::timestamp AT TIME ZONE 'utc')
  )
  SELECT
    d.day,
    count(r.day)::int,
    count(r.day) FILTER (WHERE r.status = 'success')::int,
    count(r.day) FILTER (WHERE r.status <> 'success')::int
  FROM days d
  LEFT JOIN rows_ r ON r.day = d.day
  GROUP BY d.day
  ORDER BY d.day ASC;
$$;


-- ---------------------------------------------------------------------------
-- growth_user_tools(p_user_id, p_days)
--
-- What they actually do with it, busiest first, with the failure count beside
-- the call count rather than netted into a rate: at these volumes a tool called
-- three times with one failure is a different story from one called three
-- hundred times with a hundred failures, and one percentage tells them apart
-- only if you already know the denominator.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_tools(p_user_id uuid, p_days int)
RETURNS TABLE (
  tool_name text,
  calls int,
  successes int,
  failures int,
  median_ms int,
  last_used_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 90), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  )
  SELECT
    a.tool_name,
    count(*)::int,
    count(*) FILTER (WHERE a.status = 'success')::int,
    count(*) FILTER (WHERE a.status <> 'success')::int,
    percentile_disc(0.5) WITHIN GROUP (ORDER BY a.duration_ms)::int,
    max(a.created_at)
  FROM public.activity_log a
  JOIN public.workspaces w ON w.id = a.workspace_id
  CROSS JOIN bounds b
  WHERE w.owner_id = p_user_id AND a.created_at >= b.window_start
  GROUP BY a.tool_name
  ORDER BY count(*) DESC, a.tool_name ASC;
$$;


-- ---------------------------------------------------------------------------
-- growth_user_errors(p_user_id, p_days)
--
-- The failures, by code and tool. Separate from the tool rollup because the
-- question it answers is a different one -- "what is broken for this person"
-- rather than "what do they use" -- and because a tool with two distinct
-- failure modes is one row there and two rows here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_errors(p_user_id uuid, p_days int)
RETURNS TABLE (error_code text, tool_name text, calls int, last_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 90), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  )
  SELECT
    coalesce(a.error_code, 'unknown'),
    a.tool_name,
    count(*)::int,
    max(a.created_at)
  FROM public.activity_log a
  JOIN public.workspaces w ON w.id = a.workspace_id
  CROSS JOIN bounds b
  WHERE w.owner_id = p_user_id
    AND a.created_at >= b.window_start
    AND a.status <> 'success'
  GROUP BY coalesce(a.error_code, 'unknown'), a.tool_name
  ORDER BY count(*) DESC
  LIMIT 25;
$$;


-- ---------------------------------------------------------------------------
-- growth_user_timeline(p_user_id, p_limit)
--
-- ONE MERGED LIST, newest first, of everything durable that ever happened to
-- this person: the signup, every workspace created or deleted, every mailbox
-- connected or disconnected, every credential issued, every funnel success and
-- failure with the reason it failed, every cap rejection, and every lifecycle
-- or billing email we sent them.
--
-- This is the part of the page that could not be assembled by hand in under a
-- minute, and it is the reason the page is worth building: six tables record
-- what happened to a customer, no two of them agree on a column name for when,
-- and the story only makes sense in one order.
--
-- ALL-TIME, deliberately: every source here is a durable table. Only
-- `activity_log` is purged, and the timeline does not read it -- individual
-- tool calls are volume, not events, and they are the charts above.
--
-- `tone` is the caller's rendering hint and nothing more: 'bad' for a failure
-- or a removal, 'good' for a step forward, 'flat' for a fact.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_timeline(p_user_id uuid, p_limit int)
RETURNS TABLE (
  occurred_at timestamptz,
  kind text,
  title text,
  detail text,
  tone text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH ws AS (
    SELECT w.id, coalesce(nullif(w.display_name, ''), w.slug) AS name, w.created_at, w.deleted_at
    FROM public.workspaces w WHERE w.owner_id = p_user_id
  ),
  events AS (
    SELECT u.created_at AS occurred_at, 'account'::text AS kind, 'Signed up'::text AS title,
           u.email AS detail, 'good'::text AS tone
    FROM public.users u WHERE u.id = p_user_id

    UNION ALL
    SELECT w.created_at, 'workspace', 'Workspace created', w.name, 'flat' FROM ws w

    UNION ALL
    SELECT w.deleted_at, 'workspace', 'Workspace deleted', w.name, 'bad'
    FROM ws w WHERE w.deleted_at IS NOT NULL

    UNION ALL
    SELECT i.created_at, 'inbox', 'Mailbox connected',
           i.email_address || ' · ' || public.growth_inbox_label(i.provider, i.service), 'good'
    FROM public.inboxes i JOIN ws w ON w.id = i.workspace_id

    UNION ALL
    SELECT i.deleted_at, 'inbox', 'Mailbox disconnected', i.email_address, 'bad'
    FROM public.inboxes i JOIN ws w ON w.id = i.workspace_id WHERE i.deleted_at IS NOT NULL

    UNION ALL
    SELECT k.created_at, 'key', 'API key created', k.name || ' · ' || k.key_prefix, 'good'
    FROM public.api_keys k JOIN ws w ON w.id = k.workspace_id

    UNION ALL
    SELECT k.deleted_at, 'key', 'API key revoked', k.name, 'bad'
    FROM public.api_keys k JOIN ws w ON w.id = k.workspace_id WHERE k.deleted_at IS NOT NULL

    -- The funnel rows are the only place a FAILED attempt is recorded at all:
    -- a connection that never worked leaves no inbox row behind it.
    UNION ALL
    SELECT e.occurred_at, 'funnel',
           CASE e.stage
             WHEN 'inbox_connection' THEN 'Connection attempt'
             WHEN 'credential_created' THEN 'Credential issued'
             WHEN 'first_tool_call' THEN 'First tool call'
             WHEN 'paywall_reached' THEN 'Paywall reached'
             ELSE e.stage END,
           e.category
             || CASE
                  WHEN e.outcome = 'failure' THEN ' · ' || coalesce(e.error_category, 'unknown')
                  -- THREE OUTCOMES, NOT TWO. `started` means the person pressed
                  -- the button, and reading it as a success is how a mailbox
                  -- that never connected shows up as two green connections.
                  WHEN e.outcome <> 'success' THEN ' · ' || e.outcome
                  ELSE ''
                END
             || coalesce(' · ' || e.auth_reason, ''),
           CASE e.outcome WHEN 'failure' THEN 'bad' WHEN 'success' THEN 'good' ELSE 'flat' END
    FROM public.product_funnel_events e JOIN ws w ON w.id = e.workspace_id

    UNION ALL
    SELECT e.occurred_at, 'paywall', 'Action cap rejected a call',
           e.effective_plan || ' · ' || e.used_actions || ' of ' || e.cap, 'bad'
    FROM public.usage_limit_events e JOIN ws w ON w.id = e.workspace_id

    UNION ALL
    SELECT s.sent_at, 'email', 'Lifecycle email', s.template || ' · ' || s.status,
           CASE WHEN s.status = 'sent' THEN 'flat' ELSE 'bad' END
    FROM public.lifecycle_email_sends s WHERE s.user_id = p_user_id

    UNION ALL
    SELECT s.sent_at, 'email', 'Billing email', s.template,  'flat'
    FROM public.billing_email_sends s WHERE s.user_id = p_user_id AND s.sent_at IS NOT NULL
  )
  SELECT e.occurred_at, e.kind, e.title, e.detail, e.tone
  FROM events e
  WHERE e.occurred_at IS NOT NULL
  ORDER BY e.occurred_at DESC
  LIMIT greatest(coalesce(p_limit, 200), 1);
$$;


-- ---------------------------------------------------------------------------
-- Grants. Same posture as every other growth function: SECURITY INVOKER, and
-- reachable only by the service role, because every one of these returns
-- account identity.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.growth_inbox_label(text, text)',
    'public.growth_user_directory(int, int, uuid)',
    'public.growth_user_workspaces(uuid, int)',
    'public.growth_user_inboxes(uuid, int)',
    'public.growth_user_activity(uuid, int)',
    'public.growth_user_tools(uuid, int)',
    'public.growth_user_errors(uuid, int)',
    'public.growth_user_timeline(uuid, int)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END;
$$;
