-- ===========================================================================
-- verify-action-allowance.sql
--
-- Read-only checks for supabase/migrations/20260912200000_free_action_cap_150.sql.
-- Run BY HAND against production AFTER the migration is applied and repaired,
-- one statement at a time (parallel queries trip the pooler circuit breaker):
--
--   npx supabase db query --linked "<one statement from below>"
--
-- Every statement here is a SELECT. The synthetic grace/counting case at the
-- bottom needs writes and is therefore a commented recipe, not a statement.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. Schema landed as expected
-- ---------------------------------------------------------------------------

-- Both functions exist with the contracted shapes.
--   workspace_action_allowance: TABLE(plan text, owner_id uuid, exempt boolean,
--     exempt_reason text, cap integer, period_start timestamptz, period_end
--     timestamptz, grace_ends_at timestamptz, in_grace boolean, used integer,
--     remaining integer)
--   record_usage_limit_event: boolean
SELECT p.proname,
       pg_get_function_arguments(p.oid) AS args,
       pg_get_function_result(p.oid)    AS result,
       p.proacl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('workspace_action_allowance', 'record_usage_limit_event');

-- The ACL above must list ONLY postgres and service_role (no anon,
-- authenticated or PUBLIC entry). Same question, asked directly:
SELECT has_function_privilege('anon',          'public.workspace_action_allowance(uuid)', 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', 'public.workspace_action_allowance(uuid)', 'EXECUTE') AS authenticated_can_execute,
       has_function_privilege('service_role',  'public.workspace_action_allowance(uuid)', 'EXECUTE') AS service_role_can_execute;

-- New columns.
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'workspaces'          AND column_name = 'free_action_cap_exempt') OR
    (table_name = 'triage_rules'        AND column_name IN ('paused_reason', 'paused_until')) OR
    (table_name = 'billing_email_sends' AND column_name IN ('workspace_id', 'period_start', 'stripe_customer_id', 'category'))
  )
ORDER BY table_name, column_name;

-- billing_email_sends: the template allow-list now has 12 names, the keyed
-- CHECK exists, and the category expression names the three usage templates.
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.billing_email_sends'::regclass
ORDER BY conname;

SELECT pg_get_expr(d.adbin, d.adrelid) AS category_expression
FROM pg_attrdef d
JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
WHERE d.adrelid = 'public.billing_email_sends'::regclass
  AND a.attname = 'category';

-- The workspace-keyed idempotency index, and triage_rules_due_idx unchanged
-- (its predicate must still be: enabled AND deleted_at IS NULL AND running_since IS NULL).
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('billing_email_sends_workspace_template_period_idx', 'triage_rules_due_idx');


-- ---------------------------------------------------------------------------
-- (a) Early-member backfill: every workspace that existed at apply time is
--     exempt. Immediately after the migration, false must be 0. Later, false
--     grows by exactly the number of workspaces created after launch.
-- ---------------------------------------------------------------------------
SELECT free_action_cap_exempt, count(*) AS workspaces
FROM public.workspaces
GROUP BY free_action_cap_exempt
ORDER BY free_action_cap_exempt DESC;

-- Cross-check: the exempt cohort and the metered cohort must not overlap in
-- time. The newest exempt workspace was created before the migration ran and
-- the oldest non-exempt one after it, so newest_exempt < oldest_non_exempt
-- (oldest_non_exempt is NULL until the first post-launch signup). A violation
-- means somebody flipped the flag by hand.
SELECT (SELECT max(created_at) FROM public.workspaces WHERE free_action_cap_exempt)     AS newest_exempt,
       (SELECT min(created_at) FROM public.workspaces WHERE NOT free_action_cap_exempt) AS oldest_non_exempt;

-- The same thing as a list, for the eye: every non-exempt workspace with its
-- creation time. Expect empty right after the apply, then only post-launch rows.
SELECT w.id, w.slug, w.plan, w.created_at
FROM public.workspaces w
WHERE NOT w.free_action_cap_exempt
ORDER BY w.created_at;


-- ---------------------------------------------------------------------------
-- (b) The allowance row for one exempt and one comped workspace.
-- ---------------------------------------------------------------------------

-- One early member (any pre-launch workspace). Expect exempt = true,
-- exempt_reason = 'early_member', cap NULL, remaining NULL, grace_ends_at
-- NULL, in_grace false, period = the current UTC month, used = this month's
-- billable rows.
SELECT a.*
FROM public.workspaces w
CROSS JOIN LATERAL public.workspace_action_allowance(w.id) a
WHERE w.free_action_cap_exempt
ORDER BY w.created_at
LIMIT 1;

-- One comped owner. NOTE the precedence: early_member wins over comped, so a
-- pre-launch workspace owned by a comped user reports 'early_member', which
-- is correct. 'comped' can only appear on a POST-launch workspace whose owner
-- holds a live comped_scale entitlement (D8: a new grader account). This
-- returns no rows until such a workspace exists; that is expected.
SELECT w.id, w.slug, w.created_at, a.*
FROM public.workspaces w
JOIN public.user_usage_entitlements e
  ON e.user_id = w.owner_id AND e.kind = 'comped_scale'
 AND (e.expires_at IS NULL OR e.expires_at > now())
CROSS JOIN LATERAL public.workspace_action_allowance(w.id) a
WHERE NOT w.free_action_cap_exempt
ORDER BY w.created_at DESC
LIMIT 1;

-- Fallback so the comped branch is at least exercised on a real row: the
-- newest workspace owned by a comped user, whatever its exempt flag. Expect
-- exempt = true and exempt_reason IN ('early_member', 'comped').
SELECT w.id, w.slug, w.free_action_cap_exempt, a.exempt, a.exempt_reason, a.cap, a.used
FROM public.workspaces w
JOIN public.user_usage_entitlements e
  ON e.user_id = w.owner_id AND e.kind = 'comped_scale'
 AND (e.expires_at IS NULL OR e.expires_at > now())
CROSS JOIN LATERAL public.workspace_action_allowance(w.id) a
ORDER BY w.created_at DESC
LIMIT 1;

-- Sanity across the whole table: no exempt row may carry a cap, no
-- non-exempt Free row may lack one, and remaining is never negative. Expect
-- zero rows.
SELECT w.id, w.slug, w.plan, a.exempt, a.exempt_reason, a.cap, a.used, a.remaining
FROM public.workspaces w
CROSS JOIN LATERAL public.workspace_action_allowance(w.id) a
WHERE (a.exempt AND (a.cap IS NOT NULL OR a.remaining IS NOT NULL OR a.in_grace))
   OR (NOT a.exempt AND w.plan = 'free' AND a.cap IS DISTINCT FROM 150)
   OR (NOT a.exempt AND w.plan <> 'free' AND a.grace_ends_at IS NOT NULL)
   OR a.remaining < 0
   OR a.period_start > a.period_end;


-- ---------------------------------------------------------------------------
-- (c) Synthetic grace / counting case: a recipe, NOT statements to run here.
--
-- The allowance depends on workspaces.created_at and on action_usage rows,
-- so the only honest test is a throwaway workspace. Do it like this, one
-- statement at a time, and delete what you inserted:
--
--   1. Sign up a throwaway account in the app (a new email alias). Its
--      workspace is created with free_action_cap_exempt = false because the
--      column default applies to every post-migration row. Note its id:
--
--        SELECT id, created_at FROM public.workspaces WHERE slug = '<its slug>';
--
--   2. Still in grace (created moments ago). Expect exempt false, cap 150,
--      in_grace true, grace_ends_at = created_at + 7 days, period_start =
--      grace_ends_at (or period_end if that is past month end), used 0,
--      remaining 150:
--
--        SELECT * FROM public.workspace_action_allowance('<id>');
--
--   3. Age it past grace and hand it exactly 150 billable actions inside the
--      counting window. NOT read-only; run only against the throwaway id:
--
--        UPDATE public.workspaces SET created_at = now() - interval '8 days' WHERE id = '<id>';
--        INSERT INTO public.action_usage (workspace_id, tool_name, billable, quantity, occurred_at)
--        SELECT '<id>', 'email_read', true, 1, now() - (g || ' minutes')::interval
--        FROM generate_series(1, 150) g;
--
--      Expect in_grace false, used 150, remaining 0. One more row makes
--      used 151 and remaining stays 0 (never negative):
--
--        SELECT used, remaining, in_grace, period_start FROM public.workspace_action_allowance('<id>');
--
--   4. Month-boundary case: set created_at so grace ends AFTER the 1st.
--      Expect period_start = period_end = the 1st of next month and used 0
--      even though the 150 rows still exist:
--
--        UPDATE public.workspaces
--           SET created_at = (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
--                            + interval '1 month' - interval '2 days'
--         WHERE id = '<id>';
--        SELECT period_start, period_end, in_grace, used FROM public.workspace_action_allowance('<id>');
--
--   5. Clean up the ledger rows and delete the throwaway account from the app
--      (Settings, delete account), which cascades the workspace:
--
--        DELETE FROM public.action_usage WHERE workspace_id = '<id>' AND tool_name = 'email_read'
--          AND occurred_at > now() - interval '1 day';
--
-- Never run steps 3 to 5 against a customer workspace id.
-- ---------------------------------------------------------------------------
