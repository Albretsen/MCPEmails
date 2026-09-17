/**
 * The sentinel -> HTTP mapping for POST /api/workspaces/invite/[token]/accept.
 *
 * WHY THIS IS A MODULE AND NOT A CHAIN OF `if`s INSIDE THE ROUTE. Every branch
 * here corresponds to a `RAISE EXCEPTION ... USING ERRCODE` in the
 * `accept_workspace_invite` PL/pgSQL function, and an unmapped sentinel does
 * not fail loudly: it falls through to the generic 500, which reads to the
 * person accepting as "the site is broken" rather than "your workspace needs
 * the Team plan". Two of these branches were dead code for seventeen days,
 * from 2026-08-30 until 2026-09-17, because the migration that raises
 * P0006/P0007 was written and committed but never applied to production. The
 * route claimed to handle them and the database never sent them, and nothing
 * in the test suite could tell, because the mapping was buried in a route
 * handler that no test imports.
 *
 * So the mapping lives here, where a test can exercise all seven sentinels
 * directly. If a future migration adds an eighth, the exhaustiveness test in
 * invite-accept-error.test.ts is the thing that notices.
 *
 * MATCHING IS BY SUBSTRING, deliberately. PostgREST wraps the PL/pgSQL message
 * ("workspace_seat_limit") in its own envelope, so the client-visible
 * `error.message` contains the sentinel rather than equalling it. The sentinels
 * are distinct non-overlapping tokens, so substring matching cannot pick the
 * wrong branch. ORDER IS PRESERVED from the original route for that reason and
 * no other: it is not load-bearing today, but a future sentinel that contains
 * an existing one as a substring would make it load-bearing silently.
 */

export interface InviteAcceptErrorResponse {
  status: number;
  body: {
    error: string;
    error_code?: string;
    upgrade_url?: string;
  };
}

/**
 * Every sentinel `accept_workspace_invite` can raise, in the order the route
 * tests them. Exported so the test can assert the mapping is total.
 */
export const INVITE_ACCEPT_SENTINELS = [
  'invite_not_found',
  'invite_already_accepted',
  'invite_expired',
  'invite_email_mismatch',
  'already_a_member',
  'workspace_seat_limit',
  'workspace_unavailable',
] as const;

export type InviteAcceptSentinel = (typeof INVITE_ACCEPT_SENTINELS)[number];

/**
 * Map a PostgREST error message to the response the route should send.
 *
 * Returns null when the message carries no known sentinel. The route logs that
 * case and answers 500: an unrecognised database error is a bug, not a
 * condition to explain to the user.
 */
export function mapInviteAcceptError(message: string): InviteAcceptErrorResponse | null {
  const msg = message ?? '';

  if (msg.includes('invite_not_found')) {
    return { status: 404, body: { error: 'Invite not found.' } };
  }
  if (msg.includes('invite_already_accepted')) {
    return { status: 409, body: { error: 'This invite has already been accepted.' } };
  }
  if (msg.includes('invite_expired')) {
    return { status: 410, body: { error: 'This invite has expired.' } };
  }
  if (msg.includes('invite_email_mismatch')) {
    return {
      status: 403,
      body: {
        error: 'This invite was sent to a different email address. Sign in with the correct account to accept it.',
        error_code: 'invite_email_mismatch',
      },
    };
  }
  if (msg.includes('already_a_member')) {
    return { status: 409, body: { error: 'You are already a member of this workspace.' } };
  }

  // Both of these are re-checks the RPC performs at REDEMPTION time, because an
  // invite is live for 7 days and the conditions that made it legitimate can
  // lapse inside that window: the workspace can downgrade off the Team plan
  // (seats are a Team capability) or be deleted outright.
  if (msg.includes('workspace_seat_limit')) {
    return {
      status: 403,
      body: {
        error: 'This workspace has no seat available. Its owner needs the Team plan to add collaborators.',
        error_code: 'member_limit_reached',
        upgrade_url: '/pricing',
      },
    };
  }
  if (msg.includes('workspace_unavailable')) {
    return {
      status: 410,
      body: { error: 'This workspace no longer exists.', error_code: 'workspace_unavailable' },
    };
  }

  return null;
}
