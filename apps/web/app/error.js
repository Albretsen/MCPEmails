'use client';

/**
 * app/error.js
 *
 * Root-level error boundary rendered when an unhandled runtime error occurs
 * inside the root layout's children. Next.js requires this to be a Client
 * Component so it can accept the `reset` callback.
 *
 * Props:
 *   error  — the Error that was thrown (message may be shown in development)
 *   reset  — call this to attempt re-rendering the failed subtree
 *
 * CSS is inherited from the root layout (theme.css, colors_and_type.css,
 * marketing.css), so the `.auth-shell` / `.auth-card` classes are available.
 */
export default function ErrorPage({ reset }) {
  return (
    <div className="auth-shell">
      <div className="auth-wrap">
        {/* Back link */}
        <a className="auth-back" href="/">
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
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          Back to home
        </a>

        {/* Brand */}
        <div className="auth-brand">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        {/* Card */}
        <div className="auth-card">
          {/* Icon */}
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 999,
              background: 'var(--amber-100)',
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
              stroke="var(--amber-700)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>

          {/* Error code */}
          <p
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-12)',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--amber-700)',
              margin: '0 0 8px',
            }}
          >
            Error 500
          </p>

          <h1>Something went wrong</h1>

          <p className="sub">
            An unexpected error occurred. This has been noted and we&rsquo;ll
            look into it. You can try reloading, or head back to the dashboard.
          </p>

          {/* Primary CTA — retry */}
          <button
            type="button"
            onClick={reset}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              height: 42,
              borderRadius: 8,
              background: 'var(--brand)',
              color: 'var(--fg-on-brand)',
              fontFamily: 'var(--font-sans)',
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: '0.01em',
              border: 'none',
              cursor: 'pointer',
              marginBottom: 10,
              transition: 'background var(--dur-1) var(--ease-out)',
            }}
          >
            Try again
          </button>

          {/* Secondary CTA — dashboard */}
          <a
            href="/dashboard"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 42,
              borderRadius: 8,
              background: 'var(--bg-surface)',
              color: 'var(--fg-1)',
              border: '1px solid var(--border-1)',
              fontFamily: 'var(--font-sans)',
              fontSize: 14,
              fontWeight: 500,
              textDecoration: 'none',
              letterSpacing: '0.01em',
              marginBottom: 10,
              transition: 'background var(--dur-1) var(--ease-out)',
            }}
          >
            Go to dashboard
          </a>

          {/* Tertiary CTA — homepage */}
          <a
            href="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 42,
              borderRadius: 8,
              background: 'transparent',
              color: 'var(--fg-3)',
              fontFamily: 'var(--font-sans)',
              fontSize: 14,
              fontWeight: 500,
              textDecoration: 'none',
              letterSpacing: '0.01em',
              transition: 'color var(--dur-1) var(--ease-out)',
            }}
          >
            Back to homepage
          </a>
        </div>
      </div>
    </div>
  );
}
