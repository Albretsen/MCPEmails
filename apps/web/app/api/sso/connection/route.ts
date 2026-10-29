import { NextRequest, NextResponse } from 'next/server';
import {
  adminTestSignInSeen,
  authorizeSsoAdmin,
  CONNECTION_COLUMNS,
  connectionView,
  DEFAULT_CONNECTION_NAME,
  isSsoDefaultRole,
  loadConnection,
  loadDomains,
  readJsonObject,
  recordSsoAudit,
  ssoError,
  type SsoAdminContext,
} from '@/lib/sso/admin';
import { checkEntraMetadataUrl } from '@/lib/sso/saml-values';
import {
  createSamlProvider,
  deleteSamlProvider,
  isSsoManagementConfigured,
  SsoManagementError,
  updateSamlProvider,
} from '@/lib/sso/management-api';
import { checkRateLimit } from '@/lib/rate-limit';
import type { SsoConnection } from '@/lib/sso/types';
import type { Database } from '@/types/database.types';

/**
 * PUT   /api/sso/connection  { metadataUrl }
 *   Creates the workspace's Supabase SAML provider from the Entra federation
 *   metadata URL, or points the existing one at a new URL. A new provider
 *   makes the connection `active`; sign-ins still route only for verified
 *   domains.
 *
 * PATCH /api/sso/connection  exactly one of
 *   { defaultRole: 'member' | 'viewer' }
 *   { enabled: boolean }     false disables the connection (and lifts enforcement)
 *   { enforced: boolean }    true needs: active, a verified domain, and an
 *                            owner/admin who completed a SAML sign-in
 *
 * Owner/admin of an enterprise workspace only. Every change writes an
 * sso_audit_events row.
 */
export const dynamic = 'force-dynamic';

function managementFailure(err: unknown): NextResponse {
  if (err instanceof SsoManagementError) {
    switch (err.reason) {
      case 'not_configured':
        return ssoError(503, 'management_not_configured', 'Single sign-on setup is not available yet. Contact support.');
      case 'metadata_rejected':
        return ssoError(422, 'metadata_rejected', 'Microsoft Entra metadata could not be read from that URL.');
      case 'unauthorized':
        console.error('[sso] Management API token rejected', err.status);
        return ssoError(502, 'management_unavailable', 'Single sign-on setup failed. Try again later.');
      default:
        console.error('[sso] Management API failed', err.reason, err.status);
        return ssoError(502, 'management_unavailable', 'Single sign-on setup failed. Try again later.');
    }
  }
  console.error('[sso] connection change failed', err);
  return ssoError(500, 'server_error', 'Could not save single sign-on settings.');
}

async function updateConnection(
  ctx: SsoAdminContext,
  connectionId: string,
  patch: Database['public']['Tables']['sso_connections']['Update'],
): Promise<SsoConnection> {
  const { data, error } = await ctx.db
    .from('sso_connections')
    .update(patch)
    .eq('id', connectionId)
    .eq('workspace_id', ctx.workspaceId)
    .select(CONNECTION_COLUMNS)
    .single();
  if (error || !data) throw new Error(`update sso connection: ${error?.message ?? 'no row'}`);
  return data as SsoConnection;
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeSsoAdmin();
  if (!auth.ok) return auth.response;
  const { ctx } = auth;

  const body = await readJsonObject(request);
  const check = checkEntraMetadataUrl(body?.metadataUrl);
  if (!check.ok) {
    return ssoError(400, 'invalid_metadata_url', 'Paste the App Federation Metadata Url from Microsoft Entra.');
  }
  if (!isSsoManagementConfigured()) {
    return ssoError(503, 'management_not_configured', 'Single sign-on setup is not available yet. Contact support.');
  }
  if (await checkRateLimit(`sso:metadata:${ctx.workspaceId}`, 10, 10 * 60_000)) {
    return ssoError(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  }

  try {
    const existing = await loadConnection(ctx);

    // Existing provider: point it at the new URL. If Supabase lost it, make a
    // new one below and store its id.
    if (existing?.supabase_sso_provider_id) {
      try {
        await updateSamlProvider(existing.supabase_sso_provider_id, check.url);
        const updated = await updateConnection(ctx, existing.id, { updated_at: new Date().toISOString() });
        await recordSsoAudit(ctx, 'connection.metadata_updated', existing.id, { metadata_host: check.host });
        return NextResponse.json({ connection: connectionView(updated) });
      } catch (err) {
        if (!(err instanceof SsoManagementError && err.reason === 'provider_missing')) throw err;
      }
    }

    // Create the provider first, so a refused metadata URL leaves no row
    // behind. If the row write then fails, delete the provider again.
    const providerId = await createSamlProvider(check.url);
    let connection: SsoConnection;
    try {
      if (existing) {
        connection = await updateConnection(ctx, existing.id, {
          supabase_sso_provider_id: providerId,
          status: existing.status === 'disabled' ? 'disabled' : 'active',
        });
      } else {
        const { data, error } = await ctx.db
          .from('sso_connections')
          .insert({
            workspace_id: ctx.workspaceId,
            display_name: DEFAULT_CONNECTION_NAME,
            default_role: 'member',
            created_by: ctx.userId,
            supabase_sso_provider_id: providerId,
            status: 'active',
          })
          .select(CONNECTION_COLUMNS)
          .single();
        if (error || !data) throw new Error(`create sso connection: ${error?.message ?? 'no row'}`);
        connection = data as SsoConnection;
      }
    } catch (err) {
      await deleteSamlProvider(providerId).catch((cleanupErr) =>
        console.error('[sso] orphaned provider cleanup failed', providerId, cleanupErr),
      );
      throw err;
    }

    await recordSsoAudit(ctx, existing ? 'connection.metadata_updated' : 'connection.created', connection.id, {
      metadata_host: check.host,
    });
    return NextResponse.json({ connection: connectionView(connection) });
  } catch (err) {
    return managementFailure(err);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeSsoAdmin();
  if (!auth.ok) return auth.response;
  const { ctx } = auth;

  const body = await readJsonObject(request);
  const keys = body ? Object.keys(body) : [];
  if (!body || keys.length !== 1 || !['defaultRole', 'enabled', 'enforced'].includes(keys[0])) {
    return ssoError(400, 'invalid_request', 'Send one of defaultRole, enabled or enforced.');
  }

  try {
    const connection = await loadConnection(ctx);
    if (!connection) return ssoError(404, 'no_connection', 'Set up single sign-on first.');

    if ('defaultRole' in body) {
      const role = body.defaultRole;
      if (!isSsoDefaultRole(role)) return ssoError(400, 'invalid_request', 'Default role must be member or viewer.');
      if (role === connection.default_role) return NextResponse.json({ connection: connectionView(connection) });
      const updated = await updateConnection(ctx, connection.id, { default_role: role });
      await recordSsoAudit(ctx, 'connection.default_role_changed', connection.id, {
        from: connection.default_role,
        to: role,
      });
      return NextResponse.json({ connection: connectionView(updated) });
    }

    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') return ssoError(400, 'invalid_request', 'enabled must be true or false.');
      if (!body.enabled) {
        if (connection.status === 'disabled') return NextResponse.json({ connection: connectionView(connection) });
        const updated = await updateConnection(ctx, connection.id, { status: 'disabled', enforced: false });
        if (connection.enforced) await recordSsoAudit(ctx, 'connection.enforcement_removed', connection.id, {});
        await recordSsoAudit(ctx, 'connection.disabled', connection.id, {});
        return NextResponse.json({ connection: connectionView(updated) });
      }
      if (connection.status === 'active') return NextResponse.json({ connection: connectionView(connection) });
      if (!connection.supabase_sso_provider_id) {
        return ssoError(409, 'no_provider', 'Add the Microsoft Entra metadata URL first.');
      }
      const updated = await updateConnection(ctx, connection.id, { status: 'active' });
      await recordSsoAudit(ctx, 'connection.enabled', connection.id, {});
      return NextResponse.json({ connection: connectionView(updated) });
    }

    if (typeof body.enforced !== 'boolean') return ssoError(400, 'invalid_request', 'enforced must be true or false.');
    if (body.enforced === connection.enforced) return NextResponse.json({ connection: connectionView(connection) });

    if (!body.enforced) {
      const updated = await updateConnection(ctx, connection.id, { enforced: false });
      await recordSsoAudit(ctx, 'connection.enforcement_removed', connection.id, {});
      return NextResponse.json({ connection: connectionView(updated) });
    }

    // Turning enforcement on refuses every other sign-in method for these
    // domains, so prove the SAML path works first.
    if (connection.status !== 'active' || !connection.supabase_sso_provider_id) {
      return ssoError(409, 'enforce_needs_active', 'Turn single sign-on on before requiring it.');
    }
    const domains = await loadDomains(ctx, connection.id);
    if (!domains.some((d) => d.verified_at !== null)) {
      return ssoError(409, 'enforce_needs_verified_domain', 'Verify at least one domain before requiring single sign-on.');
    }
    if (!(await adminTestSignInSeen(ctx, connection))) {
      return ssoError(
        409,
        'enforce_needs_test_sign_in',
        'An owner or admin must sign in with SSO once before single sign-on can be required.',
      );
    }
    const updated = await updateConnection(ctx, connection.id, { enforced: true });
    await recordSsoAudit(ctx, 'connection.enforced', connection.id, {});
    return NextResponse.json({ connection: connectionView(updated) });
  } catch (err) {
    return managementFailure(err);
  }
}
