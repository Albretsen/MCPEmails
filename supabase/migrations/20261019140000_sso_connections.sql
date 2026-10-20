-- ============================================================================
-- SAML SSO data model: sso_connections, sso_domains, and SSO-aware signup
-- ============================================================================
--
-- WHY. A company on the enterprise tier signs its people in through its own
-- identity provider (Microsoft Entra ID first) with SAML. Supabase Auth runs
-- the SAML exchange; we create one Supabase SSO provider per customer through
-- the Management API and keep the mapping here. Our own verified domain table
-- is the source of truth for routing: Supabase's per-provider `domains` list
-- is not used, so a domain routes only after its owner proved it in DNS.
--
-- WHAT A ROW MEANS.
--   sso_connections  "workspace W signs in through Supabase SSO provider P".
--                    status draft -> active -> disabled. Only an active
--                    connection with a provider id routes sign-ins. enforced
--                    means "refuse every non-SSO sign-in for its domains"; the
--                    enforcer is a later Custom Access Token hook, not this
--                    migration.
--   sso_domains      "email domain D belongs to connection C". Routes only
--                    once verified_at is set, which happens after a DNS TXT
--                    record `mcpemails-verification=<verification_token>` is
--                    seen on D.
--
-- DOMAIN SQUATTING. A domain may be PENDING on several connections, so a
-- squatter's unverified claim cannot block the real owner, but it can be
-- VERIFIED on at most one connection (partial unique index below). Only the
-- DNS owner can verify, so a workspace can never route or enforce another
-- company's domain. Consumer mail domains are refused outright (CHECK), from
-- the same list the app uses (apps/web/src/lib/segment/consumer-domains.mjs;
-- apps/web/src/lib/sso/migration-parity.test.ts keeps the two identical).
--
-- WHO WRITES WHAT. A workspace owner or admin may, through PostgREST:
--   - read their workspace's connections and domains,
--   - create a draft connection and rename it or change its default role,
--   - delete a draft connection that has no Supabase provider yet,
--   - add a pending domain and remove a domain.
-- Everything that needs a server-side proof is service-role only: the
-- Supabase provider id (Management API), status and enforced (the admin
-- route checks entitlement and a successful test sign-in), verified_at (the
-- DNS check), and the verification token. Column grants enforce that; RLS
-- policies scope rows to workspaces where auth.uid() is owner or admin.
-- Nothing here writes workspace_members (the team-tier code owns it).
--
-- SIGN-IN LOOKUP. public.sso_provider_for_domain(domain) returns the provider
-- id only for a verified domain on an active connection of a live workspace,
-- and NULL otherwise. It is the only routing read and is service-role only.
--
-- SSO USERS AND SIGNUP. Supabase never links SSO identities: an SSO sign-in
-- is always a NEW auth.users row, with app_metadata.provider = 'sso:<id>' at
-- INSERT, even when a password or Google account with the same email exists.
-- Two consequences fixed here:
--   1. The new-user trigger would give that user a personal workspace. The
--      trigger now skips SSO users (WHEN clause, so handle_new_user() itself
--      is untouched); a second trigger gives them only their public.users
--      row. The SSO sign-in code adds them to the company workspace.
--   2. public.users.email was UNIQUE, so that INSERT would fail with 23505 and
--      abort the whole SAML sign-in for anyone who already has an account.
--      Email is now unique among non-SSO users (unchanged for everyone today)
--      and unique per SSO provider among SSO users, keyed by the new
--      public.users.sso_provider_id. Every current lookup of public.users by
--      email tolerates two rows (invite route: limit(1); Resend webhook: IN).
--
-- SPLIT (2026-10-20). This file is the purely additive half: new functions,
-- the two new tables with their RLS, the sign-in lookup, and one new nullable
-- column on public.users. It changes nothing for existing users and was
-- applied to production on its own. The half that changes existing signup
-- objects (the public.users email uniqueness swap and the WHEN clause on
-- on_auth_user_created) is 20261019140500_sso_user_signup_triggers.sql. It is
-- only needed once an SSO provider exists, and the owner applies it before
-- the first SAML sign-in.
--
-- RELEASE ORDER. Apply before any code that creates an SSO provider. Nothing
-- reads these tables yet, so applying early is harmless.
--
-- RE-RUNNABLE. IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS
-- throughout, so it can be applied with `db query -f` and then recorded with
-- `migration repair`.
-- ============================================================================


-- ── 1. Consumer mail domains ─────────────────────────────────────────────────
-- Mirrors isConsumerEmailDomain() in apps/web/src/lib/segment/consumer-domains.mjs:
-- an exact domain, a subdomain of one, or a brand family under any TLD or
-- ccTLD (`yahoo.in`, `hotmail.co.jp`). Input must already be normalised.
CREATE OR REPLACE FUNCTION public.sso_is_consumer_domain(p_domain text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  WITH consumer(domains) AS (
    SELECT ARRAY[
      'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
      'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'yahoo.ca', 'yahoo.com.br',
      'yahoo.com.au', 'ymail.com', 'rocketmail.com', 'myyahoo.com', 'icloud.com',
      'me.com', 'mac.com', 'outlook.com', 'outlook.es', 'outlook.fr', 'outlook.de',
      'outlook.com.br', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.es',
      'hotmail.it', 'hotmail.de', 'live.com', 'live.co.uk', 'live.nl', 'msn.com',
      'passport.com', 'aol.com', 'aim.com', 'proton.me', 'protonmail.com',
      'protonmail.ch', 'pm.me', 'tutanota.com', 'tutanota.de', 'tutamail.com',
      'tuta.io', 'tuta.com', 'keemail.me', 'mailfence.com', 'posteo.de',
      'posteo.net', 'runbox.com', 'mailbox.org', 'hushmail.com', 'startmail.com',
      'disroot.org', 'riseup.net', 'yandex.com', 'yandex.ru', 'ya.ru', 'mail.ru',
      'bk.ru', 'inbox.ru', 'list.ru', 'rambler.ru', 'gmx.com', 'gmx.de', 'gmx.net',
      'gmx.co.uk', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de', 'freenet.de',
      'arcor.de', 'vodafone.de', 'mail.de', 'bluewin.ch', 'aon.at', 'zoho.com',
      'zohomail.com', 'zohomail.eu', 'fastmail.com', 'fastmail.fm', 'hey.com',
      'duck.com', 'migadu.com', 'mail.com', 'email.com', 'usa.com', 'inbox.com',
      'inbox.lv', 'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net',
      'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', '139.com', '189.cn',
      'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com',
      'rediffmail.com', 'docomo.ne.jp', 'ezweb.ne.jp', 'softbank.ne.jp',
      'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net',
      'charter.net', 'spectrum.net', 'bellsouth.net', 'earthlink.net',
      'optonline.net', 'optimum.net', 'roadrunner.com', 'rr.com', 'twc.com',
      'frontier.com', 'frontiernet.net', 'windstream.net', 'centurylink.net',
      'juno.com', 'netzero.net', 'netzero.com', 'mindspring.com', 'pacbell.net',
      'ameritech.net', 'swbell.net', 'suddenlink.net', 'mediacombb.net',
      'rogers.com', 'shaw.ca', 'bell.net', 'sympatico.ca', 'telus.net',
      'videotron.ca', 'cogeco.ca', 'eastlink.ca', 'sasktel.net', 'mts.net',
      'telusplanet.net', 'ns.sympatico.ca', 'btinternet.com', 'btopenworld.com',
      'sky.com', 'virginmedia.com', 'talktalk.net', 'ntlworld.com',
      'blueyonder.co.uk', 'tiscali.co.uk', 'plus.net', 'eircom.net', 'orange.fr',
      'free.fr', 'laposte.net', 'wanadoo.fr', 'sfr.fr', 'bbox.fr', 'neuf.fr',
      'numericable.fr', 'aliceadsl.fr', 'libero.it', 'virgilio.it', 'alice.it',
      'tin.it', 'tiscali.it', 'fastwebnet.it', 'email.it', 'terra.com',
      'terra.com.br', 'telefonica.net', 'movistar.es', 'sapo.pt', 'uol.com.br',
      'bol.com.br', 'ig.com.br', 'globo.com', 'globomail.com', 'prodigy.net.mx',
      'online.no', 'hotmail.no', 'live.no', 'telenor.no', 'getmail.no', 'altibox.no',
      'lyse.net', 'telia.com', 'comhem.se', 'bredband.net', 'spray.se', 'mail.dk',
      'tdcadsl.dk', 'kolumbus.fi', 'elisanet.fi', 'luukku.com', 'ziggo.nl',
      'kpnmail.nl', 'kpnplanet.nl', 'xs4all.nl', 'home.nl', 'planet.nl', 'hetnet.nl',
      'upcmail.nl', 'casema.nl', 'telenet.be', 'skynet.be', 'proximus.be',
      'seznam.cz', 'email.cz', 'centrum.cz', 'wp.pl', 'onet.pl', 'o2.pl',
      'interia.pl', 'op.pl', 'abv.bg', 'freemail.hu', 'citromail.hu', 'ukr.net',
      'i.ua', 'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'iinet.net.au',
      'tpg.com.au', 'xtra.co.nz', 'yopmail.com', 'mailinator.com',
      'guerrillamail.com', 'sharklasers.com', '10minutemail.com', 'temp-mail.org'
    ]::text[]
  )
  SELECT p_domain = ANY (consumer.domains)
      OR EXISTS (SELECT 1 FROM unnest(consumer.domains) AS d WHERE p_domain LIKE '%.' || d)
      OR p_domain ~ '^(yahoo|ymail|hotmail|outlook|live|msn|gmx|yandex|aol|googlemail|zohomail|proton|protonmail)\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?|(co|com|net|org|ne|or)\.[a-z0-9]{2})$'
    FROM consumer;
$$;

REVOKE ALL ON FUNCTION public.sso_is_consumer_domain(text) FROM PUBLIC, anon, authenticated;
-- Pure; granted so the CHECK below evaluates for any writer.
GRANT EXECUTE ON FUNCTION public.sso_is_consumer_domain(text) TO authenticated, service_role;


-- ── 2. Which workspaces may the caller manage SSO for ────────────────────────
-- Owner or admin of a live workspace. SECURITY DEFINER so the policies below
-- do not depend on the caller's own read access to workspace_members.
CREATE OR REPLACE FUNCTION public.sso_admin_workspace_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ARRAY(
    SELECT wm.workspace_id
    FROM   public.workspace_members wm
    JOIN   public.workspaces w ON w.id = wm.workspace_id
    WHERE  wm.user_id = auth.uid()
    AND    wm.role IN ('owner', 'admin')
    AND    w.deleted_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION public.sso_admin_workspace_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sso_admin_workspace_ids() TO authenticated, service_role;


-- ── 3. sso_connections ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sso_connections (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- The Supabase Auth SSO provider (auth.sso_providers.id), created through
  -- the Management API. NULL while the admin has not pasted metadata yet.
  supabase_sso_provider_id  uuid UNIQUE,
  display_name              text NOT NULL
                              CHECK (length(btrim(display_name)) BETWEEN 1 AND 100
                                     AND display_name !~ '[[:cntrl:]<>]'),
  status                    text NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'active', 'disabled')),
  enforced                  boolean NOT NULL DEFAULT false,
  -- Role given to a user who joins the workspace through this connection.
  default_role              text NOT NULL DEFAULT 'member'
                              CHECK (default_role IN ('member', 'viewer')),
  created_by                uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- Only a connection with a real provider can route sign-ins.
  CONSTRAINT sso_connections_active_has_provider
    CHECK (status <> 'active' OR supabase_sso_provider_id IS NOT NULL),
  -- Enforcing a connection that cannot sign anyone in would lock the domain out.
  CONSTRAINT sso_connections_enforced_only_when_active
    CHECK (NOT enforced OR status = 'active')
);

CREATE INDEX IF NOT EXISTS sso_connections_workspace_idx
  ON public.sso_connections (workspace_id);

-- created_by is the caller, workspace_id never moves, updated_at is kept.
CREATE OR REPLACE FUNCTION public.sso_connections_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL THEN
      NEW.created_by := auth.uid();
    END IF;
  ELSE
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'sso_connections.workspace_id cannot change' USING ERRCODE = '23514';
    END IF;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.display_name := btrim(NEW.display_name);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sso_connections_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sso_connections_before_write ON public.sso_connections;
CREATE TRIGGER sso_connections_before_write
  BEFORE INSERT OR UPDATE ON public.sso_connections
  FOR EACH ROW EXECUTE FUNCTION public.sso_connections_before_write();


-- ── 4. sso_domains ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sso_domains (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id       uuid NOT NULL REFERENCES public.sso_connections(id) ON DELETE CASCADE,
  -- Always the connection's workspace: set by the trigger below, never trusted
  -- from the writer. Denormalised so RLS needs no join.
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Lower case, no trailing dot, at least two labels, not an IP, not consumer.
  domain              text NOT NULL
                        CHECK (length(domain) <= 253
                               AND domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
                               AND domain !~ '\.[0-9]+$'),
  -- Published by the customer as TXT `mcpemails-verification=<token>`.
  -- 128 random bits; not a secret (it goes into public DNS), only unguessable.
  verification_token  text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '')
                        CHECK (verification_token ~ '^[a-z0-9]{32}$'),
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sso_domains_not_consumer CHECK (NOT public.sso_is_consumer_domain(domain))
);

-- One row per domain per connection.
CREATE UNIQUE INDEX IF NOT EXISTS sso_domains_connection_domain_key
  ON public.sso_domains (connection_id, domain);

-- A domain is verified on at most one connection, across every workspace.
-- This is also the guarantee that sso_provider_for_domain() finds one row.
CREATE UNIQUE INDEX IF NOT EXISTS sso_domains_verified_domain_key
  ON public.sso_domains (domain) WHERE verified_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS sso_domains_workspace_idx
  ON public.sso_domains (workspace_id);

-- Normalises the domain, pins workspace_id to the connection's, keeps the
-- domain and its connection immutable, and drops verification when the token
-- is rotated.
CREATE OR REPLACE FUNCTION public.sso_domains_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.domain := rtrim(lower(btrim(NEW.domain)), '.');
  ELSE
    IF NEW.domain IS DISTINCT FROM OLD.domain
       OR NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN
      RAISE EXCEPTION 'sso_domains.domain and connection_id cannot change; delete and re-add'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.verification_token IS DISTINCT FROM OLD.verification_token
       AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at THEN
      NEW.verified_at := NULL;
    END IF;
    NEW.created_at := OLD.created_at;
  END IF;

  SELECT c.workspace_id INTO NEW.workspace_id
    FROM public.sso_connections c
   WHERE c.id = NEW.connection_id;
  IF NEW.workspace_id IS NULL THEN
    RAISE EXCEPTION 'sso connection % not found', NEW.connection_id USING ERRCODE = '23503';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sso_domains_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sso_domains_before_write ON public.sso_domains;
CREATE TRIGGER sso_domains_before_write
  BEFORE INSERT OR UPDATE ON public.sso_domains
  FOR EACH ROW EXECUTE FUNCTION public.sso_domains_before_write();


-- ── 5. Grants and RLS ────────────────────────────────────────────────────────
ALTER TABLE public.sso_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sso_domains ENABLE ROW LEVEL SECURITY;

-- REVOKE ALL also removes TRUNCATE, REFERENCES and TRIGGER from the API roles.
REVOKE ALL ON TABLE public.sso_connections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sso_domains FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.sso_connections TO authenticated;
GRANT INSERT (workspace_id, display_name, default_role) ON public.sso_connections TO authenticated;
GRANT UPDATE (display_name, default_role) ON public.sso_connections TO authenticated;
GRANT DELETE ON public.sso_connections TO authenticated;

GRANT SELECT ON public.sso_domains TO authenticated;
GRANT INSERT (connection_id, domain) ON public.sso_domains TO authenticated;
GRANT DELETE ON public.sso_domains TO authenticated;

GRANT ALL ON TABLE public.sso_connections TO service_role;
GRANT ALL ON TABLE public.sso_domains TO service_role;

DROP POLICY IF EXISTS "sso_connections_select_admins" ON public.sso_connections;
CREATE POLICY "sso_connections_select_admins"
  ON public.sso_connections FOR SELECT
  TO authenticated
  USING (workspace_id = ANY (public.sso_admin_workspace_ids()));

DROP POLICY IF EXISTS "sso_connections_insert_admins" ON public.sso_connections;
CREATE POLICY "sso_connections_insert_admins"
  ON public.sso_connections FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = ANY (public.sso_admin_workspace_ids()));

DROP POLICY IF EXISTS "sso_connections_update_admins" ON public.sso_connections;
CREATE POLICY "sso_connections_update_admins"
  ON public.sso_connections FOR UPDATE
  TO authenticated
  USING (workspace_id = ANY (public.sso_admin_workspace_ids()))
  WITH CHECK (workspace_id = ANY (public.sso_admin_workspace_ids()));

-- A provider that exists in Supabase is removed by the server, which deletes
-- it there first; a browser delete would orphan it.
DROP POLICY IF EXISTS "sso_connections_delete_admins_draft" ON public.sso_connections;
CREATE POLICY "sso_connections_delete_admins_draft"
  ON public.sso_connections FOR DELETE
  TO authenticated
  USING (workspace_id = ANY (public.sso_admin_workspace_ids())
         AND status = 'draft'
         AND supabase_sso_provider_id IS NULL);

DROP POLICY IF EXISTS "sso_domains_select_admins" ON public.sso_domains;
CREATE POLICY "sso_domains_select_admins"
  ON public.sso_domains FOR SELECT
  TO authenticated
  USING (workspace_id = ANY (public.sso_admin_workspace_ids()));

DROP POLICY IF EXISTS "sso_domains_insert_admins" ON public.sso_domains;
CREATE POLICY "sso_domains_insert_admins"
  ON public.sso_domains FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = ANY (public.sso_admin_workspace_ids()));

DROP POLICY IF EXISTS "sso_domains_delete_admins" ON public.sso_domains;
CREATE POLICY "sso_domains_delete_admins"
  ON public.sso_domains FOR DELETE
  TO authenticated
  USING (workspace_id = ANY (public.sso_admin_workspace_ids()));


-- ── 6. Sign-in lookup ────────────────────────────────────────────────────────
-- Provider id for a verified domain on an active connection of a live
-- workspace, else NULL. Takes a bare domain; normalises it the same way the
-- domain trigger does. Service role only: the sign-in route runs server-side.
CREATE OR REPLACE FUNCTION public.sso_provider_for_domain(p_domain text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.supabase_sso_provider_id
  FROM   public.sso_domains d
  JOIN   public.sso_connections c ON c.id = d.connection_id
  JOIN   public.workspaces w ON w.id = c.workspace_id
  WHERE  d.domain = rtrim(lower(btrim(p_domain)), '.')
  AND    d.verified_at IS NOT NULL
  AND    c.status = 'active'
  AND    c.supabase_sso_provider_id IS NOT NULL
  AND    w.deleted_at IS NULL
  LIMIT  1;
$$;

REVOKE ALL ON FUNCTION public.sso_provider_for_domain(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sso_provider_for_domain(text) TO service_role;


-- ── 7. public.users: room for an SSO user with an existing account's email ───
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS sso_provider_id uuid;

COMMENT ON COLUMN public.users.sso_provider_id IS
  'Supabase SSO provider this user signs in through (auth app_metadata.provider '
  '= ''sso:<id>''); NULL for every other user. Set once, by on_auth_sso_user_created.';



COMMENT ON TABLE public.sso_connections IS
  'One SAML SSO connection per row: a workspace and its Supabase SSO provider. '
  'Owner/admin may create drafts and edit display_name/default_role; provider id, '
  'status and enforced are written only by service-role code.';
COMMENT ON TABLE public.sso_domains IS
  'Email domains of an SSO connection. Routes sign-ins only when verified_at is set '
  '(DNS TXT mcpemails-verification=<verification_token>). Verified on at most one '
  'connection. Consumer mail domains are refused.';
