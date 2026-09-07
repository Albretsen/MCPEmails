// ---------------------------------------------------------------------------
// attachment-reference.ts - classifying one `attachments[]` entry as bytes the
// caller supplied, or a pointer to bytes the server already has.
//
// ── The gap this closes ─────────────────────────────────────────────────────
// Until now the only way to put an existing attachment onto a new message was
// to move it through the model:
//
//   email_read action:attachment  →  base64 IN a tool result
//   email_compose action:send     →  base64 IN a tool argument
//
// A 152 KB PDF is ~203 KB of base64. Asking a language model to re-emit that
// character-perfect is asking it to do the one thing it is worst at, and a
// silently corrupted PDF in an accounting ledger is worse than a missing one.
// On 2026-09-07 an agent moving 30 supplier invoices refused the bridge outright
// and told the user to forward the messages by hand, which is the correct call
// and also a product failure.
//
// So `attachments[]` now takes a second shape:
//
//   { source_message_id: "INBOX:83122", attachment_index: 0 }
//
// The server resolves it against the same single-file download path
// email_attachment uses, and the bytes never appear in a tool result or a tool
// argument.
//
// ── Why the classification lives here ───────────────────────────────────────
// Two variants sharing one array is exactly the shape that rots: a caller sends
// a half-filled reference, or an inline entry with a stray `source_message_id`,
// and a lenient reader picks a branch and sends the wrong file. Deciding which
// variant an entry IS - and refusing anything ambiguous - is a pure function of
// the entry, so it is testable without a mailbox and cannot drift from the
// handler that consumes it. Same reason attachment-validation.ts exists.
//
// NOTHING HERE FETCHES. Resolution is the caller's job (index.ts), because it
// needs a provider connection. This module only decides what was asked for.
// ---------------------------------------------------------------------------

import { decodedBase64ByteLength } from "./attachment-validation.ts";

/** An attachment whose bytes the caller supplied inline, base64-encoded. */
export interface InlineAttachmentInput {
  filename: string;
  mime_type: string;
  data: string;
}

/**
 * A pointer to an attachment already sitting on a message in the same inbox.
 *
 * The selector mirrors email_attachment's: `attachment_index` or `filename`,
 * and neither is required when the source message carries exactly one file.
 * Requiring an index for the overwhelmingly common single-attachment receipt
 * would force a read-then-send round trip for no gain.
 */
export interface AttachmentReferenceInput {
  source_message_id: string;
  attachment_index?: number;
  filename?: string;
}

export type AttachmentSpec =
  | {
    kind: "inline";
    /** Zero-based position in the caller's array, for error messages. */
    position: number;
    attachment: InlineAttachmentInput;
    /** Exact decoded size, already validated as canonical base64. */
    bytes: number;
  }
  | {
    kind: "reference";
    position: number;
    reference: AttachmentReferenceInput;
  };

export interface AttachmentSpecs {
  ok: true;
  /** Every entry, in the caller's order. Mixing the two variants is allowed. */
  specs: AttachmentSpec[];
  /** Summed decoded size of the inline entries only; references are unknown here. */
  inlineBytes: number;
  referenceCount: number;
}

export interface AttachmentSpecError {
  ok: false;
  /** Suitable for `logErrorCode` — a stable sentinel, never interpolated. */
  code: string;
  message: string;
}

export interface AttachmentParseLimits {
  /** Max entries in one call, counting both variants. */
  maxItems: number;
  /** Ceiling on the summed decoded size of the INLINE entries. */
  maxInlineBytes: number;
}

/**
 * The sentence a caller gets when the combined size of inline plus resolved
 * referenced attachments exceeds the message budget.
 *
 * Exported so index.ts says the same thing after resolution as this module says
 * before it. A reference's size is not knowable until it is fetched, so the
 * budget is necessarily enforced in two places; it must not be worded twice.
 */
export function attachmentTooLargeMessage(
  tool: string,
  totalBytes: number,
  maxBytes: number,
): string {
  return (
    `${tool}: total attachment size is ${totalBytes} bytes, which exceeds the ` +
    `${maxBytes}-byte limit for one message. Send fewer attachments per ` +
    `message, or split them across several messages.`
  );
}

/** Is this a plain object (not null, not an array)? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Choosing WHICH attachment on the source message ─────────────────────────

/** One row of the compact manifest a message's attachments are chosen from. */
export interface AttachmentManifestEntry {
  index: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export type AttachmentSelection =
  | { ok: true; index: number }
  | {
    ok: false;
    /** The `error` sentinel in the payload, kept separate for logging. */
    error: string;
    /** The code the tool logs. Not always the sentinel — see selectAttachment. */
    logCode: string;
    /** The JSON body the caller receives, manifest included. */
    payload: Record<string, unknown>;
  };

/**
 * Resolve `attachment_index` / `filename` against a message's attachments.
 *
 * Shared by the single-file download (email_attachment) and by an
 * attach-by-reference send, because they ask the same question and a caller
 * should not have to learn two vocabularies for "that index is out of range"
 * depending on whether it wanted to READ the file or ATTACH it. The wording and
 * the payload shape are email_attachment's, byte for byte.
 *
 * `attachment_index` wins when both selectors are given, matching the behaviour
 * email_attachment has always documented. Neither selector is required when the
 * message carries exactly one attachment; with several, refusing is the only
 * safe answer, since picking the first would attach a file nobody named.
 */
export function selectAttachment(
  messageId: string,
  manifest: readonly AttachmentManifestEntry[],
  selector: { attachment_index?: number | null; filename?: string | null },
): AttachmentSelection {
  if (manifest.length === 0) {
    return {
      ok: false,
      error: "no_attachments",
      logCode: "no_attachments",
      payload: {
        error: "no_attachments",
        message: `Message ${messageId} has no attachments.`,
      },
    };
  }

  const index = selector.attachment_index ?? null;
  if (index !== null) {
    if (index >= manifest.length) {
      return {
        ok: false,
        error: "attachment_index_out_of_range",
        logCode: "-32602",
        payload: {
          error: "attachment_index_out_of_range",
          requested_index: index,
          total_attachments: manifest.length,
          attachments: manifest,
          message:
            `attachment_index ${index} is out of range; this message has ` +
            `${manifest.length} attachment(s) (indices 0–${manifest.length - 1}).`,
        },
      };
    }
    return { ok: true, index };
  }

  const filename = selector.filename ?? null;
  if (filename !== null) {
    const lower = filename.toLowerCase();
    const found = manifest.findIndex((a) => a.filename.toLowerCase() === lower);
    if (found === -1) {
      return {
        ok: false,
        error: "attachment_not_found",
        logCode: "attachment_not_found",
        payload: {
          error: "attachment_not_found",
          requested_filename: filename,
          attachments: manifest,
          message:
            `No attachment named '${filename}' on message ${messageId}. ` +
            "See `attachments` for the available filenames.",
        },
      };
    }
    return { ok: true, index: found };
  }

  if (manifest.length === 1) return { ok: true, index: 0 };

  return {
    ok: false,
    error: "attachment_selector_required",
    logCode: "-32602",
    payload: {
      error: "attachment_selector_required",
      total_attachments: manifest.length,
      attachments: manifest,
      message:
        `Message ${messageId} has ${manifest.length} attachments. Specify ` +
        "`attachment_index` or `filename` to choose one.",
    },
  };
}

const BOTH_SHAPES =
  "Each attachment is either inline bytes " +
  "{ filename, mime_type, data } with data base64-encoded, or a reference to a " +
  "file already in this inbox { source_message_id, attachment_index } " +
  "(attachment_index or filename may be omitted when the source message has " +
  "exactly one attachment). A reference never carries data.";

/**
 * Classify every entry of a caller's `attachments` array.
 *
 * Refuses rather than guesses. An entry carrying BOTH `data` and
 * `source_message_id` is the dangerous case: either branch is defensible, they
 * attach different files, and the caller would have no way to tell which one
 * the recipient received. Same for a reference whose `attachment_index` is not
 * a non-negative integer — silently coercing 1.5 or "0" would pick a file
 * nobody named.
 */
export function parseAttachmentInputs(
  tool: string,
  raw: unknown,
  limits: AttachmentParseLimits,
): AttachmentSpecs | AttachmentSpecError {
  if (raw === undefined || raw === null) {
    return { ok: true, specs: [], inlineBytes: 0, referenceCount: 0 };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: "-32602",
      message: `${tool}: attachments must be an array when provided.`,
    };
  }
  if (raw.length > limits.maxItems) {
    return {
      ok: false,
      code: "-32602",
      message:
        `${tool}: attachments must not exceed ${limits.maxItems} items per call.`,
    };
  }

  const specs: AttachmentSpec[] = [];
  let inlineBytes = 0;
  let referenceCount = 0;

  for (let position = 0; position < raw.length; position++) {
    const entry = raw[position];
    if (!isRecord(entry)) {
      return {
        ok: false,
        code: "-32602",
        message: `${tool}: attachments[${position}] must be an object. ${BOTH_SHAPES}`,
      };
    }

    const hasReference = entry["source_message_id"] !== undefined;
    const hasData = entry["data"] !== undefined;

    if (hasReference && hasData) {
      return {
        ok: false,
        code: "-32602",
        message:
          `${tool}: attachments[${position}] carries both data and ` +
          `source_message_id, so which file to attach is ambiguous. Send one or ` +
          `the other. ${BOTH_SHAPES}`,
      };
    }

    if (hasReference) {
      const sourceMessageId = entry["source_message_id"];
      if (typeof sourceMessageId !== "string" || sourceMessageId.trim() === "") {
        return {
          ok: false,
          code: "-32602",
          message:
            `${tool}: attachments[${position}].source_message_id must be a ` +
            `non-empty message id, as returned by email_read.`,
        };
      }
      const reference: AttachmentReferenceInput = {
        source_message_id: sourceMessageId.trim(),
      };

      const index = entry["attachment_index"];
      if (index !== undefined) {
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
          return {
            ok: false,
            code: "-32602",
            message:
              `${tool}: attachments[${position}].attachment_index must be a ` +
              `non-negative integer.`,
          };
        }
        reference.attachment_index = index;
      }

      const filename = entry["filename"];
      if (filename !== undefined) {
        if (typeof filename !== "string" || filename.trim() === "") {
          return {
            ok: false,
            code: "-32602",
            message:
              `${tool}: attachments[${position}].filename must be a non-empty ` +
              `string when provided.`,
          };
        }
        reference.filename = filename.trim();
      }

      specs.push({ kind: "reference", position, reference });
      referenceCount++;
      continue;
    }

    const filename = entry["filename"];
    const mimeType = entry["mime_type"];
    if (
      typeof filename !== "string" ||
      typeof mimeType !== "string" ||
      typeof entry["data"] !== "string"
    ) {
      return {
        ok: false,
        code: "-32602",
        message: `${tool}: attachments[${position}] is not a usable ${
          hasData ? "inline attachment" : "attachment"
        }. ${BOTH_SHAPES}`,
      };
    }

    const data = entry["data"] as string;
    const decoded = decodedBase64ByteLength(data);
    if (decoded === null) {
      return {
        ok: false,
        code: "-32602",
        message:
          `${tool}: attachments[${position}].data must be valid base64. To send ` +
          `a file that is already in this inbox, reference it with ` +
          `{ source_message_id, attachment_index } instead of re-encoding it.`,
      };
    }

    inlineBytes += decoded;
    if (inlineBytes > limits.maxInlineBytes) {
      return {
        ok: false,
        code: "attachment_too_large",
        message: attachmentTooLargeMessage(
          tool,
          inlineBytes,
          limits.maxInlineBytes,
        ),
      };
    }

    specs.push({
      kind: "inline",
      position,
      attachment: { filename, mime_type: mimeType, data },
      bytes: decoded,
    });
  }

  return { ok: true, specs, inlineBytes, referenceCount };
}
