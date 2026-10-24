-- Pro features: the plan gate's two switches and its one read (2026-10-24).
--
-- New Pro-only features (reminders, cross-inbox search, per-inbox
-- instructions, the morning brief) are gated in one place:
-- supabase/functions/mcp-server/pro-features.ts and its web mirror
-- apps/web/src/lib/plans/pro-features.ts. A feature is VISIBLE when the
-- workspace is in the internal rollout OR the public launch switch is on, and
-- ALLOWED when it is visible and the effective plan is solo (sold as Pro) or
-- pro (sold as Business). Nothing that exists today is gated: Free and
-- Personal lose nothing.
--
--   1. workspaces.pro_features_enabled: OUR rollout flag, seeded for internal
--      workspaces exactly as chat_send_confirm_enabled is (20261023200000).
--   2. pricing_switches('pro_features_public'): the launch switch. Seeded OFF,
--      so this migration changes nothing a customer sees.
--   3. workspace_pro_features(uuid): plan + flag + switch in one round trip,
--      for the MCP server (service role only).
--
-- Forward-only, every step safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. workspaces.pro_features_enabled
--
-- No column grant for anon/authenticated: 20261016160100 made every workspaces
-- column server-owned, and a new column inherits that (members may SELECT it
-- through RLS, nobody but the service role writes it).
--
-- DEFAULT FALSE: the pre-feature behaviour, not a degraded mode.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS pro_features_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.pro_features_enabled IS
  'Internal rollout flag for the new Pro features (reminders, cross-inbox search, '
  'per-inbox instructions, morning brief). True shows them before launch; the plan '
  'still decides access. Read through workspace_pro_features().';

-- Seed: our own workspaces, identified by OWNER through
-- growth_is_internal_email, exactly as 20261023200000_send_review_mode_chat.sql
-- does it (a workspace one of us was invited into belongs to a customer).
-- Idempotent.
UPDATE public.workspaces w
SET pro_features_enabled = true
FROM public.users u
WHERE u.id = w.owner_id
  AND w.deleted_at IS NULL
  AND w.pro_features_enabled IS DISTINCT FROM true
  AND public.growth_is_internal_email(u.email);


-- ---------------------------------------------------------------------------
-- 2. The public launch switch. Flip with one UPDATE, no deploy:
--      UPDATE public.pricing_switches SET enabled = true, updated_at = now()
--      WHERE key = 'pro_features_public';
-- ON CONFLICT DO NOTHING so a re-run never undoes a launch.
-- ---------------------------------------------------------------------------
INSERT INTO public.pricing_switches (key, enabled, note)
VALUES ('pro_features_public', false,
        'New Pro features visible to every workspace (access still needs Pro or '
        'Business). Off: only workspaces with pro_features_enabled see them.')
ON CONFLICT (key) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 3. workspace_pro_features(uuid)
--
-- The MCP server's one read for the gate. The plan follows the same comped
-- rule as effective_workspace_plan() and checkPlanQuota (an unexpired
-- comped_scale grant on the owner resolves to 'pro'). No my_workspace_ids()
-- filter, because the caller is the service role; so no grant to anon or
-- authenticated, either. The dashboard uses effective_workspace_plan() with
-- the user's own client for the plan instead.
--
-- A missing switch row reads as off, the pre-launch state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workspace_pro_features(p_workspace_id uuid)
RETURNS TABLE(plan text, comped_scale boolean, rollout_enabled boolean, public_launch boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    CASE WHEN e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > now()) THEN 'pro'
      ELSE w.plan
    END AS plan,
    COALESCE(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false) AS comped_scale,
    w.pro_features_enabled AS rollout_enabled,
    COALESCE(
      (SELECT s.enabled FROM public.pricing_switches s WHERE s.key = 'pro_features_public'),
      false
    ) AS public_launch
  FROM public.workspaces w
  LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  WHERE w.id = p_workspace_id
    AND w.deleted_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.workspace_pro_features(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_pro_features(uuid) TO service_role;

COMMENT ON FUNCTION public.workspace_pro_features(uuid) IS
  'Pro feature gate inputs for one workspace: effective plan (comped-aware), '
  'workspaces.pro_features_enabled and the pro_features_public switch. Service role only.';
