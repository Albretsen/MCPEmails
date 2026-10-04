// ---------------------------------------------------------------------------
// First-party context: the seam between the tool layer and `client-api`.
//
// `client-api` (supabase/functions/client-api) is the web mail client's own
// edge function. It imports this server's executors in-process and runs them
// for a signed-in human. A handful of things have to differ on that path and
// on that path ONLY:
//
//   includeFlagged   list/search rows carry `is_flagged`. MCP output must not
//                    grow a field (output schemas, token cost), so the field
//                    exists only when this option is set.
//   inboxRow /       a short-lived in-isolate cache of `inboxes` rows, so a
//   rememberInboxRow warm request does not pay a PostgREST round trip per call.
//   imapConnect      routes `ImapClient.connect` through client-api's session
//                    pool instead of dialling per call.
//   includeFlagged   also: a single `email_read` result carries `is_flagged`
//                    and `folder` (the reader toolbar and Undo need both).
//   replyRecipients  `email_reply` honours an explicit `to`: the human edited
//                    the recipient lists, and what is on screen is what is
//                    sent, still threaded. MCP callers cannot pass `to`.
//   humanBulk        a human's own multi-select move/delete runs now instead
//                    of becoming a `bulk_review_mode` plan: the person clicking
//                    IS the reviewer that gate waits for.
//   trashIds         an IMAP delete-to-trash reports the ids the messages have
//                    in Trash (COPYUID), so the client can undo it.
//   listPreviewBytes how much of part one an IMAP listing fetches for that
//                    preview (0: none, the rows then carry `preview: ""`).
//   threadHeaders    list/search rows carry `message_id_header`, `in_reply_to`
//                    and `references`, and a read carries `message_id_header`,
//                    so the web client can group mail into conversations. On
//                    IMAP the References header rides the SAME summary FETCH
//                    (`BODY.PEEK[HEADER.FIELDS (REFERENCES)]`); Gmail adds
//                    three names to `metadataHeaders`; Graph adds
//                    `internetMessageId` to `$select`. No extra round trip.
//                    On a Gmail address connected over IMAP (the server
//                    advertises X-GM-EXT-1) the same FETCH also asks for
//                    X-GM-THRID and X-GM-MSGID, and rows carry `gm_thread_id`.
//
// All of it rides one AsyncLocalStorage. NOTHING in the MCP server ever opens
// this store: `handleRequest` does not call `firstPartyContext.run`, so for
// every MCP request `getStore()` is undefined and each hook below is inert.
// (The clean IMAP preview started here as a `cleanPreview` option. It is the
// behaviour for every caller since 2026-10-04, so the option is gone. So are
// `joinInlineParts` and `exactOctets`: every read joins the inline text parts,
// and the IMAP reader hands every caller exact octets. Body and preview
// decoding has no first-party branch left.)
// That is the whole behaviour-neutrality argument, and
// client-api/tests/mcp-neutral.test.ts pins it on the bytes of a real
// `tools/call` response.
//
// This module imports nothing from the server on purpose, so imap-client.ts
// and index.ts can both depend on it without a cycle.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";

/** The connection parameters `ImapClient.connect` receives. */
export interface FirstPartyImapConfig {
  host: string;
  port: number;
  email: string;
  password: string;
  security?: "tls" | "starttls";
}

export interface FirstPartyContext {
  /** Add `is_flagged` to list and search rows. */
  includeFlagged?: boolean;
  /**
   * A cached `inboxes` row for this id in this workspace, or null. The row is
   * exactly what `resolveInbox` would have selected; the caller owns freshness.
   */
  inboxRow?: (inboxId: string, workspaceId: string) => unknown | null;
  /** Called with every row `resolveInbox` loads from the database. */
  rememberInboxRow?: (row: unknown) => void;
  /**
   * Replaces the dial in `ImapClient.connect`. `dial` is the unchanged
   * connect-with-retry; the hook may call it, or hand back a pooled client.
   */
  imapConnect?: <C>(cfg: FirstPartyImapConfig, dial: () => Promise<C>) => Promise<C>;
  /** `email_reply` reads an explicit `to` (and then derives no recipients). */
  replyRecipients?: boolean;
  /** Bulk move/delete execute directly, whatever the inbox's `bulk_review_mode`. */
  humanBulk?: boolean;
  /** IMAP delete-to-trash rows carry `new_message_id`. */
  trashIds?: boolean;
  /** Octets of part one an IMAP listing fetches for the preview; 0 fetches none. */
  listPreviewBytes?: number;
  /** Rows carry the RFC 5322 threading headers (see the header comment). */
  threadHeaders?: boolean;
}

/** Opened by client-api around each executor call; absent for MCP traffic. */
export const firstPartyContext = new AsyncLocalStorage<FirstPartyContext>();

/** True only inside a client-api call that asked for `is_flagged`. */
export function wantsFlagged(): boolean {
  return firstPartyContext.getStore()?.includeFlagged === true;
}

/**
 * `{ is_flagged }` to spread into a list/search row, or `{}` for MCP traffic.
 * Spreading `{}` adds no key, so the serialised row is byte-identical to what
 * it was before this module existed. `isFlagged` is a thunk so the MCP path
 * does not even evaluate it.
 */
export function flaggedField(isFlagged: () => boolean): { is_flagged?: boolean } {
  return wantsFlagged() ? { is_flagged: isFlagged() } : {};
}

/**
 * `{ is_flagged, folder }` to spread into a single-message read result, or
 * `{}` for MCP traffic (same byte-identity argument as `flaggedField`).
 */
export function readExtraFields(
  extras: () => { is_flagged: boolean; folder: string },
): { is_flagged?: boolean; folder?: string } {
  return wantsFlagged() ? extras() : {};
}

/** True only inside a client-api call made for the signed-in human's reply. */
export function wantsReplyRecipients(): boolean {
  return firstPartyContext.getStore()?.replyRecipients === true;
}

/** True only inside a client-api call made by the human (never the assistant). */
export function isHumanBulk(): boolean {
  return firstPartyContext.getStore()?.humanBulk === true;
}

/** True only inside a client-api delete that wants the Trash ids back. */
export function wantsTrashIds(): boolean {
  return firstPartyContext.getStore()?.trashIds === true;
}

/**
 * The partial-fetch item an IMAP summary FETCH asks for. For MCP traffic (no
 * store) this is the literal the command has always carried.
 */
export function summaryPreviewItem(): string {
  const bytes = firstPartyContext.getStore()?.listPreviewBytes;
  if (bytes === undefined) return " BODY.PEEK[1]<0.2048>";
  if (!Number.isInteger(bytes) || bytes <= 0) return "";
  return ` BODY.PEEK[1]<0.${Math.min(bytes, 8192)}>`;
}

// ── Conversation threading (client-api only) ────────────────────────────────

/** References kept on a row: the root (first) plus the newest nine. */
export const MAX_ROW_REFERENCES = 10;

export interface ThreadHeaderFields {
  /** RFC 5322 Message-ID without the angle brackets, or null. */
  message_id_header?: string | null;
  /** The first id of In-Reply-To without the angle brackets, or null. */
  in_reply_to?: string | null;
  /** Ids of References, oldest first; the root is always kept when truncated. */
  references?: string[];
}

/** True only inside a client-api call that asked for the threading headers. */
export function wantsThreadHeaders(): boolean {
  return firstPartyContext.getStore()?.threadHeaders === true;
}

/**
 * The extra item an IMAP summary FETCH asks for: the References header, in the
 * same command as the envelope. For MCP traffic (no store) this is "" and the
 * command is the literal it has always been.
 */
export function summaryReferencesItem(): string {
  return wantsThreadHeaders() ? " BODY.PEEK[HEADER.FIELDS (REFERENCES)]" : "";
}

/** The header names a Gmail `format=metadata` get adds; none for MCP traffic. */
export function threadMetadataHeaders(): string[] {
  return wantsThreadHeaders() ? ["Message-ID", "In-Reply-To", "References"] : [];
}

/** ",internetMessageId" for a Graph `$select`; "" for MCP traffic. */
export function threadGraphSelect(): string {
  return wantsThreadHeaders() ? ",internetMessageId" : "";
}

/** Every `<id>` of a header value, without brackets; a bare token counts as one id. */
export function messageIdsOf(value: string | null | undefined): string[] {
  if (!value) return [];
  const unfolded = value.replace(/\r?\n[ \t]+/g, " ");
  const bracketed = unfolded.match(/<[^<>\s]+>/g);
  if (bracketed) return bracketed.map((id) => id.slice(1, -1));
  return unfolded.split(/[\s,]+/).map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 998);
}

/** The value of a raw `References: ...` header block (as HEADER.FIELDS returns it). */
export function referencesOfHeaderBlock(block: string | null | undefined): string[] {
  if (!block) return [];
  const m = /^references:([\s\S]*)$/im.exec(block.replace(/\r?\n[ \t]+/g, " "));
  return messageIdsOf(m ? m[1].split(/\r?\n/)[0] : "");
}

function boundedReferences(ids: string[]): string[] {
  return ids.length <= MAX_ROW_REFERENCES ? ids : [ids[0], ...ids.slice(-(MAX_ROW_REFERENCES - 1))];
}

/**
 * `{ message_id_header, in_reply_to, references }` to spread into a list or
 * search row, or `{}` for MCP traffic (the byte-identity argument of
 * `flaggedField`). `read` is a thunk so the MCP path evaluates nothing.
 */
export function threadFields(
  read: () => { messageId?: string | null; inReplyTo?: string | null; references?: string | string[] | null },
): ThreadHeaderFields {
  if (!wantsThreadHeaders()) return {};
  const raw = read();
  const references = Array.isArray(raw.references) ? raw.references : messageIdsOf(raw.references);
  return {
    message_id_header: messageIdsOf(raw.messageId)[0] ?? null,
    in_reply_to: messageIdsOf(raw.inReplyTo)[0] ?? null,
    references: boundedReferences(references),
  };
}

/**
 * `{ gm_thread_id }` for an IMAP list/search row whose summary carried Gmail's
 * X-GM-THRID (a Gmail address connected over IMAP; the id rides the same FETCH,
 * see `ImapClient.gmailSummaryItems`), or `{}`: always `{}` for MCP traffic.
 * client-api turns it into the row's `thread_key` ("g:<id>") and removes it.
 */
export function gmailThreadField(read: () => string | null | undefined): { gm_thread_id?: string } {
  if (!wantsThreadHeaders()) return {};
  const id = read();
  return typeof id === "string" && /^\d{1,24}$/.test(id) ? { gm_thread_id: id } : {};
}

/** `{ message_id_header }` for a row whose provider gives nothing else cheaply (Graph). */
export function threadMessageIdField(read: () => string | null | undefined): { message_id_header?: string | null } {
  return wantsThreadHeaders() ? { message_id_header: messageIdsOf(read())[0] ?? null } : {};
}
