import { ApiError, attachmentsTooLargeMessage, describeError, getMailApi, newIdempotencyKey } from "../api";
import {
  type DraftInput,
  type FolderRef,
  FOLDER_ROLE_LABEL,
  type Inbox,
  type MessageDetail,
  type MessageKey,
  type MessageRow,
  type MoveResult,
  MAX_ATTACHMENT_BYTES,
  type OutgoingAttachment,
  isNameRef,
  isRoleRef,
  parseAddressList,
} from "../api/types";
import { usableInboxes } from "../api/inbox-health";
import { useAssistantStore } from "../state/assistant-store";
import { useReconnectStore } from "../state/connection-store";
import { type ComposeMode, type ComposeState, composeSignature, isComposeEmpty, useComposeStore } from "../state/compose-store";
import { neighbourAfterRemoval, useSelectionStore } from "../state/selection-store";
import { showToast, useToastStore } from "../state/toast-store";
import { canWrite, refuseWrite } from "../state/permissions";
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
import { blobToBase64 } from "../lib/base64";
import { keys } from "./keys";
import { queryClient } from "./query-client";
import { applyKeyRemap } from "./remap";
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

/** Retry is offered where doing the thing again is harmless: the request
 *  never reached the server, or the server said it is safe to repeat. */
function retryOf(err: unknown, run: () => void): { label: string; run: () => void } | undefined {
  return err instanceof ApiError && (err.retryable || err.code === "offline") ? { label: "Retry", run } : undefined;
}

function rollback(snap: MailSnapshot, message: string, action?: { label: string; run: () => void }): void {
  restoreMail(snap);
  refreshLists();
  refreshFolders();
  showToast({ text: message, kind: "error", action });
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

/** A scheduled send sits in a list like an email but is not one: it has no
 *  message id to move, flag or reply to (the reader offers "Cancel send"). */
function mailOnly(target: MessageKey[]): MessageKey[] {
  return target.filter((k) => findRow(k)?.folder_role !== "scheduled");
}

async function relocate(all: MessageKey[], o: RelocateOptions): Promise<void> {
  const target = mailOnly(all);
  if (!target.length || refuseWrite()) return;
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
    let lost = 0;
    for (const m of result.moved) {
      const row = rowByKey.get(m.key);
      if (!row) continue;
      // The server could not say which id the message has now: it cannot be
      // addressed, so it cannot be moved back from here.
      if (m.id_unknown) {
        lost++;
        continue;
      }
      const id = `${row.inbox_id}|${row.folder}`;
      const group = byOrigin.get(id) ?? { origin: originOf(row), keys: [] };
      group.keys.push(m.new_key);
      byOrigin.set(id, group);
    }
    try {
      for (const g of byOrigin.values()) {
        const back = await getMailApi().moveMessages(g.keys, g.origin);
        // Back in its folder under yet another id (IMAP): the restored rows,
        // the open message and any reply being written follow it.
        const now = new Map(back.moved.map((m) => [m.key, m.new_key]));
        const pairs = result.moved
          .filter((m) => now.has(m.new_key))
          .map((m) => ({ key: m.key, new_key: now.get(m.new_key) ?? m.new_key }));
        applyKeyRemap(pairs, g.origin);
      }
    } catch {
      showToast({ text: "Could not undo that.", kind: "error" });
    }
    if (lost) {
      showToast({
        text: `This mailbox does not report where moved mail went, so ${lost === 1 ? "it" : `${lost} emails`} could not be moved back. Find ${lost === 1 ? "it" : "them"} in ${o.label.replace(/^.* to /, "") || "the destination folder"}.`,
        kind: "error",
      });
    }
    refreshLists();
    refreshFolders({ own: true });
  };

  const entry = pushUndo(o.label, undo);
  showToast({ text: o.label, undo: () => void runUndo(entry.id) });

  try {
    const result = await pending;
    if (undone) return;
    // The messages have new ids now (IMAP). Rows that stay visible (search,
    // Starred), cached bodies, the selection and an open reply follow them.
    applyKeyRemap(result.moved.filter((m) => !m.id_unknown), o.destination);
    refreshLists((meta) => listShows(meta, o.destination));
  } catch (err) {
    dropUndo(entry.id);
    if (undone) return;
    rollback(
      snap,
      describeError(err, o.failure),
      retryOf(err, () => void relocate(target, o)),
    );
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

export async function markRead(all: MessageKey[], read: boolean, opts: FlagOptions = {}): Promise<void> {
  const target = mailOnly(all);
  if (!target.length) return;
  if (opts.silent ? !canWrite() : refuseWrite()) return;
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
  } catch (err) {
    // Targeted rollback (not a snapshot restore): flag changes overlap with
    // other optimistic updates all the time, e.g. archive selects the next
    // row, which marks it read.
    applyFlags(changing, { read: !read });
    refreshFolders();
    // Opening a message marks it read quietly; failing at that is not worth a toast.
    if (!opts.silent) {
      showToast({
        text: describeError(err, read ? "Could not mark as read." : "Could not mark as unread."),
        kind: "error",
        action: retryOf(err, () => void markRead(changing, read, opts)),
      });
    }
  }
}

export async function star(all: MessageKey[], starred: boolean): Promise<void> {
  const target = mailOnly(all);
  if (!target.length || refuseWrite()) return;
  // Unstarring drops rows from the Starred list, so that case needs the snapshot.
  const snap = starred ? null : snapshotMail();
  applyFlags(target, { starred });
  try {
    await getMailApi().setFlags(target, { starred });
    refreshLists((meta) => meta.folder === "starred");
  } catch (err) {
    if (snap) restoreMail(snap);
    else applyFlags(target, { starred: false });
    refreshLists((meta) => meta.folder === "starred");
    showToast({
      text: describeError(err, starred ? "Could not star that." : "Could not remove the star."),
      kind: "error",
      action: retryOf(err, () => void star(target, starred)),
    });
  }
}

/* ------------------------------------------------------------------
 * Compose: open
 * ------------------------------------------------------------------ */

function inboxes(): Inbox[] {
  return queryClient.getQueryData<Inbox[]>(keys.inboxes) ?? [];
}

/** The mailbox a new message is sent from: the active scope, else the first
 *  inbox. Never one that cannot send (it is down, per `/session`), as long
 *  as another can. */
export function defaultInboxId(): string {
  const scope = useSelectionStore.getState().scope;
  const all = inboxes();
  const usable = usableInboxes(all, useReconnectStore.getState().inboxes);
  if (scope !== "all" && (usable.some((i) => i.inbox_id === scope) || !usable.length)) return scope;
  return (usable[0] ?? all[0])?.inbox_id ?? "";
}

export function newCompose(init: Partial<ComposeState> = {}): void {
  if (refuseWrite()) return;
  useComposeStore.getState().open({ inbox_id: defaultInboxId(), mode: "new", ...init });
}

const stripRe = (s: string) => s.replace(/^(re|fwd?):\s*/i, "");

/** Starts the preview of the original in a forward's editor. The server relays
 *  the original itself (HTML, inline images, attachments), so everything from
 *  this line on is shown for reference and NOT sent: only the note above it is. */
export const FORWARD_MARKER = "---------- Forwarded message ----------";

/** The note the person wrote above the forwarded original. */
export function forwardNote(body: string): string {
  const at = body.indexOf(FORWARD_MARKER);
  return (at < 0 ? body : body.slice(0, at)).trimEnd();
}

/** Opens a reply / reply-all / forward for a message, from whatever is cached. */
export function startReply(key: MessageKey, mode: Exclude<ComposeMode, "new">): void {
  if (refuseWrite()) return;
  const detail = queryClient.getQueryData<MessageDetail>(keys.message(key));
  const row: MessageRow | MessageDetail | undefined = findRow(key) ?? detail;
  if (!row || row.folder_role === "drafts" || row.folder_role === "scheduled") return;
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
      // No stray space when the sender has no display name.
      body: `\n\n${FORWARD_MARKER}\nFrom: ${row.from.name.trim() ? `${row.from.name.trim()} ` : ""}<${row.from.email}>\nSubject: ${row.subject}\n\n${body}`,
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
  if (refuseWrite()) return;
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
  // Our own save or delete: only this mailbox's Drafts count can have moved.
  refreshFolders({ own: true });
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
  // Quietly: autosave must not nag a read-only member.
  if (!c || c.streaming || c.held || !canWrite()) return;
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
  } catch (err) {
    // What was typed is never lost: the form stays (or comes back) as it was.
    if (!opts.keepOpen && !useComposeStore.getState().compose) useComposeStore.getState().open(c);
    const offline = err instanceof ApiError && err.code === "offline";
    // Autosave while offline would nag on every pause in typing.
    if (!(opts.keepOpen && offline)) {
      showToast({
        text: offline ? "You are offline. The draft is kept here until you are back." : "Could not save the draft. It is still open.",
        kind: "error",
      });
    }
  }
}

export async function discardDraft(): Promise<void> {
  const c = useComposeStore.getState().discard();
  if (!c) return;
  if (!canWrite()) return;
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

/** Size of the files on a compose, in bytes. */
export function attachmentBytes(c: Pick<ComposeState, "attachments">): number {
  return (c.attachments ?? []).reduce((n, a) => n + a.size, 0);
}

/** The reason this compose cannot be sent because of its files, or null. */
export function attachmentProblem(c: Pick<ComposeState, "attachments">): string | null {
  const total = attachmentBytes(c);
  return total > MAX_ATTACHMENT_BYTES ? attachmentsTooLargeMessage(total) : null;
}

async function outgoingAttachments(c: ComposeState): Promise<OutgoingAttachment[] | undefined> {
  const files = (c.attachments ?? []).filter((a) => a.file);
  if (!files.length) return undefined;
  return Promise.all(
    files.map(async (a) => ({
      filename: a.name,
      mime_type: a.type || "application/octet-stream",
      data: await blobToBase64(a.file as File),
    })),
  );
}

type Keyed = ComposeState & { sendKey: NonNullable<ComposeState["sendKey"]> };

/** The idempotency key for sending this exact content: the same one as the
 *  last attempt when nothing was changed since, a new one otherwise. */
function withSendKey(c: ComposeState): Keyed {
  const signature = [
    c.mode,
    c.inbox_id,
    c.replyTo ?? "",
    composeSignature(c),
    (c.attachments ?? []).map((a) => `${a.name}:${a.size}`).join("|"),
  ].join("\u0001");
  const sendKey = c.sendKey?.signature === signature ? c.sendKey : { key: newIdempotencyKey(), signature };
  return { ...c, sendKey };
}

async function deliver(c: ComposeState): Promise<void> {
  const api = getMailApi();
  const to = parseAddressList(c.to);
  const cc = parseAddressList(c.cc);
  const bcc = parseAddressList(c.bcc);
  const extras = { attachments: await outgoingAttachments(c), idempotency_key: c.sendKey?.key };
  if ((c.mode === "reply" || c.mode === "reply_all") && c.replyTo) {
    // What is on screen is what is sent: the To, Cc and Bcc lines go out as
    // they stand (the server derives nothing when `to` is given), threaded.
    await api.replyToMessage({
      key: c.replyTo,
      reply_all: c.mode === "reply_all",
      to,
      cc,
      bcc,
      subject: c.subject,
      body_text: c.body,
      ...extras,
    });
  } else if (c.mode === "forward" && c.replyTo) {
    await api.forwardMessage({ key: c.replyTo, to, cc, bcc, body_text: forwardNote(c.body), ...extras });
  } else {
    await api.sendMessage({ inbox_id: c.inbox_id, to, cc, bcc, subject: c.subject, body_text: c.body, ...extras });
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
export function send(draft: ComposeState, opts: SendOptions = {}): boolean {
  if (draft.streaming || refuseWrite()) return false;
  if (!parseAddressList(draft.to).length) {
    showToast("Add a recipient before sending.");
    return false;
  }
  const problem = attachmentProblem(draft);
  if (problem) {
    showToast({ text: problem, kind: "error" });
    return false;
  }
  const c = withSendKey(draft);
  const windowMs = opts.undoWindowMs ?? DEFAULT_UNDO_SEND_MS;
  const store = useComposeStore.getState();
  if (store.compose === draft || (store.compose && store.compose.replyTo === c.replyTo)) store.discard();
  if (c.replyTo) useAssistantStore.getState().setLabel([c.replyTo], null);

  const fire = async () => {
    pendingSends.delete(entry.id);
    dropUndo(entry.id);
    try {
      await deliver(c);
      useAssistantStore.getState().bumpFolder({ role: "sent" });
      refreshLists((meta) => meta.folder === "sent" || meta.folder === "drafts");
      // A reply belongs to a conversation: the open thread shows it.
      if (c.replyTo) void queryClient.invalidateQueries({ queryKey: keys.threadRoot });
      refreshFolders({ own: true });
      // Confirm, unless a newer toast (another action's Undo) is on screen.
      const shown = useToastStore.getState().toast;
      if (!shown || shown.id === sendingToast) showToast(`Sent to ${c.to.trim()}`);
    } catch (err) {
      // Never lost: the message goes back into the editor exactly as it was,
      // with the same idempotency key for the next attempt.
      reopen(c);
      const offline = err instanceof ApiError && err.code === "offline";
      showToast({
        text: offline
          ? "You are offline. Your message is back in the editor."
          : describeError(err, "Could not send. Your message is back in the editor."),
        kind: "error",
        action: retryOf(err, () => {
          const now = useComposeStore.getState().compose;
          if (now) send(now, { undoWindowMs: 0 });
        }),
      });
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

/** Sends everything still inside its undo window right now (page is closing,
 *  signing out). Resolves when those sends have settled. */
export function flushPendingSends(): Promise<void> {
  const fires: Promise<void>[] = [];
  for (const p of [...pendingSends.values()]) {
    clearTimeout(p.timer);
    fires.push(p.fire());
  }
  return Promise.all(fires).then(() => {});
}

/** Queues the compose for later. `sendAt` is an ISO timestamp with timezone. */
export async function schedule(draft: ComposeState, sendAt: string, label?: string): Promise<boolean> {
  if (refuseWrite()) return false;
  const to = parseAddressList(draft.to);
  if (!to.length) {
    showToast("Add a recipient before scheduling.");
    return false;
  }
  const problem = attachmentProblem(draft);
  if (problem) {
    showToast({ text: problem, kind: "error" });
    return false;
  }
  const c = withSendKey(draft);
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
      attachments: await outgoingAttachments(c),
      idempotency_key: c.sendKey.key,
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
  } catch (err) {
    reopen(c);
    showToast({ text: describeError(err, "Could not schedule. Your message is back in the editor."), kind: "error" });
    return false;
  }
}

export async function cancelScheduled(inbox_id: string, id: string): Promise<void> {
  if (refuseWrite()) return;
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
  if (row.folder_role === "drafts" && canWrite()) void openDraft(row);
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
