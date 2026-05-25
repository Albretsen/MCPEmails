'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MIcon, MBtn } from '../MarketingPrimitives';

/**
 * ThemeBtn — floating theme toggle.
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
      // localStorage unavailable in some environments — safe to ignore
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
 * Spinner — animated SVG used during async operations.
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
 * LoginApp — the /login page Client Component.
 *
 * Implements magic-link (OTP) sign-in via Supabase Auth:
 *  1. User enters their email.
 *  2. On submit, calls supabase.auth.signInWithOtp() which sends a magic link.
 *  3. The form transitions to a "check your email" success state.
 *  4. Clicking the link takes the user to /auth/callback, which exchanges the
 *     code for a session and redirects to /dashboard.
 *
 * Error states are shown inline. No data ever leaves the browser except via
 * the Supabase SDK call.
 */
export function LoginApp() {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [step, setStep] = useState('form'); // 'form' | 'sending' | 'sent' | 'error'
  const [serverError, setServerError] = useState('');

  /**
   * Builds the Supabase `emailRedirectTo` URL.
   *
   * If the current page URL contains a `redirect` param (set by middleware
   * when an unauthenticated user visits a protected route), it is forwarded
   * as `next` so /auth/callback can redirect the user to their original
   * destination. Only relative paths are forwarded to prevent open-redirect
   * attacks — the callback route applies the same guard.
   */
  function buildCallbackUrl() {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    const callbackUrl = new URL('/auth/callback', process.env.NEXT_PUBLIC_APP_URL || window.location.origin);
    if (redirect && redirect.startsWith('/')) {
      callbackUrl.searchParams.set('next', redirect);
    }
    return callbackUrl.toString();
  }

  /** Basic email format validation. */
  function validateEmail(value) {
    if (!value || value.trim() === '') return 'Enter your email address.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) return 'Enter a valid email address.';
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

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        // After the user clicks the link Supabase redirects to /auth/callback.
        // Forward the `redirect` param (set by middleware when bouncing the
        // user away from a protected route) so the callback can send them
        // back to their intended destination instead of just /dashboard.
        emailRedirectTo: buildCallbackUrl(),
      },
    });

    if (error) {
      setServerError(error.message ?? 'Something went wrong. Please try again.');
      setStep('error');
    } else {
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

  /** Retry after an error — go back to the form state without clearing email. */
  function handleRetry() {
    setServerError('');
    setStep('form');
  }

  return (
    <div className="auth-shell">
      <ThemeBtn />
      <div className="auth-wrap">
        <a className="auth-back" href="/">
          <MIcon name="arrow" size={14} color="currentColor" strokeWidth={2} />
          Back to home
        </a>

        <div className="auth-brand">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        {/* ── Form state ──────────────────────────────────────────── */}
        {(step === 'form' || step === 'error') && (
          <div className="auth-card">
            <h1>Sign in</h1>
            <p className="sub">
              Enter your email and we'll send you a magic link — no password needed.
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
                <label htmlFor="login-email">Work email</label>
                <input
                  id="login-email"
                  className={'input' + (emailError ? ' err' : '')}
                  type="email"
                  placeholder="you@company.com"
                  autoComplete="email"
                  value={email}
                  onChange={handleEmailChange}
                  aria-invalid={emailError ? 'true' : undefined}
                  aria-describedby={emailError ? 'login-email-error' : undefined}
                />
                {emailError && (
                  <div id="login-email-error" className="err-msg" role="alert">
                    {emailError}
                  </div>
                )}
              </div>

              <MBtn
                variant="primary"
                className="auth-submit"
                type="submit"
                disabled={step === 'sending'}
              >
                Send magic link
              </MBtn>
            </form>

            <div className="auth-footer">
              Don't have an account?{' '}
              <a href="/signup">Create a workspace</a>
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
              Sending your link…
            </h1>
            <p className="sub" style={{ margin: 0 }}>
              Just a moment.
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
            <h1>Check your email</h1>
            <p className="sub">
              We sent a magic link to{' '}
              <strong style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{email}</strong>.
              Click the link to sign in — it expires in 60 minutes.
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
              Didn't get it? Check your spam folder, or{' '}
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
                try a different address
              </button>
              .
            </div>
          </div>
        )}

        {(step === 'form' || step === 'error') && (
          <div className="auth-microcopy">
            <MIcon name="shield" size={13} color="var(--mint-600)" />
            We never store your email content. SOC 2 in progress. GDPR-friendly.
          </div>
        )}
      </div>
    </div>
  );
}
