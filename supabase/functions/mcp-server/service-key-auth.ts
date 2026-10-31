/**
 * Is this bearer a service-level key for THIS Supabase project?
 *
 * WHY NOT A STRING COMPARE. A project can hold several valid service keys at once:
 * the legacy `service_role` JWT and any number of `sb_secret_...` keys. The website
 * and this edge function are configured separately, so they can hold different
 * ones, and each is valid. Staging was in exactly that state: the site sent the
 * legacy JWT, this function held an `sb_secret` key, a plain compare refused it, and
 * the dashboard showed "unauthorized". A key rotation would do the same to production
 * in silence, because nothing else fails.
 *
 * So after the fast compare, ask the project itself. Auth's admin API only answers an
 * admin-level key, and asking for the nil user id returns no user data whichever way
 * it goes:
 *
 *   404 user_not_found  the key is admin-level (it got past the check)
 *   403 not_admin       a valid key without admin rights (anon, a user JWT)
 *   401                 not a key for this project
 *
 * This works whichever format either side holds, needs no shared configuration, and
 * follows a revocation immediately since nothing is cached. It fails closed: any
 * other answer, or no answer, is a refusal.
 */

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const VERIFY_TIMEOUT_MS = 5_000;

/** Only a token that could be a service key is worth a round trip to Auth. */
export function looksLikeServiceKey(token: string): boolean {
  if (token.startsWith("sb_secret_")) return true;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

export interface ServiceKeyCheck {
  ownKey: string;
  supabaseUrl: string;
  timingSafeEqual: (a: string, b: string) => boolean;
  fetchImpl?: typeof fetch;
}

export async function isServiceKeyForThisProject(
  bearer: string,
  { ownKey, supabaseUrl, timingSafeEqual, fetchImpl = fetch }: ServiceKeyCheck,
): Promise<boolean> {
  if (!bearer) return false;
  if (ownKey && timingSafeEqual(bearer, ownKey)) return true;
  if (!supabaseUrl || !looksLikeServiceKey(bearer)) return false;
  try {
    const response = await fetchImpl(`${supabaseUrl}/auth/v1/admin/users/${NIL_USER}`, {
      headers: { apikey: bearer, Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (response.status !== 404) {
      await response.body?.cancel();
      return false;
    }
    const body = await response.json().catch(() => null) as { error_code?: unknown } | null;
    return body?.error_code === "user_not_found";
  } catch {
    return false;
  }
}
