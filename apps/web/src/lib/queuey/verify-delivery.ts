/**
 * Verify that an inbound request really came from the Queuey delivery queue.
 *
 * Queuey signs each outbound delivery with HMAC-SHA256 over a six-line
 * canonical string and sends five `X-Queuey-*` headers. This is the receiving
 * half of that scheme.
 *
 * WHY THIS EXISTS AT ALL, GIVEN WE ALREADY VERIFY STRIPE.
 * Because Queuey RE-SIGNS EVERY DELIVERY ATTEMPT. The Stripe signature we
 * forward is signed once, by Stripe, and a held event replayed two days later
 * still carries that original timestamp — which is the only reason
 * `signatureToleranceSeconds()` had to be widened to seven days. A Queuey
 * signature on the same replay is minutes old, so the window here can stay at
 * the ±5 minutes Queuey's own ingress allows, and a captured delivery stops
 * being replayable a few minutes after it was captured instead of a week.
 *
 * WHICH SPEC THIS FOLLOWS. docs/how-to/signed-requests, not the TypeScript
 * sample in docs/how-to/verify-deliveries. The two disagree in two places and
 * the sample is the looser of the pair:
 *
 *   - QUERY. The spec says the parameters are flattened, sorted by key,
 *     URL-encoded and joined with `&`, and states outright that this is NOT the
 *     raw query string. The sample uses the raw string.
 *   - PATH. The spec trims a trailing slash. The sample does not.
 *
 * Both readings agree for `/api/stripe/webhook`, which has no query and no
 * trailing slash, so today the choice is invisible. It stops being invisible
 * the moment somebody appends a query parameter: verification would fail, the
 * queue would read our 401 as permanent, and live billing events would go
 * straight to the dead-letter queue. Following the stricter spec costs nothing
 * now and removes that trap. Queuey's own .NET verifier documents that both
 * sides build the string with the same builder "so the two sides cannot
 * drift", which is the tell that the spec, not the sample, is the fixture.
 *
 * THE RAW BODY IS NOT NEGOTIABLE. The signature covers a hash of the exact
 * bytes Queuey sent. A body that has been parsed and re-serialised is a
 * different set of bytes and will not verify — which is also why the Stripe
 * path in the route reads `arrayBuffer()` rather than `json()`.
 *
 * REPLAY. The timestamp window is the only replay protection here. Queuey's
 * nonces are unique per delivery attempt, so remembering them for a little
 * longer than the skew would close the remaining window — see
 * `nonceAlreadySeen` below, which is deliberately left unwired: it needs a
 * table and a round trip on every webhook, and the event-id ledger in the
 * route already makes a replayed Stripe event a no-op ack.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** The five headers Queuey signs a delivery with, lower-cased for lookup. */
export const QUEUEY_SIGNATURE_HEADERS = {
  keyId: 'x-queuey-key-id',
  timestamp: 'x-queuey-timestamp',
  nonce: 'x-queuey-nonce',
  contentSha256: 'x-queuey-content-sha256',
  signature: 'x-queuey-signature',
} as const;

/**
 * Why a delivery did not verify. FOR LOGS ONLY — never return it to the
 * caller, which would tell an attacker which check they failed.
 */
export type QueueyVerificationFailure =
  | 'missing_headers'
  | 'malformed_timestamp'
  | 'timestamp_outside_window'
  | 'body_hash_mismatch'
  | 'signature_mismatch'
  | 'replayed_nonce';

export type QueueyVerificationResult =
  | { ok: true; keyId: string; nonce: string; signedAt: Date }
  | { ok: false; failure: QueueyVerificationFailure };

/**
 * How far a delivery's timestamp may sit from our clock, in either direction.
 * Five minutes, the same window Queuey's ingress allows — measured, not
 * assumed: a probe at 295s old was accepted and one at 299s was refused with
 * `timestamp_out_of_range`.
 */
export const DEFAULT_CLOCK_SKEW_SECONDS = 300;

/**
 * QUERY, normalised: every pair flattened, sorted by key, each side
 * URL-encoded, joined with `&`. Empty string when there are none.
 *
 * `Array.prototype.sort` is stable, so repeated keys keep the order they
 * arrived in — the spec sorts by key and says nothing about ties, and
 * preserving arrival order is the only tie-break that cannot reorder a
 * caller's own repeated values.
 */
export function canonicalQuery(search: string): string {
  const pairs = [...new URLSearchParams(search)];
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** PATH, exactly as sent, with any trailing slash trimmed. `/` stays `/`. */
export function canonicalPath(pathname: string): string {
  if (pathname.length <= 1) return pathname;
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

/** The six-line string the signature is computed over. */
export function canonicalString(parts: {
  method: string;
  path: string;
  query: string;
  timestamp: string;
  nonce: string;
  contentSha256: string;
}): string {
  return [
    parts.method.toUpperCase(),
    parts.path,
    parts.query,
    parts.timestamp,
    parts.nonce.trim(),
    parts.contentSha256.toLowerCase(),
  ].join('\n');
}

/**
 * Constant-time comparison of two lowercase-hex strings. Parsing to bytes
 * first makes it case-insensitive and keeps it off the character-by-character
 * early exit a string comparison would take.
 */
function fixedTimeEqualsHex(a: string, b: string): boolean {
  if (!/^[0-9a-fA-F]*$/.test(a) || !/^[0-9a-fA-F]*$/.test(b)) return false;
  if (a.length !== b.length || a.length === 0) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface VerifyQueueyDeliveryInput {
  /** The HTTP method exactly as received. */
  method: string;
  /** The full request URL. Only its path and query take part in the signature. */
  url: string;
  /** Reads one request header by name (lower-case); null when absent. */
  header: (name: string) => string | null;
  /** The RAW body bytes as received. An empty body is valid. */
  rawBody: Buffer;
  /** The signing secret, used as raw UTF-8 bytes. */
  secret: string;
  /** Override the ±window. Widen only if clocks genuinely drift. */
  skewSeconds?: number;
  /** Injectable clock, for tests. */
  nowSeconds?: number;
  /** Optional replay guard: true when this nonce has been seen before. */
  nonceAlreadySeen?: (nonce: string) => boolean;
}

/**
 * Verify one delivery. Never throws: an unverifiable delivery comes back as
 * `{ ok: false, failure }` with a reason meant for the logs.
 */
export function verifyQueueyDelivery(
  input: VerifyQueueyDeliveryInput,
): QueueyVerificationResult {
  const keyId = input.header(QUEUEY_SIGNATURE_HEADERS.keyId);
  const timestamp = input.header(QUEUEY_SIGNATURE_HEADERS.timestamp);
  const nonce = input.header(QUEUEY_SIGNATURE_HEADERS.nonce);
  const claimedHash = input.header(QUEUEY_SIGNATURE_HEADERS.contentSha256);
  const signature = input.header(QUEUEY_SIGNATURE_HEADERS.signature);

  if (!keyId || !timestamp || !nonce || !claimedHash || !signature) {
    return { ok: false, failure: 'missing_headers' };
  }

  // Unix SECONDS. Reject anything that is not an integer outright rather than
  // letting Number() quietly accept '1e9' or ' 12 '.
  if (!/^-?\d+$/.test(timestamp.trim())) {
    return { ok: false, failure: 'malformed_timestamp' };
  }
  const signedAtSeconds = Number(timestamp.trim());
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = input.skewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (Math.abs(now - signedAtSeconds) > skew) {
    return { ok: false, failure: 'timestamp_outside_window' };
  }

  // Hash the bytes we actually received, then check the claim against it. The
  // canonical string is built from OUR hash, never the caller's, so a wrong
  // claim cannot be smuggled into the signature input.
  const actualHash = createHash('sha256')
    .update(input.rawBody)
    .digest('hex')
    .toLowerCase();
  if (!fixedTimeEqualsHex(actualHash, claimedHash)) {
    return { ok: false, failure: 'body_hash_mismatch' };
  }

  const { pathname, search } = new URL(input.url);
  const expected = createHmac('sha256', Buffer.from(input.secret, 'utf8'))
    .update(
      Buffer.from(
        canonicalString({
          method: input.method,
          path: canonicalPath(pathname),
          query: canonicalQuery(search),
          timestamp: timestamp.trim(),
          nonce,
          contentSha256: actualHash,
        }),
        'utf8',
      ),
    )
    .digest('hex')
    .toLowerCase();

  if (!fixedTimeEqualsHex(expected, signature)) {
    return { ok: false, failure: 'signature_mismatch' };
  }

  // Only after the signature holds is the nonce worth remembering — before
  // that it is attacker-controlled input and recording it would let anyone
  // fill the replay table.
  if (input.nonceAlreadySeen?.(nonce.trim())) {
    return { ok: false, failure: 'replayed_nonce' };
  }

  return {
    ok: true,
    keyId,
    nonce: nonce.trim(),
    signedAt: new Date(signedAtSeconds * 1000),
  };
}
