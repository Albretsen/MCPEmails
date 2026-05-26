'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MIcon, MBtn } from '../MarketingPrimitives';

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
    } catch (_) {}
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

export function LoginApp() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  // 'password' is the default sign-in method; 'magic-link' is the fallback
  const [mode, setMode] = useState('password');
  const [step, setStep] = useState('form'); // 'form' | 'submitting' | 'error' | 'sending' | 'sent'
  const [serverError, setServerError] = useState('');

  function buildCallbackUrl() {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    const callbackUrl = new URL('/auth/callback', process.env.NEXT_PUBLIC_APP_URL || window.location.origin);
    if (redirect && redirect.startsWith('/')) {
      callbackUrl.searchParams.set('next', redirect);
    }
    return callbackUrl.toString();
  }

  function getRedirectDestination() {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect');
    return redirect && redirect.startsWith('/') ? redirect : '/dashboard';
  }

  function validateEmail(value) {
    if (!value || value.trim() === '') return 'Enter your email address.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) return 'Enter a valid email address.';
    return '';
  }

  // ── Password sign-in ────────────────────────────────────────────────────────

  async function handlePasswordSubmit(e) {
    e?.preventDefault();

    const emailErr = validateEmail(email);
    const passErr = password.trim() === '' ? 'Enter your password.' : '';
    setEmailError(emailErr);
    setPasswordError(passErr);
    if (emailErr || passErr) return;

    setStep('submitting');
    setServerError('');

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      // Never reveal whether the email or password was the problem
      setServerError('Incorrect email or password.');
      setStep('error');
    } else {
      // Hard redirect so the middleware reads the new session cookies on the next request
      window.location.href = getRedirectDestination();
    }
  }

  // ── Magic link sign-in ──────────────────────────────────────────────────────

  async function handleMagicLinkSubmit(e) {
    e?.preventDefault();

    const emailErr = validateEmail(email);
    if (emailErr) {
      setEmailError(emailErr);
      return;
    }

    setStep('sending');
    setServerError('');

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: buildCallbackUrl() },
    });

    if (error) {
      setServerError(error.message ?? 'Something went wrong. Please try again.');
      setStep('error');
    } else {
      setStep('sent');
    }
  }

  // ── Field change handlers ───────────────────────────────────────────────────

  function handleEmailChange(e) {
    setEmail(e.target.value);
    if (emailError) setEmailError('');
    if (serverError) { setServerError(''); setStep('form'); }
  }

  function handlePasswordChange(e) {
    setPassword(e.target.value);
    if (passwordError) setPasswordError('');
    if (serverError) { setServerError(''); setStep('form'); }
  }

  function handleRetry() {
    setServerError('');
    setStep('form');
  }

  function switchMode(next) {
    setMode(next);
    setStep('form');
    setServerError('');
    setEmailError('');
    setPasswordError('');
  }

  // ── Submitting / redirecting state (shared) ─────────────────────────────────

  const isSubmitting = step === 'submitting' || step === 'sending';

  // ── Render ──────────────────────────────────────────────────────────────────

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

        {/* ── Loading / redirecting ──────────────────────────────────────── */}
        {isSubmitting && (
          <div className="auth-card" style={{ textAlign: 'center', padding: '48px 32px' }}>
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
              {step === 'sending' ? 'Sending your link…' : 'Signing you in…'}
            </h1>
            <p className="sub" style={{ margin: 0 }}>Just a moment.</p>
          </div>
        )}

        {/* ── Magic link sent ────────────────────────────────────────────── */}
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
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', marginTop: 8, lineHeight: 1.6 }}>
              Didn't get it? Check your spam folder, or{' '}
              <button
                onClick={handleRetry}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--brand)', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, textDecoration: 'underline' }}
              >
                try a different address
              </button>
              .
            </div>
          </div>
        )}

        {/* ── Password form ──────────────────────────────────────────────── */}
        {!isSubmitting && step !== 'sent' && mode === 'password' && (
          <div className="auth-card">
            <h1>Sign in</h1>
            <p className="sub">Welcome back.</p>

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

            <form className="auth-fields" onSubmit={handlePasswordSubmit} noValidate>
              <div className="field">
                <label htmlFor="login-email">Email</label>
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
                  <div id="login-email-error" className="err-msg" role="alert">{emailError}</div>
                )}
              </div>

              <div className="field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <label htmlFor="login-password">Password</label>
                  <a
                    href="/forgot-password"
                    style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', textDecoration: 'none' }}
                  >
                    Forgot password?
                  </a>
                </div>
                <input
                  id="login-password"
                  className={'input' + (passwordError ? ' err' : '')}
                  type="password"
                  placeholder="Your password"
                  autoComplete="current-password"
                  value={password}
                  onChange={handlePasswordChange}
                  aria-invalid={passwordError ? 'true' : undefined}
                  aria-describedby={passwordError ? 'login-password-error' : undefined}
                />
                {passwordError && (
                  <div id="login-password-error" className="err-msg" role="alert">{passwordError}</div>
                )}
              </div>

              <MBtn
                variant="primary"
                className="auth-submit"
                type="submit"
                disabled={isSubmitting}
              >
                Sign in
              </MBtn>
            </form>

            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button
                onClick={() => switchMode('magic-link')}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  color: 'var(--fg-3)',
                  textDecoration: 'underline',
                }}
              >
                Sign in without a password
              </button>
            </div>

            <div className="auth-footer">
              Don't have an account?{' '}
              <a href="/signup">Create a workspace</a>
            </div>
          </div>
        )}

        {/* ── Magic link form ────────────────────────────────────────────── */}
        {!isSubmitting && step !== 'sent' && mode === 'magic-link' && (
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

            <form className="auth-fields" onSubmit={handleMagicLinkSubmit} noValidate>
              <div className="field">
                <label htmlFor="login-email-ml">Email</label>
                <input
                  id="login-email-ml"
                  className={'input' + (emailError ? ' err' : '')}
                  type="email"
                  placeholder="you@company.com"
                  autoComplete="email"
                  value={email}
                  onChange={handleEmailChange}
                  aria-invalid={emailError ? 'true' : undefined}
                  aria-describedby={emailError ? 'login-email-ml-error' : undefined}
                />
                {emailError && (
                  <div id="login-email-ml-error" className="err-msg" role="alert">{emailError}</div>
                )}
              </div>

              <MBtn
                variant="primary"
                className="auth-submit"
                type="submit"
                disabled={isSubmitting}
              >
                Send magic link
              </MBtn>
            </form>

            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button
                onClick={() => switchMode('password')}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  color: 'var(--fg-3)',
                  textDecoration: 'underline',
                }}
              >
                Use password instead
              </button>
            </div>

            <div className="auth-footer">
              Don't have an account?{' '}
              <a href="/signup">Create a workspace</a>
            </div>
          </div>
        )}

        {!isSubmitting && step !== 'sent' && (
          <div className="auth-microcopy">
            <MIcon name="shield" size={13} color="var(--mint-600)" />
            We never store your email content. SOC 2 in progress. GDPR-friendly.
          </div>
        )}
      </div>
    </div>
  );
}
