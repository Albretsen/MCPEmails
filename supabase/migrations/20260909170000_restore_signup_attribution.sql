-- ============================================================
-- Restore acquisition attribution on the email/password signup path
--
-- WHAT BROKE
-- ----------
-- 20260805090000_expand_privacy_safe_acquisition_attribution.sql taught
-- handle_new_user() to copy the eight allowlisted acquisition categories out
-- of raw_user_meta_data onto the new workspace row. Eight hours later,
-- 20260805170000_add_system_event_notifications.sql needed to add a single
-- emit_system_event() call to the same trigger and wrote its CREATE OR REPLACE
-- from the PRE-attribution copy of the body. Its INSERT INTO public.workspaces
-- lists only (owner_id, slug, display_name, plan). Nothing failed, nothing
-- warned: attribution simply stopped being written.
--
-- OAuth was unaffected, because app/auth/callback/route.ts stamps the
-- workspace with its own UPDATE after the code exchange. So the damage is
-- exactly one signup path, and it is total on that path:
--
--   last attributed email/password signup   2026-08-05 14:58 UTC
--   email/password signups since            168, of which 0 attributed
--   post-2026-08-31 cohort by provider      google 0% null, github 0% null,
--                                           email 100% null
--
-- WHY THIS IS RECOVERABLE
-- -----------------------
-- The categories were never lost. SignupApp.jsx has been sending them in
-- signUp's options.data the whole time, so they are sitting in
-- auth.users.raw_user_meta_data for every affected account. Only the copy onto
-- workspaces was dropped. This migration restores the trigger and then
-- backfills from that metadata, which is the real captured first touch and not
-- an inference. Accounts that predate attribution have no metadata to read and
-- stay NULL forever.
--
-- Both halves re-apply the same allowlist validation as the original, so a
-- value that has since fallen out of a CHECK constraint lands as NULL rather
-- than failing the write.
-- ============================================================

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
  IF v_source NOT IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other') THEN v_source := NULL; END IF;
  IF v_landing NOT IN ('home', 'blog', 'provider', 'docs', 'pricing', 'other') THEN v_landing := NULL; END IF;
  IF v_landing_path !~ '^/(|other|blog(/[a-z0-9-]+)?|connect/[a-z0-9-]+|docs(/[a-z0-9-]+)*|pricing|security|self-hosting|native-connectors-vs-mcp)$' THEN v_landing_path := NULL; END IF;
  IF v_locale NOT IN ('en', 'nb', 'es', 'fr', 'zh') THEN v_locale := NULL; END IF;
  IF v_referrer NOT IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other') THEN v_referrer := NULL; END IF;
  IF v_utm_source NOT IN ('direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other') THEN v_utm_source := NULL; END IF;
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

-- ------------------------------------------------------------
-- Backfill the workspaces the broken trigger left blank.
--
-- First touch only: the WHERE clause takes rows whose acquisition_source is
-- still NULL, so an already-attributed workspace can never be rewritten. The
-- metadata is immutable signup-time data, so this is idempotent.
-- ------------------------------------------------------------
UPDATE public.workspaces w
SET
  acquisition_source =
    CASE WHEN u.raw_user_meta_data->>'acquisition_source' IN ('direct','organic_google','reddit','github','smithery','glama','cursor','other')
         THEN u.raw_user_meta_data->>'acquisition_source' END,
  acquisition_landing =
    CASE WHEN u.raw_user_meta_data->>'acquisition_landing' IN ('home','blog','provider','docs','pricing','other')
         THEN u.raw_user_meta_data->>'acquisition_landing' END,
  acquisition_landing_path =
    CASE WHEN u.raw_user_meta_data->>'acquisition_landing_path' ~ '^/(|other|blog(/[a-z0-9-]+)?|connect/[a-z0-9-]+|docs(/[a-z0-9-]+)*|pricing|security|self-hosting|native-connectors-vs-mcp)$'
         THEN u.raw_user_meta_data->>'acquisition_landing_path' END,
  acquisition_locale =
    CASE WHEN u.raw_user_meta_data->>'acquisition_locale' IN ('en','nb','es','fr','zh')
         THEN u.raw_user_meta_data->>'acquisition_locale' END,
  acquisition_referrer =
    CASE WHEN u.raw_user_meta_data->>'acquisition_referrer' IN ('direct','organic_google','reddit','github','smithery','glama','cursor','other')
         THEN u.raw_user_meta_data->>'acquisition_referrer' END,
  acquisition_utm_source =
    CASE WHEN u.raw_user_meta_data->>'acquisition_utm_source' IN ('direct','organic_google','reddit','github','smithery','glama','cursor','other')
         THEN u.raw_user_meta_data->>'acquisition_utm_source' END,
  acquisition_utm_medium =
    CASE WHEN u.raw_user_meta_data->>'acquisition_utm_medium' IN ('organic','paid_search','social','email','referral','affiliate','display','other')
         THEN u.raw_user_meta_data->>'acquisition_utm_medium' END,
  acquisition_utm_campaign =
    CASE WHEN u.raw_user_meta_data->>'acquisition_utm_campaign' IN ('launch','newsletter','content','product','partner','community','other')
         THEN u.raw_user_meta_data->>'acquisition_utm_campaign' END
FROM auth.users u
WHERE u.id = w.owner_id
  AND w.acquisition_source IS NULL
  AND u.raw_user_meta_data->>'acquisition_source' IS NOT NULL;
