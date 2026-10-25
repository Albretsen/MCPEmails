-- ============================================================
-- MCPEmails - referral program on for every workspace
-- 20261026120000_referral_enabled_for_everyone
-- ============================================================
--
-- 20261025090000_referrals.sql shipped the program behind
-- workspaces.referral_enabled, on only for our own workspaces. This turns it
-- on for everyone, in both places it is read:
--
--   1. every existing workspace (the referrer's Invite page and link);
--   2. the column default, so a NEW workspace is flagged too. GET and POST
--      /api/referrals read the caller's own workspace, so a friend who signs
--      up today can only see and use the "Have a referral code?" field when
--      their brand-new workspace is flagged.
--
-- Deleted workspaces are left alone. Idempotent.
-- ============================================================

ALTER TABLE public.workspaces
  ALTER COLUMN referral_enabled SET DEFAULT true;

UPDATE public.workspaces
SET referral_enabled = true
WHERE deleted_at IS NULL
  AND referral_enabled IS DISTINCT FROM true;

COMMENT ON COLUMN public.workspaces.referral_enabled IS
  'Rollout gate for the referral program (invite link, attach, rewards). On for every workspace since 20261026120000; set false to take one workspace out.';
