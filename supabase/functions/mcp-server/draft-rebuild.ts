// ---------------------------------------------------------------------------
// What a draft REBUILD can and cannot carry (2026-10-13).
//
// On IMAP and Gmail an update to a stored draft is not an edit. The message is
// read, reduced to recipients, a subject, one text body and one HTML body, and
// a NEW message is built from those fields and stored in its place
// (`mime-build.ts#buildDraftMime`). Whatever the stored message had beyond
// those fields is not in the new one.
//
// `draft_editor_save` and a body-less `draft{action:"update"}` both promise to
// keep what the caller did not name, so they must not run that rebuild over a
// message it cannot represent. Until this module existed the only guard was
// "has attachments", which is one case of several:
//
//   * a second text/plain or text/html part (parseEmail keeps the first only);
//   * an inline image with a Content-ID and no filename, which is not an
//     attachment by the parser's rule and so was dropped without a refusal,
//     leaving `cid:` references pointing at nothing;
//   * a text/calendar alternative, a signature part, an embedded message;
//   * a `format=flowed` text part, whose soft line breaks would be written back
//     as hard ones (the builder emits fixed text), re-wrapping every paragraph;
//   * a multipart container that cannot be split.
//
// Each of those is now a BLOCKER: the partial write refuses and changes
// nothing, exactly as it already did for attachments.
//
// ── What is still NOT preserved, and is not a blocker ──────────────────────
// Headers. The rebuilt message carries From (written from the inbox's own
// identity), To, Cc, Bcc, Subject, Reply-To, In-Reply-To and References, and a
// new Date and Message-ID. Every other header of the stored message (X-*
// fields, priority, a read-receipt request) is gone, and the transfer encoding
// and charset of the body parts are normalised to base64 UTF-8. The decoded
// body TEXT is what is kept. That is why no description says the stored draft
// is kept "exactly"; see the `draft` tool description and contract §8.
//
// Pure and dependency-free apart from the MIME parser, so it is testable
// without booting the server.
// ---------------------------------------------------------------------------

import { type MimeLeaf, mimeLeafParts } from "./mime.ts";
import { urlFromSignatureCid } from "./signature-images.ts";

/**
 * The parts of a stored message that a rebuild from fields would drop or
 * change, as short labels fit for an error message. Empty means the message is
 * one text/plain and/or one text/html and nothing else.
 *
 * Attachments are deliberately NOT listed: they have their own refusal with
 * its own code (`draft_has_attachments`), which predates this and which a
 * caller checks first.
 */
export function draftRebuildBlockersOf(leaves: readonly MimeLeaf[]): string[] {
  const blockers: string[] = [];
  let sawPlain = false;
  let sawHtml = false;
  for (const leaf of leaves) {
    if (leaf.attachment) continue;
    if (leaf.mediaType === "text/plain") {
      if (sawPlain) blockers.push("a second text/plain part");
      else if (leaf.flowed) blockers.push("a format=flowed text part");
      sawPlain = true;
    } else if (leaf.mediaType === "text/html") {
      if (sawHtml) blockers.push("a second text/html part");
      sawHtml = true;
    } else if (leaf.mediaType.startsWith("image/")) {
      // Our own embedded signature image (signature-images.ts) survives a
      // rebuild: the transport recognises its `cid:` in the HTML and attaches
      // the image again, or turns the reference back into its https URL. So
      // it is no blocker, or every save of a draft written with
      // `signature_embed_images` on would be refused.
      if (leaf.contentId && urlFromSignatureCid(leaf.contentId) !== null) continue;
      blockers.push(`an inline ${leaf.mediaType} part`);
    } else {
      blockers.push(`a ${leaf.mediaType} part`);
    }
  }
  return blockers;
}

/** `draftRebuildBlockersOf` over a raw message (a byte string). */
export function draftRebuildBlockers(raw: string): string[] {
  return draftRebuildBlockersOf(mimeLeafParts(raw));
}

/**
 * A Reply-To header value that can be written back as it was read, or null.
 *
 * The builder writes `Reply-To: <value>` verbatim. The parser has already
 * unfolded the value, so it cannot carry a line break; this additionally
 * requires printable ASCII, so an 8-bit display name (which would need RFC 2047
 * encoding the builder does not apply to this field) is never written raw.
 * `undefined` means the stored message has no Reply-To at all.
 */
export function carriableReplyTo(value: string | null): string | null | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : null;
}

/** The three recipient lists, and which of them the CALLER supplied. */
export interface DraftRecipientLists {
  to: string[];
  cc: string[];
  bcc: string[];
  /**
   * True for a list the caller passed in this call, as opposed to one restored
   * from the stored draft or defaulted because the stored draft could not be
   * read. Only a supplied list may be CLEARED by being empty.
   */
  explicitRecipients?: { to?: boolean; cc?: boolean; bcc?: boolean };
}

/**
 * The recipient fields of a Graph `PATCH /me/messages/{id}` for a draft update.
 *
 * ── Why an empty list is sometimes sent and sometimes not ──────────────────
 * Graph's PATCH keeps a field that is absent from the body. The update used to
 * omit every empty list, which is right for a list nobody supplied (keep what
 * is stored) and wrong for one the caller supplied as `[]`: the call reported
 * success, Exchange kept the address, and Send then delivered to somebody the
 * user had removed. Verified against the code 2026-10-13; the card's "remove
 * this Cc" reaches the server as `cc: []`.
 *
 * So: a non-empty list is always sent; an empty list is sent as `[]` only when
 * the caller supplied it; an empty list the caller did NOT supply is omitted,
 * which is what keeps a full-body update whose stored-draft read failed from
 * wiping recipients it never meant to touch.
 */
export function outlookRecipientPatch<R>(
  params: DraftRecipientLists,
  mapRecipient: (address: string) => R,
): { toRecipients?: R[]; ccRecipients?: R[]; bccRecipients?: R[] } {
  const explicit = params.explicitRecipients ?? {};
  const patch: { toRecipients?: R[]; ccRecipients?: R[]; bccRecipients?: R[] } = {};
  if (params.to.length > 0 || explicit.to === true) patch.toRecipients = params.to.map(mapRecipient);
  if (params.cc.length > 0 || explicit.cc === true) patch.ccRecipients = params.cc.map(mapRecipient);
  if (params.bcc.length > 0 || explicit.bcc === true) patch.bccRecipients = params.bcc.map(mapRecipient);
  return patch;
}

/**
 * Does this HTTP status on a single-draft GET mean "there is no such draft"?
 *
 * 404 is the provider saying so. 400 is included because on both Gmail
 * ("Invalid id value") and Graph ("ErrorInvalidIdMalformed") it is what a
 * draft id of the wrong SHAPE gets, for instance an IMAP `Drafts:2` sent to a
 * Gmail inbox: the id is the only variable in the request, a malformed id
 * cannot name a draft, and the not-found answer (re-read the draft list) is the
 * one that helps.
 *
 * Everything else is NOT "not found". The editor readers used to return null
 * for every non-OK status but 401, so a 429 or a 500 on the read was reported
 * as a missing draft and a model could reasonably recreate it. Those now throw
 * and reach the "could not be read, try again" answer.
 */
export function draftReadStatusMeansMissing(status: number): boolean {
  return status === 404 || status === 400;
}
