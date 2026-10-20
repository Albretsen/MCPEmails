-- ============================================================================
-- SAML SSO: SSO users get no personal workspace, and may share an email
-- ============================================================================
--
-- Second half of 20261019140000_sso_connections.sql (split 2026-10-20 so the
-- additive half could go to production first). This half CHANGES existing
-- signup objects, so it is applied by the owner, deliberately, before the
-- first SAML sign-in (before any Supabase SSO provider is created):
--
--   npx supabase db query --linked -f supabase/migrations/20261019140500_sso_user_signup_triggers.sql
--   npx supabase migration repair --status applied 20261019140500 --linked
--
-- Until it is applied, nothing can create an SSO user (no SSO provider
-- exists), so nothing needs it. See the WHY in 20261019140000 under
-- "SSO USERS AND SIGNUP".
--
-- RE-RUNNABLE. IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.
-- ============================================================================


-- ── 7b. public.users: email unique per provider for SSO users ───────────────
-- Same rule as before for every non-SSO user; per provider for SSO users.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_non_sso_key
  ON public.users (email) WHERE sso_provider_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_sso_provider_key
  ON public.users (sso_provider_id, email) WHERE sso_provider_id IS NOT NULL;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_email_key;


-- ── 8. Signup triggers: SSO users get no personal workspace ──────────────────
-- 'sso:<uuid>' is set by Supabase Auth before the INSERT, and app_metadata is
-- writable only by Auth and the service role, never by a user.
CREATE OR REPLACE FUNCTION public.handle_new_sso_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_provider_id uuid;
BEGIN
  BEGIN
    v_provider_id := substring(NEW.raw_app_meta_data->>'provider' FROM 5)::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_provider_id := NULL;
  END;

  -- A provider string that is not 'sso:<uuid>' is not an SSO user we can
  -- place; refuse the sign-in rather than create a user with no home.
  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'unexpected SSO provider %', NEW.raw_app_meta_data->>'provider'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.users (id, email, display_name, avatar_url, sso_provider_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NULLIF(btrim(NEW.raw_user_meta_data->>'display_name'), ''),
      NULLIF(btrim(NEW.raw_user_meta_data->>'name'), ''),
      NULLIF(btrim(NEW.raw_user_meta_data->>'full_name'), ''),
      SPLIT_PART(NEW.email, '@', 1)
    ),
    NEW.raw_user_meta_data->>'avatar_url',
    v_provider_id
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_sso_user() FROM PUBLIC, anon, authenticated;

-- CREATE OR REPLACE, not DROP + CREATE: no moment without the trigger, even
-- when this file is applied statement by statement.
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  WHEN (COALESCE(NEW.raw_app_meta_data->>'provider', '') NOT LIKE 'sso:%')
  EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE TRIGGER on_auth_sso_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  WHEN (NEW.raw_app_meta_data->>'provider' LIKE 'sso:%')
  EXECUTE FUNCTION public.handle_new_sso_user();
