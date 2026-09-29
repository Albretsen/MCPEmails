-- ============================================================
-- Marketing email consent, captured at signup
--
-- WHY. Norwegian law (markedsføringsloven § 15) and ePrivacy require PRIOR
-- consent before marketing email. Decided 2026-09-29: ask once, with an
-- unticked checkbox on the signup form, and email only people who ticked it.
-- Nothing for existing users: no banner, no settings toggle, no backfill. So
-- every row that exists when this migration runs stays NULL, forever.
--
-- THE CONTRACT (shared with the email sender, do not rename):
--   marketing_consent_at      when the box was ticked, set by the DATABASE
--                             (now()), never from a client-supplied value.
--                             NULL = no consent.
--   marketing_consent_source  which checkbox wording they saw, e.g.
--                             'signup_checkbox_v1'. The English text of each
--                             version lives in apps/web/src/lib/marketing-consent.mjs
--                             (MARKETING_CONSENT_WORDING), append only.
--
-- Consent does NOT override an opt-out. A sender must also honour
-- users.unsubscribed_at and users.unsubscribed_categories, which the one-click
-- unsubscribe route (/api/email/unsubscribe) keeps writing exactly as before.
-- The consent columns are deliberately left in place after an unsubscribe: they
-- are the record of what was agreed and when, and the opt-out columns are the
-- record of its withdrawal.
--
-- HOW A VALUE GETS IN. Two paths, both server-side:
--   1. Password signup. SignupApp sends `marketing_consent: true` and
--      `marketing_consent_version` in the signUp user metadata only when the
--      box is ticked. users_marketing_consent_on_insert() below reads them off
--      auth.users when handle_new_user() inserts the public.users row, and
--      stamps now(). Anything else in the metadata (no key, false, "true" as a
--      string, an unknown version) records nothing.
--   2. Google / GitHub from the signup page. OAuth has no metadata channel, so
--      /auth/callback calls record_signup_marketing_consent() with the service
--      role, only for an account created in the last few minutes.
-- Every other way an account is created (login-page OAuth, magic link) never
-- shows the box and so records nothing.
--
-- WHY A SEPARATE TRIGGER ON public.users INSTEAD OF EDITING handle_new_user().
-- handle_new_user() can only be changed by retyping its whole body, and a
-- retype from a stale copy is exactly how attribution died for 168 signups on
-- 2026-08-05 (see 20260915190000). A BEFORE INSERT trigger on public.users
-- needs no change to that function and also means NO insert, from any caller,
-- can supply its own consent values: they are always overwritten from
-- auth.users.
-- ============================================================

-- 1. Columns. Nullable, no default: existing rows stay NULL.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_consent_source text;

COMMENT ON COLUMN public.users.marketing_consent_at IS
  'When the user ticked the marketing-email checkbox at signup. Set by the database (now()), never by a client. NULL = no consent: do not send marketing email. Does not override unsubscribed_at / unsubscribed_categories.';

COMMENT ON COLUMN public.users.marketing_consent_source IS
  'Which consent wording the user saw, e.g. signup_checkbox_v1. The English text per version is MARKETING_CONSENT_WORDING in apps/web/src/lib/marketing-consent.mjs. NULL exactly when marketing_consent_at is NULL.';

-- Both or neither: a timestamp with no wording proves nothing, and a wording
-- with no timestamp is not consent.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_marketing_consent_pair;
ALTER TABLE public.users
  ADD CONSTRAINT users_marketing_consent_pair
  CHECK ((marketing_consent_at IS NULL) = (marketing_consent_source IS NULL));

-- Only versions whose wording is recorded in code. Adding a version means a new
-- migration here AND a new entry in MARKETING_CONSENT_WORDING; the test in
-- apps/web/src/lib/marketing-consent.test.mjs reads this file to keep the two
-- lists identical.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_marketing_consent_source_known;
ALTER TABLE public.users
  ADD CONSTRAINT users_marketing_consent_source_known
  CHECK (marketing_consent_source IS NULL OR marketing_consent_source IN ('signup_checkbox_v1'));

-- The sender's segment query filters on this.
CREATE INDEX IF NOT EXISTS idx_users_marketing_consent_at
  ON public.users (marketing_consent_at)
  WHERE marketing_consent_at IS NOT NULL;


-- 2. On insert: derive consent from the auth.users row, ignore whatever the
--    INSERT itself supplied. SECURITY DEFINER because it reads auth.users.
CREATE OR REPLACE FUNCTION public.users_marketing_consent_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_meta    jsonb;
  v_version text;
BEGIN
  NEW.marketing_consent_at     := NULL;
  NEW.marketing_consent_source := NULL;

  SELECT u.raw_user_meta_data INTO v_meta
  FROM auth.users AS u
  WHERE u.id = NEW.id;

  v_version := v_meta->>'marketing_consent_version';

  -- A JSON boolean true, not the string "true", and a known version.
  IF v_meta->'marketing_consent' = 'true'::jsonb
     AND v_version IN ('signup_checkbox_v1') THEN
    NEW.marketing_consent_at     := now();
    NEW.marketing_consent_source := v_version;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.users_marketing_consent_on_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS users_marketing_consent_on_insert ON public.users;
CREATE TRIGGER users_marketing_consent_on_insert
  BEFORE INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_marketing_consent_on_insert();


-- 3. On update: a signed-in user cannot write these columns on themselves.
--    users_update_own lets an authenticated user UPDATE any column of their
--    own row, which is fine for display_name and would be a hole here: consent
--    that a user (or a script with their token) can set is not proof of
--    anything. Withdrawal does not need this path; it goes through the
--    unsubscribe columns, which stay writable exactly as before.
--
--    SECURITY INVOKER on purpose: current_user must be the caller's role
--    (authenticated / anon via PostgREST). The service role and the database
--    owner pass, which is what the OAuth RPC below and operator fixes use.
CREATE OR REPLACE FUNCTION public.users_marketing_consent_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND (NEW.marketing_consent_at IS DISTINCT FROM OLD.marketing_consent_at
          OR NEW.marketing_consent_source IS DISTINCT FROM OLD.marketing_consent_source) THEN
    RAISE EXCEPTION 'marketing consent can only be recorded at signup'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_marketing_consent_guard ON public.users;
CREATE TRIGGER users_marketing_consent_guard
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_marketing_consent_guard();


-- 4. The OAuth path. Called by /auth/callback with the service role after a
--    Google/GitHub exchange, only when the signup page left its consent cookie.
--    Refuses (returns false) unless:
--      * the version is known,
--      * the account was created in the last 10 minutes (the callback runs
--        seconds after the provider creates it; an old account signing in with
--        a stale cookie gets nothing),
--      * no consent is recorded yet (first consent wins, never overwritten).
--    The timestamp is now(), never an argument.
CREATE OR REPLACE FUNCTION public.record_signup_marketing_consent(
  p_user_id uuid,
  p_source  text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('signup_checkbox_v1') THEN
    RETURN false;
  END IF;

  UPDATE public.users AS pu
     SET marketing_consent_at     = now(),
         marketing_consent_source = p_source
   WHERE pu.id = p_user_id
     AND pu.marketing_consent_at IS NULL
     AND EXISTS (
       SELECT 1 FROM auth.users AS au
        WHERE au.id = p_user_id
          AND au.created_at > now() - interval '10 minutes'
     );

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_signup_marketing_consent(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_signup_marketing_consent(uuid, text) TO service_role;

COMMENT ON FUNCTION public.record_signup_marketing_consent(uuid, text) IS
  'Service role only. Records signup-page marketing consent for an OAuth signup created in the last 10 minutes, if none is recorded yet. Timestamp is now(). Returns true when a row was written.';
