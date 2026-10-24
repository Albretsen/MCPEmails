// ---------------------------------------------------------------------------
// AES-256-GCM for values stored at rest: OAuth tokens, IMAP passwords, and the
// encrypted plans of the card tools (bulk_plans, send_approvals,
// subscription_plans).
//
// Wire format, unchanged since the first version: base64url(IV(12) ||
// ciphertext || authTag(16)), no padding. Mirror of
// `apps/web/src/lib/crypto.ts#encryptToken`, so either side reads what the
// other wrote.
//
// Moved out of index.ts (which cannot be imported by a test) on 2026-10-24.
// The old encoder did `btoa(String.fromCharCode(...combined))` over the whole
// buffer: one argument per byte. Fine for a 200-byte token, and a "Maximum
// call stack size exceeded" for a subscriptions_scan plan of a 2000-message
// scan (every message id of every sender, a few hundred KB). The encoder now
// works in 3-byte-aligned chunks, which produces exactly the same characters.
// ---------------------------------------------------------------------------

/**
 * Bytes per `String.fromCharCode` call. MUST stay a multiple of 3: base64 maps
 * 3 bytes to 4 characters, so only a 3-aligned boundary keeps `btoa` from
 * padding in the middle. 8190 = 2730 * 3, far below any engine's argument limit.
 */
const CHUNK_BYTES = 8190;

/** Standard base64 of `bytes`, chunk by chunk. Identical to one `btoa` over all of it. */
export function bytesToBase64Chunked(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + CHUNK_BYTES))));
  }
  return parts.join("");
}

/** base64url without padding, as stored. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64Chunked(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** The inverse of {@link bytesToBase64Url}; accepts padded or unpadded input. */
export function base64UrlToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binaryStr = atob(padded);
  const raw = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) raw[i] = binaryStr.charCodeAt(i);
  return raw;
}

function keyBytesFromHex(keyHex: string): Uint8Array<ArrayBuffer> {
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16);
  return keyBytes;
}

function configuredKeyHex(): string {
  const keyHex = Deno.env.get("ENCRYPTION_KEY");
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("ENCRYPTION_KEY env var is not set or is not 64 hex characters.");
  }
  return keyHex;
}

/**
 * Decrypts what {@link encryptForStorage} (or the web app's `encryptToken`)
 * wrote. ENCRYPTION_KEY must be the 64-character hex key that encrypted it.
 *
 * @throws if ENCRYPTION_KEY is misconfigured or if decryption fails.
 */
export async function decryptStoredToken(encrypted: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytesFromHex(configuredKeyHex()),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const raw = base64UrlToBytes(encrypted);
  if (raw.length < 12 + 16) throw new Error("Encrypted token is too short to be valid.");
  const iv = raw.slice(0, 12);
  // raw.slice(12) = ciphertext || authTag, exactly what Web Crypto AES-GCM needs.
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    cryptoKey,
    raw.slice(12),
  );
  return new TextDecoder().decode(decrypted);
}

/**
 * Encrypts `plaintext` with AES-256-GCM under ENCRYPTION_KEY and returns
 * base64url(IV || ciphertext || authTag).
 */
export async function encryptForStorage(plaintext: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytesFromHex(Deno.env.get("ENCRYPTION_KEY")!),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  );
  // IV || ciphertext || authTag (Web Crypto appends the tag).
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  return bytesToBase64Url(combined);
}
