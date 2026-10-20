// ---------------------------------------------------------------------------
// envelope-address.ts — the SMTP envelope form of a stored draft's recipient.
//
// PR #126 (2026-10-16) made IMAP draft_send check every To/Cc/Bcc address of a
// stored draft before it becomes a `RCPT TO:<...>` line, because a stored draft
// is not trusted input: another client, or a reply rebuilt from hostile mail,
// may have put anything in its headers. It used the same conservative check as
// email_send, which also refused three kinds of real address that Thunderbird
// and Apple Mail write and that sent fine before:
//
//   * an internationalised domain, `user@münchen.de`;
//   * a punycode top-level domain, `user@example.xn--p1ai`;
//   * a quoted local part, `"john.doe."@example.com`.
//
// This accepts those and returns the ASCII form SMTP is given: an IDN domain
// is converted to punycode (IDNA, as browsers and mail clients do). The
// security rule of #126 is unchanged: the result is a single addr-spec of
// printable ASCII with no whitespace, control character, angle bracket or
// second `@`-separated address, so it cannot add a command or a recipient to
// the SMTP session (assertEnvelopeSafe in smtp-client.ts still checks again).
//
// Not accepted, on purpose: a non-ASCII local part (needs SMTPUTF8 end to end),
// IP-literal domains, and a quoted local part holding a space (the envelope
// guard refuses whitespace in any envelope address).
//
// Pure and dependency-free.
// ---------------------------------------------------------------------------

const LABEL = "[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?";

/**
 * An ASCII domain: LDH labels and a top-level label that is either letters or
 * an IDNA A-label (`xn--...`). Shared with index.ts#isValidEmailAddress.
 */
export const ASCII_DOMAIN_RE = new RegExp(
  `^${LABEL}(?:\\.${LABEL})*\\.(?:[a-zA-Z]{2,63}|xn--[a-zA-Z0-9-]{1,59})$`,
);

/** The unquoted local part every send path has always accepted. */
const DOT_ATOM_LOCAL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/;

/**
 * A quoted local part: printable ASCII qtext or quoted-pairs, without space
 * and without `<` or `>` (both would break `RCPT TO:<...>`).
 */
const QUOTED_LOCAL_RE = /^"(?:[\x21\x23-\x3B\x3D\x3F-\x5B\x5D-\x7E]|\\[\x21-\x3B\x3D\x3F-\x7E])+"$/;

/** Characters that can never be part of a domain, before IDNA conversion. */
// deno-lint-ignore no-control-regex
const DOMAIN_FORBIDDEN = /[\x00-\x20\x7F<>@/\\:?#[\]%"'(),;]/;

/** An IDN domain to its ASCII (punycode) form, or null when it is not a domain. */
function asciiDomain(domain: string): string | null {
  if (!domain || domain.length > 253) return null;
  if (/^[\x21-\x7E]+$/.test(domain)) return ASCII_DOMAIN_RE.test(domain) ? domain : null;
  if (DOMAIN_FORBIDDEN.test(domain)) return null;
  let host: string;
  try {
    // The WHATWG URL parser applies UTS #46 / IDNA to the host, the same
    // conversion browsers and mail clients use for an internationalised name.
    host = new URL(`http://${domain}/`).hostname;
  } catch {
    return null;
  }
  if (!host || host.length > 253 || !ASCII_DOMAIN_RE.test(host)) return null;
  return host;
}

/**
 * The address SMTP should be given for this stored-draft recipient, or null
 * when it is not one deliverable address. Input is the addr-spec the address
 * parser took from the raw header (never a display name).
 */
export function envelopeAddress(address: string): string | null {
  const trimmed = (address ?? "").trim();
  if (!trimmed || trimmed.length > 320) return null;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = asciiDomain(trimmed.slice(at + 1));
  if (domain === null) return null;
  if (local.startsWith('"')) {
    if (!QUOTED_LOCAL_RE.test(local)) return null;
  } else if (!DOT_ATOM_LOCAL_RE.test(local)) {
    return null;
  }
  const out = `${local}@${domain}`;
  return out.length > 320 ? null : out;
}
