/* A tiny typed history router. No library: the app has one screen and a
 * handful of URL shapes.
 *
 *   /                                   -> /all/inbox
 *   /{mailbox}/{folder}                 mailbox = "all" | inbox_id
 *   /{mailbox}/{folder}/{messageKey}    messageKey = "{inbox_id}:{id}"
 *   ?q=...                              search (on any of the above)
 *   /compose                            new message; the mail location it was
 *                                       opened from rides in history.state
 *   /auth/callback                      sign-in return; replaced at once by the
 *                                       URL the visitor asked for (auth/callback.ts)
 *
 * {folder} is a FolderRef id (see folderRefId): a role ("inbox"), a custom
 * folder by name ("name:Receipts"), or one exact folder ("id:{inbox}:{folder}").
 * Every segment is URI-encoded.
 */

import { captureAuthCallback } from "../auth/callback";
import {
  type FolderRef,
  type MailboxScope,
  type MessageKey,
  folderRefId,
  parseFolderRefId,
} from "../api/types";

export interface Route {
  scope: MailboxScope;
  folder: FolderRef;
  messageKey: MessageKey | null;
  query: string;
  compose: boolean;
}

export const DEFAULT_ROUTE: Route = {
  scope: "all",
  folder: { role: "inbox" },
  messageKey: null,
  query: "",
  compose: false,
};

type MailLocation = Pick<Route, "scope" | "folder" | "messageKey" | "query">;

interface HistoryState {
  /** Where /compose was opened from, so closing it returns there. */
  mail?: { scope: string; folder: string; messageKey: string | null; query: string };
  /** Position of this entry among the entries this app created. 0 = the entry
   *  the app was entered on, so Back from it leaves the app. Lives in
   *  history.state, so it survives a reload and is right after Forward too. */
  idx?: number;
  /** A full-screen layer that is not part of the URL (the phone chat). */
  overlay?: string;
  /** URL of the entry underneath, recorded when this entry was pushed. */
  below?: string;
}

const dec = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseLocation(pathname: string, search: string, state?: unknown): Route {
  const query = new URLSearchParams(search).get("q") ?? "";
  const segs = pathname.split("/").filter(Boolean).map(dec);

  if (segs[0] === "compose") {
    const from = (state as HistoryState | null | undefined)?.mail;
    const folder = from ? parseFolderRefId(from.folder) : null;
    return {
      scope: from?.scope ?? DEFAULT_ROUTE.scope,
      folder: folder ?? DEFAULT_ROUTE.folder,
      messageKey: (from?.messageKey as MessageKey | null | undefined) ?? null,
      query: from?.query ?? query,
      compose: true,
    };
  }

  const scope: MailboxScope = segs[0] || "all";
  const folder = (segs[1] && parseFolderRefId(segs[1])) || DEFAULT_ROUTE.folder;
  const rawKey = segs[2];
  const messageKey = rawKey && rawKey.indexOf(":") > 0 ? (rawKey as MessageKey) : null;
  return { scope, folder, messageKey, query, compose: false };
}

export function buildPath(route: Route): string {
  const q = route.query ? `?q=${encodeURIComponent(route.query)}` : "";
  if (route.compose) return `/compose${q}`;
  const parts = [route.scope, folderRefId(route.folder)];
  if (route.messageKey) parts.push(route.messageKey);
  return `/${parts.map(encodeURIComponent).join("/")}${q}`;
}

function stateFor(route: Route): HistoryState {
  if (!route.compose) return {};
  return {
    mail: {
      scope: route.scope,
      folder: folderRefId(route.folder),
      messageKey: route.messageKey,
      query: route.query,
    },
  };
}

export function sameRoute(a: Route, b: Route): boolean {
  return buildPath(a) === buildPath(b) && sameMail(a, b);
}

function sameMail(a: MailLocation, b: MailLocation): boolean {
  return (
    a.scope === b.scope &&
    folderRefId(a.folder) === folderRefId(b.folder) &&
    a.messageKey === b.messageKey &&
    a.query === b.query
  );
}

type Listener = (route: Route, cause: "pop" | "navigate") => void;
const listeners = new Set<Listener>();
let current: Route | null = null;
let listening = false;

function historyState(): HistoryState {
  const st: unknown = typeof window === "undefined" ? null : window.history.state;
  return st && typeof st === "object" ? (st as HistoryState) : {};
}

function historyIndex(): number {
  const i = historyState().idx;
  return typeof i === "number" && i >= 0 ? i : 0;
}

function read(): Route {
  return parseLocation(window.location.pathname, window.location.search, window.history.state);
}

function ensureListening(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("popstate", () => {
    current = read();
    for (const l of [...listeners]) l(current, "pop");
  });
}

export function getRoute(): Route {
  if (typeof window === "undefined") return DEFAULT_ROUTE;
  if (!current) {
    // /auth/callback (OAuth, emailed link): the code is taken out of the URL
    // and the originally requested URL put back, before anything is parsed.
    captureAuthCallback();
    current = read();
  }
  return current;
}

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing one. */
  replace?: boolean;
}

/** Merges `patch` into the current route and writes it to the URL.
 *  A no-op when nothing changes, so it is safe to call from store actions. */
export function navigate(patch: Partial<Route>, opts: NavigateOptions = {}): Route {
  ensureListening();
  const prev = getRoute();
  const next: Route = { ...prev, ...patch };
  if (sameRoute(prev, next)) return prev;
  current = next;
  const url = buildPath(next);
  const idx = historyIndex();
  if (opts.replace) {
    const below = historyState().below;
    window.history.replaceState({ ...stateFor(next), idx, below }, "", url);
    if (idx > 0 && below === url) collapseSoon(idx, url);
  } else {
    window.history.pushState({ ...stateFor(next), idx: idx + 1, below: currentUrl() }, "", url);
  }
  for (const l of [...listeners]) l(next, "navigate");
  return next;
}

const currentUrl = (): string => window.location.pathname + window.location.search;

/* Closing something that was pushed (the reader on phone after an archive,
 * the compose form) is written as a REPLACE back to the URL it was opened
 * from. That leaves two identical entries, and the next Back would visibly do
 * nothing. So when a replace lands on exactly the URL of the entry underneath,
 * step back onto that entry instead. Deferred, and re-checked, so a navigation
 * made in the same tick wins and nothing is popped from under it. */
function collapseSoon(idx: number, url: string): void {
  setTimeout(() => {
    const st = historyState();
    if (st.idx === idx && st.below === url && !st.overlay && currentUrl() === url) window.history.back();
  }, 0);
}

/** True when Back stays inside the app. False on the entry the app was
 *  entered on (deep link, fresh tab): Back from there would leave. */
export function canGoBack(): boolean {
  return historyIndex() > 0;
}

/** Browser Back. On phone this is how the reader returns to the list. */
export function goBack(): void {
  window.history.back();
}

/** Rewrites the address bar to the canonical URL of the current route, so an
 *  unknown or sloppy URL ("/", "/nope/x/y/z") becomes "/all/inbox". Call once at boot. */
export function canonicalizeLocation(): void {
  if (typeof window === "undefined") return;
  const route = getRoute();
  const url = buildPath(route);
  if (url === window.location.pathname + window.location.search && !window.location.hash) return;
  window.history.replaceState({ ...historyState(), ...stateFor(route) }, "", url);
}

/** Phone, at boot: a deep link straight to a message (or /compose) gets the
 *  list entry put underneath it, so Back shows the list instead of leaving
 *  the app. Does nothing when there already is an in-app entry behind. */
export function ensureBackStack(): void {
  if (typeof window === "undefined") return;
  const route = getRoute();
  if (canGoBack() || (!route.messageKey && !route.compose)) return;
  const base: Route = { ...route, messageKey: null, compose: false };
  window.history.replaceState({ ...stateFor(base), idx: 0 }, "", buildPath(base));
  window.history.pushState({ ...stateFor(route), idx: 1, below: buildPath(base) }, "", buildPath(route));
}

/* ---- overlays: full-screen layers that Back should close but that have no
 * URL of their own (the phone chat). The entry keeps the same URL. ---- */

export function currentOverlay(): string | null {
  return historyState().overlay ?? null;
}

/** Pushes an entry for an overlay. A no-op if that overlay is already on top. */
export function pushOverlay(name: string): void {
  if (typeof window === "undefined" || currentOverlay() === name) return;
  ensureListening();
  const st = historyState();
  window.history.pushState({ ...st, idx: historyIndex() + 1, overlay: name, below: currentUrl() }, "", window.location.href);
}

/** The overlay was closed from the UI: drop its entry. */
export function popOverlay(name: string): void {
  if (typeof window !== "undefined" && currentOverlay() === name) window.history.back();
}

export function subscribeRoute(listener: Listener): () => void {
  ensureListening();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper: forget the cached route so the next read parses the URL again. */
export function resetRouterForTests(): void {
  current = null;
}
