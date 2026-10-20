import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { LoginApp } from '../../../components/auth/LoginApp';
import { CONNECT_INTENT_PARAM, connectIntentSlugShape } from '@/lib/connect/intent-carry.mjs';

export const metadata = {
  title: 'Sign in · MCP Emails',
  description: 'Sign in to your MCP Emails workspace',
};

export default async function LoginPage({ searchParams }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    const params = await searchParams;
    const redirectTo =
      typeof params?.redirect === 'string' && params.redirect.startsWith('/')
        ? params.redirect
        : '/dashboard';
    redirect(redirectTo);
  }

  const params = await searchParams;
  const redirectParam = typeof params?.redirect === 'string' ? params.redirect : null;
  const safeRedirect =
    redirectParam?.startsWith('/') &&
    !redirectParam.startsWith('//') &&
    !redirectParam.startsWith('/\\')
      ? redirectParam
      : null;

  // Someone who pressed "Connect IONOS free" and already has an account ends
  // up here. Carry the provider on, shape-checked only (see intent-carry.mjs).
  const connectProvider = connectIntentSlugShape(params?.[CONNECT_INTENT_PARAM]);

  // `/login?sso=1` (or GET /auth/sso) opens the "Sign in with SSO" form.
  const initialMode = params?.sso === '1' ? 'sso' : 'password';

  return <LoginApp redirectTo={safeRedirect} connectProvider={connectProvider} initialMode={initialMode} />;
}
