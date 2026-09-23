// ---------------------------------------------------------------------------
// Setting a draft's recipients at send time (2026-09-23).
//
// `draft {action: "send", draft_id, to: [...]}` was refused, four times from
// four workspaces in ten days: the model had the draft and the recipient and
// was told to call `update` first. `update` is the wrong tool for it anyway. It
// requires a body, re-applies the signature to whatever body it is given, and
// rebuilds the message from fields, which on Gmail and IMAP drops every
// attachment the draft carried.
//
// So a recipient change at send time rewrites ONLY the To / Cc / Bcc header
// fields of the stored message and leaves every other octet where it was:
// body, attachments, signature, threading headers. On Gmail and IMAP that means
// editing the raw message; Outlook takes the recipient fields directly.
//
// The raw message is handled as a BYTE STRING, one character per octet (what
// `atob` returns, and what the IMAP client's latin1 read returns), so bytes
// outside ASCII in the body are never decoded and re-encoded. Addresses written
// into the headers are converted to their UTF-8 octets first for the same
// reason.
//
// Pure and dependency-free so it can be tested without booting the server.
// ---------------------------------------------------------------------------

/** The recipient lists to set. An absent list is left as stored. */
export interface RecipientOverride {
  to?: string[];
  cc?: string[];
  bcc?: string[];
}

/** The override a draft-send call carries, or null when it sets none. */
export function recipientOverrideFrom(args: Record<string, unknown>): RecipientOverride | null {
  const override: RecipientOverride = {};
  for (const field of ["to", "cc", "bcc"] as const) {
    const value = args[field];
    if (Array.isArray(value)) {
      override[field] = value.filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    }
  }
  return Object.keys(override).length > 0 ? override : null;
}

const HEADER_NAMES: Record<keyof RecipientOverride, string> = { to: "To", cc: "Cc", bcc: "Bcc" };

/** Longest header line written before folding (RFC 5322 recommends 78, requires under 998). */
const FOLD_AT = 76;

/** A string's UTF-8 octets, as a byte string. */
function utf8AsByteString(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join("");
}

/** `Name: a, b, c`, folded onto continuation lines when long. */
function headerField(name: string, addresses: readonly string[], eol: string): string {
  let line = `${name}: `;
  const lines: string[] = [];
  addresses.forEach((address, index) => {
    const piece = utf8AsByteString(address) + (index < addresses.length - 1 ? "," : "");
    if (line.trim().length > name.length + 1 && line.length + piece.length > FOLD_AT) {
      lines.push(line.trimEnd());
      line = " ";
    }
    line += piece + " ";
  });
  lines.push(line.trimEnd());
  return lines.join(eol);
}

/**
 * Replace the To / Cc / Bcc fields named in `override` in a raw message held as
 * a byte string. A list that is empty removes the field. Fields not named are
 * untouched, as is everything after the header block. `messageId`, when given,
 * replaces the Message-ID so a re-stored copy can be found by it.
 *
 * Returns null when the input has no header/body separator, i.e. is not a
 * message this function can safely edit.
 */
export function rewriteRecipientHeaders(
  raw: string,
  override: RecipientOverride,
  messageId?: string,
): string | null {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  let headerEnd: number;
  let eol: string;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    headerEnd = crlf;
    eol = "\r\n";
  } else if (lf !== -1) {
    headerEnd = lf;
    eol = "\n";
  } else {
    return null;
  }
  const headerBlock = raw.slice(0, headerEnd);
  const rest = raw.slice(headerEnd);

  // Group physical lines into fields: a line starting with space or tab
  // continues the field above it.
  const fields: string[] = [];
  for (const line of headerBlock.split(eol)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && fields.length > 0) {
      fields[fields.length - 1] += eol + line;
    } else {
      fields.push(line);
    }
  }

  const fieldName = (field: string) => field.slice(0, Math.max(0, field.indexOf(":"))).trim().toLowerCase();
  const replaced = new Set(
    (Object.keys(override) as Array<keyof RecipientOverride>).map((key) => HEADER_NAMES[key].toLowerCase()),
  );
  let kept = fields.filter((field) => !replaced.has(fieldName(field)));
  if (messageId !== undefined) {
    const stamped = `Message-ID: <${messageId}@mcpemails.com>`;
    const hadOne = kept.some((field) => fieldName(field) === "message-id");
    kept = kept.map((field) => fieldName(field) === "message-id" ? stamped : field);
    if (!hadOne) kept.push(stamped);
  }

  const added: string[] = [];
  for (const key of ["to", "cc", "bcc"] as const) {
    const addresses = override[key];
    if (addresses && addresses.length > 0) added.push(headerField(HEADER_NAMES[key], addresses, eol));
  }

  // New fields go right after From, where a mail client writes them; a message
  // with no From gets them first.
  const fromIndex = kept.findIndex((field) => fieldName(field) === "from");
  const at = fromIndex === -1 ? 0 : fromIndex + 1;
  const result = [...kept.slice(0, at), ...added, ...kept.slice(at)];
  return result.join(eol) + rest;
}

/**
 * A byte string as base64url, for Gmail's `raw`. Not mimeMessageToBase64url:
 * that one UTF-8-encodes its input, which would turn every octet above 0x7F in
 * a byte string into two.
 */
export function byteStringToBase64url(bytes: string): string {
  return btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
