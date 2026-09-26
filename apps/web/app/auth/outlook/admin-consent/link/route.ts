import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import {
  adminConsentLinkKey,
  adminConsentLinkUrl,
  mintAdminConsentLinkToken,
} from '@/lib/email-providers/outlook-admin-link';

/**
 * GET /auth/outlook/admin-consent/link
 *
 * Mints the shareable admin-consent link for the signed-in user's active
 * workspace and returns it as JSON for the dashboard's "Send to your IT
 * admin" dialog:
 *
 *   { url: "https://mcpemails.com/auth/outlook/admin-consent?t=...", expires_at: "..." }
 *
 * Any member may mint one. The link grants nothing inside MCP Emails: it only
 * starts Microsoft's own admin-consent flow, where a tenant administrator has
 * to sign in and approve. See lib/email-providers/outlook-admin-link.ts.
 */
export async function GET(): Promise<NextResponse> {
  const noStore = { 'Cache-Control': 'no-store' };
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized', error_code: 'session_expired' }, { status: 401, headers: noStore });
  }
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found.', error_code: 'workspace_not_found' }, { status: 403, headers: noStore });
  }

  let key: Buffer;
  try {
    key = adminConsentLinkKey();
  } catch {
    console.error('[outlook/admin-consent/link] CSRF_SECRET is missing or invalid');
    return NextResponse.json({ error: 'Link signing is not configured.', error_code: 'unavailable' }, { status: 500, headers: noStore });
  }

  const minted = mintAdminConsentLinkToken(workspaceId, user.id, key);
  return NextResponse.json(
    {
      url: adminConsentLinkUrl(process.env.NEXT_PUBLIC_APP_URL!, minted.token),
      expires_at: new Date(minted.expiresAt).toISOString(),
    },
    { headers: noStore },
  );
}
