/**
 * Referral codes: eight characters from CODE_ALPHABET.
 *
 * UNBIASED BY REJECTION SAMPLING. 256 is not a multiple of 31, so `byte % 31`
 * alone would make the first eight characters (256 - 8 * 31 = 8 leftover
 * byte values) slightly likelier. Bytes at or above 248 (the largest multiple of 31 under
 * 256) are thrown away and more are drawn, so every accepted byte maps to one
 * character with exactly equal probability. About 3% of bytes are rejected.
 *
 * `randomBytes` is injectable so tests are deterministic; the default is the
 * Web Crypto CSPRNG, which Node, the edge runtime and browsers all provide.
 */

import { CODE_ALPHABET, CODE_LENGTH } from './constants.ts';

const ALPHABET_SIZE = CODE_ALPHABET.length;
/** Largest multiple of ALPHABET_SIZE that fits in a byte: 248 for 31. */
const ACCEPT_BELOW = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

function defaultRandomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function generateReferralCode(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  let code = '';
  // Bounded so a broken source (all bytes >= 248) fails loudly, not forever.
  for (let round = 0; round < 64 && code.length < CODE_LENGTH; round += 1) {
    const bytes = randomBytes(CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= ACCEPT_BELOW) continue;
      code += CODE_ALPHABET[byte % ALPHABET_SIZE];
      if (code.length === CODE_LENGTH) break;
    }
  }
  if (code.length !== CODE_LENGTH) {
    throw new Error('generateReferralCode: random source returned no usable bytes');
  }
  return code;
}

/**
 * The canonical code for user input, or null. Case, surrounding and inner
 * whitespace and dashes are forgiven ("abcd-efgh", " ABCD EFGH "). Look-alike
 * characters (0, O, 1, I, L) are NOT mapped to anything: no code contains
 * them, so input holding one is refused rather than guessed at.
 */
export function normalizeReferralCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase().replace(/[\s-]+/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}
