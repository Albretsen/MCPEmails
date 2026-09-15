-- ============================================================
-- Widen the acquisition source allowlist
--
-- WHY. The allowlist named seven sources: direct, organic_google, reddit,
-- github, smithery, glama and cursor. Every other referrer became `other`,
-- and since directory listings are this product's main acquisition channel,
-- `other` swallowed exactly the rows worth reading. This adds the AI clients,
-- the MCP directories we are actually listed on, the two remaining search
-- engines and the social sources, and teaches cursor.directory to count as
-- `cursor` (only cursor.com did before, which is not where the listing lives).
--
-- The privacy rule is unchanged. Only these coarse categories are ever
-- persisted: no raw host, URL, referrer string or UTM value reaches a column.
--
-- WHY THE LIST IS DUPLICATED IN SQL AND IN JS. The categories are produced in
-- the browser by apps/web/src/lib/acquisition-context.mjs and validated twice
-- more on the way in: by these three CHECK constraints, and by the signup
-- trigger's own IN-lists, which NULL anything they do not recognise. Postgres
-- cannot import the JS set and the client cannot query the constraint, so the
-- list genuinely has to exist in both places. What keeps them honest is the
-- drift test in apps/web/src/lib/acquisition-context.test.mjs: it reads THIS
-- FILE off disk and asserts the SQL allowlists and the JS `SOURCES` set have
-- exactly the same members. If you edit one list here, that test fails until
-- the other side matches.
--
-- WHY THE FUNCTION BELOW IS COPIED WHOLE. handle_new_user() has no ALTER: the
-- only way to change one line is CREATE OR REPLACE with the entire body. On
-- 2026-08-05 that body was retyped from a stale copy, its workspaces INSERT
-- lost the acquisition columns, and attribution silently died for 168 email
-- signups before anybody noticed. This body is a verbatim copy of the one in
-- 20260909170000_restore_signup_attribution.sql, which is the live definition
-- (no later migration touches the function), with ONLY the three allowlists
-- changed. Diff it line by line before you change anything else in it.
-- ============================================================

-- 1. Re-pin the three CHECK constraints to the widened list. Existing rows all
--    hold values from the old list, which is a subset, so nothing is rewritten
--    and the re-add validates cleanly.
ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_source_check,
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_referrer_check,
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_utm_source_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_acquisition_source_check
    CHECK (acquisition_source IS NULL OR acquisition_source IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'other')),
  ADD CONSTRAINT workspaces_acquisition_referrer_check
    CHECK (acquisition_referrer IS NULL OR acquisition_referrer IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'other')),
  ADD CONSTRAINT workspaces_acquisition_utm_source_check
    CHECK (acquisition_utm_source IS NULL OR acquisition_utm_source IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'other'));

-- 2. The trigger keeps its own copy of the allowlist, because a value it does
--    not recognise has to become NULL rather than fail the signup. Widening
--    the constraints without widening this would leave every new source
--    passing the CHECK and still landing as NULL.

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
  IF v_source NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'other') THEN v_source := NULL; END IF;
  IF v_landing NOT IN ('home', 'blog', 'provider', 'docs', 'pricing', 'other') THEN v_landing := NULL; END IF;
  IF v_landing_path !~ '^/(|other|blog(/[a-z0-9-]+)?|connect/[a-z0-9-]+|docs(/[a-z0-9-]+)*|pricing|security|self-hosting|native-connectors-vs-mcp)$' THEN v_landing_path := NULL; END IF;
  IF v_locale NOT IN ('en', 'nb', 'es', 'fr', 'zh') THEN v_locale := NULL; END IF;
  IF v_referrer NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'other') THEN v_referrer := NULL; END IF;
  IF v_utm_source NOT IN ('direct', 'organic_google', 'organic_bing', 'organic_duckduckgo', 'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github', 'claude', 'chatgpt', 'perplexity', 'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp', 'other') THEN v_utm_source := NULL; END IF;
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
