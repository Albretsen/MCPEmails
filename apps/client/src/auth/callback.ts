/* `/auth/callback`: where OAuth providers and emailed sign-in links return to.
 *
 * The router calls `captureAuthCallback()` before it parses the first URL:
 * the code (or the error) is taken out of the address bar, and the address
 * bar is put back to the URL the visitor originally asked for. The auth store
 * then exchanges the code. No dependencies: the router imports this.
 */

export const AUTH_CALLBACK_PATH = "/auth/callback";

const RETURN_KEY = "mc-auth-return";
const RETURN_MAX_AGE_MS = 60 * 60 * 1000;

export interface AuthCallback {
  code: string | null;
  /** Human-readable reason the provider or Supabase gave. */
  error: string | null;
  /** DEVELOPMENT BUILDS ONLY: the tokens of an implicit-flow fragment
   *  (`#access_token=…&refresh_token=…`), which is what an admin-generated
   *  test link lands with. Never set in a production build: taking a session
   *  from a URL fragment would let a crafted link sign a person into someone
   *  else's account. */
  devImplicit?: { access_token: string; refresh_token: string };
}

let pending: AuthCallback | null = null;

function safePath(url: unknown): string | null {
  // Same-origin paths only: never redirect to something a link supplied.
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return null;
  if (url.startsWith(AUTH_CALLBACK_PATH)) return null;
  return url;
}

/** Remembers where the visitor was, before leaving for a provider or an email. */
export function rememberReturnUrl(): void {
  try {
    const url = safePath(window.location.pathname + window.location.search);
    if (url) localStorage.setItem(RETURN_KEY, JSON.stringify({ url, at: Date.now() }));
  } catch {
    /* private mode: sign-in lands on the inbox */
  }
}

function takeReturnUrl(): string | null {
  try {
    const raw = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { url?: unknown; at?: unknown };
    if (typeof v.at !== "number" || Date.now() - v.at > RETURN_MAX_AGE_MS) return null;
    return safePath(v.url);
  } catch {
    return null;
  }
}

/** Call before the first route is parsed. A no-op anywhere but the callback path. */
export function captureAuthCallback(dev: boolean = import.meta.env.DEV): void {
  if (typeof window === "undefined" || window.location.pathname !== AUTH_CALLBACK_PATH) return;
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const error = query.get("error_description") ?? hash.get("error_description") ?? query.get("error") ?? hash.get("error");
  pending = { code: query.get("code"), error: error ? error.replace(/\+/g, " ") : null };
  // The fragment has to be read HERE: the line below takes it out of the
  // address bar, long before the auth client (a lazy chunk) exists.
  if (import.meta.env.DEV && dev) {
    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");
    if (access_token && refresh_token) {
      pending.devImplicit = { access_token, refresh_token };
      console.info("[dev-only] implicit sign-in fragment accepted");
    }
  }
  window.history.replaceState(null, "", takeReturnUrl() ?? "/");
}

/** The captured callback, once. */
export function takeAuthCallback(): AuthCallback | null {
  const p = pending;
  pending = null;
  return p;
}

export function authCallbackUrl(): string {
  return `${window.location.origin}${AUTH_CALLBACK_PATH}`;
}
