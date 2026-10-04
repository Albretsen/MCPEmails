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
