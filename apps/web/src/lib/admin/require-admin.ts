import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/**
 * Restricts internal product views to the explicitly allowlisted operators.
 *
 * Workspace roles intentionally do not grant product-wide access. Keep this
 * separate from workspace authorization, and configure ADMIN_EMAILS as a
 * comma-separated list of operator email addresses in each environment.
 */
export async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  const allowedEmails = new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );

  if (error || !user?.email || !allowedEmails.has(user.email.toLowerCase())) {
    // Do not reveal the existence of internal operational pages.
    notFound();
  }

  return user;
}
