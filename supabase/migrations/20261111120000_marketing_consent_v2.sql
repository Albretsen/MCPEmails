-- ============================================================
-- Marketing consent: accept checkbox wording v2
--
-- WHY. Only about 5% of signups ticked the v1 box ("Email me product tips and
-- offers. Unsubscribe anytime."). v2 names the concrete benefit. The English
-- text of every version lives in apps/web/src/lib/marketing-consent.mjs
-- (MARKETING_CONSENT_WORDING), append only. v1 stays valid for the rows that
-- already carry it, and so the two wordings can be compared.
--
-- Append only: this widens the three allow-lists from
-- 20260929100000_marketing_consent.sql and changes nothing else. The function
-- bodies below are that migration's, verbatim, with 'signup_checkbox_v2'
-- added to the IN lists.
-- ============================================================

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_marketing_consent_source_known;
ALTER TABLE public.users
  ADD CONSTRAINT users_marketing_consent_source_known
  CHECK (marketing_consent_source IS NULL OR marketing_consent_source IN ('signup_checkbox_v1', 'signup_checkbox_v2'));


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
     AND v_version IN ('signup_checkbox_v1', 'signup_checkbox_v2') THEN
    NEW.marketing_consent_at     := now();
    NEW.marketing_consent_source := v_version;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.users_marketing_consent_on_insert() FROM PUBLIC, anon, authenticated;


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
  IF p_source IS NULL OR p_source NOT IN ('signup_checkbox_v1', 'signup_checkbox_v2') THEN
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

COMMENT ON COLUMN public.users.marketing_consent_source IS
  'Which consent wording the user saw: signup_checkbox_v1 or signup_checkbox_v2. The English text per version is MARKETING_CONSENT_WORDING in apps/web/src/lib/marketing-consent.mjs. NULL exactly when marketing_consent_at is NULL.';
