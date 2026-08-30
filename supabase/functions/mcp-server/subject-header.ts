// ---------------------------------------------------------------------------
// What a subject line may actually be, measured in the unit that binds.
//
// Every subject validator in this server counted CHARACTERS and compared them
// against 998. 998 is real, but it is RFC 5322's limit on a whole HEADER LINE
// ("Subject: Hello", CRLF excluded), not on the header VALUE. Prepending
// "Subject: " costs nine octets, so a 998-character subject produces a
// 1007-octet line that no compliant transport may emit.
//
// What happens then is worse than a rejection. Reproduced in production
// 2026-08-30: ONE email_compose send with a 998-character subject returned a
// single message_id and left TWO messages in the mailbox, under different
// thread_ids and both labelled SENT. The over-long line has to be folded, the
// subject had no whitespace to fold at, so a space was INSERTED nine characters
// from the end. The delivered subject no longer matched the sent copy, Gmail
// stopped collapsing the self-delivered copy into it, and the user saw a
// duplicate. Silent corruption plus an apparent double send, from a value the
// schema said was fine.
//
// The character count is the wrong unit for a second reason. A subject with any
// non-ASCII character is emitted as an RFC 2047 encoded-word
// (=?UTF-8?B?<base64>?=), which costs 4 octets per 3 UTF-8 bytes plus 12 for
// the wrapper. One emoji is 4 bytes; 250 emoji are 1000 bytes and encode to
// ~1345 octets, so a 250-CHARACTER subject can blow a 998-OCTET limit by 35%.
// No character cap can express that. So this module measures the line this
// server will actually emit, and reports the longest prefix that fits.
//
// Kept out of index.ts for the usual reason: index.ts calls Deno.serve at load,
// so nothing in it can be unit tested, and this is arithmetic that must not be
// wrong.
// ---------------------------------------------------------------------------

/**
 * RFC 5322 §2.1.1: "Each line of characters MUST be no more than 998
 * characters, and SHOULD be no more than 78 characters, excluding the CRLF."
 * Characters there means octets: the section is about what may go on the wire.
 */
export const HEADER_LINE_MAX_OCTETS = 998;

/** The field name and its separator, exactly as buildMimeMessage emits it. */
export const SUBJECT_FIELD_PREFIX = "Subject: ";

/** Octets left for the subject VALUE once the field name is paid for: 989. */
export const SUBJECT_VALUE_MAX_OCTETS = HEADER_LINE_MAX_OCTETS - SUBJECT_FIELD_PREFIX.length;

/**
 * The schema-level character cap.
 *
 * Every character costs AT LEAST one octet (ASCII) and usually more, so no
 * subject longer than this can ever fit and rejecting on length alone is
 * always correct. It is deliberately NOT sufficient: a shorter non-ASCII
 * subject can still overflow, which is what checkSubjectHeaderLine is for. The
 * schema cap exists so the ordinary "far too long" case is refused by the
 * generic validator with the generic message, before any handler runs.
 */
export const SUBJECT_MAX_CHARS = SUBJECT_VALUE_MAX_OCTETS;

/**
 * Characters as a person (or a model) counts them: code POINTS, not UTF-16
 * code units. An emoji is one character here and two units in `String.length`.
 *
 * The distinction is the difference between advice that works and advice that
 * loops. Told "at most 366 characters" after sending 250 emoji — 500 units,
 * 250 characters — a model would conclude it was already inside the limit and
 * retry the identical call.
 */
export function subjectCharCount(subject: string): number {
  return Array.from(subject).length;
}

/**
 * Mirror of buildMimeMessage's encodeMimeHeaderValue (index.ts).
 *
 * It is duplicated rather than imported because index.ts calls Deno.serve at
 * module load and cannot be imported from a test. The two must stay in step:
 * this function decides what is ACCEPTED, that one decides what is SENT, and a
 * divergence puts the corruption back. Both must:
 *
 *   1. collapse control characters (CR/LF included) to a single space FIRST —
 *      the security fix against header injection, and it changes the length;
 *   2. pass ASCII through verbatim;
 *   3. emit one =?UTF-8?B?...?= encoded-word for anything else.
 *
 * Note (3) is a single encoded-word of unbounded length, which RFC 2047 caps at
 * 75 characters per word. That is a separate, pre-existing non-conformance;
 * measuring what is actually emitted is the point here, and a stricter
 * multi-word encoder would only ever be LONGER, so this bound stays safe.
 */
export function encodeSubjectHeaderValue(value: string): string {
  // deno-lint-ignore no-control-regex
  const sanitized = value.replace(/[\x00-\x1F\x7F]+/g, " ");
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(sanitized)) return sanitized;
  const bytes = new TextEncoder().encode(sanitized);
  const binaryStr = Array.from(bytes).map((b) => String.fromCharCode(b)).join("");
  return `=?UTF-8?B?${btoa(binaryStr)}?=`;
}

/**
 * Octets in the `Subject:` header line this subject would produce, CRLF
 * excluded. The encoded form is ASCII by construction (base64 or a
 * control-stripped ASCII value), so its character count IS its octet count.
 */
export function subjectHeaderLineOctets(subject: string): number {
  return SUBJECT_FIELD_PREFIX.length + encodeSubjectHeaderValue(subject).length;
}

/** True when the subject needs RFC 2047 encoding, i.e. it is not pure ASCII. */
export function subjectNeedsEncoding(subject: string): boolean {
  // deno-lint-ignore no-control-regex
  return !/^[\x00-\x7F]*$/.test(subject.replace(/[\x00-\x1F\x7F]+/g, " "));
}

/**
 * The longest leading run of CHARACTERS (code points) whose header line still
 * fits.
 *
 * This is the actionable half of the error: "shorten it to N characters" is
 * something a model can act on, whereas "the line is 1007 octets" is not. Found
 * by binary search because encoded length is monotonic in prefix length.
 * Counting code points also means a cut can never land between the halves of a
 * surrogate pair, so the advice never names half a character.
 */
export function longestFittingSubjectChars(subject: string): number {
  if (subjectHeaderLineOctets(subject) <= HEADER_LINE_MAX_OCTETS) return subjectCharCount(subject);
  const chars = Array.from(subject);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (subjectHeaderLineOctets(chars.slice(0, mid).join("")) <= HEADER_LINE_MAX_OCTETS) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The leading `count` CHARACTERS (code points) of a subject. */
export function truncateSubjectToChars(subject: string, count: number): string {
  return Array.from(subject).slice(0, Math.max(0, count)).join("");
}

export interface SubjectHeaderCheck {
  /** Whether this subject may be sent as-is. */
  ok: boolean;
  /** Why not. `empty` covers missing, non-string and whitespace-only. */
  reason: null | "empty" | "too_long";
  /** Octets in the header line as it would be emitted, CRLF excluded. */
  octets: number;
  /** The line limit those octets are measured against. */
  limit: number;
  /** Longest prefix that would fit, in characters (code points). */
  maxChars: number;
  /** Whether RFC 2047 encoding applies, which is why chars ≠ octets. */
  encoded: boolean;
}

/**
 * Decide whether a subject can be transmitted intact.
 *
 * Takes `unknown` on purpose: it is the same decision for a missing subject, a
 * number, and a 1000-character string, and every call site was already
 * hand-rolling the first two.
 */
export function checkSubjectHeaderLine(subject: unknown): SubjectHeaderCheck {
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return {
      ok: false,
      reason: "empty",
      octets: SUBJECT_FIELD_PREFIX.length,
      limit: HEADER_LINE_MAX_OCTETS,
      maxChars: 0,
      encoded: false,
    };
  }
  const octets = subjectHeaderLineOctets(subject);
  const ok = octets <= HEADER_LINE_MAX_OCTETS;
  return {
    ok,
    reason: ok ? null : "too_long",
    octets,
    limit: HEADER_LINE_MAX_OCTETS,
    maxChars: longestFittingSubjectChars(subject),
    encoded: subjectNeedsEncoding(subject),
  };
}

/**
 * The rejection sentence, or null when the subject is fine.
 *
 * Wording follows the pre-flight validation errors ("arguments.subject must
 * contain at most 998 characters"): the leading clause is the same shape, and
 * everything after it exists because the plain version would be a lie here —
 * the true limit is not a character count, and a model told "at most 989
 * characters" after being refused a 250-character subject would retry the
 * identical call. So the sentence names the real unit, the real limit, and the
 * one number that is actionable: how long THIS subject may be.
 */
export function subjectHeaderLineError(tool: string, subject: unknown): string | null {
  const check = checkSubjectHeaderLine(subject);
  if (check.ok) return null;
  if (check.reason === "empty") {
    return `${tool}: subject is required and must be a non-empty string.`;
  }
  const overBy = check.octets - check.limit;
  const encodedClause = check.encoded
    ? ` This subject is not pure ASCII, so it is sent RFC 2047 encoded ` +
      `(=?UTF-8?B?...?=) and costs more octets than it has characters.`
    : "";
  return (
    `${tool}: subject must contain at most ${check.maxChars} characters. ` +
    `RFC 5322 allows ${check.limit} octets per header line and "${SUBJECT_FIELD_PREFIX.trimEnd()}" ` +
    `uses ${SUBJECT_FIELD_PREFIX.length}, so this subject's header line is ${check.octets} octets, ` +
    `${overBy} over.${encodedClause} A longer subject is folded in transit, which inserts ` +
    `whitespace into the delivered subject and can duplicate the message; nothing was sent.`
  );
}
