// ---------------------------------------------------------------------------
// The `thread` op: the messages of one conversation, across folders.
//
//   POST /mail { op: "thread", inbox_id, args: { message_id, thread_key?, limit? } }
//
//   message_id   any message of the conversation (the one the person opened).
//   thread_key   the key that row carried. Saves Gmail and Outlook the lookup
//                of the provider thread id; ignored on IMAP.
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
//        partial_reason,        "limit" | "time_budget" | "folder_error" | "candidates"
//        strategy,              how it was found (below)
//        folders: string[],     the folder ids that were searched ("*": all mail)
//      }
//
// Nothing is stored. Every call asks the mail server again.
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
//   IMAP     on the inbox's pooled connection (no dial when one is open):
//              1. UID FETCH the anchor's summary (envelope + References).
//              2. For each of at most MAX_FOLDERS folders (the anchor's own,
//                 then Inbox, Sent, Archive; on Gmail-over-IMAP the archive
//                 alias is All Mail): SELECT, one UID SEARCH, one UID FETCH.
//            The search is an OR over HEADER Message-ID / References /
//            In-Reply-To for the thread's known ids (the anchor's own id, its
//            In-Reply-To, the root and the newest References: at most
//            MAX_SEARCH_IDS). strategy "imap_header_search".
//
//            KNOWN GOTCHA: some servers answer `SEARCH HEADER` with OK and no
//            hits, whatever is asked (Migadu is one). That is detected, not
//            guessed: the first search runs in the anchor's own folder and must
//            return the anchor itself (it matches `HEADER Message-ID <own>`).
//            When it does not, every folder is searched with
//                SUBJECT "<normalised subject>" SINCE <anchor date - 180 days>
//            instead, the newest MAX_FALLBACK_CANDIDATES hits are fetched
//            WITHOUT previews, and the function keeps only the ones the
//            headers link to the thread. Subject never decides membership: it
//            only narrows what is fetched. strategy "imap_subject_fallback".
//            A thread whose subject was changed mid-way, or older than the
//            window, is incomplete there, and the answer cannot tell.
//
//            Whatever the search returned, a row is kept only when its own
//            Message-ID, In-Reply-To or References meets the known ids
//            (transitively: a kept row's ids become known). HEADER matching is
//            a substring match on the server; this makes it exact.
//
//            A message present in several folders (Gmail-over-IMAP's All Mail,
//            a mail to oneself) is returned once, from the first folder in
//            the order above.
//
//            THREAD=REFERENCES (RFC 5256) is not used: step 5 of that algorithm
//            merges threads by base subject, which is exactly the false
//            positive this op must not produce, and it only threads within one
//            mailbox, so it saves no round trip over the search above.
//
//            Bounds: MAX_FOLDERS folders, `limit` rows, TIME_BUDGET_MS between
//            folders. Hitting any of them answers what was found so far with
//            `partial: true`.
// ---------------------------------------------------------------------------

import type { ImapMessageSummary } from "../../mcp-server/imap-client.ts";
import { imapMailboxForServerFolder } from "../../mcp-server/imap-folder-target.ts";
import { messageIdsOf, referencesOfHeaderBlock } from "../../mcp-server/first-party.ts";
import { decodeEncodedWords } from "../../mcp-server/mime.ts";
import { graphFetch, graphFolderLabels } from "../../mcp-server/outlook-graph.ts";
import { normalizePreview } from "../../mcp-server/text-extract.ts";
import { ApiError } from "../errors.ts";
import type { ApiKeyRow, InboxRow, McpSeam } from "../seam.ts";
import { reconnectMessage } from "./health.ts";
import { outlookRoleFolderIds } from "./roles.ts";
import { normalizeSubject, threadKeyOf } from "./thread-key.ts";

export const DEFAULT_THREAD_LIMIT = 50;
export const MAX_THREAD_LIMIT = 100;
/** IMAP: folders searched per call, the anchor's own included. */
export const MAX_FOLDERS = 4;
/** IMAP: ids the header search names. */
export const MAX_SEARCH_IDS = 6;
/** IMAP subject fallback: candidates fetched per folder (newest first). */
export const MAX_FALLBACK_CANDIDATES = 200;
/** IMAP subject fallback: how far before the anchor's date the search reaches. */
export const FALLBACK_WINDOW_DAYS = 180;
/** IMAP: no new folder is started after this long. */
export const TIME_BUDGET_MS = 8_000;

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
  | "imap_header_search"
  | "imap_subject_fallback"
  | "single";

export interface ThreadResult {
  thread_key: string;
  messages: ThreadRow[];
  partial: boolean;
  partial_reason?: "limit" | "time_budget" | "folder_error" | "candidates";
  strategy: ThreadStrategy;
  folders: string[];
}

export interface ThreadArgs {
  message_id: string;
  thread_key?: string;
  limit?: number;
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

function orChain(terms: string[]): string {
  return terms.reduce((acc, term) => `OR ${acc} ${term}`);
}

/**
 * The ids the header search names, most useful first: the anchor's own id, its
 * In-Reply-To, the root, then the newest References. Pure.
 */
export function searchIds(own: string, inReplyTo: string, references: string[]): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.includes(id) && out.length < MAX_SEARCH_IDS) out.push(id);
  };
  add(own);
  add(inReplyTo);
  add(references[0]);
  for (let i = references.length - 1; i > 0; i--) add(references[i]);
  return out;
}

/** The UID SEARCH criteria for those ids, or null when none can be searched for. Pure. */
export function headerSearchCriteria(own: string, inReplyTo: string, references: string[]): string | null {
  const terms: string[] = [];
  const root = references[0] || inReplyTo || own;
  for (const id of searchIds(own, inReplyTo, references)) {
    const q = quoted(`<${id}>`);
    if (q === null) continue;
    // The message itself, wherever it is filed.
    terms.push(`HEADER Message-ID ${q}`);
    // Its descendants: every reply to a message lists it in References, and
    // names it in In-Reply-To when it is the direct parent.
    if (id === own || id === root || id === inReplyTo) terms.push(`HEADER References ${q}`);
    if (id === own || id === root) terms.push(`HEADER In-Reply-To ${q}`);
  }
  return terms.length > 0 ? orChain(terms) : null;
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
 * kept message's ids are added to `known`. Pure apart from that.
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

function imapRow(folder: string, s: ImapMessageSummary): ThreadRow {
  const l = linksOf(s);
  const from = s.envelope.from[0] ?? { name: "", email: "" };
  const row = {
    id: `${folder}:${s.uid}`,
    from: { name: decodeEncodedWords(from.name), email: from.email },
    to: s.envelope.to.map((a) => ({ name: decodeEncodedWords(a.name), email: a.email })),
    subject: decodeEncodedWords(s.envelope.subject),
    date: s.envelope.date,
    preview: normalizePreview(s.preview),
    is_read: s.flags.includes("\\Seen"),
    is_flagged: s.flags.includes("\\Flagged"),
    has_attachments: s.hasAttachments,
    folder,
    thread_id: String(s.uid),
    message_id_header: l.own || null,
    in_reply_to: l.inReplyTo || null,
    references: l.references.length <= 10 ? l.references : [l.references[0], ...l.references.slice(-9)],
  };
  return { ...row, thread_key: threadKeyOf(row, "imap") };
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

async function imapThread(
  mcp: McpSeam,
  inbox: InboxRow,
  args: ThreadArgs,
  limit: number,
  clock: () => number,
): Promise<ThreadResult> {
  const anchor = decodeImapId(args.message_id);
  if (!Number.isInteger(anchor.uid) || anchor.uid <= 0) throw notFound();
  const session = mcp.imapSessionFor(inbox);
  if (!session) throw new ApiError(502, "provider_error", "This inbox has no IMAP session.");
  const started = clock();
  try {
    // 1. The anchor: its ids are what the thread is searched by.
    let client;
    try {
      client = await session.select(imapMailboxForServerFolder(anchor.folder));
    } catch (error) {
      if (isFatal(error)) throw error;
      throw notFound();
    }
    const [anchorSummary] = await client.fetchSummaries([anchor.uid]);
    if (!anchorSummary) throw notFound();
    const anchorRow = imapRow(anchor.folder, anchorSummary);
    const links = linksOf(anchorSummary);
    const criteria = headerSearchCriteria(links.own, links.inReplyTo, links.references);
    if (criteria === null) {
      // No Message-ID, no In-Reply-To, no References: nothing can link to it.
      return finish([anchorRow], limit, { thread_key: anchorRow.thread_key, strategy: "single", folders: [anchor.folder] });
    }

    // 2. The folders, the anchor's own first. An alias this mailbox does not
    //    have (no Archive) is simply not searched.
    const folders: string[] = [anchor.folder];
    for (const alias of ["inbox", "sent", "archive"]) {
      if (folders.length >= MAX_FOLDERS) break;
      try {
        const id = await mcp.resolveFolderId(inbox, alias, { strict: true, forRead: true, session });
        if (!folders.some((f) => f === id || (f.toUpperCase() === "INBOX" && id.toUpperCase() === "INBOX"))) folders.push(id);
      } catch (error) {
        if (isFatal(error)) throw error;
      }
    }

    const known = new Set<string>([links.own, links.inReplyTo, ...links.references].filter(Boolean));
    const baseSubject = normalizeSubject(anchorRow.subject);
    const anchorMs = Date.parse(anchorRow.date);
    const since = imapDate((Number.isFinite(anchorMs) ? anchorMs : clock()) - FALLBACK_WINDOW_DAYS * 86_400_000);
    const subjectQuoted = baseSubject ? quoted(baseSubject) : null;

    const rows = new Map<string, ThreadRow>([[anchorRow.id, anchorRow]]);
    const seenMessageIds = new Set<string>(links.own ? [links.own] : []);
    const searched: string[] = [];
    let fallback = false;
    let reason: ThreadResult["partial_reason"];

    for (const folder of folders) {
      if (clock() - started > TIME_BUDGET_MS) {
        reason = "time_budget";
        break;
      }
      try {
        const selected = await session.select(imapMailboxForServerFolder(folder));
        let uids: number[] = [];
        if (!fallback) {
          uids = await selected.uidSearch(criteria);
          // The anchor matches `HEADER Message-ID <own>` in its own folder. A
          // server that does not return it does not search headers at all.
          if (folder === anchor.folder && links.own && !uids.includes(anchor.uid)) fallback = true;
        }
        let summaries: ImapMessageSummary[];
        if (fallback) {
          if (subjectQuoted === null) {
            searched.push(folder);
            continue;
          }
          uids = await selected.uidSearch(`SUBJECT ${subjectQuoted} SINCE ${since}`);
          uids.sort((a, b) => b - a);
          if (uids.length > MAX_FALLBACK_CANDIDATES) {
            uids = uids.slice(0, MAX_FALLBACK_CANDIDATES);
            reason ??= "candidates";
          }
          const wanted = uids.filter((uid) => !(folder === anchor.folder && uid === anchor.uid));
          const candidates = wanted.length > 0 ? await selected.fetchSummaries(wanted, { includePreview: false }) : [];
          const linked = keepLinked(candidates, linksOf, known);
          // Previews only for what is kept: a second, small FETCH.
          summaries = linked.length > 0 ? await selected.fetchSummaries(linked.map((s) => s.uid)) : [];
        } else {
          uids.sort((a, b) => b - a);
          if (uids.length > MAX_THREAD_LIMIT) {
            uids = uids.slice(0, MAX_THREAD_LIMIT);
            reason ??= "limit";
          }
          const wanted = uids.filter((uid) => !(folder === anchor.folder && uid === anchor.uid));
          const fetched = wanted.length > 0 ? await selected.fetchSummaries(wanted) : [];
          summaries = keepLinked(fetched, linksOf, known);
        }
        for (const summary of summaries) {
          const row = imapRow(folder, summary);
          if (rows.has(row.id)) continue;
          // The same message filed in a second folder: the first one stands.
          if (row.message_id_header) {
            if (seenMessageIds.has(row.message_id_header)) continue;
            seenMessageIds.add(row.message_id_header);
          }
          rows.set(row.id, row);
        }
        searched.push(folder);
      } catch (error) {
        if (isFatal(error)) throw error;
        // This folder could not be searched (a SELECT or SEARCH the server
        // refused): the others still answer.
        reason ??= "folder_error";
      }
    }

    return finish([...rows.values()], limit, {
      thread_key: anchorRow.thread_key,
      strategy: fallback ? "imap_subject_fallback" : "imap_header_search",
      folders: searched,
      partial_reason: reason,
    });
  } finally {
    await session.close().catch(() => {});
  }
}

/** Must be called inside `firstPartyContext.run` with `threadHeaders` set. */
export async function mailThread(
  mcp: McpSeam,
  apiKey: ApiKeyRow,
  inboxId: string,
  args: ThreadArgs,
  clock: () => number = () => Date.now(),
): Promise<ThreadResult> {
  const inbox = await mcp.resolveInbox(inboxId, apiKey);
  if (!inbox) throw new ApiError(404, "inbox_not_found", "Inbox not found.", { toolCode: "inbox_not_found" });
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_THREAD_LIMIT, 1), MAX_THREAD_LIMIT);
  try {
    return inbox.provider === "gmail"
      ? await gmailThread(mcp, inbox, args, limit)
      : inbox.provider === "outlook"
      ? await outlookThread(mcp, inbox, args, limit, clock())
      : await imapThread(mcp, inbox, args, limit, clock);
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
