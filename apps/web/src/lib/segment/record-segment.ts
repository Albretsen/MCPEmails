import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { emailSegment } from '@/lib/segment/consumer-domains.mjs';

/**
 * Write the owner's signup-email segment onto their workspace, once.
 *
 * WHERE IT RUNS. From the dashboard's server render, not from the auth
 * callback: password signups never pass through /auth/callback (email
 * confirmation is off, so signUp returns a session and the browser goes
 * straight to /dashboard), and OAuth signups land on /dashboard next anyway.
 * The dashboard is the one place every signup path reaches, which is why the
 * experiment-subject join lives there too.
 *
 * WHICH ACCOUNTS. Only accounts inside SEGMENT_STAMP_WINDOW_MS of creation, so
 * a returning customer's dashboard load costs nothing. Everything older is
 * classified once by scripts/backfill-email-segment.mjs, with this same
 * function, so the whole table is one definition.
 *
 * FIRST WRITE WINS. The update is filtered on `acquisition_email_segment IS
 * NULL`, like the other acquisition columns, so a later render (or a later
 * change of account email) never rewrites what was true at signup.
 *
 * OWNER ONLY. The segment describes who pays for the workspace. A member's
 * address says nothing about that, and the caller passes only the workspaces
 * this user owns.
 *
 * Never throws. An analytics write must not be able to break the dashboard,
 * and until the migration is applied in an environment the update fails on an
 * unknown column, which is logged and otherwise ignored.
 */
export const SEGMENT_STAMP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function shouldStampSegment(
  userCreatedAt: string | number | null | undefined,
  now: number = Date.now(),
): boolean {
  const created = typeof userCreatedAt === 'number' ? userCreatedAt : Date.parse(userCreatedAt ?? '');
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  // A little negative age is clock skew between the auth server and this one.
  return age > -5 * 60 * 1000 && age < SEGMENT_STAMP_WINDOW_MS;
}

export async function stampAcquisitionSegment(
  db: SupabaseClient<Database>,
  args: {
    workspaceId: string | null | undefined;
    ownerEmail: string | null | undefined;
    userCreatedAt: string | number | null | undefined;
    now?: number;
  },
): Promise<void> {
  try {
    if (!args.workspaceId) return;
    if (!shouldStampSegment(args.userCreatedAt, args.now)) return;
    const { error } = await db
      .from('workspaces')
      .update({ acquisition_email_segment: emailSegment(args.ownerEmail) })
      .eq('id', args.workspaceId)
      .is('acquisition_email_segment', null);
    if (error) console.error('[segment] stamp failed', { error: error.message });
  } catch (err) {
    console.error('[segment] stamp threw', { error: err instanceof Error ? err.message : String(err) });
  }
}
