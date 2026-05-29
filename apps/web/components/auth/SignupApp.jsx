'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
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

  function buildCallbackUrl() {
    return `${process.env.NEXT_PUBLIC_APP_URL || window.location.origin}/auth/callback`;
  }

  function handleGoogleSignIn() {
    setSocialLoading('google');
    window.location.href = '/auth/google';
  }

  function handleGitHubSignIn() {
    setSocialLoading('github');
    window.location.href = '/auth/github';
  }

  function validate() {
    let valid = true;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setEmailError(t('signup.errorEmailInvalid'));
      valid = false;
    } else {
      setEmailError('');
    }
    if (!password || password.length < 8) {
      setPasswordError(t('signup.errorPasswordLength'));
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
      options: { emailRedirectTo: buildCallbackUrl() },
    });

    if (error) {
      setServerError(error.message ?? t('signup.errorGeneric'));
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
