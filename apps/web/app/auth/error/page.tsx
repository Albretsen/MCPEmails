import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign-in error · mcpemails',
  description: 'Something went wrong during sign-in',
};

/**
 * Friendly labels for known `reason` values that the /auth/callback route
 * sets in the query string. For any other value, a generic fallback is shown.
 */
const ERROR_MESSAGES: Record<string, string> = {
  missing_code:
    'This sign-in link is invalid or has already been used. Links can only be clicked once.',
  'Email link is invalid or has expired':
    'This sign-in link has expired. Links are valid for 60 minutes — please request a new one.',
  'Auth session missing':
    'Your session could not be established. This can happen if cookies are blocked in your browser.',
};

const GENERIC_MESSAGE =
  'Something went wrong while signing you in. Please try again — if the problem persists, contact support.';

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
 * This is a Server Component — no client-side JS needed. Reads `searchParams`
 * as a Promise per the Next.js 15 dynamic API requirement.
 */
export default async function AuthErrorPage({ searchParams }: Props) {
  const params = await searchParams;
  const rawReason = params.reason ?? '';

  const message =
    ERROR_MESSAGES[rawReason] ??
    (rawReason.length > 0 ? ERROR_MESSAGES[rawReason] : null) ??
    GENERIC_MESSAGE;

  return (
    <div className="auth-shell">
      <div className="auth-wrap">
        <a className="auth-back" href="/">
          {/* Inline SVG arrow — matches MIcon "arrow" without a client import */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
          Back to home
        </a>

        <div className="auth-brand">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        <div className="auth-card">
          {/* Error icon */}
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 999,
              background: 'var(--red-100)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20,
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--red-600)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>

          <h1>Sign-in failed</h1>

          <p
            className="sub"
            role="alert"
            style={{ marginBottom: 24 }}
          >
            {message}
          </p>

          <a
            href="/login"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 42,
              borderRadius: 8,
              background: 'var(--cobalt-500)',
              color: '#fff',
              fontFamily: 'var(--font-sans)',
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
              letterSpacing: '0.01em',
            }}
          >
            Try signing in again
          </a>
        </div>
      </div>
    </div>
  );
}
