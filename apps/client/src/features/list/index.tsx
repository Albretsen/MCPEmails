import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, ChevronDown, Inbox as InboxIcon, Pause, PenLine, Search, X } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type UIEvent,
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isApiError } from "../../api";
import { type Inbox, type MessageKey, type MessageRow, folderRefId, isRoleRef, parseFolderRefId } from "../../api/types";
import {
  type FolderNavItem,
  flushPendingNew,
  mailActions,
  useFolders,
  useInboxes,
  useMessageList,
  usePrefetchMessage,
  usePrefetchNeighbours,
} from "../../data";
import { DASHBOARD_URL } from "../../config";
import { pluralize } from "../../lib/format";
import { useDelayedFlag } from "../../lib/hooks";
import { useAssistantStore } from "../../state/assistant-store";
import { selectHasMulti, setVisibleKeys, useSelectionStore } from "../../state/selection-store";
import { Button, EmptyState, Kbd, Skeleton } from "../../ui";
import { SEARCH_INPUT_ATTR, useShell } from "../shell";
import s from "./List.module.css";
import { READ_ONLY_EXPLANATION, useCanWrite } from "../../state/permissions";
import { openRow } from "./open-row";
import { Row, rowDomId } from "./Row";
import { anchoredOffset, emptyState, folderRefLabel, indexByKey, listCountText, listSetSize, listTitle, phoneNavValue, rowView } from "./model";
import { useListInteractions } from "./useListInteractions";

/* The message list: search, title and count, a virtualised listbox with every
 * row state of the design, the "N new emails" pill, the hold note and, on
 * phone, the compose button. Content of the labelled <section> the shell owns. */

/** Fixed row heights (the virtualiser never measures the DOM). */
export const ROW_HEIGHT = 76;
export const ROW_HEIGHT_TOUCH = 84;
const OVERSCAN = 8;
/** A skeleton is shown only when nothing is cached and the answer is slow. */
const SKELETON_DELAY_MS = 300;

/** Scroll offset per (scope, folder, query), restored when you come back. */
const scrollOffsets = new Map<string, number>();

const EMPTY_BOX_NAMES: Record<string, string> = {};

export function ListPane() {
  const { phone } = useShell();
  const scope = useSelectionStore((x) => x.scope);
  const folder = useSelectionStore((x) => x.folder);
  const query = useSelectionStore((x) => x.query);
  const selectedKey = useSelectionStore((x) => x.selectedKey);
  const multi = useSelectionStore(selectHasMulti);
  const mayWrite = useCanWrite();
  // Search as you type: the field stays instant, the list follows when it can.
  const deferredQuery = useDeferredValue(query);

  const { data: inboxes } = useInboxes();
  const { folders } = useFolders(scope);
  const list = useMessageList({ scope, folder, query: deferredQuery });
  const { rows } = list;
  const prefetch = usePrefetchMessage();
  usePrefetchNeighbours(selectedKey);

  const pendingCount = useAssistantStore((a) => a.pendingNew.length);
  const holdNote = useAssistantStore((a) => a.holdNote);
  // Changes only when the assistant or the server removes rows, never on hover.
  const leaving = useAssistantStore((a) => a.leaving);

  const folderId = folderRefId(folder);
  const q = deferredQuery.trim();
  const listId = `${scope}|${q ? `q:${q}` : folderId}`;
  const rowHeight = phone ? ROW_HEIGHT_TOUCH : ROW_HEIGHT;
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ---- derived row data ---- */
  const keyList = useMemo(() => rows.map((r) => r.key), [rows]);
  const keyIndex = useMemo(() => indexByKey(keyList), [keyList]);
  const rowsRef = useRef<{ rows: MessageRow[]; index: Map<MessageKey, number> }>({ rows, index: keyIndex });
  rowsRef.current = { rows, index: keyIndex };
  const getRow = useCallback((key: MessageKey) => {
    const cur = rowsRef.current;
    const i = cur.index.get(key);
    return i === undefined ? undefined : cur.rows[i];
  }, []);

  // `step` (j/k) and "select the next row after archive" read this.
  useLayoutEffect(() => {
    setVisibleKeys(keyList);
  }, [keyList]);

  /* ---- ticking rows for the assistant ---- */
  const [anchorState, setAnchor] = useState<{ list: string; key: MessageKey } | null>(null);
  // The first tick belongs to the list it was made in, and gives way to a real multi-selection.
  const anchor = anchorState && anchorState.list === listId && !multi && keyIndex.has(anchorState.key) ? anchorState.key : null;
  const setAnchorKey = useCallback((key: MessageKey | null) => setAnchor(key ? { list: listId, key } : null), [listId]);
  const ticking = multi || anchor != null;

  const { handlers, pointerSelected } = useListInteractions({ getRow, prefetch, phone, anchor, setAnchor: setAnchorKey });

  /* ---- virtualiser ---- */
  const hasLeaving = useMemo(() => {
    for (const _ in leaving) return true;
    return false;
  }, [leaving]);
  const getItemKey = useCallback((i: number) => rows[i]?.key ?? i, [rows]);
  // A row the assistant is removing collapses to nothing; the rows below slide up.
  const estimateSize = useCallback(
    (i: number) => {
      const r = rows[i];
      return r && leaving[r.key] ? 0 : rowHeight;
    },
    [rows, leaving, rowHeight],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
    getItemKey,
  });
  const items = virtualizer.getVirtualItems();
  const firstMeasure = useRef(true);
  useLayoutEffect(() => {
    if (firstMeasure.current) {
      firstMeasure.current = false;
      return;
    }
    virtualizer.measure();
  }, [leaving, rowHeight, virtualizer]);

  /* ---- scroll position ---- */
  const hasRows = rows.length > 0;
  const listIdRef = useRef(listId);
  /** Set while a list is waiting for its rows: scroll events are not its own yet. */
  const restoring = useRef(true);
  const prevList = useRef({ id: listId, keys: keyList });

  // Restore this list's own offset when switching to it (once it has rows).
  useLayoutEffect(() => {
    listIdRef.current = listId;
    restoring.current = true;
    if (!hasRows) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = scrollOffsets.get(listId) ?? 0;
    restoring.current = false;
  }, [listId, hasRows]);

  // Rows inserted or removed above the viewport must not move what is on screen.
  useLayoutEffect(() => {
    const prev = prevList.current;
    prevList.current = { id: listId, keys: keyList };
    if (prev.id !== listId || prev.keys === keyList) return;
    const el = scrollRef.current;
    if (!el) return;
    const next = anchoredOffset(prev.keys, keyIndex, virtualizer.scrollOffset ?? 0, rowHeight);
    if (next != null) el.scrollTop = next;
    // rowHeight / virtualizer are read, not reacted to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, keyList, keyIndex]);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    if (!restoring.current) scrollOffsets.set(listIdRef.current, e.currentTarget.scrollTop);
  }, []);

  // Keyboard selection keeps the active row in view (instantly, no smooth
  // scroll). A row chosen with the pointer is already under it: never move it.
  const selectedIndex = selectedKey ? (keyIndex.get(selectedKey) ?? -1) : -1;
  useEffect(() => {
    if (pointerSelected.current === selectedKey) return;
    pointerSelected.current = null;
    if (phone || selectedIndex < 0) return;
    virtualizer.scrollToIndex(selectedIndex, { align: "auto", behavior: "auto" });
    // Only when the selection moves, not when rows change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Load the next page when the end comes within reach.
  const firstIndex = items[0]?.index ?? 0;
  const lastIndex = items.length ? (items[items.length - 1]?.index ?? -1) : -1;
  // aria-activedescendant may only point at a row that is in the DOM.
  const activeId =
    selectedKey && selectedIndex >= firstIndex && selectedIndex <= lastIndex ? rowDomId(selectedKey) : undefined;
  const { onLastVisibleIndex } = list;
  useEffect(() => {
    if (lastIndex >= 0) onLastVisibleIndex(lastIndex);
  }, [lastIndex, onLastVisibleIndex]);

  /* ---- header ---- */
  const multiInbox = (inboxes?.length ?? 0) > 1;
  const boxNames = useMemo(() => {
    if (scope !== "all" || !multiInbox) return EMPTY_BOX_NAMES;
    const out: Record<string, string> = {};
    for (const i of inboxes ?? []) out[i.inbox_id] = i.display_name || i.email_address;
    return out;
  }, [inboxes, scope, multiInbox]);

  const nameOf = (i: Inbox | undefined) => (i ? i.display_name || i.email_address : "");
  const scopeName =
    scope === "all" ? (multiInbox ? "All mailboxes" : nameOf(inboxes?.[0])) : nameOf(inboxes?.find((i) => i.inbox_id === scope));
  const navItem = q ? undefined : folders.find((f) => f.id === folderId);
  const folderName = folderRefLabel(folder, navItem?.label);
  const isInbox = isRoleRef(folder) && folder.role === "inbox";
  const title = listTitle({ query: q, isInbox, folderName, scopeIsAll: scope === "all", scopeName });

  const loadedUnread = useMemo(() => rows.reduce((n, r) => n + (r.is_read ? 0 : 1), 0), [rows]);
  const countText = listCountText({
    searching: !!q,
    folderUnread: navItem?.unread,
    folderTotal: navItem?.total,
    listTotal: list.total,
    loadedCount: rows.length,
    loadedUnread,
    hasMore: list.hasNextPage,
  });
  const setSize = listSetSize(q ? list.total : (navItem?.total ?? list.total), rows.length, list.hasNextPage);
  const empty = emptyState({ query: q, isInbox, folderName, filteredTo: scope !== "all" && multiInbox ? scopeName : null });

  const showSkeleton = useDelayedFlag(list.isLoading, SKELETON_DELAY_MS);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      const row = selectedIndex >= 0 ? rows[selectedIndex] : rows[0];
      if (!row) return;
      e.preventDefault();
      openRow(row);
    } else if (e.key === "Escape" && anchor) {
      setAnchor(null);
    }
  };

  return (
    <div className={s.root}>
      <div className={s.head}>
        {phone ? <PhoneNav scope={scope} folderId={folderId} isInbox={isInbox && !q} inboxes={inboxes} folders={folders} /> : null}
        <SearchField phone={phone} />
        {!phone ? (
          <div className={s.titleRow}>
            <h1 className={s.title}>{title}</h1>
            {/* No count for a list that could not be loaded: "0 emails" would be a claim. */}
            <span className={s.countText}>{list.isLoading || (list.error && !hasRows) ? "" : countText}</span>
          </div>
        ) : (
          <h1 className="sr-only">{title}</h1>
        )}
      </div>

      {list.failedInboxes.length && hasRows ? (
        <div className={s.partial} role="status">
          <span className={s.partialText}>
            {partialFailureText(
              list.failedInboxes.map((f) => inboxes?.find((i) => i.inbox_id === f.inbox_id)?.email_address ?? "A mailbox"),
              list.failedInboxes.every((f) => f.code === "reconnect_required"),
            )}
          </span>
          {list.failedInboxes.every((f) => f.code === "reconnect_required") ? (
            <a href={DASHBOARD_URL} target="_blank" rel="noreferrer">
              Reconnect
            </a>
          ) : (
            <button type="button" className={s.partialRetry} onClick={list.refetch}>
              Retry
            </button>
          )}
        </div>
      ) : null}

      <div className={s.scrollWrap}>
        {holdNote || pendingCount > 0 ? (
          <div className={s.overlayTop}>
            {holdNote ? (
              <div className={s.holdNote} role="status">
                <Pause size={13} aria-hidden="true" />
                The assistant waits until your pointer leaves the list.
              </div>
            ) : null}
            {pendingCount > 0 ? (
              <button type="button" className={s.pill} onClick={flushPendingNew}>
                <ArrowUp size={13} aria-hidden="true" />
                {pluralize(pendingCount, "new email")}
              </button>
            ) : null}
          </div>
        ) : null}

        <div
          ref={scrollRef}
          className={s.scroller}
          role="listbox"
          tabIndex={0}
          aria-label={title}
          aria-multiselectable={ticking || undefined}
          aria-busy={list.isLoading || undefined}
          aria-activedescendant={activeId}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          {...handlers}
        >
          {list.isLoading ? (
            showSkeleton ? (
              <SkeletonRows count={9} height={rowHeight} />
            ) : null
          ) : isApiError(list.error, "reconnect_required") && !hasRows ? (
            // Not a failure to retry: the provider refuses the stored
            // credentials until the mailbox is reconnected in the dashboard.
            <EmptyState icon={<InboxIcon size={20} aria-hidden="true" />} title="This mailbox needs reconnecting.">
              Its mail provider no longer accepts the saved sign-in.{" "}
              <a href={DASHBOARD_URL} target="_blank" rel="noreferrer">
                Reconnect in the dashboard
              </a>
            </EmptyState>
          ) : list.error && !hasRows ? (
            <EmptyState icon={<InboxIcon size={20} aria-hidden="true" />} title="Could not load this list.">
              <Button size="sm" onClick={list.refetch}>
                Try again
              </Button>
            </EmptyState>
          ) : !hasRows ? (
            <EmptyState icon={<InboxIcon size={20} aria-hidden="true" />} title={empty.title}>
              {empty.sub}
            </EmptyState>
          ) : (
            <>
              <div
                className={s.sizer}
                data-settling={hasLeaving ? "" : undefined}
                // Dynamic value only: the height of all rows, rendered or not.
                style={{ height: virtualizer.getTotalSize() }}
              >
                {items.map((v) => {
                  const row = rows[v.index];
                  if (!row) return null;
                  const view = rowView(row);
                  return (
                    <Row
                      key={row.key}
                      rowKey={row.key}
                      who={view.who}
                      subject={view.subject}
                      preview={row.preview}
                      date={row.date}
                      unread={!row.is_read}
                      starred={row.is_starred}
                      canStar={view.canStar}
                      readOnly={!mayWrite}
                      attachable={!view.outgoing}
                      hasAttachment={row.has_attachments}
                      boxName={boxNames[row.inbox_id] ?? ""}
                      index={v.index}
                      setSize={setSize}
                      start={v.start}
                      height={rowHeight}
                      ticking={ticking}
                      anchored={anchor === row.key}
                      touchUi={phone}
                    />
                  );
                })}
              </div>
              {list.isFetchingNextPage ? <SkeletonRows count={3} height={rowHeight} /> : null}
            </>
          )}
        </div>
      </div>

      {phone ? (
        <button
          type="button"
          className={s.fab}
          aria-label="Compose"
          title={mayWrite ? "Compose" : READ_ONLY_EXPLANATION}
          disabled={!mayWrite}
          onClick={() => mailActions.newCompose()}
        >
          <PenLine size={20} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/* The search field subscribes to the query on its own, so a keystroke renders
 * this input and nothing else urgently. */
const SearchField = memo(function SearchField({ phone }: { phone: boolean }) {
  const query = useSelectionStore((x) => x.query);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => useSelectionStore.getState().setQuery(e.target.value);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    if (query) {
      e.stopPropagation();
      useSelectionStore.getState().setQuery("");
    } else e.currentTarget.blur();
  };
  return (
    <label className={s.search}>
      <Search size={14} aria-hidden="true" className={s.searchIcon} />
      <input
        {...{ [SEARCH_INPUT_ATTR]: "" }}
        className={s.searchInput}
        type="text"
        inputMode="search"
        value={query}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="Search mail"
        aria-label="Search mail"
        aria-keyshortcuts="/"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {query ? (
        <button
          type="button"
          className={s.searchClear}
          aria-label="Clear search"
          onClick={() => useSelectionStore.getState().setQuery("")}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
      {!phone ? <Kbd>/</Kbd> : null}
    </label>
  );
});

function SkeletonRows({ count, height }: { count: number; height: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        // Dynamic value only: the same fixed height as a real row.
        <div key={i} className={s.skeletonRow} style={{ height }}>
          <Skeleton width={`${38 + ((i * 7) % 22)}%`} />
          <Skeleton width={`${62 + ((i * 11) % 28)}%`} />
          <Skeleton width={`${48 + ((i * 5) % 34)}%`} />
        </div>
      ))}
    </div>
  );
}

interface PhoneNavProps {
  scope: string;
  folderId: string;
  /** Showing the inbox (and not a search). */
  isInbox: boolean;
  inboxes: Inbox[] | undefined;
  folders: FolderNavItem[];
}

/** Phone: the big title is a native select of mailboxes and folders. */
const PhoneNav = memo(function PhoneNav({ scope, folderId, isInbox, inboxes, folders }: PhoneNavProps) {
  const multi = (inboxes?.length ?? 0) > 1;
  const value = phoneNavValue(isInbox, scope, multi, folderId);

  const onChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    const selection = useSelectionStore.getState();
    startTransition(() => {
      if (v.startsWith("mb:")) selection.setScope(v.slice(3));
      else {
        const ref = parseFolderRefId(v.slice(2));
        if (ref) selection.openFolder(ref);
      }
    });
  };

  return (
    <div className={s.phoneNavRow}>
      <label className={s.phoneNav}>
        <span className="sr-only">Mailbox or folder</span>
        <select className={s.phoneSelect} value={value} onChange={onChange}>
          <optgroup label="Mailboxes">
            {multi ? <option value="mb:all">All mailboxes</option> : null}
            {(inboxes ?? []).map((i) => (
              <option key={i.inbox_id} value={multi ? `mb:${i.inbox_id}` : "mb:all"}>
                {i.display_name || i.email_address}
              </option>
            ))}
          </optgroup>
          <optgroup label="Folders">
            {folders
              .filter((f) => f.role !== "inbox")
              .map((f) => (
                <option key={f.id} value={`f:${f.id}`}>
                  {f.label}
                </option>
              ))}
          </optgroup>
        </select>
        <ChevronDown size={16} aria-hidden="true" className={s.phoneChevron} />
      </label>
    </div>
  );
});

export default ListPane;

/** "Could not load a@x.com. The other mailboxes are shown." */
function partialFailureText(names: string[], reconnect: boolean): string {
  const who = names.length === 1 ? (names[0] ?? "A mailbox") : `${names.length} mailboxes`;
  if (reconnect) return `${who} ${names.length === 1 ? "needs" : "need"} reconnecting. The other mailboxes are shown.`;
  return `Could not load ${who}. The other mailboxes are shown.`;
}
