// ---------------------------------------------------------------------------
// Release flag for the "Sign in with Microsoft" button on /login and /signup.
//
// The /auth/microsoft route and the callback guard are in production, but the
// Supabase `azure` provider is still disabled, so the button would only lead
// to /auth/error. It stays hidden until the owner sets
// NEXT_PUBLIC_MICROSOFT_SIGN_IN_ENABLED=true on Vercel (and redeploys;
// NEXT_PUBLIC_ values are inlined at build time). Turn it on only after the
// Custom Access Token hook is registered and the azure provider is enabled.
//
// Read as a literal process.env.NEXT_PUBLIC_* access so Next inlines it in
// client bundles.
// ---------------------------------------------------------------------------

export function microsoftSignInEnabled() {
  return process.env.NEXT_PUBLIC_MICROSOFT_SIGN_IN_ENABLED === 'true';
}
