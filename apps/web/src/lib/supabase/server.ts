import { createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/**
 * Creates a Supabase client for use in Server Components, Route Handlers,
 * and Server Actions.
 *
 * Reads session cookies from the incoming request and writes Set-Cookie
 * headers on the response via Next.js's cookies() API.
 *
 * Always call `supabase.auth.getUser()` (not `getSession()`) in server-side
 * code — getUser() validates the token server-side and detects revoked sessions.
 */
export async function createClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();

  // Cast bridges the @supabase/ssr v0.6.x type signature (3 generic params)
  // to the @supabase/supabase-js v2.106.x signature (5 params). Runtime is identical.
  // Remove once @supabase/ssr is upgraded to ≥0.10.x.
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — session refresh writes are
            // silently dropped here. Middleware handles the actual refresh.
          }
        },
      },
    }
  ) as unknown as SupabaseClient<Database>;
}
