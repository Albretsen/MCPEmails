import crypto from 'node:crypto';

/**
 * Shared cryptographic utilities for the OAuth 2.0 server.
 * All functions are synchronous and use Node.js built-in crypto.
 */

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 raw digest of a UTF-8 string, returned as a Buffer. */
export function sha256raw(input: string): Buffer {
  return crypto.createHash('sha256').update(input, 'utf8').digest();
}

/**
 * Encode a Buffer as a base64url string (URL-safe, no padding).
 * Per RFC 4648 §5: '+' → '-', '/' → '_', trailing '=' stripped.
 */
export function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Compute the PKCE S256 code_challenge from a plain code_verifier.
 * Per RFC 7636 §4.2: BASE64URL(SHA-256(ASCII(code_verifier)))
 */
export function computeS256Challenge(codeVerifier: string): string {
  return base64urlEncode(sha256raw(codeVerifier));
}

/**
 * Generate a refresh token: `mcpr_` prefix + 32 bytes of CSPRNG entropy,
 * base64url-encoded. Never stored as plaintext; caller must hash with sha256hex.
 */
export function generateRefreshToken(): string {
  const bytes = crypto.randomBytes(32);
  return `mcpr_${base64urlEncode(bytes)}`;
}
