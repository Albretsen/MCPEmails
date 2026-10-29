import { NextRequest, NextResponse } from 'next/server';
import { authorizeSsoAdmin, loadDomain, recordSsoAudit, ssoError } from '@/lib/sso/admin';

/**
 * DELETE /api/sso/domains/[id]
 *
 * Removes a domain from the workspace's SSO connection. A verified domain
 * stops routing sign-ins (and stops being enforced) at once. The id must
 * belong to the caller's workspace; any other id is a 404.
 *
 * Owner/admin of an enterprise workspace only. Audited.
 */
export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await authorizeSsoAdmin();
  if (!auth.ok) return auth.response;
  const { ctx } = auth;
  const { id } = await params;

  try {
    const domain = await loadDomain(ctx, id);
    if (!domain) return ssoError(404, 'domain_not_found', 'Domain not found.');

    const { error } = await ctx.db
      .from('sso_domains')
      .delete()
      .eq('id', domain.id)
      .eq('workspace_id', ctx.workspaceId);
    if (error) throw new Error(`delete sso domain: ${error.message}`);

    await recordSsoAudit(ctx, 'domain.removed', domain.connection_id, {
      domain: domain.domain,
      was_verified: domain.verified_at !== null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[sso] remove domain failed', err);
    return ssoError(500, 'server_error', 'Could not remove the domain.');
  }
}
