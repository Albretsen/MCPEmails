/**
 * Is this bearer a service-role credential for THIS Supabase project?
 *
 * Used by /triage-preview, the one route the Next.js server calls with its
 * own SUPABASE_SERVICE_ROLE_KEY.
 *
 * ── WHY NOT A PLAIN STRING COMPARE ──────────────────────────────────────────
 * The route used to compare the bearer with this function's own
 * SUPABASE_SERVICE_ROLE_KEY. Supabase injects that variable and replaced its
 * value on 2026-11-24 (all SUPABASE_* defaults changed at once). The web app
 * still held the earlier key, which stayed valid everywhere else, so every
 * automation preview answered "unauthorized" for every customer while nothing
 * else broke. Two copies of a secret in two platforms drift; the compare
 * cannot tell "a stranger" from "the same project, another valid key".
 *
 * ── WHAT IT DOES INSTEAD ────────────────────────────────────────────────────
 * 1. Exact match with this function's key: accepted, no I/O (the old path).
 * 2. Otherwise, a cheap shape check (a legacy JWT whose unverified payload says
 *    role service_role, or a new-style `sb_secret_` key) so random bearers
 *    never cause a network call.
 * 3. Then ask the project's own Auth admin API, which only a service-role
 *    credential may call. 200 means the project itself accepts the key as
 *    service role. Any other answer, or a network failure, is a refusal.
 * 4. A positive answer is cached in memory for a few minutes, keyed by a hash
 *    of the bearer, so a preview session costs one probe, not one per click.
 *    Refusals are not cached: a key that starts working should work at once.
 */

const CACHE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;

const accepted = new Map<string, number>();

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Unverified shape check. A gate against needless probes, never the decision. */
export function looksLikeServiceKey(bearer: string): boolean {
  if (bearer.startsWith("sb_secret_")) return bearer.length > 20;
  const parts = bearer.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return payload && typeof payload === "object" && payload.role === "service_role";
  } catch {
    return false;
  }
}

async function cacheKey(bearer: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ServiceBearerDeps {
  supabaseUrl: string;
  ownServiceKey: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export async function isServiceRoleBearer(bearer: string, deps: ServiceBearerDeps): Promise<boolean> {
  if (!bearer) return false;
  if (deps.ownServiceKey && timingSafeEqual(bearer, deps.ownServiceKey)) return true;
  if (!deps.supabaseUrl || !looksLikeServiceKey(bearer)) return false;

  const now = deps.now ?? Date.now;
  const key = await cacheKey(bearer);
  const until = accepted.get(key);
  if (until !== undefined) {
    if (until > now()) return true;
    accepted.delete(key);
  }

  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${deps.supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
      method: "GET",
      headers: { apikey: bearer, Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // The body lists a user; it is never read.
    await res.body?.cancel();
    if (res.status !== 200) return false;
  } catch {
    return false;
  }
  accepted.set(key, now() + CACHE_TTL_MS);
  return true;
}

/** Tests only. */
export function _resetServiceBearerCache(): void {
  accepted.clear();
}
