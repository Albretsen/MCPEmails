-- ============================================================
-- Attribute signups that land on the persona and comparison pages
--
-- WHY. A signup whose first page was /for/business, /for/founders or
-- /best-email-mcp-servers was stored with acquisition_landing_path = '/other',
-- so nobody could tell whether those pages produce customers.
-- safeLandingPath() in apps/web/src/lib/acquisition-context.mjs now passes
-- these route shapes through, in addition to everything it already did:
--
--   /for/<slug>                    (persona pages: business, founders)
--   /connect                       (the hub; /connect/<slug> was already kept)
--   /about
--   /changelog
--   /best-email-mcp-servers
--   /email-mcp-servers-compared
--
-- The privacy rule is unchanged: route shape only, lowercase [a-z0-9-] slugs,
-- no query string, fragment, locale prefix or free text.
--
-- NO BACKFILL, AND NONE IS POSSIBLE. Existing rows that hold '/other' stay
-- '/other': the page those signups actually landed on was discarded in the
-- browser and never reached the database. The new paths only appear on
-- workspaces created after BOTH this migration and the web deploy. A visitor
-- whose first touch was captured before the deploy also keeps '/other',
-- because first touch is stored in their browser and is never overwritten.
--
-- RELEASE ORDER: APPLY THIS BEFORE THE WEB CODE DEPLOYS. With the new web
-- code against the old database, a Google or GitHub signup from one of these
-- pages fails the old CHECK, and /auth/callback writes all eight acquisition
-- columns in ONE UPDATE, so that workspace would lose its source, referrer and
-- UTM fields as well, silently (the signup itself still succeeds). A password
-- signup would only lose the path (the old trigger NULLs it). Applying this
-- migration first is harmless: the old web code emits a subset of the new
-- pattern.
--
-- RE-RUNNABLE. Every statement is DROP IF EXISTS / ADD or CREATE OR REPLACE,
-- so it can be applied by hand with `db query -f` and then recorded with
-- `migration repair`.
--
-- THE CATEGORY COLUMN IS NOT TOUCHED. acquisition_landing keeps
-- home | blog | provider | docs | pricing | other, and these pages stay
-- `other` there. The path column is what answers the question.
--
-- WHY THE FUNCTION BELOW IS COPIED WHOLE. handle_new_user() has no ALTER, and
-- a retyped body once silently killed attribution for 168 signups. The body
-- is a verbatim copy of 20260929190000_acquisition_source_google_ads.sql, the
-- newest definition in the migrations on every branch as of 2026-10-04, with
-- ONLY the v_landing_path pattern changed. A test in
-- apps/web/src/lib/acquisition-context.test.mjs compares the two bodies line
-- by line, and compares this pattern with what the JS emits.
-- ============================================================

-- 1. Re-pin the CHECK constraint. Its only earlier definition is in
--    20260805090000_expand_privacy_safe_acquisition_attribution.sql; no later
--    migration redefined it. Every existing row matches the old pattern, which
--    is a subset of this one, so the re-add validates cleanly.
ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_landing_path_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_acquisition_landing_path_check CHECK (
    acquisition_landing_path IS NULL OR (
      length(acquisition_landing_path) <= 160
      AND acquisition_landing_path ~ '^/(|other|blog(/[a-z0-9-]+)?|connect(/[a-z0-9-]+)?|docs(/[a-z0-9-]+)*|for/[a-z0-9-]+|pricing|security|self-hosting|native-connectors-vs-mcp|about|changelog|best-email-mcp-servers|email-mcp-servers-compared)$'
    )
  );

-- 2. The trigger keeps its own copy of the pattern, because a value it does
--    not recognise has to become NULL rather than fail the signup. Widening
--    the constraint without widening this would leave every new path passing
--    the CHECK and still landing as NULL on password signups.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
  v_slug         text;
  v_base_slug    text;
  v_suffix       integer := 0;
  v_source       text := NEW.raw_user_meta_data->>'acquisition_source';
  v_landing      text := NEW.raw_user_meta_data->>'acquisition_landing';
  v_landing_path text := NEW.raw_user_meta_data->>'acquisition_landing_path';
  v_locale       text := NEW.raw_user_meta_data->>'acquisition_locale';
  v_referrer     text := NEW.raw_user_meta_data->>'acquisition_referrer';
  v_utm_source   text := NEW.raw_user_meta_data->>'acquisition_utm_source';
  v_utm_medium   text := NEW.raw_user_meta_data->>'acquisition_utm_medium';
  v_utm_campaign text := NEW.raw_user_meta_data->>'acquisition_utm_campaign';
BEGIN
  -- 1. Insert into public.users (mirrors auth.users)
  INSERT INTO public.users (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', SPLIT_PART(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;

  -- 2. Generate a URL-safe slug from the email local part
  --    e.g. "jane.doe+work@example.com" -> "jane-doe-work"
  v_base_slug := LOWER(
    REGEXP_REPLACE(
      REGEXP_REPLACE(SPLIT_PART(NEW.email, '@', 1), '[^a-zA-Z0-9]+', '-', 'g'),
      '^-+|-+$', '', 'g'
    )
  );
  v_slug := v_base_slug;

  -- 3. Ensure slug uniqueness with a numeric suffix if needed
  WHILE EXISTS (SELECT 1 FROM public.workspaces WHERE slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug   := v_base_slug || '-' || v_suffix;
  END LOOP;

  -- 4. Coarse first-touch attribution. Anything outside the allowlist is
  --    discarded rather than persisted, so no raw UTM value, referrer URL or
  --    identifier can reach the table through this path.
  IF v_source NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'other') THEN v_source := NULL; END IF;
  IF v_landing NOT IN ('home', 'blog', 'provider', 'docs', 'pricing', 'other') THEN v_landing := NULL; END IF;
  IF v_landing_path !~ '^/(|other|blog(/[a-z0-9-]+)?|connect(/[a-z0-9-]+)?|docs(/[a-z0-9-]+)*|for/[a-z0-9-]+|pricing|security|self-hosting|native-connectors-vs-mcp|about|changelog|best-email-mcp-servers|email-mcp-servers-compared)$' THEN v_landing_path := NULL; END IF;
  IF v_locale NOT IN ('en', 'nb', 'es', 'fr', 'zh') THEN v_locale := NULL; END IF;
  IF v_referrer NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'other') THEN v_referrer := NULL; END IF;
  IF v_utm_source NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'other') THEN v_utm_source := NULL; END IF;
  IF v_utm_medium NOT IN ('organic', 'paid_search', 'social', 'email', 'referral', 'affiliate', 'display', 'other') THEN v_utm_medium := NULL; END IF;
  IF v_utm_campaign NOT IN ('launch', 'newsletter', 'content', 'product', 'partner', 'community', 'other') THEN v_utm_campaign := NULL; END IF;

  -- 5. Create default workspace owned by this user
  INSERT INTO public.workspaces (
    owner_id, slug, display_name, plan,
    acquisition_source, acquisition_landing, acquisition_landing_path,
    acquisition_locale, acquisition_referrer,
    acquisition_utm_source, acquisition_utm_medium, acquisition_utm_campaign
  )
  VALUES (
    NEW.id,
    v_slug,
    COALESCE(NEW.raw_user_meta_data->>'display_name', SPLIT_PART(NEW.email, '@', 1)),
    'free',
    v_source, v_landing, v_landing_path,
    v_locale, v_referrer,
    v_utm_source, v_utm_medium, v_utm_campaign
  )
  RETURNING id INTO v_workspace_id;

  -- 6. Add the user as the owner member of the new workspace
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, NEW.id, 'owner');

  -- 7. Emit a system event for the internal notification pipeline.
  PERFORM public.emit_system_event('user.signup', jsonb_build_object(
    'user_id', NEW.id,
    'email', NEW.email,
    'workspace_id', v_workspace_id
  ));

  RETURN NEW;
END;
$$;
