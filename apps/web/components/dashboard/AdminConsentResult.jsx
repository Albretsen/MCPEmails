'use client';

import { useTranslations } from 'next-intl';

/**
 * The public page a Microsoft 365 administrator lands on after following a
 * shared admin-consent link (/auth/outlook/admin-consent/result).
 *
 * The reader is an admin, not an MCP Emails user, so it says what happened in
 * their organisation and what their colleagues do next, and offers nothing
 * that needs an account. The one link into the product is for the colleague
 * case (someone who also uses MCP Emails and wants to connect now).
 *
 * @param {{ status: 'granted'|'cancelled'|'failed'|'link_invalid'|'link_expired'|'timed_out'|'unavailable' }} props
 */
const TONE = {
  granted: { bg: 'var(--mint-100)', fg: 'var(--mint-600)', icon: 'check' },
  cancelled: { bg: 'var(--amber-100)', fg: 'var(--amber-700)', icon: 'info' },
  link_expired: { bg: 'var(--amber-100)', fg: 'var(--amber-700)', icon: 'info' },
  timed_out: { bg: 'var(--amber-100)', fg: 'var(--amber-700)', icon: 'info' },
};
const ERROR_TONE = { bg: 'var(--red-100)', fg: 'var(--red-600)', icon: 'alert' };

function StatusIcon({ kind, color }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  };
  if (kind === 'check') {
    return <svg {...common}><polyline points="20 6 9 17 4 12" /></svg>;
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function AdminConsentResult({ status }) {
  const tr = useTranslations('dashboardChrome');
  const tone = TONE[status] ?? ERROR_TONE;
  const granted = status === 'granted';

  return (
    <div className="auth-shell">
      <div className="auth-wrap">
        <div className="auth-brand">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        <div className="auth-card">
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 999,
              background: tone.bg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20,
            }}
          >
            <StatusIcon kind={tone.icon} color={tone.fg} />
          </div>

          <h1>{tr(`adminConsentResult.${status}Title`)}</h1>

          <p className="sub" role={granted ? 'status' : 'alert'} style={{ marginBottom: 16 }}>
            {tr(`adminConsentResult.${status}Body`)}
          </p>

          <p className="sub" style={{ marginBottom: 24, fontSize: 13 }}>
            {tr('adminConsentResult.closeHint')}
          </p>

          {granted && (
            <a
              href="/dashboard?admin_consent=granted"
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
              {tr('adminConsentResult.openApp')}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
