import { getMailApi } from "../api";
import {
  type DraftInput,
  type FolderRef,
  FOLDER_ROLE_LABEL,
  type Inbox,
  type MessageDetail,
  type MessageKey,
  type MessageRow,
  type MoveResult,
  isNameRef,
  isRoleRef,
  parseAddressList,
} from "../api/types";
import { useAssistantStore } from "../state/assistant-store";
import { type ComposeMode, type ComposeState, composeSignature, isComposeEmpty, useComposeStore } from "../state/compose-store";
import { neighbourAfterRemoval, useSelectionStore } from "../state/selection-store";
import { showToast, useToastStore } from "../state/toast-store";
import { isPhone } from "../state/ui-store";
import {
  type MailSnapshot,
  adjustFolderCounts,
  adjustUnreadCounts,
  applyFlags,
  findRow,
  findRows,
  listShows,
  originOf,
  refreshFolders,
  refreshLists,
  removeMovedRows,
  restoreMail,
  snapshotMail,
} from "./cache";
import { keys } from "./keys";
import { queryClient } from "./query-client";
import { dropUndo, pushUndo, runUndo } from "./undo";

/* Every user-initiated mailbox change. Plain functions (not hooks) so the
 * keyboard handler, toasts and stores can call them too.
 *
 * The shape of every action is the same:
 *   1. write the cache synchronously (the UI changes in this frame),
 *   2. start the API call,
 *   3. on failure restore the snapshot and say so,
 *   4. offer Undo (toast + undo stack) where the action can be reversed.
 */

export const DEFAULT_UNDO_SEND_MS = 5000;

function rollback(snap: MailSnapshot, message: string): void {
  restoreMail(snap);
  refreshLists();
  refreshFolders();
  showToast({ text: message, kind: "error" });
}

function folderLabel(ref: FolderRef): string {
  if (isRoleRef(ref)) return FOLDER_ROLE_LABEL[ref.role];
  if (isNameRef(ref)) return ref.name;
  const entries = queryClient.getQueryData<{ id: string; name: string }[]>(keys.folders(ref.inbox_id));
  return entries?.find((f) => f.id === ref.folder_id)?.name ?? ref.folder_id;
}

const countLabel = (n: number, verb: string) => (n > 1 ? `${verb} ${n} emails` : verb);

interface RelocateOptions {
  destination: FolderRef;
  label: string;
  failure: string;
  call: () => Promise<MoveResult>;
}

async function relocate(target: MessageKey[], o: RelocateOptions): Promise<void> {
  if (!target.length) return;
  const rows = findRows(target);
  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  const snap = snapshotMail();
  const selection = useSelectionStore.getState();
  const prevSelected = selection.selectedKey;
  const hitSelected = prevSelected != null && target.includes(prevSelected);
  // Decide the next selection BEFORE the rows leave the list.
  const next = hitSelected ? neighbourAfterRemoval(target, prevSelected) : prevSelected;

  // 1. Optimistic, synchronous.
  removeMovedRows(target, o.destination);
  adjustFolderCounts(rows, o.destination);
  if (hitSelected) selection.select(isPhone() ? null : next);
  else selection.clearMulti();

  // 2. Network, in the background.
  const pending = o.call();
  let undone = false;

  const undo = async () => {
    undone = true;
    restoreMail(snap);
    if (hitSelected && !isPhone()) useSelectionStore.getState().select(prevSelected);
    const result = await pending.catch(() => null);
    if (!result) return;
    // Move each message back to where it was, using the key it has NOW.
    const byOrigin = new Map<string, { origin: FolderRef; keys: MessageKey[] }>();
    for (const m of result.moved) {
      const row = rowByKey.get(m.key);
      if (!row) continue;
      const id = `${row.inbox_id}|${row.folder}`;
      const group = byOrigin.get(id) ?? { origin: originOf(row), keys: [] };
      group.keys.push(m.new_key);
      byOrigin.set(id, group);
    }
    try {
      for (const g of byOrigin.values()) await getMailApi().moveMessages(g.keys, g.origin);
    } catch {
      showToast({ text: "Could not undo that.", kind: "error" });
    }
    refreshLists();
    refreshFolders();
  };

  const entry = pushUndo(o.label, undo);
  showToast({ text: o.label, undo: () => void runUndo(entry.id) });

  try {
    await pending;
    if (!undone) refreshLists((meta) => listShows(meta, o.destination));
  } catch {
    dropUndo(entry.id);
    if (undone) return;
    rollback(snap, o.failure);
    if (hitSelected && !isPhone()) useSelectionStore.getState().select(prevSelected);
  }
}

export function archive(target: MessageKey[]): Promise<void> {
  return relocate(target, {
    destination: { role: "archive" },
    label: countLabel(target.length, "Archived"),
    failure: "Could not archive. Nothing was changed.",
    call: () => getMailApi().archiveMessages(target),
  });
}

export function trash(target: MessageKey[]): Promise<void> {
  return relocate(target, {
    destination: { role: "trash" },
    label: target.length > 1 ? `Moved ${target.length} emails to Trash` : "Moved to Trash",
    failure: "Could not delete. Nothing was changed.",
    call: () => getMailApi().deleteMessages(target),
  });
}

export function move(target: MessageKey[], destination: FolderRef): Promise<void> {
  const name = folderLabel(destination);
  return relocate(target, {
    destination,
    label: target.length > 1 ? `Moved ${target.length} emails to ${name}` : `Moved to ${name}`,
    failure: `Could not move to ${name}. Nothing was changed.`,
    call: () => getMailApi().moveMessages(target, destination),
  });
}

export interface FlagOptions {
  /** No toast (opening a message marks it read quietly). */
  silent?: boolean;
}

export async function markRead(target: MessageKey[], read: boolean, opts: FlagOptions = {}): Promise<void> {
  const rows = findRows(target).filter((r) => r.is_read !== read);
  const changing = rows.length ? rows.map((r) => r.key) : target;
  if (!changing.length) return;
  adjustUnreadCounts(rows, read);
  applyFlags(changing, { read });
  if (!opts.silent) {
    const label = read ? countLabel(changing.length, "Marked as read") : countLabel(changing.length, "Marked as unread");
    const entry = pushUndo(label, () => markRead(changing, !read, { silent: true }));
    showToast({ text: label, undo: () => void runUndo(entry.id) });
  }
  try {
    await getMailApi().setFlags(changing, { read });
  } catch {
    // Targeted rollback (not a snapshot restore): flag changes overlap with
    // other optimistic updates all the time, e.g. archive selects the next
    // row, which marks it read.
    applyFlags(changing, { read: !read });
    refreshFolders();
    // Opening a message marks it read quietly; failing at that is not worth a toast.
    if (!opts.silent) showToast({ text: read ? "Could not mark as read." : "Could not mark as unread.", kind: "error" });
  }
}

export async function star(target: MessageKey[], starred: boolean): Promise<void> {
  if (!target.length) return;
  // Unstarring drops rows from the Starred list, so that case needs the snapshot.
  const snap = starred ? null : snapshotMail();
  applyFlags(target, { starred });
  try {
    await getMailApi().setFlags(target, { starred });
    refreshLists((meta) => meta.folder === "starred");
  } catch {
    if (snap) restoreMail(snap);
    else applyFlags(target, { starred: false });
    refreshLists((meta) => meta.folder === "starred");
    showToast({ text: starred ? "Could not star that." : "Could not remove the star.", kind: "error" });
  }
}

/* ------------------------------------------------------------------
 * Compose: open
 * ------------------------------------------------------------------ */

function inboxes(): Inbox[] {
  return queryClient.getQueryData<Inbox[]>(keys.inboxes) ?? [];
}

/** The mailbox a new message is sent from: the active scope, else the first inbox. */
export function defaultInboxId(): string {
  const scope = useSelectionStore.getState().scope;
  if (scope !== "all") return scope;
  return inboxes()[0]?.inbox_id ?? "";
}

export function newCompose(init: Partial<ComposeState> = {}): void {
  useComposeStore.getState().open({ inbox_id: defaultInboxId(), mode: "new", ...init });
}

const stripRe = (s: string) => s.replace(/^(re|fwd?):\s*/i, "");

/** Opens a reply / reply-all / forward for a message, from whatever is cached. */
export function startReply(key: MessageKey, mode: Exclude<ComposeMode, "new">): void {
  const detail = queryClient.getQueryData<MessageDetail>(keys.message(key));
  const row: MessageRow | MessageDetail | undefined = findRow(key) ?? detail;
  if (!row || row.folder_role === "drafts") return;
  const inbox_id = row.inbox_id;
  const self = inboxes().find((i) => i.inbox_id === inbox_id)?.email_address ?? "";
  const fromSelf = row.from.email === self;
  const subject = stripRe(row.subject);

  if (mode === "forward") {
    const body = detail?.body_text ?? row.subject;
    const init = {
      to: "",
      cc: "",
      bcc: "",
      subject: `Fwd: ${subject}`,
      body: `\n\n---------- Forwarded message ----------\nFrom: ${row.from.name} <${row.from.email}>\nSubject: ${row.subject}\n\n${body}`,
    };
    useComposeStore.getState().open({ mode, inbox_id, replyTo: key, ...init, pristine: composeSignature(init) });
    return;
  }
  const to = fromSelf ? row.to.map((a) => a.email).join(", ") : row.from.email;
  const others =
    mode === "reply_all"
      ? [...row.to, ...(detail?.cc ?? [])].map((a) => a.email).filter((e) => e && e !== self && e !== row.from.email)
      : [];
  const init = { to, cc: others.join(", "), bcc: "", subject: `Re: ${subject}`, body: "" };
  useComposeStore.getState().open({ mode, inbox_id, replyTo: key, ...init, pristine: composeSignature(init) });
}

/** Opens a draft row for editing. The form appears at once; the body follows
 *  (draft list rows carry no body). */
export async function openDraft(row: MessageRow): Promise<void> {
  useSelectionStore.getState().select(null);
  useComposeStore.getState().open({
    mode: "new",
    inbox_id: row.inbox_id,
    to: row.to.map((a) => a.email).join(", "),
    subject: row.subject === "(no subject)" ? "" : row.subject,
    body: "",
    draft_id: row.id,
    savedAt: Date.parse(row.date) || undefined,
  });
  try {
    const d = await queryClient.fetchQuery({
      queryKey: keys.draft(row.inbox_id, row.id),
      queryFn: ({ signal }) => getMailApi().readDraft(row.inbox_id, row.id, signal),
      staleTime: 0,
    });
    const c = useComposeStore.getState().compose;
    // Only fill in if this draft is still open and the user has not typed yet.
    if (c && c.draft_id === row.id && c.body === "") {
      useComposeStore.getState().patch({
        body: d.body_text,
        cc: d.cc.map((a) => a.email).join(", "),
        bcc: d.bcc.map((a) => a.email).join(", "),
        replyTo: undefined,
      });
    }
  } catch {
    showToast({ text: "Could not load that draft.", kind: "error" });
  }
}

/* ------------------------------------------------------------------
 * Compose: save / discard
 * ------------------------------------------------------------------ */

function draftInput(c: ComposeState): DraftInput {
  return {
    inbox_id: c.inbox_id,
    to: parseAddressList(c.to),
    cc: parseAddressList(c.cc),
    bcc: parseAddressList(c.bcc),
    subject: c.subject,
    body_text: c.body,
    reply_to: c.mode === "reply" || c.mode === "reply_all" ? c.replyTo : undefined,
  };
}

function refreshDrafts(): void {
  void queryClient.invalidateQueries({ queryKey: keys.draftsRoot });
  refreshLists((meta) => meta.folder === "drafts");
  refreshFolders();
}

export interface SaveDraftOptions {
  /** No "Saved to Drafts" toast. */
  silent?: boolean;
  /** Autosave: keep the form open and just record the new draft id. */
  keepOpen?: boolean;
}

/** Saves the open compose as a draft. Closes the form unless `keepOpen`.
 *  An empty form is simply closed. Does nothing while the assistant is
 *  streaming into it or a send is held for approval. */
export async function saveDraft(opts: SaveDraftOptions = {}): Promise<void> {
  const store = useComposeStore.getState();
  const c = store.compose;
  if (!c || c.streaming || c.held) return;
  if (isComposeEmpty(c)) {
    if (!opts.keepOpen) store.close();
    return;
  }
  if (!opts.keepOpen) store.close();
  try {
    const api = getMailApi();
    const ref = c.draft_id
      ? await api.updateDraft(c.inbox_id, c.draft_id, draftInput(c))
      : await api.createDraft(draftInput(c));
    if (opts.keepOpen) {
      const now = useComposeStore.getState().compose;
      // IMAP hands back a new id on every update: always keep the latest.
      if (now && now.draft_id === c.draft_id && now.replyTo === c.replyTo) {
        useComposeStore.getState().patch({ draft_id: ref.draft_id, savedAt: Date.now() });
      }
    } else {
      useAssistantStore.getState().bumpFolder({ role: "drafts" });
      if (!opts.silent) showToast("Saved to Drafts");
    }
    refreshDrafts();
  } catch {
    if (!opts.keepOpen && !useComposeStore.getState().compose) useComposeStore.getState().open(c);
    showToast({ text: "Could not save the draft. It is still open.", kind: "error" });
  }
}

export async function discardDraft(): Promise<void> {
  const c = useComposeStore.getState().discard();
  if (!c) return;
  const entry = pushUndo("Draft discarded", () => {
    useComposeStore.getState().open({ ...c, draft_id: undefined, held: undefined, streaming: null, segments: undefined });
  });
  showToast({ text: "Draft discarded", undo: () => void runUndo(entry.id) });
  if (!c.draft_id) return;
  try {
    await getMailApi().deleteDraft(c.inbox_id, c.draft_id);
    refreshDrafts();
  } catch {
    showToast({ text: "Could not delete the saved draft.", kind: "error" });
  }
}

/* ------------------------------------------------------------------
 * Send (with an undo window) and schedule
 * ------------------------------------------------------------------ */

interface PendingSend {
  timer: ReturnType<typeof setTimeout>;
  fire: () => Promise<void>;
}
const pendingSends = new Map<number, PendingSend>();

async function deliver(c: ComposeState): Promise<void> {
  const api = getMailApi();
  const to = parseAddressList(c.to);
  const cc = parseAddressList(c.cc);
  const bcc = parseAddressList(c.bcc);
  if ((c.mode === "reply" || c.mode === "reply_all") && c.replyTo) {
    await api.replyToMessage({ key: c.replyTo, reply_all: c.mode === "reply_all", to, cc, bcc, body_text: c.body });
  } else if (c.mode === "forward" && c.replyTo) {
    await api.forwardMessage({ key: c.replyTo, to, cc, bcc, body_text: c.body });
  } else {
    await api.sendMessage({ inbox_id: c.inbox_id, to, cc, bcc, subject: c.subject, body_text: c.body });
  }
  // The saved draft is now redundant. Best effort: a leftover draft is harmless.
  if (c.draft_id) await api.deleteDraft(c.inbox_id, c.draft_id).catch(() => {});
}

function reopen(c: ComposeState): void {
  useComposeStore.getState().open({ ...c, held: undefined, streaming: null, segments: undefined });
  if (c.replyTo) useSelectionStore.getState().select(c.replyTo);
  // `select` clears nothing in compose, but opening a reply must win the main pane.
}

export interface SendOptions {
  /** How long Undo stays available before the message really goes out. */
  undoWindowMs?: number;
}

/** Sends the given compose after an undo window. The form closes at once; the
 *  API call is delayed client-side, and Undo reopens the form untouched.
 *  Returns false (with a toast) when it cannot be sent as is. */
export function send(c: ComposeState, opts: SendOptions = {}): boolean {
  if (c.streaming) return false;
  if (!parseAddressList(c.to).length) {
    showToast("Add a recipient before sending.");
    return false;
  }
  const windowMs = opts.undoWindowMs ?? DEFAULT_UNDO_SEND_MS;
  const store = useComposeStore.getState();
  if (store.compose === c || (store.compose && store.compose.replyTo === c.replyTo)) store.discard();
  if (c.replyTo) useAssistantStore.getState().setLabel([c.replyTo], null);

  const fire = async () => {
    pendingSends.delete(entry.id);
    dropUndo(entry.id);
    try {
      await deliver(c);
      useAssistantStore.getState().bumpFolder({ role: "sent" });
      refreshLists((meta) => meta.folder === "sent" || meta.folder === "drafts");
      refreshFolders();
      // Confirm, unless a newer toast (another action's Undo) is on screen.
      const shown = useToastStore.getState().toast;
      if (!shown || shown.id === sendingToast) showToast(`Sent to ${c.to.trim()}`);
    } catch {
      reopen(c);
      showToast({ text: "Could not send. Your message is back in the editor.", kind: "error" });
    }
  };

  const entry = pushUndo("Send", () => {
    const p = pendingSends.get(entry.id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingSends.delete(entry.id);
    reopen(c);
  });
  pendingSends.set(entry.id, { timer: setTimeout(() => void fire(), windowMs), fire });
  const sendingToast = showToast({ text: `Sending to ${c.to.trim()}`, undo: () => void runUndo(entry.id), durationMs: windowMs });
  return true;
}

/** Sends everything still inside its undo window right now (page is closing). */
export function flushPendingSends(): void {
  for (const p of [...pendingSends.values()]) {
    clearTimeout(p.timer);
    void p.fire();
  }
}

/** Queues the compose for later. `sendAt` is an ISO timestamp with timezone. */
export async function schedule(c: ComposeState, sendAt: string, label?: string): Promise<boolean> {
  const to = parseAddressList(c.to);
  if (!to.length) {
    showToast("Add a recipient before scheduling.");
    return false;
  }
  useComposeStore.getState().discard();
  try {
    const api = getMailApi();
    const s = await api.scheduleSend({
      inbox_id: c.inbox_id,
      to,
      cc: parseAddressList(c.cc),
      bcc: parseAddressList(c.bcc),
      subject: c.subject,
      body_text: c.body,
      send_at: sendAt,
    });
    if (c.draft_id) await api.deleteDraft(c.inbox_id, c.draft_id).catch(() => {});
    useAssistantStore.getState().bumpFolder({ role: "scheduled" });
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: keys.scheduled });
      refreshLists((meta) => meta.folder === "scheduled" || meta.folder === "drafts");
    };
    refresh();
    const entry = pushUndo("Schedule", async () => {
      await api.cancelScheduled(s.inbox_id, s.id).catch(() => {});
      refresh();
      reopen({ ...c, draft_id: undefined });
    });
    showToast({ text: `Scheduled for ${label ?? new Date(sendAt).toLocaleString()}`, undo: () => void runUndo(entry.id) });
    return true;
  } catch {
    reopen(c);
    showToast({ text: "Could not schedule. Your message is back in the editor.", kind: "error" });
    return false;
  }
}

export async function cancelScheduled(inbox_id: string, id: string): Promise<void> {
  try {
    await getMailApi().cancelScheduled(inbox_id, id);
    showToast("Scheduled send cancelled");
  } catch {
    showToast({ text: "Could not cancel that send.", kind: "error" });
  }
  void queryClient.invalidateQueries({ queryKey: keys.scheduled });
  refreshLists((meta) => meta.folder === "scheduled");
}

/** Runs the latest undo (the `z` shortcut). */
export function undoLast(): void {
  const offered = useToastStore.getState().toast;
  if (runUndo() == null) {
    showToast("Nothing to undo");
    return;
  }
  // The toast that offered this undo is spent: do not leave a dead button up.
  if (offered?.undo) useToastStore.getState().dismiss(offered.id);
}

/** Opens a row the way a click does: drafts open the editor, the rest the reader. */
export function openRow(row: MessageRow): void {
  if (row.folder_role === "drafts") void openDraft(row);
  else useSelectionStore.getState().select(row.key);
}

/** Jumps to an email from the assistant transcript: its folder, then the row. */
export function openEmailFromChat(key: MessageKey): void {
  const row = findRow(key);
  const selection = useSelectionStore.getState();
  const role = row?.folder_role;
  if (row && role && role !== "trash" && role !== selectionRole()) selection.openFolder({ role }, "all");
  else if (row && !role) selection.openFolder({ inbox_id: row.inbox_id, folder_id: row.folder }, selection.scope);
  else if (selection.query) selection.setQuery("");
  selection.select(key);
}

function selectionRole(): string | null {
  const f = useSelectionStore.getState().folder;
  return isRoleRef(f) ? f.role : null;
}

export const mailActions = {
  archive,
  trash,
  move,
  markRead,
  star,
  send,
  schedule,
  cancelScheduled,
  saveDraft,
  discardDraft,
  newCompose,
  startReply,
  openDraft,
  openRow,
  openEmailFromChat,
  undoLast,
};

export type MailActions = typeof mailActions;
