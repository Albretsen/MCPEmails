import type { SupabaseClient } from '@supabase/supabase-js';
import { isProFeaturePlan } from '@/lib/plans/pro-features';
import type { Database } from '@/types/database.types';

/**
 * Who may start a NEW Gmail connection through Google sign-in (/auth/gmail).
 *
 * WHY THERE IS A GATE. The Google OAuth client behind /auth/gmail is published
 * but unverified (restricted Gmail scopes, no CASA). Google lets such a client
 * be granted by 100 users in its lifetime, the counter never resets, and
 * revoking or deleting an inbox does not give a slot back. On 2026-10-26 the
 * floor we can see (distinct addresses ever on a Gmail OAuth inbox row,
 * soft-deleted included) was 95, growing ~16 a month while the option was open
 * to every plan. Hitting 100 makes Google refuse every new user on its own
 * screen, after they have clicked through our modal.
 *
 * The rule:
 *   - Reconnecting an inbox that already exists is never gated here. The same
 *     Google account re-consenting does not use a new slot, and existing
 *     connections must keep working on every plan.
 *   - A new connection needs Pro or Business (plans `solo` and `pro`).
 *   - And the cap must have more than GMAIL_OAUTH_RESERVE slots left. Below
 *     that, the option is hidden for everyone and the owner is alerted.
 *
 * App password stays the default Gmail path on every plan.
 *
 * `used` is the larger of our own floor and the last hand-entered Cloud
 * Console figure in admin_oauth_cap_snapshots, so recording the real number
 * there tightens the gate at once.
 */

export const GMAIL_OAUTH_USER_CAP = 100;
/** Hide the option once fewer than this many lifetime slots remain. */
export const GMAIL_OAUTH_RESERVE = 5;

export type GmailOAuthRefusal = 'plan' | 'cap';

export interface GmailOAuthCapState {
  /** Lifetime grants counted so far (a floor), or null when unreadable. */
  used: number | null;
  /** Slots left, or null when unreadable. */
  remaining: number | null;
  /** True when new connections must stop (also when the count is unreadable). */
  closed: boolean;
}

export interface GmailOAuthAccess {
  allowed: boolean;
  refusal: GmailOAuthRefusal | null;
}

/** Pure: is the cap closed for a given used count? Unknown counts close it. */
export function decideGmailOAuthCap(used: number | null): GmailOAuthCapState {
  if (used == null || !Number.isFinite(used)) return { used: null, remaining: null, closed: true };
  const remaining = Math.max(0, GMAIL_OAUTH_USER_CAP - used);
  return { used, remaining, closed: remaining < GMAIL_OAUTH_RESERVE };
}

/** Pure: may this workspace start a new Gmail OAuth connection? */
export function decideGmailOAuthAccess(input: { plan: string | null; capClosed: boolean }): GmailOAuthAccess {
  if (!isProFeaturePlan(input.plan)) return { allowed: false, refusal: 'plan' };
  if (input.capClosed) return { allowed: false, refusal: 'cap' };
  return { allowed: true, refusal: null };
}

/**
 * Read the cap. Service-role client only (gmail_oauth_cap_summary is granted to
 * service_role alone). Fails closed: a failed read hides the option rather than
 * risk sending someone to Google's refusal screen.
 */
export async function loadGmailOAuthCapState(serviceClient: SupabaseClient<Database>): Promise<GmailOAuthCapState> {
  try {
    const { data, error } = await serviceClient.rpc('gmail_oauth_cap_summary');
    const row = Array.isArray(data) ? data[0] : null;
    if (error || !row) return decideGmailOAuthCap(null);
    const floor = typeof row.distinct_ever === 'number' ? row.distinct_ever : null;
    const reported = typeof row.google_reported_users === 'number' ? row.google_reported_users : null;
    const used = floor == null ? null : Math.max(floor, reported ?? 0);
    return decideGmailOAuthCap(used);
  } catch {
    return decideGmailOAuthCap(null);
  }
}

export const GMAIL_OAUTH_CAP_EVENT = 'gmail.oauth_cap_closed';
/** At most one alert per this window, however many requests see the cap closed. */
export const GMAIL_OAUTH_ALERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tell the owner the gate has closed: a system_events row, which system-notify
 * turns into an email. Deduplicated to one per GMAIL_OAUTH_ALERT_WINDOW_MS.
 * Never throws; an unreadable count is logged but not emailed (it is not the
 * cap closing).
 */
export async function alertGmailOAuthCapClosed(
  serviceClient: SupabaseClient<Database>,
  state: GmailOAuthCapState,
  now: Date = new Date(),
): Promise<'sent' | 'deduped' | 'skipped'> {
  try {
    if (!state.closed) return 'skipped';
    if (state.used == null) {
      console.warn('[gmail-oauth-gate] cap count unreadable; Gmail sign-in hidden for new connections');
      return 'skipped';
    }
    console.warn(`[gmail-oauth-gate] Gmail OAuth closed to new connections: ${state.used}/${GMAIL_OAUTH_USER_CAP} used`);
    const since = new Date(now.getTime() - GMAIL_OAUTH_ALERT_WINDOW_MS).toISOString();
    const { count, error } = await serviceClient
      .from('system_events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', GMAIL_OAUTH_CAP_EVENT)
      .gte('created_at', since);
    if (error || (count ?? 0) > 0) return 'deduped';
    await serviceClient.rpc('emit_system_event', {
      p_event_type: GMAIL_OAUTH_CAP_EVENT,
      p_payload: {
        used: state.used,
        remaining: state.remaining,
        cap: GMAIL_OAUTH_USER_CAP,
        reserve: GMAIL_OAUTH_RESERVE,
      },
    });
    return 'sent';
  } catch (err) {
    console.warn('[gmail-oauth-gate] alert failed', err instanceof Error ? err.message : err);
    return 'skipped';
  }
}
