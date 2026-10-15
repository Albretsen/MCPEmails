/* Domain types.
 *
 * PART 1 mirrors the real backend (the MCP server's result shapes) field for
 * field, so the HTTP implementation is a pass-through. Do not rename these.
 * PART 2 holds client-side additions. Keep the two apart: nothing in part 2
 * exists on the wire.
 */

/* ===================================================================
 * PART 1: wire types (verbatim backend names)
 * =================================================================== */

export interface EmailAddressEntry {
  name: string;
  email: string;
}

export interface EmailSummary {
  id: string;
  from: EmailAddressEntry;
  to: EmailAddressEntry[];
  subject: string;
  /** ISO 8601, UTC. */
  date: string;
  preview: string;
  is_read: boolean;
  has_attachments: boolean;
  /** Folder id as the provider reports it. Opaque: never parse it. */
  folder: string;
  thread_id: string;
  /** Starred / flagged. Sent by the client API on every list and search row. */
  is_flagged?: boolean;
  /* ---- Conversation threading. Sent by the client API on every list, search
   *      and thread row; ABSENT from an older server and from rows cached
   *      before it (such a row is then a conversation of one). ---- */
  /** RFC 5322 Message-ID without the angle brackets. */
  message_id_header?: string | null;
  /** The parent's Message-ID. IMAP and Gmail; null on Outlook. */
  in_reply_to?: string | null;
  /** Ancestors' Message-IDs, oldest first (the root is kept when truncated). */
  references?: string[];
  /** The conversation, as the server computed it. Opaque apart from its first
   *  letter: `g:` Gmail thread, `o:` Outlook conversation, `m:` root
   *  Message-ID, `s:` subject + participants (no headers), `u:` a lone message. */
  thread_key?: string;
}

/** The `thread` op's result: the messages of one conversation across folders,
 *  date ASCENDING, without bodies. */
export interface ThreadResult {
  thread_key: string;
  messages: EmailSummary[];
  /** Something bounded the answer (a limit, the time budget, a folder that
   *  could not be searched): there may be more. */
  partial: boolean;
  partial_reason?: ThreadPartialReason;
  /** How the server found the conversation. Informational only. */
  strategy?: "imap_gmail_thrid" | "imap_subject_search" | (string & {});
  folders?: string[];
}

/** Why a `thread` answer may be incomplete. `rate_limited` and `time_budget`
 *  are passing conditions: asking again later may find the rest. A server newer
 *  than this client may send a reason that is not listed here. */
export type ThreadPartialReason = "limit" | "time_budget" | "folder_error" | "candidates" | "rate_limited" | (string & {});

export interface ListInboxResult {
  messages: EmailSummary[];
  /** May be null (some IMAP servers cannot count cheaply). Never render null as a number. */
  total: number | null;
  total_is_estimate?: boolean;
  has_more: boolean;
  next_offset: number | null;
}

export interface ReadEmailAttachmentMeta {
  attachment_index?: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  /** Base64 when the caller asked for the bytes, otherwise null. */
  data: string | null;
  note?: string;
}

export interface ReadEmailResult {
  id: string;
  thread_id: string;
  from: EmailAddressEntry;
  to: EmailAddressEntry[];
  cc: EmailAddressEntry[];
  bcc: EmailAddressEntry[];
  reply_to: EmailAddressEntry | null;
  subject: string;
  date: string;
  body_text: string | null;
  body_html: string | null;
  attachments: ReadEmailAttachmentMeta[];
  /** Reading a message never changes this; marking read is a separate flag call. */
  is_read: boolean;
  labels: string[];
  in_reply_to: string | null;
  references: string[];
  /** Starred / flagged. Sent by the client API on every `read`. */
  is_flagged?: boolean;
  /** See EmailSummary. */
  message_id_header?: string | null;
  thread_key?: string;
  /** The folder the message is in, as a list row of that folder names it.
   *  Sent by the client API on every `read`; valid as a move destination. */
  folder?: string;
}

/** THE result of the `move`, `archive` and `delete` ops, for every provider.
 *  One row per message id asked for, in the order asked. */
export interface RelocateResult {
  succeeded: number;
  failed: number;
  results: RelocateRow[];
}

/** `success: true`: the message was relocated and `new_message_id` is the id
 *  it has NOW. Gmail and Outlook: the same id. IMAP: the new id (the UID is
 *  per folder), or null when the server did not report it (no UIDPLUS). Null
 *  too after `delete` with `permanent: true`. A null id means the old id no
 *  longer resolves.
 *  `success: false`: nothing happened to this message (`error` says why;
 *  `not_processed` = the call stopped before reaching it). */
export type RelocateRow =
  | { message_id: string; success: true; new_message_id: string | null }
  | { message_id: string; success: false; error: string };

export interface FolderEntry {
  id: string;
  name: string;
  type: "folder" | "label";
  total_messages: number | null;
  unread_messages: number | null;
  /** The folder's system role, or null for a folder of the person's own.
   *  ABSENT from a server that does not send it yet: then (and only then) the
   *  client falls back to matching ids and names (`roleOfFolder`). */
  role?: ServerFolderRole | null;
}

export interface SenderIdentity {
  email_address: string;
  display_name: string | null;
  is_default: boolean;
}

export type InboxProvider = "gmail" | "outlook" | "fastmail" | "imap";

export interface Inbox {
  inbox_id: string;
  email_address: string;
  display_name: string;
  provider: InboxProvider;
  service: string | null;
  sender_identities: SenderIdentity[];
  sender_identity_status: "available" | "reconnect_required" | "unavailable";
  /** `/session` only (app.ts, `sessionInboxList`). Absent from a server that
   *  predates it and from a session cached before it: read it through
   *  `inboxHealth` (api/inbox-health.ts), never directly. */
  status?: InboxHealthStatus;
  /** null when `status` is "ok". "sender_identity": mail WORKS, only the
   *  send-as list needs a reconnect. */
  status_reason?: InboxStatusReason | null;
}

export type InboxHealthStatus = "ok" | "reconnect_required" | "error";
export type InboxStatusReason = "password_refused" | "access_revoked" | "sender_identity" | "no_mailbox" | "unavailable";

/** `folders` op: the system role of a folder, as the server resolved it. */
export type ServerFolderRole = "inbox" | "sent" | "drafts" | "trash" | "archive" | "spam";

/** Draft list rows carry no body: call readDraft for it. */
export interface DraftSummary {
  /** On IMAP this id CHANGES on every update. Always keep the latest one returned. */
  draft_id: string;
  subject: string;
  to: EmailAddressEntry[];
  cc: EmailAddressEntry[];
  created_at: string;
}

export interface ScheduledSend {
  id: string;
  inbox_id: string;
  send_at: string;
  status: string;
  created_at: string;
  /** Plain address strings, not EmailAddressEntry. */
  to: string[];
  subject: string;
}

export interface ContactHit {
  email_address: string;
  display_name: string | null;
  message_count: number;
  last_contacted_at: string;
  inbox_id: string;
}

export type PlanSlug = "free" | "personal" | "solo" | "pro";

/** The action cap as the backend reports it today. */
export interface ActionCapStatus {
  plan: PlanSlug;
  exempt: boolean;
  monthly: AllowancePeriod;
}

export interface AllowancePeriod {
  used: number;
  /** null = unlimited. Never render as a number. */
  cap: number | null;
  remaining: number | null;
  period_start: string;
  resets_at: string;
}

/* ===================================================================
 * PART 2: client-side additions (never sent to or received from the wire)
 * =================================================================== */

/** `${inbox_id}:${id}`. Message ids are only unique inside one inbox. */
export type MessageKey = `${string}:${string}`;

export function makeKey(inbox_id: string, id: string): MessageKey {
  return `${inbox_id}:${id}`;
}

/** Splits on the FIRST colon: inbox ids never contain one, message ids may. */
export function parseKey(key: MessageKey): { inbox_id: string; id: string } {
  const i = key.indexOf(":");
  return { inbox_id: key.slice(0, i), id: key.slice(i + 1) };
}

export type FolderRole = "inbox" | "starred" | "drafts" | "scheduled" | "sent" | "archive" | "trash" | "spam";

export const FOLDER_ROLES: readonly FolderRole[] = [
  "inbox",
  "starred",
  "drafts",
  "scheduled",
  "sent",
  "archive",
  "trash",
  "spam",
];

/** Roles the backend accepts as a folder alias. `starred` and `scheduled` are
 *  NOT folders there: starred = search with `flagged: true`, scheduled = the
 *  schedule list. MailApi implementations hide that difference. */
export const BACKEND_FOLDER_ALIASES: readonly FolderRole[] = ["inbox", "sent", "drafts", "trash", "archive", "spam"];

export const FOLDER_ROLE_LABEL: Record<FolderRole, string> = {
  inbox: "Inbox",
  starred: "Starred",
  drafts: "Drafts",
  scheduled: "Scheduled",
  sent: "Sent",
  archive: "Archive",
  trash: "Trash",
  spam: "Spam",
};

/** 'all' = unified view across every connected inbox, else one inbox_id. */
export type MailboxScope = "all" | (string & {});

/** How the client points at a folder.
 *  - `{ role }`                 a system folder, in whatever scope is active.
 *  - `{ inbox_id, folder_id }`  one concrete folder of one inbox (exact).
 *  - `{ name }`                 a custom folder BY NAME across the inboxes in
 *                               scope (unified view: "Receipts" in every inbox
 *                               that has one). Resolved per inbox by the API. */
export type FolderRef = { role: FolderRole } | { inbox_id: string; folder_id: string } | { name: string };

export function isRoleRef(ref: FolderRef): ref is { role: FolderRole } {
  return "role" in ref;
}
export function isExactRef(ref: FolderRef): ref is { inbox_id: string; folder_id: string } {
  return "folder_id" in ref;
}
export function isNameRef(ref: FolderRef): ref is { name: string } {
  return "name" in ref;
}

/** Stable string id for a FolderRef: map keys, query keys, URL segments, `folderBump`. */
export function folderRefId(ref: FolderRef): string {
  if (isRoleRef(ref)) return ref.role;
  if (isExactRef(ref)) return `id:${ref.inbox_id}:${ref.folder_id}`;
  return `name:${ref.name}`;
}

export function parseFolderRefId(id: string): FolderRef | null {
  if ((FOLDER_ROLES as readonly string[]).includes(id)) return { role: id as FolderRole };
  if (id.startsWith("name:") && id.length > 5) return { name: id.slice(5) };
  if (id.startsWith("id:")) {
    const rest = id.slice(3);
    const i = rest.indexOf(":");
    if (i > 0 && i < rest.length - 1) return { inbox_id: rest.slice(0, i), folder_id: rest.slice(i + 1) };
  }
  return null;
}

export function sameFolderRef(a: FolderRef, b: FolderRef): boolean {
  return folderRefId(a) === folderRefId(b);
}

/** Best-effort role for a provider folder id or name. Folder ids are opaque, so
 *  this is only used to decorate rows that did not come from a role listing
 *  (search results). Unknown folders return null. */
export function roleOfFolder(idOrName: string): FolderRole | null {
  const s = idOrName.toLowerCase().replace(/^\[(gmail|google mail)\]\//, "");
  if (s === "inbox") return "inbox";
  if (/^(sent|sent mail|sent items|sent messages)$/.test(s)) return "sent";
  if (/^(drafts?)$/.test(s)) return "drafts";
  if (/^(trash|bin|deleted|deleted items|deleted messages)$/.test(s)) return "trash";
  if (/^(archive|archives|all mail)$/.test(s)) return "archive";
  if (/^(spam|junk|junk e-?mail|bulk mail)$/.test(s)) return "spam";
  return null;
}

/** Gmail over IMAP lists its own machinery as folders: the "[Gmail]" container
 *  (it holds folders, no mail, and cannot be opened) and the Starred view
 *  (the app has its own). They are not folders the person made. */
export function isProviderViewFolder(idOrName: string): boolean {
  return /^\[(gmail|google mail)\](\/starred)?$/i.test(idOrName);
}

/** One row of a message list. The wire summary plus what the client needs to
 *  address and decorate it. */
export type MessageRow = EmailSummary & {
  key: MessageKey;
  inbox_id: string;
  is_starred: boolean;
  folder_role: FolderRole | null;
};

/** A fully read message, addressed the same way as a row. */
export type MessageDetail = ReadEmailResult & {
  key: MessageKey;
  inbox_id: string;
  is_starred: boolean;
  folder: string;
  folder_role: FolderRole | null;
  /** True while this is only the list row dressed up as a detail (body not loaded). */
  is_partial?: boolean;
};

/** One conversation as the `thread` op returned it, addressed like list rows. */
export interface MessageThread {
  thread_key: string;
  /** Date ascending. */
  rows: MessageRow[];
  partial: boolean;
  /** Set when `partial`. */
  partial_reason?: ThreadPartialReason;
}

/** Per-inbox offsets for a merged listing. `null` = that inbox is exhausted.
 *  For a single-inbox scope it has exactly one entry, which is the backend's
 *  own `offset` / `next_offset`. */
export type PageCursor = Record<string, number | null>;

/** One inbox of a unified listing that could not be loaded. The other inboxes
 *  are still shown; the list says which one is missing. */
export interface InboxFailure {
  inbox_id: string;
  /** `reconnect_required`: reconnecting in the dashboard fixes it.
   *  `inbox_unavailable`: it does not. Anything else: worth a retry. */
  code: string;
  message: string;
}

export interface MessagePage {
  rows: MessageRow[];
  /** Inboxes in scope that failed for this page. Absent when all answered. */
  failed_inboxes?: InboxFailure[];
  /** Set only on a PROVISIONAL first page of a unified listing: inboxes that
   *  have not answered yet. Such a page is not complete, has no total and no
   *  cursor, and is replaced when they answer (see `mergeInboxPages`). */
  pending_inboxes?: string[];
  /** Sum of the per-inbox totals, or null when any inbox could not count. */
  total: number | null;
  total_is_estimate: boolean;
  has_more: boolean;
  next_cursor: PageCursor | null;
}

export interface ListMessagesParams {
  scope: MailboxScope;
  folder: FolderRef;
  limit: number;
  /** Omit for the first page. */
  cursor?: PageCursor | null;
  unread?: boolean;
}

export interface SearchMessagesParams {
  scope: MailboxScope;
  query: string;
  limit: number;
  cursor?: PageCursor | null;
}

export interface MessageFlags {
  read?: boolean;
  starred?: boolean;
}

/** Message ids are not stable across a move on IMAP (the UID is per folder).
 *  Every mutation that relocates a message reports the key it has now. */
export interface MoveResult {
  /** `id_unknown`: the message moved but the server did not say under which
   *  id (IMAP without UIDPLUS). `new_key` is then the old key, which no longer
   *  resolves: the move cannot be undone from here. */
  moved: { key: MessageKey; new_key: MessageKey; id_unknown?: true }[];
}

/** A file sent with a message: base64 in the JSON body. */
export interface OutgoingAttachment {
  filename: string;
  mime_type: string;
  /** Base64 (standard alphabet, no data: prefix). */
  data: string;
}

/** Total size of the files on one message (before base64). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Fields shared by every call that puts a message on the wire. */
export interface SendExtras {
  attachments?: OutgoingAttachment[];
  /** One per user send. Pass the SAME key when retrying that send, so a
   *  dropped response can never deliver the message twice. Generated by the
   *  implementation when omitted. */
  idempotency_key?: string;
}

export interface SendMessageInput extends SendExtras {
  inbox_id: string;
  to: EmailAddressEntry[];
  cc?: EmailAddressEntry[];
  bcc?: EmailAddressEntry[];
  subject: string;
  body_text: string;
  body_html?: string;
}

export interface ReplyMessageInput extends SendExtras {
  /** The message being answered. */
  key: MessageKey;
  reply_all?: boolean;
  /** The To line as the person left it. When given, the lists are explicit:
   *  To is exactly `to`, Cc exactly `cc`, Bcc exactly `bcc`, and the backend
   *  derives nothing. Omitted, the backend answers the original's sender (or
   *  everyone, with `reply_all`) and `cc` / `bcc` are additions. The reply is
   *  threaded under `key` either way. */
  to?: EmailAddressEntry[];
  /** The subject shown in the editor. Not sent: a reply keeps its thread's subject. */
  subject?: string;
  cc?: EmailAddressEntry[];
  bcc?: EmailAddressEntry[];
  body_text: string;
  body_html?: string;
}

export interface ForwardMessageInput extends SendExtras {
  key: MessageKey;
  to: EmailAddressEntry[];
  cc?: EmailAddressEntry[];
  bcc?: EmailAddressEntry[];
  /** Note placed above the forwarded message. */
  body_text?: string;
}

export interface SendResult {
  /** Id of the message in Sent when the provider reports one. */
  message_id: string | null;
  inbox_id: string;
}

export interface DraftInput {
  inbox_id: string;
  to: EmailAddressEntry[];
  cc?: EmailAddressEntry[];
  bcc?: EmailAddressEntry[];
  subject: string;
  body_text: string;
  /** Set when the draft is a reply, so it threads. */
  reply_to?: MessageKey;
}

export interface DraftDetail extends DraftSummary {
  inbox_id: string;
  bcc: EmailAddressEntry[];
  body_text: string;
  body_html: string | null;
  reply_to: MessageKey | null;
}

export interface DraftRef {
  inbox_id: string;
  /** The id to use from now on. May differ from the one you passed in. */
  draft_id: string;
}

export interface ScheduleSendInput extends SendMessageInput {
  /** ISO 8601, UTC. */
  send_at: string;
}

/** Server-pushed changes (new mail watch, another device, an automation). */
export type MailEvent =
  | { type: "new_mail"; rows: MessageRow[] }
  | { type: "flags_changed"; keys: MessageKey[]; flags: MessageFlags }
  /** `to: null` = the messages left their folder and the destination is not
   *  known (seen by the sync engine: moved or deleted on another device). */
  | { type: "moved"; keys: MessageKey[]; to: FolderRef | null; from?: FolderRef; new_keys?: MessageKey[] };

export type MailEventListener = (event: MailEvent) => void;

/** A downloaded attachment, ready for a blob URL. */
export interface AttachmentDownload {
  blob: Blob;
  filename: string;
  mime_type: string;
}

/** `status` op: the cheap change check for one folder. */
export interface FolderStatus {
  /** The folder as it was asked for (alias, name or id). */
  folder?: string;
  /** The provider folder id it resolved to. */
  id: string;
  total: number | null;
  unread: number | null;
  /** Changes whenever the folder's contents or flags change. Opaque.
   *  IMAP servers without CONDSTORE: flag changes are seen only on the newest
   *  50 messages of the first two folders asked about. */
  fingerprint: string;
}

/** One `folders[]` entry of the `status` op as the server sends it. A folder
 *  that could not be read has `fingerprint: null` and an `error` code
 *  (`folder_not_found`, `provider_error`, `reconnect_required`); `id` is null
 *  when it did not even resolve. The other folders still answer. */
export interface FolderStatusWire {
  folder: string;
  id: string | null;
  total: number | null;
  unread: number | null;
  fingerprint: string | null;
  error?: string;
}

/** The `status` op's result. */
export interface StatusResult {
  inbox_id: string;
  provider: string;
  folders: FolderStatusWire[];
}

export interface SessionUser {
  id: string;
  email: string;
  display_name: string | null;
}

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer" | (string & {});

export interface WorkspaceInfo {
  id: string;
  display_name: string;
  role: WorkspaceRole;
  plan: PlanSlug;
  web_client_enabled: boolean;
}

/** `GET /session`: everything the app needs to boot, in one round trip. */
export interface SessionInfo {
  user: SessionUser;
  workspaces: WorkspaceInfo[];
  /** The active workspace (chosen by X-Workspace-Id, else the earliest membership). */
  workspace_id: string;
  role: WorkspaceRole;
  inboxes: Inbox[];
  allowance: AssistantAllowance;
}

/** The assistant's own monthly allowance. Same period shape as the action cap,
 *  but a separate counter: it applies even to cap-exempt workspaces. */
export interface AssistantAllowance extends AllowancePeriod {
  plan: PlanSlug;
}

/** Slugs are historical: `solo` is sold as Pro and `pro` as Team. */
export function planDisplayName(plan: PlanSlug): string {
  switch (plan) {
    case "free":
      return "Free";
    case "personal":
      return "Personal";
    case "solo":
      return "Pro";
    case "pro":
      return "Team";
  }
}

/** "312 / 1,000", or "312 used" when there is no cap. */
export function formatAllowance(a: Pick<AllowancePeriod, "used" | "cap">): string {
  const used = a.used.toLocaleString("en-US");
  return a.cap == null ? `${used} used` : `${used} / ${a.cap.toLocaleString("en-US")}`;
}

/** 0..1 for a meter, or null when there is no cap to measure against. */
export function allowanceFraction(a: Pick<AllowancePeriod, "used" | "cap">): number | null {
  if (a.cap == null || a.cap <= 0) return null;
  return Math.min(1, Math.max(0, a.used / a.cap));
}

export function isAllowanceExhausted(a: Pick<AllowancePeriod, "cap" | "remaining">): boolean {
  return a.cap != null && a.remaining != null && a.remaining <= 0;
}

/** "Maya Chen <maya@x.io>" style list to entries. Tolerant of bare addresses. */
export function parseAddressList(input: string): EmailAddressEntry[] {
  return input
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(.*)<([^>]+)>$/.exec(s);
      if (m) return { name: (m[1] ?? "").trim().replace(/^"|"$/g, ""), email: (m[2] ?? "").trim() };
      return { name: "", email: s };
    });
}

export function formatAddressList(list: EmailAddressEntry[]): string {
  return list.map((a) => a.email).join(", ");
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = "NotImplementedError";
  }
}
