'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { MIcon, MBtn } from '../MarketingPrimitives';
import { ThemeBtn, Spinner, GoogleIcon, GitHubIcon, SocialButton, OrDivider } from './AuthShared';

export function LoginApp({ redirectTo = null }) {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [mode, setMode] = useState('password'); // 'password' | 'magic-link'
  const [step, setStep] = useState('form'); // 'form' | 'submitting' | 'error' | 'sending' | 'sent'
  const [serverError, setServerError] = useState('');
  const [socialLoading, setSocialLoading] = useState(null); // null | 'google' | 'github'

  function getSafeRedirect() {
    const redirect = redirectTo;
    return redirect && redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.startsWith('/\\')
      ? redirect
      : null;
  }

  function signupHref() {
    const redirect = getSafeRedirect();
    return redirect ? `/signup?redirect=${encodeURIComponent(redirect)}` : '/signup';
  }

  function buildOAuthUrl(provider) {
    const redirect = getSafeRedirect();
    const url = new URL(`/auth/${provider}`, window.location.origin);
    if (redirect && redirect.startsWith('/')) {
      url.searchParams.set('next', redirect);
    }
    return url.toString();
  }

  function buildCallbackUrl() {
    const redirect = getSafeRedirect();
    const callbackUrl = new URL('/auth/callback', window.location.origin);
    if (redirect && redirect.startsWith('/')) {
      callbackUrl.searchParams.set('next', redirect);
    }
    return callbackUrl.toString();
  }

  function getRedirectDestination() {
    return getSafeRedirect() ?? '/dashboard';
  }

  function handleGoogleSignIn() {
    setSocialLoading('google');
    window.location.href = buildOAuthUrl('google');
  }

  function handleGitHubSignIn() {
    setSocialLoading('github');
    window.location.href = buildOAuthUrl('github');
  }

  function validateEmail(value) {
    if (!value || value.trim() === '') return t('login.errorEmailRequired');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) return t('login.errorEmailInvalid');
    return '';
  }

  async function handlePasswordSubmit(e) {
    e?.preventDefault();
    const emailErr = validateEmail(email);
    const passErr = password.trim() === '' ? t('login.errorPasswordRequired') : '';
    setEmailError(emailErr);
    setPasswordError(passErr);
    if (emailErr || passErr) return;

    setStep('submitting');
    setServerError('');

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });

    if (error) {
      const isBanned = error.code === 'user_banned' || /banned/i.test(error.message ?? '');
      setServerError(isBanned ? t('login.errorAccountClosed') : t('login.errorIncorrect'));
      setStep('error');
    } else {
      window.location.href = getRedirectDestination();
    }
  }

  async function handleMagicLinkSubmit(e) {
    e?.preventDefault();
    const emailErr = validateEmail(email);
    if (emailErr) { setEmailError(emailErr); return; }

    setStep('sending');
    setServerError('');

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: buildCallbackUrl() },
    });

    if (error) {
      setServerError(error.message ?? t('login.errorGeneric'));
      setStep('error');
    } else {
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
    if (serverError) { setServerError(''); setStep('form'); }
  }

  function handleRetry() { setServerError(''); setStep('form'); }

  function switchMode(next) {
    setMode(next);
    setStep('form');
    setServerError('');
    setEmailError('');
    setPasswordError('');
  }

  const isSubmitting = step === 'submitting' || step === 'sending';
  const anySocialLoading = socialLoading !== null;
  const anyBusy = isSubmitting || anySocialLoading;

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

  const errorBanner = serverError && (
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

        {/* ── Full-page loading (password submit or magic link sending) ──── */}
        {isSubmitting && (
          <div className="auth-card" style={{ textAlign: 'center', padding: '48px 32px' }}>
            <div style={{ width: 48, height: 48, borderRadius: 999, background: 'var(--cobalt-50)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Spinner />
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 6px' }}>
              {step === 'sending' ? t('login.sendingYourLink') : t('login.signingYouIn')}
            </h1>
            <p className="sub" style={{ margin: 0 }}>{t('shared.justAMoment')}</p>
          </div>
        )}

        {/* ── Magic link sent ────────────────────────────────────────────── */}
        {step === 'sent' && (
          <div className="auth-card">
            <div style={{ width: 48, height: 48, borderRadius: 999, background: 'var(--mint-50)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
              <MIcon name="mail" size={22} color="var(--mint-600)" />
            </div>
            <h1>{t('shared.checkYourEmail')}</h1>
            <p className="sub">
              {t.rich('login.magicLinkSentLead', {
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

        {/* ── Password form ──────────────────────────────────────────────── */}
        {!isSubmitting && step !== 'sent' && mode === 'password' && (
          <div className="auth-card">
            <h1>{t('login.title')}</h1>
            {socialButtons}
            {errorBanner}
            <form className="auth-fields" onSubmit={handlePasswordSubmit} noValidate>
              <div className="field">
                <label htmlFor="login-email">{t('login.emailLabel')}</label>
                <input
                  id="login-email"
                  className={'input' + (emailError ? ' err' : '')}
                  type="email" placeholder={t('login.emailPlaceholder')} autoComplete="email"
                  value={email} onChange={handleEmailChange}
                  aria-invalid={emailError ? 'true' : undefined}
                  aria-describedby={emailError ? 'login-email-error' : undefined}
                />
                {emailError && <div id="login-email-error" className="err-msg" role="alert">{emailError}</div>}
              </div>
              <div className="field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <label htmlFor="login-password">{t('login.passwordLabel')}</label>
                  <a href="/forgot-password" style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', textDecoration: 'none' }}>
                    {t('login.forgotPassword')}
                  </a>
                </div>
                <input
                  id="login-password"
                  className={'input' + (passwordError ? ' err' : '')}
                  type="password" placeholder={t('login.passwordPlaceholder')} autoComplete="current-password"
                  value={password} onChange={handlePasswordChange}
                  aria-invalid={passwordError ? 'true' : undefined}
                  aria-describedby={passwordError ? 'login-password-error' : undefined}
                />
                {passwordError && <div id="login-password-error" className="err-msg" role="alert">{passwordError}</div>}
              </div>
              <MBtn variant="primary" className="auth-submit" type="submit" disabled={anyBusy}>
                {t('login.submit')}
              </MBtn>
            </form>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button onClick={() => switchMode('magic-link')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', textDecoration: 'underline' }}>
                {t('login.switchToMagicLink')}
              </button>
            </div>
            <div className="auth-footer">
              {t('login.noAccountPrefix')}<a href={signupHref()}>{t('login.createWorkspace')}</a>
            </div>
          </div>
        )}

        {/* ── Magic link form ────────────────────────────────────────────── */}
        {!isSubmitting && step !== 'sent' && mode === 'magic-link' && (
          <div className="auth-card">
            <h1>{t('login.title')}</h1>
            {socialButtons}
            <p className="sub" style={{ margin: '0 0 12px' }}>
              {t('login.magicLinkIntro')}
            </p>
            {errorBanner}
            <form className="auth-fields" onSubmit={handleMagicLinkSubmit} noValidate>
              <div className="field">
                <label htmlFor="login-email-ml">{t('login.emailLabel')}</label>
                <input
                  id="login-email-ml"
                  className={'input' + (emailError ? ' err' : '')}
                  type="email" placeholder={t('login.emailPlaceholder')} autoComplete="email"
                  value={email} onChange={handleEmailChange}
                  aria-invalid={emailError ? 'true' : undefined}
                  aria-describedby={emailError ? 'login-email-ml-error' : undefined}
                />
                {emailError && <div id="login-email-ml-error" className="err-msg" role="alert">{emailError}</div>}
              </div>
              <MBtn variant="primary" className="auth-submit" type="submit" disabled={anyBusy}>
                {t('login.sendMagicLink')}
              </MBtn>
            </form>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button onClick={() => switchMode('password')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', textDecoration: 'underline' }}>
                {t('login.switchToPassword')}
              </button>
            </div>
            <div className="auth-footer">
              {t('login.noAccountPrefix')}<a href={signupHref()}>{t('login.createWorkspace')}</a>
            </div>
          </div>
        )}

        {!isSubmitting && step !== 'sent' && (
          <div className="auth-microcopy">
            <MIcon name="shield" size={13} color="var(--mint-600)" />
            {t('shared.microcopy')}
          </div>
        )}
      </div>
    </div>
  );
}
