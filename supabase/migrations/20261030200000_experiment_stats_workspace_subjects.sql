-- experiment_stats: count experiments whose subject is a workspace.
--
-- The function was written for the homepage test, which split anonymous
-- visitors by a cookie and found their account later through
-- experiment_subjects. Every experiment since 2026-10-24 (onb_flow,
-- onb_convert, chat_checkout_link, personal_pass_3m, first30_week1_summary)
-- splits workspaces instead and uses the workspace uuid without dashes as the
-- subject. Those ids never appear in experiment_subjects, so the admin tab
-- showed 0 signed up, 0 converted and 0 retained for all of them.
--
-- A subject now resolves to a workspace in one of two ways:
--   cookie     experiment_subjects links it, exactly as before. Signed up
--              still means the workspace was created after the assignment,
--              and the retention clock starts at linked_at.
--   workspace  no experiment_subjects row, and the subject is a workspace id.
--              The workspace is in the test by construction, so it counts as
--              signed up, and the retention clock starts at the assignment.
-- Converted keeps one rule for both: a paid charge on or after assignment.
--
-- The return type is unchanged, so the web app keeps working before and after
-- this lands. subject_id is CHECKed as 32 lowercase hex, which always casts to
-- uuid, so the workspace join can use the primary key.

CREATE OR REPLACE FUNCTION public.experiment_stats(p_key text)
 RETURNS TABLE(variant_id text, assigned integer, signed_up integer, converted integer, retention_eligible integer, retained integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- One row per assignment, carrying everything the flags need. Both joins
  -- are LEFT so an unconverted visitor is still counted in `assigned`, which
  -- is the denominator everything else is judged against.
  subject_rows AS (
    SELECT
      a.variant_id AS vid,
      a.first_assigned_at,
      (s.subject_id IS NULL AND ws.id IS NOT NULL) AS by_workspace,
      coalesce(s.workspace_id, ws.id) AS workspace_id,
      CASE WHEN s.subject_id IS NULL THEN a.first_assigned_at ELSE s.linked_at END AS clock_at
    FROM public.experiment_assignments a
    LEFT JOIN public.experiment_subjects s ON s.subject_id = a.subject_id
    LEFT JOIN public.workspaces ws ON s.subject_id IS NULL AND ws.id = a.subject_id::uuid
    WHERE a.experiment_key = p_key
  ),
  joined AS (
    SELECT
      r.vid,
      r.first_assigned_at,
      r.workspace_id,
      r.clock_at,
      w.onboarding_value_activated_at,
      (r.workspace_id IS NOT NULL
        AND (r.by_workspace OR w.created_at >= r.first_assigned_at)) AS in_test
    FROM subject_rows r
    LEFT JOIN public.workspaces w ON w.id = r.workspace_id
  ),
  flagged AS (
    SELECT
      r.vid,
      r.in_test AS is_signed_up,
      (r.in_test
        AND EXISTS (
          SELECT 1
          FROM public.billing_funnel_by_workspace b
          WHERE b.workspace_id = r.workspace_id
            AND b.paid_at IS NOT NULL
            AND b.paid_at >= r.first_assigned_at
        )) AS is_converted,
      (r.in_test
        AND r.clock_at <= now() - make_interval(days => x.retention_window_days)) AS is_eligible,
      (r.in_test
        AND r.clock_at <= now() - make_interval(days => x.retention_window_days)
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
              AND al.created_at > r.clock_at + interval '1 day'
              AND al.created_at <= r.clock_at + make_interval(days => x.retention_window_days)
          )
          -- Any call at all, successful or not: the loosest possible "they
          -- came back", useful for a test whose change is upstream of mailbox
          -- work.
          WHEN 'any_tool_call' THEN EXISTS (
            SELECT 1
            FROM public.activity_log al
            WHERE al.workspace_id = r.workspace_id
              AND al.created_at > r.clock_at + interval '1 day'
              AND al.created_at <= r.clock_at + make_interval(days => x.retention_window_days)
          )
          -- A durable column rather than activity_log, so this one goal
          -- survives the 90 day purge. Bounded below by the clock for the
          -- same reason the others are: an activation that predates it is
          -- not something this experiment can claim.
          WHEN 'value_activation' THEN (
            r.onboarding_value_activated_at IS NOT NULL
            AND r.onboarding_value_activated_at > r.clock_at
            AND r.onboarding_value_activated_at <= r.clock_at + make_interval(days => x.retention_window_days)
          )
          ELSE false
        END) AS is_retained
    FROM joined r
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
$function$;
