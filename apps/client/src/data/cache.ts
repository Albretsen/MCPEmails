import type { InfiniteData, QueryKey } from "@tanstack/react-query";
import {
  type FolderEntry,
  type FolderRef,
  type FolderRole,
  type MessageDetail,
  type MessageFlags,
  type MessageKey,
  type MessagePage,
  type MessageRow,
  type MessageThread,
  type PageCursor,
  folderRefId,
  isExactRef,
  isNameRef,
  isRoleRef,
  roleOfFolder,
} from "../api/types";
import { type ListMeta, keys } from "./keys";
import { queryClient } from "./query-client";

/* Synchronous cache surgery. Optimistic mutations, server-pushed events and
 * the assistant's mail effects all go through these helpers, so every list on
 * screen (and every cached list that is not) changes in the same frame.
 *
 * No store imports here: stores may import this module.
 */

export type ListData = InfiniteData<MessagePage, PageCursor | null>;

function lists(): [QueryKey, ListData | undefined][] {
  return queryClient.getQueriesData<ListData>({ queryKey: keys.messagesRoot });
}

function metaOf(key: QueryKey): ListMeta {
  return key[1] as ListMeta;
}

/* ---- conversations: the `thread` op's answers ---- */

function threads(): [QueryKey, MessageThread | undefined][] {
  return queryClient.getQueriesData<MessageThread>({ queryKey: keys.threadRoot });
}

/** Rewrites the rows of every cached thread (flags, new ids). */
function mapThreadRows(fn: (row: MessageRow) => MessageRow): void {
  for (const [key, data] of threads()) {
    if (!data) continue;
    let changed = false;
    const rows = data.rows.map((row) => {
      const next = fn(row);
      if (next !== row) changed = true;
      return next;
    });
    if (changed) queryClient.setQueryData<MessageThread>(key, { ...data, rows });
  }
}

/** Forgets every cached thread that holds one of these messages: they moved,
 *  so what the thread says about their folder (and, on IMAP, their id) is
 *  stale. It is asked for again when the conversation is next opened. */
export function dropThreadsWith(target: readonly MessageKey[]): void {
  if (!target.length) return;
  const set = new Set(target);
  for (const [key, data] of threads()) {
    if (data?.rows.some((r) => set.has(r.key))) queryClient.removeQueries({ queryKey: key, exact: true });
  }
}

/** Looks a row up in every cached list, then in every cached thread (a
 *  message of an open conversation that sits in another folder). */
export function findRow(key: MessageKey): MessageRow | undefined {
  for (const [, data] of lists()) {
    if (!data) continue;
    for (const page of data.pages) {
      const hit = page.rows.find((r) => r.key === key);
      if (hit) return hit;
    }
  }
  for (const [, data] of threads()) {
    const hit = data?.rows.find((r) => r.key === key);
    if (hit) return hit;
  }
  return undefined;
}

export function findRows(wanted: readonly MessageKey[]): MessageRow[] {
  const out: MessageRow[] = [];
  for (const k of wanted) {
    const r = findRow(k);
    if (r) out.push(r);
  }
  return out;
}

/** Rewrites every cached list. Return the row to keep it, a new object to
 *  change it, or null to drop it. Lists that do not change keep their identity
 *  (so nothing re-renders for them). */
export function mapRows(fn: (row: MessageRow, meta: ListMeta) => MessageRow | null): void {
  for (const [key, data] of lists()) {
    if (!data) continue;
    const meta = metaOf(key);
    let changed = false;
    const pages = data.pages.map((page) => {
      let pageChanged = false;
      let removed = 0;
      const rows: MessageRow[] = [];
      for (const row of page.rows) {
        const next = fn(row, meta);
        if (next !== row) pageChanged = true;
        if (next) rows.push(next);
        else removed++;
      }
      if (!pageChanged) return page;
      changed = true;
      return { ...page, rows, total: page.total == null ? null : Math.max(0, page.total - removed) };
    });
    if (changed) queryClient.setQueryData<ListData>(key, { ...data, pages });
  }
}

export function patchRows(target: readonly MessageKey[], patch: Partial<MessageRow>): void {
  const set = new Set(target);
  mapRows((row) => (set.has(row.key) ? { ...row, ...patch } : row));
}

/** Applies read/starred to rows and to any cached message detail. Rows that
 *  were unstarred leave the Starred list. */
export function applyFlags(target: readonly MessageKey[], flags: MessageFlags): void {
  const set = new Set(target);
  const patch: Partial<MessageRow> = {};
  if (flags.read !== undefined) patch.is_read = flags.read;
  if (flags.starred !== undefined) patch.is_starred = flags.starred;
  mapRows((row, meta) => {
    if (!set.has(row.key)) return row;
    if (flags.starred === false && meta.folder === "starred") return null;
    return { ...row, ...patch };
  });
  mapThreadRows((row) => (set.has(row.key) ? { ...row, ...patch } : row));
  for (const key of target) {
    queryClient.setQueryData<MessageDetail>(keys.message(key), (d) => (d ? { ...d, ...patch } : d));
  }
}

/** Removes rows from every list they no longer belong in after moving to
 *  `destination`. Lists OF the destination are left alone (they are refreshed
 *  by an invalidation instead, since the moved rows' new ids are not known). */
export function removeMovedRows(target: readonly MessageKey[], destination: FolderRef | null): void {
  const set = new Set(target);
  const destId = destination ? folderRefId(destination) : null;
  const gone = destination != null && isRoleRef(destination) && (destination.role === "trash" || destination.role === "spam");
  mapRows((row, meta) => {
    if (!set.has(row.key)) return row;
    if (destination == null) return null; // permanently deleted
    if (meta.query) return gone ? null : row; // search results span folders
    if (meta.folder === "starred") return gone ? null : row;
    if (meta.folder === destId) return row;
    return null;
  });
  dropThreadsWith(target);
}

/** Puts new rows at the top of every inbox list they belong to. */
export function insertInboxRows(rows: readonly MessageRow[]): void {
  if (!rows.length) return;
  for (const [key, data] of lists()) {
    if (!data) continue;
    const meta = metaOf(key);
    if (meta.query || meta.folder !== "inbox") continue;
    const mine = rows.filter((r) => meta.scope === "all" || meta.scope === r.inbox_id);
    if (!mine.length) continue;
    const first = data.pages[0];
    if (!first) continue;
    const have = new Set(first.rows.map((r) => r.key));
    const fresh = mine.filter((r) => !have.has(r.key));
    if (!fresh.length) continue;
    const page0: MessagePage = {
      ...first,
      rows: [...fresh, ...first.rows],
      total: first.total == null ? null : first.total + fresh.length,
    };
    queryClient.setQueryData<ListData>(key, { ...data, pages: [page0, ...data.pages.slice(1)] });
  }
}

/* Folder roles the folder list itself does not reveal. A provider with opaque
 * folder ids and localised names (Outlook: "Innboks", "Kladd") cannot be
 * matched by name; the server resolves the role aliases, and `status` answers
 * with the real id. The sync engine records those here (inbox -> id -> role). */
const learnedRoles = new Map<string, Map<string, FolderRole>>();

/** Returns true when something new was learned. */
export function learnFolderRoles(inbox_id: string, pairs: readonly { id: string; role: FolderRole }[]): boolean {
  const known = learnedRoles.get(inbox_id) ?? new Map<string, FolderRole>();
  let changed = false;
  for (const p of pairs) {
    if (known.get(p.id) === p.role) continue;
    known.set(p.id, p.role);
    changed = true;
  }
  if (changed) learnedRoles.set(inbox_id, known);
  return changed;
}

export function forgetFolderRoles(): void {
  learnedRoles.clear();
}

/** The role of one folder of one inbox, or null for a folder of the person's own. */
export function folderRoleOf(inbox_id: string, f: Pick<FolderEntry, "id" | "name" | "role">): FolderRole | null {
  // The server's word, when it sends one (null = a folder of the person's own).
  if (f.role !== undefined) return f.role;
  return learnedRoles.get(inbox_id)?.get(f.id) ?? roleOfFolder(f.id) ?? roleOfFolder(f.name);
}

/** The folder list carries the server's `role` field. */
export function hasServerRoles(entries: readonly FolderEntry[]): boolean {
  return entries.some((f) => f.role !== undefined);
}

/** Finds the FolderEntry a ref points at inside one inbox's folder list. */
export function resolveFolderEntry(entries: readonly FolderEntry[], inbox_id: string, ref: FolderRef): FolderEntry | undefined {
  if (isExactRef(ref)) return ref.inbox_id === inbox_id ? entries.find((f) => f.id === ref.folder_id) : undefined;
  if (isNameRef(ref)) return entries.find((f) => f.name.toLowerCase() === ref.name.toLowerCase());
  // Roles from the server decide alone: a mailbox it gives no Archive has
  // none, whatever its folders are called.
  if (hasServerRoles(entries)) return entries.find((f) => f.role === ref.role);
  const known = learnedRoles.get(inbox_id);
  const learned = known ? entries.find((f) => known.get(f.id) === ref.role) : undefined;
  if (learned) return learned;
  return entries.find((f) => roleOfFolder(f.id) === ref.role) ?? entries.find((f) => roleOfFolder(f.name) === ref.role);
}

/** Adjusts cached folder counts for rows leaving their folder and (optionally)
 *  arriving in another. Counts that the server reported as null stay null. */
export function adjustFolderCounts(rows: readonly MessageRow[], destination: FolderRef | null | undefined): void {
  const byInbox = new Map<string, MessageRow[]>();
  for (const r of rows) byInbox.set(r.inbox_id, [...(byInbox.get(r.inbox_id) ?? []), r]);
  for (const [inbox_id, mine] of byInbox) {
    queryClient.setQueryData<FolderEntry[]>(keys.folders(inbox_id), (entries) => {
      if (!entries) return entries;
      const dest = destination ? resolveFolderEntry(entries, inbox_id, destination) : undefined;
      return entries.map((f) => {
        let total = 0;
        let unread = 0;
        for (const r of mine) {
          if (r.folder === f.id) {
            total--;
            if (!r.is_read) unread--;
          }
          if (dest && dest.id === f.id && r.folder !== f.id) {
            total++;
            if (!r.is_read) unread++;
          }
        }
        if (!total && !unread) return f;
        return {
          ...f,
          total_messages: f.total_messages == null ? null : Math.max(0, f.total_messages + total),
          unread_messages: f.unread_messages == null ? null : Math.max(0, f.unread_messages + unread),
        };
      });
    });
  }
}

/** Adjusts unread counts when rows change read state in place. */
export function adjustUnreadCounts(rows: readonly MessageRow[], read: boolean): void {
  const byInbox = new Map<string, MessageRow[]>();
  for (const r of rows) if (r.is_read !== read) byInbox.set(r.inbox_id, [...(byInbox.get(r.inbox_id) ?? []), r]);
  for (const [inbox_id, mine] of byInbox) {
    queryClient.setQueryData<FolderEntry[]>(keys.folders(inbox_id), (entries) =>
      entries?.map((f) => {
        const n = mine.filter((r) => r.folder === f.id).length;
        if (!n || f.unread_messages == null) return f;
        return { ...f, unread_messages: Math.max(0, f.unread_messages + (read ? -n : n)) };
      }),
    );
  }
}

/** Adds arriving rows to their folder's counts. */
export function addToFolderCounts(rows: readonly MessageRow[]): void {
  // HTTP mode: `status` already delivered the counts that include these rows.
  if (folderRefresher) return;
  const byInbox = new Map<string, MessageRow[]>();
  for (const r of rows) byInbox.set(r.inbox_id, [...(byInbox.get(r.inbox_id) ?? []), r]);
  for (const [inbox_id, mine] of byInbox) {
    queryClient.setQueryData<FolderEntry[]>(keys.folders(inbox_id), (entries) =>
      entries?.map((f) => {
        const here = mine.filter((r) => r.folder === f.id);
        if (!here.length) return f;
        const unread = here.filter((r) => !r.is_read).length;
        return {
          ...f,
          total_messages: f.total_messages == null ? null : f.total_messages + here.length,
          unread_messages: f.unread_messages == null ? null : f.unread_messages + unread,
        };
      }),
    );
  }
}

/* ---- snapshots, for rollback and undo ---- */

export interface MailSnapshot {
  lists: [QueryKey, ListData | undefined][];
  folders: [QueryKey, FolderEntry[] | undefined][];
}

export function snapshotMail(): MailSnapshot {
  return {
    lists: lists(),
    folders: queryClient.getQueriesData<FolderEntry[]>({ queryKey: keys.foldersRoot }),
  };
}

export function restoreMail(snap: MailSnapshot): void {
  for (const [key, data] of snap.lists) queryClient.setQueryData(key, data);
  for (const [key, data] of snap.folders) queryClient.setQueryData(key, data);
}

/* ---- background refresh ---- */

/** Marks lists stale and refetches the ones on screen. Pass a predicate to
 *  limit it (e.g. only lists of the destination folder). */
export function refreshLists(match?: (meta: ListMeta) => boolean): void {
  void queryClient.invalidateQueries({
    queryKey: keys.messagesRoot,
    predicate: match ? (q) => match(metaOf(q.queryKey)) : undefined,
  });
}

/* HTTP mode: listing folders is the slowest call the backend has, and the
 * sync engine's `status` call returns the same counts cheaply. While a
 * refresher is installed, "refresh the folders" means "ask for status". */
let folderRefresher: (() => void) | null = null;

export function setFolderRefresher(fn: (() => void) | null): void {
  folderRefresher = fn;
}

/** `own`: the caller's own mutation just succeeded. In HTTP mode the sync
 *  engine hears of every mutation itself and asks `status` for exactly the
 *  folders it can have changed, so there is nothing to do here: a status
 *  sweep of every mailbox after each draft autosave would be waste. */
export function refreshFolders(opts: { own?: boolean } = {}): void {
  if (folderRefresher) {
    if (!opts.own) folderRefresher();
  } else void queryClient.invalidateQueries({ queryKey: keys.foldersRoot });
}

/** Rows of one inbox in one cached list, in page order. */
export function rowsOfList(key: QueryKey, inbox_id: string): MessageRow[] {
  const data = queryClient.getQueryData<ListData>(key);
  const out: MessageRow[] = [];
  for (const page of data?.pages ?? []) for (const r of page.rows) if (r.inbox_id === inbox_id) out.push(r);
  return out;
}

/** Every cached folder listing (not searches), with its meta. */
export function cachedFolderLists(): { key: QueryKey; meta: ListMeta }[] {
  const out: { key: QueryKey; meta: ListMeta }[] = [];
  for (const [key, data] of lists()) {
    if (!data) continue;
    const meta = metaOf(key);
    if (!meta.query) out.push({ key, meta });
  }
  return out;
}

/** A message has a new id (IMAP: ids are per folder, so a move changes them).
 *  Rewrites every cached row and detail that still carries the old key.
 *  `patch` may add what is known about where the message is now. */
export function remapKeys(
  pairs: readonly { key: MessageKey; new_key: MessageKey }[],
  patch: (row: MessageRow) => Partial<MessageRow> = () => ({}),
): void {
  const map = new Map<MessageKey, MessageKey>();
  for (const p of pairs) if (p.key !== p.new_key) map.set(p.key, p.new_key);
  if (!map.size) return;
  const idOf = (key: MessageKey) => key.slice(key.indexOf(":") + 1);
  mapRows((row) => {
    const next = map.get(row.key);
    return next ? { ...row, ...patch(row), key: next, id: idOf(next) } : row;
  });
  dropThreadsWith([...map.keys()]);
  for (const [old, next] of map) {
    const detail = queryClient.getQueryData<MessageDetail>(keys.message(old));
    if (detail) {
      queryClient.setQueryData<MessageDetail>(keys.message(next), { ...detail, key: next, id: idOf(next) });
      queryClient.removeQueries({ queryKey: keys.message(old), exact: true });
    }
  }
}

/** True when a list shows the folder a ref points at. */
export function listShows(meta: ListMeta, ref: FolderRef): boolean {
  if (meta.query) return false;
  if (meta.folder === folderRefId(ref)) return true;
  // An exact ref and a role/name ref can point at the same folder; without the
  // folder list we cannot tell, so refresh on any non-identical custom match.
  return !isRoleRef(ref) && !(meta.folder in ROLE_IDS);
}

const ROLE_IDS: Record<string, true> = {
  inbox: true,
  starred: true,
  drafts: true,
  scheduled: true,
  sent: true,
  archive: true,
  trash: true,
  spam: true,
};

/** The folder a row sits in, as an exact ref (for moving it back). */
export function originOf(row: MessageRow): FolderRef {
  return { inbox_id: row.inbox_id, folder_id: row.folder };
}
