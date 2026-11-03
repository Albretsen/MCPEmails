import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { ARABIC_GUIDE_PATH, primaryLanguageFromHeader } from '@/lib/acquisition-browser-language.mjs';

/**
 * Record the browser language of a signup that landed on the Arabic guide.
 *
 * WHERE IT RUNS. Beside stampAcquisitionCountry, at the same two places and
 * behind the same gates, because it needs the same thing: the new user's own
 * browser sending the request.
 *
 * ONLY THAT PAGE. The read-out needs this for one landing page, so nobody else's
 * language is kept. The first-touch landing path is read from the workspace, so
 * this must run after attribution has been written.
 *
 * WHERE IT GOES. auth.users.raw_user_meta_data, as acquisition_browser_language.
 * A column would need a migration for a test that may close in 90 days. The auth
 * API merges user_metadata, so nothing else in it changes. Read it back with
 * scripts/report-arabic-guide-test.sql.
 *
 * Its own statements, and it never throws: nothing here may affect a signup.
 */
export async function stampArabicGuideBrowserLanguage(
  db: Pick<SupabaseClient<Database>, 'from' | 'auth'>,
  args: {
    ownerId: string | null | undefined;
    acceptLanguage: string | null | undefined;
  },
): Promise<void> {
  try {
    const language = primaryLanguageFromHeader(args.acceptLanguage);
    if (!args.ownerId || !language) return;
    const { data, error } = await db
      .from('workspaces')
      .select('id')
      .eq('owner_id', args.ownerId)
      .eq('acquisition_landing_path', ARABIC_GUIDE_PATH)
      .limit(1);
    if (error) {
      console.error('[browser-language] read failed', { error: error.message });
      return;
    }
    if (!data?.length) return;
    const { error: writeError } = await db.auth.admin.updateUserById(args.ownerId, {
      user_metadata: { acquisition_browser_language: language },
    });
    if (writeError) console.error('[browser-language] stamp failed', { error: writeError.message });
  } catch (err) {
    console.error('[browser-language] stamp threw', { error: err instanceof Error ? err.message : String(err) });
  }
}
