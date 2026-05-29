'use client';

/**
 * app/global-error.js
 *
 * Rendered when an error is thrown inside the root layout itself (which is
 * rare, but catastrophic when it happens). Because it replaces the root
 * layout, it MUST include <html> and <body> tags and import its own styles.
 * The root layout's imports are not available here.
 *
 * Props:
 *   reset : call this to attempt re-rendering the root layout
 */

import '../styles/theme.css';
import '../styles/colors_and_type.css';
import '../styles/marketing.css';

export default function GlobalError({ reset }) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var t = localStorage.getItem("mcpe-theme") || "light";
                  document.documentElement.setAttribute("data-theme", t);
                } catch(e) {
                  document.documentElement.setAttribute("data-theme", "light");
                }
              })();
            `,
          }}
        />
      </head>
      <body>
        <div className="auth-shell">
          <div className="auth-wrap">
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
                  stroke="var(--red-700)"
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

              <h1>Critical error</h1>

              <p className="sub">
                A critical error has occurred. Reload the page to try again.
                If the problem persists, please contact{' '}
                <a href="mailto:support@mcpemails.com" style={{ color: 'var(--brand)' }}>
                  support@mcpemails.com
                </a>
                .
              </p>

              {/* Primary CTA: retry */}
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
                Reload
              </button>

              {/* Secondary CTA: homepage (hard navigation to escape bad state) */}
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
                Go to homepage
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
