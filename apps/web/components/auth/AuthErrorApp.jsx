'use client';

import { useTranslations } from 'next-intl';

/**
 * AuthErrorApp: client component rendering the /auth/error screen UI.
 *
 * Extracted from app/auth/error/page.tsx so the visible copy can be localized
 * via next-intl's useTranslations('auth'). The server page resolves the error
 * `reason` into a message key and passes it as the `messageKey` prop.
 */
export function AuthErrorApp({ messageKey }) {
  const t = useTranslations('auth');
  const message = t(`error.${messageKey}`);

  return (
    <div className="auth-shell">
      <div className="auth-wrap">
        <a className="auth-back" href="/">
          {/* Inline SVG arrow, matches MIcon "arrow" without a client import */}
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
          {t('error.backToHome')}
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

          <h1>{t('error.title')}</h1>

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
            {t('error.tryAgain')}
          </a>
        </div>
      </div>
    </div>
  );
}
