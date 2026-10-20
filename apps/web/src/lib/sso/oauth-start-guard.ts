import { createServiceRoleClient } from '@/lib/supabase/service';
import { SSO_REQUIRED_REASON, ssoSignInRequired, type SsoEnforcementRpc } from '@/lib/sso/enforcement';

/**
 * Shared by /auth/google, /auth/github and /auth/microsoft: when the sign-in
 * page passed the typed address as `email` and that address must use SSO,
 * the /auth/error URL to send the person to instead of the provider. Null
 * otherwise, including on any lookup error (the auth hook still enforces).
 *
 * The address is only read, never forwarded: it stays out of the provider
 * URL and out of the error URL.
 */
export async function ssoRequiredRedirect(origin: string, searchParams: URLSearchParams): Promise<string | null> {
  const email = searchParams.get('email');
  if (!email) return null;
  let rpc: SsoEnforcementRpc;
  try {
    const service = createServiceRoleClient();
    rpc = service.rpc.bind(service) as unknown as SsoEnforcementRpc;
  } catch (err) {
    console.error('[sso-enforcement] no service client, continuing:', err);
    return null;
  }
  if (!(await ssoSignInRequired(rpc, email))) return null;
  return `${origin}/auth/error?reason=${SSO_REQUIRED_REASON}`;
}
