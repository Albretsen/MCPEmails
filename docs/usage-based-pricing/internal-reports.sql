-- Usage-based pricing: internal reporting pack, revision 1
--
-- READ ONLY. Run with a service/admin reporting role. Bind :report_end once
-- (an exclusive UTC timestamptz) and retain it with the exported result. The
-- queries return only IDs and aggregate meter data: never join or export users
-- email addresses, email content, recipients, tool arguments, API-key IDs, or
-- inbox IDs.
--
-- Report 1 — shadow-meter distribution, outcomes, and tool mix
--
-- The rolling window is [report_end - 30 days, report_end). The prior complete
-- window is [report_end - 60 days, report_end - 30 days). "Effective plan"
-- reflects an active comped Scale entitlement but never changes the underlying
-- Stripe/billing projection. Empty plans are intentionally returned as zero
-- rather than omitted so the cap decision can be reviewed for every plan.
WITH parameters AS (
  SELECT :report_end::timestamptz AS report_end
), plan_catalog AS (
  SELECT * FROM (VALUES
    ('free'::text, 2500::bigint),
    ('solo'::text, 50000::bigint),
    ('pro'::text, 300000::bigint)
  ) AS v(plan, cap)
), workspace_effective_plan AS (
  SELECT
    w.id AS workspace_id,
    CASE
      WHEN e.kind = 'comped_scale'
       AND (e.expires_at IS NULL OR e.expires_at > p.report_end) THEN 'pro'
      WHEN w.plan IN ('free', 'solo', 'pro') THEN w.plan
      ELSE 'free'
    END AS effective_plan
  FROM public.workspaces w
  CROSS JOIN parameters p
  LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  WHERE w.deleted_at IS NULL
), rolling_workspace_actions AS (
  SELECT
    ep.workspace_id,
    ep.effective_plan,
    COALESCE(SUM(au.quantity), 0)::bigint AS actions
  FROM workspace_effective_plan ep
  CROSS JOIN parameters p
  LEFT JOIN public.action_usage au
    ON au.workspace_id = ep.workspace_id
   AND au.billable = true
   AND au.meter_version = 1
   AND au.occurred_at >= p.report_end - INTERVAL '30 days'
   AND au.occurred_at < p.report_end
  GROUP BY ep.workspace_id, ep.effective_plan
), distribution AS (
  SELECT
    effective_plan AS plan,
    count(*)::bigint AS workspaces,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY actions)::numeric(20,2) AS p50_actions,
    percentile_cont(0.8) WITHIN GROUP (ORDER BY actions)::numeric(20,2) AS p80_actions,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY actions)::numeric(20,2) AS p95_actions,
    sum(actions)::bigint AS total_actions,
    count(*) FILTER (WHERE actions > pc.cap)::bigint AS over_proposed_cap_workspaces
  FROM rolling_workspace_actions rwa
  JOIN plan_catalog pc ON pc.plan = rwa.effective_plan
  GROUP BY effective_plan, pc.cap
), activity_outcomes AS (
  SELECT
    COALESCE(al.status, 'no_activity') AS status,
    count(al.id)::bigint AS calls
  FROM parameters p
  LEFT JOIN public.activity_log al
    ON al.created_at >= p.report_end - INTERVAL '30 days'
   AND al.created_at < p.report_end
  GROUP BY COALESCE(al.status, 'no_activity')
), tool_mix AS (
  SELECT au.tool_name, sum(au.quantity)::bigint AS actions
  FROM public.action_usage au
  CROSS JOIN parameters p
  WHERE au.billable = true
    AND au.meter_version = 1
    AND au.occurred_at >= p.report_end - INTERVAL '30 days'
    AND au.occurred_at < p.report_end
  GROUP BY au.tool_name
), prior_complete_actions AS (
  SELECT COALESCE(SUM(au.quantity), 0)::bigint AS actions
  FROM public.action_usage au
  CROSS JOIN parameters p
  WHERE au.billable = true
    AND au.meter_version = 1
    AND au.occurred_at >= p.report_end - INTERVAL '60 days'
    AND au.occurred_at < p.report_end - INTERVAL '30 days'
)
SELECT jsonb_build_object(
  'report_end', (SELECT report_end FROM parameters),
  'meter_version', 1,
  'rolling_30_day_distribution_by_effective_plan', (
    SELECT jsonb_agg(jsonb_build_object(
      'plan', pc.plan,
      'cap', pc.cap,
      'workspaces', COALESCE(d.workspaces, 0),
      'p50_actions', COALESCE(d.p50_actions, 0),
      'p80_actions', COALESCE(d.p80_actions, 0),
      'p95_actions', COALESCE(d.p95_actions, 0),
      'total_actions', COALESCE(d.total_actions, 0),
      'over_proposed_cap_workspaces', COALESCE(d.over_proposed_cap_workspaces, 0)
    ) ORDER BY pc.cap)
    FROM plan_catalog pc LEFT JOIN distribution d ON d.plan = pc.plan
  ),
  'successful_vs_failed_calls', (
    SELECT jsonb_build_object(
      'successful_calls', COALESCE(sum(calls) FILTER (WHERE status = 'success'), 0),
      'failed_or_rate_limited_calls', COALESCE(sum(calls) FILTER (WHERE status <> 'success' AND status <> 'no_activity'), 0),
      'all_logged_calls', COALESCE(sum(calls) FILTER (WHERE status <> 'no_activity'), 0)
    ) FROM activity_outcomes
  ),
  'tool_mix', (SELECT COALESCE(jsonb_agg(to_jsonb(tool_mix) ORDER BY actions DESC, tool_name), '[]'::jsonb) FROM tool_mix),
  'prior_complete_30_day_billable_actions', (SELECT actions FROM prior_complete_actions)
) AS report;


-- Report 2 — approved grant candidates
--
-- Use docs/usage-based-pricing/phase-0-comped-grant-candidates.sql without
-- modification. It is the approved source of candidate rows and CSV fields;
-- do not use the aggregate report above to select individual users.


-- Report 3 — protected-entitlement grant and support audit
--
-- One current row per user-level entitlement, with aggregate workspace
-- coverage. The audit event stream lets support prove that webhook activity did
-- not remove or downgrade a comped grant. This report deliberately excludes
-- `reason`, user email, and Stripe customer ID; retrieve a reason only in the
-- approved support flow for the affected user.
WITH parameters AS (
  SELECT :report_end::timestamptz AS report_end
), owned_workspaces AS (
  SELECT owner_id AS user_id, count(*)::bigint AS active_workspace_count,
         count(*) FILTER (WHERE plan = 'pro')::bigint AS projected_scale_workspace_count
  FROM public.workspaces
  WHERE deleted_at IS NULL
  GROUP BY owner_id
), audit_summary AS (
  SELECT
    user_id,
    count(*)::bigint AS audit_events,
    max(occurred_at) AS last_audit_at,
    count(*) FILTER (WHERE operation = 'delete')::bigint AS delete_events,
    count(*) FILTER (WHERE operation = 'update')::bigint AS update_events
  FROM public.user_usage_entitlement_audit
  GROUP BY user_id
)
SELECT
  e.user_id,
  e.kind,
  e.source,
  e.granted_at,
  e.expires_at,
  (e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > p.report_end)) AS comped_scale_active_at_report_end,
  COALESCE(ow.active_workspace_count, 0) AS active_workspace_count,
  COALESCE(ow.projected_scale_workspace_count, 0) AS projected_scale_workspace_count,
  COALESCE(a.audit_events, 0) AS audit_events,
  a.last_audit_at,
  COALESCE(a.update_events, 0) AS update_events,
  COALESCE(a.delete_events, 0) AS delete_events
FROM public.user_usage_entitlements e
CROSS JOIN parameters p
LEFT JOIN owned_workspaces ow ON ow.user_id = e.user_id
LEFT JOIN audit_summary a ON a.user_id = e.user_id
ORDER BY e.granted_at DESC, e.user_id;


-- Report 4 — meter, reconciliation, and enforcement anomalies
--
-- Returns aggregate counts and affected workspace IDs only. Investigate an
-- affected workspace through the approved support procedure; do not add email
-- or tool-argument fields to this report. Any non-zero result needs a recorded
-- disposition before moving from shadow to enforcement.
WITH parameters AS (
  SELECT :report_end::timestamptz AS report_end
), expected_billable_tools AS (
  SELECT unnest(ARRAY[
    'contact_search', 'draft_create', 'draft_delete', 'draft_list', 'draft_reply',
    'draft_send', 'draft_update', 'email_archive', 'email_attachment', 'email_copy',
    'email_copy_batch', 'email_delete', 'email_delete_batch', 'email_extract',
    'email_flag', 'email_forward', 'email_list', 'email_move', 'email_move_batch',
    'email_original', 'email_read', 'email_read_batch', 'email_reply', 'email_search',
    'email_search_and_delete', 'email_search_and_move', 'email_send', 'folder_create',
    'folder_delete', 'folder_list', 'folder_rename', 'schedule_cancel', 'schedule_create',
    'schedule_list', 'signature_get', 'signature_set'
  ]::text[]) AS tool_name
), anomalies AS (
  SELECT 'invalid_billable_shape'::text AS anomaly, au.workspace_id
  FROM public.action_usage au CROSS JOIN parameters p
  WHERE au.occurred_at >= p.report_end - INTERVAL '30 days' AND au.occurred_at < p.report_end
    AND ((au.billable AND au.quantity <> 1) OR (NOT au.billable AND au.quantity <> 0))
  UNION ALL
  SELECT 'unknown_billable_tool', au.workspace_id
  FROM public.action_usage au CROSS JOIN parameters p
  LEFT JOIN expected_billable_tools bt ON bt.tool_name = au.tool_name
  WHERE au.occurred_at >= p.report_end - INTERVAL '30 days' AND au.occurred_at < p.report_end
    AND au.meter_version = 1 AND au.billable AND bt.tool_name IS NULL
  UNION ALL
  SELECT 'inbox_list_marked_billable', au.workspace_id
  FROM public.action_usage au CROSS JOIN parameters p
  WHERE au.occurred_at >= p.report_end - INTERVAL '30 days' AND au.occurred_at < p.report_end
    AND au.meter_version = 1 AND au.tool_name = 'inbox_list' AND au.billable
  UNION ALL
  SELECT 'successful_billable_activity_missing_ledger_row', al.workspace_id
  FROM public.activity_log al CROSS JOIN parameters p
  JOIN expected_billable_tools bt ON bt.tool_name = al.tool_name
  WHERE al.status = 'success'
    AND al.created_at >= p.report_end - INTERVAL '30 days' AND al.created_at < p.report_end
    AND NOT EXISTS (
      SELECT 1 FROM public.action_usage au
      WHERE au.workspace_id = al.workspace_id AND au.tool_name = al.tool_name
        AND au.billable AND au.meter_version = 1
        AND au.occurred_at >= al.created_at - INTERVAL '5 minutes'
        AND au.occurred_at <= al.created_at + INTERVAL '5 minutes'
    )
  UNION ALL
  SELECT 'active_comped_owner_without_scale_projection', w.id
  FROM public.workspaces w CROSS JOIN parameters p
  JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  WHERE w.deleted_at IS NULL AND w.plan <> 'pro'
    AND e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > p.report_end)
  UNION ALL
  SELECT 'legacy_grandfathered_owner_without_active_comped_entitlement', w.id
  FROM public.workspaces w CROSS JOIN parameters p
  WHERE w.deleted_at IS NULL AND w.grandfathered = true
    AND NOT EXISTS (
      SELECT 1 FROM public.user_usage_entitlements e
      WHERE e.user_id = w.owner_id AND e.kind = 'comped_scale'
        AND (e.expires_at IS NULL OR e.expires_at > p.report_end)
    )
  UNION ALL
  SELECT 'usage_limit_event_for_active_comped_owner', ule.workspace_id
  FROM public.usage_limit_events ule CROSS JOIN parameters p
  JOIN public.workspaces w ON w.id = ule.workspace_id
  JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  WHERE ule.occurred_at >= p.report_end - INTERVAL '30 days' AND ule.occurred_at < p.report_end
    AND e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > p.report_end)
)
SELECT anomaly, count(*)::bigint AS affected_rows,
       count(DISTINCT workspace_id)::bigint AS affected_workspaces,
       array_agg(DISTINCT workspace_id ORDER BY workspace_id) FILTER (WHERE workspace_id IS NOT NULL) AS workspace_ids
FROM anomalies
GROUP BY anomaly
ORDER BY anomaly;
