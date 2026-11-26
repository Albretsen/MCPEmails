/**
 * Caller-supplied threading headers for a plain send (`email_compose` action
 * 'send', legacy `email_send`).
 *
 * WHY. `reply` threads by reading the original out of a connected mailbox.
 * Some callers keep their incoming mail elsewhere (an agent inbox service, a
 * webhook, a helpdesk) and send through MCPEmails from their own address. They
 * already hold the original's RFC 5322 Message-ID and References chain, and
 * asked (2026-11-26) to pass them in so the answer lands in the same thread
 * without granting access to the incoming mailbox.
 *
 * WHAT IS CHECKED. Only shape: each id must be one RFC 5322 msg-id
 * (`id-left@id-right`, printable ASCII, no whitespace or angle brackets
 * inside). Nothing is looked up. A malformed id is refused rather than
 * repaired, because a header we silently dropped would break the thread with
 * no error anywhere.
 *
 * WHAT IS DERIVED. References should end with the parent's id (RFC 5322
 * 3.6.4), so `in_reply_to` is appended when the chain does not already end
 * with it, and is the whole chain when none was given. `references` without
 * `in_reply_to` replies to the last id in the chain.
 *
 * LINE LENGTH. buildMimeMessage writes each header on one line, and RFC 5322
 * caps a line at 998 octets. A chain that would not fit keeps its first id
 * (the thread root) and as many of the most recent ids as fit, which is the
 * trimming 3.6.4 itself suggests.
 *
 * Outlook senders are refused by the caller: Graph accepts only `x-` custom
 * headers on a message it builds, so these two cannot be set there.
 */

export const MAX_REFERENCES = 100;
const MAX_ID_CHARS = 250;
/** "References: " is 12 octets; leave the rest of the 998 to the ids. */
const MAX_REFERENCES_VALUE_OCTETS = 980;

// id-left "@" id-right, both printable ASCII without space, <, > or @ inside
// id-right. Deliberately looser than dot-atom (real ids carry '/', '=', '$'),
// strict on what could end the header or the msg-id.
const MSG_ID_CORE = /^[\x21-\x3B\x3D\x3F-\x7E]+@[\x21-\x3B\x3D\x3F\x41-\x7E]+$/;

export type ThreadHeaderParse =
  | { ok: true; inReplyTo?: string; references?: string }
  | { ok: false; message: string };

/** Normalise one id to `<core>`, or null when it is not a single msg-id. */
export function normaliseMessageId(raw: string): string | null {
  let core = raw.trim();
  if (core.startsWith("<") && core.endsWith(">")) core = core.slice(1, -1).trim();
  if (!core || core.length > MAX_ID_CHARS) return null;
  if (!MSG_ID_CORE.test(core)) return null;
  return `<${core}>`;
}

/**
 * Read `in_reply_to` and `references` off a send call. Both absent is
 * `{ ok: true }` with neither set, so a normal send is untouched.
 * `tool` prefixes the error text, matching the handler's other messages.
 */
export function parseThreadHeaderArgs(
  args: Record<string, unknown>,
  tool = "email_send",
): ThreadHeaderParse {
  const rawParent = args["in_reply_to"];
  const rawRefs = args["references"];
  const hasParent = rawParent !== undefined && rawParent !== null && rawParent !== "";
  const hasRefs = rawRefs !== undefined && rawRefs !== null &&
    !(Array.isArray(rawRefs) && rawRefs.length === 0) && rawRefs !== "";
  if (!hasParent && !hasRefs) return { ok: true };

  let parent: string | undefined;
  if (hasParent) {
    if (typeof rawParent !== "string") {
      return { ok: false, message: `${tool}: in_reply_to must be a string holding one Message-ID, for example "<abc123@mail.example.com>".` };
    }
    const id = normaliseMessageId(rawParent);
    if (!id) {
      return {
        ok: false,
        message: `${tool}: in_reply_to is not a valid Message-ID: "${rawParent.slice(0, 120)}". ` +
          "Pass the original email's Message-ID header, for example \"<abc123@mail.example.com>\". Nothing was sent.",
      };
    }
    parent = id;
  }

  let chain: string[] = [];
  if (hasRefs) {
    // An array is the advertised shape. A single header-style string
    // ("<a@x> <b@y>") is what a caller copying the raw header sends, so it is
    // split rather than refused.
    const items = typeof rawRefs === "string"
      ? rawRefs.split(/[\s,]+/).filter(Boolean)
      : Array.isArray(rawRefs) ? rawRefs : null;
    if (!items || items.some((v) => typeof v !== "string")) {
      return { ok: false, message: `${tool}: references must be an array of Message-ID strings, oldest first.` };
    }
    if (items.length > MAX_REFERENCES) {
      return { ok: false, message: `${tool}: references takes at most ${MAX_REFERENCES} Message-IDs; got ${items.length}.` };
    }
    for (const item of items as string[]) {
      const id = normaliseMessageId(item);
      if (!id) {
        return {
          ok: false,
          message: `${tool}: references holds an invalid Message-ID: "${item.slice(0, 120)}". ` +
            "Each entry must be one Message-ID, for example \"<abc123@mail.example.com>\". Nothing was sent.",
        };
      }
      if (chain[chain.length - 1] !== id) chain.push(id);
    }
  }

  if (!parent) parent = chain[chain.length - 1];
  if (parent && chain[chain.length - 1] !== parent) chain.push(parent);
  chain = fitReferences(chain);

  return {
    ok: true,
    ...(parent ? { inReplyTo: parent } : {}),
    ...(chain.length ? { references: chain.join(" ") } : {}),
  };
}

/** Keep the root and the newest ids that fit one header line. */
export function fitReferences(chain: string[]): string[] {
  if (chain.join(" ").length <= MAX_REFERENCES_VALUE_OCTETS) return chain;
  const root = chain[0];
  const tail: string[] = [];
  let used = root.length;
  for (let i = chain.length - 1; i > 0; i--) {
    const next = used + 1 + chain[i].length;
    if (next > MAX_REFERENCES_VALUE_OCTETS) break;
    tail.unshift(chain[i]);
    used = next;
  }
  return [root, ...tail];
}
