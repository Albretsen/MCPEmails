/**
 * Has the person behind a billing email deleted their account?
 *
 * WHY THIS EXISTS. delete-account cancels the subscription itself and stamps
 * `cancellation_details.comment = 'account_deleted'`, which the webhook reads
 * to skip the cancellation series. A subscription cancelled any other way on an
 * account that is already gone (from the Stripe dashboard, or by Stripe when
 * the retries run out) carries no such comment, so the webhook queued
 * cancel_ask plus both win-backs to someone who had deleted everything. The
 * dispatcher now asks this question before every send, and the webhook before
 * it queues.
 *
 * THE SIGNAL. delete-account bans the auth user for ~100 years and stamps
 * `app_metadata.deleted_at` in the same call. Either one counts. An auth user
 * that no longer exists at all counts too.
 *
 * WHY NOT "OWNS NO LIVE WORKSPACE". Deleting a single workspace
 * (DELETE /api/workspaces/[id]) soft-deletes it and drops its memberships
 * while the account stays usable, so a workspace-based test would also catch a
 * customer who still has a login and is owed their billing mail. The ban is
 * written by delete-account only.
 *
 * Server-side only: needs the service-role client for auth.admin.
 */

/** What the dispatcher writes into `billing_email_sends.cancel_reason`. */
export const ACCOUNT_DELETED_REASON = 'account_deleted';

export type AccountState = 'live' | 'deleted' | 'unknown';

/** The slice of the service-role client this needs, so tests can pass a stand-in. */
export interface AuthAdminReader {
  auth: {
    admin: {
      getUserById(id: string): Promise<{
        data: {
          user: {
            banned_until?: string | null;
            app_metadata?: Record<string, unknown> | null;
          } | null;
        };
        error: { message: string; status?: number } | null;
      }>;
    };
  };
}

/**
 * `'deleted'` when the account was deleted, `'live'` when it was not (or there
 * is no user to ask about), `'unknown'` when the auth read failed. Never throws.
 * The caller decides what `'unknown'` means; the dispatcher retries it on the
 * next tick, the same as a failed Stripe read.
 */
export async function accountState(
  db: AuthAdminReader,
  userId: string | null | undefined,
  now: number = Date.now(),
): Promise<AccountState> {
  if (!userId) return 'live';
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) return error.status === 404 ? 'deleted' : 'unknown';
    const user = data?.user;
    if (!user) return 'deleted';
    if (user.app_metadata?.deleted_at) return 'deleted';
    if (user.banned_until && new Date(user.banned_until).getTime() > now) return 'deleted';
    return 'live';
  } catch {
    return 'unknown';
  }
}
