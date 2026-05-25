import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/**
 * Returns a Supabase client authenticated with the service-role key.
 *
 * This client BYPASSES Row-Level Security and must only be used for
 * server-side administrative operations (e.g., marking an inbox as
 * errored after a token refresh failure).
 *
 * NEVER expose the service-role key to the browser or include it in
 * any client-side bundle.
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
export function createServiceRoleClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for server-side admin operations.'
    );
  }

  return createClient<Database>(url, key, {
    auth: {
      // Service-role client never manages user sessions
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
