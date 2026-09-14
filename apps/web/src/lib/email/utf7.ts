/**
 * lib/email/utf7.ts — IMAP "modified UTF-7" mailbox-name codec (RFC 3501 5.1.3).
 *
 * A DELIBERATE, VERBATIM COPY of supabase/functions/mcp-server/utf7.ts.
 *
 * Everything below the header comment is byte-for-byte the same source as the
 * edge function's copy, and "the two copies of the modified-UTF-7 codec agree"
 * (in utf7.test.ts here, and again in the Deno suite over there) fails the build
 * the moment that stops being true.
 *
 * Why a copy rather than a shared module. The other holder of this code is a
 * Supabase edge function, which is deployed on its own with
 * `supabase functions deploy` and bundles only what lives under
 * supabase/functions/. No edge function in this repo imports anything from
 * outside that tree, and packages/ holds the published npm CLI, not shared
 * source, so there is no existing path a Deno bundle and a Next build could
 * both resolve. This repo already answers that situation with a copy plus a
 * drift test — see "the three copies of the character class agree" in
 * supabase/functions/mcp-server/text-safety.test.ts — and this follows it.
 *
 * The bug it exists to fix, on this side: mailbox names travel the wire in a
 * 7-bit encoding, so the dashboard's IMAP client showed a folder named
 * "مجلد اختبار" as the raw wire string "&BkUGLAZEBi8- &BicGLgYqBigGJwYx-", and
 * would have sent SELECT for a name in a form no server accepts.
 *
 * See the edge function's copy for the encoding rules and the reasoning behind
 * decoding being total.
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
