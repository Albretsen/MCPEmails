/**
 * utf7.ts — IMAP "modified UTF-7" mailbox-name codec (RFC 3501 section 5.1.3).
 *
 * IMAP mailbox names travel the wire in a 7-bit encoding, not in UTF-8. Until
 * this module existed the client wrote folder names as raw UTF-8 octets and
 * read them back verbatim, so every non-ASCII folder name broke its own round
 * trip. Reproduced in production against Migadu on 2026-09-14:
 *
 *   folder_create "مجلد اختبار"            → reported success
 *   folder_list                            → "&BkUGLAZEBi8- &BicGLgYqBigGJwYx-"
 *   any folder argument "مجلد اختبار"      → folder_not_found
 *
 * i.e. the only string that worked was the wire form the caller never saw, and
 * the only string the caller saw was one the server would not accept.
 *
 * The rules, exactly:
 *
 *   * printable US-ASCII (0x20-0x7E) other than "&" stands for itself;
 *   * "&" is written "&-";
 *   * everything else is a run of modified BASE64 between "&" and "-", taken
 *     over the UTF-16BE octets of the run, over the alphabet A-Za-z0-9+, —
 *     note the comma in place of BASE64's "/" — with the "=" padding omitted.
 *
 * Two properties the callers depend on:
 *
 *   encode(decode(x)) === x   for well-formed x
 *   decode(encode(y)) === y   for every y
 *
 * DECODING IS TOTAL. Servers send junk — half-encoded names, "&" runs that
 * never close, names that are just raw UTF-8 because the server never
 * implemented 5.1.3 at all. None of that may throw, and none of it may produce
 * a half-mangled name that a later encode would turn into a different string
 * than the server holds. So anything that does not decode cleanly is returned
 * exactly as it arrived: a name we cannot interpret is still a name we can hand
 * back to the server unchanged.
 */

/** BASE64 with "," in place of "/" (RFC 3501 5.1.3), padding omitted. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

/** Reverse map for decoding; -1 for every octet that is not in the alphabet. */
const REVERSE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/**
 * Encode a human-readable mailbox name to its modified-UTF-7 wire form.
 *
 * Iteration is over UTF-16 code units rather than code points on purpose: the
 * encoding is defined over UTF-16BE octets, so a non-BMP character (an emoji
 * folder name) is a surrogate PAIR, two code units, four octets. Walking code
 * points and re-splitting them would be the same work done twice.
 */
export function encodeModifiedUtf7(name: string): string {
  let out = "";
  let run: number[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const octets: number[] = [];
    for (const unit of run) {
      octets.push((unit >> 8) & 0xff, unit & 0xff);
    }
    out += `&${base64Encode(octets)}-`;
    run = [];
  };

  for (let i = 0; i < name.length; i++) {
    const unit = name.charCodeAt(i);
    if (unit >= 0x20 && unit <= 0x7e) {
      flushRun();
      // "&" is the escape character, so a literal one is written "&-".
      out += unit === 0x26 ? "&-" : String.fromCharCode(unit);
    } else {
      run.push(unit);
    }
  }
  flushRun();
  return out;
}

/**
 * Decode a wire mailbox name back to its human-readable form.
 *
 * Never throws. Returns the input verbatim when it is not well-formed
 * modified UTF-7, which also covers the non-compliant servers that simply send
 * raw UTF-8: such a name has no "&" run at all and falls straight through.
 */
export function decodeModifiedUtf7(wire: string): string {
  // Fast path, and the whole of the raw-UTF-8 case: no escape, nothing to do.
  if (!wire.includes("&")) return wire;

  let out = "";
  let i = 0;
  while (i < wire.length) {
    const ch = wire[i];
    if (ch !== "&") {
      out += ch;
      i++;
      continue;
    }
    if (wire[i + 1] === "-") {
      out += "&";
      i += 2;
      continue;
    }
    const end = wire.indexOf("-", i + 1);
    // An unterminated run is illegal. Per the contract above we do not guess
    // where it was meant to end; the whole name comes back untouched.
    if (end === -1) return wire;
    const decoded = decodeRun(wire.slice(i + 1, end));
    if (decoded === null) return wire;
    out += decoded;
    // RFC 3501: the "-" that closes a run is absorbed, not emitted.
    i = end + 1;
  }
  return out;
}

/** Modified BASE64 over a byte sequence, "=" padding omitted. */
function base64Encode(octets: number[]): string {
  let out = "";
  for (let i = 0; i < octets.length; i += 3) {
    const b0 = octets[i];
    const b1 = octets[i + 1];
    const b2 = octets[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 0b111111];
  }
  return out;
}

/**
 * Decode one modified-BASE64 run (the text strictly between "&" and "-") into
 * the characters it stands for, or null when the run is not well-formed.
 *
 * Lone surrogates are passed through rather than rejected. They are not valid
 * Unicode, but they are valid JavaScript string contents, and re-emitting the
 * code unit we were given keeps `decode(encode(y)) === y` true for every string
 * a caller can actually construct — which matters more here than policing a
 * server's Unicode hygiene on a name we are only going to quote and send back.
 *
 * C0/C7 control characters are the one exception: a run that decodes to one
 * (e.g. "&AAA-" → U+0000) is treated as junk, because a control character
 * cannot legally appear in a mailbox name and the client refuses to put one
 * back on the wire. Returning the wire form verbatim keeps the name usable.
 */
function decodeRun(b64: string): string | null {
  // An empty run is "&-" handled by the caller; "&" immediately followed by "-"
  // never reaches here, so an empty run at this point means "&&…" style junk.
  if (b64.length === 0) return null;
  // A single leftover BASE64 character carries 6 bits, which cannot complete an
  // octet: no valid encoding ends that way.
  if (b64.length % 4 === 1) return null;

  const octets: number[] = [];
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < b64.length; i++) {
    const code = b64.charCodeAt(i);
    const value = code < 128 ? REVERSE[code] : -1;
    if (value < 0) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      octets.push((acc >> bits) & 0xff);
    }
  }
  // Whatever is left over is padding, and padding bits must be zero.
  if (bits >= 6) return null;
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  // UTF-16BE: an odd octet count is half a code unit.
  if (octets.length % 2 !== 0) return null;

  let out = "";
  for (let i = 0; i < octets.length; i += 2) {
    const unit = (octets[i] << 8) | octets[i + 1];
    if (unit <= 0x1f || unit === 0x7f) return null;
    out += String.fromCharCode(unit);
  }
  return out;
}
