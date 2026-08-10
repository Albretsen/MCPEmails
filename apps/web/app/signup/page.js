import '../../styles/theme.css';
import '../../styles/marketing.css';
import '../../styles/dashboard.css';
import { SignupApp } from '../../components/auth/SignupApp';

export const metadata = {
  title: 'Create workspace · mcpemails',
  description: 'Create your mcpemails workspace and connect your first inbox',
};

/**
 * /signup: account creation page.
 *
 * Server Component shell: renders the SignupApp Client Component which
 * handles form state, Supabase email/password sign-up, and the
 * "check your email" success state.
 * Middleware redirects already-authenticated users to /dashboard before
 * this page is ever rendered.
 */
export default async function SignupPage({ searchParams }) {
  const params = await searchParams;
  const redirect = typeof params?.redirect === 'string' ? params.redirect : null;
  const safeRedirect =
    redirect?.startsWith('/') &&
    !redirect.startsWith('//') &&
    !redirect.startsWith('/\\')
      ? redirect
      : null;

  return <SignupApp redirectTo={safeRedirect} />;
}
