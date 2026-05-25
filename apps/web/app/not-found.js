export const metadata = {
  title: '404 – Page not found · mcpemails',
  description: 'The page you are looking for does not exist.',
};

/**
 * app/not-found.js
 *
 * Rendered whenever Next.js cannot match a route, or when a Server Component
 * calls `notFound()`. This is a Server Component — no interactivity needed.
 *
 * Uses the shared `.auth-shell` / `.auth-card` pattern so it looks at home
 * next to other standalone pages (login, auth/error, etc.).
 * CSS is available from the root layout (theme.css, colors_and_type.css,
 * marketing.css).
 */
export default function NotFound() {
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
              background: 'var(--cobalt-50)',
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
              stroke="var(--cobalt-600)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="11" />
              <line x1="11" y1="14" x2="11.01" y2="14" />
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
              color: 'var(--cobalt-600)',
              margin: '0 0 8px',
            }}
          >
            Error 404
          </p>

          <h1>Page not found</h1>

          <p className="sub">
            The page you are looking for does not exist or may have been moved.
            Check the URL, or use one of the links below to get back on track.
          </p>

          {/* Primary CTA — dashboard (likely where the user came from) */}
          <a
            href="/dashboard"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 42,
              borderRadius: 8,
              background: 'var(--brand)',
              color: 'var(--fg-on-brand)',
              fontFamily: 'var(--font-sans)',
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
              letterSpacing: '0.01em',
              marginBottom: 10,
              transition: 'background var(--dur-1) var(--ease-out)',
            }}
          >
            Go to dashboard
          </a>

          {/* Secondary CTA — homepage */}
          <a
            href="/"
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
              transition: 'background var(--dur-1) var(--ease-out)',
            }}
          >
            Back to homepage
          </a>
        </div>
      </div>
    </div>
  );
}
