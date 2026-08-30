// ---------------------------------------------------------------------------
// Conflicting inbox selectors.
//
// ── The problem this exists to solve ────────────────────────────────────────
// Every inbox-bound tool takes `inbox_id` (a UUID, or an address) and `inbox`
// (an address). The documented rule was "inbox_id wins when both are given",
// and the resolver implemented exactly that: passing one inbox's id together
// with a DIFFERENT inbox's address returned the id's mailbox, silently, with
// nothing in the response naming the address that had been discarded.
//
// That precedence is defensible right up until the two disagree. The way a
// mismatched pair actually arises is a model carrying a stale `inbox_id` from
// earlier in a conversation while writing the address the user just named — so
// the argument the user can see is the one that gets ignored, and the tool
// reads (or worse, sends from) a mailbox nobody asked for. The failure is
// silent on both sides: the caller believes it addressed the account it named,
// and the response looks completely normal.
//
// Two selectors that disagree are not a precedence question, they are a
// caller bug. Refusing is cheap, and the refusal can say exactly what
// conflicted, which is more than the caller could work out on its own.
//
// ── Scope ──────────────────────────────────────────────────────────────────
// Only the BOTH-given case changes. One selector alone, or a pair that
// resolves to the same inbox, behaves exactly as before — including the case
// where `inbox_id` carries an address rather than a UUID, which the resolver
// has always accepted.
// ---------------------------------------------------------------------------

/** The minimum an inbox row needs for selector matching and for the message. */
export interface SelectorInbox {
  id: string;
  email_address: string;
}

/**
 * Everything the error needs to name BOTH sides of the disagreement. The
 * caller sent two values; a refusal that echoed only one of them would leave
 * the model guessing which of its own arguments to drop.
 */
export interface InboxSelectorConflict {
  inbox_id: string;
  inbox: string;
  resolved_from_inbox_id: SelectorInbox;
  resolved_from_inbox: SelectorInbox;
}

export type InboxSelectorOutcome =
  /** Zero or one selector given, or both agree: resolution proceeds as before. */
  | { kind: "ok"; inbox: SelectorInbox | null }
  /** A selector named nothing this key can reach. Pre-existing behaviour. */
  | { kind: "not_found" }
  /** Both given, both resolved, and they are different mailboxes. */
  | { kind: "conflict"; conflict: InboxSelectorConflict };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves one raw selector against a known set of inboxes, using the same
 * rules the server's database resolver uses: a UUID matches `id`, anything
 * containing `@` matches `email_address` case-insensitively, and nothing else
 * matches at all.
 *
 * The live resolver queries Postgres rather than a list, so this is the
 * in-memory mirror of it — used directly by the tests, and by any caller that
 * already holds the accessible inboxes.
 */
export function findInboxBySelector(
  raw: string,
  known: readonly SelectorInbox[],
): SelectorInbox | null {
  const value = raw.trim();
  if (!value) return null;
  if (UUID_RE.test(value)) {
    return known.find((ib) => ib.id.toLowerCase() === value.toLowerCase()) ?? null;
  }
  if (value.includes("@")) {
    return known.find(
      (ib) => ib.email_address.toLowerCase() === value.toLowerCase(),
    ) ?? null;
  }
  return null;
}

/**
 * The conflict decision itself, given the two raw selectors and what each of
 * them resolved to (`null` when a selector matched no reachable inbox).
 *
 * This is the function the live resolver calls, after it has done its two
 * database lookups. It is deliberately ignorant of HOW the lookups happened so
 * that the rule is stated in exactly one place.
 *
 * Ordering note: an unresolvable `inbox_id` still reports `not_found`, and it
 * reports it BEFORE the address is considered, so the pre-existing error for a
 * bad id is unchanged rather than being reclassified as a conflict.
 */
export function inboxSelectorOutcome(
  rawInboxId: string,
  rawInbox: string,
  fromInboxId: SelectorInbox | null,
  fromInbox: SelectorInbox | null,
): InboxSelectorOutcome {
  const id = rawInboxId.trim();
  const address = rawInbox.trim();

  if (id && !fromInboxId) return { kind: "not_found" };
  if (address && !fromInbox) return { kind: "not_found" };

  if (id && address && fromInboxId && fromInbox) {
    if (fromInboxId.id !== fromInbox.id) {
      return {
        kind: "conflict",
        conflict: {
          inbox_id: id,
          inbox: address,
          resolved_from_inbox_id: fromInboxId,
          resolved_from_inbox: fromInbox,
        },
      };
    }
  }

  return { kind: "ok", inbox: fromInboxId ?? fromInbox ?? null };
}

/**
 * Resolve-and-check in one step against a known inbox set.
 *
 * The composed form of the two functions above: it is what the tests drive,
 * and what a caller with the full list in hand should use.
 */
export function checkInboxSelectors(
  rawInboxId: string,
  rawInbox: string,
  known: readonly SelectorInbox[],
): InboxSelectorOutcome {
  return inboxSelectorOutcome(
    rawInboxId,
    rawInbox,
    findInboxBySelector(rawInboxId, known),
    findInboxBySelector(rawInbox, known),
  );
}

/**
 * The agent-facing refusal text.
 *
 * Names both arguments and both mailboxes, because the whole point of the
 * error is that the caller cannot see which of its two values was being
 * discarded. Ends with the one instruction that resolves it: send one.
 */
export function inboxSelectorConflictMessage(
  conflict: InboxSelectorConflict,
): string {
  return (
    "inbox_id and inbox name different inboxes, so this call was refused " +
    "rather than guessing which one you meant. " +
    `inbox_id "${conflict.inbox_id}" is ${conflict.resolved_from_inbox_id.email_address} ` +
    `(inbox_id: ${conflict.resolved_from_inbox_id.id}); ` +
    `inbox "${conflict.inbox}" is ${conflict.resolved_from_inbox.email_address} ` +
    `(inbox_id: ${conflict.resolved_from_inbox.id}). ` +
    "Retry with only the one you want — pass inbox_id alone, or inbox alone. " +
    "A stale inbox_id carried over from an earlier call is the usual cause."
  );
}
