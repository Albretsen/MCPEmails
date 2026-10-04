import { type Session, type SupabaseClient, createClient } from "@supabase/supabase-js";
import { AUTH_STORAGE_KEY, type AuthBackend, type AuthChange, AuthFailure, type AuthSession } from "./backend";

/* The Supabase browser client: PKCE, session persisted in localStorage,
 * tokens refreshed automatically. This is the only module that imports
 * `@supabase/supabase-js`; it is loaded on demand, in HTTP mode only. */

export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      // `/auth/callback` is handled by the app (auth/callback.ts): by the time
      // this client exists the code is out of the URL. Detection stays on for
      // a redirect that lands anywhere else with `?code=`.
      detectSessionInUrl: true,
      storageKey: AUTH_STORAGE_KEY,
      storage: window.localStorage,
    },
  });
}

function toSession(s: Session | null | undefined): AuthSession | null {
  if (!s?.access_token || !s.user) return null;
  const meta = (s.user.user_metadata ?? {}) as Record<string, unknown>;
  const name = [meta.full_name, meta.name, meta.display_name].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return { access_token: s.access_token, user: { id: s.user.id, email: s.user.email ?? "", name: name?.trim() ?? null } };
}

const EVENTS: Record<string, AuthChange | undefined> = {
  SIGNED_IN: "signed_in",
  SIGNED_OUT: "signed_out",
  TOKEN_REFRESHED: "token_refreshed",
  USER_UPDATED: "user_updated",
};

/** Messages a person can act on. Supabase's own wording is kept only where it is clear. */
function failure(error: { message?: string; code?: string; status?: number }): AuthFailure {
  const code = error.code ?? "auth_error";
  const raw = error.message ?? "";
  if (code === "invalid_credentials" || /invalid login credentials/i.test(raw)) {
    return new AuthFailure("That email and password do not match.", "invalid_credentials");
  }
  if (code === "email_not_confirmed") return new AuthFailure("Confirm your email address first, then sign in.", code);
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || error.status === 429) {
    return new AuthFailure("Too many attempts. Wait a minute and try again.", "rate_limited");
  }
  if (code === "otp_disabled" || code === "signup_disabled" || /signups not allowed/i.test(raw)) {
    return new AuthFailure("There is no account for that email. Create one at mcpemails.com first.", "no_account");
  }
  if (/fetch|network/i.test(raw)) return new AuthFailure("Could not reach the sign-in service. Check your connection.", "network");
  return new AuthFailure(raw || "Could not sign in. Try again.", code);
}

export function createSupabaseAuthBackend(url: string, anonKey: string): AuthBackend {
  const supabase = createSupabaseClient(url, anonKey);
  // Development only: adopt the tokens of an implicit-flow fragment
  // (#access_token=…), which is what an admin-generated test link produces
  // and the PKCE client ignores. The fragment is captured by auth/callback.ts
  // (the router strips the URL before this lazy module exists, which is why
  // reading `location` here never worked). Never in production builds: the
  // method does not exist there and the capture is compiled out.
  const dev: Pick<AuthBackend, "devAdoptSession"> = import.meta.env.DEV
    ? {
        async devAdoptSession(tokens) {
          const { data, error } = await supabase.auth.setSession(tokens);
          return error ? null : toSession(data.session);
        },
      }
    : {};
  return {
    ...dev,
    async getSession() {
      const { data } = await supabase.auth.getSession();
      return toSession(data.session);
    },
    async refreshSession() {
      const { data, error } = await supabase.auth.refreshSession();
      return error ? null : toSession(data.session);
    },
    onChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        const mapped = EVENTS[event];
        // Never call back into supabase.auth from inside this callback (it
        // holds the auth lock): hand over on the next tick.
        if (mapped) setTimeout(() => listener(mapped, toSession(session)), 0);
      });
      return () => data.subscription.unsubscribe();
    },
    async signInWithPassword(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw failure(error);
      const session = toSession(data.session);
      if (!session) throw new AuthFailure("Could not sign in. Try again.");
      return session;
    },
    async sendMagicLink(email, redirectTo) {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        // New accounts are created on mcpemails.com, never from here.
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });
      if (error) throw failure(error);
    },
    async signInWithOAuth(provider, redirectTo) {
      const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } });
      if (error) throw failure(error);
    },
    async exchangeCode(code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw failure(error);
      return toSession(data.session);
    },
    async signOut() {
      await supabase.auth.signOut({ scope: "local" });
    },
  };
}
