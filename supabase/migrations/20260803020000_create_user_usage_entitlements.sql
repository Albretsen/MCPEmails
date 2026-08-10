-- Phase 2: user-level protected usage entitlements.
CREATE TABLE public.user_usage_entitlements (
  user_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('standard', 'comped_scale')),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reason      text NOT NULL,
  source      text NOT NULL CHECK (source IN ('migration', 'support', 'promotion')),
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_usage_entitlement_audit (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid NOT NULL,
  operation      text NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  record         jsonb NOT NULL
);

CREATE OR REPLACE FUNCTION public.audit_user_usage_entitlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.user_usage_entitlement_audit (user_id, operation, record)
    VALUES (OLD.user_id, 'delete', to_jsonb(OLD));
    RETURN OLD;
  END IF;
  INSERT INTO public.user_usage_entitlement_audit (user_id, operation, record)
  VALUES (NEW.user_id, lower(TG_OP), to_jsonb(NEW));
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_usage_entitlements_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.user_usage_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.audit_user_usage_entitlement();

CREATE TRIGGER user_usage_entitlements_updated_at
  BEFORE UPDATE ON public.user_usage_entitlements
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

ALTER TABLE public.user_usage_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_usage_entitlement_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_usage_entitlements_select_own"
  ON public.user_usage_entitlements FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- Entitlement writes and audit reads are service/admin-only.

-- Existing launch-era unlimited workspaces become permanent, user-level Scale
-- grants. The owner is the subject, so protection follows every workspace.
INSERT INTO public.user_usage_entitlements (user_id, kind, granted_at, reason, source, expires_at)
SELECT DISTINCT w.owner_id, 'comped_scale', now(),
       'Verified legacy grandfathered workspace migration', 'migration', NULL::timestamptz
FROM public.workspaces w
WHERE w.grandfathered = true
ON CONFLICT (user_id) DO NOTHING;

-- A comped owner must receive Scale projection on every new workspace even if
-- Stripe is free/cancelled. Webhooks may still project normal billing plans;
-- effective access reads the entitlement independently.
CREATE OR REPLACE FUNCTION public.apply_comped_scale_to_new_workspace()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_usage_entitlements e
    WHERE e.user_id = NEW.owner_id
      AND e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > now())
  ) THEN
    NEW.plan := 'pro';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_apply_comped_scale
  BEFORE INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.apply_comped_scale_to_new_workspace();

COMMENT ON TABLE public.user_usage_entitlements IS
  'User-level usage entitlement. comped_scale overrides normal Stripe plan for effective capabilities and action caps.';
