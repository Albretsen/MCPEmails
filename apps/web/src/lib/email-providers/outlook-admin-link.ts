/**
 * The shareable Microsoft 365 admin-consent link.
 *
 * A work or school Microsoft 365 tenant on Microsoft's default consent policy
 * does not let an employee approve mail access, so an administrator has to
 * approve MCP Emails once for the whole organisation. The person who hits
 * that wall is the employee; the person who can clear it is an admin who
 * usually has no MCP Emails account at all. So the dashboard hands the
 * employee a link they can SEND, and anyone holding it can start Microsoft's
 * admin-consent flow without signing in to MCP Emails.
 *
 *   https://mcpemails.com/auth/outlook/admin-consent?t=<token>
 *
 * The token is an HMAC-signed capability, not a database row:
 *
 *   base64url( version | workspace uuid | inviter user uuid | expiry u32 )
 *   "." base64url( HMAC-SHA256(key, payload)[0..16] )
 *
 * It is valid for seven days and reusable until then (re-approving an app an
 * admin already approved is harmless: Microsoft records the same grant). It
 * grants nothing by itself. Opening it only mints a fresh 10-minute
 * oauth_states row (the table's own lifetime) and sends the browser to
 * Microsoft, where the admin still has to sign in with an admin account and
 * approve the permission list. The inviter's ids are carried so that state row
 * can satisfy oauth_states' NOT NULL workspace_id / user_id and foreign keys
 * without a migration, and so the approval can be attributed in the logs.
 *
 * The HMAC key is derived (HKDF-SHA256) from CSRF_SECRET, an existing 32-byte
 * HMAC secret the build already requires (next.config.js), under a label of
 * its own, so no new environment variable is needed and a CSRF token and a
 * link token can never be confused for each other.
 *
 * The functions below take the key and the clock as arguments so the tests can
 * exercise signing, tampering and expiry without an environment.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** How long a shared link stays usable. */
export const ADMIN_CONSENT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cookie that ties the Microsoft round trip to the browser that opened the
 * link. Set when the link is opened, checked (and cleared) by the callback, so
 * a callback URL with a stolen state value, replayed in somebody else's
 * browser, cannot render an "approved" page.
 */
export const ADMIN_CONSENT_STATE_COOKIE = 'mcpe_outlook_ac';

/** Same lifetime as the oauth_states row it mirrors. */
export const ADMIN_CONSENT_STATE_TTL_SECONDS = 10 * 60;

const TOKEN_VERSION = 1;
const SIGNATURE_BYTES = 16;
const PAYLOAD_BYTES = 1 + 16 + 16 + 4;
const HKDF_SALT = 'mcpemails';
const HKDF_INFO = 'outlook-admin-consent-link/v1';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Derive the link-signing key from a 64-hex-character secret. */
export function deriveAdminConsentLinkKey(secretHex: string | undefined): Buffer {
  if (!secretHex || !/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new Error('CSRF_SECRET missing or invalid.');
  }
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secretHex, 'hex'), HKDF_SALT, HKDF_INFO, 32),
  );
}

/** The key the running server signs with. Throws when CSRF_SECRET is unusable. */
export function adminConsentLinkKey(): Buffer {
  return deriveAdminConsentLinkKey(process.env.CSRF_SECRET);
}

function uuidBytes(uuid: string): Buffer {
  if (!UUID_SHAPE.test(uuid)) throw new Error('Not a UUID.');
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sign(key: Buffer, payload: Buffer): Buffer {
  return createHmac('sha256', key).update(payload).digest().subarray(0, SIGNATURE_BYTES);
}

export interface AdminConsentLinkClaims {
  workspaceId: string;
  userId: string;
  /** Epoch milliseconds, truncated to whole seconds. */
  expiresAt: number;
}

/** Sign a link token. `expiresAt` is epoch milliseconds. */
export function signAdminConsentLinkToken(claims: AdminConsentLinkClaims, key: Buffer): string {
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  payload.writeUInt8(TOKEN_VERSION, 0);
  uuidBytes(claims.workspaceId).copy(payload, 1);
  uuidBytes(claims.userId).copy(payload, 17);
  payload.writeUInt32BE(Math.floor(claims.expiresAt / 1000), 33);
  return `${payload.toString('base64url')}.${sign(key, payload).toString('base64url')}`;
}

/** Mint a token for a workspace member, valid for ADMIN_CONSENT_LINK_TTL_MS. */
export function mintAdminConsentLinkToken(
  workspaceId: string,
  userId: string,
  key: Buffer,
  now: number = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = Math.floor((now + ADMIN_CONSENT_LINK_TTL_MS) / 1000) * 1000;
  return { token: signAdminConsentLinkToken({ workspaceId, userId, expiresAt }, key), expiresAt };
}

export type AdminConsentLinkVerification =
  | ({ ok: true } & AdminConsentLinkClaims)
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Verify a link token. The signature is checked before the expiry, so an
 * "expired" answer is only ever given about a token this server issued.
 */
export function verifyAdminConsentLinkToken(
  token: string | null | undefined,
  key: Buffer,
  now: number = Date.now(),
): AdminConsentLinkVerification {
  if (typeof token !== 'string' || token.length > 200) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    return { ok: false, reason: 'malformed' };
  }
  const payload = Buffer.from(parts[0], 'base64url');
  const signature = Buffer.from(parts[1], 'base64url');
  if (payload.length !== PAYLOAD_BYTES || payload.readUInt8(0) !== TOKEN_VERSION) {
    return { ok: false, reason: 'malformed' };
  }
  if (signature.length !== SIGNATURE_BYTES || !timingSafeEqual(signature, sign(key, payload))) {
    return { ok: false, reason: 'bad_signature' };
  }
  const expiresAt = payload.readUInt32BE(33) * 1000;
  if (now >= expiresAt) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    workspaceId: bytesToUuid(payload.subarray(1, 17)),
    userId: bytesToUuid(payload.subarray(17, 33)),
    expiresAt,
  };
}

/** The public URL an employee sends to their administrator. */
export function adminConsentLinkUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/auth/outlook/admin-consent?t=${encodeURIComponent(token)}`;
}

/** Constant-time comparison of the state cookie with the returned state. */
export function stateCookieMatches(cookie: string | null | undefined, state: string | null | undefined): boolean {
  if (!cookie || !state) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Where the admin lands ────────────────────────────────────────────────────

/**
 * What the public result page can say. Every value is a fixed code the page
 * maps to its own sentence; nothing Microsoft sends is ever echoed.
 *
 *  - granted:      the tenant approved the app.
 *  - cancelled:    the admin declined on Microsoft's screen.
 *  - failed:       Microsoft answered with an error, or without a grant.
 *  - link_invalid: the token is malformed, forged or tampered with.
 *  - link_expired: a genuine token past its seven days.
 *  - timed_out:    the 10-minute round trip state is gone (took too long,
 *                  replayed, or finished in a different browser).
 *  - unavailable:  our side failed before Microsoft was reached.
 */
export const ADMIN_CONSENT_RESULT_STATUSES = [
  'granted',
  'cancelled',
  'failed',
  'link_invalid',
  'link_expired',
  'timed_out',
  'unavailable',
] as const;
export type AdminConsentResultStatus = (typeof ADMIN_CONSENT_RESULT_STATUSES)[number];

export function isAdminConsentResultStatus(value: unknown): value is AdminConsentResultStatus {
  return typeof value === 'string' && (ADMIN_CONSENT_RESULT_STATUSES as readonly string[]).includes(value);
}

export function adminConsentResultUrl(appUrl: string, status: AdminConsentResultStatus): string {
  return `${appUrl.replace(/\/+$/, '')}/auth/outlook/admin-consent/result?status=${status}`;
}

/**
 * Where the callback sends the browser once Microsoft has answered.
 *
 * The admin who opened a shared link has no MCP Emails session (or has one
 * for a different account), so they get the small public result page. Only
 * when the browser's signed-in user IS the person who created the link (the
 * "I'm the admin, approve now" path) does it return to the dashboard, where
 * the existing toasts carry the next step (connecting the mailbox).
 */
export function adminConsentCallbackRedirect(input: {
  appUrl: string;
  outcome: 'admin_consent_granted' | 'admin_consent_cancelled' | 'admin_consent_failed';
  sessionUserId: string | null;
  inviterUserId: string;
}): string {
  const appUrl = input.appUrl.replace(/\/+$/, '');
  const toDashboard = !!input.sessionUserId && input.sessionUserId === input.inviterUserId;
  if (toDashboard) {
    if (input.outcome === 'admin_consent_granted') return `${appUrl}/dashboard?admin_consent=granted`;
    if (input.outcome === 'admin_consent_cancelled') return `${appUrl}/dashboard?error=cancelled`;
    return `${appUrl}/dashboard?error=admin_consent_failed`;
  }
  const status: AdminConsentResultStatus =
    input.outcome === 'admin_consent_granted'
      ? 'granted'
      : input.outcome === 'admin_consent_cancelled'
        ? 'cancelled'
        : 'failed';
  return adminConsentResultUrl(appUrl, status);
}
