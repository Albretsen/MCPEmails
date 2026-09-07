// ---------------------------------------------------------------------------
// forward-attachments.ts — turning a read message's attachments into the parts
// an email_forward is about to transmit, or refusing to send at all.
//
// Extracted from index.ts on 2026-09-07 so the refusal below is unit-testable.
// Its counterpart on the wire is smtp-client.ts's writeAllBytes, which is what
// made forwarding those bytes work in the first place.
// ---------------------------------------------------------------------------

import { PreTransmissionError } from "./send-stages.ts";

/**
 * Per-file ceiling when email_forward re-reads a message it is about to send
 * with `include_attachments: true`.
 *
 * The reader's 2 MB bulk clamp (BULK_ATTACHMENT_MAX_BYTES) is right for a READ,
 * whose caller asked for a look at the mailbox and gets `data: null` plus a note
 * pointing at the single-file download. It is wrong for a forward, where the
 * bytes are not a preview: they are the payload, they are going to be encoded
 * and transmitted whatever we do, and dropping one turns a forwarded invoice
 * into an empty message. So the forward path lifts the per-file cap to the same
 * 10 MB the send paths accept (SEND_MAX_ATTACHMENT_BYTES) and the tool
 * description has always advertised; the shared 10 MB per-call budget still
 * bounds the whole message.
 *
 * This is the named ceiling for forwarding. Anything above it is refused with a
 * typed `attachment_too_large` naming the file, never silently dropped.
 */
export const FORWARD_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The shape collectForwardAttachments needs from a ReadEmailResult entry. */
export interface ForwardSourceAttachment {
  filename: string;
  mime_type: string;
  size_bytes: number;
  /** Base64 bytes, or null when the reader listed the file without fetching it. */
  data: string | null;
}

/** A send-ready attachment part. */
export interface ForwardAttachmentPart {
  filename: string;
  mime_type: string;
  data: string;
}

/**
 * An attachment the forward path could not carry.
 *
 * ── WHY THIS IS AN ERROR AND NOT A DROPPED FILE ────────────────────────────
 * All three forward providers used to do this:
 *
 *     original.attachments.filter((a) => a.data !== null).map(...)
 *
 * `data: null` is how the readers say "I listed this file but did not fetch its
 * bytes": over the per-file cap, over the per-call budget, or, on Gmail, the
 * attachment fetch itself failed. Filtering that away meant the forward went out
 * WITHOUT the file and reported `status: "sent"`. The recipient gets a message
 * whose text says "please find the invoice attached" and no invoice, and nobody
 * finds out until someone reconciles the books.
 *
 * So: no file, no send. The caller gets a typed `attachment_too_large` naming
 * the file, its size and the limit, and can fetch it with
 * `email_read action: attachment` (25 MB) and send it explicitly.
 *
 * A `PreTransmissionError` (stage "compose") because that is literally what it
 * is: the refusal happens while assembling the parts, before any provider send
 * call. Two things follow from the base class and neither is decorative — the
 * stage wrappers in index.ts pass it through with its own type instead of
 * reclassifying it, and if its own handler branch is ever removed it still
 * cannot land in the branch that says "may or may not have been delivered".
 */
export class ForwardAttachmentError extends PreTransmissionError {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly limitBytes: number;
  /** "too_large" when the size explains it; "unavailable" when nothing does. */
  readonly kind: "too_large" | "unavailable";
  constructor(input: {
    filename: string;
    sizeBytes: number;
    limitBytes: number;
    kind: "too_large" | "unavailable";
  }) {
    super("compose", `forward_attachment_${input.kind}: ${input.filename}`);
    this.name = "ForwardAttachmentError";
    this.filename = input.filename;
    this.sizeBytes = input.sizeBytes;
    this.limitBytes = input.limitBytes;
    this.kind = input.kind;
  }
}

/**
 * Turn a read result's attachment list into send-ready parts, or throw.
 *
 * Returns [] when the caller did not ask for attachments: that is the one case
 * where leaving them behind is what was requested.
 */
export function collectForwardAttachments(
  attachments: readonly ForwardSourceAttachment[],
  includeAttachments: boolean,
  limitBytes: number = FORWARD_ATTACHMENT_MAX_BYTES,
): ForwardAttachmentPart[] {
  if (!includeAttachments) return [];
  return attachments.map((a) => {
    if (a.data === null) {
      throw new ForwardAttachmentError({
        filename: a.filename,
        sizeBytes: a.size_bytes,
        limitBytes,
        kind: a.size_bytes > limitBytes ? "too_large" : "unavailable",
      });
    }
    return { filename: a.filename, mime_type: a.mime_type, data: a.data };
  });
}
