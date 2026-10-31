// ---------------------------------------------------------------------------
// Finding the original of a held rule forward, however long it waited.
//
// A rule forward can wait up to 7 days for a person. In that time the message
// may be filed, deleted or replaced, and the provider id stored on the approval
// is not a stable name for it: an IMAP id holds the folder, and a Graph id may
// change on a move. What is stable is the message's own Message-ID header.
//
// THE RULE: send the message that was queued, or send nothing.
//   * The stored id still answers with the same message: use it.
//   * Otherwise search every folder by Message-ID. Exactly one match that also
//     has the same sender and subject is the message, wherever it went.
//   * Two or more matches, no match, or one match that reads differently: refuse.
//
// Sender and subject are checked because a Message-ID is written by the sender.
// A later message carrying a copied id must not be taken for the original.
//
// Provider calls live behind OriginalLookup (index.ts); a thrown error means the
// mailbox could not answer, which the caller must not read as "not there".
//
// Run: deno test supabase/functions/mcp-server/original-locator.test.ts
// ---------------------------------------------------------------------------

/** Stored in the approval's encrypted payload when the forward is queued. */
export interface OriginalRef {
  rfc_message_id: string;
  from: string | null;
  subject: string | null;
}

/** What a provider says about one message. */
export interface OriginalFacts {
  rfc_message_id: string | null;
  from: string | null;
  subject: string | null;
}

export interface OriginalMatch extends OriginalFacts {
  id: string;
}

export interface OriginalLookup {
  /** The message under this provider id, or null when the id no longer answers. */
  read(messageId: string): Promise<OriginalFacts | null>;
  /** Every message in the mailbox with this Message-ID, in any folder. */
  search(rfcMessageId: string): Promise<OriginalMatch[]>;
}

export type OriginalLocation =
  | { kind: "found"; id: string; moved: boolean }
  | { kind: "ambiguous" }
  | { kind: "gone" };

/** What the dispatcher writes to `scheduled_sends.error_detail` for a refusal. */
export const ORIGINAL_NOT_FOUND_CODE = "original_not_found";
export const ORIGINAL_AMBIGUOUS_CODE = "original_ambiguous";
/** A ledger row says an attempt may have gone out, so it is not tried again. */
export const DELIVERY_UNCERTAIN_CODE = "delivery_uncertain";

const normalize = (value: string | null | undefined): string =>
  (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

function sameMessage(ref: OriginalRef, facts: OriginalFacts): boolean {
  return normalize(facts.rfc_message_id) === normalize(ref.rfc_message_id) &&
    normalize(facts.from) === normalize(ref.from) &&
    normalize(facts.subject) === normalize(ref.subject);
}

/** Reads an `original_ref` back out of a stored payload. Anything else is null. */
export function parseOriginalRef(value: unknown): OriginalRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.rfc_message_id !== "string" || v.rfc_message_id.length === 0) return null;
  return {
    rfc_message_id: v.rfc_message_id,
    from: typeof v.from === "string" ? v.from : null,
    subject: typeof v.subject === "string" ? v.subject : null,
  };
}

/**
 * Where the queued message is now. `ref` is null on a forward queued before refs
 * were recorded, or whose message had no Message-ID: all that can be done then is
 * to use the stored id if it still answers, and refuse if it does not.
 */
export async function locateOriginal(
  storedId: string,
  ref: OriginalRef | null,
  lookup: OriginalLookup,
): Promise<OriginalLocation> {
  const atStoredId = await lookup.read(storedId);
  if (!ref) return atStoredId ? { kind: "found", id: storedId, moved: false } : { kind: "gone" };
  if (atStoredId && sameMessage(ref, atStoredId)) return { kind: "found", id: storedId, moved: false };

  const matches = await lookup.search(ref.rfc_message_id);
  const distinct = new Map(matches.map((match) => [match.id, match]));
  if (distinct.size > 1) return { kind: "ambiguous" };
  const [only] = distinct.values();
  if (!only || !sameMessage(ref, only)) return { kind: "gone" };
  return { kind: "found", id: only.id, moved: only.id !== storedId };
}

/**
 * The server-derived ledger key of an approved rule forward. One per approval: the
 * provider id is left out on purpose, because it may change on a move.
 */
export function ruleForwardLedgerKey(approvalId: string): string {
  return `approved-rule-forward:${approvalId}`;
}

/**
 * What an existing ledger row means for this dispatch. "succeeded" went out
 * already. Anything else is a send whose outcome is not known to be "nothing was
 * sent", because a provable non-send releases the row. So it is never retried.
 */
export function replayOutcome(status: string): "already_sent" | "uncertain" {
  return status === "succeeded" ? "already_sent" : "uncertain";
}
