// ---------------------------------------------------------------------------
// `thread_key`: the conversation a row belongs to, as one opaque string.
//
// Computed here, after the executor has answered, from fields the row already
// carries (first-party.ts `threadHeaders`). Nothing is stored: the key is a
// pure function of the row and the inbox's provider.
//
// THE RULE, first match wins:
//
//   1. Gmail API inbox      "g:" + thread_id        (Gmail's threadId)
//      Outlook inbox        "o:" + thread_id        (Graph's conversationId)
//      Only when `thread_id` is a non-empty string that is not the row's own
//      message id on Outlook (Graph rows fall back to `msg.id` when a message
//      has no conversationId, and that is not a conversation).
//      Gmail over IMAP      "g:" + X-GM-THRID (decimal), when the row's FETCH
//      carried it (the server advertises X-GM-EXT-1). Exact, like the API's.
//      List, search and thread rows have it; a single `read` does not ask the
//      server for it and keeps the header key of rule 2.
//   2. Headers present     "m:" + ROOT Message-ID, where ROOT is
//                             the first id of References, else
//                             the id of In-Reply-To, else
//                             the row's own Message-ID.
//      Ids are compared without angle brackets, byte for byte (RFC 5322 ids
//      are case-sensitive on the left of the "@").
//   3. No header at all     "s:" + hash(normalised subject + "\n" + the sorted,
//                           lower-cased, de-duplicated addresses of From and
//                           To). Only when the normalised subject is not
//                           empty and there is at least one address.
//   4. Otherwise            "u:" + the row's id (a conversation of one).
//
// Normalised subject: reply/forward prefixes removed repeatedly ("Re:", "RE[2]:",
// "Fwd:", "Fw:", "SV:", "VS:", "AW:", "WG:", "Antw:", "TR:", "RV:", "Res:",
// "Enc:"), whitespace collapsed, lower-cased. "(no subject)" is empty.
//
// Rule 3 is deliberately narrow. Two mails that both say "Re: Invoice" are the
// same conversation only when headers say so; the subject is consulted only
// for a message that has NO Message-ID, NO In-Reply-To and NO References (a
// malformed or hand-built message), and even then the participants must be
// the same set. The client never merges on subject either.
//
// The client groups by more than the key: it also links a row to any row whose
// Message-ID appears in its In-Reply-To or References, so a reply whose
// References were truncated by some mail client still joins its conversation.
// The key is the root that makes the common case one map lookup.
// ---------------------------------------------------------------------------

export interface ThreadRowLike {
  id?: unknown;
  thread_id?: unknown;
  subject?: unknown;
  from?: unknown;
  to?: unknown;
  message_id_header?: unknown;
  in_reply_to?: unknown;
  references?: unknown;
  /** Gmail-over-IMAP's X-GM-THRID, as the tool layer hands it over (first-party.ts). */
  gm_thread_id?: unknown;
}

const PREFIX = /^\s*(?:(?:re|fwd?|fw|sv|vs|aw|wg|antw|tr|rv|res|enc)(?:\[\d+\])?\s*[:：]\s*)+/i;

/**
 * The subject without its reply/forward prefixes, whitespace collapsed, in the
 * case the sender wrote it. This is what an IMAP `SEARCH SUBJECT` is given
 * (mail/thread.ts): a server matches ASCII without regard to case, but not
 * every server folds case outside ASCII, so "Ødegård" must not be sent as
 * "ødegård".
 */
export function baseSubject(subject: unknown): string {
  if (typeof subject !== "string") return "";
  let text = subject.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 8; i++) {
    const next = text.replace(PREFIX, "").trim();
    if (next === text) break;
    text = next;
  }
  return text.toLowerCase() === "(no subject)" ? "" : text;
}

/** See the header comment. */
export function normalizeSubject(subject: unknown): string {
  return baseSubject(subject).toLowerCase();
}

/** cyrb53: a 53-bit string hash. A grouping key, not a security boundary. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function emailsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  for (const entry of list) {
    const email = entry && typeof entry === "object" ? (entry as { email?: unknown }).email : entry;
    if (typeof email === "string" && email.trim()) out.push(email.trim().toLowerCase());
  }
  return out;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The ids a row links through, root first: References, then In-Reply-To, then its own. */
export function threadIdsOf(row: ThreadRowLike): { own: string; inReplyTo: string; references: string[] } {
  const references = Array.isArray(row.references)
    ? row.references.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  return { own: text(row.message_id_header), inReplyTo: text(row.in_reply_to), references };
}

export function threadKeyOf(row: ThreadRowLike, provider: string | null): string {
  const id = text(row.id);
  const threadId = text(row.thread_id);
  if (provider === "gmail" && threadId) return `g:${threadId}`;
  // Gmail over IMAP: the row carried X-GM-THRID (decimal; the Gmail API spells
  // the same number in hex, and an inbox is only ever one of the two).
  const gmThreadId = text(row.gm_thread_id);
  if (provider !== "gmail" && provider !== "outlook" && /^\d{1,24}$/.test(gmThreadId)) return `g:${gmThreadId}`;
  if (provider === "outlook" && threadId && threadId !== id) return `o:${threadId}`;
  const { own, inReplyTo, references } = threadIdsOf(row);
  const root = references[0] || inReplyTo || own;
  if (root) return `m:${root}`;
  const subject = normalizeSubject(row.subject);
  const people = [...new Set([...emailsOf(row.from), ...emailsOf(row.to)])].sort();
  if (subject && people.length > 0) return `s:${hash53(`${subject}\n${people.join(",")}`)}`;
  return `u:${id}`;
}

/**
 * The op result with `thread_key` on every message row (`messages[]`), or on
 * the result itself when it is one message (`read`). Anything else is
 * returned untouched.
 */
export function withThreadKeys(result: unknown, provider: string | null): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const body = result as Record<string, unknown>;
  if (Array.isArray(body["messages"])) {
    return {
      ...body,
      messages: (body["messages"] as unknown[]).map((row) => {
        if (!row || typeof row !== "object") return row;
        // `gm_thread_id` is the tool layer's hand-over, not part of a row.
        const { gm_thread_id: _gm, ...rest } = row as Record<string, unknown>;
        return { ...rest, thread_key: threadKeyOf(row as ThreadRowLike, provider) };
      }),
    };
  }
  if (typeof body["id"] === "string") return { ...body, thread_key: threadKeyOf(body as ThreadRowLike, provider) };
  return result;
}
