// ---------------------------------------------------------------------------
// The `status` op: a cheap "did anything change?" check per folder.
//
// The client polls this (on focus, and every 30 to 60 s while visible) instead
// of re-listing. It answers, per folder, `{ id, total, unread, fingerprint }`.
// The fingerprint is opaque: the client only compares it with the one it saw
// last, and refetches page 1 of a folder whose fingerprint moved.
//
// What each provider's fingerprint is made of, and what it can and cannot see:
//
//   IMAP     one STATUS per folder on the pooled connection:
//            UIDVALIDITY + UIDNEXT + MESSAGES + UNSEEN, plus HIGHESTMODSEQ when
//            the server has CONDSTORE (Gmail, Fastmail, Dovecot, iCloud, Yahoo).
//            With HIGHESTMODSEQ every change moves it, a star included.
//            WITHOUT it, STATUS alone sees arrivals, deletions, moves and the
//            unread COUNT, but not a star, and not a read/unread swap that
//            leaves the count where it was. So for the first FLAGS_DIGEST_FOLDERS
//            folders of the request (the client asks for the inbox first) the
//            fingerprint also carries a digest of `UID FLAGS` of the newest
//            FLAGS_DIGEST_MESSAGES messages: one SELECT and one small FETCH,
//            on the same pooled connection.
//            NOT detected on a server without CONDSTORE: a flag change on a
//            message older than the newest FLAGS_DIGEST_MESSAGES of a digest
//            folder, and any flag-only change that keeps UNSEEN the same in a
//            folder beyond the first FLAGS_DIGEST_FOLDERS.
//   Gmail    the mailbox `historyId` (moves on every change anywhere in the
//            mailbox, so every folder's fingerprint moves together) plus the
//            label's own counters for `total` / `unread`.
//   Outlook  the folder's counters plus the id and lastModifiedDateTime of its
//            most recently MODIFIED message, which a flag or read change bumps.
//
// A folder that cannot be resolved or read reports `error` for that folder
// only; the others still answer.
// ---------------------------------------------------------------------------

import { lookupCanonicalAlias } from "../../mcp-server/imap-folder-target.ts";
import { graphFetch } from "../../mcp-server/outlook-graph.ts";
import { ApiError } from "../errors.ts";
import { reconnectMessage } from "./health.ts";
import type { ApiKeyRow, InboxRow, McpSeam } from "../seam.ts";

export interface FolderStatus {
  /** The folder as the caller named it (alias, name or id). */
  folder: string;
  /** The provider folder id it resolved to; null when it did not resolve. */
  id: string | null;
  total: number | null;
  unread: number | null;
  fingerprint: string | null;
  error?: string;
}

export interface StatusResult {
  inbox_id: string;
  provider: string;
  folders: FolderStatus[];
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Folders per request that get a flags digest on a server without CONDSTORE. */
export const FLAGS_DIGEST_FOLDERS = 2;
/** Newest messages whose flags the digest covers (one list page). */
export const FLAGS_DIGEST_MESSAGES = 50;

/** FNV-1a, 32 bit: a change detector, not a security boundary. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function failed(folder: string, id: string | null, error: string): FolderStatus {
  return { folder, id, total: null, unread: null, fingerprint: null, error };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/auth_failed$/.test(message)) return "reconnect_required";
  if (error instanceof Error && error.name === "FolderTargetError") return "folder_not_found";
  // A folder id the client still holds for a mailbox that was since deleted or
  // renamed: IMAP answers the STATUS (or SELECT) with NO.
  if (/^(STATUS failed for|Mailbox not found:)/.test(message)) return "folder_not_found";
  return "provider_error";
}

/**
 * A refused credential, in either form the tool layer raises it: the
 * `*_auth_failed` sentinel its helpers throw, or the `ImapAuthError` a dial
 * throws when this module opens the connection itself (`session.client()`).
 * Found live 2026-10-04: only the sentinel was recognised, so a status call
 * for the inbox alone (no LIST, hence no helper in between) answered 200 with
 * a per-folder `provider_error` while every other op said reconnect_required.
 */
function isAuthFailure(error: unknown): boolean {
  return error instanceof Error &&
    (/^(gmail|outlook|imap|fastmail)_auth_failed$/.test(error.message) || error.name === "ImapAuthError");
}

async function imapStatus(mcp: McpSeam, inbox: InboxRow, folders: string[], flagsDigest = true): Promise<FolderStatus[]> {
  const out: FolderStatus[] = [];
  // In order, on ONE connection, which is handed back to the pool after every
  // folder and taken again for the next. With nobody else waiting that costs
  // nothing (the same connection comes straight back). With a `list` or
  // `read` waiting (imap-pool.ts rule 8) it lets that go first: a poll of six
  // folders is six round trips, and a person's click should wait for one of
  // them at most, not for all six.
  let digests = 0;
  for (const folder of folders) {
    const session = mcp.imapSessionFor(inbox);
    if (!session) throw new ApiError(502, "provider_error", "This inbox has no IMAP session.");
    try {
      let id: string | null = null;
      try {
        id = await mcp.resolveFolderId(inbox, folder, { strict: true, forRead: true, session });
        const client = await session.client();
        const s = await client.mailboxChangeState(id);
        // No CONDSTORE: STATUS cannot see a flag change, so look at the flags
        // of the newest messages for the first few folders (see the header).
        let flags = "-";
        if (flagsDigest && s.highestModSeq === null && s.messages > 0 && digests < FLAGS_DIGEST_FOLDERS) {
          digests++;
          try {
            const selected = await session.select(id);
            const count = selected.selectedMessageCount() ?? s.messages;
            const listed = count > 0
              ? await selected.flagsBySequence(Math.max(1, count - FLAGS_DIGEST_MESSAGES + 1), count)
              : "";
            if (listed !== null) flags = digest(listed);
          } catch (error) {
            if (isAuthFailure(error) || (error instanceof Error && error.name === "ImapAuthError")) throw error;
            // The counters still stand; this poll just sees no flag detail.
          }
        }
        out.push({
          folder,
          id,
          total: s.messages,
          unread: s.unseen,
          fingerprint: `i:${s.uidValidity}:${s.uidNext}:${s.messages}:${s.unseen}:${s.highestModSeq ?? "-"}:${flags}`,
        });
      } catch (error) {
        if (isAuthFailure(error)) throw error;
        // The pool had no connection to give: the whole call is retryable,
        // not a per-folder fact.
        if (error instanceof Error && error.name === "ImapPoolBusyError") throw error;
        out.push(failed(folder, id, errorCode(error)));
      }
    } finally {
      await session.close();
    }
  }
  return out;
}

async function gmailStatus(mcp: McpSeam, inbox: InboxRow, folders: string[]): Promise<FolderStatus[]> {
  const token = await mcp.withFreshGmailToken(inbox);
  const headers = { Authorization: `Bearer ${token}` };
  const profile = (async () => {
    const resp = await fetch(`${GMAIL_BASE}/profile`, { headers });
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      throw new Error(`gmail_profile_failed:${resp.status}`);
    }
    const body = await resp.json() as { historyId?: string };
    return body.historyId ?? null;
  })();
  profile.catch(() => {});
  const perFolder = folders.map(async (folder): Promise<Omit<FolderStatus, "fingerprint">> => {
    let id: string | null = null;
    try {
      id = await mcp.resolveFolderId(inbox, folder, { strict: true, forRead: true });
      const resp = await fetch(`${GMAIL_BASE}/labels/${encodeURIComponent(id)}`, { headers });
      if (resp.status === 401) throw new Error("gmail_auth_failed");
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        // Not every folder is a label (All Mail): no counters, the mailbox
        // historyId is still a valid fingerprint for it.
        return { folder, id, total: null, unread: null };
      }
      const label = await resp.json() as { messagesTotal?: number; messagesUnread?: number };
      return { folder, id, total: label.messagesTotal ?? null, unread: label.messagesUnread ?? null };
    } catch (error) {
      if (isAuthFailure(error)) throw error;
      return { ...failed(folder, id, errorCode(error)) };
    }
  });
  const [historyId, rows] = await Promise.all([profile, Promise.all(perFolder)]);
  return rows.map((row) => ({
    ...row,
    fingerprint: "error" in row && row.error ? null : historyId === null ? null : `g:${historyId}`,
  }));
}

async function outlookStatus(mcp: McpSeam, inbox: InboxRow, folders: string[]): Promise<FolderStatus[]> {
  const token = await mcp.withFreshOutlookToken(inbox);
  const one = async (folder: string): Promise<FolderStatus> => {
    let id: string | null = null;
    try {
      // An alias ("sent", "trash", "spam", "archive", ...) is Graph's own
      // well-known folder name (sentitems, deleteditems, junkemail, archive):
      // addressed directly, in any display language, with no folder walk.
      // Every alias used to walk the whole folder tree first, all of them at
      // once, on top of two requests per folder: far past the four concurrent
      // requests Exchange allows one mailbox, and the folders at the end of
      // the list (spam) answered provider_error.
      const alias = lookupCanonicalAlias(folder);
      id = alias ? alias.outlook : await mcp.resolveFolderId(inbox, folder, { strict: true, forRead: true });
      const segment = mcp.outlookFolderPathSegment(id);
      const [countsResp, latestResp] = await Promise.all([
        graphFetch(token, `/me/mailFolders/${segment}?$select=id,totalItemCount,unreadItemCount`),
        graphFetch(
          token,
          `/me/mailFolders/${segment}/messages?$select=id,lastModifiedDateTime&$orderby=lastModifiedDateTime desc&$top=1`,
        ),
      ]);
      if (countsResp.status === 401 || latestResp.status === 401) throw new Error("outlook_auth_failed");
      if (!countsResp.ok) {
        await countsResp.body?.cancel().catch(() => {});
        await latestResp.body?.cancel().catch(() => {});
        return failed(folder, id, countsResp.status === 404 ? "folder_not_found" : "provider_error");
      }
      const counts = await countsResp.json() as { id?: string; totalItemCount?: number; unreadItemCount?: number };
      let latest = "-";
      if (latestResp.ok) {
        const page = await latestResp.json() as { value?: Array<{ id?: string; lastModifiedDateTime?: string }> };
        const top = page.value?.[0];
        if (top) latest = `${top.id ?? ""}@${top.lastModifiedDateTime ?? ""}`;
      } else {
        await latestResp.body?.cancel().catch(() => {});
      }
      const total = counts.totalItemCount ?? null;
      const unread = counts.unreadItemCount ?? null;
      return { folder, id: counts.id ?? id, total, unread, fingerprint: `o:${total}:${unread}:${latest}` };
    } catch (error) {
      if (isAuthFailure(error)) throw error;
      if (error instanceof Error && error.name === "OutlookNoMailboxError") throw error;
      return failed(folder, id, errorCode(error));
    }
  };
  // Two folders (four requests) at a time, results in the order asked.
  const rows: FolderStatus[] = new Array(folders.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < folders.length) {
      const index = next++;
      rows[index] = await one(folders[index]);
    }
  };
  await Promise.all([worker(), worker()]);
  return rows;
}

/** Must be called inside `firstPartyContext.run` so the inbox cache and IMAP pool apply. */
export async function mailboxStatus(
  mcp: McpSeam,
  apiKey: ApiKeyRow,
  inboxId: string,
  folders: string[],
  /**
   * `flagsDigest: false` skips the SELECT + FETCH a server without CONDSTORE
   * otherwise costs (see the header). For the push watcher (push/mail.ts),
   * which only asks whether mail ARRIVED and so has no use for flag changes.
   * The client's own `status` op never passes it.
   */
  options: { flagsDigest?: boolean } = {},
): Promise<StatusResult> {
  const inbox = await mcp.resolveInbox(inboxId, apiKey);
  if (!inbox) throw new ApiError(404, "inbox_not_found", "Inbox not found.", { toolCode: "inbox_not_found" });
  try {
    const rows = inbox.provider === "gmail"
      ? await gmailStatus(mcp, inbox, folders)
      : inbox.provider === "outlook"
      ? await outlookStatus(mcp, inbox, folders)
      : await imapStatus(mcp, inbox, folders, options.flagsDigest !== false);
    return { inbox_id: inbox.id, provider: inbox.provider, folders: rows };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isAuthFailure(error) || (error instanceof Error && error.name === "ImapAuthError")) {
      throw new ApiError(409, "reconnect_required", reconnectMessage(inbox.provider), {
        toolCode: "auth_failed",
      });
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
