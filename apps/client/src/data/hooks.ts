import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { DEFAULT_PAGE_SIZE, getMailApi } from "../api";
import {
  type AssistantAllowance,
  type ContactHit,
  type DraftSummary,
  FOLDER_ROLE_LABEL,
  type FolderEntry,
  type FolderRef,
  type FolderRole,
  type Inbox,
  type InboxFailure,
  type MailboxScope,
  type MessageDetail,
  type MessageKey,
  type MessagePage,
  type MessageRow,
  type MessageThread,
  type PageCursor,
  type ScheduledSend,
  type ThreadPartialReason,
  folderRefId,
  parseKey,
  isProviderViewFolder,
} from "../api/types";
import { type InboxHealth, inboxHealth, usableInboxes } from "../api/inbox-health";
import { useDelayedFlag, useRested } from "../lib/hooks";
import { useAssistantStore } from "../state/assistant-store";
import { useReconnectStore } from "../state/connection-store";
import { holdRows, useHeldRows } from "../state/held-rows";
import { selectConversationView, useUiStore } from "../state/ui-store";
import { useConversationIndex } from "../state/conversation-store";
import { mergeThread } from "./conversations";
import { threadQueryId } from "./conversation-scope";
import { getVisibleKeys } from "../state/selection-store";
import { type ListData, findRow, folderRoleOf, resolveFolderEntry } from "./cache";
import { keys, listMeta } from "./keys";
import { loadListPage } from "./progressive";
import { FOLDERS_STALE_MS, STALE_MS } from "./query-client";
import { type MailActions, mailActions } from "./mail-actions";

/* ------------------------------------------------------------------
 * Inboxes and folders
 * ------------------------------------------------------------------ */

export function useInboxes() {
  return useQuery<Inbox[]>({
    queryKey: keys.inboxes,
    queryFn: ({ signal }) => getMailApi().listInboxes(signal),
    staleTime: 5 * 60_000,
  });
}

export type InboxWithHealth = Inbox & { health: InboxHealth };

const NO_INBOXES: InboxWithHealth[] = [];

/** Every mailbox of the session with what `/session` (and, between two
 *  sessions, the mail calls themselves) says about it. Mailboxes that are
 *  not `health.usable` are shown, never asked for mail. */
export function useInboxHealth(): InboxWithHealth[] {
  const { data: inboxes } = useInboxes();
  const refused = useReconnectStore((x) => x.inboxes);
  return useMemo(
    () => (inboxes ? inboxes.map((i) => ({ ...i, health: inboxHealth(i, refused[i.inbox_id] === true) })) : NO_INBOXES),
    [inboxes, refused],
  );
}

/** Ids of the mailboxes in scope that mail calls are made for. */
function useUsableIds(scope: MailboxScope): string[] {
  const { data: inboxes } = useInboxes();
  const refused = useReconnectStore((x) => x.inboxes);
  return useMemo(
    () =>
      usableInboxes(inboxes ?? [], refused)
        .filter((i) => scope === "all" || i.inbox_id === scope)
        .map((i) => i.inbox_id),
    [inboxes, refused, scope],
  );
}

export interface FolderNavItem {
  /** folderRefId(ref): stable key, also the `folderBump` key. */
  id: string;
  ref: FolderRef;
  label: string;
  role: FolderRole | null;
  kind: "system" | "custom";
  /** null when any inbox in scope could not count. */
  total: number | null;
  unread: number | null;
  /** The number the navigation shows: unread for Inbox, total for Drafts,
   *  Scheduled and custom folders, nothing (0) for the rest. */
  count: number;
}

/** Order of the system folders in the navigation. */
export const NAV_ROLES: readonly FolderRole[] = [
  "inbox",
  "starred",
  "drafts",
  "scheduled",
  "sent",
  "archive",
  "trash",
  "spam",
];

const sumNullable = (values: (number | null)[]): number | null => {
  let total = 0;
  for (const v of values) {
    if (v == null) return null;
    total += v;
  }
  return total;
};

const NO_FOLDERS: FolderEntry[] = [];

function useFolderEntries(inboxIds: string[]): (FolderEntry[] | undefined)[] {
  return useQueries({
    queries: inboxIds.map((id) => ({
      queryKey: keys.folders(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getMailApi().listFolders(id, signal),
      staleTime: FOLDERS_STALE_MS,
    })),
    // A mailbox whose folder list could not be loaded (it needs reconnecting,
    // say) has no folders to show: that is an answer, not "still loading",
    // so the navigation does not keep its skeleton rows forever.
    combine: (results) => results.map((r) => r.data ?? (r.isError ? NO_FOLDERS : undefined)),
  });
}

/** Folders for the navigation, merged across the inboxes in scope, with counts.
 *  System folders come first in NAV_ROLES order, then custom folders. In the
 *  unified scope custom folders are merged by name (`{ name }` refs); in a
 *  single-inbox scope they are exact (`{ inbox_id, folder_id }`). */
export function useFolders(scope: MailboxScope): { folders: FolderNavItem[]; isLoading: boolean } {
  const { data: inboxes } = useInboxes();
  // A mailbox that is down has no folders to show, and none are asked for.
  const inScope = useUsableIds(scope);
  const entries = useFolderEntries(inScope);
  const { data: scheduled } = useScheduled(scope);

  const folders = useMemo(() => {
    const perInbox = inScope.map((id, i) => ({ inbox_id: id, entries: entries[i] ?? [] }));
    const system: FolderNavItem[] = NAV_ROLES.map((role) => {
      const ref: FolderRef = { role };
      let total: number | null = null;
      let unread: number | null = null;
      if (role === "scheduled") {
        total = scheduled?.length ?? 0;
        unread = 0;
      } else if (role !== "starred") {
        const hits = perInbox.map((p) => resolveFolderEntry(p.entries, p.inbox_id, ref)).filter((f) => !!f);
        total = sumNullable(hits.map((f) => f.total_messages));
        unread = sumNullable(hits.map((f) => f.unread_messages));
      }
      const count = role === "inbox" ? (unread ?? 0) : role === "drafts" || role === "scheduled" ? (total ?? 0) : 0;
      return { id: folderRefId(ref), ref, label: FOLDER_ROLE_LABEL[role], role, kind: "system", total, unread, count };
    });

    const custom = new Map<string, FolderNavItem>();
    for (const p of perInbox) {
      for (const f of p.entries) {
        if (folderRoleOf(p.inbox_id, f) || isProviderViewFolder(f.id)) continue;
        const ref: FolderRef = scope === "all" ? { name: f.name } : { inbox_id: p.inbox_id, folder_id: f.id };
        const id = folderRefId(ref);
        const cur = custom.get(id);
        if (cur) {
          cur.total = sumNullable([cur.total, f.total_messages]);
          cur.unread = sumNullable([cur.unread, f.unread_messages]);
          cur.count = cur.total ?? 0;
        } else {
          custom.set(id, {
            id,
            ref,
            label: f.name,
            role: null,
            kind: "custom",
            total: f.total_messages,
            unread: f.unread_messages,
            count: f.total_messages ?? 0,
          });
        }
      }
    }
    return [...system, ...custom.values()];
  }, [inScope, entries, scheduled, scope]);

  return { folders, isLoading: !inboxes || entries.some((e) => e === undefined) };
}

/** Unread count of each mailbox's inbox, plus `all`. For the mailbox switcher. */
export function useInboxUnreadCounts(): Record<string, number> {
  const ids = useUsableIds("all");
  const entries = useFolderEntries(ids);
  return useMemo(() => {
    const out: Record<string, number> = { all: 0 };
    ids.forEach((id, i) => {
      const n = resolveFolderEntry(entries[i] ?? [], id, { role: "inbox" })?.unread_messages ?? 0;
      out[id] = n;
      out.all = (out.all ?? 0) + n;
    });
    return out;
  }, [ids, entries]);
}

/* ------------------------------------------------------------------
 * Message list
 * ------------------------------------------------------------------ */

export interface MessageListArgs {
  scope: MailboxScope;
  folder: FolderRef;
  /** Non-empty = search (the folder is ignored). */
  query?: string;
}

export interface MessageListResult {
  /** Flattened, de-duplicated, newest first. */
  rows: MessageRow[];
  /** null = unknown. Never render null as a number. */
  total: number | null;
  totalIsEstimate: boolean;
  /** True only when there is nothing cached for THIS list: show a skeleton. */
  isLoading: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  /** Call with the index of the last row on screen: loads more near the end. */
  onLastVisibleIndex: (index: number) => void;
  error: Error | null;
  /** Unified view: mailboxes that did not answer. The others are shown. */
  failedInboxes: InboxFailure[];
  /** Unified view: mailboxes whose first page is still on its way. The list
   *  shows the others' rows meanwhile and is not complete. */
  pendingInboxes: string[];
  /** Rows held back while the pointer is over the list (the pill counts them). */
  heldCount: number;
  refetch: () => void;
}

const NO_FAILURES: InboxFailure[] = [];

const byDateDesc = (a: MessageRow, b: MessageRow) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
const LOAD_MORE_WITHIN = 12;

/** The message list for one folder (or one search), paged as the user scrolls.
 *
 * Switching folders shows that folder's own cached rows at once, or a skeleton
 * when there are none. It never shows the previous folder's rows. */
export function useMessageList({ scope, folder, query = "" }: MessageListArgs): MessageListResult {
  const meta = useMemo(() => listMeta(scope, folder, query), [scope, folder, query]);
  const q = useInfiniteQuery<MessagePage, Error, ListData, readonly unknown[], PageCursor | null>({
    queryKey: keys.messages(meta),
    // The first page of a unified list is painted as each mailbox answers
    // (data/progressive.ts); every other page arrives whole.
    queryFn: ({ pageParam, signal, queryKey }) =>
      loadListPage(getMailApi(), {
        scope,
        folder,
        query: meta.query,
        cursor: pageParam,
        limit: DEFAULT_PAGE_SIZE,
        queryKey,
        signal,
        onArrived: holdUnderPointer,
      }),
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    staleTime: STALE_MS,
  });

  // Rows the assistant moved stay in place (faded) until cleared, even if a
  // background refetch has already dropped them from the server's answer.
  const ghosts = useAssistantStore((s) => s.ghosts);
  const held = useHeldRows((h) => h.keys);

  const { rows, heldCount } = useMemo(() => {
    const seen = new Set<MessageKey>();
    const out: MessageRow[] = [];
    let heldCount = 0;
    for (const page of q.data?.pages ?? []) {
      for (const r of page.rows) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        // Arrived late, under the pointer: behind the "N new emails" pill.
        if (held[r.key]) heldCount++;
        else out.push(r);
      }
    }
    if (!meta.query) {
      for (const key in ghosts) {
        const g = ghosts[key as MessageKey];
        if (!g?.row || seen.has(g.row.key)) continue;
        const from = g.from ? folderRefId(g.from) : (g.row.folder_role ?? "");
        const inScope = scope === "all" || scope === g.row.inbox_id;
        if (inScope && from === meta.folder) out.push(g.row);
      }
    }
    return { rows: out.sort(byDateDesc), heldCount };
  }, [q.data, ghosts, held, meta, scope]);

  const first = q.data?.pages[0];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;

  // Mailboxes that have not answered yet (a provisional first page). Only
  // while the fetch that will replace it is running.
  const pendingInboxes = q.isFetching && first?.pending_inboxes?.length ? first.pending_inboxes : NO_PENDING;
  // A provisional page with no fetch behind it (restored from the saved
  // cache, or its fetch was cancelled) would pass for a complete list.
  const orphaned = !q.isFetching && !q.isError && !!first?.pending_inboxes?.length;
  const { refetch } = q;
  useEffect(() => {
    if (orphaned) void refetch();
  }, [orphaned, refetch]);

  // Every page's failures: a mailbox that fails on a later page is named too.
  const failedInboxes = useMemo(() => {
    let out: InboxFailure[] | null = null;
    for (const page of q.data?.pages ?? []) {
      for (const f of page.failed_inboxes ?? []) {
        if (out?.some((x) => x.inbox_id === f.inbox_id)) continue;
        (out ??= []).push(f);
      }
    }
    return out ?? NO_FAILURES;
  }, [q.data]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const count = rows.length;
  const onLastVisibleIndex = useCallback(
    (index: number) => {
      if (index >= count - LOAD_MORE_WITHIN) loadMore();
    },
    [count, loadMore],
  );

  return {
    rows,
    total: first ? first.total : null,
    totalIsEstimate: first?.total_is_estimate ?? false,
    // Nothing to show yet and mailboxes still out: that is loading, not empty.
    isLoading: q.isPending || (rows.length === 0 && heldCount === 0 && (pendingInboxes.length > 0 || orphaned)),
    isFetching: q.isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage: loadMore,
    onLastVisibleIndex,
    error: q.error,
    failedInboxes,
    pendingInboxes,
    heldCount,
    refetch: () => void q.refetch(),
  };
}

const NO_PENDING: string[] = [];

/** Rows that arrived late are not put between the rows under the pointer:
 *  they wait behind the "N new emails" pill, exactly as new mail does. With
 *  the pointer elsewhere they go straight in, and the list's scroll anchoring
 *  keeps what is on screen where it is. */
function holdUnderPointer(arrived: MessageKey[]): void {
  if (!arrived.length) return;
  const ui = useUiStore.getState();
  if (ui.listHover && ui.viewport !== "phone") holdRows(arrived);
}

/* ------------------------------------------------------------------
 * One message
 * ------------------------------------------------------------------ */

/** A list row dressed as a detail, so the reader can paint before the body arrives. */
export function detailFromRow(row: MessageRow): MessageDetail {
  return {
    key: row.key,
    inbox_id: row.inbox_id,
    id: row.id,
    thread_id: row.thread_id,
    from: row.from,
    to: row.to,
    cc: [],
    bcc: [],
    reply_to: null,
    subject: row.subject,
    date: row.date,
    body_text: null,
    body_html: null,
    attachments: [],
    is_read: row.is_read,
    is_starred: row.is_starred,
    labels: [],
    in_reply_to: null,
    references: [],
    folder: row.folder,
    folder_role: row.folder_role,
    is_partial: true,
  };
}

function messageQuery(key: MessageKey) {
  const { inbox_id, id } = parseKey(key);
  return {
    queryKey: keys.message(key),
    queryFn: ({ signal }: { signal: AbortSignal }) => getMailApi().readMessage(inbox_id, id, { include_html: true }, signal),
    staleTime: STALE_MS,
  };
}

export interface MessageResult {
  /** The full message, or the list row as a partial (`is_partial`) while the
   *  body loads. Undefined only when nothing is known about the key. */
  message: MessageDetail | undefined;
  /** The body has not arrived yet. */
  isBodyPending: boolean;
  /** The body has been pending for over 300 ms: show the body skeleton now. */
  showBodySkeleton: boolean;
  error: Error | null;
  refetch: () => void;
}

/** The open message. Header fields come from the list row immediately; the
 *  body fills in when it arrives. Reading does not mark the message read. */
export function useMessage(key: MessageKey | null): MessageResult {
  const q = useQuery<MessageDetail>({
    ...(key ? messageQuery(key) : { queryKey: ["message", "none"], queryFn: () => Promise.reject(new Error("no key")) }),
    enabled: !!key,
    placeholderData: () => {
      const row = key ? findRow(key) : undefined;
      return row ? detailFromRow(row) : undefined;
    },
  });
  const isBodyPending = !!key && (q.isPlaceholderData || q.isPending) && !q.isError;
  // A read that failed (offline, a provider error) has no data and, being
  // settled, no placeholder either: the list row still says who and what, so
  // the reader shows the header and "could not be loaded" with Try again,
  // not "No email selected".
  const failedRow = key && !q.data && q.isError ? findRow(key) : undefined;
  return {
    message: key ? (q.data ?? (failedRow ? detailFromRow(failedRow) : undefined)) : undefined,
    isBodyPending,
    showBodySkeleton: useDelayedFlag(isBodyPending, 300),
    error: q.error,
    refetch: () => void q.refetch(),
  };
}

/* ------------------------------------------------------------------
 * One conversation
 * ------------------------------------------------------------------ */

export interface ConversationThreadResult {
  /** The conversation's messages, oldest first. From the list's own rows at
   *  once; the `thread` op adds what sits in other folders (Sent, Archive). */
  messages: MessageRow[];
  /** The `thread` op is still out. */
  isFetching: boolean;
  /** The server could not look everywhere: there may be more. */
  partial: boolean;
  /** Why, when `partial`. */
  partialReason: ThreadPartialReason | undefined;
  /** Asks for the thread again (one request). */
  retry: () => void;
}

const NO_ROWS: MessageRow[] = [];
/** How long a conversation must stay open before its thread is asked for:
 *  stepping through the list with j / k asks for none. */
export const THREAD_DWELL_MS = 250;

/** The open conversation. Paints from rows already in the cache; the `thread`
 *  op runs in the background and never blocks the body of the open message.
 *
 *  One request per conversation opened:
 *   - the query is keyed by the CONVERSATION (mailbox + conversation id), not
 *     by the row that stands for it, so moving between its messages, or a
 *     reply becoming its head, asks for nothing;
 *   - it is asked for only once the selection has rested THREAD_DWELL_MS;
 *   - moving on changes the key: the query loses its only observer and
 *     TanStack aborts the signal handed to the transport, so a superseded
 *     request is cancelled and its answer is never written to the cache. */
export function useConversationThread(key: MessageKey | null): ConversationThreadResult {
  const enabled = useUiStore(selectConversationView);
  const conv = useConversationIndex((s) => (key && enabled ? s.list.byKey.get(key) : undefined));
  // The row itself, for a message the list does not hold (a deep link).
  const anchor = conv?.head ?? (key ? findRow(key) : undefined);
  const threadKey = anchor?.thread_key;
  const queryKey =
    enabled && !!anchor && !!threadKey && anchor.folder_role !== "drafts" && anchor.folder_role !== "scheduled"
      ? keys.thread(anchor.inbox_id, threadQueryId(anchor, conv))
      : null;
  // The conversation as one value: the same for every message of it.
  const wanted = queryKey ? `${queryKey[1]}\u0001${queryKey[2]}` : null;
  const rested = useRested(wanted, THREAD_DWELL_MS);
  const q = useQuery<MessageThread>({
    queryKey: queryKey ?? ["thread", "none"],
    queryFn: ({ signal }) => getMailApi().getThread((anchor as MessageRow).key, { thread_key: threadKey }, signal),
    // Asked once the conversation has stayed open; a cached answer shows at once.
    enabled: wanted != null && rested,
    staleTime: STALE_MS,
    retry: false,
  });
  const listRows = useMemo(() => conv?.rows ?? (anchor ? [anchor] : NO_ROWS), [conv, anchor]);
  const data = wanted ? q.data : undefined;
  const threadRows = data?.rows ?? NO_ROWS;
  const messages = useMemo(() => mergeThread(listRows, threadRows), [listRows, threadRows]);
  const refetch = q.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);
  const partial = data?.partial === true;
  return {
    messages,
    isFetching: wanted != null && q.isFetching,
    partial,
    partialReason: partial ? data?.partial_reason : undefined,
    retry,
  };
}

export interface PrefetchHandlers {
  /** Hover / focus intent: prefetches after 50 ms. */
  onIntent: (key: MessageKey) => void;
  /** The pointer left before the delay passed. */
  onIntentEnd: () => void;
  /** Touch: prefetch immediately. */
  onTouch: (key: MessageKey) => void;
  prefetch: (key: MessageKey) => void;
}

export const PREFETCH_DELAY_MS = 50;
/** Hover prefetches in flight at once. More intent than that is dropped: the
 *  pointer has moved on, and opening a row fetches it anyway. */
export const PREFETCH_MAX_IN_FLIGHT = 3;

let prefetching = 0;

/** True when a slot was free. The slot is released when the fetch settles. */
function prefetchLimited(run: () => Promise<unknown>): boolean {
  if (prefetching >= PREFETCH_MAX_IN_FLIGHT) return false;
  prefetching++;
  void run().finally(() => {
    prefetching--;
  });
  return true;
}

/** Prefetches message bodies on intent so opening a row is instant. The
 *  returned handlers are stable: safe to pass to memoised rows. */
export function usePrefetchMessage(): PrefetchHandlers {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The row whose prefetch was started by hover and may still be cancelled. */
  const hovering = useRef<MessageKey | null>(null);

  const prefetch = useCallback(
    (key: MessageKey) => {
      const q = messageQuery(key);
      const state = qc.getQueryState(q.queryKey);
      // Nothing to do: already loading, or fresh enough.
      if (state?.fetchStatus === "fetching") return;
      if (state?.data !== undefined && !state.isInvalidated && Date.now() - state.dataUpdatedAt < STALE_MS) return;
      if (prefetchLimited(() => qc.prefetchQuery(q))) hovering.current = key;
    },
    [qc],
  );
  const onIntentEnd = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // The pointer left before the body arrived: stop the request, unless the
    // row was opened meanwhile (then someone is waiting for it).
    const key = hovering.current;
    hovering.current = null;
    if (!key) return;
    const queryKey = keys.message(key);
    const query = qc.getQueryCache().find({ queryKey, exact: true });
    if (query && query.getObserversCount() === 0 && query.state.fetchStatus === "fetching") {
      void qc.cancelQueries({ queryKey, exact: true });
    }
  }, [qc]);
  const onIntent = useCallback(
    (key: MessageKey) => {
      onIntentEnd();
      timer.current = setTimeout(() => prefetch(key), PREFETCH_DELAY_MS);
    },
    [onIntentEnd, prefetch],
  );
  useEffect(() => onIntentEnd, [onIntentEnd]);

  return useMemo(() => ({ onIntent, onIntentEnd, onTouch: prefetch, prefetch }), [onIntent, onIntentEnd, prefetch]);
}

/** Prefetches the rows just above and below the open one (j/k is then instant). */
export function usePrefetchNeighbours(selectedKey: MessageKey | null): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!selectedKey) return;
    const list = getVisibleKeys();
    const i = list.indexOf(selectedKey);
    if (i < 0) return;
    for (const k of [list[i + 1], list[i - 1]]) if (k) void qc.prefetchQuery(messageQuery(k));
  }, [qc, selectedKey]);
}

/* ------------------------------------------------------------------
 * Drafts, scheduled, contacts, allowance
 * ------------------------------------------------------------------ */

export type DraftListItem = DraftSummary & { inbox_id: string };

/** Drafts of every inbox in scope, newest first. Rows carry no body. */
export function useDrafts(scope: MailboxScope): { data: DraftListItem[]; isLoading: boolean } {
  const { data: inboxes } = useInboxes();
  const ids = useUsableIds(scope);
  const lists = useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.drafts(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getMailApi().listDrafts(id, signal),
      staleTime: STALE_MS,
    })),
    combine: (results) => results.map((r) => r.data),
  });
  const data = useMemo(() => {
    const out: DraftListItem[] = [];
    ids.forEach((inbox_id, i) => {
      for (const d of lists[i] ?? []) out.push({ ...d, inbox_id });
    });
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }, [ids, lists]);
  return { data, isLoading: !inboxes || lists.some((l) => l === undefined) };
}

export function useScheduled(scope: MailboxScope = "all") {
  return useQuery<ScheduledSend[], Error, ScheduledSend[]>({
    queryKey: keys.scheduled,
    queryFn: ({ signal }) => getMailApi().listScheduled(undefined, signal),
    staleTime: STALE_MS,
    select: useCallback(
      (all: ScheduledSend[]) => (scope === "all" ? all : all.filter((s) => s.inbox_id === scope)),
      [scope],
    ),
  });
}

/** Recipient autocomplete. The query is deferred so typing stays responsive. */
export function useContacts(query: string) {
  const deferred = useDeferredValue(query.trim());
  return useQuery<ContactHit[]>({
    queryKey: keys.contacts(deferred),
    queryFn: ({ signal }) => getMailApi().searchContacts(deferred, signal),
    enabled: deferred.length > 0,
    staleTime: 60_000,
    // Same kind of list for a longer query: keep the last hits while typing.
    placeholderData: (prev) => prev,
  });
}

export function useAssistantAllowance() {
  return useQuery<AssistantAllowance>({
    queryKey: keys.allowance,
    queryFn: ({ signal }) => getMailApi().getAssistantAllowance(signal),
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------
 * Actions
 * ------------------------------------------------------------------ */

/** Optimistic mailbox actions. A stable object: safe in deps and memo props. */
export function useMailActions(): MailActions {
  return mailActions;
}
