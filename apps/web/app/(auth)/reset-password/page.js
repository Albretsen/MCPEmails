import { ResetPasswordApp } from '../../../components/auth/ResetPasswordApp';

export const metadata = {
  title: 'Choose new password · mcpemails',
  description: 'Set a new password for your mcpemails account',
};

/**
 * /reset-password — password reset completion page.
 *
 * Server Component shell: renders the ResetPasswordApp Client Component.
 *
 * The user arrives here after clicking the reset link in their email.
 * The /auth/callback route has already exchanged the code for a recovery
 * session before redirecting to this page. ResetPasswordApp verifies the
 * session on mount, then calls supabase.auth.updateUser({ password }) on
 * submit. On success it signs the user out and redirects to /login.
 *
 * If the user navigates directly here without a valid session (expired or
 * already-used link), ResetPasswordApp shows an "expired" state with a
 * link back to /forgot-password.
 */
export default function ResetPasswordPage() {
  return <ResetPasswordApp />;
}
