import { create } from "zustand";
import { AUTH_STORAGE_KEY, type AuthBackend, AuthFailure, type AuthSession, type AuthUser, type OAuthProvider } from "./backend";
import { type AuthCallback, authCallbackUrl, rememberReturnUrl } from "./callback";

/* Who is signed in. Three states: loading (not known yet), signed-out,
 * signed-in. The gate in app/Gate.tsx renders from this and nothing else.
 *
 * This store knows nothing about mail: whoever needs to react to a sign-in
 * or sign-out (cache namespaces, in-memory stores) registers a listener.
 */

export type AuthStatus = "loading" | "signed-out" | "signed-in";

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  /** Shown on the login screen: a failed callback, an ended session. */
  notice: string | null;
}

export interface SignedOutInfo {
  /** The person pressed Sign out here (as opposed to an expired session or a
   *  sign-out in another tab). */
  explicit: boolean;
}

export interface SignedInInfo {
  user: AuthUser;
  /** The id of the user this tab showed before, when it was someone else. */
  replaced: string | null;
}

export const useAuthStore = create<AuthState>(() => ({ status: "loading", user: null, notice: null }));

type Listener<T> = (info: T) => void | Promise<void>;
const signedInListeners = new Set<Listener<SignedInInfo>>();
const signedOutListeners = new Set<Listener<SignedOutInfo>>();

export function onSignedIn(listener: Listener<SignedInInfo>): () => void {
  signedInListeners.add(listener);
  return () => void signedInListeners.delete(listener);
}
export function onSignedOut(listener: Listener<SignedOutInfo>): () => void {
  signedOutListeners.add(listener);
  return () => void signedOutListeners.delete(listener);
}

const tokenListeners = new Set<(token: string) => void>();
/** Fires when the session's access token was replaced by a refreshed one. */
export function onTokenRefreshed(listener: (token: string) => void): () => void {
  tokenListeners.add(listener);
  return () => void tokenListeners.delete(listener);
}

let backend: Promise<AuthBackend> | null = null;
let stop: (() => void) | null = null;
let explicitSignOut = false;
/** The user whose data this tab may be showing (including a provisional one). */
let shownUserId: string | null = null;

/** The user the backend last confirmed (listeners fire once per identity). */
let confirmed: string | null = null;

function setSignedIn(user: AuthUser): void {
  const prev = useAuthStore.getState();
  const replaced = shownUserId && shownUserId !== user.id ? shownUserId : null;
  shownUserId = user.id;
  if (prev.status !== "signed-in" || prev.user?.id !== user.id || prev.user.email !== user.email || prev.user.name !== user.name) {
    useAuthStore.setState({ status: "signed-in", user, notice: null });
  }
  if (confirmed === user.id) return;
  confirmed = user.id;
  for (const l of [...signedInListeners]) void l({ user, replaced });
}

function setSignedOut(info: SignedOutInfo, notice: string | null = null): void {
  const prev = useAuthStore.getState();
  const had = prev.status === "signed-in" || shownUserId != null;
  shownUserId = null;
  confirmed = null;
  if (prev.status !== "signed-out" || notice) {
    useAuthStore.setState({ status: "signed-out", user: null, notice: notice ?? (prev.status === "signed-out" ? prev.notice : null) });
  }
  if (had) for (const l of [...signedOutListeners]) void l(info);
}

/** Boot: show the app for the user this browser was last signed in as, while
 *  the real session is being checked. Confirmed or revoked by `initAuth`. */
export function assumeSignedIn(user: AuthUser): void {
  shownUserId = user.id;
  useAuthStore.setState({ status: "signed-in", user, notice: null });
}

function onStorage(e: StorageEvent): void {
  if (e.key !== AUTH_STORAGE_KEY && e.key !== null) return;
  // Another tab removed the session (or cleared storage): this tab is out too.
  if (e.newValue == null) {
    if (useAuthStore.getState().status === "signed-in") setSignedOut({ explicit: false });
    return;
  }
  // Another tab signed in: pick the session up.
  void backend
    ?.then((b) => b.getSession())
    .then((s) => {
      if (s) setSignedIn(s.user);
    })
    .catch(() => {});
}

/** Starts auth. Resolves when the first answer is in (signed in or out). */
export async function initAuth(source: AuthBackend | Promise<AuthBackend>, opts: { callback?: AuthCallback | null } = {}): Promise<void> {
  stopAuth();
  const mine = Promise.resolve(source);
  backend = mine;
  let b: AuthBackend;
  try {
    b = await mine;
  } catch {
    if (backend === mine) setSignedOut({ explicit: false }, "Could not load sign-in. Reload the page to try again.");
    return;
  }
  if (backend !== mine) return;

  const unsub = b.onChange((event, session) => {
    if (backend !== mine) return;
    if (event === "signed_out" || !session) {
      const explicit = explicitSignOut;
      explicitSignOut = false;
      setSignedOut({ explicit });
    } else {
      setSignedIn(session.user);
      if (event === "token_refreshed") for (const l of [...tokenListeners]) l(session.access_token);
    }
  });
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  stop = () => {
    unsub();
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };

  let session: AuthSession | null = null;
  let notice: string | null = opts.callback?.error ?? null;
  try {
    if (opts.callback?.code) {
      try {
        session = await b.exchangeCode(opts.callback.code);
      } catch (err) {
        notice = err instanceof AuthFailure ? `That sign-in link did not work: ${err.message}` : "That sign-in link did not work. Ask for a new one.";
      }
    }
    // Development builds only: both sides of this are compiled out otherwise.
    if (import.meta.env.DEV && !session && opts.callback?.devImplicit && b.devAdoptSession) {
      session = await b.devAdoptSession(opts.callback.devImplicit).catch(() => null);
    }
    session ??= await b.getSession();
  } catch {
    session = null;
  }
  if (backend !== mine) return;
  if (session) setSignedIn(session.user);
  else setSignedOut({ explicit: false }, notice);
}

export function stopAuth(): void {
  stop?.();
  stop = null;
  backend = null;
}

/** Test helper. */
export function resetAuthForTests(): void {
  stopAuth();
  shownUserId = null;
  confirmed = null;
  explicitSignOut = false;
  signedInListeners.clear();
  signedOutListeners.clear();
  useAuthStore.setState({ status: "loading", user: null, notice: null });
}

async function need(): Promise<AuthBackend> {
  if (!backend) throw new AuthFailure("Sign-in is not available right now.");
  return backend;
}

/* ---------------- tokens (for the API client) ---------------- */

export async function getAccessToken(): Promise<string | null> {
  try {
    return (await (await need()).getSession())?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function refreshAccessToken(): Promise<string | null> {
  try {
    return (await (await need()).refreshSession())?.access_token ?? null;
  } catch {
    return null;
  }
}

/** The API refused the token and a refresh did not help: the session is over. */
export function handleAuthFailure(): void {
  if (useAuthStore.getState().status !== "signed-in") return;
  void backend?.then((b) => b.signOut()).catch(() => {});
  setSignedOut({ explicit: false }, "Your session ended. Sign in again to continue.");
}

/* ---------------- actions (for the login screen and the account menu) ---------------- */

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const session = await (await need()).signInWithPassword(email.trim(), password);
  setSignedIn(session.user);
}

export async function sendMagicLink(email: string): Promise<void> {
  rememberReturnUrl();
  await (await need()).sendMagicLink(email.trim(), authCallbackUrl());
}

export async function signInWithProvider(provider: OAuthProvider): Promise<void> {
  rememberReturnUrl();
  await (await need()).signInWithOAuth(provider, authCallbackUrl());
}

export async function signOut(): Promise<void> {
  explicitSignOut = true;
  try {
    await (await need()).signOut();
  } catch {
    /* signing out locally must always work */
  }
  explicitSignOut = false;
  setSignedOut({ explicit: true });
}
