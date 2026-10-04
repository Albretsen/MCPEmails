// ---------------------------------------------------------------------------
// Octets as a string, one character per octet, exactly.
//
// The MIME parser, the IMAP tokenizer and the header rewriters all work on
// "byte strings": `charCodeAt(i)` IS octet i. That only holds if the string
// was built that way. `TextDecoder("latin1")` does not build it that way: under
// the WHATWG encoding standard the labels "latin1", "iso-8859-1" and "ascii"
// all mean windows-1252, which maps 27 of the octets 0x80-0x9F to code points
// above U+00FF (0x80 is U+20AC, 0x99 is U+2122). `charCodeAt(i) & 0xff` on
// such a string turns 0x80 into 0xAC and 0x99 into 0x22, so every UTF-8
// character with a continuation byte in that range ("’", "–", "€", "Ø", "Å",
// most CJK) came out of an 8bit body corrupted.
//
// Pure and dependency-free so it can be tested without booting the server.
// ---------------------------------------------------------------------------

/** Arguments per `String.fromCharCode` call: far below any engine's limit. */
const CHUNK_BYTES = 8192;

const WINDOWS_1252 = new TextDecoder("windows-1252");

/** Any code unit a single octet cannot be. */
// deno-lint-ignore no-control-regex -- the range IS the test.
const ABOVE_ONE_OCTET = /[^\x00-\xff]/;

function exactChunk(bytes: Uint8Array): string {
  return String.fromCharCode.apply(null, bytes as unknown as number[]);
}

/**
 * `bytes` as a string whose code units are the octets: all 256 values survive,
 * and `charCodeAt(i)` gives `bytes[i]` back.
 *
 * Bulk on purpose, this is the read path of every IMAP response. Two native
 * operations, no per-octet JavaScript:
 *
 *   * Above one chunk, try the windows-1252 decoder first and KEEP its answer
 *     only when it holds no code unit above U+00FF. windows-1252 is the
 *     identity everywhere except the 27 remapped octets, and every one of
 *     those maps above U+00FF, so "nothing above U+00FF" proves the decode was
 *     exact. That is the case for anything 7-bit on the wire (headers, 7bit,
 *     quoted-printable and base64 bodies), which then costs what it always
 *     did.
 *   * Otherwise `String.fromCharCode` over fixed chunks, which is exact for
 *     every octet.
 */
export function bytesToByteString(bytes: Uint8Array): string {
  if (bytes.length <= CHUNK_BYTES) return exactChunk(bytes);
  const fast = WINDOWS_1252.decode(bytes);
  if (!ABOVE_ONE_OCTET.test(fast)) return fast;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    parts.push(exactChunk(bytes.subarray(i, i + CHUNK_BYTES)));
  }
  return parts.join("");
}
