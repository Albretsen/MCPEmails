import { LoginApp } from '../../../components/auth/LoginApp';

export const metadata = {
  title: 'Sign in · mcpemails',
  description: 'Sign in to your mcpemails workspace',
};

/**
 * /login — magic-link sign-in page.
 *
 * Server Component shell: renders the LoginApp Client Component which
 * handles form state, Supabase OTP sign-in, and the success state.
 * Middleware redirects already-authenticated users to /dashboard before
 * this page is ever rendered.
 */
export default function LoginPage() {
  return <LoginApp />;
}
