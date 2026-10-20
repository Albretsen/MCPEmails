// ---------------------------------------------------------------------------
// Release flag for every SSO entry point in the UI.
//
// SAML SSO ships dark: the routes and tables are in production, but nobody
// sees an SSO link on the login page or an SSO card on the Security page
// until the owner sets NEXT_PUBLIC_SSO_ENABLED=true on Vercel (and redeploys;
// NEXT_PUBLIC_ values are inlined at build time). Turn it on only after the
// auth hooks are registered and the SSO signup migration
// (20261019140500_sso_user_signup_triggers.sql) is applied.
//
// Read as a literal process.env.NEXT_PUBLIC_* access so Next inlines it in
// client bundles.
// ---------------------------------------------------------------------------

export function ssoUiEnabled() {
  return process.env.NEXT_PUBLIC_SSO_ENABLED === 'true';
}
