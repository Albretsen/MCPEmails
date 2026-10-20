// ---------------------------------------------------------------------------
// address-header.ts — RFC 5322 address lists, parsed STRUCTURE FIRST (2026-10-16).
//
// ── THE RULE THIS FILE EXISTS FOR ──────────────────────────────────────────
// An address header is split into mailboxes and each mailbox into
// (display-name, address) on the RAW header text. Only after that is the
// display-name phrase RFC 2047-decoded. The address is never decoded.
//
// Until 2026-10-16 every IMAP path did the opposite:
//   parseAddressList(decodeEncodedWords(header))
// which let a sender put commas, angle brackets and CRLF inside an encoded
// display name and have them become STRUCTURE: an extra recipient (an encoded
// "exfil@evil.com,"), or, through a stored draft decoded a second time at
// send, a CRLF inside the SMTP envelope (RCPT TO command injection). Decoding
// after splitting makes the decoded text inert: it can only ever be a name.
//
// Names that come out of here have control characters collapsed to a space,
// so a decoded CRLF cannot reach any header or log line downstream.
//
// Pure and dependency-free except for the RFC 2047 decoder.
// ---------------------------------------------------------------------------

import { decodeEncodedWords } from "./mime.ts";

export interface MailboxEntry {
  name: string;
  email: string;
}

/**
 * Which encoded-words in a display name are decoded.
 *
 *   * "none"     — the input is already display text (Gmail's decoded header
 *                  values, a model-supplied "Name <addr>", our own display form).
 *   * "unquoted" — RFC 2047 §5 strictly: encoded-words in atoms only, never
 *                  inside a quoted-string. Used where we RE-WRITE a mailbox
 *                  into a header, so a quoted literal "=?...?=" stays literal
 *                  and is never decoded a second time.
 *   * "all"      — also inside quoted-strings, which several real mailers
 *                  write and every major client decodes anyway. Used for raw
 *                  headers read from a message. Only the NAME is affected.
 */
export type NameDecoding = "none" | "unquoted" | "all";

// deno-lint-ignore no-control-regex
const CONTROL_RUN = /[\x00-\x1F\x7F]+/g;

/** Collapse every run of control characters (CR/LF included) to one space. */
export function stripHeaderControls(value: string): string {
  return value.replace(CONTROL_RUN, " ");
}

/** True when the value holds any C0 control character or DEL. */
export function hasHeaderControls(value: string): boolean {
  // deno-lint-ignore no-control-regex
  return /[\x00-\x1F\x7F]/.test(value);
}

/**
 * Split an address-list into its mailbox strings at top-level commas, i.e.
 * commas outside quoted-strings, comments and angle-addrs. Group syntax
 * (`Team: a@x, b@y;`) contributes its members; the group's own name is not a
 * mailbox, and an empty group (`undisclosed-recipients:;`) contributes none.
 */
export function splitAddressList(header: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuote = false;
  let comment = 0;
  let angle = 0;
  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (inQuote) {
      current += ch;
      if (ch === "\\" && i + 1 < header.length) current += header[++i];
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (comment > 0) {
      current += ch;
      if (ch === "\\" && i + 1 < header.length) current += header[++i];
      else if (ch === "(") comment++;
      else if (ch === ")") comment--;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      current += ch;
    } else if (ch === "(") {
      comment++;
      current += ch;
    } else if (ch === "<") {
      angle++;
      current += ch;
    } else if (ch === ">") {
      if (angle > 0) angle--;
      current += ch;
    } else if (angle === 0 && ch === ",") {
      push();
    } else if (angle === 0 && ch === ":") {
      // A group name ends here; what precedes it is not an address.
      current = "";
    } else if (angle === 0 && ch === ";") {
      push();
    } else {
      current += ch;
    }
  }
  push();
  return out;
}

interface Piece {
  text: string;
  quoted: boolean;
}

/** Tokenise a phrase into quoted and unquoted runs, dropping comments. */
function phrasePieces(phrase: string): { pieces: Piece[]; comments: string[] } {
  const pieces: Piece[] = [];
  const comments: string[] = [];
  let plain = "";
  const flushPlain = () => {
    if (plain) pieces.push({ text: plain, quoted: false });
    plain = "";
  };
  for (let i = 0; i < phrase.length; i++) {
    const ch = phrase[i];
    if (ch === '"') {
      flushPlain();
      let q = "";
      i++;
      for (; i < phrase.length; i++) {
        const c = phrase[i];
        if (c === "\\" && i + 1 < phrase.length) q += phrase[++i];
        else if (c === '"') break;
        else q += c;
      }
      pieces.push({ text: q, quoted: true });
    } else if (ch === "(") {
      let depth = 1;
      let c = "";
      i++;
      for (; i < phrase.length && depth > 0; i++) {
        const x = phrase[i];
        if (x === "\\" && i + 1 < phrase.length) c += phrase[++i];
        else if (x === "(") {
          depth++;
          c += x;
        } else if (x === ")") {
          depth--;
          if (depth > 0) c += x;
        } else c += x;
      }
      i--;
      comments.push(c);
      plain += " ";
    } else {
      plain += ch;
    }
  }
  flushPlain();
  return { pieces, comments };
}

function decodeText(text: string, quoted: boolean, mode: NameDecoding): string {
  if (mode === "all" || (mode === "unquoted" && !quoted)) return decodeEncodedWords(text);
  return text;
}

/** The display text of a phrase: quotes removed, escapes resolved, decoded per `mode`. */
function phraseText(phrase: string, mode: NameDecoding): { name: string; comments: string[] } {
  const { pieces, comments } = phrasePieces(phrase);
  // Adjacent unquoted runs decode together so RFC 2047's "whitespace between
  // two encoded-words is dropped" still applies across them.
  const name = pieces.map((p) => decodeText(p.text, p.quoted, mode)).join("");
  return { name, comments: comments.map((c) => decodeText(c, false, mode)) };
}

function cleanName(name: string): string {
  let n = stripHeaderControls(name).replace(/\s+/g, " ").trim();
  // 'Name' <addr> — a legacy convention some senders use.
  if (n.length >= 2 && n.startsWith("'") && n.endsWith("'")) n = n.slice(1, -1).trim();
  return n;
}

/**
 * Index of the `<` that opens the mailbox's angle-addr: the last top-level one
 * (outside quotes and comments) that is closed by a `>` ending the string.
 */
function angleStart(s: string): number {
  let inQuote = false;
  let comment = 0;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === "\\") i++;
      else if (ch === '"') inQuote = false;
    } else if (comment > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") comment++;
      else if (ch === ")") comment--;
    } else if (ch === '"') inQuote = true;
    else if (ch === "(") comment++;
    else if (ch === "<") last = i;
  }
  return last;
}

/**
 * Parse ONE mailbox ("Name <addr>", "addr", "addr (Name)") without splitting.
 * The address is taken from the raw text and is never decoded; the name is
 * decoded per `mode` and stripped of control characters.
 */
export function parseMailbox(raw: string, mode: NameDecoding = "none"): MailboxEntry {
  const s = raw.trim();
  const close = s.lastIndexOf(">");
  const trailing = close === -1 ? "" : s.slice(close + 1);
  const trailingIsComment = close !== -1 && /^\s*(\(.*\))?\s*$/.test(trailing);
  let lt = close !== -1 && trailingIsComment ? angleStart(s.slice(0, close)) : -1;
  // A malformed phrase (an unterminated quote) hides every `<` from the
  // scanner; the address is still the last angle-addr.
  if (lt === -1 && close !== -1 && trailingIsComment) {
    const fallback = s.lastIndexOf("<", close);
    if (fallback !== -1) lt = fallback;
  }
  if (lt !== -1 && close > lt) {
    const email = s.slice(lt + 1, close).trim();
    const { name, comments } = phraseText(s.slice(0, lt), mode);
    const cleaned = cleanName(name);
    return { name: cleaned || cleanName(comments.join(" ")), email };
  }
  // Bare addr-spec, possibly with a trailing (Name) comment.
  const { pieces, comments } = phrasePieces(s);
  if (comments.length > 0 && pieces.every((p) => !p.quoted)) {
    const email = pieces.map((p) => p.text).join("").trim();
    return {
      name: cleanName(comments.map((c) => decodeText(c, false, mode)).join(" ")),
      email,
    };
  }
  return { name: "", email: s };
}

/** Split and parse an address-list that is already display text (no decoding). */
export function parseAddressList(header: string, mode: NameDecoding = "none"): MailboxEntry[] {
  if (!header || !header.trim()) return [];
  return splitAddressList(header).map((m) => parseMailbox(m, mode));
}

/**
 * Parse a RAW address header read from a message (IMAP / stored MIME): the
 * structure is read on the raw text, then each display name is decoded.
 * This replaces `parseAddressList(decodeEncodedWords(header))`, which must
 * never be written again.
 */
export function parseAddressHeader(header: string | null | undefined): MailboxEntry[] {
  return parseAddressList(header ?? "", "all");
}

/** The first mailbox of a raw address header (From), or an empty entry. */
export function parseMailboxHeader(header: string | null | undefined): MailboxEntry {
  return parseAddressHeader(header)[0] ?? { name: "", email: "" };
}

/** Characters that make a display name ambiguous to re-parse unless quoted. */
const DISPLAY_NEEDS_QUOTES = /["\\,;:<>()[\]]|=\?/;

/**
 * Render a mailbox as DISPLAY text ("Name <addr>"), the form DraftParams and
 * draft_read carry. Non-ASCII stays as text (it is shown to people and the
 * model); a name holding a special is quoted so the string still parses back
 * to exactly one mailbox ("Doe, Jane" stays one recipient), and a name that
 * looks like an encoded-word is quoted so it is never decoded again. Header
 * encoding happens later, in mime-build.ts, for every recipient it writes.
 */
export function formatMailboxDisplay(entry: MailboxEntry): string {
  const email = entry.email.trim();
  const name = cleanName(entry.name ?? "");
  if (!name) return email;
  const shown = DISPLAY_NEEDS_QUOTES.test(name)
    ? `"${name.replace(/["\\]/g, (c) => `\\${c}`)}"`
    : name;
  return `${shown} <${email}>`;
}

/**
 * The address part made safe to write between `<` `>` in a header: whitespace,
 * control characters, angle brackets and list/group delimiters removed. A real
 * address never contains any of them; anything that did can no longer split
 * the field or start a new line.
 */
export function headerSafeAddress(email: string): string {
  // deno-lint-ignore no-control-regex
  return email.replace(/[\x00-\x20\x7F<>,;]/g, "");
}

/** True when an envelope address holds anything that could break an SMTP command line. */
export function unsafeEnvelopeAddress(address: string): boolean {
  // deno-lint-ignore no-control-regex
  return address.length === 0 || /[\x00-\x20\x7F<>]/.test(address);
}
