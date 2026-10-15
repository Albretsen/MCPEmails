/**
 * SUPPORT_RELEASE_GATE: the single release gate for Help & support.
 *
 * Help & support (/help, the ticket API, and the entry points in the
 * dashboard, connect modal, error pages and footer) is internal-only while it
 * is being tested. Every place that decides "show it or not" calls
 * `supportVisibleTo()` from here, directly or through getSupportViewer() /
 * GET /api/support/visibility, and carries the marker comment
 * `SUPPORT_RELEASE_GATE`. Nothing re-implements the check.
 *
 * HOW TO RELEASE:
 *   1. Delete this file.
 *   2. `rg -n SUPPORT_RELEASE_GATE apps/web` and the type errors from
 *      `tsc --noEmit` list every call site. At each one, treat the gate as
 *      true: drop the condition, the 404 branch, the noindex metadata, the
 *      preview-cookie plumbing and the /api/support/preview route.
 *   3. Add /help to the sitemap.
 *
 * WHO SEES IT NOW. `isInternalAccount()` (our domains, GROWTH_INTERNAL_EMAILS,
 * plus-tag aliases of those) is the whole rule. No flag column, no env var.
 *
 * THE PREVIEW TOKEN exists so staff can see the SIGNED-OUT form, which has no
 * session to read an email from. A signed-in internal user hits
 * /api/support/preview and gets a cookie holding a signed token that embeds
 * their email and an expiry. The token is honoured only while that embedded
 * email is STILL internal, so removing someone from GROWTH_INTERNAL_EMAILS
 * revokes their outstanding tokens too. Signed with CSRF_SECRET under the
 * 'support-preview' label; a missing or malformed secret fails closed.
 */
import { isInternalAccount } from '@/lib/analytics/internal-accounts';

import { supportHmac, verifySupportHmac } from '@/lib/support/signing';

export const SUPPORT_PREVIEW_COOKIE = 'mcpe_support_preview';

/** Preview token lifetime, also the cookie Max-Age. */
export const SUPPORT_PREVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The single gate. True when support UI/API is visible to this visitor. */
export function supportVisibleTo(email: string | null, previewToken?: string | null): boolean {
  if (isInternalAccount(email)) return true;
  if (!previewToken) return false;
  const embedded = readPreviewToken(previewToken, Date.now());
  return embedded !== null && isInternalAccount(embedded);
}

/**
 * Signed token carrying an internal email + expiry (30 days).
 * Format: base64url(JSON {e, x}) "." base64url(HMAC).
 * Throws when the secret is unusable: there is nothing safe to mint.
 */
export function mintSupportPreviewToken(email: string, nowMs: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ e: email.trim().toLowerCase(), x: nowMs + SUPPORT_PREVIEW_TTL_MS }),
  ).toString('base64url');
  const mac = supportHmac('support-preview', payload);
  if (!mac) throw new Error('CSRF_SECRET missing or invalid; cannot mint a support preview token.');
  return `${payload}.${mac.toString('base64url')}`;
}

/** The embedded email of a valid, unexpired token, else null. Never throws. */
export function readPreviewToken(token: string, nowMs: number): string | null {
  try {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const payload = token.slice(0, dot);
    if (!verifySupportHmac('support-preview', payload, token.slice(dot + 1))) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const { e, x } = parsed as { e?: unknown; x?: unknown };
    if (typeof e !== 'string' || typeof x !== 'number' || !Number.isFinite(x)) return null;
    if (x <= nowMs) return null;
    return e;
  } catch {
    return null;
  }
}
