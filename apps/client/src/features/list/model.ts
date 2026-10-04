import type { ToolCallState, ToolName } from "../../api/assistant-api";
import { toolIcon, toolTag } from "../../api/assistant-api";
import { FOLDER_ROLE_LABEL, type FolderRef, type MessageKey, type MessageRow, isNameRef, isRoleRef } from "../../api/types";
import { INBOX_NOTICE } from "../../api/inbox-health";
import { type Conversation, participantNames } from "../../data/conversations";
import { displayName, pluralize } from "../../lib/format";

/* Pure derivations for the message list: what a row shows, what the header
 * says, and where the scroller should sit after rows changed. No React, no
 * stores: everything here is unit tested. */

/* ------------------------------------------------------------------
 * Row
 * ------------------------------------------------------------------ */

export interface RowView {
  /** "Maya Chen", or "To: Sam, Priya" for mail the user wrote. */
  who: string;
  subject: string;
  /** Drafts and scheduled sends have no star. */
  canStar: boolean;
  /** Mail the user wrote (sent, drafts, scheduled). */
  outgoing: boolean;
}

const viewCache = new WeakMap<MessageRow, RowView>();

/** The static part of a row. Cached per row object: the query cache keeps a
 *  row's identity until it changes, so this runs once per change. */
export function rowView(row: MessageRow): RowView {
  const hit = viewCache.get(row);
  if (hit) return hit;
  const role = row.folder_role;
  const outgoing = role === "sent" || role === "drafts" || role === "scheduled";
  const view: RowView = {
    who: outgoing ? `To: ${row.to.map(displayName).join(", ") || "—"}` : displayName(row.from),
    subject: row.subject || "(no subject)",
    canStar: role !== "drafts" && role !== "scheduled",
    outgoing,
  };
  viewCache.set(row, view);
  return view;
}

const whoCache = new WeakMap<Conversation, { self: string; who: string }>();

/** The first line of a conversation row: "Maya, me". A conversation that is
 *  all the person's own mail (the Sent list) keeps the head's "To: …". Cached
 *  per conversation object, which is kept until its rows change. */
export function conversationWho(conv: Conversation, self: string, headWho: string): string {
  const hit = whoCache.get(conv);
  if (hit && hit.self === self) return hit.who;
  const outgoing = (role: MessageRow["folder_role"]) => role === "sent" || role === "drafts" || role === "scheduled";
  const who = conv.rows.every((r) => outgoing(r.folder_role)) ? headWho : participantNames(conv.rows, self);
  whoCache.set(conv, { self, who });
  return who;
}

export interface RowDecorInput {
  /** A tool call is touching the row right now. */
  touch: { tool: ToolName; state: ToolCallState } | null | undefined;
  /** Some call touched the row earlier in this conversation. */
  hasTrace: boolean;
  /** Where the assistant moved it (the row is a faded ghost), or null. */
  ghostTo: string | null;
  label: string | null | undefined;
  /** The row would ride along with the next message to the assistant. */
  attached: boolean;
  fresh: boolean;
}

export interface RowDecor {
  tag: { text: string; icon: string; amber: boolean } | null;
  /** Mono note in the first line: "Moved to Receipts" or a label. */
  note: string | null;
  /** The logo mark linking to the call that touched this row. */
  trace: boolean;
  /** "In chat" badge. */
  inChat: boolean;
  /** Row wash: amber while a send waits for approval, cobalt while touched or fresh. */
  tone: "amber" | "cobalt" | null;
}

/** Which of the assistant's marks a row shows. One of tag / ghost note wins the
 *  slot; a label and the trace mark can show together; the "in chat" badge only
 *  when nothing else is competing for attention. */
export function rowDecor(i: RowDecorInput): RowDecor {
  const waiting = i.touch?.state === "waiting";
  const ghost = !i.touch && i.ghostTo != null;
  const label = !i.touch && !ghost && i.label ? i.label : null;
  return {
    tag: i.touch ? { text: toolTag(i.touch.tool, i.touch.state), icon: toolIcon(i.touch.tool), amber: waiting } : null,
    note: ghost ? `Moved to ${i.ghostTo}` : label,
    trace: !i.touch && !ghost && i.hasTrace,
    inChat: i.attached && !i.touch && !i.hasTrace && !i.label,
    tone: waiting ? "amber" : i.touch || i.fresh ? "cobalt" : null,
  };
}

export function folderRefLabel(ref: FolderRef, known?: string): string {
  if (isRoleRef(ref)) return FOLDER_ROLE_LABEL[ref.role];
  if (isNameRef(ref)) return ref.name;
  return known || ref.folder_id;
}

export interface RowLabelInput {
  unread: boolean;
  starred: boolean;
  who: string;
  subject: string;
  time: string;
  /** Assistant tag ("Reading") or note ("Moved to Receipts"), if any. */
  status?: string | null;
  hasAttachment?: boolean;
  /** Messages in the conversation, when more than one. */
  count?: number;
}

/** "Unread. Maya Chen, Q3 numbers, 9:41". */
export function rowAriaLabel(i: RowLabelInput): string {
  let out = `${i.unread ? "Unread. " : ""}${i.who}, ${i.subject}${i.time ? `, ${i.time}` : ""}`;
  if (i.count && i.count > 1) out += `, ${i.count} messages`;
  if (i.starred) out += ", starred";
  if (i.hasAttachment) out += ", has attachment";
  if (i.status) out += `. Assistant: ${i.status}`;
  return out;
}

/* ------------------------------------------------------------------
 * Header
 * ------------------------------------------------------------------ */

export interface ListTitleInput {
  query: string;
  isInbox: boolean;
  folderName: string;
  scopeIsAll: boolean;
  /** "All mailboxes", or the mailbox's name. */
  scopeName: string;
}

export function listTitle(i: ListTitleInput): string {
  const q = i.query.trim();
  if (q) return `Results for "${q}"`;
  if (i.isInbox) return i.scopeName ? `Inbox · ${i.scopeName}` : "Inbox";
  return i.folderName + (!i.scopeIsAll && i.scopeName ? ` · ${i.scopeName}` : "");
}

export interface ListCountInput {
  /** A search: folder counts do not apply. */
  searching: boolean;
  /** From the folder list. null/undefined = not known. */
  folderUnread: number | null | undefined;
  folderTotal: number | null | undefined;
  /** Total reported with the first page. null = the server could not count. */
  listTotal: number | null;
  loadedCount: number;
  loadedUnread: number;
  hasMore: boolean;
}

/** "3 unread" when there is unread mail, else "128 emails". Prefers the
 *  folder's own counts over what happens to be loaded; an unknown count is
 *  shown as "50+", never as a made-up number. */
export function listCountText(i: ListCountInput): string {
  const open = i.hasMore ? "+" : "";
  const unread = i.searching ? null : i.folderUnread;
  if (unread != null) {
    if (unread > 0) return `${unread.toLocaleString("en-US")} unread`;
  } else if (i.loadedUnread > 0) {
    return `${i.loadedUnread.toLocaleString("en-US")}${open} unread`;
  }
  const total = (i.searching ? null : i.folderTotal) ?? i.listTotal;
  if (total != null) return pluralize(Math.max(total, i.hasMore ? 0 : i.loadedCount), "email");
  return i.hasMore ? `${i.loadedCount.toLocaleString("en-US")}+ emails` : pluralize(i.loadedCount, "email");
}

/** aria-setsize: the real size when known, -1 (unknown) while more can load. */
export function listSetSize(total: number | null, loaded: number, hasMore: boolean): number {
  if (total != null) return Math.max(total, loaded);
  return hasMore ? -1 : loaded;
}

export interface EmptyInput {
  query: string;
  isInbox: boolean;
  folderName: string;
  /** Viewing one mailbox out of several. */
  filteredTo: string | null;
}

export function emptyState(i: EmptyInput): { title: string; sub: string } {
  const q = i.query.trim();
  if (q) return { title: `No results for "${q}"`, sub: "Try a sender name or part of a subject." };
  return {
    title: `Nothing in ${i.isInbox ? "your inbox" : i.folderName}.`,
    // Only the inbox fills by itself: the line would be false for Trash or Starred.
    sub: i.filteredTo ? `Showing ${i.filteredTo} only.` : i.isInbox ? "New mail appears here as it arrives." : "",
  };
}

export interface FailureNotice {
  text: string;
  /** What the person can do about it: reconnect in the dashboard, ask
   *  again, or nothing (a mailbox that is gone). */
  action: "reconnect" | "retry" | "none";
}

const SHOWN = "The other mailboxes are shown.";

/** The line above a unified list when some mailboxes are left out of it.
 *  `failures` carry the copy for a mailbox the session calls down. */
export function failureNotice(failures: readonly { inbox_id: string; code: string; message: string }[], addressOf: (inbox_id: string) => string | undefined): FailureNotice | null {
  const first = failures[0];
  if (!first) return null;
  const known = (code: string) => code === "reconnect_required" || code === "inbox_unavailable";
  const reconnectable = failures.some((f) => f.code === "reconnect_required");
  if (failures.length === 1) {
    const who = addressOf(first.inbox_id) ?? "A mailbox";
    if (!known(first.code)) return { text: `Could not load ${who}. ${SHOWN}`, action: "retry" };
    // Only our own copy (the session's reason): never a raw server message.
    const ours = (Object.values(INBOX_NOTICE) as string[]).includes(first.message);
    const why = ours ? first.message : first.code === "inbox_unavailable" ? INBOX_NOTICE.unavailable : INBOX_NOTICE.generic;
    return { text: `${who}: ${why} ${SHOWN}`, action: reconnectable ? "reconnect" : "none" };
  }
  const n = failures.length;
  if (failures.every((f) => f.code === "reconnect_required")) return { text: `${n} mailboxes need reconnecting. ${SHOWN}`, action: "reconnect" };
  if (failures.every((f) => known(f.code))) return { text: `${n} mailboxes need attention. ${SHOWN}`, action: reconnectable ? "reconnect" : "none" };
  return { text: `Could not load ${n} mailboxes. ${SHOWN}`, action: "retry" };
}

/** "Still loading a@x.com" / "Still loading 2 mailboxes: a@x.com, b@x.com". */
export function pendingTitle(names: readonly string[]): string {
  if (!names.length) return "";
  return names.length === 1 ? `Still loading ${names[0]}` : `Still loading ${names.length} mailboxes: ${names.join(", ")}`;
}

/** Value of the phone title <select>: the inbox is reached through the
 *  Mailboxes group, every other folder through Folders. */
export function phoneNavValue(isInbox: boolean, scope: string, multiInbox: boolean, folderId: string): string {
  return isInbox ? `mb:${multiInbox ? scope : "all"}` : `f:${folderId}`;
}

/* ------------------------------------------------------------------
 * Scroll anchoring
 * ------------------------------------------------------------------ */

/** How far down the list to look for a surviving row to anchor on. */
const ANCHOR_SEARCH = 12;

/** Rows were inserted or removed. Returns the scroll offset that keeps the
 *  row at the top of the viewport where it was, or null when nothing needs to
 *  change. At the very top (offset 0) new rows are allowed to push the list
 *  down: that is where the user expects to see them arrive. */
export function anchoredOffset<K extends string = MessageKey>(
  prevKeys: readonly K[],
  nextIndex: ReadonlyMap<K, number>,
  offset: number,
  rowHeight: number,
): number | null {
  if (offset <= 0 || rowHeight <= 0) return null;
  const first = Math.floor(offset / rowHeight);
  const last = Math.min(prevKeys.length, first + ANCHOR_SEARCH);
  for (let i = first; i < last; i++) {
    const key = prevKeys[i];
    if (key === undefined) break;
    const j = nextIndex.get(key);
    if (j === undefined) continue; // this row left: anchor on the next one
    return j === i ? null : Math.max(0, offset + (j - i) * rowHeight);
  }
  return null;
}

export function indexByKey<K extends string = MessageKey>(keys: readonly K[]): Map<K, number> {
  const out = new Map<K, number>();
  for (let i = 0; i < keys.length; i++) out.set(keys[i] as K, i);
  return out;
}
