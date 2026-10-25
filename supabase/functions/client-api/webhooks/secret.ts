// ---------------------------------------------------------------------------
// Decrypt a stored webhook signing secret.
//
// Same scheme as inbox passwords and OAuth tokens: AES-256-GCM under
// ENCRYPTION_KEY (64 hex characters), stored as base64url(IV(12) ||
// ciphertext || tag(16)). Encrypted by apps/web/src/lib/crypto.ts when the
// endpoint is created; mcp-server/index.ts `decryptStoredToken` is the same
// decryption for inbox credentials. The plaintext lives in memory for one
// signature and is never logged.
// ---------------------------------------------------------------------------

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function createSecretDecryptor(keyHex: string | undefined): (ciphertext: string) => Promise<string> {
  let key: Promise<CryptoKey> | null = null;
  const loadKey = (): Promise<CryptoKey> => {
    if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) return Promise.reject(new Error("encryption_key_missing"));
    key ??= crypto.subtle.importKey(
      "raw",
      Uint8Array.from(keyHex.match(/../g)!.map((pair) => parseInt(pair, 16))),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    return key;
  };
  return async (ciphertext) => {
    const raw = fromBase64Url(ciphertext);
    if (raw.length < 12 + 16 + 1) throw new Error("secret_ciphertext_invalid");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), tagLength: 128 }, await loadKey(), raw.slice(12));
    return new TextDecoder().decode(plain);
  };
}

/** The inverse, for tests (production encrypts in the web app). */
export async function encryptSecretForTests(keyHex: string, plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyHex.match(/../g)!.map((pair) => parseInt(pair, 16))),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode(plaintext)));
  const all = new Uint8Array(iv.length + sealed.length);
  all.set(iv, 0);
  all.set(sealed, iv.length);
  let binary = "";
  for (const b of all) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
