/* HttpMailApi: MailApi over `client-api` (see the backend contract).
 *
 * Every mail call is `POST /mail { op, inbox_id, args }`; reads are coalesced
 * into `POST /mail/batch` by the ApiClient. Result shapes are the MCP tool
 * results (the wire types in `api/types.ts`).
 *
 * Rules kept here:
 * - Every call is per inbox. Scope 'all' fans out and merges with
 *   `mergeInboxPages`; an inbox that fails does not fail the list, it is
 *   reported in `MessagePage.failed_inboxes`.
 * - `is_flagged` on the wire is `is_starred` in the client.
 * - `starred` = search with `flagged: true`; `scheduled` = the schedule list;
 *   `drafts` = the draft list (so a row id IS a draft id).
 * - Multi-key mutations are grouped by inbox: one call per inbox.
 * - Recipients go out as plain address strings.
 * - Every send carries an idempotency key; the caller passes the same key
 *   when it retries the same send.
 */

import type { MailApi } from "../mail-api";
import { hasServerStatus, inboxHealth } from "../inbox-health";
import type { PartialPageListener } from "../mail-api";
import { type InboxPage, mergeInboxPages } from "../merge";
import {
  type AssistantAllowance,
  type AttachmentDownload,
  BACKEND_FOLDER_ALIASES,
  type ContactHit,
  type DraftDetail,
  type DraftInput,
  type DraftRef,
  type DraftSummary,
  type EmailAddressEntry,
  type EmailSummary,
  type FolderEntry,
  type FolderRef,
  type FolderRole,
  type FolderStatus,
  type FolderStatusWire,
  type ForwardMessageInput,
  type Inbox,
  type InboxFailure,
  type ListInboxResult,
  type ListMessagesParams,
  MAX_ATTACHMENT_BYTES,
  type MailEvent,
  type MailEventListener,
  type MessageDetail,
  type MessageFlags,
  type MessageKey,
  type MessagePage,
  type MessageRow,
  type MessageThread,
  type MoveResult,
  type OutgoingAttachment,
  type ReadEmailResult,
  type RelocateResult,
  type ReplyMessageInput,
  type ScheduledSend,
  type ScheduleSendInput,
  type SearchMessagesParams,
  type SendMessageInput,
  type SendResult,
  type SessionInfo,
  type ThreadResult,
  isExactRef,
  isRoleRef,
  makeKey,
  parseKey,
  roleOfFolder,
} from "../types";
import { ApiClient, ApiError, isAbortError } from "./client";

export interface HttpMailApiOptions {
  client: ApiClient;
  now?: () => number;
  /** Idempotency key source. */
  newId?: () => string;
}

/** Told to the sync engine, so its own changes are not announced as news. */
export interface MutationNotice {
  phase: "start" | "end";
  inbox_ids: string[];
  /** Keys the mutation touched, plus the keys they have afterwards. */
  keys: MessageKey[];
  /** Per mailbox, the only folders whose counts or contents this mutation
   *  can have changed (role aliases, names or ids, as `status` accepts them).
   *  An empty list: no folder changed (a scheduled send). */
  touched: { inbox_id: string; folders: string[] }[];
}

/** `missing`: folders asked about that the mailbox no longer has. */
export type InboxStatus = { ok: true; folders: FolderStatus[]; missing: string[] } | { ok: false; error: ApiError };

const SESSION_FRESH_MS = 10_000;
const FOLDER_MEMO_MS = 60_000;
const MAX_KNOWN = 5000;
const LIST_LIMIT_MAX = 100;
/** `read` windows long bodies. The reader wants the whole message. */
const READ_BODY_MAX_CHARS = 2_000_000;
/** `status` accepts at most this many folders per inbox. */
export const STATUS_MAX_FOLDERS = 20;
const IMAP_SEARCH_FOLDERS = ["inbox", "archive", "sent"];

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

const emails = (list: EmailAddressEntry[] | undefined): string[] => (list ?? []).map((a) => a.email).filter(Boolean);

/** Accepts `[...]` or `{ [field]: [...] }`. */
function arr<T>(value: unknown, field: string): T[] {
  if (Array.isArray(value)) return value as T[];
  const inner = value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
  return Array.isArray(inner) ? (inner as T[]) : [];
}

/** Decoded size of a base64 string. */
export function base64Bytes(data: string): number {
  const len = data.length;
  if (!len) return 0;
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

export function attachmentsTooLargeMessage(bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `Attachments total ${mb} MB. The limit is 10 MB per message: remove a file to send.`;
}

/** `attachment; filename*=UTF-8''na%C3%AFve.pdf; filename="naive.pdf"` -> the name. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star?.[2]) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(header);
  if (!plain) return null;
  const raw = plain[2] != null ? plain[2].replace(/\\(.)/g, "$1") : (plain[1] ?? "").trim();
  return raw || null;
}

/** Reads a `RelocateResult` (the one shape `move`, `archive` and `delete`
 *  answer with). A message the server did not report as moved was not moved:
 *  that, and any refused row, throws. */
export function parseMoveResult(inbox_id: string, ids: string[], result: unknown): MoveResult {
  const rows = new Map<string, RelocateResult["results"][number]>();
  for (const row of arr<RelocateResult["results"][number]>(result, "results")) {
    if (row && typeof row.message_id === "string") rows.set(row.message_id, row);
  }
  const moved: MoveResult["moved"] = [];
  let failed = 0;
  for (const id of ids) {
    const row = rows.get(id);
    if (!row || row.success !== true) {
      failed++;
      continue;
    }
    const key = makeKey(inbox_id, id);
    if (typeof row.new_message_id === "string" && row.new_message_id) moved.push({ key, new_key: makeKey(inbox_id, row.new_message_id) });
    else moved.push({ key, new_key: key, id_unknown: true });
  }
  if (failed) {
    throw new ApiError("partial_failure", `${failed} of ${ids.length} could not be changed.`, { retryable: false });
  }
  return { moved };
}

/** `role` as the server sends it on a folder entry: one of the six system
 *  roles or null. Absent stays absent (the client then guesses from names);
 *  a value this build does not know is read as "no system role". */
function withKnownRole(f: FolderEntry): FolderEntry {
  if (f.role === undefined || f.role === null) return f;
  return (BACKEND_FOLDER_ALIASES as readonly string[]).includes(f.role) ? f : { ...f, role: null };
}

function groupByInbox(keys: MessageKey[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const key of keys) {
    const { inbox_id, id } = parseKey(key);
    const list = out.get(inbox_id);
    if (list) list.push(id);
    else out.set(inbox_id, [id]);
  }
  return out;
}

export class HttpMailApi implements MailApi {
  private readonly client: ApiClient;
  private readonly now: () => number;
  private readonly newId: () => string;

  private listeners = new Set<MailEventListener>();
  private mutationListeners = new Set<(m: MutationNotice) => void>();
  private sessionListeners = new Set<(s: SessionInfo) => void>();

  private session: SessionInfo | null = null;
  /** When `session` came from the server (0 = seeded from the local cache). */
  private sessionAt = 0;
  private sessionPromise: Promise<SessionInfo> | null = null;
  /** The session's allowance answers the first allowance read only. */
  private allowanceTaken = true;

  /** What list rows told us, for reads that do not carry it. */
  private known = new Map<MessageKey, { folder: string; starred: boolean; role: FolderRole | null }>();
  private folderMemo = new Map<string, { at: number; entries: FolderEntry[] }>();
  private scheduledSeen = new Map<MessageKey, ScheduledSend>();
  /** Draft ids change on every save: old id -> the id that replaced it. */
  private draftAlias = new Map<string, string>();
  private draftChain = new Map<string, Promise<unknown>>();

  constructor(options: HttpMailApiOptions) {
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? newIdempotencyKey;
  }

  /* ================= session ================= */

  /** The last session of this user + workspace, from the local cache. Lets
   *  the first batch of reads go out in parallel with `GET /session`. */
  seedSession(session: SessionInfo): void {
    if (this.session) return;
    this.session = session;
    this.applyHealth(session);
  }

  /** Tells the client which mailboxes `/session` calls down, so nothing is
   *  sent for them. A server that sends no `status` says nothing here: what
   *  the client remembered about refusals stands. */
  private applyHealth(s: SessionInfo): void {
    if (!hasServerStatus(s.inboxes)) return;
    const down: string[] = [];
    const ok: string[] = [];
    for (const i of s.inboxes) (inboxHealth(i).usable ? ok : down).push(i.inbox_id);
    this.client.setInboxHealth(down, ok);
  }

  /** A mail call for a mailbox the session calls down just succeeded (the
   *  periodic probe, after a reconnect in the dashboard): the session is
   *  corrected here, without waiting for the server's next `/session`, which
   *  may be up to a minute behind. Returns the corrected session, or null
   *  when there was nothing to correct. */
  markInboxOk(inbox_id: string): SessionInfo | null {
    const s = this.session;
    const inbox = s?.inboxes.find((i) => i.inbox_id === inbox_id);
    if (!s || !inbox || inbox.status === undefined || inboxHealth(inbox).usable) return null;
    this.session = { ...s, inboxes: s.inboxes.map((i) => (i === inbox ? { ...i, status: "ok", status_reason: null } : i)) };
    return this.session;
  }

  peekSession(): SessionInfo | null {
    return this.session;
  }

  /** `GET /session`. Concurrent calls share one request. */
  getSession(signal?: AbortSignal): Promise<SessionInfo> {
    if (!this.sessionPromise) {
      const p = this.client.get<SessionInfo>("/session").then((s) => {
        this.session = s;
        this.sessionAt = this.now();
        this.allowanceTaken = false;
        this.applyHealth(s);
        for (const l of [...this.sessionListeners]) l(s);
        return s;
      });
      this.sessionPromise = p;
      const clear = () => {
        if (this.sessionPromise === p) this.sessionPromise = null;
      };
      p.then(clear, clear);
    }
    const p = this.sessionPromise;
    if (!signal) return p;
    return new Promise<SessionInfo>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /** Fires with every session the server returns. */
  onSession(listener: (s: SessionInfo) => void): () => void {
    this.sessionListeners.add(listener);
    return () => void this.sessionListeners.delete(listener);
  }

  private sessionIsFresh(): boolean {
    return !!this.session && this.sessionAt > 0 && this.now() - this.sessionAt < SESSION_FRESH_MS;
  }

  private async inboxIds(scope: string, signal?: AbortSignal): Promise<string[]> {
    if (scope !== "all") return [scope];
    const s = this.session ?? (await this.getSession(signal));
    return s.inboxes.map((i) => i.inbox_id);
  }

  private inboxOf(inbox_id: string): Inbox | undefined {
    return this.session?.inboxes.find((i) => i.inbox_id === inbox_id);
  }

  /** Forgets everything about the signed-in user and aborts what is in flight. */
  reset(): void {
    this.client.reset();
    this.session = null;
    this.sessionAt = 0;
    this.sessionPromise = null;
    this.allowanceTaken = true;
    this.known.clear();
    this.folderMemo.clear();
    this.scheduledSeen.clear();
    this.draftAlias.clear();
    this.draftChain.clear();
  }

  /* ================= events ================= */

  subscribe(listener: MailEventListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The sync engine publishes what it found through the same channel a
   *  server push would use. */
  emit(event: MailEvent): void {
    for (const l of [...this.listeners]) l(event);
  }

  onMutation(listener: (m: MutationNotice) => void): () => void {
    this.mutationListeners.add(listener);
    return () => void this.mutationListeners.delete(listener);
  }

  /** `folders`: what the mutation can have changed in each of its mailboxes
   *  (the same list for every mailbox, or one list per mailbox). */
  private async mutating<T>(
    inbox_ids: string[],
    keys: MessageKey[],
    folders: readonly string[] | ReadonlyMap<string, Iterable<string>>,
    run: () => Promise<{ value: T; keys?: MessageKey[] }>,
  ): Promise<T> {
    const touched = inbox_ids.map((inbox_id) => {
      const list: Iterable<string> = Array.isArray(folders) ? (folders as readonly string[]) : ((folders as ReadonlyMap<string, Iterable<string>>).get(inbox_id) ?? []);
      return { inbox_id, folders: [...new Set(list)] };
    });
    const tell = (m: MutationNotice) => {
      for (const l of [...this.mutationListeners]) l(m);
    };
    tell({ phase: "start", inbox_ids, keys, touched });
    try {
      const out = await run();
      tell({ phase: "end", inbox_ids, keys: [...keys, ...(out.keys ?? [])], touched });
      return out.value;
    } catch (err) {
      tell({ phase: "end", inbox_ids, keys, touched });
      throw err;
    }
  }

  /** Per mailbox, the folders these messages are in (as far as list rows
   *  told us), plus `also` for every mailbox. */
  private foldersOf(keys: MessageKey[], also: readonly string[] = []): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const key of keys) {
      const { inbox_id } = parseKey(key);
      const set = out.get(inbox_id) ?? new Set<string>(also);
      out.set(inbox_id, set);
      const folder = this.known.get(key)?.folder;
      if (folder) set.add(folder);
    }
    return out;
  }

  /* ================= rows ================= */

  private remember(row: MessageRow): void {
    if (this.known.size >= MAX_KNOWN) {
      // Oldest first: a Map iterates in insertion order.
      let drop = MAX_KNOWN / 10;
      for (const k of this.known.keys()) {
        this.known.delete(k);
        if (--drop <= 0) break;
      }
    }
    this.known.set(row.key, { folder: row.folder, starred: row.is_starred, role: row.folder_role });
  }

  protected toRow(inbox_id: string, m: EmailSummary, extra: { starred?: boolean; role?: FolderRole | null } = {}): MessageRow {
    const key = makeKey(inbox_id, m.id);
    const row: MessageRow = {
      ...m,
      to: m.to ?? [],
      key,
      inbox_id,
      is_starred: m.is_flagged ?? extra.starred ?? this.known.get(key)?.starred ?? false,
      folder_role: this.roleOfId(inbox_id, m.folder ?? "") ?? extra.role ?? null,
    };
    this.remember(row);
    return row;
  }

  /** The role of a folder id of one mailbox: what the server's folder list
   *  says when it carries roles (ids are opaque and names localised on some
   *  providers), a guess from the id otherwise. */
  private roleOfId(inbox_id: string, folder: string): FolderRole | null {
    const entry = this.folderMemo.get(inbox_id)?.entries.find((f) => f.id === folder);
    if (entry && entry.role !== undefined) return entry.role;
    return roleOfFolder(folder);
  }

  /* ================= reads ================= */

  async listInboxes(signal?: AbortSignal): Promise<Inbox[]> {
    if (this.session && this.sessionIsFresh()) return this.session.inboxes;
    return (await this.getSession(signal)).inboxes;
  }

  async listFolders(inbox_id: string, signal?: AbortSignal): Promise<FolderEntry[]> {
    // Slow lane: listing folders takes seconds on IMAP, and a batch answers
    // only when its slowest call has. Message lists must not wait for it.
    const entries = arr<FolderEntry>(await this.client.read("folders", inbox_id, {}, signal, "slow"), "folders").map(withKnownRole);
    this.folderMemo.set(inbox_id, { at: this.now(), entries });
    return entries;
  }

  private async foldersMemo(inbox_id: string, signal?: AbortSignal): Promise<FolderEntry[]> {
    const hit = this.folderMemo.get(inbox_id);
    if (hit && this.now() - hit.at < FOLDER_MEMO_MS) return hit.entries;
    return this.listFolders(inbox_id, signal);
  }

  /** The `folder` argument for one inbox, or null when that inbox has no such folder. */
  private async folderArg(inbox_id: string, ref: FolderRef, signal?: AbortSignal): Promise<string | null> {
    if (isRoleRef(ref)) return BACKEND_FOLDER_ALIASES.includes(ref.role) ? ref.role : null;
    if (isExactRef(ref)) return ref.inbox_id === inbox_id ? ref.folder_id : null;
    const wanted = ref.name.toLowerCase();
    const entries = await this.foldersMemo(inbox_id, signal);
    return entries.find((f) => f.name.toLowerCase() === wanted)?.id ?? null;
  }

  private async pageOf(
    inbox_id: string,
    op: "list" | "search",
    args: Record<string, unknown>,
    extra: { starred?: boolean; role?: FolderRole | null },
    signal?: AbortSignal,
  ): Promise<InboxPage> {
    const r = await this.client.read<ListInboxResult>(op, inbox_id, args, signal);
    const messages = arr<EmailSummary>(r, "messages");
    return {
      inbox_id,
      rows: messages.map((m) => this.toRow(inbox_id, m, extra)),
      total: typeof r?.total === "number" ? r.total : null,
      total_is_estimate: r?.total_is_estimate === true,
      has_more: r?.has_more === true,
      next_offset: r?.next_offset ?? null,
    };
  }

  /** Fans a paged read out over the inboxes in scope. One inbox failing does
   *  not fail the page: it is listed in `failed_inboxes`. All failing does. */
  private async merged(
    scope: string,
    cursor: ListMessagesParams["cursor"],
    limit: number,
    fetchOne: (inbox_id: string, offset: number, limit: number) => Promise<InboxPage>,
    signal?: AbortSignal,
    onPartial?: PartialPageListener,
  ): Promise<MessagePage> {
    const failures: InboxFailure[] = [];
    // Mailboxes the session calls down are not asked at all: the server
    // would answer 409 without looking. They are reported like any other
    // mailbox that could not be loaded, with the session's reason as text.
    const ids: string[] = [];
    for (const id of await this.inboxIds(scope, signal)) {
      const inbox = this.inboxOf(id);
      const health = inbox ? inboxHealth(inbox) : null;
      if (health && !health.usable) failures.push({ inbox_id: id, code: health.code ?? "reconnect_required", message: health.notice ?? "" });
      else ids.push(id);
    }
    const down = failures[0];
    if (!ids.length && down) throw new ApiError(down.code, down.message, { status: 409 });

    const skipped = failures.length;
    let attempted = 0;
    let firstError: unknown = null;
    const withFailures = (page: MessagePage): MessagePage => (failures.length ? { ...page, failed_inboxes: [...failures] } : page);
    const page = await mergeInboxPages(
      ids,
      cursor,
      Math.min(limit, LIST_LIMIT_MAX),
      async (inbox_id, offset, n) => {
        attempted++;
        try {
          return await fetchOne(inbox_id, offset, n);
        } catch (err) {
          if (isAbortError(err) || signal?.aborted) throw err;
          firstError ??= err;
          failures.push({
            inbox_id,
            code: err instanceof ApiError ? err.code : "error",
            message: err instanceof Error ? err.message : "Could not load this mailbox.",
          });
          // Excluded from this listing: it answers "nothing, and no more".
          return { inbox_id, rows: [], total: null, has_more: false };
        }
      },
      onPartial
        ? (partial) => {
            if (!signal?.aborted) onPartial(withFailures(partial));
          }
        : undefined,
    );
    if (failures.length > skipped && failures.length - skipped === attempted) throw firstError;
    return withFailures(page);
  }

  async listMessages(params: ListMessagesParams, signal?: AbortSignal, onPartial?: PartialPageListener): Promise<MessagePage> {
    const { scope, folder, cursor, limit } = params;
    if (isRoleRef(folder) && folder.role === "scheduled") return this.scheduledPage(scope, signal);
    if (isRoleRef(folder) && folder.role === "drafts") return this.draftsPage(scope, signal, onPartial);
    if (isRoleRef(folder) && folder.role === "starred") {
      return this.merged(
        scope,
        cursor,
        limit,
        (id, offset, n) => this.pageOf(id, "search", { flagged: true, limit: n, offset }, { starred: true }, signal),
        signal,
        onPartial,
      );
    }
    const role = isRoleRef(folder) ? folder.role : null;
    return this.merged(
      scope,
      cursor,
      limit,
      async (id, offset, n) => {
        const arg = await this.folderArg(id, folder, signal);
        // This inbox has no folder of that name: nothing to show, not an error.
        if (arg == null) return { inbox_id: id, rows: [], total: 0, has_more: false };
        const args: Record<string, unknown> = { folder: arg, limit: n, offset };
        if (params.unread) args.unread = true;
        return this.pageOf(id, "list", args, { role }, signal);
      },
      signal,
      onPartial,
    );
  }

  async searchMessages(params: SearchMessagesParams, signal?: AbortSignal, onPartial?: PartialPageListener): Promise<MessagePage> {
    const text = params.query.trim();
    return this.merged(
      params.scope,
      params.cursor,
      params.limit,
      (id, offset, n) => {
        const args: Record<string, unknown> = { text, limit: n, offset };
        // IMAP searches one folder at a time and defaults to the inbox only.
        if (this.inboxOf(id)?.provider === "imap") args.include_folders = IMAP_SEARCH_FOLDERS;
        return this.pageOf(id, "search", args, {}, signal);
      },
      signal,
      onPartial,
    );
  }

  private async draftsPage(scope: string, signal?: AbortSignal, onPartial?: PartialPageListener): Promise<MessagePage> {
    return this.merged(
      scope,
      null,
      LIST_LIMIT_MAX,
      async (inbox_id) => {
        const drafts = await this.listDrafts(inbox_id, signal);
        const rows = drafts.map((d) => this.draftRow(inbox_id, d));
        return { inbox_id, rows, total: rows.length, has_more: false };
      },
      signal,
      onPartial,
    );
  }

  private draftRow(inbox_id: string, d: DraftSummary): MessageRow {
    const self = this.inboxOf(inbox_id);
    return {
      id: d.draft_id,
      key: makeKey(inbox_id, d.draft_id),
      inbox_id,
      from: { name: self?.display_name ?? "", email: self?.email_address ?? "" },
      to: d.to ?? [],
      subject: d.subject || "(no subject)",
      date: d.created_at,
      preview: "",
      is_read: true,
      is_starred: false,
      has_attachments: false,
      folder: "drafts",
      folder_role: "drafts",
      thread_id: d.draft_id,
    };
  }

  private async scheduledPage(scope: string, signal?: AbortSignal): Promise<MessagePage> {
    const all = await this.listScheduled(scope === "all" ? undefined : scope, signal);
    const rows = all.map((s) => this.scheduledRow(s)).sort((a, b) => (a.date < b.date ? -1 : 1));
    return { rows, total: rows.length, total_is_estimate: false, has_more: false, next_cursor: null };
  }

  private scheduledRow(s: ScheduledSend): MessageRow {
    const self = this.inboxOf(s.inbox_id);
    return {
      id: s.id,
      key: makeKey(s.inbox_id, s.id),
      inbox_id: s.inbox_id,
      from: { name: self?.display_name ?? "", email: self?.email_address ?? "" },
      to: (s.to ?? []).map((email) => ({ name: "", email })),
      subject: s.subject || "(no subject)",
      date: s.send_at,
      preview: "",
      is_read: true,
      is_starred: false,
      has_attachments: false,
      folder: "scheduled",
      folder_role: "scheduled",
      thread_id: s.id,
    };
  }

  async readMessage(inbox_id: string, id: string, opts: { include_html: boolean }, signal?: AbortSignal): Promise<MessageDetail> {
    const key = makeKey(inbox_id, id);
    const scheduled = this.scheduledSeen.get(key);
    if (scheduled) {
      const row = this.scheduledRow(scheduled);
      const body = (scheduled as ScheduledSend & { body?: string }).body ?? null;
      return {
        ...row,
        cc: [],
        bcc: [],
        reply_to: null,
        body_text: body,
        body_html: null,
        attachments: [],
        labels: [],
        in_reply_to: null,
        references: [],
      };
    }
    const r = await this.client.read<ReadEmailResult>(
      "read",
      inbox_id,
      { message_id: id, include_html: opts.include_html, include_attachments: false, body_max_chars: READ_BODY_MAX_CHARS },
      signal,
    );
    const seen = this.known.get(key);
    const folder = r.folder ?? seen?.folder ?? "";
    return {
      ...r,
      to: r.to ?? [],
      cc: r.cc ?? [],
      bcc: r.bcc ?? [],
      reply_to: r.reply_to ?? null,
      attachments: (r.attachments ?? []).map((a, i) => ({ ...a, attachment_index: a.attachment_index ?? i })),
      labels: r.labels ?? [],
      references: r.references ?? [],
      in_reply_to: r.in_reply_to ?? null,
      body_text: r.body_text ?? null,
      body_html: r.body_html ?? null,
      key,
      inbox_id,
      is_starred: r.is_flagged ?? seen?.starred ?? false,
      folder,
      folder_role: this.roleOfId(inbox_id, folder) ?? seen?.role ?? null,
    };
  }

  /** `thread`: one op, on the background lane so it never delays the `read`
   *  of the message the person just opened. */
  async getThread(key: MessageKey, opts: { thread_key?: string; limit?: number } = {}, signal?: AbortSignal): Promise<MessageThread> {
    const { inbox_id, id } = parseKey(key);
    const args: Record<string, unknown> = { message_id: id };
    if (opts.thread_key) args.thread_key = opts.thread_key;
    if (opts.limit) args.limit = opts.limit;
    const r = await this.client.read<ThreadResult>("thread", inbox_id, args, signal, "background");
    return {
      thread_key: typeof r?.thread_key === "string" ? r.thread_key : (opts.thread_key ?? ""),
      rows: arr<EmailSummary>(r, "messages").map((m) => this.toRow(inbox_id, m)),
      partial: r?.partial === true,
      ...(r?.partial === true && typeof r.partial_reason === "string" ? { partial_reason: r.partial_reason } : {}),
    };
  }

  async downloadAttachment(key: MessageKey, attachment_index: number, signal?: AbortSignal): Promise<AttachmentDownload> {
    const { inbox_id, id } = parseKey(key);
    const { blob, headers } = await this.client.binary({ op: "attachment", inbox_id, args: { message_id: id, attachment_index } }, signal);
    return {
      blob,
      filename: filenameFromDisposition(headers.get("Content-Disposition")) ?? `attachment-${attachment_index + 1}`,
      mime_type: (headers.get("Content-Type") ?? blob.type ?? "application/octet-stream").split(";")[0]?.trim() || "application/octet-stream",
    };
  }

  /** One `status` call per inbox, coalesced into a single batch request.
   *  `folders` are aliases, names or ids (the server checks the inbox only
   *  when none are given). Folders that did not resolve are left out. */
  async getStatus(requests: { inbox_id: string; folders?: string[] }[], signal?: AbortSignal): Promise<Map<string, InboxStatus>> {
    const out = new Map<string, InboxStatus>();
    await Promise.all(
      requests.map(async ({ inbox_id, folders: wanted }) => {
        try {
          const args = wanted?.length ? { folders: wanted.slice(0, STATUS_MAX_FOLDERS) } : {};
          const rows = arr<FolderStatusWire>(await this.client.read("status", inbox_id, args, signal, "background"), "folders");
          const folders: FolderStatus[] = [];
          const missing: string[] = [];
          for (const f of rows) {
            if (f.error === "folder_not_found") missing.push(f.id ?? f.folder);
            if (typeof f.id !== "string" || typeof f.fingerprint !== "string") continue;
            folders.push({ folder: f.folder, id: f.id, total: f.total ?? null, unread: f.unread ?? null, fingerprint: f.fingerprint });
          }
          // Every folder failed, and not because it is gone: the mailbox itself is the problem.
          if (rows.length && !folders.length && missing.length < rows.length) {
            throw new ApiError(rows.find((f) => f.error && f.error !== "folder_not_found")?.error ?? "provider_error", "status failed");
          }
          out.set(inbox_id, { ok: true, folders, missing });
        } catch (err) {
          if (isAbortError(err)) throw err;
          out.set(inbox_id, { ok: false, error: err instanceof ApiError ? err : new ApiError("error", "status failed") });
        }
      }),
    );
    return out;
  }

  /* ================= message mutations ================= */

  private async perInbox(
    keys: MessageKey[],
    op: string,
    args: (ids: string[], inbox_id: string) => Record<string, unknown>,
  ): Promise<Map<string, { ids: string[]; result: unknown }>> {
    const groups = groupByInbox(keys);
    const out = new Map<string, { ids: string[]; result: unknown }>();
    await Promise.all(
      [...groups].map(async ([inbox_id, ids]) => {
        out.set(inbox_id, { ids, result: await this.client.mutate(op, inbox_id, args(ids, inbox_id)) });
      }),
    );
    return out;
  }

  async setFlags(keys: MessageKey[], flags: MessageFlags): Promise<void> {
    if (!keys.length) return;
    const patch: Record<string, unknown> = {};
    if (flags.read !== undefined) patch.read = flags.read;
    if (flags.starred !== undefined) patch.starred = flags.starred;
    // Read state changes a folder's unread count; a star changes no count.
    const folders = flags.read !== undefined ? this.foldersOf(keys) : [];
    await this.mutating([...groupByInbox(keys).keys()], keys, folders, async () => {
      await this.perInbox(keys, "flag", (message_ids) => ({ message_ids, ...patch }));
      if (flags.starred !== undefined) {
        for (const k of keys) {
          const seen = this.known.get(k);
          if (seen) seen.starred = flags.starred;
        }
      }
      return { value: undefined };
    });
  }

  /** `destination`: the folder the messages go to (null: nowhere, they are
   *  deleted for good). Source and destination are what a move can change. */
  private relocate(
    keys: MessageKey[],
    op: string,
    destination: string | null,
    args: (ids: string[], inbox_id: string) => Record<string, unknown>,
  ): Promise<MoveResult> {
    if (!keys.length) return Promise.resolve({ moved: [] });
    return this.mutating([...groupByInbox(keys).keys()], keys, this.foldersOf(keys, destination ? [destination] : []), async () => {
      const results = await this.perInbox(keys, op, args);
      const moved: MoveResult["moved"] = [];
      for (const [inbox_id, { ids, result }] of results) moved.push(...parseMoveResult(inbox_id, ids, result).moved);
      for (const m of moved) {
        if (m.new_key !== m.key || m.id_unknown) this.known.delete(m.key);
      }
      return { value: { moved }, keys: moved.map((m) => m.new_key) };
    });
  }

  moveMessages(keys: MessageKey[], destination: FolderRef): Promise<MoveResult> {
    if (isExactRef(destination) && keys.some((k) => parseKey(k).inbox_id !== destination.inbox_id)) {
      return Promise.reject(new ApiError("invalid_request", "A message cannot be moved to another mailbox."));
    }
    const dest = isRoleRef(destination) ? destination.role : isExactRef(destination) ? destination.folder_id : destination.name;
    if (isRoleRef(destination) && !BACKEND_FOLDER_ALIASES.includes(destination.role)) {
      return Promise.reject(new ApiError("invalid_request", `Messages cannot be moved to ${destination.role}.`));
    }
    return this.relocate(keys, "move", dest, (message_ids) => ({ message_ids, destination_folder_id: dest }));
  }

  archiveMessages(keys: MessageKey[]): Promise<MoveResult> {
    return this.relocate(keys, "archive", "archive", (message_ids) => ({ message_ids }));
  }

  async deleteMessages(keys: MessageKey[], opts?: { permanent?: boolean }): Promise<MoveResult> {
    const permanent = opts?.permanent === true;
    const result = await this.relocate(keys, "delete", permanent ? null : "trash", (message_ids) => ({ message_ids, permanent }));
    return permanent ? { moved: [] } : result;
  }

  /* ================= sending ================= */

  private checkAttachments(list: OutgoingAttachment[] | undefined): OutgoingAttachment[] | undefined {
    if (!list?.length) return undefined;
    const total = list.reduce((n, a) => n + base64Bytes(a.data), 0);
    if (total > MAX_ATTACHMENT_BYTES) throw new ApiError("attachments_too_large", attachmentsTooLargeMessage(total));
    return list.map((a) => ({ filename: a.filename, mime_type: a.mime_type || "application/octet-stream", data: a.data }));
  }

  private async sending(inbox_id: string, op: string, args: Record<string, unknown>): Promise<SendResult> {
    // A send lands in Sent and may take a saved draft with it.
    return this.mutating([inbox_id], [], ["sent", "drafts"], async () => {
      const r = await this.client.mutate<{ message_id?: string | null }>(op, inbox_id, args);
      return { value: { message_id: r?.message_id ?? null, inbox_id } };
    });
  }

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    const attachments = this.checkAttachments(input.attachments);
    return this.sending(input.inbox_id, "send", {
      to: emails(input.to),
      cc: emails(input.cc),
      bcc: emails(input.bcc),
      subject: input.subject,
      body: input.body_text,
      ...(input.body_html ? { html_body: input.body_html } : {}),
      ...(attachments ? { attachments } : {}),
      idempotency_key: input.idempotency_key ?? this.newId(),
    });
  }

  async replyToMessage(input: ReplyMessageInput): Promise<SendResult> {
    const { inbox_id, id } = parseKey(input.key);
    const attachments = this.checkAttachments(input.attachments);
    const idempotency_key = input.idempotency_key ?? this.newId();
    // With `to`, the three lists are sent as they stand on screen and the
    // server derives nothing; without it the server derives To and treats
    // cc / bcc as additions. Threaded under the original either way.
    return this.sending(inbox_id, "reply", {
      message_id: id,
      reply_all: input.reply_all === true,
      ...(input.to?.length ? { to: emails(input.to) } : {}),
      body: input.body_text,
      ...(input.body_html ? { html_body: input.body_html } : {}),
      ...(input.cc?.length ? { cc: emails(input.cc) } : {}),
      ...(input.bcc?.length ? { bcc: emails(input.bcc) } : {}),
      ...(attachments ? { attachments } : {}),
      idempotency_key,
    });
  }

  async forwardMessage(input: ForwardMessageInput): Promise<SendResult> {
    const { inbox_id, id } = parseKey(input.key);
    // The original is relayed server side, its own attachments included. The
    // `forward` op takes no extra files (the tool layer relays the original's
    // bytes and has no place to add parts).
    if (input.attachments?.length) {
      const n = input.attachments.length;
      throw new ApiError(
        "forward_attachments_unsupported",
        `A forward carries the original's attachments, but ${n === 1 ? "the file you added" : `the ${n} files you added`} cannot be sent with it. Remove ${n === 1 ? "it" : "them"} to send, or attach ${n === 1 ? "it" : "them"} to a new message.`,
      );
    }
    return this.sending(inbox_id, "forward", {
      message_id: id,
      to: emails(input.to),
      ...(input.cc?.length ? { cc: emails(input.cc) } : {}),
      ...(input.bcc?.length ? { bcc: emails(input.bcc) } : {}),
      ...(input.body_text ? { body: input.body_text } : {}),
      idempotency_key: input.idempotency_key ?? this.newId(),
    });
  }

  /* ================= drafts ================= */

  private latestDraftId(inbox_id: string, draft_id: string): string {
    let id = draft_id;
    for (let i = 0; i < 50; i++) {
      const next = this.draftAlias.get(`${inbox_id}:${id}`);
      if (!next || next === id) break;
      id = next;
    }
    return id;
  }

  private draftArgs(input: DraftInput, creating: boolean): Record<string, unknown> {
    return {
      to: emails(input.to),
      cc: emails(input.cc),
      bcc: emails(input.bcc),
      subject: input.subject,
      body: input.body_text,
      // A reply draft threads under its message (the server derives the
      // recipients and subject then). Only `draft_create` takes it.
      ...(creating && input.reply_to ? { message_id: parseKey(input.reply_to).id } : {}),
    };
  }

  async listDrafts(inbox_id: string, signal?: AbortSignal): Promise<DraftSummary[]> {
    return arr<DraftSummary>(await this.client.read("draft_list", inbox_id, { limit: 50 }, signal), "drafts").map((d) => ({
      ...d,
      to: d.to ?? [],
      cc: d.cc ?? [],
    }));
  }

  async readDraft(inbox_id: string, draft_id: string, signal?: AbortSignal): Promise<DraftDetail> {
    const id = this.latestDraftId(inbox_id, draft_id);
    type Wire = Partial<DraftDetail> & Partial<ReadEmailResult> & { body?: string; reply_to_message_id?: string | null };
    const r = await this.client.read<Wire>("draft_read", inbox_id, { draft_id: id }, signal);
    const answered = r.reply_to_message_id ?? null;
    return {
      draft_id: r.draft_id ?? id,
      inbox_id,
      subject: r.subject ?? "",
      to: r.to ?? [],
      cc: r.cc ?? [],
      bcc: r.bcc ?? [],
      created_at: r.created_at ?? r.date ?? new Date(this.now()).toISOString(),
      body_text: r.body_text ?? r.body ?? "",
      body_html: r.body_html ?? null,
      reply_to: answered ? makeKey(inbox_id, answered) : null,
    };
  }

  async createDraft(input: DraftInput): Promise<DraftRef> {
    return this.mutating([input.inbox_id], [], ["drafts"], async () => {
      const r = await this.client.mutate<{ draft_id: string }>("draft_create", input.inbox_id, this.draftArgs(input, true));
      if (!r?.draft_id) throw new ApiError("invalid_response", "The draft was saved without an id.");
      return { value: { inbox_id: input.inbox_id, draft_id: r.draft_id } };
    });
  }

  /** Saves of one draft are serialised: each must use the id the previous
   *  one returned (IMAP replaces the draft, so a stale id fails). */
  updateDraft(inbox_id: string, draft_id: string, input: DraftInput): Promise<DraftRef> {
    const lineage = `${inbox_id}:${this.latestDraftId(inbox_id, draft_id)}`;
    const prev = this.draftChain.get(lineage) ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() =>
        this.mutating([inbox_id], [], ["drafts"], async () => {
          const current = this.latestDraftId(inbox_id, draft_id);
          const r = await this.client.mutate<{ draft_id?: string }>("draft_update", inbox_id, { draft_id: current, ...this.draftArgs(input, false) });
          const next = r?.draft_id || current;
          if (next !== current) {
            this.draftAlias.set(`${inbox_id}:${current}`, next);
            this.draftChain.set(`${inbox_id}:${next}`, run);
          }
          return { value: { inbox_id, draft_id: next } };
        }),
      );
    this.draftChain.set(lineage, run);
    const done = () => {
      for (const [k, v] of this.draftChain) if (v === run) this.draftChain.delete(k);
    };
    run.then(done, done);
    return run;
  }

  async deleteDraft(inbox_id: string, draft_id: string): Promise<void> {
    await (this.draftChain.get(`${inbox_id}:${this.latestDraftId(inbox_id, draft_id)}`) ?? Promise.resolve()).catch(() => {});
    await this.mutating([inbox_id], [], ["drafts"], async () => {
      await this.client.mutate("draft_delete", inbox_id, { draft_id: this.latestDraftId(inbox_id, draft_id) });
      return { value: undefined };
    });
  }

  async sendDraft(inbox_id: string, draft_id: string): Promise<SendResult> {
    return this.sending(inbox_id, "draft_send", { draft_id: this.latestDraftId(inbox_id, draft_id), idempotency_key: this.newId() });
  }

  /* ================= scheduled sends ================= */

  async listScheduled(inbox_id?: string, signal?: AbortSignal): Promise<ScheduledSend[]> {
    // One call: without an inbox the schedule list spans the workspace, each
    // row carrying its own `inbox_id`. Result: `{ scheduled_sends, total }`.
    const rows = arr<ScheduledSend>(await this.client.read("schedule_list", inbox_id ?? null, { limit: 100 }, signal), "scheduled_sends");
    const all = rows
      .map((s) => ({ ...s, inbox_id: s.inbox_id ?? inbox_id ?? "", to: s.to ?? [] }))
      .filter((s) => s.inbox_id && (!inbox_id || s.inbox_id === inbox_id));
    for (const k of [...this.scheduledSeen.keys()]) if (!inbox_id || parseKey(k).inbox_id === inbox_id) this.scheduledSeen.delete(k);
    for (const s of all) this.scheduledSeen.set(makeKey(s.inbox_id, s.id), s);
    return all;
  }

  async scheduleSend(input: ScheduleSendInput): Promise<ScheduledSend> {
    const attachments = this.checkAttachments(input.attachments);
    // Held by the server until its time: no folder changes now.
    return this.mutating([input.inbox_id], [], [], async () => {
      const to = emails(input.to);
      const r = await this.client.mutate<Partial<ScheduledSend> & { schedule_id?: string }>("schedule_create", input.inbox_id, {
        send_at: input.send_at,
        to,
        cc: emails(input.cc),
        bcc: emails(input.bcc),
        subject: input.subject,
        body: input.body_text,
        ...(input.body_html ? { html_body: input.body_html } : {}),
        ...(attachments ? { attachments } : {}),
        idempotency_key: input.idempotency_key ?? this.newId(),
      });
      const id = r?.id ?? r?.schedule_id;
      if (!id) throw new ApiError("invalid_response", "The send was scheduled without an id.");
      const value: ScheduledSend = {
        id,
        inbox_id: r.inbox_id ?? input.inbox_id,
        send_at: r.send_at ?? input.send_at,
        status: r.status ?? "pending",
        created_at: r.created_at ?? new Date(this.now()).toISOString(),
        to: r.to ?? to,
        subject: r.subject ?? input.subject,
      };
      return { value };
    });
  }

  async cancelScheduled(inbox_id: string, id: string): Promise<void> {
    await this.mutating([inbox_id], [], [], async () => {
      await this.client.mutate("schedule_cancel", inbox_id, { id });
      this.scheduledSeen.delete(makeKey(inbox_id, id));
      return { value: undefined };
    });
  }

  /* ================= misc ================= */

  async searchContacts(query: string, signal?: AbortSignal): Promise<ContactHit[]> {
    // No inbox_id: contacts are searched across every inbox of the workspace.
    return arr<ContactHit>(await this.client.read("contacts", null, { query, limit: 8 }, signal), "contacts");
  }

  async getAssistantAllowance(signal?: AbortSignal): Promise<AssistantAllowance> {
    // `/session` is on its way and carries the allowance: no second request.
    if (this.sessionPromise) await this.getSession(signal).catch(() => null);
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (this.session && this.sessionIsFresh() && !this.allowanceTaken) {
      this.allowanceTaken = true;
      return this.session.allowance;
    }
    return this.client.get<AssistantAllowance>("/allowance", signal);
  }
}
