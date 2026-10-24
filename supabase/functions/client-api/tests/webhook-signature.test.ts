// The signature format, pinned to a fixed vector. The same vector is pinned
// in apps/web/src/lib/webhooks/sign.test.ts, and was computed independently
// with `openssl dgst -sha256 -hmac`, so the edge, the web app and a receiver
// following the docs all agree.

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createSecretDecryptor, encryptSecretForTests } from "../webhooks/secret.ts";
import { hmacSha256Hex, newEventId, signatureHeader, verifySignature } from "../webhooks/sign.ts";

const SECRET = `whsec_${"5a".repeat(32)}`;
const T = 1761300000;
const BODY = '{"id":"evt_0123456789abcdef0123456789abcdef","type":"ping"}';
const EXPECTED = "c32330190696c5030a0e27c1d1a00fbee30675fcc3d122f460ab9171266fe03f";

Deno.test("known vector: HMAC-SHA256(secret, t + '.' + body), hex", async () => {
  assertEquals(await hmacSha256Hex(SECRET, `${T}.${BODY}`), EXPECTED);
  assertEquals(await signatureHeader(SECRET, T, BODY), `t=${T},v1=${EXPECTED}`);
});

Deno.test("a fractional timestamp is floored, never rounded up", async () => {
  assertEquals(await signatureHeader(SECRET, T + 0.9, BODY), `t=${T},v1=${EXPECTED}`);
});

Deno.test("verify: accepts the header, refuses a changed body, a wrong secret and a stale timestamp", async () => {
  const header = `t=${T},v1=${EXPECTED}`;
  assert(await verifySignature(header, SECRET, BODY, T + 10));
  assert(!await verifySignature(header, SECRET, BODY.replace("ping", "pong"), T));
  assert(!await verifySignature(header, `whsec_${"5b".repeat(32)}`, BODY, T));
  assert(!await verifySignature(header, SECRET, BODY, T + 301), "outside the 5 minute tolerance");
  assert(!await verifySignature(header, SECRET, BODY, T - 301));
  assert(!await verifySignature(`v1=${EXPECTED}`, SECRET, BODY, T), "no timestamp");
  assert(await verifySignature(`t=${T},v1=${"0".repeat(64)},v1=${EXPECTED}`, SECRET, BODY, T), "any v1 may match (rotation)");
});

Deno.test("event ids are evt_ and 32 hex characters, and differ", () => {
  const a = newEventId();
  assertMatch(a, /^evt_[0-9a-f]{32}$/);
  assert(a !== newEventId());
});

Deno.test("the stored secret decrypts with ENCRYPTION_KEY (AES-256-GCM, IV || ciphertext || tag, base64url)", async () => {
  const key = "0f".repeat(32);
  const sealed = await encryptSecretForTests(key, SECRET);
  assert(!sealed.includes(SECRET.slice(6, 20)));
  assertEquals(await createSecretDecryptor(key)(sealed), SECRET);
  let threw = false;
  try {
    await createSecretDecryptor("1f".repeat(32))(sealed);
  } catch {
    threw = true;
  }
  assert(threw, "the wrong key fails the GCM tag");
  threw = false;
  try {
    await createSecretDecryptor(undefined)(sealed);
  } catch {
    threw = true;
  }
  assert(threw, "no key, no secret");
});
