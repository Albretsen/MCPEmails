import '../../styles/theme.css';
import '../../styles/marketing.css';
import '../../styles/dashboard.css';
import { SignupApp } from '../../components/auth/SignupApp';
import {
  CLIENT_INTENT_PARAM,
  CONNECT_INTENT_PARAM,
  clientIntentShape,
  connectIntentSlugShape,
} from '@/lib/connect/intent-carry.mjs';

export const metadata = {
  title: 'Create your account',
  description: 'Create your MCPEmails account and connect your first inbox',
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

  // The provider a /connect/<slug> page sent this visitor for. Only its shape
  // is checked here; the dashboard validates it against the registry.
  const connectProvider = connectIntentSlugShape(params?.[CONNECT_INTENT_PARAM]);

  // The AI app this visitor came for (`?client=claude`), carried the same way
  // into the first run; the /onboarding chip starts from it.
  const connectClient = clientIntentShape(params?.[CLIENT_INTENT_PARAM]);

  return <SignupApp redirectTo={safeRedirect} connectProvider={connectProvider} connectClient={connectClient} />;
}
