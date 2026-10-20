-- ============================================================
-- mcp_tools_call_gate + workspace_action_allowance_terms (migration 20261020214737)
-- ============================================================
-- Pins: the same key filters and reads as mcp_tools_call_preflight; the
-- reservation made through the unchanged reserve_action_usage() only for a
-- metered workspace and only when a tool is named; a refusal at the cap
-- reserving nothing; exempt, comped and grace workspaces never reserved
-- against; last_used_at written at most once a minute and returned as it was
-- BEFORE the write; the terms matching workspace_action_allowance() column for
-- column; and service-role-only execution.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(33);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('9e000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'gate-free@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('9e000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'gate-comped@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

-- free_open: Free, out of grace, 10 actions used. free_full: Free, at its 150.
-- free_new: Free, created now (in grace). early: Free, early member (exempt).
-- comped: Personal, owner comped. diag: Personal with card diagnostics on.
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan, created_at, free_action_cap_exempt, card_diagnostics)
VALUES
  ('ae000000-0000-0000-0000-000000000001', 'gate-free-open', 'G1', '9e000000-0000-0000-0000-000000000001', 'free', now() - interval '60 days', false, false),
  ('ae000000-0000-0000-0000-000000000002', 'gate-free-full', 'G2', '9e000000-0000-0000-0000-000000000001', 'free', now() - interval '60 days', false, false),
  ('ae000000-0000-0000-0000-000000000003', 'gate-free-new',  'G3', '9e000000-0000-0000-0000-000000000001', 'free', now(), false, false),
  ('ae000000-0000-0000-0000-000000000004', 'gate-early',     'G4', '9e000000-0000-0000-0000-000000000001', 'free', now() - interval '60 days', true, false),
  ('ae000000-0000-0000-0000-000000000005', 'gate-comped',    'G5', '9e000000-0000-0000-0000-000000000002', 'personal', now() - interval '60 days', false, false),
  ('ae000000-0000-0000-0000-000000000006', 'gate-diag',      'G6', '9e000000-0000-0000-0000-000000000001', 'personal', now() - interval '60 days', false, true);

INSERT INTO public.user_usage_entitlements (user_id, kind, reason, source)
VALUES ('9e000000-0000-0000-0000-000000000002', 'comped_scale', 'pgTAP fixture', 'support');

INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes, expires_at, deleted_at, last_used_at)
VALUES
  ('be000000-0000-0000-0000-000000000001', 'ae000000-0000-0000-0000-000000000001', '9e000000-0000-0000-0000-000000000001', 'Open',   'mcpe_g1', 'gate_hash_open',   ARRAY['read:email'], NULL, NULL, NULL),
  ('be000000-0000-0000-0000-000000000002', 'ae000000-0000-0000-0000-000000000002', '9e000000-0000-0000-0000-000000000001', 'Full',   'mcpe_g2', 'gate_hash_full',   ARRAY['read:email'], NULL, NULL, now() - interval '5 minutes'),
  ('be000000-0000-0000-0000-000000000003', 'ae000000-0000-0000-0000-000000000003', '9e000000-0000-0000-0000-000000000001', 'New',    'mcpe_g3', 'gate_hash_new',    ARRAY['read:email'], NULL, NULL, now() - interval '10 seconds'),
  ('be000000-0000-0000-0000-000000000004', 'ae000000-0000-0000-0000-000000000004', '9e000000-0000-0000-0000-000000000001', 'Early',  'mcpe_g4', 'gate_hash_early',  ARRAY['read:email'], NULL, NULL, NULL),
  ('be000000-0000-0000-0000-000000000005', 'ae000000-0000-0000-0000-000000000005', '9e000000-0000-0000-0000-000000000002', 'Comped', 'mcpe_g5', 'gate_hash_comped', ARRAY['read:email'], NULL, NULL, NULL),
  ('be000000-0000-0000-0000-000000000006', 'ae000000-0000-0000-0000-000000000006', '9e000000-0000-0000-0000-000000000001', 'Diag',   'mcpe_g6', 'gate_hash_diag',   ARRAY['read:email'], NULL, NULL, NULL),
  ('be000000-0000-0000-0000-000000000007', 'ae000000-0000-0000-0000-000000000001', '9e000000-0000-0000-0000-000000000001', 'Gone',   'mcpe_g7', 'gate_hash_revoked', ARRAY['read:email'], NULL, now() - interval '1 minute', NULL);

INSERT INTO public.action_usage (workspace_id, tool_name, billable, quantity, meter_version)
SELECT 'ae000000-0000-0000-0000-000000000001', 'email_read', true, 1, 1 FROM generate_series(1, 10);
INSERT INTO public.action_usage (workspace_id, tool_name, billable, quantity, meter_version)
SELECT 'ae000000-0000-0000-0000-000000000002', 'email_read', true, 1, 1 FROM generate_series(1, 150);

INSERT INTO public.activity_log (workspace_id, api_key_id, tool_name, status, created_at)
VALUES
  ('ae000000-0000-0000-0000-000000000001', 'be000000-0000-0000-0000-000000000001', 'email_read', 'success', now() - interval '10 seconds'),
  ('ae000000-0000-0000-0000-000000000001', 'be000000-0000-0000-0000-000000000001', 'email_read', 'success', now() - interval '20 seconds');

-- ── A metered Free workspace with room: reserved, with the terms ─────────
CREATE TEMP TABLE g_open AS
SELECT public.mcp_tools_call_gate(
  'gate_hash_open', ARRAY[now() - interval '15 seconds', now() - interval '1 minute'],
  now() - interval '1 minute', true, 'email_list', 1) AS a;

SELECT is((SELECT a->'key'->>'id' FROM g_open), 'be000000-0000-0000-0000-000000000001', 'a live key is returned');
SELECT is((SELECT count(*)::int FROM g_open, jsonb_object_keys(a->'key')), 13, 'with the 13 columns lookupApiKey selects');
SELECT is((SELECT a->'key_counts' FROM g_open), '[1, 2]'::jsonb, 'window counts in caller order');
SELECT is((SELECT (a->>'workspace_count')::int FROM g_open), 2, 'the workspace minute count');
SELECT is((SELECT a->'workspace'->>'plan' FROM g_open), 'free', 'the workspace row');
SELECT is((SELECT a->'workspace'->'card_diagnostics' FROM g_open), 'false'::jsonb, 'with card_diagnostics');
SELECT is((SELECT a->'allowance'->>'cap' FROM g_open), '150', 'the allowance terms');
SELECT ok((SELECT a->'allowance'->'used' = 'null'::jsonb AND a->'allowance'->'remaining' = 'null'::jsonb FROM g_open),
  'with no usage count');
SELECT is((SELECT a->'reservation'->'row'->>'allowed' FROM g_open), 'true', 'a metered workspace with room is reserved against');
SELECT is((SELECT (a->'reservation'->'row'->>'used_actions')::int FROM g_open), 11, 'counting the reservation, as reserve_action_usage does');
SELECT is((SELECT a->'reservation'->>'tool_name' FROM g_open), 'email_list', 'under the tool the caller named');
SELECT is(
  (SELECT r.tool_name FROM public.action_usage_reservations r, g_open
    WHERE r.id = (g_open.a->'reservation'->'row'->>'reservation_id')::uuid),
  'email_list', 'and the reservation row exists');
SELECT ok((SELECT (a->'reservation'->>'period_start')::timestamptz = (a->'allowance'->>'period_start')::timestamptz
              AND (a->'reservation'->>'cap')::int = 150 FROM g_open),
  'made under the same cap and window the terms report');

-- Released the way the edge function releases one it does not use.
SELECT ok(public.finalize_action_usage_reservation(
  (SELECT (a->'reservation'->'row'->>'reservation_id')::uuid FROM g_open), false), 'a release succeeds');
SELECT is((SELECT count(*)::int FROM public.action_usage WHERE workspace_id = 'ae000000-0000-0000-0000-000000000001'), 10,
  'and leaves no action_usage row');

-- ── last_used_at: stamped when null, returned as it was before ───────────
SELECT ok((SELECT a->'key'->'last_used_at' = 'null'::jsonb AND (a->>'last_used_stamped')::boolean FROM g_open),
  'a never-used key is stamped, and the row returned is the one read before the stamp');
SELECT ok((SELECT last_used_at IS NOT NULL FROM public.api_keys WHERE id = 'be000000-0000-0000-0000-000000000001'),
  'the stamp landed');
SELECT is((public.mcp_tools_call_gate('gate_hash_open', ARRAY[now()], now(), false, NULL, 1)->>'last_used_stamped')::boolean,
  false, 'a key stamped under a minute ago is not stamped again');
SELECT is((public.mcp_tools_call_gate('gate_hash_new', ARRAY[now()], now(), false, NULL, 1)->>'last_used_stamped')::boolean,
  false, 'nor one used 10 seconds ago');
SELECT is((public.mcp_tools_call_gate('gate_hash_full', ARRAY[now()], now(), false, NULL, 1)->>'last_used_stamped')::boolean,
  true, 'one used 5 minutes ago is');

-- ── At the cap: refused, nothing reserved ────────────────────────────────
CREATE TEMP TABLE g_full AS
SELECT public.mcp_tools_call_gate('gate_hash_full', ARRAY[now()], now(), true, 'email_read', 1) AS a;
SELECT is((SELECT a->'reservation'->'row' FROM g_full),
  '{"allowed": false, "used_actions": 150, "reservation_id": null}'::jsonb, 'a Free workspace at 150 is refused');
SELECT is((SELECT count(*)::int FROM public.action_usage_reservations WHERE workspace_id = 'ae000000-0000-0000-0000-000000000002'), 0,
  'and nothing is reserved');

-- ── Never metered: no reservation at all ─────────────────────────────────
SELECT is(public.mcp_tools_call_gate('gate_hash_new', ARRAY[now()], now(), true, 'email_read', 1)->'reservation',
  'null'::jsonb, 'a Free workspace in its grace days is not reserved against');
SELECT is(public.mcp_tools_call_gate('gate_hash_new', ARRAY[now()], now(), true, 'email_read', 1)->'allowance'->>'in_grace',
  'true', 'and its terms say so');
SELECT is(public.mcp_tools_call_gate('gate_hash_early', ARRAY[now()], now(), true, 'email_read', 1)->'reservation',
  'null'::jsonb, 'an early member is not reserved against');
SELECT is(public.mcp_tools_call_gate('gate_hash_comped', ARRAY[now()], now(), true, 'email_read', 1)->'allowance'->>'exempt_reason',
  'comped', 'a comped owner is exempt');
SELECT is(public.mcp_tools_call_gate('gate_hash_comped', ARRAY[now()], now(), true, 'email_read', 1)->'reservation',
  'null'::jsonb, 'and not reserved against');
SELECT is(public.mcp_tools_call_gate('gate_hash_full', ARRAY[now()], now(), true, NULL, 1)->'reservation',
  'null'::jsonb, 'no tool named, no reservation');
SELECT ok((SELECT a->'allowance' = 'null'::jsonb AND a->'reservation' = 'null'::jsonb
             FROM (SELECT public.mcp_tools_call_gate('gate_hash_full', ARRAY[now()], now(), false, 'email_read', 1) AS a) s),
  'no allowance asked for, no allowance and no reservation');

-- ── Dead keys, diagnostics, parity, privileges ───────────────────────────
SELECT is(public.mcp_tools_call_gate('gate_hash_revoked', ARRAY[now()], now(), true, 'email_read', 1),
  '{"key": null}'::jsonb, 'a revoked key returns key: null and reserves nothing');
SELECT is(public.mcp_tools_call_gate('gate_hash_diag', ARRAY[now()], now(), false, NULL, 1)->'workspace'->'card_diagnostics',
  'true'::jsonb, 'card_diagnostics comes back as stored');

SELECT is(
  (SELECT count(*)::int FROM public.workspaces w
    WHERE w.id::text LIKE 'ae000000-%'
      AND (SELECT to_jsonb(t) - 'used' - 'remaining' FROM public.workspace_action_allowance_terms(w.id) t)
          IS DISTINCT FROM
          (SELECT to_jsonb(f) - 'used' - 'remaining' FROM public.workspace_action_allowance(w.id) f)),
  0, 'the terms equal workspace_action_allowance() in every column but the count');

SELECT ok(
  NOT has_function_privilege('anon', 'public.mcp_tools_call_gate(text, timestamptz[], timestamptz, boolean, text, integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.mcp_tools_call_gate(text, timestamptz[], timestamptz, boolean, text, integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.workspace_action_allowance_terms(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.workspace_action_allowance_terms(uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.mcp_tools_call_gate(text, timestamptz[], timestamptz, boolean, text, integer)', 'EXECUTE'),
  'service role only');

SELECT * FROM finish();
ROLLBACK;
