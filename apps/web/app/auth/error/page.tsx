import type { Metadata } from 'next';
import { AuthErrorApp } from '../../../components/auth/AuthErrorApp';

export const metadata: Metadata = {
  title: 'Sign-in error · mcpemails',
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
};

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

  const messageKey = ERROR_MESSAGE_KEYS[rawReason] ?? GENERIC_MESSAGE_KEY;

  return <AuthErrorApp messageKey={messageKey} />;
}
