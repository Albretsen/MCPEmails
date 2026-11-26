-- Keep public.users.email in step with auth.users.email.
--
-- public.users is filled by handle_new_user() on INSERT only. When a person
-- changed their account email (POST /api/user/email, confirmed by link), the
-- auth row moved to the new address but public.users kept the old one, so
-- Settings and every mail we send from public.users still used the old
-- address. This trigger copies the confirmed address across, and the UPDATE
-- below repairs the rows that drifted before it existed.

CREATE OR REPLACE FUNCTION public.sync_user_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.users
       SET email = NEW.email
     WHERE id = NEW.id
       AND email IS DISTINCT FROM NEW.email;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_user_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (NEW.email IS DISTINCT FROM OLD.email)
  EXECUTE FUNCTION public.sync_user_email();

-- One-time repair of rows that drifted before the trigger existed.
UPDATE public.users u
   SET email = a.email
  FROM auth.users a
 WHERE a.id = u.id
   AND a.email IS NOT NULL
   AND u.email IS DISTINCT FROM a.email
   AND NOT EXISTS (
     SELECT 1 FROM public.users x WHERE x.id <> u.id AND lower(x.email) = lower(a.email)
   );
