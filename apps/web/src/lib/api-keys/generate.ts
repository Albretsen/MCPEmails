import crypto from 'node:crypto';

const KEY_PREFIX = 'mcpe_';
const KEY_BYTE_LENGTH = 32; // 256 bits of entropy

export interface GeneratedKey {
  /** The full raw key, shown once to the user, then discarded. Never persisted. */
  rawKey: string;
  /** SHA-256 hex digest of rawKey, the only value stored in the database. */
  keyHash: string;
  /** First 8 characters of the hex suffix, stored for display, not authentication. */
  keyPrefix: string;
}

/**
 * Generate a new MCP API key.
 *
 * The returned `rawKey` MUST be shown to the user immediately and then discarded.
 * Store only `keyHash` and `keyPrefix`. This function must not be called more than
 * once per user-initiated key creation; there is no way to recover a lost raw key.
 *
 * Key format: mcpe_<64 lowercase hex characters>
 * Total length: 69 characters (5 prefix + 64 suffix)
 * Entropy: 256 bits from CSPRNG
 */
export function generateApiKey(): GeneratedKey {
  // 32 bytes of CSPRNG output: 256 bits of entropy.
  const randomBytes = crypto.randomBytes(KEY_BYTE_LENGTH);

  // Hex-encode for a fixed-length, unambiguous string.
  const suffix = randomBytes.toString('hex'); // 64 lowercase hex characters

  const rawKey = KEY_PREFIX + suffix;

  // Hash immediately; the raw key must not be logged or stored at any point after this.
  const keyHash = hashApiKey(rawKey);

  // First 8 characters of the suffix for dashboard display.
  const keyPrefix = suffix.slice(0, 8);

  return { rawKey, keyHash, keyPrefix };
}

/**
 * Hash an API key (raw or incoming bearer token) with SHA-256.
 *
 * SHA-256 is appropriate here, not bcrypt, because the pre-image has 256 bits
 * of CSPRNG entropy. No dictionary attack applies. bcrypt's deliberate slowness
 * would add unacceptable latency to every MCP tool call for zero security gain.
 *
 * This function must be used both at key-creation time (in the Route Handler)
 * and at authentication time (in the Edge Function), producing identical output.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}
