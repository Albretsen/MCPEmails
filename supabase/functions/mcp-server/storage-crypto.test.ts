// Unit tests for storage-crypto.ts: the chunked base64url encoder must be
// byte-identical to the old whole-buffer `btoa(String.fromCharCode(...x))`
// (stored OAuth tokens and plans were written by it), and a plan-sized value
// must round-trip without overflowing the stack (subscriptions_scan,
// 2026-10-24: "Maximum call stack size exceeded" on a 2000-message scan).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  base64UrlToBytes,
  bytesToBase64Chunked,
  bytesToBase64Url,
  decryptStoredToken,
  encryptForStorage,
} from "./storage-crypto.ts";

/** Invented key, 32 bytes of hex. */
const TEST_KEY = "7c".repeat(32);

function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get("ENCRYPTION_KEY");
  Deno.env.set("ENCRYPTION_KEY", TEST_KEY);
  return fn().finally(() => {
    if (previous === undefined) Deno.env.delete("ENCRYPTION_KEY");
    else Deno.env.set("ENCRYPTION_KEY", previous);
  });
}

function pseudoRandomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** The encoder this replaced, verbatim. Only safe for small inputs. */
function oldEncoder(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** A reference with no spread at all: one character at a time, one btoa. */
function referenceBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

Deno.test("base64url: identical to the old whole-buffer encoder around every chunk boundary", () => {
  const sizes = [0, 1, 2, 3, 4, 28, 100, 8189, 8190, 8191, 8192, 16379, 16380, 16381, 24571, 30000];
  for (const n of sizes) {
    const bytes = pseudoRandomBytes(n, n + 7);
    assertEquals(bytesToBase64Url(bytes), oldEncoder(bytes), `size ${n}`);
    assertEquals(bytesToBase64Chunked(bytes), referenceBase64(bytes), `size ${n} (padded)`);
  }
});

Deno.test("base64url: a 1 MB buffer encodes without a stack overflow and decodes back exactly", () => {
  const bytes = pseudoRandomBytes(1024 * 1024 + 5);
  const encoded = bytesToBase64Url(bytes);
  assertEquals(encoded, referenceBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""));
  assertEquals(base64UrlToBytes(encoded), bytes);
});

Deno.test("encryptForStorage: a ~1 MB plan round-trips through decryptStoredToken", async () => {
  await withKey(async () => {
    // Shaped like a subscription plan: many senders, each with message ids.
    const senders = Array.from({ length: 200 }, (_, i) => ({
      sender_key: `list:news${i}.example.com`,
      archive_ids: Array.from({ length: 400 }, (_, j) => `INBOX:${i * 1000 + j}`),
    }));
    const plaintext = JSON.stringify(senders) + "é€😀".repeat(1000);
    assert(plaintext.length > 1_000_000, `plaintext is ${plaintext.length} chars`);
    const encrypted = await encryptForStorage(plaintext);
    assert(/^[A-Za-z0-9_-]+$/.test(encrypted), "base64url, no padding");
    const raw = base64UrlToBytes(encrypted);
    assertEquals(raw.length, 12 + new TextEncoder().encode(plaintext).length + 16, "IV || ciphertext || tag");
    assertEquals(await decryptStoredToken(encrypted), plaintext);
  });
});

Deno.test("decryptStoredToken: reads a token written by the old encoder", async () => {
  await withKey(async () => {
    const keyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(TEST_KEY.substring(i * 2, i * 2 + 2), 16);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode("ya29.token")),
    );
    const all = new Uint8Array(12 + ct.byteLength);
    all.set(iv, 0);
    all.set(ct, 12);
    assertEquals(await decryptStoredToken(oldEncoder(all)), "ya29.token");
  });
});
