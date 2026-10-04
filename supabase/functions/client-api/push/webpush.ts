// ---------------------------------------------------------------------------
// Web Push, with nothing but Web Crypto.
//
//   RFC 8292  VAPID: an ES256 JWT that tells the push service who is sending.
//   RFC 8291  Message encryption: the payload is encrypted to the browser's
//             own key pair (p256dh) and its auth secret. The push service
//             (Google, Mozilla, Apple, Microsoft) relays ciphertext it cannot
//             read; only the browser that created the subscription can.
//   RFC 8188  The `aes128gcm` content coding the ciphertext is framed in.
//   RFC 8030  The HTTP exchange: TTL, Topic, Urgency, and what the push
//             service's status codes mean.
//
// WHERE A PUSH MAY BE SENT. A subscription's endpoint is a URL the browser
// chose and a signed-in user handed us, and this function will POST to it. So
// it is checked against the push services browsers actually use
// (`isAllowedPushEndpoint`); anything else is refused at subscribe time AND
// again here. Without that, "subscribe" would be a way to make this function
// send requests to an address of the caller's choosing.
//
// Nothing in this file logs. Callers get a classified outcome and log counts.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not_base64url");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(new ArrayBuffer(length));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── endpoints ───────────────────────────────────────────────────────────────

/**
 * Hosts of the push services behind Chrome / Edge / Opera / Brave (FCM),
 * Firefox (Mozilla autopush), Safari on macOS and iOS (Apple) and legacy Edge
 * (WNS). Exact host or a dot-suffix of it; https only; default port only.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export const MAX_ENDPOINT_CHARS = 2048;

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_CHARS) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false;
  // The PARSED hostname, never the string: "https://fcm.googleapis.com.evil.example",
  // "https://evil.example/?fcm.googleapis.com" and "https://fcm.googleapis.com@evil.example"
  // all contain an allowed host and are none of them.
  const host = url.hostname.toLowerCase();
  // An IP literal (v6 in brackets, v4 in any spelling the parser normalised to
  // dotted decimal) and a rooted name ("host.") are never a push service.
  if (host === "" || host.startsWith("[") || host.endsWith(".") || /^[0-9.]+$/.test(host)) return false;
  // Exact, or a label boundary in front: ".googleapis.com" style suffixes are
  // dot-anchored, so "evilfcm.googleapis.com" does not match "fcm.googleapis.com".
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** An uncompressed P-256 point: 0x04 || X || Y. */
export function isP256PublicKey(text: unknown): text is string {
  if (typeof text !== "string" || text.length > 120) return false;
  try {
    const bytes = b64urlDecode(text);
    return bytes.length === 65 && bytes[0] === 4;
  } catch {
    return false;
  }
}

/** The 16-byte authentication secret of a subscription. */
export function isAuthSecret(text: unknown): text is string {
  if (typeof text !== "string" || text.length > 64) return false;
  try {
    return b64urlDecode(text).length === 16;
  } catch {
    return false;
  }
}

// ── VAPID (RFC 8292) ────────────────────────────────────────────────────────

export interface VapidConfig {
  /** base64url, 65 bytes: the application server key the browser subscribed with. */
  publicKey: string;
  /** base64url, 32 bytes: the P-256 private scalar. */
  privateKey: string;
  /** `mailto:` or `https:` contact the push service may use. */
  subject: string;
}

/** The three secrets, or null when push is not configured (or configured wrongly). */
export function vapidFromEnv(env: (name: string) => string | undefined): VapidConfig | null {
  const publicKey = (env("VAPID_PUBLIC_KEY") ?? "").trim();
  const privateKey = (env("VAPID_PRIVATE_KEY") ?? "").trim();
  const subject = (env("VAPID_SUBJECT") ?? "").trim();
  if (!isP256PublicKey(publicKey)) return null;
  try {
    if (b64urlDecode(privateKey).length !== 32) return null;
  } catch {
    return null;
  }
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject) || subject.length > 200) return null;
  return { publicKey, privateKey, subject };
}

async function importVapidKey(config: VapidConfig): Promise<CryptoKey> {
  const point = b64urlDecode(config.publicKey);
  return await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64urlEncode(point.subarray(1, 33)),
      y: b64urlEncode(point.subarray(33, 65)),
      d: config.privateKey,
      ext: false,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** How long a VAPID token is valid for. RFC 8292 allows at most 24 hours. */
export const VAPID_TTL_SEC = 12 * 60 * 60;

/** The signed JWT for one push service origin (`aud`). */
export async function vapidToken(config: VapidConfig, audience: string, nowMs: number): Promise<string> {
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(nowMs / 1000) + VAPID_TTL_SEC,
    sub: config.subject,
  })));
  const key = await importVapidKey(config);
  // Web Crypto's ECDSA signature is already r || s (IEEE P1363), which is the JWS form.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`)),
  );
  return `${header}.${claims}.${b64urlEncode(signature)}`;
}

/** `Authorization` for a push request (RFC 8292 section 3). */
export function vapidAuthorization(token: string, config: VapidConfig): string {
  return `vapid t=${token}, k=${config.publicKey}`;
}

// ── encryption (RFC 8291 + RFC 8188) ────────────────────────────────────────

/** One record. Push services accept at most 4096 bytes of body. */
const RECORD_SIZE = 4096;
/** salt(16) + rs(4) + idlen(1) + keyid(65) + padding delimiter(1) + AES-GCM tag(16). */
const OVERHEAD = 16 + 4 + 1 + 65 + 1 + 16;
/** The largest plaintext one push message can carry. */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - OVERHEAD;

export interface SubscriptionKeys {
  /** base64url, the browser's P-256 public key. */
  p256dh: string;
  /** base64url, the browser's 16-byte auth secret. */
  auth: string;
}

export interface EncryptOptions {
  /** Tests only: a fixed salt (16 bytes) instead of a random one. */
  salt?: Uint8Array;
  /** Tests only: a fixed sender key pair instead of a fresh one per message. */
  senderKeys?: CryptoKeyPair;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, info: info as Uint8Array<ArrayBuffer> },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** The `aes128gcm` body for one push message: header, then one encrypted record. */
export async function encryptPayload(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
  options: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("push_payload_too_large");
  const uaPublic = b64urlDecode(keys.p256dh);
  const authSecret = b64urlDecode(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error("push_keys_invalid");

  const sender = options.senderKeys ??
    await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, sender.privateKey, 256),
  );

  // RFC 8291 section 3.4: mix the auth secret and both public keys into the key material.
  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = options.salt ? new Uint8Array(options.salt) : crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("push_salt_invalid");
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (here: only) record; no further padding.
  const record = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, concat(plaintext, new Uint8Array([2]))),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, record);
}

// ── sending (RFC 8030) ──────────────────────────────────────────────────────

export type PushOutcome =
  /** Accepted by the push service (201, or any other 2xx). */
  | { kind: "sent"; status: number; attempts: number }
  /** 404 / 410: the subscription no longer exists. Stop sending to it. */
  | { kind: "gone"; status: number; attempts: number }
  /** 413: the push service refused the size. Retrying the same body cannot help. */
  | { kind: "too_large"; status: number; attempts: number }
  /** 429 with a Retry-After longer than this call may wait. */
  | { kind: "rate_limited"; status: number; attempts: number; retryAfterSec: number }
  /** 400 / 401 / 403: this server's request or its VAPID key was refused. */
  | { kind: "rejected"; status: number; attempts: number }
  /** 5xx or a network error, after the bounded retries. */
  | { kind: "failed"; status: number | null; attempts: number };

export interface PushMessage {
  endpoint: string;
  keys: SubscriptionKeys;
  /** The JSON document the service worker receives. */
  payload: unknown;
  /** Seconds the push service keeps the message for an offline device. */
  ttlSec: number;
  /** RFC 8030 Topic: a newer message with the same topic REPLACES an undelivered older one. */
  topic?: string;
  urgency?: "very-low" | "low" | "normal" | "high";
}

export interface PushSender {
  send(message: PushMessage): Promise<PushOutcome>;
}

export interface PushSenderOptions {
  vapid: VapidConfig;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per message, the first included. */
  maxAttempts?: number;
  /** The longest Retry-After (seconds) worth waiting for inside one request. */
  maxRetryAfterSec?: number;
  /** Abort one attempt after this long. */
  timeoutMs?: number;
}

/** RFC 8030 section 5.4: at most 32 characters of the URL-safe base64 alphabet. */
export function isValidTopic(topic: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(topic);
}

function retryAfterSeconds(response: Response, nowMs: number): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : null;
}

export function createPushSender(options: PushSenderOptions): PushSender {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const maxRetryAfterSec = options.maxRetryAfterSec ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;
  // One signature per push service origin per isolate, reused for an hour.
  const tokens = new Map<string, { token: string; at: number }>();

  const tokenFor = async (audience: string): Promise<string> => {
    const hit = tokens.get(audience);
    if (hit && now() - hit.at < 60 * 60_000) return hit.token;
    const token = await vapidToken(options.vapid, audience, now());
    tokens.set(audience, { token, at: now() });
    return token;
  };

  return {
    async send(message: PushMessage): Promise<PushOutcome> {
      if (!isAllowedPushEndpoint(message.endpoint)) return { kind: "rejected", status: 0, attempts: 0 };
      let body: Uint8Array<ArrayBuffer>;
      let authorization: string;
      try {
        body = await encryptPayload(encoder.encode(JSON.stringify(message.payload)), message.keys);
        authorization = vapidAuthorization(await tokenFor(new URL(message.endpoint).origin), options.vapid);
      } catch (error) {
        if (error instanceof Error && error.message === "push_payload_too_large") {
          return { kind: "too_large", status: 0, attempts: 0 };
        }
        // Keys that cannot be used are a dead subscription, not a server fault.
        return { kind: "gone", status: 0, attempts: 0 };
      }
      const headers: Record<string, string> = {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(Math.max(0, Math.round(message.ttlSec))),
        Urgency: message.urgency ?? "normal",
      };
      if (message.topic && isValidTopic(message.topic)) headers["Topic"] = message.topic;

      let attempts = 0;
      let lastStatus: number | null = null;
      while (attempts < maxAttempts) {
        attempts++;
        let response: Response;
        try {
          response = await doFetch(message.endpoint, {
            method: "POST",
            headers,
            body,
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          lastStatus = null;
          if (attempts < maxAttempts) await sleep(250 * 2 ** (attempts - 1));
          continue;
        }
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        lastStatus = status;
        if (status >= 200 && status < 300) return { kind: "sent", status, attempts };
        if (status === 404 || status === 410) return { kind: "gone", status, attempts };
        if (status === 413) return { kind: "too_large", status, attempts };
        if (status === 429) {
          const wait = retryAfterSeconds(response, now()) ?? 1;
          if (wait > maxRetryAfterSec || attempts >= maxAttempts) {
            return { kind: "rate_limited", status, attempts, retryAfterSec: wait };
          }
          await sleep(wait * 1000);
          continue;
        }
        if (status >= 500) {
          if (attempts < maxAttempts) await sleep(250 * 2 ** (attempts - 1));
          continue;
        }
        return { kind: "rejected", status, attempts };
      }
      return { kind: "failed", status: lastStatus, attempts };
    },
  };
}
