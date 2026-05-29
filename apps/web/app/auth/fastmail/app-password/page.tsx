import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: JSX component; TypeScript finds it at runtime via allowJs
import { FastmailAppPasswordForm } from '../../../../components/auth/FastmailAppPasswordForm';

/**
 * /auth/fastmail/app-password
 *
 * Server Component shell for the Fastmail app-password connection page.
 *
 * Guards the page server-side: unauthenticated users are redirected to login
 * before the form is ever rendered. The client component (FastmailAppPasswordForm)
 * handles form state, submission, and the redirect to /dashboard/inboxes on success.
 *
 * This route is linked from /auth/fastmail (the OAuth initiation route) as an
 * alternative for users who prefer app passwords over OAuth, or whose Fastmail
 * organisation has disabled third-party OAuth.
 *
 * References:
 *   Documents/Architecture/email-provider-oauth-flows.md §4 (app-password section)
 */

export const metadata = {
  title: 'Connect Fastmail · mcpemails',
  description: 'Connect your Fastmail account with an app password',
};

export default async function FastmailAppPasswordPage() {
  // Guard: only authenticated users may reach this page.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?next=/auth/fastmail/app-password');
  }

  return (
    <main className="app-password-page">
      <FastmailAppPasswordForm />
    </main>
  );
}
