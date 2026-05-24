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
 * SignupApp — the /signup page Client Component.
 *
 * Implements email + password sign-up via Supabase Auth:
 *  1. User enters their email and a password (≥ 8 characters).
 *  2. On submit, calls supabase.auth.signUp() which creates the account and
 *     sends a confirmation email.
 *  3. The form transitions to a "check your email" success state.
 *  4. Clicking the confirmation link takes the user to /auth/callback, which
 *     exchanges the code for a session and redirects to /dashboard.
 *
 * A workspace is auto-provisioned for the new user by a Supabase DB trigger
 * (handle_new_user) on insert into auth.users — no workspace form field needed.
 *
 * Error states are shown inline. No credentials leave the browser except via
 * the Supabase SDK call.
 */
export function SignupApp() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [step, setStep] = useState('form'); // 'form' | 'submitting' | 'sent' | 'error'
  const [serverError, setServerError] = useState('');

  /** Validate form fields; return true if all valid. */
  function validate() {
    let valid = true;

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setEmailError('Enter a valid email address.');
      valid = false;
    } else {
      setEmailError('');
    }

    if (!password || password.length < 8) {
      setPasswordError('Password must be at least 8 characters.');
      valid = false;
    } else {
      setPasswordError('');
    }

    return valid;
  }

  async function handleSubmit(e) {
    e?.preventDefault();

    if (!validate()) return;

    setStep('submitting');
    setServerError('');

    const supabase = createClient();

    const { error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // After clicking the confirmation link Supabase redirects here.
        // The callback route exchanges the code for a session cookie.
        emailRedirectTo: `${window.location.origin}/auth/callback`,
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

  function handlePasswordChange(e) {
    setPassword(e.target.value);
    if (passwordError) setPasswordError('');
  }

  /** Retry after an error — go back to the form state without clearing fields. */
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
            <h1>Create your workspace</h1>
            <p className="sub">
              Connect an inbox in under a minute. No credit card required.
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
                <label htmlFor="signup-email">Work email</label>
                <input
                  id="signup-email"
                  className={'input' + (emailError ? ' err' : '')}
                  type="email"
                  placeholder="you@company.com"
                  autoComplete="email"
                  value={email}
                  onChange={handleEmailChange}
                  aria-invalid={emailError ? 'true' : undefined}
                  aria-describedby={emailError ? 'signup-email-error' : undefined}
                />
                {emailError && (
                  <div id="signup-email-error" className="err-msg" role="alert">
                    {emailError}
                  </div>
                )}
              </div>

              <div className="field">
                <label htmlFor="signup-password">Password</label>
                <input
                  id="signup-password"
                  className={'input' + (passwordError ? ' err' : '')}
                  type="password"
                  placeholder="8+ characters"
                  autoComplete="new-password"
                  value={password}
                  onChange={handlePasswordChange}
                  aria-invalid={passwordError ? 'true' : undefined}
                  aria-describedby={passwordError ? 'signup-password-error' : undefined}
                />
                {passwordError && (
                  <div id="signup-password-error" className="err-msg" role="alert">
                    {passwordError}
                  </div>
                )}
              </div>

              <MBtn
                variant="primary"
                className="auth-submit"
                type="submit"
                onClick={handleSubmit}
              >
                Create workspace
              </MBtn>
            </form>

            <div className="auth-footer">
              Already have an account?{' '}
              <a href="/login">Sign in</a>
            </div>
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
              Creating your workspace…
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
              We sent a confirmation link to{' '}
              <strong style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{email}</strong>.
              Click it to activate your account — it expires in 60 minutes.
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
