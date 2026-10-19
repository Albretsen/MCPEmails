import { NextResponse } from 'next/server';
import {
  adminTestSignInSeen,
  authorizeSsoAdmin,
  connectionView,
  domainView,
  loadAuditEvents,
  loadConnection,
  loadDomains,
  ssoError,
} from '@/lib/sso/admin';
import { samlServiceProviderValues } from '@/lib/sso/saml-values';
import { isSsoManagementConfigured } from '@/lib/sso/management-api';

/**
 * GET /api/sso
 *
 * Everything the SSO settings section shows: our SAML values for the admin to
 * paste into Entra, the workspace's connection, its domains with the TXT
 * record each needs, whether an admin has completed a test sign-in (enforce
 * is locked until then), and the recent audit trail.
 *
 * Owner/admin of an enterprise workspace only (see lib/sso/admin.ts). The
 * Supabase provider id and the Management API token never leave the server.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const auth = await authorizeSsoAdmin();
  if (!auth.ok) return auth.response;
  const { ctx } = auth;

  try {
    const connection = await loadConnection(ctx);
    const [domains, testSignInSeen, events] = await Promise.all([
      connection ? loadDomains(ctx, connection.id) : Promise.resolve([]),
      connection ? adminTestSignInSeen(ctx, connection) : Promise.resolve(false),
      loadAuditEvents(ctx),
    ]);
    return NextResponse.json({
      saml: samlServiceProviderValues(process.env.NEXT_PUBLIC_SUPABASE_URL),
      managementConfigured: isSsoManagementConfigured(),
      connection: connection ? connectionView(connection) : null,
      domains: domains.map(domainView),
      testSignInSeen,
      events,
    });
  } catch (err) {
    console.error('[sso] GET failed', err);
    return ssoError(500, 'server_error', 'Could not load single sign-on settings.');
  }
}
