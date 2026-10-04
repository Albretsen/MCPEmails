// Web Push crypto and transport (push/webpush.ts). No network: the push
// service is a fetch stand-in, and "the browser" is a key pair held here.

import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import {
  b64urlDecode,
  b64urlEncode,
  createPushSender,
  encryptPayload,
  isAllowedPushEndpoint,
  isAuthSecret,
  isP256PublicKey,
  isValidTopic,
  MAX_PLAINTEXT_BYTES,
  type PushMessage,
  type VapidConfig,
  vapidFromEnv,
  vapidToken,
} from "../push/webpush.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── RFC 8291, section 5 / appendix A ────────────────────────────────────────

const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function jwk(publicKey: string, privateKey: string): JsonWebKey {
  const point = b64urlDecode(publicKey);
  return {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(point.subarray(1, 33)),
    y: b64urlEncode(point.subarray(33, 65)),
    d: privateKey,
  };
}

async function ecdhPair(publicKey: string, privateKey: string): Promise<CryptoKeyPair> {
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  return {
    privateKey: await crypto.subtle.importKey("jwk", jwk(publicKey, privateKey), algorithm, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", b64urlDecode(publicKey), algorithm, true, []),
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, info: info as Uint8Array<ArrayBuffer> },
      key,
      bytes * 8,
    ),
  );
}

/** What a browser does with a push body: RFC 8291 section 4, the receiving side. */
async function browserDecrypt(body: Uint8Array, ua: CryptoKeyPair, uaPublic: string, auth: string): Promise<string> {
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16, false);
  const idLength = body[20];
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  assert(body.length <= recordSize, "one record, inside the declared record size");
  const asKey = await crypto.subtle.importKey("raw", asPublic as Uint8Array<ArrayBuffer>, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...b64urlDecode(uaPublic), ...asPublic]);
  const ikm = await hkdf(b64urlDecode(auth), secret, info, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, record as Uint8Array<ArrayBuffer>),
  );
  // Strip the padding delimiter: the last non-zero byte must be 0x02 (final record).
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assertEquals(plain[end], 2, "final-record delimiter");
  return decoder.decode(plain.subarray(0, end));
}

async function newBrowser(): Promise<{ pair: CryptoKeyPair; p256dh: string; auth: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const p256dh = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const auth = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  return { pair, p256dh, auth };
}

Deno.test("RFC 8291 test vector: the same inputs produce the RFC's message body, byte for byte", async () => {
  const body = await encryptPayload(
    encoder.encode(RFC.plaintext),
    { p256dh: RFC.uaPublic, auth: RFC.auth },
    { salt: b64urlDecode(RFC.salt), senderKeys: await ecdhPair(RFC.asPublic, RFC.asPrivate) },
  );
  assertEquals(b64urlEncode(body), RFC.body);
});

Deno.test("RFC 8291 test vector: the receiving side recovers the RFC's plaintext from the RFC's body", async () => {
  const ua = await ecdhPair(RFC.uaPublic, RFC.uaPrivate);
  assertEquals(await browserDecrypt(b64urlDecode(RFC.body), ua, RFC.uaPublic, RFC.auth), RFC.plaintext);
});

Deno.test("encryptPayload: a fresh key pair and salt per message, and the browser can decrypt it", async () => {
  const browser = await newBrowser();
  const text = JSON.stringify({ type: "new_mail", title: "Blåbærsyltetøy ✓", count: 2 });
  const first = await encryptPayload(encoder.encode(text), browser);
  const second = await encryptPayload(encoder.encode(text), browser);
  assertNotEquals(b64urlEncode(first), b64urlEncode(second), "nothing is reused between messages");
  assertNotEquals(b64urlEncode(first.subarray(0, 16)), b64urlEncode(second.subarray(0, 16)), "salt");
  assertNotEquals(b64urlEncode(first.subarray(21, 86)), b64urlEncode(second.subarray(21, 86)), "sender key");
  assertEquals(await browserDecrypt(first, browser.pair, browser.p256dh, browser.auth), text);
  assertEquals(await browserDecrypt(second, browser.pair, browser.p256dh, browser.auth), text);
  assert(!decoder.decode(first).includes("new_mail"), "the body is ciphertext");
});

Deno.test("encryptPayload: another browser, or the wrong auth secret, cannot decrypt", async () => {
  const browser = await newBrowser();
  const other = await newBrowser();
  const body = await encryptPayload(encoder.encode("secret"), browser);
  await assertRejects(() => browserDecrypt(body, other.pair, other.p256dh, other.auth));
  await assertRejects(() => browserDecrypt(body, browser.pair, browser.p256dh, other.auth));
});

Deno.test("encryptPayload: the largest payload fits in 4096 bytes; one byte more is refused", async () => {
  const browser = await newBrowser();
  const body = await encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES), browser);
  assertEquals(body.length, 4096);
  await assertRejects(() => encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), browser), Error, "push_payload_too_large");
});

Deno.test("encryptPayload: malformed subscription keys are refused", async () => {
  const browser = await newBrowser();
  await assertRejects(() => encryptPayload(encoder.encode("x"), { p256dh: "AAAA", auth: browser.auth }), Error, "push_keys_invalid");
  await assertRejects(() => encryptPayload(encoder.encode("x"), { p256dh: browser.p256dh, auth: "AAAA" }), Error, "push_keys_invalid");
});

// ── VAPID ───────────────────────────────────────────────────────────────────

async function newVapid(): Promise<{ config: VapidConfig; verifyKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return {
    config: { publicKey, privateKey: exported.d!, subject: "mailto:push-test@client-api-test.example" },
    verifyKey: pair.publicKey,
  };
}

Deno.test("VAPID: an ES256 JWT with aud, exp within 24 h and sub, verifiable with the public key", async () => {
  const { config, verifyKey } = await newVapid();
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const token = await vapidToken(config, "https://fcm.googleapis.com", now);
  const [header, claims, signature] = token.split(".");
  assertEquals(JSON.parse(decoder.decode(b64urlDecode(header))), { typ: "JWT", alg: "ES256" });
  const body = JSON.parse(decoder.decode(b64urlDecode(claims)));
  assertEquals(body.aud, "https://fcm.googleapis.com");
  assertEquals(body.sub, config.subject);
  assert(body.exp > now / 1000 && body.exp <= now / 1000 + 24 * 3600, "exp is in the future and at most 24 hours away");
  assertEquals(b64urlDecode(signature).length, 64, "r || s, not DER");
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      b64urlDecode(signature),
      encoder.encode(`${header}.${claims}`),
    ),
    "signature verifies",
  );
});

Deno.test("vapidFromEnv: all three secrets, well formed, or push is off", async () => {
  const { config } = await newVapid();
  const env = (values: Record<string, string>) => (name: string) => values[name];
  const good = { VAPID_PUBLIC_KEY: config.publicKey, VAPID_PRIVATE_KEY: config.privateKey, VAPID_SUBJECT: config.subject };
  assertEquals(vapidFromEnv(env(good)), config);
  assertEquals(vapidFromEnv(env({})), null);
  assertEquals(vapidFromEnv(env({ ...good, VAPID_PRIVATE_KEY: "" })), null);
  assertEquals(vapidFromEnv(env({ ...good, VAPID_PUBLIC_KEY: config.privateKey })), null);
  assertEquals(vapidFromEnv(env({ ...good, VAPID_SUBJECT: "someone@example.com" })), null, "subject must be mailto: or https:");
  assertEquals(vapidFromEnv(env({ ...good, VAPID_SUBJECT: "https://mcpemails.com/contact" }))?.subject, "https://mcpemails.com/contact");
});

// ── validation ──────────────────────────────────────────────────────────────

Deno.test("endpoints: only https URLs on the push services browsers use", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://web.push.apple.com/QGX",
    "https://db5p.notify.windows.com/w/?token=abc",
  ]) assert(isAllowedPushEndpoint(ok), ok);
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilfcm.googleapis.com.example/x",
    "https://notfcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://169.254.169.254/latest/meta-data",
    "https://fcm.googleapis.com:8443/x",
    "https://user:pass@fcm.googleapis.com/x",
    "https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server",
    "javascript:alert(1)",
    "",
    `https://fcm.googleapis.com/${"a".repeat(3000)}`,
    null,
    42,
  ]) assert(!isAllowedPushEndpoint(bad), String(bad).slice(0, 60));
});

Deno.test("endpoints: the allow-list compares the parsed hostname, exactly or at a label boundary (adversarial)", () => {
  for (const bad of [
    // An allowed host as a PREFIX, a SUFFIX without a dot, or a substring.
    "https://fcm.googleapis.com.evil.example",
    "https://fcm.googleapis.com.evil.example/fcm/send/abc",
    "https://evilgoogleapis.com/fcm/send/abc",
    "https://evilfcm.googleapis.com/fcm/send/abc",
    "https://xpush.apple.com/x",
    "https://evilnotify.windows.com/x",
    "https://fcm-googleapis.com/x",
    "https://googleapis.com/fcm/send/abc",
    "https://storage.googleapis.com/fcm.googleapis.com/x",
    // An allowed host anywhere but the host.
    "https://evil.example/fcm.googleapis.com/fcm/send/abc",
    "https://evil.example/?h=fcm.googleapis.com",
    "https://evil.example/#fcm.googleapis.com",
    "https://evil.example\\@fcm.googleapis.com.evil.example/x",
    // Userinfo, in every form.
    "https://fcm.googleapis.com@evil.example/x",
    "https://fcm.googleapis.com:443@evil.example/x",
    "https://user@fcm.googleapis.com/x",
    "https://:pass@fcm.googleapis.com/x",
    "https://evil.example%2f@fcm.googleapis.com/x",
    // Schemes.
    "http://fcm.googleapis.com/x",
    "HTTP://fcm.googleapis.com/x",
    "ws://fcm.googleapis.com/x",
    "wss://fcm.googleapis.com/x",
    "ftp://fcm.googleapis.com/x",
    "//fcm.googleapis.com/x",
    "fcm.googleapis.com/x",
    "data:text/plain,https://fcm.googleapis.com/",
    // Ports.
    "https://fcm.googleapis.com:8443/x",
    "https://fcm.googleapis.com:80/x",
    "https://fcm.googleapis.com:0/x",
    // IP literals, in the spellings a URL parser accepts.
    "https://127.0.0.1/x",
    "https://2130706433/x",
    "https://0x7f.0.0.1/x",
    "https://017700000001/x",
    "https://10.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://[fd00::1]/x",
    // A rooted name, and things that are not URLs.
    "https://fcm.googleapis.com./x",
    "https://fcm.googleapis.com../x",
    "https:///fcm.googleapis.com.evil.example/x",
    " ",
    "https://",
  ]) assert(!isAllowedPushEndpoint(bad), `accepted: ${bad}`);

  // What stays allowed: the host itself and real subdomains of it, in any case.
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://FCM.GoogleAPIs.com/fcm/send/abc",
    "https://fcm.googleapis.com:443/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/x",
    "https://wns2-db5p.notify.windows.com/w/?token=x",
    // The path may say anything: only the host is the service.
    "https://fcm.googleapis.com/evil.example/@x?y=https://evil.example",
  ]) assert(isAllowedPushEndpoint(ok), `refused: ${ok}`);
});

Deno.test("keys and topics: shape checks", async () => {
  const browser = await newBrowser();
  assert(isP256PublicKey(browser.p256dh));
  assert(!isP256PublicKey(browser.auth));
  assert(!isP256PublicKey("not base64 !"));
  assert(isAuthSecret(browser.auth));
  assert(!isAuthSecret(browser.p256dh));
  assert(isValidTopic("0123456789abcdef0123456789abcdef"));
  assert(!isValidTopic("0123456789abcdef0123456789abcdef0"), "33 characters");
  assert(!isValidTopic("has space"));
});

// ── the HTTP exchange ───────────────────────────────────────────────────────

interface Sent {
  url: string;
  headers: Headers;
  body: Uint8Array;
}

async function harness(responses: Array<Response | Error>, overrides: { maxRetryAfterSec?: number } = {}) {
  const { config, verifyKey } = await newVapid();
  const browser = await newBrowser();
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const sender = createPushSender({
    vapid: config,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body as Uint8Array });
      const next = responses.shift() ?? new Response(null, { status: 201 });
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }) as typeof fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
  const message: PushMessage = {
    endpoint: "https://fcm.googleapis.com/fcm/send/device-token",
    keys: browser,
    payload: { type: "new_mail", title: "Maya", body: "Lunch on Friday?" },
    ttlSec: 3600,
    topic: "0123456789abcdef0123456789abcdef",
  };
  return { sender, sent, sleeps, message, browser, config, verifyKey };
}

Deno.test("send: one POST with VAPID, aes128gcm, TTL, Topic and Urgency; the body decrypts to the payload", async () => {
  const h = await harness([new Response(null, { status: 201 })]);
  const outcome = await h.sender.send(h.message);
  assertEquals(outcome, { kind: "sent", status: 201, attempts: 1 });
  assertEquals(h.sent.length, 1);
  const { url, headers, body } = h.sent[0];
  assertEquals(url, h.message.endpoint);
  assertEquals(headers.get("content-encoding"), "aes128gcm");
  assertEquals(headers.get("ttl"), "3600");
  assertEquals(headers.get("topic"), "0123456789abcdef0123456789abcdef");
  assertEquals(headers.get("urgency"), "normal");
  const auth = headers.get("authorization") ?? "";
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  assert(match, "vapid scheme");
  assertEquals(match[2], h.config.publicKey);
  const [head, claims, signature] = match[1].split(".");
  assertEquals(JSON.parse(decoder.decode(b64urlDecode(claims))).aud, "https://fcm.googleapis.com");
  assert(
    await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, h.verifyKey, b64urlDecode(signature), encoder.encode(`${head}.${claims}`)),
  );
  assertEquals(JSON.parse(await browserDecrypt(body, h.browser.pair, h.browser.p256dh, h.browser.auth)), h.message.payload);
  assert(!decoder.decode(body).includes("Lunch"), "the push service sees ciphertext only");
});

Deno.test("send: 404 and 410 mean the subscription is gone, with no retry", async () => {
  for (const status of [404, 410]) {
    const h = await harness([new Response(null, { status })]);
    assertEquals(await h.sender.send(h.message), { kind: "gone", status, attempts: 1 });
    assertEquals(h.sent.length, 1);
  }
});

Deno.test("send: 413 is reported as too large and is not retried", async () => {
  const h = await harness([new Response(null, { status: 413 })]);
  assertEquals(await h.sender.send(h.message), { kind: "too_large", status: 413, attempts: 1 });
  assertEquals(h.sent.length, 1);
});

Deno.test("send: 429 with a short Retry-After waits that long and tries again", async () => {
  const h = await harness([new Response(null, { status: 429, headers: { "Retry-After": "2" } }), new Response(null, { status: 201 })]);
  assertEquals(await h.sender.send(h.message), { kind: "sent", status: 201, attempts: 2 });
  assertEquals(h.sleeps, [2000]);
});

Deno.test("send: 429 with a long Retry-After gives up at once and reports the wait", async () => {
  const h = await harness([new Response(null, { status: 429, headers: { "Retry-After": "120" } })]);
  assertEquals(await h.sender.send(h.message), { kind: "rate_limited", status: 429, attempts: 1, retryAfterSec: 120 });
  assertEquals(h.sleeps, []);
});

Deno.test("send: 5xx and network errors are retried with backoff, at most three attempts", async () => {
  const recovered = await harness([new Response(null, { status: 503 }), new Error("reset"), new Response(null, { status: 201 })]);
  assertEquals(await recovered.sender.send(recovered.message), { kind: "sent", status: 201, attempts: 3 });
  assertEquals(recovered.sleeps, [250, 500]);

  const down = await harness([500, 502, 503, 500, 500].map((status) => new Response(null, { status })));
  assertEquals(await down.sender.send(down.message), { kind: "failed", status: 503, attempts: 3 });
  assertEquals(down.sent.length, 3, "bounded");
});

Deno.test("send: 400 / 401 / 403 are this server's fault and are not retried", async () => {
  for (const status of [400, 401, 403]) {
    const h = await harness([new Response(null, { status })]);
    assertEquals(await h.sender.send(h.message), { kind: "rejected", status, attempts: 1 });
  }
});

Deno.test("send: an endpoint outside the push services is never contacted", async () => {
  const h = await harness([]);
  const outcome = await h.sender.send({ ...h.message, endpoint: "https://internal.example/hook" });
  assertEquals(outcome.kind, "rejected");
  assertEquals(h.sent.length, 0);
});

Deno.test("send: a payload over the limit is reported without a request", async () => {
  const h = await harness([]);
  const outcome = await h.sender.send({ ...h.message, payload: { body: "x".repeat(5000) } });
  assertEquals(outcome.kind, "too_large");
  assertEquals(h.sent.length, 0);
});

Deno.test("send: the VAPID token is signed once per push service and reused", async () => {
  const h = await harness([]);
  await h.sender.send(h.message);
  await h.sender.send(h.message);
  await h.sender.send({ ...h.message, endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc" });
  const tokens = h.sent.map((s) => /t=([^,]+)/.exec(s.headers.get("authorization") ?? "")?.[1]);
  assertEquals(tokens[0], tokens[1]);
  assertNotEquals(tokens[0], tokens[2], "a different audience gets its own token");
});
