import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeSsoAdmin,
  DOMAIN_COLUMNS,
  domainView,
  loadDomain,
  recordSsoAudit,
  ssoError,
} from '@/lib/sso/admin';
import { checkDomainVerificationRecord } from '@/lib/sso/dns-verify';
import { checkRateLimit } from '@/lib/rate-limit';
import type { SsoDomain } from '@/lib/sso/types';

/**
 * POST /api/sso/domains/[id]/verify  ("Check now")
 *
 * Looks up the domain's TXT records and, when
 * `mcpemails-verification=<token>` is there, marks the domain verified. Only
 * a verified domain routes sign-ins or can be enforced, and a domain can be
 * verified on one workspace at most (unique index), so a second workspace
 * that proves the same domain gets `domain_taken`.
 *
 * The update is conditioned on the token that was checked, so a token
 * rotated mid-request is never marked verified.
 *
 * Owner/admin of an enterprise workspace only. Audited when it verifies.
 */
export const dynamic = 'force-dynamic';

export async function POST(
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
    if (domain.verified_at) return NextResponse.json({ domain: domainView(domain) });

    if (await checkRateLimit(`sso:verify:${ctx.workspaceId}`, 30, 10 * 60_000)) {
      return ssoError(429, 'rate_limited', 'Too many checks. Wait a few minutes and try again.');
    }

    const result = await checkDomainVerificationRecord(domain.domain, domain.verification_token);
    if (!result.verified) {
      return result.reason === 'lookup_failed'
        ? ssoError(502, 'dns_lookup_failed', 'DNS lookup failed. Try again in a minute.')
        : ssoError(422, 'dns_record_missing', 'The TXT record was not found yet. DNS changes can take a while.');
    }

    const { data, error } = await ctx.db
      .from('sso_domains')
      .update({ verified_at: new Date().toISOString() })
      .eq('id', domain.id)
      .eq('workspace_id', ctx.workspaceId)
      .eq('verification_token', domain.verification_token)
      .select(DOMAIN_COLUMNS)
      .single();
    if (error?.code === '23505') {
      return ssoError(409, 'domain_taken', 'This domain is already verified by another workspace. Contact support.');
    }
    if (error || !data) throw new Error(`verify sso domain: ${error?.message ?? 'no row'}`);

    const verified = data as SsoDomain;
    await recordSsoAudit(ctx, 'domain.verified', verified.connection_id, { domain: verified.domain });
    return NextResponse.json({ domain: domainView(verified) });
  } catch (err) {
    console.error('[sso] verify domain failed', err);
    return ssoError(500, 'server_error', 'Could not check the domain.');
  }
}
