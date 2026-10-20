-- ============================================================================
-- Auth hooks: SSO enforcement and the Microsoft email guard
-- ============================================================================
--
-- WHY. The anon key is public, so anyone can call Supabase Auth directly
-- (password, OTP / magic link, OAuth authorize, refresh). A check in our own
-- routes is only a nicer error message. The only server-side place that sees
-- every sign-in is Supabase Auth itself, through its hooks. Two hooks here:
--
--   public.auth_hook_custom_access_token(event)  Custom Access Token hook.
--     Runs every time Supabase issues an access token. THE ENFORCER.
--     1. SSO enforcement. When the user's email domain is verified on an
--        active, enforced SSO connection, refuse the token unless the user is
--        an SSO user of THAT connection's provider. Supabase never links SSO
--        identities (an SSO sign-in is always its own auth.users row with
--        is_sso_user = true and app_metadata.provider = 'sso:<id>'), so a
--        non-SSO row with an enforced email is, by construction, a password,
--        magic link, Google, GitHub or Microsoft sign-in. Deciding on the user
--        row rather than on authentication_method also covers token_refresh:
--        an existing session for that user stops refreshing once enforcement
--        is on (UNVERIFIED that the hook runs on refresh: live-test item).
--     2. SSO domain binding. An SSO token is issued only when the user's
--        email domain routes, through our verified sso_domains, to the very
--        provider the user signed in with (sso_provider_for_domain). Any
--        customer's IdP can assert any address, and anyone with the public
--        anon key can start SAML for any provider id and take the implicit
--        flow, which never reaches the /auth/callback check
--        (lib/sso/join.ts). Without this, company A's IdP could mint a
--        session for x@companyB.example on a domain B has not enforced, and
--        a connection an admin disabled would keep signing people in. Same
--        refusal as the callback: 'sso_not_configured'.
--     3. Microsoft email guard. Production auto-confirms email, and Supabase
--        then links an `azure` identity to an existing user with the same
--        email even when Microsoft did not vouch for that email. The
--        /auth/callback guard (PR #144) cannot catch the implicit flow, which
--        never reaches our callback. So on an OAuth sign-in whose identity
--        (the one with the newest last_sign_in_at) is `azure`, refuse the
--        token unless the ID token carried xms_edov = true, or the sign-in is
--        a Microsoft personal account (consumer tenant). Same rule as
--        isMicrosoftEmailVerified() in apps/web/src/lib/auth/microsoft-sign-in.ts.
--
--   public.auth_hook_before_user_created(event)  Before User Created hook.
--     Second layer for NEW accounts: refuses a non-SSO signup on an enforced
--     domain, and an `azure` signup without a verified email, before the
--     auth.users row (and its personal workspace) exists. Without it the
--     access-token hook still refuses the token, but the junk account and
--     workspace would remain.
--
-- BREAK-GLASS. The owner of the workspace that owns the enforced connection
-- (workspaces.owner_id) is exempt from SSO enforcement, so a broken IdP or an
-- expired SAML certificate never locks the company out of its own settings.
-- One account per connection, already the most privileged one; everyone else
-- on the domain, admins included, must use SSO. The Microsoft email guard has
-- no exemption.
--
-- FAIL OPEN. A hook that throws blocks every sign-in for everyone. Each hook
-- body catches any internal error, logs a WARNING and allows the sign-in.
-- Enforcement is a policy layer; an outage of it must not become an outage of
-- sign-in.
--
-- KILL SWITCH. public.auth_hook_switches, one row per check:
--   UPDATE public.auth_hook_switches SET enabled = false WHERE name = 'sso_enforcement';
--   UPDATE public.auth_hook_switches SET enabled = false WHERE name = 'sso_domain_binding';
--   UPDATE public.auth_hook_switches SET enabled = false WHERE name = 'azure_email_guard';
-- Takes effect on the next sign-in, no deploy. A missing row counts as on.
-- To remove the hooks entirely, turn them off in the dashboard
-- (Authentication > Hooks); the functions are harmless when unregistered.
--
-- ERROR MESSAGES are stable reason codes ('sso_required',
-- 'sso_not_configured', 'microsoft_email_unverified'), not prose: supabase-js returns them as
-- error.message, /auth/callback forwards them as /auth/error?reason=..., and
-- the app turns them into localized copy.
--
-- REGISTRATION. Not active until the owner registers both functions in the
-- dashboard (Authentication > Hooks). The PR lists the steps. Until then this
-- migration changes nothing at sign-in.
--
-- RE-RUNNABLE. CREATE OR REPLACE / IF NOT EXISTS / ON CONFLICT throughout.
-- ============================================================================


-- Supabase Auth calls the hooks as supabase_auth_admin.
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;


-- ── 1. Kill switch ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_hook_switches (
  name        text PRIMARY KEY
                CHECK (name IN ('sso_enforcement', 'sso_domain_binding', 'azure_email_guard')),
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.auth_hook_switches (name, enabled) VALUES
  ('sso_enforcement', true),
  ('sso_domain_binding', true),
  ('azure_email_guard', true)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE public.auth_hook_switches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.auth_hook_switches FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.auth_hook_switches TO service_role;

COMMENT ON TABLE public.auth_hook_switches IS
  'Kill switches for the auth hooks (20261019153000). enabled = false turns a check off '
  'on the next sign-in. A missing row counts as on.';

CREATE OR REPLACE FUNCTION public.auth_hook_switch_on(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT s.enabled FROM public.auth_hook_switches s WHERE s.name = p_name), true);
$$;

REVOKE ALL ON FUNCTION public.auth_hook_switch_on(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_hook_switch_on(text) TO service_role;


-- ── 2. Enforced connection for an email ──────────────────────────────────────
-- The enforced, active connection whose verified domain is this email's
-- domain, on a live workspace; no row otherwise. Exact domain match, the same
-- normalisation as sso_provider_for_domain(). Ignores the kill switch: the
-- callers decide.
CREATE OR REPLACE FUNCTION public.sso_enforced_connection_for_email(p_email text)
RETURNS TABLE (connection_id uuid, workspace_id uuid, supabase_sso_provider_id uuid, owner_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.workspace_id, c.supabase_sso_provider_id, w.owner_id
  FROM   public.sso_domains d
  JOIN   public.sso_connections c ON c.id = d.connection_id
  JOIN   public.workspaces w ON w.id = c.workspace_id
  WHERE  d.domain = rtrim(lower(btrim(substring(p_email FROM '@([^@]*)$'))), '.')
  AND    d.verified_at IS NOT NULL
  AND    c.status = 'active'
  AND    c.enforced
  AND    c.supabase_sso_provider_id IS NOT NULL
  AND    w.deleted_at IS NULL
  LIMIT  1;
$$;

REVOKE ALL ON FUNCTION public.sso_enforced_connection_for_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sso_enforced_connection_for_email(text) TO service_role;


-- ── 3. Route pre-check ───────────────────────────────────────────────────────
-- For the sign-in routes' friendly error only (the hooks enforce): true when a
-- non-SSO sign-in with this email would be refused. False for the break-glass
-- owner, when the switch is off, or when nothing is enforced. Service role.
CREATE OR REPLACE FUNCTION public.sso_sign_in_required(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.auth_hook_switch_on('sso_enforcement')
     AND EXISTS (
       SELECT 1
       FROM   public.sso_enforced_connection_for_email(p_email) e
       WHERE  NOT EXISTS (
         SELECT 1 FROM auth.users u
         WHERE  u.id = e.owner_id
         AND    lower(u.email) = lower(btrim(p_email))
       )
     );
$$;

REVOKE ALL ON FUNCTION public.sso_sign_in_required(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sso_sign_in_required(text) TO service_role;


-- ── 4. Microsoft: does this identity's data vouch for its email ──────────────
-- identity_data of an `azure` identity (or user_metadata of a new azure user,
-- which Supabase fills from the same claims). True only with a non-empty
-- email and xms_edov true ("1"/"true" from some tenants), or the Microsoft
-- personal-account tenant. A MISSING xms_edov is NOT verified (stricter than
-- Supabase, which treats missing as verified).
CREATE OR REPLACE FUNCTION public.auth_azure_email_verified(p_data jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  -- Never NULL: a NULL here would read as "not refused" in the callers.
  SELECT COALESCE(
           btrim(p_data->>'email') <> ''
           AND (
                lower(COALESCE(p_data->'custom_claims'->>'xms_edov', '')) IN ('true', '1')
             OR lower(COALESCE(p_data->>'xms_edov', '')) IN ('true', '1')
             OR COALESCE(p_data->'custom_claims'->>'tid', p_data->>'tid', '')
                  = '9188040d-6c67-4c5b-b112-36a304b66dad'
           ),
         false);
$$;

REVOKE ALL ON FUNCTION public.auth_azure_email_verified(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_azure_email_verified(jsonb) TO service_role;


-- ── 5. The decision, shared by the access-token hook and the tests ───────────
-- NULL when the token may be issued, otherwise the reason code. Reads the
-- user row and identities as they are when the hook runs (Supabase calls it
-- inside the sign-in transaction, after stamping last_sign_in_at).
CREATE OR REPLACE FUNCTION public.auth_token_refusal(p_user_id uuid, p_authentication_method text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user       auth.users%ROWTYPE;
  v_provider   text;
  v_is_sso     boolean;
  v_enforced   record;
  v_routed     uuid;
  v_identity   record;
BEGIN
  SELECT * INTO v_user FROM auth.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_provider := COALESCE(v_user.raw_app_meta_data->>'provider', '');
  v_is_sso := COALESCE(v_user.is_sso_user, false) OR v_provider LIKE 'sso:%';

  -- 1. SSO enforcement.
  IF v_user.email IS NOT NULL AND public.auth_hook_switch_on('sso_enforcement') THEN
    SELECT * INTO v_enforced FROM public.sso_enforced_connection_for_email(v_user.email);
    IF FOUND THEN
      IF v_is_sso THEN
        -- An SSO user from some OTHER provider asserting this domain's email
        -- (any IdP can assert any address) is not this company's user.
        IF v_provider <> 'sso:' || v_enforced.supabase_sso_provider_id::text THEN
          RETURN 'sso_required';
        END IF;
      ELSIF v_user.id IS DISTINCT FROM v_enforced.owner_id THEN
        RETURN 'sso_required';
      END IF;
    END IF;
  END IF;

  -- 2. SSO domain binding: an SSO user's email domain must route to the
  -- provider they signed in with. Also refuses a disabled connection, an
  -- unverified or removed domain, and a deleted workspace.
  IF v_is_sso AND public.auth_hook_switch_on('sso_domain_binding') THEN
    v_routed := public.sso_provider_for_domain(substring(v_user.email FROM '@([^@]*)$'));
    IF v_routed IS NULL OR v_provider <> 'sso:' || v_routed::text THEN
      RETURN 'sso_not_configured';
    END IF;
  END IF;

  -- 3. Microsoft email guard: only on an OAuth sign-in, and only when the
  -- identity this sign-in used is azure. A later Google, password or magic
  -- link sign-in is never refused because of an old azure identity.
  IF p_authentication_method = 'oauth' AND public.auth_hook_switch_on('azure_email_guard') THEN
    SELECT i.provider, i.identity_data INTO v_identity
    FROM   auth.identities i
    WHERE  i.user_id = p_user_id
    ORDER  BY COALESCE(i.last_sign_in_at, i.updated_at, i.created_at) DESC NULLS LAST
    LIMIT  1;
    IF FOUND AND v_identity.provider = 'azure'
       AND NOT public.auth_azure_email_verified(v_identity.identity_data) THEN
      RETURN 'microsoft_email_unverified';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_token_refusal(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_token_refusal(uuid, text) TO service_role;


-- ── 6. Custom Access Token hook ──────────────────────────────────────────────
-- Leaves the claims untouched; only ever allows or refuses.
CREATE OR REPLACE FUNCTION public.auth_hook_custom_access_token(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reason text;
BEGIN
  BEGIN
    v_reason := public.auth_token_refusal(
      (event->>'user_id')::uuid,
      event->>'authentication_method'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auth_hook_custom_access_token failed open: % (%)', SQLERRM, SQLSTATE;
    v_reason := NULL;
  END;

  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', v_reason)
    );
  END IF;

  RETURN jsonb_build_object('claims', event->'claims');
END;
$$;

REVOKE ALL ON FUNCTION public.auth_hook_custom_access_token(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_hook_custom_access_token(jsonb) TO supabase_auth_admin, service_role;


-- ── 7. Before User Created hook ──────────────────────────────────────────────
-- Payload: { metadata: {...}, user: { email, app_metadata: { provider },
-- user_metadata, identities, ... } }. The row does not exist yet. Returns {}
-- to allow.
CREATE OR REPLACE FUNCTION public.auth_signup_refusal(p_user jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email     text := NULLIF(btrim(p_user->>'email'), '');
  v_provider  text := COALESCE(p_user->'app_metadata'->>'provider', '');
  v_identity  jsonb;
BEGIN
  -- 1. SSO enforcement. Only an SSO signup may create an account on an
  -- enforced domain. (The break-glass owner already has an account, so no
  -- exemption is needed here.) Any 'sso…' provider passes this layer: that
  -- the payload already carries 'sso:<id>' at this point is UNVERIFIED, and a
  -- wrong guess here would refuse every SSO user. The access-token hook
  -- checks the exact provider on the stored row.
  IF v_email IS NOT NULL AND v_provider NOT LIKE 'sso%'
     AND public.auth_hook_switch_on('sso_enforcement') THEN
    PERFORM 1 FROM public.sso_enforced_connection_for_email(v_email);
    IF FOUND THEN
      RETURN 'sso_required';
    END IF;
  END IF;

  -- 2. Microsoft email guard for a new azure account.
  IF v_provider = 'azure' AND public.auth_hook_switch_on('azure_email_guard') THEN
    SELECT i->'identity_data' INTO v_identity
    FROM   jsonb_array_elements(COALESCE(p_user->'identities', '[]'::jsonb)) AS i
    WHERE  i->>'provider' = 'azure'
    LIMIT  1;
    IF NOT public.auth_azure_email_verified(COALESCE(v_identity, p_user->'user_metadata', '{}'::jsonb)) THEN
      RETURN 'microsoft_email_unverified';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_signup_refusal(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_signup_refusal(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.auth_hook_before_user_created(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reason text;
BEGIN
  BEGIN
    v_reason := public.auth_signup_refusal(event->'user');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auth_hook_before_user_created failed open: % (%)', SQLERRM, SQLSTATE;
    v_reason := NULL;
  END;

  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', v_reason)
    );
  END IF;

  RETURN '{}'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_hook_before_user_created(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_hook_before_user_created(jsonb) TO supabase_auth_admin, service_role;
