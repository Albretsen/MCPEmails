// ---------------------------------------------------------------------------
// subscription-scan.ts: the provider half of subscription cleanup. Reads the
// From, List-Id, List-Unsubscribe, List-Unsubscribe-Post, DKIM-Signature and
// Authentication-Results headers of recent mail, plus read state, date and
// folder, and returns them as `ListHeaderRecord`s for list-unsubscribe.ts to
// group and classify.
//
// Kept out of index.ts so it can be tested without booting the server. The
// provider plumbing it needs (an IMAP session, a Gmail or Graph fetch with a
// fresh token, the Junk folder's name) is handed in as a context that
// index.ts builds (`subscriptionScanContextFor`).
//
// ── Bounds ──────────────────────────────────────────────────────────────────
// Every provider stops at `limit` messages, at messages older than `days`,
// and when the shared WorkBudget (bulk-budget.ts, 25 s by default) runs out.
// Stops are cooperative, between requests, and any stop short of "every
// message in the window was read" returns `truncated: true`. Scanning is
// read-only everywhere: IMAP uses BODY.PEEK, Gmail format=metadata, Graph GET.
//
// ── Folders ─────────────────────────────────────────────────────────────────
// The inbox first, then the Junk/Spam folder with `inJunk: true` so the
// classifier can refuse to act on those senders. The inbox gets the limit
// first; Junk gets what is left.
//
// ── Message ids ─────────────────────────────────────────────────────────────
// The same opaque ids every other tool takes: "<folder>:<uid>" on IMAP (the
// format of index.ts's encodeImapId), the Gmail message id, and the Graph
// immutable id (graphFetch always asks for ImmutableId).
// ---------------------------------------------------------------------------

import { parseMailbox } from "./address-header.ts";
import type { WorkBudget } from "./bulk-budget.ts";
import { type ImapHeaderFieldsRow, ImapMessageTooLargeError, ImapSelectRefusedError } from "./imap-client.ts";
import { type AuthservTrust, type ListHeaderRecord, normalizeListId } from "./list-unsubscribe.ts";
import { getHeader, getHeaderAll, parseHeaders } from "./mime.ts";
import { graphErrorFromResponse } from "./outlook-graph.ts";
import { mapWithConcurrency } from "./provider-concurrency.ts";

/** The header fields a scan reads, in the order IMAP is asked for them. */
export const LIST_HEADER_FIELDS = [
  "From",
  "List-Id",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "DKIM-Signature",
  "Authentication-Results",
] as const;

/** UIDs per IMAP FETCH: one round trip each, small enough to stop on budget. */
export const IMAP_HEADER_FETCH_CHUNK = 250;

/** Concurrent Gmail metadata gets (Gmail 429s on too many per user). */
export const GMAIL_METADATA_CONCURRENCY = 8;

/** Concurrent Graph header gets (Graph documents four per app per mailbox). */
export const GRAPH_HEADER_CONCURRENCY = 4;

/** Most Graph header gets per scan: one per distinct sender, newest first. */
export const OUTLOOK_MAX_HEADER_GETS = 200;

export interface ScanOptions {
  /** Window in days, counted back from now. */
  days: number;
  /** Most messages read across all folders. */
  limit: number;
  /**
   * Provider folder names or ids to scan instead of the inbox plus Junk. A
   * folder equal to the context's junk folder is still flagged `inJunk`.
   */
  folders?: string[];
}

export interface ScanResult {
  records: ListHeaderRecord[];
  /** Messages whose headers were read (Outlook: messages listed). */
  scanned: number;
  /** True when anything in the window was left unread: limit, budget or provider pushback. */
  truncated: boolean;
  /**
   * The context's trusted authserv-ids, handed through for groupSenders.
   * Absent = trust nothing (every sender auth_unverified).
   */
  trust?: AuthservTrust;
}

/** The slice of ImapClient a scan uses; the real client satisfies it. */
export interface ScanImapClient {
  uidSearch(criteria: string): Promise<number[]>;
  fetchHeaderFields(
    uids: number[],
    fields: readonly string[],
    options?: { maxLiteralBytes?: number },
  ): Promise<ImapHeaderFieldsRow[]>;
}

interface ScanContextBase {
  budget: WorkBudget;
  /**
   * Which Authentication-Results headers this inbox's provider writes
   * (list-unsubscribe.ts authservTrustFor). Passed through on the result.
   */
  trust?: AuthservTrust;
  /** Clock for the `days` window; injectable for tests. */
  now?: () => number;
}

export interface ImapScanContext extends ScanContextBase {
  provider: "imap";
  /** SELECT a mailbox (verbatim server name) and return the client, e.g. ImapSession.select. */
  select(folder: string): Promise<ScanImapClient>;
  /** The inbox's server name; "INBOX" when omitted. */
  inboxFolder?: string;
  /** The Junk/Spam mailbox's server name, or null when the account has none. */
  junkFolder: string | null;
}

export interface GmailScanContext extends ScanContextBase {
  provider: "gmail";
  /** GET `https://gmail.googleapis.com/gmail/v1/users/me` + path, authorized. */
  fetch(path: string): Promise<Response>;
}

export interface OutlookScanContext extends ScanContextBase {
  provider: "outlook";
  /** graphFetch with a fresh token: a path under /v1.0 or an absolute nextLink. */
  fetch(pathOrUrl: string): Promise<Response>;
  /** Override {@link OUTLOOK_MAX_HEADER_GETS}. */
  maxHeaderGets?: number;
}

export type ListHeaderScanContext = ImapScanContext | GmailScanContext | OutlookScanContext;

/**
 * Read the list headers of the last `days` days of mail, up to `limit`
 * messages, inside `ctx.budget`. See the file header for the bounds.
 */
export function fetchListHeaderRecords(ctx: ListHeaderScanContext, opts: ScanOptions): Promise<ScanResult> {
  const limit = Math.max(0, Math.floor(opts.limit));
  const days = Math.max(1, Math.floor(opts.days));
  const sinceMs = (ctx.now ?? Date.now)() - days * 86_400_000;
  const run = ctx.provider === "imap"
    ? scanImap(ctx, limit, sinceMs, opts.folders)
    : ctx.provider === "gmail"
    ? scanGmail(ctx, limit, sinceMs, opts.folders)
    : scanOutlook(ctx, limit, sinceMs, opts.folders);
  return ctx.trust ? run.then((result) => ({ ...result, trust: ctx.trust })) : run;
}

// ── Shared ──────────────────────────────────────────────────────────────────

/** A raw header block (any provider's headers rendered as `Name: value` lines) as a record. */
export function recordFromHeaderBlock(
  block: string,
  meta: { messageId: string; folder: string; seen: boolean; receivedAt: string; inJunk: boolean },
): ListHeaderRecord {
  const headers = parseHeaders(block);
  return recordFromHeaderMap(headers, meta, "all");
}

function recordFromHeaderMap(
  headers: Map<string, string[]>,
  meta: { messageId: string; folder: string; seen: boolean; receivedAt: string; inJunk: boolean },
  nameDecoding: "all" | "none",
): ListHeaderRecord {
  const from = parseMailbox(getHeader(headers, "from") ?? "", nameDecoding);
  return {
    messageId: meta.messageId,
    folder: meta.folder,
    fromAddress: from.email.trim(),
    fromName: from.name,
    listId: normalizeListId(getHeader(headers, "list-id")),
    listUnsubscribe: getHeader(headers, "list-unsubscribe"),
    listUnsubscribePost: getHeader(headers, "list-unsubscribe-post"),
    dkimSignatures: getHeaderAll(headers, "dkim-signature"),
    authResults: getHeaderAll(headers, "authentication-results"),
    seen: meta.seen,
    receivedAt: meta.receivedAt,
    inJunk: meta.inJunk,
  };
}

/** `{ name, value }[]` (Gmail payload.headers, Graph internetMessageHeaders) as a header map, order kept. */
export function headerMapOfPairs(pairs: ReadonlyArray<{ name?: string; value?: string }> | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pair of pairs ?? []) {
    if (!pair?.name || typeof pair.value !== "string") continue;
    const key = pair.name.trim().toLowerCase();
    const list = out.get(key);
    if (list) list.push(pair.value);
    else out.set(key, [pair.value]);
  }
  return out;
}

const IMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `SINCE dd-Mon-yyyy` for a UTC instant (RFC 3501 date; servers compare by date only). */
export function imapSinceCriteria(sinceMs: number): string {
  const d = new Date(sinceMs);
  return `SINCE ${d.getUTCDate()}-${IMAP_MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// ── IMAP ────────────────────────────────────────────────────────────────────

async function scanImap(
  ctx: ImapScanContext,
  limit: number,
  sinceMs: number,
  folders: string[] | undefined,
): Promise<ScanResult> {
  const inbox = ctx.inboxFolder ?? "INBOX";
  const plan = folders && folders.length > 0
    ? folders.map((f) => ({ folder: f, inJunk: f === ctx.junkFolder }))
    : [{ folder: inbox, inJunk: false }, ...(ctx.junkFolder ? [{ folder: ctx.junkFolder, inJunk: true }] : [])];

  const records: ListHeaderRecord[] = [];
  let scanned = 0;
  let truncated = false;
  for (const { folder, inJunk } of plan) {
    if (scanned >= limit || ctx.budget.exhausted()) {
      truncated = true;
      break;
    }
    let client: ScanImapClient;
    try {
      client = await ctx.select(folder);
    } catch (err) {
      // A Junk folder the server will not open costs the junk flags, not the
      // scan. Anything else (a dead socket) still fails the call.
      const refused = err instanceof ImapSelectRefusedError ||
        (err instanceof Error && err.message.startsWith("Mailbox not found:"));
      if (inJunk && refused) continue;
      throw err;
    }
    // SINCE is by date, without time: the date boundary is filtered again on
    // INTERNALDATE below.
    const found = await client.uidSearch(imapSinceCriteria(sinceMs));
    // Highest UID first: newest arrivals, as the listing orders them.
    const uids = [...new Set(found)].sort((a, b) => b - a);
    const take = uids.slice(0, limit - scanned);
    if (take.length < uids.length) truncated = true;
    for (let i = 0; i < take.length; i += IMAP_HEADER_FETCH_CHUNK) {
      if (ctx.budget.exhausted()) {
        truncated = true;
        break;
      }
      const chunk = take.slice(i, i + IMAP_HEADER_FETCH_CHUNK);
      let rows: ImapHeaderFieldsRow[];
      try {
        rows = await client.fetchHeaderFields(chunk, LIST_HEADER_FIELDS);
      } catch (err) {
        // One outsized header block fails its whole FETCH, with the socket
        // left aligned: skip that chunk and say the scan is incomplete.
        if (err instanceof ImapMessageTooLargeError) {
          truncated = true;
          continue;
        }
        throw err;
      }
      for (const row of rows) {
        scanned++;
        const receivedAt = row.internalDate ?? new Date(0).toISOString();
        if (row.internalDate && Date.parse(row.internalDate) < sinceMs) continue;
        records.push(recordFromHeaderBlock(row.headers, {
          messageId: `${folder}:${row.uid}`,
          folder,
          seen: row.flags.includes("\\Seen"),
          receivedAt,
          inJunk,
        }));
      }
    }
  }
  return { records, scanned, truncated };
}

// ── Gmail ───────────────────────────────────────────────────────────────────

/** The subset of a Gmail `format=metadata` message this scan reads. */
export interface GmailMetadataMessage {
  id?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

/** A Gmail metadata message as a record, or null without an id. */
export function recordFromGmailMessage(msg: GmailMetadataMessage): ListHeaderRecord | null {
  if (!msg.id) return null;
  const labels = msg.labelIds ?? [];
  const inJunk = labels.includes("SPAM");
  const ms = Number(msg.internalDate);
  // Gmail hands header values back already decoded, so the display name is
  // not decoded a second time.
  return recordFromHeaderMap(headerMapOfPairs(msg.payload?.headers), {
    messageId: msg.id,
    folder: inJunk ? "SPAM" : "INBOX",
    seen: !labels.includes("UNREAD"),
    receivedAt: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString(),
    inJunk,
  }, "none");
}

async function gmailError(resp: Response, context: string): Promise<Error> {
  if (resp.status === 401) {
    await resp.body?.cancel().catch(() => {});
    return new Error("gmail_auth_failed");
  }
  let message = resp.statusText;
  try {
    const body = (await resp.json()) as { error?: { message?: string } };
    message = body.error?.message ?? message;
  } catch {
    // Keep the status text.
  }
  return new Error(`Gmail API error (${context}): ${message}`);
}

async function scanGmail(
  ctx: GmailScanContext,
  limit: number,
  sinceMs: number,
  folders: string[] | undefined,
): Promise<ScanResult> {
  const labels = folders && folders.length > 0 ? folders : ["INBOX", "SPAM"];
  const ids: string[] = [];
  let truncated = false;
  for (const label of labels) {
    let pageToken: string | undefined;
    do {
      if (ids.length >= limit || ctx.budget.exhausted()) {
        truncated = true;
        break;
      }
      const params = new URLSearchParams({
        labelIds: label,
        q: `after:${Math.floor(sinceMs / 1000)}`,
        maxResults: String(Math.min(500, limit - ids.length)),
      });
      if (label === "SPAM" || label === "TRASH") params.set("includeSpamTrash", "true");
      if (pageToken) params.set("pageToken", pageToken);
      const resp = await ctx.fetch(`/messages?${params}`);
      if (!resp.ok) throw await gmailError(resp, "list");
      const data = (await resp.json()) as { messages?: { id: string }[]; nextPageToken?: string };
      for (const m of data.messages ?? []) if (m?.id) ids.push(m.id);
      pageToken = data.nextPageToken;
      if (pageToken && ids.length >= limit) truncated = true;
    } while (pageToken && ids.length < limit);
  }
  const wanted = [...new Set(ids)].slice(0, limit);

  let stop = false;
  const metadataQuery = new URLSearchParams({ format: "metadata" });
  for (const h of LIST_HEADER_FIELDS) metadataQuery.append("metadataHeaders", h);
  const results = await mapWithConcurrency(wanted, GMAIL_METADATA_CONCURRENCY, async (id) => {
    if (stop || ctx.budget.exhausted()) {
      stop = true;
      return null;
    }
    const resp = await ctx.fetch(`/messages/${encodeURIComponent(id)}?${metadataQuery}`);
    if (resp.status === 401) throw await gmailError(resp, "metadata");
    if (!resp.ok) {
      // Rate limited or failing: stop issuing more and report a partial scan.
      // A single message that vanished (404) is just skipped.
      if (resp.status === 429 || resp.status >= 500) stop = true;
      await resp.body?.cancel().catch(() => {});
      return resp.status === 404 ? undefined : null;
    }
    return recordFromGmailMessage((await resp.json()) as GmailMetadataMessage) ?? undefined;
  });
  const records: ListHeaderRecord[] = [];
  let scanned = 0;
  for (const r of results) {
    if (r === null) truncated = true;
    else if (r !== undefined) {
      scanned++;
      records.push(r);
    }
  }
  return { records, scanned, truncated };
}

// ── Outlook (Graph) ─────────────────────────────────────────────────────────

interface GraphListMessage {
  id?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  isRead?: boolean;
}

/** A Graph list row as a record with no headers yet, or null without id/sender. */
export function recordFromGraphListMessage(msg: GraphListMessage, folder: string, inJunk: boolean): ListHeaderRecord | null {
  const address = msg.from?.emailAddress?.address?.trim() ?? "";
  if (!msg.id || !address) return null;
  return {
    messageId: msg.id,
    folder,
    fromAddress: address,
    fromName: msg.from?.emailAddress?.name ?? "",
    listId: null,
    listUnsubscribe: null,
    listUnsubscribePost: null,
    dkimSignatures: [],
    authResults: [],
    seen: msg.isRead ?? true,
    receivedAt: msg.receivedDateTime ?? new Date(0).toISOString(),
    inJunk,
  };
}

/**
 * Fill one record from a Graph `internetMessageHeaders` array, in place. The
 * Graph From (already decoded, from the list) is kept; only the list and
 * authentication headers are read from the internet headers.
 */
export function applyGraphHeaders(
  record: ListHeaderRecord,
  headers: ReadonlyArray<{ name?: string; value?: string }> | undefined,
): void {
  const map = headerMapOfPairs(headers);
  record.listId = normalizeListId(getHeader(map, "list-id"));
  record.listUnsubscribe = getHeader(map, "list-unsubscribe");
  record.listUnsubscribePost = getHeader(map, "list-unsubscribe-post");
  record.dkimSignatures = getHeaderAll(map, "dkim-signature");
  record.authResults = getHeaderAll(map, "authentication-results");
}

/**
 * Copy the newest record's list id to the sender's other records, so they
 * group under the same `list:` key (see `ListHeaderRecord.headersInferred`).
 * Only the list id is copied: classification reads the unsubscribe headers
 * from the record that actually carried them.
 */
export function propagateListIds(records: ListHeaderRecord[], fetched: Map<string, ListHeaderRecord>): void {
  for (const record of records) {
    const source = fetched.get(record.fromAddress.toLowerCase());
    if (!source || source === record || !source.listId) continue;
    record.listId = source.listId;
    record.headersInferred = true;
  }
}

async function scanOutlook(
  ctx: OutlookScanContext,
  limit: number,
  sinceMs: number,
  folders: string[] | undefined,
): Promise<ScanResult> {
  const plan = folders && folders.length > 0
    ? folders.map((f) => ({ folder: f, inJunk: f.toLowerCase() === "junkemail" }))
    : [{ folder: "inbox", inJunk: false }, { folder: "junkemail", inJunk: true }];
  const sinceIso = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z");

  const records: ListHeaderRecord[] = [];
  let truncated = false;
  for (const { folder, inJunk } of plan) {
    const label = inJunk ? "Junk" : folder === "inbox" ? "INBOX" : folder;
    const params = new URLSearchParams({
      $select: "id,from,receivedDateTime,isRead",
      $filter: `receivedDateTime ge ${sinceIso}`,
      $orderby: "receivedDateTime desc",
      $top: String(Math.max(1, Math.min(500, limit - records.length))),
    });
    let next: string | undefined = `/me/mailFolders/${encodeURIComponent(folder)}/messages?${params}`;
    while (next) {
      if (records.length >= limit || ctx.budget.exhausted()) {
        truncated = true;
        break;
      }
      const resp = await ctx.fetch(next);
      if (!resp.ok) {
        // A mailbox with no Junk folder (404) is not an error worth failing on.
        if (inJunk && resp.status === 404) {
          await resp.body?.cancel().catch(() => {});
          break;
        }
        throw await graphErrorFromResponse(resp, "Outlook subscription scan");
      }
      const data = (await resp.json()) as { value?: GraphListMessage[]; "@odata.nextLink"?: string };
      for (const msg of data.value ?? []) {
        if (records.length >= limit) {
          truncated = true;
          break;
        }
        const r = recordFromGraphListMessage(msg, label, inJunk);
        if (r) records.push(r);
      }
      next = data["@odata.nextLink"];
      if (next && records.length >= limit) {
        truncated = true;
        next = undefined;
      }
    }
  }
  const scanned = records.length;

  // Newest message per distinct sender (records are newest first per folder;
  // the inbox is listed first, so an inbox copy wins over a Junk copy).
  const newestBySender = new Map<string, ListHeaderRecord>();
  for (const r of records) {
    const key = r.fromAddress.toLowerCase();
    const seen = newestBySender.get(key);
    if (!seen || (seen.inJunk && !r.inJunk) || (seen.inJunk === r.inJunk && Date.parse(r.receivedAt) > Date.parse(seen.receivedAt))) {
      newestBySender.set(key, r);
    }
  }
  const cap = Math.max(0, ctx.maxHeaderGets ?? OUTLOOK_MAX_HEADER_GETS);
  // Senders with the most mail first: they are the ones a cleanup is for.
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.fromAddress.toLowerCase(), (counts.get(r.fromAddress.toLowerCase()) ?? 0) + 1);
  const targets = [...newestBySender.entries()].sort((a, b) => (counts.get(b[0]) ?? 0) - (counts.get(a[0]) ?? 0));
  if (targets.length > cap) truncated = true;

  let stop = false;
  const fetched = new Map<string, ListHeaderRecord>();
  await mapWithConcurrency(targets.slice(0, cap), GRAPH_HEADER_CONCURRENCY, async ([key, record]) => {
    if (stop || ctx.budget.exhausted()) {
      stop = true;
      truncated = true;
      return;
    }
    const resp = await ctx.fetch(`/me/messages/${encodeURIComponent(record.messageId)}?$select=internetMessageHeaders`);
    if (!resp.ok) {
      if (resp.status === 401) throw await graphErrorFromResponse(resp, "Outlook subscription scan");
      if (resp.status === 429 || resp.status >= 500) stop = true;
      truncated = true;
      await resp.body?.cancel().catch(() => {});
      return;
    }
    const data = (await resp.json()) as { internetMessageHeaders?: { name?: string; value?: string }[] };
    applyGraphHeaders(record, data.internetMessageHeaders);
    fetched.set(key, record);
  });
  propagateListIds(records, fetched);
  return { records, scanned, truncated };
}
