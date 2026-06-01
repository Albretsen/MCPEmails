import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * API key name distinguishability helpers.
 *
 * Two keys with the identical name are indistinguishable in the audit log and
 * usage stats (the original report: two "OAuth: Claude" keys). We keep names
 * distinguishable in two complementary ways:
 *
 *   - Dashboard creation (user picks the name): reject a duplicate with a 409 so
 *     the user chooses a distinct name. See app/api/api-keys/route.ts.
 *   - OAuth authorization (name is derived from the client, can't be rejected
 *     without breaking the flow): auto-disambiguate by appending " (2)", " (3)",
 *     … See app/api/oauth/token/route.ts.
 *
 * Matching is case-insensitive and ignores surrounding whitespace, mirroring how
 * a human reads the list.
 */

/** Fetch the names of all active (non-revoked) API keys in a workspace. */
export async function getActiveApiKeyNames(
  // Accept any Supabase client (RLS user client or service-role client).
  supabase: Pick<SupabaseClient, 'from'>,
  workspaceId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('api_keys')
    .select('name')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);

  return (data ?? [])
    .map((row: { name: string | null }) => (row.name ?? '').trim())
    .filter((name: string) => name.length > 0);
}

/** Case-insensitive check of whether `name` collides with an existing name. */
export function isApiKeyNameTaken(existingNames: string[], name: string): boolean {
  const needle = name.trim().toLowerCase();
  return existingNames.some((existing) => existing.toLowerCase() === needle);
}

/**
 * Return a name not already used by an active key in `existingNames`. If `base`
 * is free it is returned unchanged; otherwise " (2)", " (3)", … is appended
 * until a free name is found.
 */
export function disambiguateApiKeyName(existingNames: string[], base: string): string {
  const trimmed = base.trim();
  if (!isApiKeyNameTaken(existingNames, trimmed)) return trimmed;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${trimmed} (${i})`;
    if (!isApiKeyNameTaken(existingNames, candidate)) return candidate;
  }
  // Pathological fallback: 999 same-named keys. Fall back to a timestamp suffix.
  return `${trimmed} (${Date.now()})`;
}
