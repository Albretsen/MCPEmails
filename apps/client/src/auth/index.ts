export {
  useAuthStore,
  initAuth,
  stopAuth,
  assumeSignedIn,
  onSignedIn,
  onSignedOut,
  onTokenRefreshed,
  getAccessToken,
  refreshAccessToken,
  handleAuthFailure,
  signInWithPassword,
  sendMagicLink,
  signInWithProvider,
  signOut,
} from "./auth-store";
export type { AuthState, AuthStatus, SignedInInfo, SignedOutInfo } from "./auth-store";
export { AUTH_STORAGE_KEY, AuthFailure } from "./backend";
export type { AuthBackend, AuthChange, AuthSession, AuthUser, OAuthProvider } from "./backend";
export { AUTH_CALLBACK_PATH, captureAuthCallback, takeAuthCallback } from "./callback";
export type { AuthCallback } from "./callback";
export {
  useSessionStore,
  activeWorkspace,
  readIdentity,
  writeIdentity,
  clearIdentity,
  hasStoredAuthSession,
  EMPTY_SESSION,
} from "./session-store";
export type { IdentityHint, SessionState, SessionStatus } from "./session-store";
