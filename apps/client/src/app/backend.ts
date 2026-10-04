import { ApiError, isAbortError, setAssistantTransport, setMailApi } from "../api";
import type { ApprovalDraft } from "../api/assistant-api";
import { ApiClient } from "../api/http/client";
import { HttpAssistantTransport } from "../api/http/http-assistant";
import { HttpMailApi } from "../api/http/http-mail-api";
import { hasServerStatus, inboxHealth, usableInboxes } from "../api/inbox-health";
import type { Inbox, MessageDetail, SessionInfo } from "../api/types";
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
  onTokenRefreshed,
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
import { SYNC_INTERVAL_LIVE_MS, SYNC_INTERVAL_MS, type SyncEngine, createSyncEngine } from "../data/sync";
import { clearUndo } from "../data/undo";
import { VAPID_PUBLIC_KEY, getPlatform } from "../platform";
import { useAssistantStore } from "../state/assistant-store";
import { type ComposeState, useComposeStore } from "../state/compose-store";
import { markInboxAuth, useConnectionStore, useReconnectStore } from "../state/connection-store";
import { releaseHeldRows } from "../state/held-rows";
import { useSelectionStore } from "../state/selection-store";
import { useToastStore } from "../state/toast-store";
import { type PushController, createPushController } from "./push";
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
let push: PushController | null = null;
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

/** Web push for this account (HTTP mode only; null in mock mode). */
export function getPushController(): PushController | null {
  return push;
}

/** One sync run now (a push arrived, or a notification was clicked). */
export function syncNow(): void {
  if (syncWanted) void sync?.syncNow();
}

/* Which mailboxes need reconnecting, kept across reloads (ids only): a load
 * must not wait seconds for a mailbox that is known to refuse. */
const REFUSED_KEY = "mc-refused";

export function readRefused(workspace_id: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(REFUSED_KEY) ?? "null") as { workspace_id?: unknown; ids?: unknown } | null;
    if (!v || v.workspace_id !== workspace_id || !Array.isArray(v.ids)) return [];
    return v.ids.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function writeRefused(ids: string[]): void {
  try {
    if (ids.length && workspaceId) localStorage.setItem(REFUSED_KEY, JSON.stringify({ workspace_id: workspaceId, ids }));
    else localStorage.removeItem(REFUSED_KEY);
  } catch {
    /* private mode: the next load asks the mailbox again */
  }
}

/** Mailboxes the current session itself calls down (`status` from `/session`). */
function serverDown(): string[] {
  const inboxes = useSessionStore.getState().session?.inboxes ?? [];
  return inboxes.filter((i) => i.status !== undefined && !inboxHealth(i).usable).map((i) => i.inbox_id);
}

function persistRefused(): void {
  writeRefused([...new Set([...serverDown(), ...Object.keys(useReconnectStore.getState().inboxes)])]);
}

/** When `/session` was last asked why a mailbox started refusing, per mailbox. */
const askedWhy = new Map<string, number>();
const ASK_WHY_GAP_MS = 2 * 60_000;

/** A mail call said whether its mailbox accepts the stored credentials.
 *
 * `/session` is the authority on that (per-inbox `status`): this only fills
 * the gap between two sessions. A mailbox that starts refusing mid-session is
 * marked here at once and the session asked for the reason; one the session
 * calls down and whose probe now succeeds is put back at once. */
function onInboxAuth(inbox_id: string, needsReconnect: boolean): void {
  const inbox = useSessionStore.getState().session?.inboxes.find((i) => i.inbox_id === inbox_id);
  const saidDown = !!inbox && inbox.status !== undefined && !inboxHealth(inbox).usable;
  const was = useReconnectStore.getState().inboxes[inbox_id] === true;
  if (needsReconnect) {
    // Nothing new: the session, or an earlier call, already said so.
    if (saidDown || was) return;
    markInboxAuth(inbox_id, true);
    persistRefused();
    // The server knows which kind of refusal it was: its copy replaces ours.
    if (inbox?.status !== undefined && Date.now() - (askedWhy.get(inbox_id) ?? -Infinity) > ASK_WHY_GAP_MS) {
      askedWhy.set(inbox_id, Date.now());
      void loadSession();
    }
    return;
  }
  if (!saidDown && !was) return;
  if (was) markInboxAuth(inbox_id, false);
  if (saidDown) {
    const next = api?.markInboxOk(inbox_id);
    if (next) {
      queryClient.setQueryData(keys.session, next);
      queryClient.setQueryData(keys.inboxes, next.inboxes);
      useSessionStore.setState({ session: next });
    }
  }
  persistRefused();
  // Reconnected: what was loaded without it is loaded again.
  refreshLists((meta) => meta.scope === "all" || meta.scope === inbox_id);
  void queryClient.invalidateQueries({ queryKey: keys.folders(inbox_id) });
}

/** Everything a previous user could have left in memory. */
function resetStores(opts: { location: boolean }): void {
  useAssistantStore.getState().reset();
  releaseHeldRows();
  if (opts.location) {
    useReconnectStore.setState({ inboxes: {} });
    writeRefused([]);
  }
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
          // The Bcc the person had typed on the draft this run started with.
          bcc: d.bcc ?? "",
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
  // Which mailboxes worked before this answer (as the app was treating them).
  const usableIds = (inboxes: readonly Inbox[], refused: Readonly<Record<string, true>>) =>
    usableInboxes(inboxes, refused)
      .map((i) => i.inbox_id)
      .sort()
      .join(",");
  const usableBefore = before ? usableIds(before.inboxes, useReconnectStore.getState().inboxes) : null;
  useSessionStore.setState({ session: s, status: "ready", fromCache: false, errorCode: null });
  if (hasServerStatus(s.inboxes)) {
    // The server's word replaces what mail calls were remembered to have said.
    if (Object.keys(useReconnectStore.getState().inboxes).length) useReconnectStore.setState({ inboxes: {} });
    persistRefused();
  }
  // Folder lists nobody has yet are asked for NOW, in the same tick as the
  // message lists and `status` that were waiting for this answer, so a cold
  // boot is one batch request and not a second one after the next render.
  const mail = api;
  if (mail) {
    // Not for a mailbox the session calls down: nothing is asked of those.
    for (const inbox of usableInboxes(s.inboxes)) {
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
  const usableNow = usableIds(s.inboxes, useReconnectStore.getState().inboxes);
  if (before && ids(before) !== ids(s)) refreshLists((meta) => meta.scope === "all");
  else if (usableBefore != null && usableBefore !== usableNow) {
    // A mailbox went down or came back: lists that include it are rebuilt
    // (its own, and the unified ones), and a mailbox that is back gets its
    // folders asked for again.
    const was = new Set(usableBefore.split(","));
    const now = new Set(usableNow.split(","));
    const changed = new Set([...was, ...now].filter((id) => id && was.has(id) !== now.has(id)));
    refreshLists((meta) => meta.scope === "all" || changed.has(meta.scope));
    for (const id of changed) if (now.has(id)) void queryClient.invalidateQueries({ queryKey: keys.folders(id) });
  }
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
    // Another account signed in over the one this tab was showing. The open
    // socket holds the previous account's token: it is closed, not re-used.
    client?.disconnect();
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
  // Opened alongside `/session`, which goes over HTTP: nothing waits for it.
  client?.connect();
  void loadSession();
}

async function onSignOut(info: SignedOutInfo): Promise<void> {
  sync?.stop();
  // However the session ended, this browser stops receiving the account's
  // notifications: its push subscription is ended (there may be no token left
  // to tell the server with; the push service then reports it gone).
  void push?.signOut({ authed: false }).catch(() => {});
  client?.disconnect();
  api?.reset();
  transport?.reset();
  workspaceId = null;
  sessionLoad = null;
  clearIdentity();
  writeRefused([]);
  askedWhy.clear();
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
    onInboxAuth,
    // Unit tests of this module run against a fake `fetch`; they must not dial.
    socket: import.meta.env.MODE === "test" ? false : { onDiagnostics: (d) => useConnectionStore.setState(d) },
  });
  const socketClient = client;
  onTokenRefreshed((token) => socketClient.tokenRefreshed(token));
  const mail = new HttpMailApi({ client });
  api = mail;
  mail.onSession(applySession);
  const pushClient = client;
  push = createPushController({
    platform: getPlatform,
    request: (method, path, body) => pushClient.request(method, path, body),
    apiBase: config.apiBase,
    vapidPublicKey: VAPID_PUBLIC_KEY,
    workspaceId: () => workspaceId,
  });
  // Every session the server answers with: make sure it has this browser's
  // current push subscription for this workspace (a no-op unless
  // notifications were turned on here).
  const pushSync = push;
  mail.onSession(() => void pushSync.sync().catch(() => {}));
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
    const refused = readRefused(hint.workspace_id);
    if (refused.length) {
      client?.seedRefused(refused);
      useReconnectStore.setState({ inboxes: Object.fromEntries(refused.map((id) => [id, true as const])) });
    }
    void initAuth(backend, { callback });
    // The socket handshake starts now, next to the cache restore and the
    // first HTTP requests. They do not wait for it.
    client?.connect();
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
  // While there is still a token: remove this browser's push subscription
  // from the server, so no notification about this account reaches it again.
  if (push) await Promise.race([push.signOut({ authed: true }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  await signOut();
}

/** Starts the sync engine (called once the mail UI is mounted). */
export function startSync(): () => void {
  if (!api) return () => {};
  const mail = api;
  sync ??= createSyncEngine({
    api: mail,
    inboxIds: () => (mail.peekSession()?.inboxes ?? []).map((i) => i.inbox_id),
    intervalMs: () => (client?.socketLive ? SYNC_INTERVAL_LIVE_MS : SYNC_INTERVAL_MS),
  });
  const engine = sync;
  syncWanted = true;
  // Coming back to the tab (perhaps from reconnecting a mailbox in the
  // dashboard): the sync run that follows asks refused mailboxes again.
  // Registered before the engine's own listeners, so it runs first.
  let recheckedAt = 0;
  const recheck = () => {
    if (document.visibilityState === "hidden") return;
    client?.recheckRefused();
    // The session says which mailboxes are down, and is the first to say one
    // is back: ask it again too (focus and visibility fire together: once).
    const s = useSessionStore.getState().session;
    const anyDown = !!s && usableInboxes(s.inboxes, useReconnectStore.getState().inboxes).length < s.inboxes.length;
    if (anyDown && Date.now() - recheckedAt > 5000) {
      recheckedAt = Date.now();
      void loadSession();
    }
  };
  window.addEventListener("focus", recheck);
  document.addEventListener("visibilitychange", recheck);
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
    window.removeEventListener("focus", recheck);
    document.removeEventListener("visibilitychange", recheck);
    off();
    offNetwork();
    syncWanted = false;
    engine.stop();
  };
}
