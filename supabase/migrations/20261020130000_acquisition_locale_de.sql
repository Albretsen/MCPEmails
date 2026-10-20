-- ============================================================
-- Accept 'de' as a signup acquisition locale
--
-- WHY. The marketing site gains a German locale (/de). Signups that start on a
-- /de page carry acquisition_locale = 'de', which the current CHECK rejects
-- and the signup trigger NULLs.
--
-- WHAT. Re-pin workspaces_acquisition_locale_check with 'de' added, and
-- redefine handle_new_user() with the same list.
--
-- RELEASE ORDER: APPLY THIS BEFORE THE WEB CODE DEPLOYS. With the new web
-- code against the old database, a Google or GitHub signup from a /de page
-- fails the old CHECK, and /auth/callback writes all the acquisition columns
-- in ONE UPDATE, so that workspace loses its whole attribution silently. A
-- password signup would have the locale NULLed by the old trigger. Applying
-- this first is harmless: the old web code never emits 'de'.
--
-- RE-RUNNABLE. DROP IF EXISTS / ADD and CREATE OR REPLACE only, so it can be
-- applied by hand with `db query -f` and then recorded with `migration repair`.
--
-- WHY THE FUNCTION BELOW IS COPIED WHOLE. handle_new_user() has no ALTER, and
-- a retyped body once silently killed attribution for 168 signups. The body
-- is a verbatim copy of 20261019130000_directory_listing_attribution.sql, the
-- newest definition as of 2026-10-20, with ONLY the v_locale allowlist line
-- changed. apps/web/src/lib/acquisition-context.test.mjs checks both.
-- ============================================================

-- 1. Re-pin the locale CHECK. Every existing row holds a value from the old
--    list, a subset of the new one, so the re-add validates.
ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_locale_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_acquisition_locale_check
    CHECK (acquisition_locale IS NULL OR acquisition_locale IN ('en', 'nb', 'es', 'fr', 'zh', 'de'));

-- 2. The trigger keeps its own copy of the list, because a value it does not
--    recognise has to become NULL rather than fail the signup.

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
  IF v_source NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'npm', 'mcp_registry', 'docker', 'github_punkpeye', 'github_tensorblock', 'github_bestof', 'claude_directory', 'chatgpt_directory', 'cursor_directory', 'other') THEN v_source := NULL; END IF;
  IF v_landing NOT IN ('home', 'blog', 'provider', 'docs', 'pricing', 'other') THEN v_landing := NULL; END IF;
  IF v_landing_path !~ '^/(|other|blog(/[a-z0-9-]+)?|connect(/[a-z0-9-]+)?|docs(/[a-z0-9-]+)*|for/[a-z0-9-]+|pricing|security|self-hosting|native-connectors-vs-mcp|about|changelog|best-email-mcp-servers|email-mcp-servers-compared)$' THEN v_landing_path := NULL; END IF;
  IF v_locale NOT IN ('en', 'nb', 'es', 'fr', 'zh', 'de') THEN v_locale := NULL; END IF;
  IF v_referrer NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'npm', 'mcp_registry', 'docker', 'github_punkpeye', 'github_tensorblock', 'github_bestof', 'claude_directory', 'chatgpt_directory', 'cursor_directory', 'other') THEN v_referrer := NULL; END IF;
  IF v_utm_source NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'google_ads', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'npm', 'mcp_registry', 'docker', 'github_punkpeye', 'github_tensorblock', 'github_bestof', 'claude_directory', 'chatgpt_directory', 'cursor_directory', 'other') THEN v_utm_source := NULL; END IF;
  IF v_utm_medium NOT IN ('organic', 'paid_search', 'social', 'email', 'referral', 'affiliate', 'display', 'directory', 'other') THEN v_utm_medium := NULL; END IF;
  IF v_utm_campaign NOT IN ('launch', 'newsletter', 'content', 'product', 'partner', 'community', 'listing', 'other') THEN v_utm_campaign := NULL; END IF;

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
