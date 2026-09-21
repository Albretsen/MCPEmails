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
//
// ── The AGREEING pair: accepted, in silence, and why (2026-09-20) ───────────
// A live functional test called
//
//     folder_list {inbox: "bjellanda@gmail.com", inbox_id: "1245c938-…"}
//
// — both selectors, same mailbox — and got its folders back with nothing said,
// even though every `inbox_id` description on the surface reads "pass this or
// `inbox`, not both". That left the rule looking unenforced and the precedence
// looking untested, so it is worth writing down that this outcome is the
// decision rather than the omission.
//
// Classified against the IGNORABLE / MISPLACED line that consolidated-
// arguments.ts draws, a redundant selector is IGNORABLE, and by a stronger test
// than the one used there. That module can only ask whether an argument's value
// equals the published schema's absence-equivalent default — a judgement made
// before the call, from the schema alone. Here the server has done both lookups
// and holds proof: the two selectors named the SAME inbox row, so dropping
// either one provably could not have changed which mailbox was touched. There
// is no unapplied instruction to disclose, because nothing went unapplied.
//
// Disclosing it anyway would mean a result note on every call a model makes
// when it helpfully sends both — a fact-free sentence on a correct call, which
// is precisely the noise that makes a result note stop being read on the calls
// that do carry one. The disclosure mechanism (result-notes.ts) is reserved for
// what it was built for: an instruction the server did NOT carry out.
//
// The disagreeing pair is the opposite in every respect — the selectors assert
// different mailboxes, one of them is going to be discarded, and the call is a
// write as often as not — so it is refused above. `redundant` on the `ok`
// outcome records that the server saw the duplicate and chose to say nothing,
// so the choice is visible, testable, and reversible by a caller that ever
// wants to disclose it.
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
  | {
      kind: "ok";
      inbox: SelectorInbox | null;
      /**
       * Both selectors were given and both named THIS inbox.
       *
       * Accepted without a word — see the header for the reasoning. Carried on
       * the outcome so that "we noticed and said nothing" is a fact a test can
       * assert, rather than an absence nobody can tell apart from an oversight.
       */
      redundant: boolean;
    }
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

  const bothGiven = !!(id && address && fromInboxId && fromInbox);
  if (bothGiven && fromInboxId!.id !== fromInbox!.id) {
    return {
      kind: "conflict",
      conflict: {
        inbox_id: id,
        inbox: address,
        resolved_from_inbox_id: fromInboxId!,
        resolved_from_inbox: fromInbox!,
      },
    };
  }

  // Reaching here with `bothGiven` means the pair agreed: two names for one
  // mailbox, nothing discarded, nothing to report. See the header.
  return { kind: "ok", inbox: fromInboxId ?? fromInbox ?? null, redundant: bothGiven };
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
