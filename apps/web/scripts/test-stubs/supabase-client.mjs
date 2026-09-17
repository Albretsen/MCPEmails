// `@/lib/supabase/client` outside a browser.
//
// Sidebar calls `createClient()` to sign out, which is the only reason the
// dashboard tree touches this module at all. The real one reads
// NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY at call time and would build a browser
// client pointed at the production project. A test must never do that, so this
// stands in with the one method the caller uses.
export function createClient() {
  return {
    auth: {
      signOut: async () => ({ error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  };
}
