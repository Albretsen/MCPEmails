/**
 * Is this inbox usable, as far as its `inboxes` row knows?
 *
 * The SAME rule as inboxHealthStatus() in
 * supabase/functions/mcp-server/inbox-health.ts, which tells AI clients which
 * inboxes need reconnecting. Before this module the dashboard only looked at
 * `status`, so a row the mcp-server reported as `reconnect_required` showed a
 * green "Connected" on the Inboxes page (found in production 2026-10-30).
 *
 *   'reconnect_required': `status = 'error'`, or `status = 'active'` with the
 *       login-refused marker in `last_error` (an IMAP server said NO to the
 *       password; the row stays 'active' on purpose, see inbox-health.ts).
 *   'unavailable': `status = 'error'` because the Outlook account has no
 *       mailbox. Reconnecting does not fix it.
 *   'ok': everything else, including 'pending'.
 *
 * Mirrored, not imported: the web app does not bundle edge-function code.
 * health.test.ts and inbox-health.test.ts both run
 * supabase/functions/mcp-server/inbox-health.cases.json, so the two copies
 * cannot drift.
 */
import { OUTLOOK_NO_MAILBOX_REASON } from '@/lib/email-providers/outlook-oauth';

export type InboxHealth = 'ok' | 'reconnect_required' | 'unavailable';

export interface InboxHealthRow {
  provider?: string | null;
  status?: unknown;
  last_error?: unknown;
}

const MARKER_RE =
  /^The mail server refused this mailbox's password\. Reconnect this inbox to restore access\. \(Checked ([0-9T:.Z-]{20,30})\)$/;

/** When the login-refused marker in `lastError` was written (ms), or null. */
export function loginRefusedAt(lastError: unknown): number | null {
  if (typeof lastError !== 'string') return null;
  const match = MARKER_RE.exec(lastError);
  if (!match) return null;
  const at = Date.parse(match[1]);
  return Number.isFinite(at) ? at : null;
}

export function inboxHealth(row: InboxHealthRow): InboxHealth {
  if (row.status === 'error') {
    return row.last_error === OUTLOOK_NO_MAILBOX_REASON ? 'unavailable' : 'reconnect_required';
  }
  if (row.status === 'active' && loginRefusedAt(row.last_error) !== null) return 'reconnect_required';
  return 'ok';
}

/**
 * `last_error` for a person to read: one line, without the trailing
 * "(Checked <ISO time>)" our health checks append, and, when `max` is given,
 * shortened on a word boundary rather than mid-word.
 */
export function lastErrorForDisplay(lastError: unknown, max?: number): string | null {
  if (typeof lastError !== 'string') return null;
  let v = lastError
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s*\(Checked [0-9T:.Z-]{10,30}\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v) return null;
  if (max !== undefined && v.length > max) {
    const cut = v.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    v = `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, '')}…`;
  }
  return v;
}
