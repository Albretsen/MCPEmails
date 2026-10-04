// ---------------------------------------------------------------------------
// The `thread` op: the messages of one conversation, across folders.
//
//   POST /mail { op: "thread", inbox_id, args: { message_id, thread_key?, limit? } }
//
//   message_id   any message of the conversation (the one the person opened).
//   thread_key   the key that row carried. Saves Gmail, Outlook and Gmail over
//                IMAP the lookup of the provider thread id.
//   limit        1..100, default 50. The NEWEST `limit` messages are returned.
//
//   -> {
//        thread_key,            the anchor's key (thread-key.ts)
//        messages: Row[],       date ASCENDING. A row is a `list` row: id, from,
//                               to, subject, date, preview, is_read, is_flagged,
//                               has_attachments, folder, thread_id,
//                               message_id_header, in_reply_to, references,
//                               thread_key. NO bodies: read them with `read` /
//                               `read_batch`.
//        partial: boolean,      true when something bounded the answer; then
//        partial_reason,        "limit" | "time_budget" | "folder_error" |
//                               "candidates" | "rate_limited"
//        strategy,              how it was found (below)
//        folders: string[],     the folder ids that were searched ("*": all mail)
//      }
//
// Nothing is stored in the database. An IMAP answer is remembered in the
// isolate for THREAD_MEMO_MS (ThreadMemory, below).
//
// Per provider:
//
//   Gmail    `threads.get?format=metadata` (one request, plus one
//            `messages.get?format=minimal` when no `g:` key was given). Every
//            label: Gmail threads span the mailbox. Messages in Trash, Spam and
//            Drafts are left out. strategy "gmail_thread".
//   Outlook  `/me/messages?$filter=conversationId eq '...'` (one request, plus
//            one for the conversationId when no `o:` key was given, plus the
//            folder-name lookup the list already does). Every folder; drafts,
//            Deleted Items and Junk are left out. strategy "outlook_conversation".
//            Graph cannot combine this filter with $orderby; rows are sorted here.
//
//   IMAP     on the inbox's pooled connection (no dial when one is open),
//            handed back to the pool after every folder, so a `list` or `read`
//            the person is waiting for is queued behind one folder at most.
//
//   IMAP, Gmail (the server advertises X-GM-EXT-1). strategy "imap_gmail_thrid".
//            Gmail's own thread id decides membership: exact, and instant on a
//            mailbox of any size (a SUBJECT or HEADER search of a large Gmail
//            mailbox ran 25 s, live 2026-10-04).
//              anchor's folder   UID SEARCH X-GM-THRID <id>, then ONE UID FETCH
//                                of the hits (summary + X-GM-MSGID +
//                                X-GM-LABELS), the anchor among them. The id is
//                                the `g:` key the row carried. No key, or one
//                                the anchor is not part of: one
//                                UID FETCH <anchor> (X-GM-THRID X-GM-MSGID)
//                                first, and the search runs on what it says.
//              All Mail (\All)   UID SEARCH X-GM-THRID <id>, then at most ONE
//                                UID FETCH: none when All Mail has exactly as
//                                many hits as the anchor's folder had (a label
//                                folder is a subset of All Mail, so those are
//                                the same messages); for more than
//                                GMAIL_PROBE_OVER hits the ids are asked for
//                                first and only the new messages are fetched.
//            Measured live (2026-10-04, a large mailbox): a Gmail round trip is
//            110 to 300 ms and a SELECT 250 to 650 ms, which is why nothing
//            here is fetched twice, and why All Mail is searched on a SECOND
//            pooled connection of the inbox (pool scope "<inbox>:all-mail",
//            mail/run.ts) that stays selected on All Mail, at the same time as
//            the anchor's folder is searched on the first. Without it every
//            call paid two SELECTs (and left the next `read` a third). Gmail
//            allows 15 connections per account; this is the second.
//            WHICH ID A MESSAGE GETS. A Gmail message is one message with
//            labels, and IMAP shows it once per label folder with a different
//            UID in each. A message that is in the anchor's folder is returned
//            with its id THERE ("INBOX:<uid>" for a thread opened from the
//            Inbox: the id the list row has, and the one an archive or a move
//            out of the Inbox must be issued against). Every other message is
//            returned with its All Mail id ("[Gmail]/All Mail:<uid>"), which
//            reads, flags and deletes correctly; its `folder` is the role its
//            labels give it (the Sent folder for \Sent, "INBOX" for \Inbox,
//            else All Mail). Copies are matched by X-GM-MSGID, never by
//            Message-ID. Drafts are left out; Trash and Spam are not in All
//            Mail. That is why the anchor's folder is searched too: two
//            searches and two fetches, not one of each.
//            A Gmail mailbox with All Mail hidden from IMAP answers the
//            anchor's folder alone, `partial: "folder_error"`.
//
//   IMAP, every other server. strategy "imap_subject_search".
//            For each of at most MAX_FOLDERS folders (the anchor's own, then
//            Sent, Inbox, Archive; duplicates skipped): SELECT, ONE search
//                UID SEARCH SINCE <anchor date - 180 days> SUBJECT "<base subject>"
//            (base subject: reply/forward prefixes stripped; outside ASCII it
//            goes out as a UTF-8 literal under CHARSET UTF-8, and a server
//            that refuses the charset gets the ASCII folding `uidSearch`
//            allows, or that folder is reported partial), then ONE UID FETCH
//            of the newest MAX_CANDIDATES hits (envelope + References; with the
//            preview when there are at most INLINE_PREVIEW_CANDIDATES of them,
//            else the kept rows' previews cost one more FETCH).
//            The SUBJECT only narrows what is fetched. MEMBERSHIP is decided
//            here, by the Message-ID / In-Reply-To / References graph: a
//            candidate is kept only when it is reachable from the anchor, in
//            either direction (ancestors and descendants), through the
//            candidates of ALL folders. Two mails that both say "Re: Invoice"
//            and share no id are two conversations.
//
//            WHY NOT `SEARCH HEADER`. It was the first choice until
//            2026-10-04. Migadu answers `HEADER Message-ID <id>` correctly and
//            `HEADER References` / `HEADER In-Reply-To` with OK and no hits, so
//            a check that "the header search found the anchor" passed and every
//            later reply was missed, `partial: false`. SUBJECT and SINCE are
//            RFC 3501 base keys every server indexes; nothing is probed.
//
//            An anchor with no Message-ID, In-Reply-To or References is a
//            conversation of one (strategy "single", no search). An anchor with
//            an EMPTY subject has nothing to narrow by: the newest
//            MAX_CANDIDATES messages since anchor date - EMPTY_SUBJECT_WINDOW_DAYS
//            are the candidates (strategy "imap_window_scan"), and more than
//            that many makes the answer `partial: "candidates"`, as does a
//            subject so generic that a folder holds more than MAX_CANDIDATES
//            of it. A thread whose subject was changed mid-way, or that reaches
//            back before the window, is incomplete and the answer cannot tell.
//
//            THREAD=REFERENCES (RFC 5256) is not used: step 5 of that algorithm
//            merges threads by base subject, which is exactly the false
//            positive this op must not produce, and it only threads within one
//            mailbox.
//
//   IMAP, all servers:
//            RATE LIMITS. One search per folder per call. A search the server
//            throttles (`NO [LIMIT]`, "too many", ...: imap-pool.ts
//            `isSearchThrottle`; Migadu allows about 60 a minute) ends the call
//            with what was found, `partial: "rate_limited"`; the connection is
//            kept, and no search is sent for that inbox for
//            RATE_LIMIT_BACKOFF_MS (calls in that window answer the anchor,
//            `partial: "rate_limited"`, at the cost of one FETCH).
//            TIME. Every search is raced against what is left of
//            TIME_BUDGET_MS. A search that loses is abandoned (its connection
//            is dropped: it is still busy), the call answers what it has with
//            `partial: "time_budget"`, and that inbox is not searched again for
//            SLOW_SEARCH_BACKOFF_MS.
//            MEMO. A complete answer is remembered for THREAD_MEMO_MS under the
//            id of every message in it, so re-opening the conversation or
//            stepping to another of its messages costs nothing. Any write op on
//            the inbox (flag, move, delete, send...) forgets that inbox's
//            entries (mail/run.ts).
//            Bounds: MAX_FOLDERS folders, `limit` rows.
// ---------------------------------------------------------------------------

import type { ImapMessageSummary } from "../../mcp-server/imap-client.ts";
import { imapMailboxForServerFolder } from "../../mcp-server/imap-folder-target.ts";
import { messageIdsOf, referencesOfHeaderBlock } from "../../mcp-server/first-party.ts";
import { decodeEncodedWords } from "../../mcp-server/mime.ts";
import { graphFetch, graphFolderLabels } from "../../mcp-server/outlook-graph.ts";
import { normalizePreview } from "../../mcp-server/text-extract.ts";
import { ApiError } from "../errors.ts";
import { isSearchThrottle, searchThrottleWaitMs } from "../imap-pool.ts";
import type { ApiKeyRow, ImapSessionLike, ImapStatusClient, InboxRow, McpSeam } from "../seam.ts";
import { reconnectMessage } from "./health.ts";
import { outlookRoleFolderIds } from "./roles.ts";
import { baseSubject, threadKeyOf } from "./thread-key.ts";

export const DEFAULT_THREAD_LIMIT = 50;
export const MAX_THREAD_LIMIT = 100;
/** IMAP: folders searched per call, the anchor's own included. */
export const MAX_FOLDERS = 4;
/** IMAP subject search: candidates fetched per folder (newest first). */
export const MAX_CANDIDATES = 200;
/** IMAP subject search: up to this many candidates are fetched WITH their preview. */
export const INLINE_PREVIEW_CANDIDATES = 24;
/** IMAP subject search: how far before the anchor's date the search reaches. */
export const SEARCH_WINDOW_DAYS = 180;
/** IMAP, an anchor with no subject: the window its candidates come from. */
export const EMPTY_SUBJECT_WINDOW_DAYS = 30;
/** IMAP: characters of the base subject a search is given (SUBJECT is a substring match). */
export const MAX_SUBJECT_SEARCH_CHARS = 120;
/** Gmail over IMAP: an All Mail hit list longer than this is asked for its ids before anything is fetched. */
export const GMAIL_PROBE_OVER = 6;
/** IMAP: the whole call's budget; every search is raced against what is left of it. */
export const TIME_BUDGET_MS = 5_000;
/** IMAP: no search for an inbox this long after its server throttled one. */
export const RATE_LIMIT_BACKOFF_MS = 15_000;
/** IMAP: no search for an inbox this long after one outlived the budget. */
export const SLOW_SEARCH_BACKOFF_MS = 60_000;
/** IMAP: how long a complete answer is served from memory. */
export const THREAD_MEMO_MS = 45_000;

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface ThreadRow {
  id: string;
  from: { name: string; email: string };
  to: Array<{ name: string; email: string }>;
  subject: string;
  date: string;
  preview: string;
  is_read: boolean;
  is_flagged: boolean;
  has_attachments: boolean;
  folder: string;
  thread_id: string;
  message_id_header: string | null;
  in_reply_to: string | null;
  references: string[];
  thread_key: string;
}

export type ThreadStrategy =
  | "gmail_thread"
  | "outlook_conversation"
  | "imap_gmail_thrid"
  | "imap_subject_search"
  | "imap_window_scan"
  | "single";

export type ThreadPartialReason = "limit" | "time_budget" | "folder_error" | "candidates" | "rate_limited";

export interface ThreadResult {
  thread_key: string;
  messages: ThreadRow[];
  partial: boolean;
  partial_reason?: ThreadPartialReason;
  strategy: ThreadStrategy;
  folders: string[];
}

export interface ThreadArgs {
  message_id: string;
  thread_key?: string;
  limit?: number;
}

/**
 * What the `thread` op keeps between calls, per isolate: complete IMAP answers
 * for THREAD_MEMO_MS, and which inboxes must not be searched right now.
 * One per app (mail/run.ts `MailEnv.threads`); nothing here outlives the isolate.
 */
export class ThreadMemory {
  /** `inbox \0 limit \0 row id` -> the answer that row is part of. */
  readonly #answers = new Map<string, { result: ThreadResult; at: number }>();
  readonly #backoff = new Map<string, { until: number; reason: "rate_limited" | "time_budget" }>();
  hits = 0;
  private readonly max: number;
  /** The IMAP call budget; TIME_BUDGET_MS unless a test asks for less. */
  readonly timeBudgetMs: number;

  constructor(options: { max?: number; timeBudgetMs?: number } = {}) {
    this.max = options.max ?? 4000;
    this.timeBudgetMs = options.timeBudgetMs ?? TIME_BUDGET_MS;
  }

  recall(inboxId: string, anchorId: string, limit: number, now: number): ThreadResult | null {
    const key = `${inboxId}\u0000${limit}\u0000${anchorId}`;
    const hit = this.#answers.get(key);
    if (!hit) return null;
    if (now - hit.at >= THREAD_MEMO_MS || now < hit.at) {
      this.#answers.delete(key);
      return null;
    }
    this.hits++;
    return hit.result;
  }

  remember(inboxId: string, limit: number, result: ThreadResult, now: number): void {
    // Only an answer that would come out the same if asked again.
    if (result.partial && result.partial_reason !== "limit" && result.partial_reason !== "candidates") return;
    if (this.#answers.size + result.messages.length > this.max) this.#answers.clear();
    const entry = { result, at: now };
    for (const row of result.messages) this.#answers.set(`${inboxId}\u0000${limit}\u0000${row.id}`, entry);
  }

  /** A write op ran on this inbox: flags, folders and ids may all have changed. */
  forget(inboxId: string): void {
    const prefix = `${inboxId}\u0000`;
    for (const key of this.#answers.keys()) if (key.startsWith(prefix)) this.#answers.delete(key);
  }

  holdOff(inboxId: string, reason: "rate_limited" | "time_budget", now: number, askedMs: number | null = null): void {
    if (this.#backoff.size > 2000) this.#backoff.clear();
    // The wait the server named (plus a second), when it named one.
    const ms = reason === "rate_limited" ? (askedMs !== null ? askedMs + 1000 : RATE_LIMIT_BACKOFF_MS) : SLOW_SEARCH_BACKOFF_MS;
    this.#backoff.set(inboxId, { until: now + ms, reason });
  }

  /** Why this inbox must not be searched right now, or null. */
  heldOff(inboxId: string, now: number): "rate_limited" | "time_budget" | null {
    const hit = this.#backoff.get(inboxId);
    if (!hit) return null;
    if (now >= hit.until) {
      this.#backoff.delete(inboxId);
      return null;
    }
    return hit.reason;
  }
}

function notFound(): ApiError {
  return new ApiError(404, "not_found", "This message no longer exists.", { toolCode: "message_not_found" });
}

function byDateAscending(a: ThreadRow, b: ThreadRow): number {
  const at = Date.parse(a.date);
  const bt = Date.parse(b.date);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sort ascending and keep the newest `limit`. */
function finish(
  rows: ThreadRow[],
  limit: number,
  base: Omit<ThreadResult, "messages" | "partial"> & { partial_reason?: ThreadResult["partial_reason"] },
): ThreadResult {
  rows.sort(byDateAscending);
  const over = rows.length > limit;
  const reason = base.partial_reason ?? (over ? "limit" : undefined);
  const out: ThreadResult = {
    thread_key: base.thread_key,
    messages: over ? rows.slice(rows.length - limit) : rows,
    partial: reason !== undefined,
    strategy: base.strategy,
    folders: base.folders,
  };
  if (reason !== undefined) out.partial_reason = reason;
  return out;
}

// ── Gmail ───────────────────────────────────────────────────────────────────

interface GmailMeta {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<{ filename?: string }>;
  };
}

/** "Name <a@b>" or "a@b". Mirrors the tool layer's `parseEmailAddress`. */
export function parseAddress(header: string): { name: string; email: string } {
  const trimmed = header.trim();
  const angle = /^(.*?)\s*<([^>]+)>\s*$/.exec(trimmed);
  if (angle) return { name: angle[1].replace(/^["']|["']$/g, "").trim(), email: angle[2].trim() };
  return { name: "", email: trimmed };
}

/** A comma-separated address list; a comma inside `<...>` or quotes does not split. */
export function parseAddresses(header: string): Array<{ name: string; email: string }> {
  const out: Array<{ name: string; email: string }> = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0 && !quoted) {
      if (current.trim()) out.push(parseAddress(current));
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(parseAddress(current));
  return out;
}

/** The folder a Gmail message is "in". Mirrors the tool layer's `gmailFolderOfLabels`. */
function gmailFolder(labelIds: readonly string[]): string {
  for (const system of ["TRASH", "SPAM", "DRAFT", "INBOX", "SENT"]) if (labelIds.includes(system)) return system;
  return labelIds.find((id) => id.startsWith("Label_")) ?? "archive";
}

async function gmailJson<T>(token: string, path: string): Promise<T> {
  const resp = await fetch(`${GMAIL_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 401) {
    await resp.body?.cancel().catch(() => {});
    throw new Error("gmail_auth_failed");
  }
  if (resp.status === 404) {
    await resp.body?.cancel().catch(() => {});
    throw notFound();
  }
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new Error(`gmail_thread_failed:${resp.status}`);
  }
  return await resp.json() as T;
}

async function gmailThread(mcp: McpSeam, inbox: InboxRow, args: ThreadArgs, limit: number): Promise<ThreadResult> {
  const token = await mcp.withFreshGmailToken(inbox);
  let threadId = args.thread_key?.startsWith("g:") ? args.thread_key.slice(2) : "";
  if (!threadId) {
    const anchor = await gmailJson<GmailMeta>(token, `/messages/${encodeURIComponent(args.message_id)}?format=minimal`);
    threadId = anchor.threadId ?? "";
    if (!threadId) throw notFound();
  }
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "To", "Subject", "Date", "Message-ID", "In-Reply-To", "References"]) {
    params.append("metadataHeaders", h);
  }
  const thread = await gmailJson<{ messages?: GmailMeta[] }>(token, `/threads/${encodeURIComponent(threadId)}?${params}`);
  const rows: ThreadRow[] = [];
  for (const msg of thread.messages ?? []) {
    const labels = msg.labelIds ?? [];
    if (!msg.id || labels.includes("TRASH") || labels.includes("SPAM") || labels.includes("DRAFT")) continue;
    const hdrs: Record<string, string> = {};
    for (const h of msg.payload?.headers ?? []) hdrs[h.name.toLowerCase()] = h.value;
    const references = messageIdsOf(hdrs["references"]);
    const row = {
      id: msg.id,
      from: parseAddress(hdrs["from"] ?? ""),
      to: parseAddresses(hdrs["to"] ?? ""),
      subject: hdrs["subject"] ?? "(no subject)",
      date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
      preview: normalizePreview(msg.snippet ?? ""),
      is_read: !labels.includes("UNREAD"),
      is_flagged: labels.includes("STARRED"),
      has_attachments: msg.payload?.mimeType === "multipart/mixed" ||
        (msg.payload?.parts ?? []).some((p) => typeof p.filename === "string" && p.filename.length > 0),
      folder: gmailFolder(labels),
      thread_id: msg.threadId ?? threadId,
      message_id_header: messageIdsOf(hdrs["message-id"])[0] ?? null,
      in_reply_to: messageIdsOf(hdrs["in-reply-to"])[0] ?? null,
      references: references.length <= 10 ? references : [references[0], ...references.slice(-9)],
    };
    rows.push({ ...row, thread_key: `g:${threadId}` });
  }
  return finish(rows, limit, { thread_key: `g:${threadId}`, strategy: "gmail_thread", folders: ["*"] });
}

// ── Outlook ─────────────────────────────────────────────────────────────────

interface GraphMessage {
  id: string;
  conversationId?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  parentFolderId?: string;
  internetMessageId?: string;
  flag?: { flagStatus?: string };
}

async function graphJson<T>(token: string, path: string): Promise<T> {
  const resp = await graphFetch(token, path);
  if (resp.status === 401) {
    await resp.body?.cancel().catch(() => {});
    throw new Error("outlook_auth_failed");
  }
  if (resp.status === 404) {
    await resp.body?.cancel().catch(() => {});
    throw notFound();
  }
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new Error(`outlook_thread_failed:${resp.status}`);
  }
  return await resp.json() as T;
}

async function outlookThread(
  mcp: McpSeam,
  inbox: InboxRow,
  args: ThreadArgs,
  limit: number,
  now: number,
): Promise<ThreadResult> {
  const token = await mcp.withFreshOutlookToken(inbox);
  let conversationId = args.thread_key?.startsWith("o:") ? args.thread_key.slice(2) : "";
  if (!conversationId) {
    const anchor = await graphJson<GraphMessage>(
      token,
      `/me/messages/${encodeURIComponent(args.message_id)}?$select=id,conversationId`,
    );
    conversationId = anchor.conversationId ?? "";
    if (!conversationId) throw notFound();
  }
  const params = new URLSearchParams({
    $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
    $select:
      "id,conversationId,from,toRecipients,subject,receivedDateTime,bodyPreview,isRead,isDraft,hasAttachments,parentFolderId,internetMessageId,flag",
    // One more than the cap: whether it comes back says the thread is longer.
    $top: String(Math.min(limit + 1, MAX_THREAD_LIMIT + 1)),
  });
  const page = await graphJson<{ value?: GraphMessage[] }>(token, `/me/messages?${params}`);
  const all = (page.value ?? []).filter((msg) => msg.isDraft !== true);

  // Folder ids -> the labels list rows carry, and the ids of Trash and Junk.
  const folderIds = [...new Set(all.map((msg) => msg.parentFolderId).filter((id): id is string => !!id))];
  const [labels, hidden] = await Promise.all([
    folderIds.length > 0
      ? graphFolderLabels(token, folderIds).catch((error) => {
        if (error instanceof Error && error.name === "OutlookNoMailboxError") throw error;
        return new Map<string, string>();
      })
      : Promise.resolve(new Map<string, string>()),
    outlookRoleFolderIds(mcp, inbox, now, ["trash", "spam", "drafts"]).catch(() => new Set<string>()),
  ]);

  const rows: ThreadRow[] = [];
  for (const msg of all) {
    if (msg.parentFolderId && hidden.has(msg.parentFolderId)) continue;
    rows.push({
      id: msg.id,
      from: { name: msg.from?.emailAddress?.name ?? "", email: msg.from?.emailAddress?.address ?? "" },
      to: (msg.toRecipients ?? []).map((r) => ({
        name: r.emailAddress?.name ?? "",
        email: r.emailAddress?.address ?? "",
      })),
      subject: msg.subject ?? "(no subject)",
      date: msg.receivedDateTime ?? new Date().toISOString(),
      preview: normalizePreview(msg.bodyPreview ?? ""),
      is_read: msg.isRead ?? true,
      is_flagged: msg.flag?.flagStatus === "flagged",
      has_attachments: msg.hasAttachments ?? false,
      folder: (msg.parentFolderId && labels.get(msg.parentFolderId)) || msg.parentFolderId || "",
      thread_id: msg.conversationId ?? conversationId,
      message_id_header: messageIdsOf(msg.internetMessageId)[0] ?? null,
      in_reply_to: null,
      references: [],
      thread_key: `o:${conversationId}`,
    });
  }
  return finish(rows, limit, { thread_key: `o:${conversationId}`, strategy: "outlook_conversation", folders: ["*"] });
}

// ── IMAP ────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 3501 `date`: 1-Jan-2026. */
export function imapDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** A quoted IMAP string, or null for a value that cannot go on a command line. */
function quoted(value: string): string | null {
  // deno-lint-ignore no-control-regex
  if (value.length === 0 || value.length > 900 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The one search a folder is given: `SINCE <date> SUBJECT "<base subject>"`,
 * or, for an anchor with no usable subject, the date window alone. Pure.
 */
export function threadSearchCriteria(subject: string, anchorMs: number): { criteria: string; bySubject: boolean } {
  // Whole code points: a surrogate pair is never cut in half.
  const base = [...baseSubject(subject)].slice(0, MAX_SUBJECT_SEARCH_CHARS).join("").trim();
  const q = base ? quoted(base) : null;
  if (q !== null) {
    return { criteria: `SINCE ${imapDate(anchorMs - SEARCH_WINDOW_DAYS * 86_400_000)} SUBJECT ${q}`, bySubject: true };
  }
  return { criteria: `SINCE ${imapDate(anchorMs - EMPTY_SUBJECT_WINDOW_DAYS * 86_400_000)}`, bySubject: false };
}

interface Linked {
  own: string;
  inReplyTo: string;
  references: string[];
}

function linksOf(summary: ImapMessageSummary): Linked {
  return {
    own: messageIdsOf(summary.envelope.messageId)[0] ?? "",
    inReplyTo: messageIdsOf(summary.envelope.inReplyTo)[0] ?? "",
    references: referencesOfHeaderBlock(summary.referencesHeader),
  };
}

/**
 * Of `candidates`, the ones the headers link to `known`, transitively. Every
 * kept message's ids are added to `known`, so this walks the reply graph in
 * both directions from whatever `known` starts as: a candidate that names a
 * known id is a descendant (or a sibling under a known ancestor), and a
 * candidate whose own id is known is an ancestor. Pure apart from `known`.
 */
export function keepLinked<T>(candidates: T[], links: (candidate: T) => Linked, known: Set<string>): T[] {
  const kept: T[] = [];
  let rest = candidates;
  for (;;) {
    const next: T[] = [];
    let grew = false;
    for (const candidate of rest) {
      const l = links(candidate);
      const hit = (l.own && known.has(l.own)) || (l.inReplyTo && known.has(l.inReplyTo)) ||
        l.references.some((id) => known.has(id));
      if (!hit) {
        next.push(candidate);
        continue;
      }
      kept.push(candidate);
      grew = true;
      if (l.own) known.add(l.own);
      if (l.inReplyTo) known.add(l.inReplyTo);
      for (const id of l.references) known.add(id);
    }
    if (!grew || next.length === 0) return kept;
    rest = next;
  }
}

/** `idFolder` is where the UID lives; `as` overrides what the row says about itself. */
function imapRow(idFolder: string, s: ImapMessageSummary, as: { folder?: string; threadKey?: string } = {}): ThreadRow {
  const l = linksOf(s);
  const from = s.envelope.from[0] ?? { name: "", email: "" };
  const row = {
    id: `${idFolder}:${s.uid}`,
    from: { name: decodeEncodedWords(from.name), email: from.email },
    to: s.envelope.to.map((a) => ({ name: decodeEncodedWords(a.name), email: a.email })),
    subject: decodeEncodedWords(s.envelope.subject),
    date: s.envelope.date,
    preview: normalizePreview(s.preview),
    is_read: s.flags.includes("\\Seen"),
    is_flagged: s.flags.includes("\\Flagged"),
    has_attachments: s.hasAttachments,
    folder: as.folder ?? idFolder,
    thread_id: String(s.uid),
    message_id_header: l.own || null,
    in_reply_to: l.inReplyTo || null,
    references: l.references.length <= 10 ? l.references : [l.references[0], ...l.references.slice(-9)],
  };
  return { ...row, thread_key: as.threadKey ?? threadKeyOf(row, "imap") };
}

function decodeImapId(id: string): { folder: string; uid: number } {
  const at = id.lastIndexOf(":");
  if (at === -1) return { folder: "INBOX", uid: Number(id) };
  return { folder: id.slice(0, at), uid: Number(id.slice(at + 1)) };
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof Error &&
    (/^(gmail|outlook|imap|fastmail)_auth_failed$/.test(error.message) || error.name === "ImapAuthError");
}

/** Errors that end the whole call rather than one folder. */
function isFatal(error: unknown): boolean {
  return isAuthFailure(error) || error instanceof ApiError ||
    (error instanceof Error && error.name === "ImapPoolBusyError");
}

/**
 * Runs `work` so that the IMAP connection it opens is the inbox's SECOND
 * pooled connection (mail/run.ts gives it its own pool scope). Only the Gmail
 * path uses it, for All Mail. The default runs `work` as it is: same
 * connection, one step after the other.
 */
export type Aside = <T>(work: () => Promise<T>) => Promise<T>;

class TimeBudgetError extends Error {
  constructor() {
    super("thread_time_budget");
    this.name = "TimeBudgetError";
  }
}

/** `work`, or a TimeBudgetError after `ms`. The work is abandoned, not cancelled. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeBudgetError()), Math.max(1, ms));
  });
  // The loser of the race still settles; its rejection is nobody's to handle.
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A server's refusal text for a log line: no quoted operand, bounded. */
function refusalForLog(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  return text.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\{\d+\}.*/s, "{}").slice(0, 120);
}

const sameFolder = (a: string, b: string): boolean =>
  a === b || (a.toUpperCase() === "INBOX" && b.toUpperCase() === "INBOX");

/** Gmail labels of a summary, lower-cased (`\\inbox`, `\\sent`, `\\draft`, user labels). */
function gmailLabelSet(s: ImapMessageSummary): Set<string> {
  return new Set((s.gmLabels ?? []).map((label) => label.toLowerCase()));
}

function isGmailDraft(s: ImapMessageSummary): boolean {
  const labels = gmailLabelSet(s);
  return labels.has("\\draft") || labels.has("\\drafts") || s.flags.includes("\\Draft");
}

interface Candidate {
  folder: string;
  summary: ImapMessageSummary;
  hasPreview: boolean;
}

async function imapThread(
  mcp: McpSeam,
  inbox: InboxRow,
  args: ThreadArgs,
  limit: number,
  clock: () => number,
  memory: ThreadMemory,
  aside: Aside,
): Promise<ThreadResult> {
  const anchor = decodeImapId(args.message_id);
  if (!Number.isInteger(anchor.uid) || anchor.uid <= 0) throw notFound();
  const remembered = memory.recall(inbox.id, args.message_id, limit, clock());
  if (remembered) return remembered;

  const started = clock();
  const remaining = () => memory.timeBudgetMs - (clock() - started);
  /** One step on the pooled connection, which goes back to the pool after it. */
  const step = async <T>(work: (session: ImapSessionLike) => Promise<T>): Promise<T> => {
    const session = mcp.imapSessionFor(inbox);
    if (!session) throw new ApiError(502, "provider_error", "This inbox has no IMAP session.");
    try {
      return await work(session);
    } finally {
      await session.close().catch(() => {});
    }
  };

  /** Why no further search may be sent on this call, once one was throttled or outran the budget. */
  let stopped: "rate_limited" | "time_budget" | null = memory.heldOff(inbox.id, clock());
  let reason: ThreadPartialReason | undefined = stopped ?? undefined;

  /**
   * One UID SEARCH, raced against the budget. Null when it was throttled or
   * outlived the budget: `stopped` then says which, and (for the budget) the
   * connection is still busy with it, so NOTHING more may be sent on it.
   */
  const search = async (client: ImapStatusClient, criteria: string): Promise<number[] | null> => {
    if (stopped) return null;
    const left = remaining();
    try {
      if (left <= 0) throw new TimeBudgetError();
      return await within(client.uidSearch(criteria), left);
    } catch (error) {
      if (error instanceof TimeBudgetError) stopped = "time_budget";
      else if (isSearchThrottle(error)) {
        stopped = "rate_limited";
        console.warn("[client-api] thread_search_throttled", { inbox_id: inbox.id, refusal: refusalForLog(error) });
      } else throw error;
      memory.holdOff(inbox.id, stopped, clock(), searchThrottleWaitMs(error));
      reason = stopped;
      return null;
    }
  };

  const rows = new Map<string, ThreadRow>();
  const searched: string[] = [];
  const candidates: Candidate[] = [];
  let folders: string[] = [anchor.folder];
  let criteria: { criteria: string; bySubject: boolean } | null = null;

  /** SELECT, the one search, the one FETCH of its candidates. False when no search could be sent. */
  const searchFolder = async (session: ImapSessionLike, folder: string): Promise<boolean> => {
    const selected = await session.select(imapMailboxForServerFolder(folder));
    const hits = await search(selected, criteria!.criteria);
    if (hits === null) return false;
    let uids = hits.sort((a, b) => b - a);
    if (uids.length > MAX_CANDIDATES) {
      uids = uids.slice(0, MAX_CANDIDATES);
      reason ??= "candidates";
    }
    const wanted = uids.filter((uid) => !(sameFolder(folder, anchor.folder) && uid === anchor.uid));
    const hasPreview = wanted.length <= INLINE_PREVIEW_CANDIDATES;
    if (wanted.length > 0) {
      for (const summary of await selected.fetchSummaries(wanted, { includePreview: hasPreview })) {
        candidates.push({ folder, summary, hasPreview });
      }
    }
    searched.push(folder);
    return true;
  };

  // ── Gmail over IMAP: state filled in by step 1 ──
  interface GmailState {
    threadId: string;
    key: string;
    allMail: string | null;
    sent: string | null;
    /** X-GM-MSGIDs already answered (or skipped as drafts). */
    seen: Set<string>;
    /** Hits of the thread search in the anchor's folder, or -1 when it did not run. */
    anchorFolderHits: number;
    /** Every message of the anchor's folder is also in All Mail (false for Trash and Spam). */
    anchorFolderInAllMail: boolean;
  }
  let gmail: GmailState | null = null;
  /** Step 1 found a Gmail server but could not get as far as the anchor's row. */
  let gmailAnchorMissing = false;
  const gmailRow = (idFolder: string, s: ImapMessageSummary, fromAllMail: boolean): ThreadRow => {
    const labels = gmailLabelSet(s);
    const folder = !fromAllMail
      ? idFolder
      : labels.has("\\inbox")
      ? "INBOX"
      : labels.has("\\sent")
      ? gmail!.sent ?? idFolder
      : idFolder;
    return imapRow(idFolder, s, { folder, threadKey: gmail!.key });
  };
  /** Rows for these summaries of one folder; the anchor is always kept. */
  const gmailTake = (folder: string, summaries: ImapMessageSummary[], fromAllMail: boolean): void => {
    for (const s of summaries) {
      const isAnchor = !fromAllMail && s.uid === anchor.uid;
      // Only what Gmail says is this thread, whatever the search returned.
      if (s.gmThreadId !== gmail!.threadId) continue;
      // The same message under another label: the first id stands.
      if (s.gmMessageId) {
        if (gmail!.seen.has(s.gmMessageId)) continue;
        gmail!.seen.add(s.gmMessageId);
      }
      if (isGmailDraft(s) && !isAnchor) continue;
      const row = gmailRow(folder, s, fromAllMail);
      rows.set(row.id, row);
      if (isAnchor) {
        anchorRow = row;
        links = linksOf(s);
      }
    }
  };
  const capped = (hits: number[]): number[] => {
    const uids = hits.sort((a, b) => b - a);
    if (uids.length <= MAX_THREAD_LIMIT) return uids;
    reason ??= "limit";
    return uids.slice(0, MAX_THREAD_LIMIT);
  };
  /** All Mail: one search; a fetch only for what the anchor's folder did not already answer. */
  const gmailAllMail = async (session: ImapSessionLike, folder: string): Promise<void> => {
    const selected = await session.select(imapMailboxForServerFolder(folder));
    const hits = await search(selected, `X-GM-THRID ${gmail!.threadId}`);
    if (hits === null) return;
    await gmailAllMailHits(selected, folder, hits);
  };
  const gmailAllMailHits = async (selected: ImapStatusClient, folder: string, hits: number[]): Promise<void> => {
    searched.push(folder);
    // The anchor's folder is a label: its messages are a subset of All Mail's.
    // The same number of hits is therefore the same messages, and nothing is fetched.
    if (gmail!.anchorFolderInAllMail && hits.length === gmail!.anchorFolderHits) return;
    let wanted = capped(hits);
    if (wanted.length > GMAIL_PROBE_OVER) {
      // A long thread: ask which of them are new before fetching envelopes and previews.
      const known = gmail!.seen;
      wanted = (await selected.fetchGmailIds(wanted)).filter((m) => !m.messageId || !known.has(m.messageId)).map((m) => m.uid);
    }
    if (wanted.length > 0) gmailTake(folder, await selected.fetchSummaries(wanted, { gmailLabels: true }), true);
  };

  // 1. The anchor, and its own folder's search, in one lease.
  let anchorRow: ThreadRow | null = null;
  let links: Linked = { own: "", inReplyTo: "", references: [] };
  const first = step(async (session) => {
    let client: ImapStatusClient;
    try {
      client = await session.select(imapMailboxForServerFolder(anchor.folder));
    } catch (error) {
      if (isFatal(error)) throw error;
      throw notFound();
    }

    if (client.hasCapability("X-GM-EXT-1") && !stopped) {
      // The key the row carried names the thread: search first, and the anchor
      // comes back in the ONE fetch with the rest. No key, or one the anchor is
      // not part of: the anchor says which thread it is in.
      let threadId = /^g:([1-9]\d{0,23})$/.exec(args.thread_key ?? "")?.[1] ?? "";
      let hits: number[] | null = threadId ? await search(client, `X-GM-THRID ${threadId}`) : [];
      if (hits !== null && !hits.includes(anchor.uid)) {
        const own = (await client.fetchGmailIds([anchor.uid]))[0];
        if (!own) throw notFound();
        threadId = /^[1-9]\d{0,23}$/.test(own.threadId) ? own.threadId : "";
        hits = threadId ? await search(client, `X-GM-THRID ${threadId}`) : [];
      }
      if (threadId) {
        gmail = { threadId, key: `g:${threadId}`, allMail: null, sent: null, seen: new Set(), anchorFolderHits: -1, anchorFolderInAllMail: true };
        if (hits === null) {
          // Throttled, or still running past the budget: nothing more on this lease.
          gmailAnchorMissing = true;
          return;
        }
        gmail.anchorFolderHits = hits.length;
        const uids = capped(hits);
        if (!uids.includes(anchor.uid)) uids.push(anchor.uid);
        gmailTake(anchor.folder, await client.fetchSummaries(uids, { gmailLabels: true }), false);
        if (anchorRow === null) throw notFound();
        searched.push(anchor.folder);
        try {
          for (const box of await client.listMailboxes()) {
            const flags = box.flags.map((flag) => flag.toLowerCase());
            if (flags.includes("\\all")) gmail.allMail = box.name;
            if (flags.includes("\\sent")) gmail.sent = box.name;
            if (sameFolder(box.name, anchor.folder) && (flags.includes("\\trash") || flags.includes("\\junk"))) {
              gmail.anchorFolderInAllMail = false;
            }
          }
        } catch (error) {
          if (isFatal(error)) throw error;
          reason ??= "folder_error";
        }
        return;
      }
      // X-GM-EXT-1 without a usable thread id: thread it like any other server.
    }

    // On Gmail (held off: no search may be sent) the same FETCH carries
    // X-GM-THRID; every other server is asked for exactly what a list row asks for.
    const anchorSummary = (await client.fetchSummaries([anchor.uid], { gmailLabels: true }))[0];
    if (!anchorSummary) throw notFound();
    links = linksOf(anchorSummary);
    const heldGmailId = client.hasCapability("X-GM-EXT-1") ? anchorSummary.gmThreadId ?? "" : "";
    if (/^[1-9]\d{0,23}$/.test(heldGmailId)) {
      gmail = { threadId: heldGmailId, key: `g:${heldGmailId}`, allMail: null, sent: null, seen: new Set(), anchorFolderHits: -1, anchorFolderInAllMail: true };
      gmailTake(anchor.folder, [anchorSummary], false);
      return;
    }

    anchorRow = imapRow(anchor.folder, anchorSummary);
    rows.set(anchorRow.id, anchorRow);
    // No Message-ID, no In-Reply-To, no References: nothing can link to it.
    if (!links.own && !links.inReplyTo && links.references.length === 0) return;
    if (stopped) return;
    const anchorMs = Date.parse(anchorRow.date);
    criteria = threadSearchCriteria(anchorRow.subject, Number.isFinite(anchorMs) ? anchorMs : clock());
    try {
      // The other folders: Sent first (a reply of one's own is the message most
      // often missing from the list the person is looking at). An alias this
      // mailbox does not have (no Archive) is simply not searched.
      for (const alias of ["sent", "inbox", "archive"]) {
        if (folders.length >= MAX_FOLDERS) break;
        try {
          const id = await mcp.resolveFolderId(inbox, alias, { strict: true, forRead: true, session });
          if (!folders.some((f) => sameFolder(f, id))) folders = [...folders, id];
        } catch (error) {
          if (isFatal(error)) throw error;
        }
      }
      await searchFolder(session, anchor.folder);
    } catch (error) {
      if (isFatal(error)) throw error;
      reason ??= "folder_error";
    }
  });

  // Gmail over IMAP, AT THE SAME TIME, on the inbox's second pooled connection
  // (`aside`), which stays parked on All Mail between calls: measured live, the
  // SELECT back and forth between the Inbox and All Mail on one connection was
  // 600 to 1100 ms of a 1.2 to 1.9 s call. Started only when the row's key
  // names a Gmail thread; the fetch waits for the anchor's folder, because
  // that decides what is still missing.
  const keyThreadId = /^g:([1-9]\d{0,23})$/.exec(args.thread_key ?? "")?.[1] ?? "";
  let allMailDone = false;
  let asideFatal: unknown = null;
  const speculative = keyThreadId && !stopped
    ? aside(() =>
      step(async (session) => {
        const client = await session.client();
        if (!client.hasCapability("X-GM-EXT-1")) return;
        let allMail: string | null = null;
        for (const box of await client.listMailboxes()) {
          if (box.flags.some((flag) => flag.toLowerCase() === "\\all")) allMail = box.name;
        }
        if (allMail === null || sameFolder(allMail, anchor.folder)) return;
        const selected = await session.select(imapMailboxForServerFolder(allMail));
        let hits = await search(selected, `X-GM-THRID ${keyThreadId}`);
        await first.catch(() => {});
        const state = gmail as GmailState | null;
        if (!state || gmailAnchorMissing || anchorRow === null) return;
        // The key named another thread than the anchor's: ask again for the right one.
        if (state.threadId !== keyThreadId) hits = await search(selected, `X-GM-THRID ${state.threadId}`);
        if (hits === null) return;
        await gmailAllMailHits(selected, allMail, hits);
        allMailDone = true;
      })
    ).catch((error) => {
      if (isFatal(error)) asideFatal = error;
      // Anything else: the sequential pass below tries All Mail once more.
    })
    : null;
  try {
    await first;
  } finally {
    if (speculative) await speculative;
  }
  if (asideFatal && !(asideFatal instanceof ApiError)) throw asideFatal;

  // ── Gmail over IMAP: All Mail holds the rest ──
  const gm = gmail as GmailState | null;
  if (gm) {
    if (gmailAnchorMissing) {
      // The first search was throttled or outran the budget before the anchor
      // was read: the anchor alone, on a fresh lease (the other is still busy).
      await step(async (session) => {
        const client = await session.select(imapMailboxForServerFolder(anchor.folder));
        const summary = (await client.fetchSummaries([anchor.uid], { gmailLabels: true }))[0];
        if (!summary) throw notFound();
        if (summary.gmThreadId) {
          gm.threadId = summary.gmThreadId;
          gm.key = `g:${summary.gmThreadId}`;
        }
        gmailTake(anchor.folder, [summary], false);
      });
    }
    const gmailAnchor = anchorRow as ThreadRow | null;
    if (!gmailAnchor) throw notFound();
    if (!stopped && !allMailDone) {
      if (gm.allMail === null) reason ??= "folder_error";
      else if (!sameFolder(gm.allMail, anchor.folder)) {
        try {
          await aside(() => step((session) => gmailAllMail(session, gm.allMail!)));
        } catch (error) {
          if (isFatal(error)) throw error;
          reason ??= "folder_error";
        }
      }
    }
    const result = finish([...rows.values()], limit, {
      thread_key: gm.key,
      strategy: "imap_gmail_thrid",
      folders: searched,
      partial_reason: reason,
    });
    memory.remember(inbox.id, limit, result, clock());
    return result;
  }
  const anchored = anchorRow as ThreadRow | null;
  if (!anchored) throw notFound();

  if (criteria === null) {
    // A conversation of one, or an inbox that must not be searched right now.
    const result = finish([anchored], limit, {
      thread_key: anchored.thread_key,
      strategy: stopped ? "imap_subject_search" : "single",
      folders: stopped ? [] : [anchor.folder],
      partial_reason: reason,
    });
    memory.remember(inbox.id, limit, result, clock());
    return result;
  }
  const strategy: ThreadStrategy = (criteria as { bySubject: boolean }).bySubject ? "imap_subject_search" : "imap_window_scan";

  // 2. The other folders, one lease each.
  for (const folder of folders.slice(1)) {
    if (stopped) break;
    if (remaining() <= 0) {
      reason = "time_budget";
      break;
    }
    try {
      await step((session) => searchFolder(session, folder));
    } catch (error) {
      if (isFatal(error)) throw error;
      // This folder could not be searched (a SELECT or SEARCH the server
      // refused): the others still answer.
      reason ??= "folder_error";
    }
  }

  // 3. Membership: reachable from the anchor through the ids, across folders.
  const known = new Set<string>([links.own, links.inReplyTo, ...links.references].filter(Boolean));
  const kept = keepLinked(candidates, (c) => linksOf(c.summary), known);

  // 4. Previews for kept rows whose candidates were fetched without one.
  const bare = new Map<string, Candidate[]>();
  for (const c of kept) if (!c.hasPreview) bare.set(c.folder, [...(bare.get(c.folder) ?? []), c]);
  for (const [folder, list] of bare) {
    if (stopped === "time_budget" || remaining() <= 0) break;
    try {
      await step(async (session) => {
        const selected = await session.select(imapMailboxForServerFolder(folder));
        const full = new Map((await selected.fetchSummaries(list.map((c) => c.summary.uid))).map((s) => [s.uid, s]));
        for (const c of list) c.summary = full.get(c.summary.uid) ?? c.summary;
      });
    } catch (error) {
      if (isFatal(error)) throw error;
      // The rows stand, without a preview.
    }
  }

  const seenMessageIds = new Set<string>(links.own ? [links.own] : []);
  for (const c of kept) {
    const row = imapRow(c.folder, c.summary);
    if (rows.has(row.id)) continue;
    // The same message filed in a second folder: the first one stands.
    if (row.message_id_header) {
      if (seenMessageIds.has(row.message_id_header)) continue;
      seenMessageIds.add(row.message_id_header);
    }
    rows.set(row.id, row);
  }

  const result = finish([...rows.values()], limit, {
    thread_key: anchored.thread_key,
    strategy,
    folders: searched,
    partial_reason: reason,
  });
  memory.remember(inbox.id, limit, result, clock());
  return result;
}

/** Must be called inside `firstPartyContext.run` with `threadHeaders` set. */
export async function mailThread(
  mcp: McpSeam,
  apiKey: ApiKeyRow,
  inboxId: string,
  args: ThreadArgs,
  clock: () => number = () => Date.now(),
  memory: ThreadMemory = new ThreadMemory(),
  aside: Aside = (work) => work(),
): Promise<ThreadResult> {
  const inbox = await mcp.resolveInbox(inboxId, apiKey);
  if (!inbox) throw new ApiError(404, "inbox_not_found", "Inbox not found.", { toolCode: "inbox_not_found" });
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_THREAD_LIMIT, 1), MAX_THREAD_LIMIT);
  try {
    return inbox.provider === "gmail"
      ? await gmailThread(mcp, inbox, args, limit)
      : inbox.provider === "outlook"
      ? await outlookThread(mcp, inbox, args, limit, clock())
      : await imapThread(mcp, inbox, args, limit, clock, memory, aside);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isAuthFailure(error)) {
      throw new ApiError(409, "reconnect_required", reconnectMessage(inbox.provider), { toolCode: "auth_failed" });
    }
    if (error instanceof Error && error.name === "OutlookNoMailboxError") {
      throw new ApiError(409, "reconnect_required", "This Outlook account has no mailbox.", {
        toolCode: "outlook_no_mailbox",
      });
    }
    if (error instanceof Error && error.name === "ImapPoolBusyError") {
      throw new ApiError(503, "provider_error", "The mailbox is busy. Try again.", {
        retryable: true,
        toolCode: "imap_pool_busy",
      });
    }
    throw new ApiError(502, "provider_error", "The mail provider request failed. Try again.", { retryable: true });
  }
}
