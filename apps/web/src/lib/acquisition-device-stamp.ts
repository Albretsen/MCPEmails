import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { sanitizedDevice } from '@/lib/acquisition-device.mjs';

/**
 * Write the device class of a signup onto the new owner's workspace, once.
 *
 * WHERE IT RUNS. On the first request the new user's OWN browser makes to this
 * server, because only that request carries the browser's User-Agent. There is
 * one such place per signup method:
 *
 *   - Google and GitHub: /auth/callback. The provider redirects the browser
 *     there, and the account was created by that very exchange. The Supabase
 *     session itself is made server-side, which is why auth.sessions says
 *     `node` for these signups and cannot be used instead.
 *   - Password: the first dashboard render. Email confirmation is off, so
 *     signUp() goes from the browser straight to Supabase and the browser then
 *     loads /dashboard; no request of ours sees the signup itself, and
 *     /auth/callback is never visited. Same place and same reasoning as
 *     stampAcquisitionSegment. A magic-link account made from the login page
 *     has the `email` provider too and is caught here if the link is opened
 *     inside the window.
 *
 * The class is derived on the server from that request's headers (see
 * acquisition-device.mjs). Nothing the page sends is trusted: there is no
 * query parameter or metadata field for it, and whatever a caller passes is
 * still checked against the three allowed words here.
 *
 * WHICH ACCOUNTS. Only brand-new ones. The callback gates on
 * isNewAccountSignup like the attribution write beside it. The dashboard gates
 * on DEVICE_STAMP_WINDOW_MS, deliberately far shorter than the segment's 24
 * hours: an email address is the same tomorrow, but the device a person comes
 * back on is not, and "signed up on a phone, returned on a laptop" is the very
 * thing this column exists to see. A signup that misses the window stays NULL,
 * which is honest.
 *
 * FIRST WRITE WINS. Filtered on `acquisition_device IS NULL`, like the other
 * acquisition columns. An unknown class (null) is not written at all.
 *
 * OWNER ONLY. Filtered on owner_id, so it lands on the workspace the signup
 * trigger created for this user and never on a workspace they were invited to.
 *
 * Never throws. An analytics write must not be able to break a sign-in or the
 * dashboard, and until the migration is applied the update fails on an unknown
 * column, which is logged and otherwise ignored.
 */
export const DEVICE_STAMP_WINDOW_MS = 10 * 60 * 1000;

/**
 * The dashboard's gate: a password (or magic-link) account that is minutes
 * old. OAuth accounts are left to /auth/callback, so each signup method has
 * exactly one place that writes.
 */
export function shouldStampDeviceOnDashboard(
  args: {
    provider: unknown;
    userCreatedAt: string | number | null | undefined;
  },
  now: number = Date.now(),
): boolean {
  if (args.provider !== 'email') return false;
  const created = typeof args.userCreatedAt === 'number'
    ? args.userCreatedAt
    : Date.parse(args.userCreatedAt ?? '');
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  // A little negative age is clock skew between the auth server and this one.
  return age > -2 * 60 * 1000 && age < DEVICE_STAMP_WINDOW_MS;
}

export async function stampAcquisitionDevice(
  db: Pick<SupabaseClient<Database>, 'from'>,
  args: {
    ownerId: string | null | undefined;
    device: string | null | undefined;
  },
): Promise<void> {
  try {
    const device = sanitizedDevice(args.device);
    if (!args.ownerId || !device) return;
    const { error } = await db
      .from('workspaces')
      .update({ acquisition_device: device })
      .eq('owner_id', args.ownerId)
      .is('acquisition_device', null);
    if (error) console.error('[device] stamp failed', { error: error.message });
  } catch (err) {
    console.error('[device] stamp threw', { error: err instanceof Error ? err.message : String(err) });
  }
}
