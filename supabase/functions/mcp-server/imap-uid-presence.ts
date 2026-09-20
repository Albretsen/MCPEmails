// ---------------------------------------------------------------------------
// imap-uid-presence.ts — does the message this mutation names actually exist?
//
// The live functional test against a real Gmail-over-IMAP mailbox on
// 2026-09-20 (finding F-09) asked the server to delete and to move message ids
// that had never existed, and the server said yes to every one of them:
//
//   email_delete   {action:"delete", message_id:"INBOX:99999999"}
//     → {"success":true,"message_id":"INBOX:99999999","operation":"email_delete"}
//   email_delete   {action:"delete_batch", message_ids:["INBOX:77777777","INBOX:66666666"]}
//     → {"succeeded":2,"failed":0, results:[{...success:true},{...success:true}]}
//   email_organize {action:"move", message_id:"INBOX:55555555", ...}
//     → {"success":true,"operation":"email_move",
//        "provider_semantics":"Relocated the message to the destination folder."}
//
// Nothing was deleted and nothing was moved, because none of those messages
// were there. The ROOT CAUSE is a property of the protocol rather than a typo
// in any one handler: RFC 3501's UID commands are set-addressed, and a UID set
// that matches zero messages is not an error. "UID STORE 99999999 +FLAGS
// (\\Deleted)", "UID COPY 55555555 Archive" and "UID MOVE 77777777 Trash" each
// come back a tagged OK having done nothing at all, and every one of those
// call sites treated "the command did not throw" as "the message was acted
// on". A tagged OK is the server saying it understood the request, not that
// the request found anything.
//
// WHY THIS IS NOT AN EDGE CASE. On IMAP a UID is per-folder and is reassigned
// the moment a message crosses a folder boundary, so a move invalidates the id
// it was given. During that same test run one message's id changed FOUR times
// as it was moved around. A stale id is the ordinary shape of this traffic,
// not a malformed-input curiosity, and a destructive tool that confirms a
// delete it never performed is the worst way to meet it: the agent stops
// looking, and the mail is still sitting in the inbox.
//
// The READ side already got this right — `email_read` action 'read_batch'
// answers a bogus id with MESSAGE_NOT_FOUND_DETAIL — so the vocabulary and the
// taxonomy already existed; only the mutation side was missing the question.
// This module is that question, and nothing else: `UID SEARCH UID <set>`
// against the SELECTed mailbox, answered with the subset that is really there.
//
// SEARCH, not FETCH, and this matters for the one behaviour that must NOT
// change. IMAP SEARCH has no implicit UNDELETED, so a message already flagged
// \\Deleted and not yet expunged still comes back present — which keeps
// re-deleting an already-trashed message the honest idempotent no-op it has
// always been, and distinguishes it from an id for a message that is gone. A
// probe that treated "already deleted" as "not found" would trade one wrong
// answer for another.
//
// It lives in its own module because index.ts cannot be imported by a test (it
// calls `Deno.serve` and builds a service-role client at module load), and
// "a nonexistent id is reported as not found" is precisely the property that
// went unnoticed for want of a test. Every dependency is an injected
// interface, so the whole thing is exercised without a mailbox.
// ---------------------------------------------------------------------------

import { toUidSet } from "./imap-client.ts";
import { MESSAGE_NOT_FOUND } from "./message-id-errors.ts";

/**
 * The one method of {@link ImapClient} this probe needs.
 *
 * Narrowed to a structural interface rather than taking the client so a test
 * can answer the probe from a literal array, and so nothing here can reach for
 * a second command and quietly widen the cost of a check that runs on every
 * mutating call.
 */
export interface UidSearcher {
  uidSearch(criteria: string): Promise<number[]>;
}

/**
 * The SEARCH criteria that asks the SELECTed mailbox which of these UIDs it
 * holds.
 *
 * `UID <set>` is the whole query on purpose. No UNDELETED, no date window, no
 * flag terms: the question is existence and only existence, and every extra
 * term is another way for the answer to mean something subtly different from
 * "the message the caller named is here" (see the header on why \\Deleted in
 * particular must stay visible).
 */
export function uidPresenceCriteria(uids: number[]): string {
  return `UID ${toUidSet(uids)}`;
}

/**
 * Which of `uids` the SELECTed mailbox actually holds.
 *
 * The result is intersected with what was asked for, so a server that answers
 * a UID set more generously than it was asked (or ignores the criteria and
 * returns the mailbox) cannot make an id that was never requested look
 * present. The intersection can only ever shrink the set, so it is safe in the
 * direction that matters: it cannot invent a message to act on.
 *
 * A failed SEARCH throws rather than returning an empty set. That is
 * deliberate and it is the difference between the two honest answers and the
 * dishonest one: "not found" is a claim about the mailbox, and we are only
 * entitled to make it when the mailbox answered. A probe that swallowed its
 * own failure would turn a transient read error into a permanent-sounding
 * "the message may have been deleted", sending the caller to re-list a mailbox
 * that was never the problem.
 */
export async function presentUids(
  searcher: UidSearcher,
  uids: number[],
): Promise<Set<number>> {
  if (uids.length === 0) return new Set();
  const found = await searcher.uidSearch(uidPresenceCriteria(uids));
  const asked = new Set(uids);
  return new Set(found.filter((uid) => asked.has(uid)));
}

/**
 * Guard for the single-message mutation paths: throw the not-found sentinel
 * unless the message is really there.
 *
 * {@link MESSAGE_NOT_FOUND} rather than a fresh error string because that
 * sentinel is already a wire value in three contracts — `handleFlagError`
 * renders it as the same sentence `email_read` has always used for a stale id,
 * `formatBulkResult` groups on it, and `activity_log.error_code` reports it —
 * and inventing a second spelling for this condition is how the Gmail 400 case
 * managed to be known in one handler and unknown in four (see
 * message-id-errors.ts).
 */
export async function assertUidPresent(
  searcher: UidSearcher,
  uid: number,
): Promise<void> {
  const present = await presentUids(searcher, [uid]);
  if (!present.has(uid)) throw new Error(MESSAGE_NOT_FOUND);
}

/**
 * Split a folder group's items into the ones the mailbox holds and the ones it
 * does not, preserving the caller's order in both halves.
 *
 * Order is preserved for the same reason `groupImapIdsByFolder` preserves it:
 * a bulk result is read alongside the list that was sent, and a `results[]`
 * that reorders the caller's ids makes a partial run illegible.
 */
export function splitByPresence<T extends { uid: number }>(
  items: readonly T[],
  present: ReadonlySet<number>,
): { present: T[]; missing: T[] } {
  const found: T[] = [];
  const missing: T[] = [];
  for (const item of items) {
    if (present.has(item.uid)) found.push(item);
    else missing.push(item);
  }
  return { present: found, missing };
}
