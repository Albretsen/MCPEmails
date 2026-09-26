// ---------------------------------------------------------------------------
// COPYUID (RFC 4315 UIDPLUS): where a moved or copied message landed.
//
// An IMAP message id here is "<folder>:<uid>", and a UID is only unique inside
// its mailbox. After a MOVE the message has a NEW uid in the destination, so the
// id a move used to hand back (the source id) pointed at nothing: a model that
// moved a message to Archive and then tried to move it back with that id got
// message_not_found. A UIDPLUS server tells us the new uid in a COPYUID response
// code, on the tagged OK of UID COPY or (for UID MOVE, RFC 6851 section 4.3) on
// an untagged `* OK [COPYUID ...]` sent before the expunges:
//
//   * OK [COPYUID 38505 304,319:320 3956:3958] Moved UIDs.
//
// The source and destination sets list UIDs in corresponding order (RFC 4315
// section 3), so 304→3956, 319→3957, 320→3958.
//
// Pure, no I/O, so the parsing can be tested without a socket. A server that
// says nothing, or says something malformed, yields an empty mapping and the
// caller keeps today's behaviour (no new id reported). It must never throw: the
// move itself already succeeded by the time this runs.
// ---------------------------------------------------------------------------

/**
 * Upper bound on how many UIDs one COPYUID set may expand to. Our largest bulk
 * call is 500 ids; this only exists so a hostile or broken "1:4294967295" cannot
 * make us allocate four billion numbers.
 */
const MAX_COPYUID_EXPANSION = 10_000;

/**
 * Expand an RFC 3501 sequence-set of UIDs IN THE ORDER WRITTEN.
 * "304,319:320" → [304, 319, 320]. Returns null on anything malformed,
 * including "*", which a COPYUID set may not contain.
 */
export function expandUidSet(set: string): number[] | null {
  const out: number[] = [];
  for (const part of set.split(",")) {
    const m = /^(\d+)(?::(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a <= 0 || b <= 0) return null;
    // RFC 3501: "4:2" means the same as "2:4". Ascending is the only reading.
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (out.length + (hi - lo + 1) > MAX_COPYUID_EXPANSION) return null;
    for (let u = lo; u <= hi; u++) out.push(u);
  }
  return out;
}

/**
 * Parse every `[COPYUID <uidvalidity> <source-set> <dest-set>]` in the given
 * response text(s) into a source-uid → destination-uid map.
 *
 * Takes the tagged completion text AND the untagged lines, because servers
 * differ on where they put it for MOVE (untagged per RFC 6851; some also or
 * only on the tagged OK). A response code whose two sets differ in length is
 * ignored entirely: pairing them up anyway would hand out ids for the wrong
 * messages, which is worse than handing out none.
 *
 * `requested`, when given, restricts the map to UIDs this command actually
 * asked about, so a stray code from some other context cannot leak in.
 */
export function parseCopyUid(
  texts: readonly string[],
  requested?: readonly number[],
): Map<number, number> {
  const mapping = new Map<number, number>();
  const allowed = requested ? new Set(requested) : null;
  const re = /\[COPYUID\s+(\d+)\s+([0-9:,]+)\s+([0-9:,]+)\]/gi;
  for (const text of texts) {
    if (typeof text !== "string" || !/COPYUID/i.test(text)) continue;
    for (const m of text.matchAll(re)) {
      const src = expandUidSet(m[2]);
      const dst = expandUidSet(m[3]);
      if (!src || !dst || src.length !== dst.length) continue;
      for (let i = 0; i < src.length; i++) {
        if (allowed && !allowed.has(src[i])) continue;
        mapping.set(src[i], dst[i]);
      }
    }
  }
  return mapping;
}

// ── Result shape ────────────────────────────────────────────────────────────

/**
 * Map each moved message's OLD id to its NEW id, for the items whose source uid
 * the server reported in COPYUID. Items it did not report are simply absent.
 *
 * `encode` is index.ts's own `encodeImapId`, passed in so there is still only
 * one spelling of an IMAP message id; `destinationFolder` must be the resolved
 * server mailbox name, exactly what email_read puts in front of the colon.
 */
export function newMessageIdsFor(
  items: readonly { uid: number; messageId: string }[],
  mapping: ReadonlyMap<number, number>,
  destinationFolder: string,
  encode: (folder: string, uid: number) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const dst = mapping.get(item.uid);
    if (dst !== undefined) out[item.messageId] = encode(destinationFolder, dst);
  }
  return out;
}

/**
 * One succeeded row of a bulk result. `new_message_id` is added only when the
 * server reported one, so a non-UIDPLUS server (and Gmail/Outlook, whose ids
 * survive a move) produce exactly the row they always did.
 */
export function succeededBulkRow(
  messageId: string,
  newMessageIds: Readonly<Record<string, string>> | undefined,
): { message_id: string; success: true; new_message_id?: string } {
  const next = newMessageIds && Object.hasOwn(newMessageIds, messageId)
    ? newMessageIds[messageId]
    : undefined;
  return next ? { message_id: messageId, success: true, new_message_id: next } : {
    message_id: messageId,
    success: true,
  };
}

/**
 * The note a move result carries when the server did NOT say where the message
 * went. On IMAP the old id is dead after a move, and without this the natural
 * next step ("now move it back") fails with message_not_found.
 */
export function unknownNewIdNote(destinationFolder: string, count = 1): string {
  const what = count === 1 ? "the moved message's new id" : "the moved messages' new ids";
  const it = count === 1 ? "it" : "them";
  return `This mail server did not report ${what}. On IMAP a message's id changes when it ` +
    `changes folder, so the old message_id no longer finds ${it}: look ${it} up in ` +
    `"${destinationFolder}" (email_read list or search) before acting on ${it} again.`;
}
