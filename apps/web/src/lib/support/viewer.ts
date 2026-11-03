/**
 * Who is looking at Help & support.
 *
 * Server-only (Server Components and Route Handlers). Reads the Supabase
 * session with getUser() (validated server-side, never getSession()).
 */
import { createClient } from '@/lib/supabase/server';

export interface SupportViewer {
  user: { id: string; email: string } | null;
}

export async function getSupportViewer(): Promise<SupportViewer> {
  let user: SupportViewer['user'] = null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (data.user?.email) user = { id: data.user.id, email: data.user.email };
  } catch {
    // No session or Supabase unreachable: treat as signed out.
  }
  return { user };
}
