import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { sanitizedCountry } from '@/lib/acquisition-country.mjs';

/**
 * Write the signup country onto the new owner's workspace, once.
 *
 * WHERE IT RUNS. Beside stampAcquisitionDevice, at the same two places and
 * behind the same gates, for the same reason: it has to be the first request
 * the new user's OWN browser makes to this server. Vercel sets
 * `x-vercel-ip-country` from the address of whoever sent the request, so only
 * that request places the person rather than a server.
 *
 *   - Google and GitHub: /auth/callback. The provider redirects the browser
 *     there; the code exchange inside it is server to server, but the request
 *     itself came from the person's browser.
 *   - Password: the first dashboard render (provider `email`, account minutes
 *     old). signUp() goes from the page straight to Supabase, so no earlier
 *     request of ours sees the signup.
 *
 * Only the two-letter code is kept (see acquisition-country.mjs). The IP
 * address is never read here, and neither is logged.
 *
 * FIRST WRITE WINS. Filtered on `acquisition_country IS NULL`. An unknown
 * country is not written at all, so a later request cannot fill it in with the
 * place someone happens to be the next time.
 *
 * OWNER ONLY. Filtered on owner_id, so it lands on the workspace the signup
 * trigger created for this user and never on one they were invited to.
 *
 * A statement of its own, so the attribution and device writes cannot fail on
 * this column while its migration is unapplied. Never throws.
 */
/**
 * The one statement this file runs, until the generated types know the column.
 *
 * src/types/database.types.ts is generated from the production schema, which
 * gains acquisition_country only when 20261020100000_acquisition_country.sql
 * is applied, and supabase-js refuses (as a type error) an update naming a
 * column those types do not have. The types are never hand-edited, so the
 * workspaces builder is viewed through this narrow shape for this one write.
 * After the migration is applied and `npm run gen:types` is run, the view can
 * go and the chain below is checked against the real schema like the device
 * stamp's.
 */
type PendingCountryWrite = {
  update(values: { acquisition_country: string }): {
    eq(column: 'owner_id', value: string): {
      is(column: 'acquisition_country', value: null): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

export async function stampAcquisitionCountry(
  db: Pick<SupabaseClient<Database>, 'from'>,
  args: {
    ownerId: string | null | undefined;
    country: string | null | undefined;
  },
): Promise<void> {
  try {
    const country = sanitizedCountry(args.country);
    if (!args.ownerId || !country) return;
    const workspaces = db.from('workspaces') as unknown as PendingCountryWrite;
    const { error } = await workspaces
      .update({ acquisition_country: country })
      .eq('owner_id', args.ownerId)
      .is('acquisition_country', null);
    if (error) console.error('[country] stamp failed', { error: error.message });
  } catch (err) {
    console.error('[country] stamp threw', { error: err instanceof Error ? err.message : String(err) });
  }
}
