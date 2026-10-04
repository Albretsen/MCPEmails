import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assumeSignedIn,
  getAccessToken,
  handleAuthFailure,
  initAuth,
  onSignedIn,
  onSignedOut,
  refreshAccessToken,
  resetAuthForTests,
  sendMagicLink,
  signInWithPassword,
  signOut,
  useAuthStore,
} from "./auth-store";
import { AUTH_STORAGE_KEY, type AuthBackend, type AuthChange, AuthFailure, type AuthSession } from "./backend";
import { AUTH_CALLBACK_PATH, captureAuthCallback, rememberReturnUrl, takeAuthCallback } from "./callback";

const alice: AuthSession = { access_token: "tok-alice", user: { id: "u-alice", email: "alice@example.com", name: "Alice" } };
const bob: AuthSession = { access_token: "tok-bob", user: { id: "u-bob", email: "bob@example.com", name: null } };

function fakeBackend(initial: AuthSession | null) {
  const listeners = new Set<(e: AuthChange, s: AuthSession | null) => void>();
  const state = { session: initial, refreshable: true, signOuts: 0, exchanged: [] as string[], links: [] as string[][] };
  const backend: AuthBackend = {
    getSession: async () => state.session,
    refreshSession: async () => {
      if (!state.refreshable || !state.session) return null;
      state.session = { ...state.session, access_token: `${state.session.access_token}+` };
      return state.session;
    },
    onChange(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    signInWithPassword: async (email, password) => {
      if (password !== "right") throw new AuthFailure("That email and password do not match.", "invalid_credentials");
      state.session = { access_token: "tok-new", user: { id: "u-alice", email, name: null } };
      return state.session;
    },
    sendMagicLink: async (email, redirectTo) => {
      state.links.push([email, redirectTo]);
    },
    signInWithOAuth: async () => {},
    exchangeCode: async (code) => {
      state.exchanged.push(code);
      if (code === "bad") throw new AuthFailure("The link has expired.");
      state.session = alice;
      return alice;
    },
    signOut: async () => {
      state.signOuts++;
      state.session = null;
    },
  };
  /** What another tab (or the token refresher) would cause. */
  const emit = (e: AuthChange, s: AuthSession | null) => {
    state.session = s;
    for (const l of [...listeners]) l(e, s);
  };
  return { backend, state, emit };
}

const status = () => useAuthStore.getState().status;

beforeEach(() => {
  resetAuthForTests();
  localStorage.clear();
});

describe("auth store", () => {
  it("starts loading, then signed in with the stored session", async () => {
    expect(status()).toBe("loading");
    const seen = vi.fn();
    onSignedIn(seen);
    await initAuth(fakeBackend(alice).backend);
    expect(useAuthStore.getState()).toMatchObject({ status: "signed-in", user: alice.user });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ user: alice.user, replaced: null });
  });

  it("is signed out when there is no session", async () => {
    await initAuth(fakeBackend(null).backend);
    expect(useAuthStore.getState()).toMatchObject({ status: "signed-out", user: null, notice: null });
  });

  it("an expired or invalid refresh token ends up signed out, and listeners clean up", async () => {
    // The page was painted for the user this browser last showed...
    assumeSignedIn(alice.user);
    expect(status()).toBe("signed-in");
    const out = vi.fn();
    onSignedOut(out);
    // ...but the stored session could not be refreshed.
    await initAuth(fakeBackend(null).backend);
    expect(status()).toBe("signed-out");
    expect(out).toHaveBeenCalledWith({ explicit: false });
  });

  it("token refreshes do not re-announce the same user", async () => {
    const { backend, emit } = fakeBackend(alice);
    const seen = vi.fn();
    onSignedIn(seen);
    await initAuth(backend);
    emit("token_refreshed", { ...alice, access_token: "tok-2" });
    emit("signed_in", alice);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(await getAccessToken()).toBe("tok-alice");
  });

  it("multi-tab: a sign-out in another tab signs this one out", async () => {
    const { backend, emit } = fakeBackend(alice);
    const out = vi.fn();
    onSignedOut(out);
    await initAuth(backend);
    emit("signed_out", null);
    expect(status()).toBe("signed-out");
    expect(out).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledWith({ explicit: false });
  });

  it("multi-tab: the session disappearing from storage signs this tab out", async () => {
    const { backend, state } = fakeBackend(alice);
    const out = vi.fn();
    onSignedOut(out);
    await initAuth(backend);
    state.session = null;
    // Unrelated keys are ignored.
    window.dispatchEvent(new StorageEvent("storage", { key: "mc-layout-v1", newValue: null }));
    expect(status()).toBe("signed-in");
    window.dispatchEvent(new StorageEvent("storage", { key: AUTH_STORAGE_KEY, newValue: null }));
    expect(status()).toBe("signed-out");
    expect(out).toHaveBeenCalledTimes(1);
  });

  it("multi-tab: another account signing in replaces this one, and says so", async () => {
    const { backend, emit } = fakeBackend(alice);
    const seen = vi.fn();
    onSignedIn(seen);
    await initAuth(backend);
    emit("signed_in", bob);
    expect(useAuthStore.getState().user).toEqual(bob.user);
    expect(seen).toHaveBeenLastCalledWith({ user: bob.user, replaced: "u-alice" });
  });

  it("signing out here is explicit, and reported once", async () => {
    const { backend, state, emit } = fakeBackend(alice);
    const out = vi.fn();
    onSignedOut(out);
    await initAuth(backend);
    await signOut();
    emit("signed_out", null); // the backend's own echo
    expect(state.signOuts).toBe(1);
    expect(out).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledWith({ explicit: true });
    expect(await getAccessToken()).toBeNull();
  });

  it("password sign-in: errors are shown, success signs in", async () => {
    const { backend } = fakeBackend(null);
    await initAuth(backend);
    await expect(signInWithPassword("alice@example.com", "wrong")).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(status()).toBe("signed-out");
    await signInWithPassword(" alice@example.com ", "right");
    expect(useAuthStore.getState()).toMatchObject({ status: "signed-in", user: { email: "alice@example.com" } });
  });

  it("the API refusing the token ends the session with a notice", async () => {
    const { backend, state } = fakeBackend(alice);
    const out = vi.fn();
    onSignedOut(out);
    await initAuth(backend);
    state.refreshable = false;
    expect(await refreshAccessToken()).toBeNull();
    handleAuthFailure();
    handleAuthFailure(); // several requests fail at once
    expect(useAuthStore.getState()).toMatchObject({ status: "signed-out", notice: "Your session ended. Sign in again to continue." });
    expect(out).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledWith({ explicit: false });
  });

  it("a backend that cannot load ends signed out, not loading forever", async () => {
    await initAuth(Promise.reject(new Error("chunk failed")));
    expect(status()).toBe("signed-out");
    expect(useAuthStore.getState().notice).toMatch(/Reload/);
  });
});

describe("auth callback", () => {
  it("takes the code out of the URL and restores the requested URL", async () => {
    window.history.replaceState(null, "", "/all/inbox/a%3Am1?q=invoice");
    rememberReturnUrl();
    window.history.replaceState(null, "", `${AUTH_CALLBACK_PATH}?code=abc123`);
    captureAuthCallback();
    expect(window.location.pathname + window.location.search).toBe("/all/inbox/a%3Am1?q=invoice");
    const cb = takeAuthCallback();
    expect(cb).toEqual({ code: "abc123", error: null });
    expect(takeAuthCallback()).toBeNull();

    const { backend, state } = fakeBackend(null);
    await initAuth(backend, { callback: cb });
    expect(state.exchanged).toEqual(["abc123"]);
    expect(status()).toBe("signed-in");
  });

  it("a failed exchange lands on the login screen with the reason", async () => {
    const { backend } = fakeBackend(null);
    await initAuth(backend, { callback: { code: "bad", error: null } });
    expect(status()).toBe("signed-out");
    expect(useAuthStore.getState().notice).toBe("That sign-in link did not work: The link has expired.");
  });

  it("a provider error is shown, and the URL falls back to the inbox", () => {
    window.history.replaceState(null, "", `${AUTH_CALLBACK_PATH}?error=access_denied&error_description=User+cancelled`);
    captureAuthCallback();
    expect(window.location.pathname).toBe("/");
    expect(takeAuthCallback()).toEqual({ code: null, error: "User cancelled" });
  });

  it("development only: an implicit-flow fragment is captured before the URL is cleaned, and adopted", async () => {
    window.history.replaceState(null, "", `${AUTH_CALLBACK_PATH}#access_token=AT&refresh_token=RT&type=magiclink`);
    captureAuthCallback();
    // The fragment is out of the address bar before any auth client exists.
    expect(window.location.pathname + window.location.hash).toBe("/");
    const cb = takeAuthCallback();
    expect(cb?.devImplicit).toEqual({ access_token: "AT", refresh_token: "RT" });

    const { backend, state } = fakeBackend(null);
    const adopted: unknown[] = [];
    backend.devAdoptSession = async (tokens) => {
      adopted.push(tokens);
      state.session = alice;
      return alice;
    };
    await initAuth(backend, { callback: cb });
    expect(adopted).toEqual([{ access_token: "AT", refresh_token: "RT" }]);
    expect(status()).toBe("signed-in");
  });

  it("outside development the fragment is ignored: no tokens are ever taken from a URL", async () => {
    window.history.replaceState(null, "", `${AUTH_CALLBACK_PATH}#access_token=AT&refresh_token=RT&type=magiclink`);
    captureAuthCallback(false);
    expect(window.location.pathname + window.location.hash).toBe("/");
    const cb = takeAuthCallback();
    expect(cb).toEqual({ code: null, error: null });
    // A production backend has no `devAdoptSession` at all.
    const { backend } = fakeBackend(null);
    await initAuth(backend, { callback: cb });
    expect(status()).toBe("signed-out");
  });

  it("never returns to a URL outside the app", () => {
    localStorage.setItem("mc-auth-return", JSON.stringify({ url: "//evil.example/x", at: Date.now() }));
    window.history.replaceState(null, "", `${AUTH_CALLBACK_PATH}?code=x`);
    captureAuthCallback();
    expect(window.location.pathname).toBe("/");
    takeAuthCallback();
  });

  it("magic links come back to /auth/callback on this origin", async () => {
    const { backend, state } = fakeBackend(null);
    await initAuth(backend);
    window.history.replaceState(null, "", "/all/sent");
    await sendMagicLink("alice@example.com");
    expect(state.links).toEqual([["alice@example.com", `${window.location.origin}/auth/callback`]]);
    expect(JSON.parse(localStorage.getItem("mc-auth-return") ?? "{}").url).toBe("/all/sent");
  });
});
