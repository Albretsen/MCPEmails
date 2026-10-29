import { checkSsoDomain } from '@/lib/sso/domains';

/**
 * SSO enforcement, app side.
 *
 * THE ENFORCER IS NOT HERE. When a company's connection is enforced, Supabase
 * Auth refuses every non-SSO token for its domain through the Custom Access
 * Token hook, and every non-SSO signup through the Before User Created hook
 * (supabase/migrations/20261019153000_auth_hooks_sso_enforcement.sql). The
 * anon key is public, so a check in our routes alone would be bypassable.
 * What lives here only turns those refusals into a clear message:
 *
 *   - before an OAuth redirect, when the sign-in page passes the typed email,
 *     the route stops early instead of sending the person through Google or
 *     Microsoft only to be refused at the end;
 *   - after a refusal, supabase-js and /auth/callback carry the hook's reason
 *     code ('sso_required') as the error message, and isSsoRequiredError()
 *     recognises it.
 *
 * Every check here FAILS OPEN: a lookup error means "no friendly message",
 * never "blocked". The hook still decides.
 */

/** The reason code the hooks return and /auth/error understands. */
export const SSO_REQUIRED_REASON = 'sso_required';

/** Where a person told to use SSO goes next. */
export const SSO_SIGN_IN_PATH = '/login?sso=1';

/**
 * The service-role client's `rpc`, passed as `supabase.rpc.bind(supabase)`.
 * Typed narrowly here until database.types.ts is regenerated with the RPC.
 */
export type SsoEnforcementRpc = (
  fn: 'sso_sign_in_required',
  args: { p_email: string },
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * True only when the database says a non-SSO sign-in with this email would be
 * refused (enforced, verified domain; not the break-glass owner; kill switch
 * on). Invalid and consumer addresses never reach the database. Any error
 * returns false.
 */
export async function ssoSignInRequired(rpc: SsoEnforcementRpc, email: unknown): Promise<boolean> {
  if (typeof email !== 'string') return false;
  const check = checkSsoDomain(email);
  if (!check.ok) return false;
  try {
    const { data, error } = await rpc('sso_sign_in_required', { p_email: email.trim().toLowerCase() });
    if (error) {
      console.error('[sso-enforcement] pre-check failed, continuing:', error.message);
      return false;
    }
    return data === true;
  } catch (err) {
    console.error('[sso-enforcement] pre-check failed, continuing:', err);
    return false;
  }
}

/**
 * Whether an auth error (from supabase-js, or a reason string from
 * /auth/callback) is the hooks' SSO refusal.
 */
export function isSsoRequiredError(error: unknown): boolean {
  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '';
  return message.includes(SSO_REQUIRED_REASON);
}
