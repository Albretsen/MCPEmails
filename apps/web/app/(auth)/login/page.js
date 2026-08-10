import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { LoginApp } from '../../../components/auth/LoginApp';

export const metadata = {
  title: 'Sign in · mcpemails',
  description: 'Sign in to your mcpemails workspace',
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

  return <LoginApp redirectTo={safeRedirect} />;
}
