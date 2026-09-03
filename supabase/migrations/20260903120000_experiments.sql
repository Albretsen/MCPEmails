-- ===========================================================================
-- A/B experiments: the tables, the assignment record, and the read-out.
--
-- WHY THIS FILE EXISTS
-- Every product change so far has been argued from a before-and-after on a
-- shared timeline, which is not evidence: signups move for reasons we do not
-- control, and n is small enough that a good week reads as a win. This gives
-- the product one honest way to ask "did that change anything", by splitting
-- visitors on a stable anonymous id and following each side all the way to a
-- paid workspace and a return visit.
--
-- THREE TABLES, ONE RULE EACH.
--   experiments            : the definition. Weights are integers summing to
--                            100 so a split is exact and readable, not a float
--                            nobody can reason about.
--   experiment_assignments : what a subject was shown, written ONCE. A subject
--                            never moves between variants, even if the weights
--                            change under them, because a mid-flight reshuffle
--                            would mix two populations inside one column.
--   experiment_subjects    : the anonymous-id to account join, written once per
--                            new account. First link wins, so an anonymous id
--                            can never be re-pointed at a second account.
--
-- WHO CAN READ THEM. All three have RLS enabled and no policies at all, and
-- anon/authenticated are revoked outright, the same shape as
-- product_funnel_events. Only service-role server code touches them. The
-- subject id is a random 32 hex value with no user data in it, but it is still
-- a per-visitor identifier and does not belong in a browser-reachable table.
--
-- WINDOW SAFETY. Retention is read from activity_log, which a pg_cron job
-- purges past 90 days, so retention_window_days is capped at 90 by a CHECK
-- rather than trusted. Past that the retained count would be computed against
-- a purged stretch and every experiment would look like a success.
--
-- Forward-only. No previously applied migration file is edited. Re-runnable:
-- everything is IF NOT EXISTS, CREATE OR REPLACE, or guarded, so a partial
-- failure can be fixed and the whole file re-applied.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Variant validation helpers.
--
-- These exist so the shape of `variants` is enforced by the database and not
-- only by the admin form. The panel validates first and shows a readable
-- message, but the CHECK is what makes a malformed split impossible: a
-- 50/40 experiment silently sends a tenth of the traffic nowhere, and the
-- resulting numbers look fine.
--
-- Both are IMMUTABLE because a CHECK constraint may only call functions whose
-- answer depends on the row alone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.experiment_variants_valid(p_variants jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry jsonb;
  v_ids text[] := '{}';
  v_id text;
  v_weight_total int := 0;
  v_count int;
BEGIN
  IF p_variants IS NULL OR jsonb_typeof(p_variants) <> 'array' THEN
    RETURN false;
  END IF;

  v_count := jsonb_array_length(p_variants);
  IF v_count < 1 OR v_count > 10 THEN
    RETURN false;
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_variants) AS t(value) LOOP
    IF jsonb_typeof(v_entry) <> 'object' THEN
      RETURN false;
    END IF;

    -- id: the value that ends up in a cookie, a URL and a stored assignment,
    -- so it is deliberately narrow.
    IF jsonb_typeof(v_entry -> 'id') <> 'string' THEN
      RETURN false;
    END IF;
    v_id := v_entry ->> 'id';
    IF v_id !~ '^[a-z0-9_]{1,32}$' THEN
      RETURN false;
    END IF;
    IF v_id = ANY (v_ids) THEN
      RETURN false;
    END IF;
    v_ids := array_append(v_ids, v_id);

    -- label: what the admin panel prints. Non-empty so a table cannot render
    -- a blank row nobody can identify.
    IF jsonb_typeof(v_entry -> 'label') <> 'string' THEN
      RETURN false;
    END IF;
    IF btrim(v_entry ->> 'label') = '' THEN
      RETURN false;
    END IF;

    -- weight: an integer share out of 100. Zero is allowed and useful, it is
    -- how a variant is parked without deleting it or losing its history.
    IF jsonb_typeof(v_entry -> 'weight') <> 'number' THEN
      RETURN false;
    END IF;
    IF (v_entry ->> 'weight')::numeric <> trunc((v_entry ->> 'weight')::numeric) THEN
      RETURN false;
    END IF;
    IF (v_entry ->> 'weight')::numeric < 0 OR (v_entry ->> 'weight')::numeric > 100 THEN
      RETURN false;
    END IF;
    v_weight_total := v_weight_total + (v_entry ->> 'weight')::int;
  END LOOP;

  RETURN v_weight_total = 100;
END;
$$;

COMMENT ON FUNCTION public.experiment_variants_valid(jsonb) IS
  'True when the variants array is 1 to 10 objects with unique slug ids, non-empty labels, and integer weights 0 to 100 summing to exactly 100. Used by the experiments CHECK constraint.';

REVOKE ALL ON FUNCTION public.experiment_variants_valid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.experiment_variants_valid(jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.experiment_has_variant(p_variants jsonb, p_variant_id text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_variants IS NULL OR p_variant_id IS NULL OR jsonb_typeof(p_variants) <> 'array' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_variants) AS t(value)
    WHERE t.value ->> 'id' = p_variant_id
  );
END;
$$;

COMMENT ON FUNCTION public.experiment_has_variant(jsonb, text) IS
  'True when the given variant id appears in the variants array. Used to keep winner_variant_id honest.';

REVOKE ALL ON FUNCTION public.experiment_has_variant(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.experiment_has_variant(jsonb, text) TO service_role;


-- ---------------------------------------------------------------------------
-- 2. experiments
--
-- variants->0 is the control by convention: it is what everybody sees while
-- the experiment is a draft, and what an unknown or subject-less request falls
-- back to. Ordering therefore carries meaning and the admin panel must not
-- reorder the array casually.
--
-- The two winner rules are separate on purpose. One says a concluded
-- experiment must name a winner (otherwise "concluded" tells a reader nothing
-- and the resolver has nothing to serve); the other says the named winner has
-- to be a variant that exists, which is the typo that would otherwise send
-- 100% of traffic to a fallback nobody notices.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.experiments (
  key text PRIMARY KEY
    CHECK (key ~ '^[a-z0-9_]{2,64}$'),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'concluded')),
  variants jsonb NOT NULL
    CHECK (public.experiment_variants_valid(variants)),
  winner_variant_id text,
  -- What "came back" means for this experiment. Stated per experiment because
  -- a homepage test and an onboarding test are not answering the same
  -- question, and a single hard-coded goal would quietly make one of them lie.
  retention_goal text NOT NULL DEFAULT 'mailbox_activity'
    CHECK (retention_goal IN ('mailbox_activity', 'any_tool_call', 'value_activation')),
  -- Capped at 90 because activity_log is purged there. See the header.
  retention_window_days int NOT NULL DEFAULT 7
    CHECK (retention_window_days BETWEEN 1 AND 90),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  concluded_at timestamptz,
  CONSTRAINT experiments_concluded_needs_winner
    CHECK (status <> 'concluded' OR winner_variant_id IS NOT NULL),
  CONSTRAINT experiments_winner_is_a_variant
    CHECK (winner_variant_id IS NULL OR public.experiment_has_variant(variants, winner_variant_id))
);

COMMENT ON TABLE public.experiments IS
  'One row per A/B experiment. variants is an ordered array of {id,label,weight}; entry 0 is the control and is what a draft experiment serves to everyone.';

ALTER TABLE public.experiments ENABLE ROW LEVEL SECURITY;
-- No policies at all, deliberately. Only service-role server code reads or
-- writes experiments; the browser never sees this table.
REVOKE ALL ON TABLE public.experiments FROM anon, authenticated;

-- The house convention for updated_at (users, workspaces, bulk_runs, ...) is
-- the moddatetime extension rather than a hand-written trigger function.
DROP TRIGGER IF EXISTS experiments_updated_at ON public.experiments;
CREATE TRIGGER experiments_updated_at
  BEFORE UPDATE ON public.experiments
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);


-- ---------------------------------------------------------------------------
-- 3. experiment_assignments
--
-- Written once per (experiment, subject) and never updated. The primary key is
-- the whole mechanism: the writer inserts with ON CONFLICT DO NOTHING and then
-- reads back what is stored, so two concurrent requests for the same visitor
-- agree on one variant and a later weight change cannot move anybody.
--
-- subject_id is a 32 hex random value minted in the proxy, not a user id: at
-- the moment of assignment there is no account yet, which is the entire point.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.experiment_assignments (
  experiment_key text NOT NULL REFERENCES public.experiments(key) ON DELETE CASCADE,
  subject_id text NOT NULL
    CHECK (subject_id ~ '^[a-f0-9]{32}$'),
  variant_id text NOT NULL,
  first_assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_key, subject_id)
);

COMMENT ON TABLE public.experiment_assignments IS
  'What each anonymous subject was shown, written once and never overwritten. The primary key is what makes an assignment stick across concurrent requests and weight changes.';

-- Every read in experiment_stats groups by variant inside one experiment.
CREATE INDEX IF NOT EXISTS experiment_assignments_key_variant_idx
  ON public.experiment_assignments (experiment_key, variant_id);

ALTER TABLE public.experiment_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.experiment_assignments FROM anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. experiment_subjects
--
-- The join from an anonymous visitor to the account they eventually created.
-- One row per subject, inserted on the first authenticated dashboard render of
-- a NEW account (the caller checks that; the ON CONFLICT DO NOTHING here is
-- the second line of defence).
--
-- workspace_id and user_id are both nullable and user_id has no FK, matching
-- the other analytics columns: an analytics join must never be the reason a
-- user row cannot be deleted.
--
-- ONE WORKSPACE CAN BE LINKED FROM TWO SUBJECT IDS. Someone who browses on a
-- laptop and signs up on a phone arrives with two subject ids, and each is
-- linked to the same workspace. That is accepted, not a bug: the unit of
-- counting here is the subject, and the denominator stays consistent because
-- `assigned` counted both of those subjects too. Deduplicating to the account
-- would shrink the numerator while leaving the denominator alone, which is
-- the direction that invents a false result.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.experiment_subjects (
  subject_id text PRIMARY KEY
    CHECK (subject_id ~ '^[a-f0-9]{32}$'),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid,
  linked_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.experiment_subjects IS
  'Anonymous subject id to account join, written once per new signup. First link wins: an anonymous id is never re-pointed at a second account.';

CREATE INDEX IF NOT EXISTS experiment_subjects_workspace_idx
  ON public.experiment_subjects (workspace_id);

ALTER TABLE public.experiment_subjects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.experiment_subjects FROM anon, authenticated;

-- Spelled out rather than left to the schema default privileges. Service-role
-- access to these three tables is load bearing, and a future change to the
-- defaults should not be able to switch the experiments system off quietly.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.experiments,
  public.experiment_assignments,
  public.experiment_subjects
  TO service_role;


-- ---------------------------------------------------------------------------
-- 5. experiment_assign(p_key, p_subject_id, p_variant_id) returns text
--
-- Returns the variant this subject is in, which is NOT always the one passed
-- in: the caller offers the variant its hash picked, and the stored answer
-- wins. INSERT ... ON CONFLICT DO NOTHING RETURNING returns nothing on a
-- conflict, so the read-back is a separate SELECT rather than an assumption.
--
-- Raises on an unknown key instead of writing an orphan row. The library
-- catches it: a database hiccup must not break a page, but it must not be
-- recorded as a real exposure either.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.experiment_assign(
  p_key text,
  p_subject_id text,
  p_variant_id text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stored text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.experiments e WHERE e.key = p_key) THEN
    RAISE EXCEPTION 'experiment % does not exist', p_key
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- variant_id has no foreign key to point at, so this is the only thing
  -- standing between a caller typo and a permanent assignment to a variant
  -- that does not exist. Such a row would count in `assigned` for nobody:
  -- experiment_stats drives its rows off the variants array, so the traffic
  -- would vanish from the table rather than show up as a discrepancy.
  IF NOT EXISTS (
    SELECT 1 FROM public.experiments e
    WHERE e.key = p_key
      AND public.experiment_has_variant(e.variants, p_variant_id)
  ) THEN
    RAISE EXCEPTION 'variant % is not part of experiment %', p_variant_id, p_key
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.experiment_assignments (experiment_key, subject_id, variant_id)
  VALUES (p_key, p_subject_id, p_variant_id)
  ON CONFLICT (experiment_key, subject_id) DO NOTHING;

  SELECT a.variant_id
    INTO v_stored
    FROM public.experiment_assignments a
   WHERE a.experiment_key = p_key
     AND a.subject_id = p_subject_id;

  RETURN v_stored;
END;
$$;

COMMENT ON FUNCTION public.experiment_assign(text, text, text) IS
  'Record the variant a subject was shown, once, and return the stored value. A pre-existing assignment always wins over the offered variant.';

REVOKE ALL ON FUNCTION public.experiment_assign(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.experiment_assign(text, text, text) TO service_role;


-- ---------------------------------------------------------------------------
-- 6. experiment_link_subject(p_subject_id, p_workspace_id, p_user_id)
--
-- First link wins. A returning visitor who signs in on a second account keeps
-- pointing at the first one, because the alternative is worse: re-pointing
-- would move a conversion from the cohort that earned it to whichever account
-- was created last.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.experiment_link_subject(
  p_subject_id text,
  p_workspace_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.experiment_subjects (subject_id, workspace_id, user_id)
  VALUES (p_subject_id, p_workspace_id, p_user_id)
  ON CONFLICT (subject_id) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public.experiment_link_subject(text, uuid, uuid) IS
  'Join an anonymous subject id to the account it created, once. Later calls for the same subject are ignored.';

REVOKE ALL ON FUNCTION public.experiment_link_subject(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.experiment_link_subject(text, uuid, uuid) TO service_role;


-- ---------------------------------------------------------------------------
-- 7. experiment_stats(p_key)
--
-- One row per variant listed in the experiment, in array order, zeros
-- included. Driving the result off the variants array rather than off the
-- assignments means a variant nobody has been bucketed into still appears,
-- which is how the panel can show a 90/10 split honestly on day one instead of
-- silently hiding the arm with no traffic yet.
--
-- The four counts narrow in one direction, each a subset of the one before:
--
--   assigned           every subject bucketed into the variant.
--   signed_up          of those, the ones whose account was created AFTER the
--                      bucketing. The date test is the whole guard: an
--                      existing customer who wanders past the homepage gets a
--                      subject id like anybody else, and counting their
--                      long-standing workspace as a signup would credit the
--                      experiment with customers it did not win.
--   converted          signed_up who paid, again only counting payments AFTER
--                      the bucketing, for the same reason.
--   retention_eligible signed_up who have had the full window to come back.
--                      Somebody who signed up yesterday is not evidence of
--                      anything on a 7 day window, so they are in neither the
--                      numerator nor the denominator.
--   retained           of the eligible, the ones who came back.
--
-- SOFT-DELETED WORKSPACES ARE NOT FILTERED, on purpose, the same choice
-- growth_people_counts makes: the signup and the payment did happen, and a
-- workspace deleted later is evidence about the experiment rather than an
-- inventory question. Dropping them would quietly credit the arm whose users
-- stayed with a better conversion rate than it earned.
--
-- The retention window is half-open at the start and closed at the end:
-- (linked_at + 1 day, linked_at + window]. The one day offset is deliberate
-- and matches growth_retention_curve: it asks "did they come back on a later
-- day", not "did they use it during signup", which everybody does by
-- definition. value_activation keeps a lower bound of linked_at but drops the
-- one day offset, because activation is a one-time milestone that usually
-- happens on day zero and excluding day zero would score it as never.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.experiment_stats(p_key text)
RETURNS TABLE (
  variant_id text,
  assigned int,
  signed_up int,
  converted int,
  retention_eligible int,
  retained int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH exp AS (
    SELECT e.variants, e.retention_goal, e.retention_window_days
    FROM public.experiments e
    WHERE e.key = p_key
  ),
  -- The row skeleton: the variants array, in order, whatever the data says.
  variant_rows AS (
    SELECT
      (v.entry ->> 'id') AS vid,
      v.ord AS vpos
    FROM exp
    CROSS JOIN LATERAL jsonb_array_elements(exp.variants) WITH ORDINALITY AS v(entry, ord)
  ),
  -- One row per assignment, carrying everything the flags need. The join to
  -- experiment_subjects is LEFT so an unconverted visitor is still counted in
  -- `assigned`, which is the denominator everything else is judged against.
  subject_rows AS (
    SELECT
      a.variant_id AS vid,
      a.first_assigned_at,
      s.workspace_id,
      s.linked_at,
      w.created_at AS workspace_created_at,
      w.onboarding_value_activated_at
    FROM public.experiment_assignments a
    LEFT JOIN public.experiment_subjects s ON s.subject_id = a.subject_id
    LEFT JOIN public.workspaces w ON w.id = s.workspace_id
    WHERE a.experiment_key = p_key
  ),
  flagged AS (
    SELECT
      r.vid,
      (r.workspace_id IS NOT NULL
        AND r.workspace_created_at >= r.first_assigned_at) AS is_signed_up,
      (r.workspace_id IS NOT NULL
        AND r.workspace_created_at >= r.first_assigned_at
        AND EXISTS (
          SELECT 1
          FROM public.billing_funnel_by_workspace b
          WHERE b.workspace_id = r.workspace_id
            AND b.paid_at IS NOT NULL
            AND b.paid_at >= r.first_assigned_at
        )) AS is_converted,
      (r.workspace_id IS NOT NULL
        AND r.workspace_created_at >= r.first_assigned_at
        AND r.linked_at <= now() - make_interval(days => x.retention_window_days)) AS is_eligible,
      (r.workspace_id IS NOT NULL
        AND r.workspace_created_at >= r.first_assigned_at
        AND r.linked_at <= now() - make_interval(days => x.retention_window_days)
        AND CASE x.retention_goal
          -- Real mailbox work, the same test growth_retention_curve uses:
          -- a successful call that touched an inbox and was not just a list.
          WHEN 'mailbox_activity' THEN EXISTS (
            SELECT 1
            FROM public.activity_log al
            WHERE al.workspace_id = r.workspace_id
              AND al.status = 'success'
              AND al.inbox_id IS NOT NULL
              AND al.tool_name <> 'inbox_list'
              AND al.created_at > r.linked_at + interval '1 day'
              AND al.created_at <= r.linked_at + make_interval(days => x.retention_window_days)
          )
          -- Any call at all, successful or not: the loosest possible "they
          -- came back", useful for a test whose change is upstream of mailbox
          -- work.
          WHEN 'any_tool_call' THEN EXISTS (
            SELECT 1
            FROM public.activity_log al
            WHERE al.workspace_id = r.workspace_id
              AND al.created_at > r.linked_at + interval '1 day'
              AND al.created_at <= r.linked_at + make_interval(days => x.retention_window_days)
          )
          -- A durable column rather than activity_log, so this one goal
          -- survives the 90 day purge. Bounded below by linked_at for the
          -- same reason the others are: an activation that predates the link
          -- is not something this experiment can claim.
          WHEN 'value_activation' THEN (
            r.onboarding_value_activated_at IS NOT NULL
            AND r.onboarding_value_activated_at > r.linked_at
            AND r.onboarding_value_activated_at <= r.linked_at + make_interval(days => x.retention_window_days)
          )
          ELSE false
        END) AS is_retained
    FROM subject_rows r
    CROSS JOIN exp x
  )
  SELECT
    vr.vid::text,
    count(f.vid)::int,
    count(*) FILTER (WHERE f.is_signed_up)::int,
    count(*) FILTER (WHERE f.is_converted)::int,
    count(*) FILTER (WHERE f.is_eligible)::int,
    count(*) FILTER (WHERE f.is_retained)::int
  FROM variant_rows vr
  LEFT JOIN flagged f ON f.vid = vr.vid
  GROUP BY vr.vid, vr.vpos
  ORDER BY vr.vpos;
$$;

COMMENT ON FUNCTION public.experiment_stats(text) IS
  'Per-variant funnel for one experiment: assigned, signed up, converted, retention eligible, retained. One row per variant in the experiments.variants order, zeros when there is no data. Signups and payments only count when they happened after the subject was bucketed.';

REVOKE ALL ON FUNCTION public.experiment_stats(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.experiment_stats(text) TO service_role;


-- ---------------------------------------------------------------------------
-- 8. Seed: the first experiment.
--
-- Draft, and 100/0, so applying this file changes nothing anybody sees. The
-- panel starts it when the video variant is actually built.
-- ---------------------------------------------------------------------------
INSERT INTO public.experiments (key, name, description, status, variants)
VALUES (
  'homepage_demo_video',
  'Homepage demo video',
  'Control is today''s homepage. The video variant embeds the connect-and-triage demo cut between the hero and the logo strip.',
  'draft',
  '[{"id":"control","label":"Current homepage","weight":100},{"id":"video","label":"Homepage with demo video","weight":0}]'::jsonb
)
ON CONFLICT (key) DO NOTHING;
