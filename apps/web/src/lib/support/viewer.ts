/**
 * Who is looking at Help & support, and may they see it.
 *
 * Server-only (Server Components and Route Handlers). Reads the Supabase
 * session with getUser() (validated server-side, never getSession()) and the
 * staff preview cookie, then asks the release gate.
 */
import { cookies } from 'next/headers';

import { createClient } from '@/lib/supabase/server';

import { SUPPORT_PREVIEW_COOKIE, supportVisibleTo } from '@/lib/support/release-gate'; // SUPPORT_RELEASE_GATE

export interface SupportViewer {
  visible: boolean;
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

  let previewToken: string | null = null;
  try {
    previewToken = (await cookies()).get(SUPPORT_PREVIEW_COOKIE)?.value ?? null; // SUPPORT_RELEASE_GATE
  } catch {
    previewToken = null;
  }

  const visible = supportVisibleTo(user?.email ?? null, previewToken); // SUPPORT_RELEASE_GATE
  return { visible, user };
}
