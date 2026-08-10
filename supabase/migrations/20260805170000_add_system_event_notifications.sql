-- ============================================================
-- Generic system-event -> internal email notification pipeline
-- (Phase 1: database layer only)
--
-- system_events is an audit/status log, not a queue anything polls.
-- Rows are written by public.emit_system_event(), which also fires a
-- best-effort pg_net call to the (not-yet-built) system-notify Edge
-- Function. The Edge Function is expected to update processed_at /
-- status once it has attempted delivery.
--
-- Like synthetic_monitor_runs, this table intentionally excludes
-- recipient email addresses, credentials, and message bodies -- only
-- structured, schema-controlled event metadata.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.system_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  event_type text NOT NULL,

  -- Structured event metadata only. Never store recipient email
  -- addresses, credentials, tokens, or message bodies here.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),

  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sent', 'failed'
  )),

  -- Set only when status = 'failed'. A safe, bounded diagnostic string,
  -- never a raw provider response.
  error text,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- Set by the system-notify Edge Function once it has attempted delivery.
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS system_events_event_type_created_at_idx
  ON public.system_events (event_type, created_at DESC);

COMMENT ON TABLE public.system_events IS
  'Audit/status log for the system-event notification pipeline. Not a queue anything polls. Never stores recipient emails, credentials, or message bodies -- only structured event metadata.';
COMMENT ON COLUMN public.system_events.payload IS
  'Structured event metadata only. Never store recipient email addresses, credentials, tokens, or email content.';
COMMENT ON COLUMN public.system_events.error IS
  'Safe, bounded diagnostic string set only when status = failed. Never a raw provider response.';

-- Edge Function (service role) and trusted SECURITY DEFINER functions are
-- the only writers/readers of this table. No browser, customer, or
-- authenticated-user access is required or allowed.
ALTER TABLE public.system_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.system_events FROM anon, authenticated;

-- ============================================================
-- public.emit_system_event(event_type, payload)
--
-- Records an audit row and best-effort notifies the system-notify Edge
-- Function via pg_net, mirroring invoke_synthetic_monitor's style. This
-- function must NEVER raise: it is called from inside the signup trigger,
-- and a notification failure must never block a real user from signing
-- up. The initial INSERT is deliberately outside the exception block so
-- the audit row is always written even if the http_post call fails.
-- ============================================================

CREATE OR REPLACE FUNCTION public.emit_system_event(p_event_type text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_event_id uuid;
BEGIN
  INSERT INTO public.system_events (event_type, payload, status)
  VALUES (p_event_type, COALESCE(p_payload, '{}'::jsonb), 'pending')
  RETURNING id INTO v_event_id;

  BEGIN
    PERFORM net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'system_notify_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-System-Notify-Token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'system_notify_token')
      ),
      body := jsonb_build_object(
        'event_id', v_event_id,
        'event_type', p_event_type,
        'payload', p_payload
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'emit_system_event: notify dispatch failed for event %: %', v_event_id, SQLERRM;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.emit_system_event(text, jsonb) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- public.handle_new_user()
--
-- Same body as 20260524180000_configure_auth_user_provisioning, with one
-- new step added at the end (before RETURN NEW;) to emit a 'user.signup'
-- system event. No other behavior changes.
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
  --    e.g. "jane.doe+work@example.com" → "jane-doe-work"
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

  -- 4. Create default workspace owned by this user
  INSERT INTO public.workspaces (owner_id, slug, display_name, plan)
  VALUES (
    NEW.id,
    v_slug,
    COALESCE(NEW.raw_user_meta_data->>'display_name', SPLIT_PART(NEW.email, '@', 1)),
    'free'
  )
  RETURNING id INTO v_workspace_id;

  -- 5. Add the user as the owner member of the new workspace
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, NEW.id, 'owner');

  -- 6. Emit a system event for the internal notification pipeline.
  PERFORM public.emit_system_event('user.signup', jsonb_build_object(
    'user_id', NEW.id,
    'email', NEW.email,
    'workspace_id', v_workspace_id
  ));

  RETURN NEW;
END;
$$;

-- The trigger itself already exists from the initial schema migration;
-- no need to recreate it — CREATE OR REPLACE FUNCTION is sufficient.
