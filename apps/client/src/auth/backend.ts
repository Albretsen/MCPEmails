/* What the app needs from an auth provider. The Supabase adapter
 * (`./supabase.ts`) is the only implementation in the app; tests use a fake. */

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthSession {
  access_token: string;
  user: AuthUser;
}

export type AuthChange = "signed_in" | "signed_out" | "token_refreshed" | "user_updated";

export type OAuthProvider = "google" | "github";

/** A sign-in attempt that failed for a reason worth showing. */
export class AuthFailure extends Error {
  constructor(
    message: string,
    readonly code: string = "auth_error",
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

export interface AuthBackend {
  /** The stored session, refreshed first when it has expired. Null when
   *  there is none or the refresh token is no longer valid. */
  getSession(): Promise<AuthSession | null>;
  /** Forces a refresh. Null when it cannot be refreshed. */
  refreshSession(): Promise<AuthSession | null>;
  /** Also fires for changes made in another tab. */
  onChange(listener: (event: AuthChange, session: AuthSession | null) => void): () => void;
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  sendMagicLink(email: string, redirectTo: string): Promise<void>;
  /** Leaves the page for the provider. */
  signInWithOAuth(provider: OAuthProvider, redirectTo: string): Promise<void>;
  /** PKCE: trades the code from `/auth/callback` for a session. */
  exchangeCode(code: string): Promise<AuthSession | null>;
  /** Development builds only (absent otherwise): adopts the tokens of an
   *  implicit-flow test link. See `AuthCallback.devImplicit`. */
  devAdoptSession?(tokens: { access_token: string; refresh_token: string }): Promise<AuthSession | null>;
  /** This browser only: other devices and the dashboard stay signed in. */
  signOut(): Promise<void>;
}

/** localStorage key of the Supabase session (watched for multi-tab sign-out). */
export const AUTH_STORAGE_KEY = "mc-auth";
