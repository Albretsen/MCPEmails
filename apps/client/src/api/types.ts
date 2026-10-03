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
}

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
}

export interface FolderEntry {
  id: string;
  name: string;
  type: "folder" | "label";
  total_messages: number | null;
  unread_messages: number | null;
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
}

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

/** Per-inbox offsets for a merged listing. `null` = that inbox is exhausted.
 *  For a single-inbox scope it has exactly one entry, which is the backend's
 *  own `offset` / `next_offset`. */
export type PageCursor = Record<string, number | null>;

export interface MessagePage {
  rows: MessageRow[];
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
  moved: { key: MessageKey; new_key: MessageKey }[];
}

export interface SendMessageInput {
  inbox_id: string;
  to: EmailAddressEntry[];
  cc?: EmailAddressEntry[];
  bcc?: EmailAddressEntry[];
  subject: string;
  body_text: string;
  body_html?: string;
}

export interface ReplyMessageInput {
  /** The message being answered. */
  key: MessageKey;
  reply_all?: boolean;
  /** Overrides the recipients the backend would derive. */
  to?: EmailAddressEntry[];
  cc?: EmailAddressEntry[];
  bcc?: EmailAddressEntry[];
  body_text: string;
  body_html?: string;
}

export interface ForwardMessageInput {
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
  | { type: "moved"; keys: MessageKey[]; to: FolderRef; from?: FolderRef; new_keys?: MessageKey[] };

export type MailEventListener = (event: MailEvent) => void;

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
