import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeSsoAdmin,
  createDraftConnection,
  DOMAIN_COLUMNS,
  domainView,
  loadConnection,
  loadDomains,
  readJsonObject,
  recordSsoAudit,
  ssoError,
} from '@/lib/sso/admin';
import { checkSsoDomain } from '@/lib/sso/domains';
import type { SsoDomain } from '@/lib/sso/types';

/**
 * POST /api/sso/domains  { domain }
 *
 * Adds a pending email domain to the workspace's SSO connection (creating a
 * draft connection if there is none yet) and returns the TXT record the admin
 * must publish. A pending domain routes nothing; only the DNS check in
 * ./[id]/verify sets verified_at. The same domain may be pending on several
 * workspaces, so a squatter cannot block its owner.
 *
 * Owner/admin of an enterprise workspace only. Audited.
 */
export const dynamic = 'force-dynamic';

const MAX_DOMAINS_PER_CONNECTION = 20;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeSsoAdmin();
  if (!auth.ok) return auth.response;
  const { ctx } = auth;

  const body = await readJsonObject(request);
  const check = checkSsoDomain(body?.domain);
  if (!check.ok) {
    return check.reason === 'consumer'
      ? ssoError(400, 'consumer_domain', 'Public email domains cannot use single sign-on.')
      : ssoError(400, 'invalid_domain', 'Enter a domain like example.com.');
  }

  try {
    const connection = (await loadConnection(ctx)) ?? (await createDraftConnection(ctx));
    const existing = await loadDomains(ctx, connection.id);
    if (existing.some((d) => d.domain === check.domain)) {
      return ssoError(409, 'domain_exists', 'That domain is already on the list.');
    }
    if (existing.length >= MAX_DOMAINS_PER_CONNECTION) {
      return ssoError(409, 'domain_limit', 'This connection has the most domains it can hold.');
    }

    const { data, error } = await ctx.db
      .from('sso_domains')
      .insert({ connection_id: connection.id, domain: check.domain })
      .select(DOMAIN_COLUMNS)
      .single();
    if (error?.code === '23505') return ssoError(409, 'domain_exists', 'That domain is already on the list.');
    if (error?.code === '23514') return ssoError(400, 'invalid_domain', 'Enter a domain like example.com.');
    if (error || !data) throw new Error(`insert sso domain: ${error?.message ?? 'no row'}`);

    const domain = data as SsoDomain;
    await recordSsoAudit(ctx, 'domain.added', connection.id, { domain: domain.domain });
    return NextResponse.json({ domain: domainView(domain) }, { status: 201 });
  } catch (err) {
    console.error('[sso] add domain failed', err);
    return ssoError(500, 'server_error', 'Could not add the domain.');
  }
}
