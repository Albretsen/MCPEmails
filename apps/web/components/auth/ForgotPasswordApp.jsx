'use client';

import { useState, useEffect } from 'react';
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
 * ForgotPasswordApp: the /forgot-password page Client Component.
 *
 * Implements the first step of the password reset flow:
 *  1. User enters their email address.
 *  2. On submit, calls supabase.auth.resetPasswordForEmail() which sends a
 *     reset link to the address on file (if an account exists; Supabase does
 *     not reveal whether the address is registered, preventing enumeration).
 *  3. The form always transitions to a "check your email" success state
 *     regardless of whether the address was found, to avoid user enumeration.
 *
 * The reset link in the email points to /auth/callback?next=/reset-password
 * so the callback route exchanges the code for a recovery session and then
 * redirects the user to /reset-password to enter their new password.
 */
export function ForgotPasswordApp() {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [step, setStep] = useState('form'); // 'form' | 'sending' | 'sent' | 'error'
  const [serverError, setServerError] = useState('');

  /** Basic email format validation. */
  function validateEmail(value) {
    if (!value || value.trim() === '') return t('forgot.errorEmailRequired');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()))
      return t('forgot.errorEmailInvalid');
    return '';
  }

  async function handleSubmit(e) {
    e?.preventDefault();

    const validationError = validateEmail(email);
    if (validationError) {
      setEmailError(validationError);
      return;
    }

    setStep('sending');
    setServerError('');

    const supabase = createClient();

    // The reset link will redirect the user to /auth/callback, which exchanges
    // the code for a recovery session, and then forwards them to /reset-password.
    const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;

    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo,
    });

    if (error) {
      // Only surface genuine technical errors, not "user not found" (Supabase
      // handles that transparently to prevent user enumeration).
      setServerError(error.message ?? t('forgot.errorGeneric'));
      setStep('error');
    } else {
      // Always show the success state, even if no account exists for this
      // address, Supabase silently no-ops and returns no error.
      setStep('sent');
    }
  }

  function handleEmailChange(e) {
    setEmail(e.target.value);
    if (emailError) setEmailError('');
    if (serverError) {
      setServerError('');
      setStep('form');
    }
  }

  /** Retry after an error: go back to the form without clearing the email. */
  function handleRetry() {
    setServerError('');
    setStep('form');
  }

  return (
    <div className="auth-shell">
      <ThemeBtn />
      <div className="auth-wrap">
        <a className="auth-back" href="/login">
          <MIcon name="arrow" size={14} color="currentColor" strokeWidth={2} />
          {t('shared.backToSignIn')}
        </a>

        <div className="auth-brand">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        {/* ── Form state ──────────────────────────────────────────── */}
        {(step === 'form' || step === 'error') && (
          <div className="auth-card">
            <h1>{t('forgot.title')}</h1>
            <p className="sub">
              {t('forgot.intro')}
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
                <label htmlFor="forgot-email">{t('forgot.emailLabel')}</label>
                <input
                  id="forgot-email"
                  className={'input' + (emailError ? ' err' : '')}
                  type="email"
                  placeholder={t('forgot.emailPlaceholder')}
                  autoComplete="email"
                  value={email}
                  onChange={handleEmailChange}
                  aria-invalid={emailError ? 'true' : undefined}
                  aria-describedby={emailError ? 'forgot-email-error' : undefined}
                />
                {emailError && (
                  <div id="forgot-email-error" className="err-msg" role="alert">
                    {emailError}
                  </div>
                )}
              </div>

              <MBtn
                variant="primary"
                className="auth-submit"
                type="submit"
                onClick={handleSubmit}
              >
                {t('forgot.submit')}
              </MBtn>
            </form>

            <div className="auth-footer">
              {t('forgot.rememberPrefix')}
              <a href="/login">{t('forgot.signIn')}</a>
            </div>
          </div>
        )}

        {/* ── Sending state ───────────────────────────────────────── */}
        {step === 'sending' && (
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
              {t('forgot.sendingYourLink')}
            </h1>
            <p className="sub" style={{ margin: 0 }}>
              {t('shared.justAMoment')}
            </p>
          </div>
        )}

        {/* ── Sent / success state ─────────────────────────────────── */}
        {step === 'sent' && (
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
              <MIcon name="mail" size={22} color="var(--mint-600)" />
            </div>
            <h1>{t('shared.checkYourEmail')}</h1>
            <p className="sub">
              {t.rich('forgot.sentLead', {
                email,
                strong: (c) => <strong style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{c}</strong>,
              })}
            </p>

            <div
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                color: 'var(--fg-3)',
                marginTop: 8,
                lineHeight: 1.6,
              }}
            >
              {t('shared.didntGetItPrefix')}
              <button
                onClick={handleRetry}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--brand)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: 'underline',
                }}
              >
                {t('shared.tryDifferentAddress')}
              </button>
              .
            </div>

            <div className="auth-footer" style={{ marginTop: 24 }}>
              <a href="/login">{t('forgot.backToSignIn')}</a>
            </div>
          </div>
        )}

        {(step === 'form' || step === 'error') && (
          <div className="auth-microcopy">
            <MIcon name="shield" size={13} color="var(--mint-600)" />
            {t('shared.microcopy')}
          </div>
        )}
      </div>
    </div>
  );
}
