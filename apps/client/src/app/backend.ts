import { ApiError, isAbortError, setAssistantTransport, setMailApi } from "../api";
import type { ApprovalDraft } from "../api/assistant-api";
import { ApiClient } from "../api/http/client";
import { HttpAssistantTransport } from "../api/http/http-assistant";
import { HttpMailApi } from "../api/http/http-mail-api";
import type { MessageDetail, SessionInfo } from "../api/types";
import {
  type AuthBackend,
  EMPTY_SESSION,
  type SignedInInfo,
  type SignedOutInfo,
  assumeSignedIn,
  clearIdentity,
  getAccessToken,
  handleAuthFailure,
  hasStoredAuthSession,
  initAuth,
  onSignedIn,
  onSignedOut,
  readIdentity,
  refreshAccessToken,
  signOut,
  takeAuthCallback,
  useAuthStore,
  useSessionStore,
  writeIdentity,
} from "../auth";
import { config } from "../config";
import { findRow, refreshLists } from "../data/cache";
import { keys } from "../data/keys";
import { flushPendingSends, mailActions } from "../data/mail-actions";
import {
  cacheNamespaceOf,
  dropMemoryCache,
  getCacheNamespace,
  FOLDERS_STALE_MS,
  purgeAllCaches,
  queryClient,
  restoreQueryCache,
  setCacheNamespace,
} from "../data/query-client";
import { applyKeyRemap } from "../data/remap";
import { type SyncEngine, createSyncEngine } from "../data/sync";
import { clearUndo } from "../data/undo";
import { getPlatform } from "../platform";
import { useAssistantStore } from "../state/assistant-store";
import { type ComposeState, useComposeStore } from "../state/compose-store";
import { useSelectionStore } from "../state/selection-store";
import { useToastStore } from "../state/toast-store";
import { DEFAULT_ROUTE, getRoute, navigate } from "./router";

/* HTTP mode wiring: the one place where auth, the API client, the session,
 * the cache namespace and the in-memory stores meet.
 *
 * Boot (see bootHttp):
 *   1. If this browser was signed in before, the app is shown for that user
 *      at once, painted from that user's cache namespace. No network yet.
 *   2. In parallel: the auth client checks the session, `GET /session` goes
 *      out, and (when the cached session names the inboxes) the first batch
 *      of reads goes out with it rather than after it.
 *   3. `/session` answers: the cache is reconciled with it.
 * Sign-out, an ended session, another user or another workspace: everything
 * in memory is dropped first, so no account ever sees another's mail.
 */

let client: ApiClient | null = null;
let api: HttpMailApi | null = null;
let transport: HttpAssistantTransport | null = null;
let sync: SyncEngine | null = null;
let workspaceId: string | null = null;
let sessionLoad: Promise<void> | null = null;
let installed = false;
/** The mail UI is mounted (the sync engine should be running). */
let syncWanted = false;

const CACHE_BUDGET_MS = 250;
const AUTH_WATCHDOG_MS = 15_000;
const FOLDERS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FOLDERS_REFRESH_DELAY_MS = 5000;

export function getHttpMailApi(): HttpMailApi | null {
  return api;
}

/** Everything a previous user could have left in memory. */
function resetStores(opts: { location: boolean }): void {
  useAssistantStore.getState().reset();
  if (useComposeStore.getState().compose) useComposeStore.setState({ compose: null });
  useToastStore.getState().dismiss();
  clearUndo();
  if (opts.location) {
    useSelectionStore.setState({ scope: "all", folder: { role: "inbox" }, query: "", selectedKey: null, multiSel: [], ctxOff: false });
    navigate({ ...DEFAULT_ROUTE }, { replace: true });
  } else {
    useSelectionStore.setState({ multiSel: [], ctxOff: false });
  }
}

function sendApproved(d: ApprovalDraft): void {
  const c = useComposeStore.getState().compose;
  // What the person approved is the draft on screen (they may have reopened
  // it); the assistant's copy is used only when that form is gone.
  const same = !!c && (d.reply_to ? c.replyTo === d.reply_to : !c.replyTo);
  const draft: ComposeState =
    same && c
      ? { ...c, held: undefined }
      : {
          // The op the assistant asked for: a reply threads, a new message does not.
          mode: d.reply_to ? (d.kind === "reply_all" || d.kind === "forward" ? d.kind : "reply") : "new",
          inbox_id: d.inbox_id,
          to: d.to,
          cc: d.cc ?? "",
          bcc: "",
          subject: d.subject,
          body: d.body,
          replyTo: d.reply_to,
          ai: true,
        };
  if (!mailActions.send(draft)) throw new Error("The draft could not be sent as it is.");
}

/** Applies a `/session` answer: namespace, identity hint, caches, stores. */
function applySession(s: SessionInfo): void {
  const ns = cacheNamespaceOf(s.user.id, s.workspace_id);
  const current = getCacheNamespace();
  if (current !== ns) {
    // First load on this browser, or the server chose another workspace than
    // the one the cache was painted from: that paint was not this session's.
    if (current != null) {
      dropMemoryCache();
      resetStores({ location: true });
    }
    setCacheNamespace(ns);
  }
  const before = useSessionStore.getState().session;
  workspaceId = s.workspace_id;
  const user = useAuthStore.getState().user ?? { id: s.user.id, email: s.user.email, name: s.user.display_name };
  writeIdentity({ user: { ...user, name: user.name ?? s.user.display_name }, workspace_id: s.workspace_id });
  queryClient.setQueryData(keys.session, s);
  queryClient.setQueryData(keys.inboxes, s.inboxes);
  queryClient.setQueryData(keys.allowance, s.allowance);
  useSessionStore.setState({ session: s, status: "ready", fromCache: false, errorCode: null });
  // Folder lists nobody has yet are asked for NOW, in the same tick as the
  // message lists and `status` that were waiting for this answer, so a cold
  // boot is one batch request and not a second one after the next render.
  const mail = api;
  if (mail) {
    for (const inbox of s.inboxes) {
      const key = keys.folders(inbox.inbox_id);
      if (queryClient.getQueryData(key) !== undefined) continue;
      void queryClient.prefetchQuery({
        queryKey: key,
        queryFn: ({ signal }) => mail.listFolders(inbox.inbox_id, signal),
        staleTime: FOLDERS_STALE_MS,
      });
    }
  }

  // The set of mailboxes changed since the cached session: unified lists
  // were merged from the old set.
  const ids = (x: SessionInfo | null) => (x?.inboxes ?? []).map((i) => i.inbox_id).sort().join(",");
  if (before && ids(before) !== ids(s)) refreshLists((meta) => meta.scope === "all");
}

/** `GET /session`. Never throws: the outcome is in the session store. */
export function loadSession(): Promise<void> {
  if (!api) return Promise.resolve();
  if (sessionLoad) return sessionLoad;
  const mine = api;
  // The last error stays on screen until this attempt has an answer.
  useSessionStore.setState((st) => ({ status: st.session ? st.status : "loading" }));
  const attempt = async (retried: boolean): Promise<void> => {
    try {
      await mine.getSession();
    } catch (err) {
      if (isAbortError(err) || api !== mine) return;
      const code = err instanceof ApiError ? err.code : "error";
      // The remembered workspace is no longer ours: let the server choose.
      if ((code === "forbidden" || code === "invalid_request") && workspaceId && !retried) {
        workspaceId = null;
        return attempt(true);
      }
      if (code === "unauthenticated") return; // the auth store is signing out
      useSessionStore.setState({ status: "error", errorCode: code });
    }
  };
  sessionLoad = attempt(false).finally(() => {
    sessionLoad = null;
  });
  return sessionLoad;
}

async function onSignIn(info: SignedInInfo): Promise<void> {
  if (info.replaced) {
    // Another account signed in over the one this tab was showing.
    api?.reset();
    transport?.reset();
    await purgeAllCaches();
    resetStores({ location: true });
    workspaceId = null;
    clearIdentity();
    useSessionStore.setState(EMPTY_SESSION);
  }
  const hint = readIdentity();
  if (hint && hint.user.id !== info.user.id) {
    clearIdentity();
    workspaceId = null;
  }
  void loadSession();
}

async function onSignOut(info: SignedOutInfo): Promise<void> {
  sync?.stop();
  api?.reset();
  transport?.reset();
  workspaceId = null;
  sessionLoad = null;
  clearIdentity();
  useSessionStore.setState(EMPTY_SESSION);
  // An ended session keeps the URL, so signing in again returns to it.
  resetStores({ location: info.explicit });
  await purgeAllCaches();
}

/** Creates the HTTP MailApi and assistant transport and makes them the app's. */
export function installHttpBackend(): HttpMailApi {
  if (api && installed) return api;
  installed = true;
  client = new ApiClient({
    baseUrl: config.apiBase,
    getToken: getAccessToken,
    refreshToken: refreshAccessToken,
    onAuthFailure: handleAuthFailure,
    getWorkspaceId: () => workspaceId,
    isOnline: () => getPlatform().network.isOnline(),
  });
  const mail = new HttpMailApi({ client });
  api = mail;
  mail.onSession(applySession);
  transport = new HttpAssistantTransport({
    client,
    sendApproved,
    moveMessages: (k, to) => mail.moveMessages(k, to),
    setFlags: (k, flags) => mail.setFlags(k, flags),
    onMoved: (pairs) => applyKeyRemap(pairs),
    folderOf: (key) => (findRow(key)?.folder ?? queryClient.getQueryData<MessageDetail>(keys.message(key))?.folder) || undefined,
  });
  setMailApi(mail);
  setAssistantTransport(transport);
  onSignedIn(onSignIn);
  onSignedOut(onSignOut);
  return mail;
}

/** HTTP mode, before the first render. Resolves as soon as there is
 *  something to paint: it never waits for the network. */
export async function bootHttp(loadBackend: () => Promise<AuthBackend>): Promise<void> {
  const mail = installHttpBackend();
  // Reading the route first takes a sign-in callback out of the URL.
  getRoute();
  const callback = takeAuthCallback();
  const backend = loadBackend();
  const hint = readIdentity();

  if (hint && hasStoredAuthSession() && !callback) {
    assumeSignedIn(hint.user);
    workspaceId = hint.workspace_id;
    setCacheNamespace(cacheNamespaceOf(hint.user.id, hint.workspace_id));
    void initAuth(backend, { callback });
    const restored = restoreQueryCache().then(() => {
      const cached = queryClient.getQueryData<SessionInfo>(keys.session);
      // Only while the server has not answered yet (a slow IndexedDB).
      if (cached && !useSessionStore.getState().session && getCacheNamespace() === cacheNamespaceOf(hint.user.id, hint.workspace_id)) {
        mail.seedSession(cached);
        useSessionStore.setState({ session: cached, status: "ready", fromCache: true, errorCode: null });
      }
    });
    await Promise.race([restored, new Promise((r) => setTimeout(r, CACHE_BUDGET_MS))]);
    void loadSession();
    return;
  }
  // Nobody to assume: the gate shows a neutral frame until auth answers
  // (local unless a token needs refreshing), then the login screen or the app.
  void initAuth(backend, { callback });
  // Never an endless blank frame: if auth has not answered, offer sign-in.
  setTimeout(() => {
    if (useAuthStore.getState().status === "loading") {
      useAuthStore.setState({ status: "signed-out", user: null, notice: "Checking your session took too long. Sign in to continue." });
    }
  }, AUTH_WATCHDOG_MS);
}

export function switchWorkspace(id: string): Promise<void> {
  const user = useAuthStore.getState().user;
  if (!api || !user || id === workspaceId) return Promise.resolve();
  api.reset();
  transport?.reset();
  dropMemoryCache();
  resetStores({ location: true });
  workspaceId = id;
  sessionLoad = null;
  writeIdentity({ user, workspace_id: id });
  setCacheNamespace(cacheNamespaceOf(user.id, id));
  useSessionStore.setState({ session: null, status: "loading", fromCache: false, errorCode: null });
  const mail = api;
  return restoreQueryCache().then(() => {
    const cached = queryClient.getQueryData<SessionInfo>(keys.session);
    if (cached?.workspace_id === id && !useSessionStore.getState().session) {
      mail.seedSession(cached);
      useSessionStore.setState({ session: cached, status: "ready", fromCache: true });
    }
    if (syncWanted) {
      sync?.stop();
      sync?.start();
    }
    return loadSession();
  });
}

/** Sign out here: pending sends go out first, then everything is forgotten. */
export async function signOutEverywhere(): Promise<void> {
  await Promise.race([flushPendingSends(), new Promise((r) => setTimeout(r, 4000))]);
  await signOut();
}

/** Starts the sync engine (called once the mail UI is mounted). */
export function startSync(): () => void {
  if (!api) return () => {};
  const mail = api;
  sync ??= createSyncEngine({
    api: mail,
    inboxIds: () => (mail.peekSession()?.inboxes ?? []).map((i) => i.inbox_id),
  });
  const engine = sync;
  syncWanted = true;
  engine.start();
  // Folder lists are kept across reloads and corrected by `status`, which
  // cannot see a folder that was added or removed. Old lists are refreshed
  // in the background, after the first paint's own requests.
  const refreshOldFolders = setTimeout(() => {
    for (const q of queryClient.getQueryCache().findAll({ queryKey: keys.foldersRoot })) {
      if (q.state.data !== undefined && Date.now() - q.state.dataUpdatedAt > FOLDERS_MAX_AGE_MS) {
        void queryClient.invalidateQueries({ queryKey: q.queryKey, exact: true });
      }
    }
  }, FOLDERS_REFRESH_DELAY_MS);
  // The inbox list may only arrive with the session: look again then.
  const off = mail.onSession(() => void engine.syncNow());
  // Back online: what failed to load while offline is asked for again.
  const network = getPlatform().network;
  let wasOnline = network.isOnline();
  const offNetwork = network.subscribe(() => {
    const online = network.isOnline();
    if (online && !wasOnline) {
      void queryClient.refetchQueries({ type: "active", predicate: (q) => q.state.status === "error" || q.state.error != null });
      if (!useSessionStore.getState().session || useSessionStore.getState().fromCache) void loadSession();
    }
    wasOnline = online;
  });
  return () => {
    clearTimeout(refreshOldFolders);
    off();
    offNetwork();
    syncWanted = false;
    engine.stop();
  };
}
