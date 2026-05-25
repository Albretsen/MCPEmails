import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * AES-256-GCM authenticated encryption for OAuth tokens and IMAP passwords.
 *
 * Ciphertext layout (base64url-encoded for text storage in Supabase):
 *   [ 12-byte IV ][ ciphertext ][ 16-byte GCM auth tag ]
 *
 * The encryption key is read from the ENCRYPTION_KEY environment variable,
 * which must be a 64-character hex string representing 32 bytes.
 *
 * Key must NEVER be logged, hard-coded, or included in client bundles.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        'Generate one with: openssl rand -hex 32'
    );
  }

  cachedKey = Buffer.from(keyHex, 'hex');
  return cachedKey;
}

/**
 * Encrypts a plaintext string and returns a base64url-encoded ciphertext
 * suitable for storing in a Supabase text/bytea column.
 */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Layout: IV || ciphertext || authTag
  return Buffer.concat([iv, encrypted, authTag]).toString('base64url');
}

/**
 * Decrypts a base64url-encoded ciphertext produced by encryptToken.
 * Throws if the ciphertext has been tampered with (GCM auth tag mismatch).
 */
export function decryptToken(ciphertext: string): string {
  const raw = Buffer.from(ciphertext, 'base64url');
  const key = getKey();

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(raw.length - TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
