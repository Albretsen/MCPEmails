// ---------------------------------------------------------------------------
// Webhook signing: the one place the signature format is defined on the edge.
//
//   MCPEmails-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
//   MCPEmails-Event-Id:  evt_<32 hex>
//
// The HMAC key is the UTF-8 bytes of the WHOLE secret as shown to the
// customer, `whsec_` prefix included, so a receiver pastes the string it was
// given and nothing else. `t` is the time of THIS attempt (a retry is signed
// afresh), so a receiver can refuse a replay older than its tolerance; the
// docs say 5 minutes. The Node twin is apps/web/src/lib/webhooks/sign.ts and
// both are pinned to the same known vector by their tests.
// ---------------------------------------------------------------------------

export const SIGNATURE_HEADER = "MCPEmails-Signature";
export const EVENT_ID_HEADER = "MCPEmails-Event-Id";
export const EVENT_TYPE_HEADER = "MCPEmails-Event-Type";
/** The replay window the docs recommend, and `verifySignature` defaults to. */
export const SIGNATURE_TOLERANCE_SEC = 300;

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** The header value for one attempt. */
export async function signatureHeader(secret: string, timestampSec: number, body: string): Promise<string> {
  const t = Math.floor(timestampSec);
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * What a receiver does, here so the format has an executable definition:
 * parse `t` and every `v1`, refuse a timestamp outside the tolerance, and
 * accept when any `v1` matches.
 */
export async function verifySignature(
  header: string,
  secret: string,
  body: string,
  nowSec: number,
  toleranceSec = SIGNATURE_TOLERANCE_SEC,
): Promise<boolean> {
  let t: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && /^\d{1,12}$/.test(v ?? "")) t = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")) signatures.push(v);
  }
  if (t === null || signatures.length === 0) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${body}`);
  return signatures.some((s) => constantTimeEqual(s, expected));
}

/** `evt_` + 32 hex characters (128 random bits). */
export function newEventId(): string {
  return `evt_${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
}
