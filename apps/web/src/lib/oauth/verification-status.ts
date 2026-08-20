/**
 * Single source of truth for whether mcpemails.com is an unverified Google
 * OAuth app.
 *
 * While this is `true`, the Gmail connect flow shows a walkthrough of the
 * "Google hasn't verified this app" screen and the exact buttons needed to get
 * past it.
 *
 * Two things this flag no longer means, both of which it used to:
 *
 *  1. It is not a "review in progress" state. Google verification requires a
 *     paid third-party CASA security assessment that is not being bought, so
 *     being unverified is the steady state, not a phase. The flag should stay
 *     on, and the copy it gates must not promise that the screen goes away.
 *  2. It has nothing to do with token lifetime. The old comment here claimed
 *     access expires "roughly every 7 days" while unverified. That is wrong and
 *     conflates two unrelated things: the 7-day refresh-token expiry applies to
 *     Google Cloud projects left in *Testing* publishing status, which is not
 *     the same as being unverified. Access tokens last an hour and are renewed
 *     by the gmail-token-refresh job; the refresh token behind them is only
 *     invalidated when the user revokes access. Production agrees: the oldest
 *     Gmail inbox has been connected and healthy for 82 days, and the only
 *     Gmail inboxes in an error state got there by explicit revocation.
 *
 * Toggle via the `NEXT_PUBLIC_OAUTH_VERIFICATION_PENDING` env var; treated as
 * ENABLED when unset. Setting it to `false` hides the walkthrough, which is
 * only correct if the app actually becomes verified.
 *
 * The `NEXT_PUBLIC_` prefix is required: this flag is read from a client
 * component (the connect modal), so the value must be inlined at build time.
 */
export const OAUTH_VERIFICATION_PENDING: boolean =
  process.env.NEXT_PUBLIC_OAUTH_VERIFICATION_PENDING !== 'false' &&
  process.env.NEXT_PUBLIC_OAUTH_VERIFICATION_PENDING !== '0';
