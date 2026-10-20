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
// Pure (no I/O) so it can be tested without booting the server.
//
// SECURITY (2026-10-16): an entry is validated as a whole (no control
// characters anywhere, a valid address) and written back through
// mime-build.ts#headerAddressList, never as given, so a display name can no
// longer carry a CRLF into the stored message.
// ---------------------------------------------------------------------------

import { hasHeaderControls, parseMailbox } from "./address-header.ts";
import { headerAddressList } from "./mime-build.ts";

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

/**
 * The first entry of a draft-send recipient override that cannot be used, or
 * null when every entry can.
 *
 * `recipientOverrideFrom` drops what it cannot read (a non-string, a blank) and
 * writes everything else into the header as given, so a mistyped address was
 * either left off the mail without a word or stored as a recipient no server
 * will accept. A send is the last place to find that out, so the call is
 * refused instead and nothing is rewritten.
 *
 * An entry may be a bare address or `Name <address>`; the address part is what
 * is validated, with the validator every other send path uses. A blank string
 * is not a mistyped address and stays ignored, as before.
 */
export function invalidRecipientIn(
  args: Record<string, unknown>,
  isValidEmailAddress: (address: string) => boolean,
): { field: "to" | "cc" | "bcc"; entry: unknown } | null {
  for (const field of ["to", "cc", "bcc"] as const) {
    const value = args[field];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== "string") return { field, entry };
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      // A control character anywhere (a CRLF in the display name included)
      // is refused outright: it can only be an attempt to add a header.
      if (hasHeaderControls(trimmed)) return { field, entry };
      // One entry is one mailbox; its address part, read structurally (the
      // last angle-addr outside any quoted name), is what is validated.
      if (!isValidEmailAddress(parseMailbox(trimmed).email)) return { field, entry };
    }
  }
  return null;
}

/**
 * One header's value from a Gmail `payload.headers` list, or null.
 *
 * Case-insensitive on purpose. Gmail returns header names as the message
 * spells them, and RFC 5322 names are case-insensitive, so `CC:` written by
 * another mail client is the same field as the `Cc:` this server writes.
 */
export function gmailHeaderValue(
  headers: readonly { name: string; value: string }[] | null | undefined,
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  const found = (headers ?? []).find((h) =>
    typeof h?.name === "string" && h.name.toLowerCase() === wanted
  );
  return typeof found?.value === "string" ? found.value : null;
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
    // Re-serialized, not written as given: names RFC 2047-encoded, addresses
    // stripped of anything that could split the field (mime-build.ts).
    const addresses = headerAddressList(override[key] ?? []);
    if (addresses.length > 0) added.push(headerField(HEADER_NAMES[key], addresses, eol));
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
