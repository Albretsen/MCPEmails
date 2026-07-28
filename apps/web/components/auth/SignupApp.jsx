'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { trackProductEvent } from '@/lib/analytics.mjs';
import { createClient } from '@/lib/supabase/client';
import { MIcon, MBtn } from '../MarketingPrimitives';
import { ThemeBtn, Spinner, GoogleIcon, GitHubIcon, SocialButton, OrDivider } from './AuthShared';

export function SignupApp() {
  const t = useTranslations('auth');
  const SIGNUP_LOADING_MESSAGES = [
    t('signup.loading1'),
    t('signup.loading2'),
    t('signup.loading3'),
    t('signup.loading4'),
    t('signup.loading5'),
  ];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [step, setStep] = useState('form'); // 'form' | 'submitting' | 'sent' | 'error'
  const [serverError, setServerError] = useState('');
  const [loadingMsg, setLoadingMsg] = useState(SIGNUP_LOADING_MESSAGES[0]);
  const [socialLoading, setSocialLoading] = useState(null); // null | 'google' | 'github'
  const loadingTimerRef = useRef(null);

  useEffect(() => {
    if (step !== 'submitting') {
      clearTimeout(loadingTimerRef.current);
      setLoadingMsg(SIGNUP_LOADING_MESSAGES[0]);
      return;
    }
    let index = 1;
    function cycle() {
      const delay = 2000 + Math.random() * 3000;
      loadingTimerRef.current = setTimeout(() => {
        setLoadingMsg(SIGNUP_LOADING_MESSAGES[index % SIGNUP_LOADING_MESSAGES.length]);
        index++;
        cycle();
      }, delay);
    }
    cycle();
    return () => clearTimeout(loadingTimerRef.current);
  }, [step]);

  // Preserve a `?redirect=/path` query param (e.g. when arriving from an invite
  // link) so the user lands back where they started after confirming/signing in,
  // instead of always being dropped on /dashboard. Only relative paths are honored.
  function getSafeRedirect() {
    const redirect = new URLSearchParams(window.location.search).get('redirect');
    return redirect && redirect.startsWith('/') ? redirect : null;
  }

  function buildCallbackUrl() {
    const callbackUrl = new URL('/auth/callback', process.env.NEXT_PUBLIC_APP_URL || window.location.origin);
    const redirect = getSafeRedirect();
    if (redirect) callbackUrl.searchParams.set('next', redirect);
    return callbackUrl.toString();
  }

  // Where a freshly-signed-up user lands once they have a session. Honor an
  // invite/`?redirect=` target if present; otherwise drop them into the
  // first-run connect flow (`firstrun=1` auto-opens the Connect Inbox modal).
  function getRedirectDestination() {
    return getSafeRedirect() ?? '/dashboard?firstrun=1';
  }

  function buildOAuthUrl(provider) {
    const url = new URL(`/auth/${provider}`, window.location.origin);
    const redirect = getSafeRedirect() ?? '/dashboard?firstrun=1';
    const destination = new URL(redirect, window.location.origin);
    destination.searchParams.set('signup_method', provider);
    url.searchParams.set('next', `${destination.pathname}${destination.search}`);
    return url.toString();
  }

  function handleGoogleSignIn() {
    trackProductEvent('signup_started', { method: 'google' });
    setSocialLoading('google');
    window.location.href = buildOAuthUrl('google');
  }

  function handleGitHubSignIn() {
    trackProductEvent('signup_started', { method: 'github' });
    setSocialLoading('github');
    window.location.href = buildOAuthUrl('github');
  }

  function validateEmail(value) {
    if (!value || value.trim() === '') return t('login.errorEmailRequired');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) return t('signup.errorEmailInvalid');
    return '';
  }

  function validatePassword(value) {
    if (!value || value.trim() === '') return t('login.errorPasswordRequired');
    if (value.length < 8) return t('signup.errorPasswordLength');
    return '';
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    const emailErr = validateEmail(email);
    const passErr = validatePassword(password);
    setEmailError(emailErr);
    setPasswordError(passErr);
    if (emailErr || passErr) return;

    setStep('submitting');
    setServerError('');
    trackProductEvent('signup_started', { method: 'password' });

    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: buildCallbackUrl() },
    });

    if (error) {
      setServerError(error.message ?? t('signup.errorGeneric'));
      setStep('error');
    } else if (data?.session) {
      // Email confirmation is disabled, so signUp returns an active session.
      // Skip the "check your email" wall and send the user straight into the
      // first-run connect flow — the moment of highest intent for activation.
      trackProductEvent('signup_completed', { method: 'password' });
      window.location.href = getRedirectDestination();
    } else {
      // Confirmation is still required (e.g. the project setting was
      // re-enabled): fall back to the check-your-email screen.
      setStep('sent');
    }
  }

  function handleEmailChange(e) {
    setEmail(e.target.value);
    if (emailError) setEmailError('');
    if (serverError) { setServerError(''); setStep('form'); }
  }

  function handlePasswordChange(e) {
    setPassword(e.target.value);
    if (passwordError) setPasswordError('');
  }

  function handleRetry() { setServerError(''); setStep('form'); }

  const anyBusy = step === 'submitting' || socialLoading !== null;

  const socialButtons = (
    <>
      <SocialButton
        icon={<GoogleIcon />}
        label={t('shared.continueWithGoogle')}
        loading={socialLoading === 'google'}
        onClick={handleGoogleSignIn}
        disabled={anyBusy}
      />
      <SocialButton
        icon={<GitHubIcon />}
        label={t('shared.continueWithGitHub')}
        loading={socialLoading === 'github'}
        onClick={handleGitHubSignIn}
        disabled={anyBusy}
      />
      <OrDivider />
    </>
  );

  return (
    <div className="auth-shell">
      <ThemeBtn />
      <div className="auth-wrap">
        <a className="auth-back" href="/">
          <MIcon name="arrow" size={14} color="currentColor" strokeWidth={2} />
          {t('shared.backToHome')}
        </a>

        <div className="auth-brand">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        {/* ── Form ──────────────────────────────────────────────────── */}
        {(step === 'form' || step === 'error') && (
          <div className="auth-card">
            <h1>{t('signup.title')}</h1>
            {socialButtons}
            {serverError && (
              <div
                role="alert"
                style={{
                  background: 'var(--red-100)', border: '1px solid rgba(229,72,77,0.25)',
                  borderRadius: 8, padding: '10px 14px', marginBottom: 16,
                  fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--red-700)', lineHeight: 1.5,
                }}
              >
                {serverError}
              </div>
            )}
            <form className="auth-fields" onSubmit={handleSubmit} noValidate>
              <div className="field">
                <label htmlFor="signup-email">{t('signup.emailLabel')}</label>
                <input
                  id="signup-email"
                  className={'input' + (emailError ? ' err' : '')}
                  type="email" placeholder={t('signup.emailPlaceholder')} autoComplete="email"
                  value={email} onChange={handleEmailChange}
                  aria-invalid={emailError ? 'true' : undefined}
                  aria-describedby={emailError ? 'signup-email-error' : undefined}
                />
                {emailError && <div id="signup-email-error" className="err-msg" role="alert">{emailError}</div>}
              </div>
              <div className="field">
                <label htmlFor="signup-password">{t('signup.passwordLabel')}</label>
                <input
                  id="signup-password"
                  className={'input' + (passwordError ? ' err' : '')}
                  type="password" placeholder={t('signup.passwordPlaceholder')} autoComplete="new-password"
                  value={password} onChange={handlePasswordChange}
                  aria-invalid={passwordError ? 'true' : undefined}
                  aria-describedby={passwordError ? 'signup-password-error' : undefined}
                />
                {passwordError && <div id="signup-password-error" className="err-msg" role="alert">{passwordError}</div>}
              </div>
              <MBtn variant="primary" className="auth-submit" type="submit" disabled={anyBusy}>
                {t('signup.submit')}
              </MBtn>
            </form>
            <div className="auth-footer">
              {t('signup.haveAccountPrefix')}<a href="/login">{t('signup.signIn')}</a>
            </div>
          </div>
        )}

        {/* ── Submitting ────────────────────────────────────────────── */}
        {step === 'submitting' && (
          <div className="auth-card" style={{ textAlign: 'center', padding: '48px 32px' }}>
            <div style={{ width: 48, height: 48, borderRadius: 999, background: 'var(--cobalt-50)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Spinner />
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 6px' }}>{loadingMsg}</h1>
            <p className="sub" style={{ margin: 0, color: 'var(--fg-3)', fontSize: 13 }}>
              {t('signup.submittingSub')}
            </p>
          </div>
        )}

        {/* ── Sent ──────────────────────────────────────────────────── */}
        {step === 'sent' && (
          <div className="auth-card">
            <div style={{ width: 48, height: 48, borderRadius: 999, background: 'var(--mint-50)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
              <MIcon name="mail" size={22} color="var(--mint-600)" />
            </div>
            <h1>{t('shared.checkYourEmail')}</h1>
            <p className="sub">
              {t.rich('signup.sentLead', {
                email,
                strong: (c) => <strong style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{c}</strong>,
              })}
            </p>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', marginTop: 8, lineHeight: 1.6 }}>
              {t('shared.didntGetItPrefix')}
              <button onClick={handleRetry} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--brand)', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, textDecoration: 'underline' }}>
                {t('shared.tryDifferentAddress')}
              </button>.
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
