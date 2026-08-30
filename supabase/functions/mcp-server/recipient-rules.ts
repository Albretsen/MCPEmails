// ---------------------------------------------------------------------------
// recipient-rules.ts - who a message is actually addressed to, decided before
// anything is transmitted.
//
// Two questions used to be answered inline, once per provider, and the copies
// had drifted apart. Both were found in production on 2026-08-30:
//
//   F6  draft_send transmitted a draft with NO recipients. The draft path had
//       substituted the account's own address into the stored MIME at
//       draft_create time, so by send time the "recipientless" draft looked
//       addressed and went out to the account owner. email_send refuses the
//       same input pre-flight ("to must contain at least 1 items"), so the two
//       send paths disagreed about the same message. Where the mail lands must
//       never be left to whatever the provider decides to do with an empty
//       recipient set: it is benign on Gmail and undefined everywhere else.
//
//   F7  A reply to SELF-ADDRESSED mail failed. The reply paths build the
//       recipient set by removing the account's own address, which for a
//       note-to-self (From and To both the account) leaves nothing, and the
//       error then blamed the source message's headers, which were fine. A
//       mail client replies to yourself here, and one of the three reply paths
//       (email_compose reply without reply_all) already did, so the other two
//       were simply wrong.
//
// Everything here is PURE: no I/O, no provider clients, no imports. That is
// what lets the six call sites in index.ts share ONE answer, and lets the
// answer be tested without a mailbox. See recipient-rules.test.ts.
// ---------------------------------------------------------------------------

/** A parsed address. `name` is the display name, absent or empty when bare. */
export interface RecipientAddress {
  name?: string;
  email: string;
}

/** Reply-all fans out to everyone on the thread; this is the ceiling. */
export const REPLY_RECIPIENT_LIMIT = 50;

// ── Address extraction ──────────────────────────────────────────────────────

/**
 * The mailbox part of one header entry, or "" when the entry carries no usable
 * address at all.
 *
 * Deliberately permissive about what an address may look like (no dot required
 * in the domain, so `root@localhost` survives) and strict about the two things
 * that would make a send meaningless: a missing local part or a missing domain.
 * Whitespace-only entries, bare display names and `<>` all collapse to "".
 */
export function extractAddress(entry: string | null | undefined): string {
  if (typeof entry !== "string") return "";
  const trimmed = entry.trim();
  if (!trimmed) return "";
  const angle = trimmed.match(/<([^>]*)>/);
  const candidate = (angle ? angle[1] : trimmed).trim();
  if (!candidate || /[\s,;]/.test(candidate)) return "";
  const at = candidate.indexOf("@");
  if (at <= 0 || at !== candidate.lastIndexOf("@") || at === candidate.length - 1) {
    return "";
  }
  return candidate;
}

/** Lower-cased set of the addresses this inbox sends as. */
export function ownAddressSet(
  addresses: Iterable<string | null | undefined>,
): Set<string> {
  const own = new Set<string>();
  for (const address of addresses) {
    const email = extractAddress(address);
    if (email) own.add(email.toLowerCase());
  }
  return own;
}

// ── F6: is this draft sendable? ─────────────────────────────────────────────

/** The recipient headers of a stored draft, as strings, in any provider shape. */
export interface DraftRecipientFields {
  to?: readonly (string | null | undefined)[] | null;
  cc?: readonly (string | null | undefined)[] | null;
  bcc?: readonly (string | null | undefined)[] | null;
}

/**
 * How many distinct, usable addresses the draft would actually be sent to.
 *
 * Bcc counts: a Bcc-only draft is a legitimate message with real recipients.
 * Deduplication is by lower-cased address, so the same person in To and Cc is
 * one recipient, and an entry with no usable address is none.
 */
export function draftRecipientCount(fields: DraftRecipientFields): number {
  const seen = new Set<string>();
  for (const list of [fields.to, fields.cc, fields.bcc]) {
    for (const entry of list ?? []) {
      const email = extractAddress(entry);
      if (email) seen.add(email.toLowerCase());
    }
  }
  return seen.size;
}

/**
 * The send gate. A draft with nothing in To, Cc or Bcc must not be handed to a
 * provider: what happens next is the provider's choice, not ours.
 *
 * This is checked ONLY at send time. draft_create and draft_update stay
 * permissive because writing a draft before knowing who it is for is a real
 * drafting workflow, and refusing it would break that.
 */
export function draftIsSendable(fields: DraftRecipientFields): boolean {
  return draftRecipientCount(fields) > 0;
}

/**
 * The refusal. Deliberately distinct from the "draft not found" wording: the
 * draft exists, is untouched, and the caller can fix it in one call.
 */
export function draftNoRecipientsMessage(draftId: string): string {
  return `draft_send: draft ${draftId} has no recipients. Its To, Cc and Bcc are all ` +
    `empty, so there is nobody to send it to. Nothing was transmitted and the draft is ` +
    `unchanged. Add at least one address with draft_update (to / cc / bcc), then retry ` +
    `draft_send.`;
}

// ── F7: who does a reply go to? ─────────────────────────────────────────────

/** The headers a reply is derived from, plus the account's own identities. */
export interface ReplyRecipientInput {
  /** Parsed From of the source message (usually one entry). */
  from?: readonly (RecipientAddress | null | undefined)[] | null;
  /** Parsed To of the source message. */
  to?: readonly (RecipientAddress | null | undefined)[] | null;
  /** Parsed Cc of the source message. */
  cc?: readonly (RecipientAddress | null | undefined)[] | null;
  /** Every address this inbox sends as. An inbox can have more than one. */
  ownAddresses?: Iterable<string | null | undefined>;
  /** true = reply to the whole thread, false = reply to the sender only. */
  replyAll?: boolean;
  /** Recipient ceiling, default REPLY_RECIPIENT_LIMIT. */
  limit?: number;
}

export type ReplyRecipients =
  | {
    ok: true;
    recipients: RecipientAddress[];
    /**
     * true when the only address left was the account's own, i.e. this is a
     * reply to a note-to-self. Callers may surface it; nothing depends on it.
     */
    selfReply: boolean;
  }
  | { ok: false; reason: "no_addresses" };

/**
 * Compute the recipients of a reply.
 *
 *   reply            -> the sender.
 *   reply_all        -> the sender plus To plus Cc, minus this inbox's own
 *                       addresses, deduplicated, capped.
 *   either, and the  -> the sender anyway (a reply to yourself), exactly once.
 *   filter empties it
 *
 * The last line is F7. The self filter is right for a genuine multi-party
 * thread, where echoing a copy back to the user is noise, and wrong as an
 * absolute rule: on self-addressed mail it removes the only participant there
 * is. So it is applied, and then undone if and only if it left nothing, which
 * is exactly what a mail client does.
 *
 * `ok: false` is reserved for the case the old error message claimed but never
 * actually diagnosed: a source message with no From, To or Cc at all.
 */
export function computeReplyRecipients(
  input: ReplyRecipientInput,
): ReplyRecipients {
  const own = ownAddressSet(input.ownAddresses ?? []);
  const limit = input.limit ?? REPLY_RECIPIENT_LIMIT;

  const from = normalizeEntries(input.from);
  const everyone = dedupe([
    ...from,
    ...normalizeEntries(input.to),
    ...normalizeEntries(input.cc),
  ]);
  if (everyone.length === 0) return { ok: false, reason: "no_addresses" };

  // Whoever we fall back to when the thread is entirely the account itself:
  // the sender if the message has one, else the first participant found.
  const self = from[0] ?? everyone[0];

  if (input.replyAll !== true) {
    return {
      ok: true,
      recipients: [self],
      selfReply: own.has(self.email.toLowerCase()),
    };
  }

  const others = everyone.filter((entry) => !own.has(entry.email.toLowerCase()));
  if (others.length > 0) {
    return { ok: true, recipients: others.slice(0, limit), selfReply: false };
  }
  return { ok: true, recipients: [self], selfReply: true };
}

/** The refusal, for the one case where nothing is derivable. */
export function replyNoRecipientsMessage(tool: string): string {
  return `${tool}: the source message carries no From, To or Cc address, so there is no ` +
    `reply recipient to derive from it. Send a new message with an explicit recipient ` +
    `instead.`;
}

// ── internals ───────────────────────────────────────────────────────────────

/** Drop entries with no usable address; normalize the address it does carry. */
function normalizeEntries(
  entries: readonly (RecipientAddress | null | undefined)[] | null | undefined,
): RecipientAddress[] {
  const out: RecipientAddress[] = [];
  for (const entry of entries ?? []) {
    if (!entry) continue;
    const email = extractAddress(entry.email);
    if (!email) continue;
    out.push(entry.name ? { name: entry.name, email } : { email });
  }
  return out;
}

/** First occurrence wins, compared case-insensitively on the address. */
function dedupe(entries: readonly RecipientAddress[]): RecipientAddress[] {
  const seen = new Set<string>();
  const out: RecipientAddress[] = [];
  for (const entry of entries) {
    const key = entry.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
