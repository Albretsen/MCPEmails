-- ===========================================================================
-- ONE NUMBER FOR "HOW MANY PEOPLE HAVE SIGNED UP".
--
-- WHY THIS FILE EXISTS
-- Four surfaces answered that question and three of them disagreed:
--
--   422  the signup notification email, and albretsen.no  -- count(users)
--   412  /admin/growth and the kiosk headline             -- growth_people_counts
--   404  the kiosk's "Road to a paying customer" ladder   -- live workspaces
--
-- None of them was broken. They counted three different things: every row in
-- `users` including the ten accounts we operate ourselves; the people who are
-- not us; and workspaces that still exist. Three right answers under one word
-- is worse than one wrong answer, because nobody can tell which is which from
-- across a room, and a milestone you cannot state is a milestone you cannot
-- celebrate.
--
-- THE AGREED DEFINITION, and the only one anything should print under the word
-- "signed up":
--
--   a row in public.users whose address is not one of ours.
--
-- Not workspaces: a person who deletes a workspace still signed up, and a
-- person with two has not signed up twice. Not `auth.users` either, though it
-- happens to agree today -- `public.users` is the row the product treats as a
-- person. Deleted workspaces are irrelevant to it by construction, which is
-- what makes it the number that never has to be re-explained.
--
-- WHY THE LIST MOVES INTO A TABLE
-- "Not one of ours" was only knowable inside the Next.js app, which reads
-- GROWTH_INTERNAL_EMAILS from its environment. A Supabase edge function and a
-- separate website cannot see that variable, so both counted everybody -- and
-- would have gone on counting everybody however carefully the board was
-- written. The list has to live where every caller can reach it, which is the
-- database. Rows in a table are not in this public repository, so the personal
-- addresses stay unpublished exactly as the env var kept them.
--
-- Forward-only. No previously applied migration file is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The list itself.
--
-- Addresses only. The two domains we own outright stay in code, because they
-- are already public and a domain is not a secret worth a round trip.
--
-- Service-role only, and RLS on with no policy: this table names real people,
-- and the kiosk reaches the database with a shared token that hangs on a wall.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.internal_accounts (
  email text PRIMARY KEY,
  -- Why this address is ours. Free text, read by humans only: 'founder',
  -- 'synthetic monitor', 'reviewer demo mailbox'. An unexplained entry is how
  -- a real customer eventually gets excluded by accident.
  note text,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT internal_accounts_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT internal_accounts_email_shaped CHECK (position('@' in email) > 1)
);

COMMENT ON TABLE public.internal_accounts IS
  'Addresses we operate ourselves, excluded from every "how many people" count. Seeded from GROWTH_INTERNAL_EMAILS; see scripts/sync-internal-accounts.mjs. Plus-tagged variants match automatically and must NOT be listed separately.';

ALTER TABLE public.internal_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.internal_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.internal_accounts TO service_role;


-- ---------------------------------------------------------------------------
-- 2. The two halves of "one of ours", as functions rather than literals, so a
--    caller cannot accidentally use a different list or a different domain set
--    and still look like it is asking the same question.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.internal_account_emails()
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(ia.email), '{}'::text[]) FROM public.internal_accounts ia;
$$;

-- Domains we own outright. Everything under them is ours by definition. Kept
-- in step with INTERNAL_DOMAINS in apps/web/src/lib/analytics/internal-accounts.ts.
CREATE OR REPLACE FUNCTION public.internal_account_domains()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ARRAY['@mcpemails.com', '@mcpemails.dev'];
$$;

-- One-argument overload of the existing predicate. Same matching rules --
-- exact, plus-tag-insensitive, or on an internal domain -- with the lists
-- supplied from the table instead of by the caller. The three-argument form
-- stays exactly as it is: /admin/growth still passes its own lists, and this
-- migration must not be able to move a number on that page.
CREATE OR REPLACE FUNCTION public.growth_is_internal_email(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.growth_is_internal_email(
    p_email,
    public.internal_account_emails(),
    public.internal_account_domains()
  );
$$;

COMMENT ON FUNCTION public.growth_is_internal_email(text) IS
  'True when an address is one of ours, reading the list from public.internal_accounts. Use this form from anything that is not /admin/growth.';


-- ---------------------------------------------------------------------------
-- 3. The number.
--
-- Returns the momentum figures beside the headline rather than only the total,
-- because the signup email prints all three and two of them drifting apart
-- from the board would reintroduce the same problem one line further down.
--
-- `internal_excluded` is returned rather than hidden so a caller can say how
-- many it dropped, and so a wrong number is diagnosable from its own output:
-- total + internal_excluded is every row in `users`.
--
-- Windows are rolling hours, not UTC calendar days, matching what the email
-- already said and what "last 24 hours" means to a person reading it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.signup_scoreboard()
RETURNS TABLE (
  total int,
  last_24h int,
  last_7d int,
  internal_excluded int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH scoped AS (
    SELECT u.created_at, public.growth_is_internal_email(u.email) AS is_internal
    FROM public.users u
  )
  SELECT
    count(*) FILTER (WHERE NOT s.is_internal)::int,
    count(*) FILTER (WHERE NOT s.is_internal AND s.created_at >= now() - interval '24 hours')::int,
    count(*) FILTER (WHERE NOT s.is_internal AND s.created_at >= now() - interval '7 days')::int,
    count(*) FILTER (WHERE s.is_internal)::int
  FROM scoped s;
$$;

COMMENT ON FUNCTION public.signup_scoreboard() IS
  'THE signup count. One row: people who have signed up (internal accounts excluded), the last 24h and 7d, and how many were excluded. Every surface that prints "signed up" reads this.';

REVOKE ALL ON FUNCTION public.internal_account_emails() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_is_internal_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.signup_scoreboard() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.internal_account_emails() TO service_role;
GRANT EXECUTE ON FUNCTION public.internal_account_domains() TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_is_internal_email(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.signup_scoreboard() TO service_role;


-- ---------------------------------------------------------------------------
-- 4. The third number: the kiosk's "Road to a paying customer" ladder.
--
-- Its first rung read 404 while the tile five columns to the left read 412,
-- and the two were four tiles apart under words a passer-by reads as the same
-- word. They were both right: the ladder counts WORKSPACES that still exist,
-- including the ones we operate ourselves, and the tile counts PEOPLE who are
-- not us.
--
-- The unit difference is real and stays -- a funnel about connecting a mailbox
-- has to be about workspaces, and the tile's aside says so. What goes is the
-- half of the gap that was pure accident: our own accounts being inside the
-- ladder and outside the headline. `shared.ts` has carried a note since the
-- ladder shipped saying the clean fix is to teach this function the same
-- exclusion, and it was only deferred because the list of our addresses was
-- not reachable from SQL. It is now.
--
-- No signature change, so /admin/growth and all three kiosk views pick it up
-- with no code change; both surfaces want the exclusion for the same reason.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_activation_funnel(p_days int)
RETURNS TABLE (
  stage_index int,
  stage text,
  workspaces int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  ),
  cohort AS (
    SELECT
      w.onboarding_client_selected_at AS client_selected_at,
      w.onboarding_inbox_connected_at AS inbox_connected_at,
      w.onboarding_connection_verified_at AS connection_verified_at,
      w.onboarding_credential_issued_at AS credential_issued_at,
      w.onboarding_technical_activated_at AS technical_activated_at,
      w.onboarding_value_activated_at AS value_activated_at
    -- LEFT JOIN, not JOIN: a workspace whose owner has no `users` row must
    -- stay in the funnel. It cannot be matched against the internal list, and
    -- dropping it would understate the top of the ladder, the opposite of the
    -- safe direction, which everywhere else in this schema is to count an
    -- unmatched address as external.
    --
    -- The CROSS JOIN comes after the LEFT JOIN rather than staying the comma
    -- form it replaced: `FROM workspaces w, bounds b LEFT JOIN users u ON
    -- u.id = w.owner_id` binds the join to `bounds` and cannot see `w` at all.
    FROM public.workspaces w
    LEFT JOIN public.users u ON u.id = w.owner_id
    CROSS JOIN bounds b
    WHERE w.deleted_at IS NULL
      AND w.created_at >= b.window_start
      AND NOT public.growth_is_internal_email(u.email)
  ),
  counted AS (
    SELECT
      count(*)::int AS signup,
      count(*) FILTER (WHERE coalesce(
        c.client_selected_at, c.inbox_connected_at, c.connection_verified_at,
        c.credential_issued_at, c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS client_selected,
      count(*) FILTER (WHERE coalesce(
        c.inbox_connected_at, c.connection_verified_at,
        c.credential_issued_at, c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS inbox_connected,
      count(*) FILTER (WHERE coalesce(
        c.connection_verified_at, c.credential_issued_at,
        c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS connection_verified,
      count(*) FILTER (WHERE coalesce(
        c.credential_issued_at, c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS credential_issued,
      count(*) FILTER (WHERE coalesce(
        c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS technical_activation,
      count(*) FILTER (WHERE c.value_activated_at IS NOT NULL)::int AS value_activation
    FROM cohort c
  )
  SELECT ordered.stage_index, ordered.stage, ordered.workspaces
  FROM counted cn
  CROSS JOIN LATERAL (
    VALUES
      (1, 'signup'::text, cn.signup),
      (2, 'client_selected'::text, cn.client_selected),
      (3, 'inbox_connected'::text, cn.inbox_connected),
      (4, 'connection_verified'::text, cn.connection_verified),
      (5, 'credential_issued'::text, cn.credential_issued),
      (6, 'technical_activation'::text, cn.technical_activation),
      (7, 'value_activation'::text, cn.value_activation)
  ) AS ordered(stage_index, stage, workspaces)
  ORDER BY ordered.stage_index;
$$;

COMMENT ON FUNCTION public.growth_activation_funnel(int) IS
  'Signup-to-value funnel over live workspaces created in the window, internal accounts excluded (public.internal_accounts). Counts WORKSPACES; signup_scoreboard() counts PEOPLE.';
