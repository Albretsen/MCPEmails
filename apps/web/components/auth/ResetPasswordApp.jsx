'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { MIcon, MBtn } from '../MarketingPrimitives';

/**
 * ThemeBtn: floating theme toggle.
 * Duplicated per auth page so auth pages don't depend on a shared wrapper.
 */
function ThemeBtn() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(
      typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-theme') === 'dark'
    );
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try {
      localStorage.setItem('mcpe-theme', dark ? 'dark' : 'light');
    } catch (_) {
      // localStorage unavailable in some environments; safe to ignore
    }
  }, [dark]);

  return (
    <button
      className="theme-toggle"
      onClick={() => setDark((d) => !d)}
      title="Toggle theme"
    >
      <MIcon name={dark ? 'sun' : 'moon'} size={16} color="currentColor" />
    </button>
  );
}

/**
 * Spinner: animated SVG used during async operations.
 */
function Spinner() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
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

/**
 * ResetPasswordApp: the /reset-password page Client Component.
 *
 * Implements the second step of the password reset flow:
 *  1. The user arrives here after clicking the reset link in their email.
 *     The /auth/callback route has already exchanged the code for a recovery
 *     session and written the session cookies.
 *  2. On mount, we verify the session exists. If not (link expired or already
 *     used), we show an "expired" state with a link back to /forgot-password.
 *  3. User enters and confirms their new password (≥ 8 characters).
 *  4. On submit, calls supabase.auth.updateUser({ password }) which updates
 *     the password and promotes the recovery session to a full session.
 *  5. On success, signs out and redirects to /login so the user can sign in
 *     cleanly with their new credentials.
 */
export function ResetPasswordApp() {
  const router = useRouter();
  const t = useTranslations('auth');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [step, setStep] = useState('checking'); // 'checking' | 'form' | 'submitting' | 'success' | 'expired' | 'error'
  const [serverError, setServerError] = useState('');

  /**
   * On mount, verify that a recovery session is present.
   * If the user navigates directly to this page without a valid session
   * (expired link, already used, etc.), we show the expired state.
   */
  useEffect(() => {
    async function checkSession() {
      const supabase = createClient();
      const { data: { user }, error } = await supabase.auth.getUser();

      if (error || !user) {
        setStep('expired');
      } else {
        setStep('form');
      }
    }

    checkSession();
  }, []);

  /** Validate form fields; returns true if all valid. */
  function validate() {
    let valid = true;

    if (!password || password.length < 8) {
      setPasswordError(t('reset.errorPasswordLength'));
      valid = false;
    } else {
      setPasswordError('');
    }

    if (!confirmPassword) {
      setConfirmError(t('reset.errorConfirmRequired'));
      valid = false;
    } else if (password !== confirmPassword) {
      setConfirmError(t('reset.errorMismatch'));
      valid = false;
    } else {
      setConfirmError('');
    }

    return valid;
  }

  async function handleSubmit(e) {
    e?.preventDefault();

    if (!validate()) return;

    setStep('submitting');
    setServerError('');

    const supabase = createClient();

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setServerError(error.message ?? t('reset.errorGeneric'));
      setStep('error');
      return;
    }

    // Password updated. Sign out so the user starts a clean session with
    // their new credentials. This also invalidates the recovery session.
    await supabase.auth.signOut();

    setStep('success');

    // Give the success state a moment to render, then redirect to login.
    setTimeout(() => {
      router.push('/login');
    }, 2000);
  }

  function handlePasswordChange(e) {
    setPassword(e.target.value);
    if (passwordError) setPasswordError('');
  }

  function handleConfirmChange(e) {
    setConfirmPassword(e.target.value);
    if (confirmError) setConfirmError('');
  }

  function handleRetry() {
    setServerError('');
    setStep('form');
  }

  return (
    <div className="auth-shell">
      <ThemeBtn />
      <div className="auth-wrap">
        {/* Back link only shown on the form and error states */}
        {(step === 'form' || step === 'error') && (
          <a className="auth-back" href="/login">
            <MIcon name="arrow" size={14} color="currentColor" strokeWidth={2} />
            {t('reset.backToSignIn')}
          </a>
        )}

        <div className="auth-brand">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        {/* ── Checking session state ───────────────────────────────── */}
        {step === 'checking' && (
          <div
            className="auth-card"
            style={{ textAlign: 'center', padding: '48px 32px' }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 999,
                background: 'var(--cobalt-50)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Spinner />
            </div>
            <p className="sub" style={{ margin: 0 }}>
              {t('reset.verifying')}
            </p>
          </div>
        )}

        {/* ── Expired / invalid session state ─────────────────────── */}
        {step === 'expired' && (
          <div className="auth-card">
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
              <MIcon name="lock" size={22} color="var(--red-600)" />
            </div>
            <h1>{t('reset.expiredTitle')}</h1>
            <p className="sub">
              {t('reset.expiredBody')}
            </p>

            <div style={{ marginTop: 24 }}>
              <MBtn
                variant="primary"
                className="auth-submit"
                onClick={() => router.push('/forgot-password')}
              >
                {t('reset.requestNewLink')}
              </MBtn>
            </div>

            <div className="auth-footer" style={{ marginTop: 16 }}>
              <a href="/login">{t('reset.backToSignIn')}</a>
            </div>
          </div>
        )}

        {/* ── Form state ──────────────────────────────────────────── */}
        {(step === 'form' || step === 'error') && (
          <div className="auth-card">
            <h1>{t('reset.title')}</h1>
            <p className="sub">
              {t('reset.intro')}
            </p>

            {serverError && (
              <div
                role="alert"
                style={{
                  background: 'var(--red-100)',
                  border: '1px solid rgba(229,72,77,0.25)',
                  borderRadius: 8,
                  padding: '10px 14px',
                  marginBottom: 16,
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  color: 'var(--red-700)',
                  lineHeight: 1.5,
                }}
              >
                {serverError}
              </div>
            )}

            <form className="auth-fields" onSubmit={handleSubmit} noValidate>
              <div className="field">
                <label htmlFor="reset-password">{t('reset.newPasswordLabel')}</label>
                <input
                  id="reset-password"
                  className={'input' + (passwordError ? ' err' : '')}
                  type="password"
                  placeholder={t('reset.newPasswordPlaceholder')}
                  autoComplete="new-password"
                  value={password}
                  onChange={handlePasswordChange}
                  aria-invalid={passwordError ? 'true' : undefined}
                  aria-describedby={passwordError ? 'reset-password-error' : undefined}
                />
                {passwordError && (
                  <div id="reset-password-error" className="err-msg" role="alert">
                    {passwordError}
                  </div>
                )}
              </div>

              <div className="field">
                <label htmlFor="reset-confirm">{t('reset.confirmLabel')}</label>
                <input
                  id="reset-confirm"
                  className={'input' + (confirmError ? ' err' : '')}
                  type="password"
                  placeholder={t('reset.confirmPlaceholder')}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={handleConfirmChange}
                  aria-invalid={confirmError ? 'true' : undefined}
                  aria-describedby={confirmError ? 'reset-confirm-error' : undefined}
                />
                {confirmError && (
                  <div id="reset-confirm-error" className="err-msg" role="alert">
                    {confirmError}
                  </div>
                )}
              </div>

              <MBtn
                variant="primary"
                className="auth-submit"
                type="submit"
                onClick={handleSubmit}
              >
                {t('reset.submit')}
              </MBtn>
            </form>
          </div>
        )}

        {/* ── Submitting state ─────────────────────────────────────── */}
        {step === 'submitting' && (
          <div
            className="auth-card"
            style={{ textAlign: 'center', padding: '48px 32px' }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 999,
                background: 'var(--cobalt-50)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Spinner />
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 6px' }}>
              {t('reset.updating')}
            </h1>
            <p className="sub" style={{ margin: 0 }}>
              {t('shared.justAMoment')}
            </p>
          </div>
        )}

        {/* ── Success state ────────────────────────────────────────── */}
        {step === 'success' && (
          <div className="auth-card">
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 999,
                background: 'var(--mint-50)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 20,
              }}
            >
              <MIcon name="check" size={22} color="var(--mint-600)" />
            </div>
            <h1>{t('reset.successTitle')}</h1>
            <p className="sub">
              {t('reset.successBody')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
