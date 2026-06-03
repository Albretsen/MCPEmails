/**
 * Single source of truth for whether mcpemails.com is still going through
 * Google's OAuth verification / CASA security assessment and Microsoft's
 * publisher verification.
 *
 * While this is `true`, the Gmail and Outlook connect flows surface an
 * in-product warning that explains the "Google hasn't verified this app"
 * screen, how to proceed through it, and that access tokens expire roughly
 * every 7 days until verification completes.
 *
 * Toggle via the `NEXT_PUBLIC_OAUTH_VERIFICATION_PENDING` env var. Because we
 * are currently unverified, the warning is treated as ENABLED when the var is
 * unset. Set the var to `false` (or `0`) once both Google verification and
 * Microsoft publisher verification are complete — no code change required.
 *
 * The `NEXT_PUBLIC_` prefix is required: this flag is read from a client
 * component (the connect modal), so the value must be inlined at build time.
 */
export const OAUTH_VERIFICATION_PENDING: boolean =
  process.env.NEXT_PUBLIC_OAUTH_VERIFICATION_PENDING !== 'false' &&
  process.env.NEXT_PUBLIC_OAUTH_VERIFICATION_PENDING !== '0';
