import { ForgotPasswordApp } from '../../../components/auth/ForgotPasswordApp';

export const metadata = {
  title: 'Reset password · mcpemails',
  description: 'Reset your mcpemails account password',
};

/**
 * /forgot-password: password reset request page.
 *
 * Server Component shell: renders the ForgotPasswordApp Client Component
 * which handles email input, calls supabase.auth.resetPasswordForEmail(),
 * and transitions to a "check your email" success state.
 *
 * Middleware redirects already-authenticated users to /dashboard before
 * this page is ever rendered.
 */
export default function ForgotPasswordPage() {
  return <ForgotPasswordApp />;
}
