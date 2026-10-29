import type { Metadata } from 'next';
import { AuthErrorApp } from '../../../components/auth/AuthErrorApp';
import { SSO_REQUIRED_REASON } from '@/lib/sso/enforcement';

export const metadata: Metadata = {
  title: 'Sign-in error',
  description: 'Something went wrong during sign-in',
};

/**
 * Maps known `reason` values that the /auth/callback route sets in the query
 * string to a translation key under the `auth.error.*` namespace. For any
 * other value, the generic key is used.
 */
const ERROR_MESSAGE_KEYS: Record<string, string> = {
  missing_code: 'missingCode',
  'Email link is invalid or has expired': 'linkExpired',
  'Auth session missing': 'sessionMissing',
  sso_not_configured: 'ssoNotConfigured',
  sso_join_failed: 'ssoJoinFailed',
  oauth_cancelled: 'oauthCancelled',
  microsoft_admin_approval: 'microsoftAdminApproval',
  microsoft_email_unverified: 'microsoftEmailUnverified',
  provider_email_unverified: 'providerEmailUnverified',
  [SSO_REQUIRED_REASON]: 'ssoRequired',
};

/**
 * Reason codes the Supabase auth hooks return as their error message. The
 * callback forwards Supabase's error text, which may carry more than the bare
 * code, so these match anywhere in the reason. 'sso_not_configured' is the
 * SSO domain-binding refusal; its message key comes with the SAML sign-in
 * change (PR #151), and until then it shows the generic message.
 */
const HOOK_REASONS = [SSO_REQUIRED_REASON, 'sso_not_configured', 'microsoft_email_unverified'];

const GENERIC_MESSAGE_KEY = 'generic';

interface Props {
  searchParams: Promise<{ reason?: string }>;
}

/**
 * /auth/error
 *
 * Shown when the /auth/callback route handler cannot exchange a code for a
 * session. The `reason` query param carries either a known key
 * ("missing_code") or the raw Supabase error message, both of which are
 * mapped to user-friendly copy.
 *
 * This is a Server Component, no client-side JS needed. Reads `searchParams`
 * as a Promise per the Next.js 15 dynamic API requirement.
 */
export default async function AuthErrorPage({ searchParams }: Props) {
  const params = await searchParams;
  const rawReason = params.reason ?? '';

  const hookReason = HOOK_REASONS.find((code) => rawReason.includes(code));
  const messageKey = ERROR_MESSAGE_KEYS[rawReason] ?? (hookReason && ERROR_MESSAGE_KEYS[hookReason]) ?? GENERIC_MESSAGE_KEY;

  return <AuthErrorApp messageKey={messageKey} />;
}
