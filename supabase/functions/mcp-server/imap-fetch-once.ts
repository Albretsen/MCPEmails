// ---------------------------------------------------------------------------
// One download per message per tool call.
//
// ── What this is for ────────────────────────────────────────────────────────
// email_attachment reads its message twice by design: pass 1 lists the
// attachments without encoding any of them (encoding all of them is what used
// to kill the isolate), pass 2 encodes the one that was asked for. On Gmail
// and Outlook pass 2 fetches just that file. On IMAP both passes went through
// `readImapMessage`, and each one opened a connection, authenticated, SELECTed
// and downloaded the WHOLE raw message, attachments included: two handshakes
// and two full downloads to return one file. Measured 2026-10-02 at p50 8.4 s
// against 2.3 s for email_read, which does the same work once.
//
// The handler now hands both passes one map. Pass 1 puts the raw message in
// it; pass 2 finds it there and never touches the network, so the second
// connection is not opened at all.
//
// ── What this is NOT ────────────────────────────────────────────────────────
// It is not a cache. The product promises that nothing read from a mailbox is
// kept, and nothing is: the map is a local variable of ONE tool call, created
// by the handler and unreachable once the handler returns. There is no
// module-level state here, and nothing is shared between calls, sessions,
// inboxes or keys. A handler that does not pass a map gets exactly the old
// behaviour, which is every handler except email_attachment's.
//
// The parser is untouched. Pass 2 parses the very bytes pass 1 downloaded, so
// what it returns is what a second download would have returned: a stored
// message does not change under its id (index.ts already relies on that to
// reuse the size pass 1 measured).
// ---------------------------------------------------------------------------

import type { ImapRawMessage } from "./imap-client.ts";

/** Raw messages already downloaded by the tool call that owns this map. */
export type ImapFetchedThisCall = Map<string, ImapRawMessage>;

/**
 * The raw message for `messageId`: from `kept` when this call has already
 * downloaded it, otherwise fetched on the client `select` yields.
 *
 * `select` is only called on a miss, so a hit costs no connection, no SELECT
 * and no FETCH. `client` is the one that did the fetch, or null on a hit (the
 * caller selects for itself if it still needs one). A message the server does
 * not have is null and is not remembered.
 */
export async function imapRawMessageOnce<
  C extends { fetchMessageRaw(uid: number): Promise<ImapRawMessage | null> },
>(
  kept: ImapFetchedThisCall | undefined,
  messageId: string,
  uid: number,
  select: () => Promise<C>,
): Promise<{ message: ImapRawMessage | null; client: C | null }> {
  const already = kept?.get(messageId);
  if (already) return { message: already, client: null };
  const client = await select();
  const message = await client.fetchMessageRaw(uid);
  if (message) kept?.set(messageId, message);
  return { message, client };
}
