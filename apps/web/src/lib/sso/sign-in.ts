import { checkSsoDomain } from '@/lib/sso/domains';

/**
 * The two SSO questions sign-in code asks: "does this email's domain sign in
 * through SSO, and with which provider?" and "did this user sign in through
 * SSO?".
 *
 * ROUTING. Our verified sso_domains table is the source of truth, not the
 * domains list on the Supabase provider. public.sso_provider_for_domain()
 * returns a provider id only for a DNS-verified domain on an active
 * connection of a live workspace; the caller then uses
 * `signInWithSSO({ providerId })`. The RPC is service-role only.
 *
 * IDENTITY. Supabase never links an SSO identity to an existing account, so an
 * SSO user is always its own auth.users row with
 * app_metadata.provider = 'sso:<provider id>'.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The service-role client's `rpc`, passed as `supabase.rpc.bind(supabase)`.
 * Typed narrowly here until database.types.ts is regenerated with the RPC.
 */
export type SsoLookupRpc = (
  fn: 'sso_provider_for_domain',
  args: { p_domain: string },
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export type SsoRoute =
  | { sso: true; domain: string; providerId: string }
  | { sso: false; reason: 'invalid_email' | 'consumer_domain' | 'not_configured' };

/**
 * Where an email address signs in. `not_configured` covers an unknown domain,
 * an unverified one and a disabled connection alike, so the caller can show
 * one generic message and reveal nothing more about the domain.
 *
 * Throws when the lookup itself fails, so an outage is never read as "this
 * domain has no SSO" (which, once enforcement exists, would send people to a
 * sign-in method their company has turned off).
 */
export async function ssoRouteForEmail(rpc: SsoLookupRpc, email: unknown): Promise<SsoRoute> {
  const check = checkSsoDomain(email);
  if (!check.ok) {
    return { sso: false, reason: check.reason === 'consumer' ? 'consumer_domain' : 'invalid_email' };
  }

  const { data, error } = await rpc('sso_provider_for_domain', { p_domain: check.domain });
  if (error) throw new Error(`sso_provider_for_domain failed: ${error.message}`);
  if (typeof data !== 'string' || !UUID.test(data)) {
    return { sso: false, reason: 'not_configured' };
  }
  return { sso: true, domain: check.domain, providerId: data.toLowerCase() };
}

/** Enough of a Supabase `User` to read how it signed up. */
export interface SsoUserLike {
  app_metadata?: { provider?: unknown } | null;
}

/**
 * The Supabase SSO provider id an SSO user belongs to, or null for any other
 * user. Reads app_metadata.provider, which only Supabase Auth and the service
 * role can write.
 */
export function ssoProviderIdOf(user: SsoUserLike | null | undefined): string | null {
  const provider = user?.app_metadata?.provider;
  if (typeof provider !== 'string' || !provider.startsWith('sso:')) return null;
  const id = provider.slice('sso:'.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** True when the user is an SSO account. */
export function isSsoUser(user: SsoUserLike | null | undefined): boolean {
  return ssoProviderIdOf(user) !== null;
}
