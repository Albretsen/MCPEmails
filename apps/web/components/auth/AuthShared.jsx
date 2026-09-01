'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { MIcon } from '../MarketingPrimitives';

export function ThemeBtn() {
  const t = useTranslations('auth');
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // Reads the theme the pre-paint script already applied to <html>. It cannot be a useState
    // initialiser: there is no document during the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(
      typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-theme') === 'dark'
    );
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try {
      localStorage.setItem('mcpe-theme', dark ? 'dark' : 'light');
    } catch {}
  }, [dark]);

  return (
    <button
      className="theme-toggle"
      onClick={() => setDark((d) => !d)}
      title={t('shared.toggleTheme')}
      aria-label={t('shared.toggleTheme')}
    >
      <MIcon name={dark ? 'sun' : 'moon'} size={16} color="currentColor" />
    </button>
  );
}

export function Spinner({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="var(--cobalt-200)" strokeWidth="3" />
      <path
        d="M12 3a9 9 0 0 1 9 9"
        stroke="var(--cobalt-500)"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

export function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958l3.007 2.332C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
    </svg>
  );
}

export function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M9 0C4.025 0 0 4.13 0 9.228c0 4.077 2.576 7.532 6.154 8.749.45.085.614-.2.614-.444 0-.219-.008-.948-.012-1.719-2.503.558-3.032-1.099-3.032-1.099-.409-1.065-1-1.35-1-1.35-.817-.573.062-.561.062-.561.904.065 1.38.952 1.38.952.803 1.41 2.107 1.003 2.62.767.082-.596.314-1.003.571-1.233-1.998-.232-4.1-1.024-4.1-4.558 0-1.007.351-1.83.926-2.476-.093-.233-.402-1.172.088-2.442 0 0 .754-.247 2.473.945A8.442 8.442 0 0 1 9 4.517c.764.004 1.533.106 2.252.31 1.717-1.192 2.47-.945 2.47-.945.492 1.27.183 2.21.09 2.442.577.645.924 1.469.924 2.476 0 3.543-2.105 4.323-4.11 4.55.323.284.61.847.61 1.706 0 1.233-.011 2.227-.011 2.53 0 .246.162.534.619.443C15.427 16.757 18 13.303 18 9.228 18 4.13 13.974 0 9 0Z"/>
    </svg>
  );
}

export function SocialButton({ icon, label, loading, onClick, disabled }) {
  const t = useTranslations('auth');
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 10, width: '100%', minHeight: 44, padding: '10px 16px',
        border: '1px solid rgba(0,0,0,0.15)', borderRadius: 8,
        background: 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !loading ? 0.5 : 1,
        fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 500,
        color: 'var(--fg-1)', marginTop: 8,
        transition: 'opacity 0.15s',
      }}
    >
      {loading ? <Spinner size={18} /> : icon}
      {loading ? t('shared.signingIn') : label}
    </button>
  );
}

export function OrDivider() {
  const t = useTranslations('auth');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0 8px' }}>
      <div style={{ flex: 1, height: 1, background: 'rgba(0,0,0,0.1)' }} />
      <span style={{ fontSize: 12, color: 'var(--fg-3)', fontFamily: 'var(--font-sans)' }}>{t('shared.or')}</span>
      <div style={{ flex: 1, height: 1, background: 'rgba(0,0,0,0.1)' }} />
    </div>
  );
}
