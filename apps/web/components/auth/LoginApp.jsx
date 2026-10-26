'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { readAcquisitionContext } from '../analytics/AcquisitionCapture';
import { appendAcquisitionParams } from '@/lib/acquisition-context.mjs';
import { rememberOAuthConsent } from '@/lib/marketing-consent.mjs';
import {
  connectIntentStorage,
  rememberConnectIntent,
  withConnectIntent,
} from '@/lib/connect/intent-carry.mjs';
import { isSsoRequiredError } from '@/lib/sso/enforcement';
import { ssoUiEnabled } from '@/lib/sso/ui-flag.mjs';
import { MIcon, MBtn } from '../MarketingPrimitives';
import { ThemeBtn, Spinner, GoogleIcon, GitHubIcon, MicrosoftIcon, SocialButton, OrDivider } from './AuthShared';
import { microsoftSignInEnabled } from '@/lib/auth/microsoft-flag.mjs';

export function LoginApp({ redirectTo = null, connectProvider = null, initialMode = 'password' }) {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  // The SSO form (and /login?sso=1) exist only once SSO is released
  // (NEXT_PUBLIC_SSO_ENABLED); until then the page is exactly as before.
  const ssoOn = ssoUiEnabled();
  const [mode, setMode] = useState(ssoOn && initialMode === 'sso' ? 'sso' : 'password'); // 'password' | 'magic-link' | 'sso'
  const [step, setStep] = useState('form'); // 'form' | 'submitting' | 'error' | 'sending' | 'sent' | 'redirecting'
  const [serverError, setServerError] = useState('');
  const [socialLoading, setSocialLoading] = useState(null); // null | 'google' | 'microsoft' | 'github'

  // This page shows no marketing-consent checkbox, so an account it creates
  // (first OAuth login, magic link) must record none. Drop any tick the signup
  // page left behind for an abandoned Google/GitHub attempt.
  useEffect(() => { rememberOAuthConsent(false); }, []);

  // Someone who pressed "Connect IONOS free" on a provider page and then chose
  // to sign in instead (`/login?provider=ionos`). Same hint, same handling as
  // SignupApp: carried in the destination URL, remembered for the magic link.
  useEffect(() => {
    if (connectProvider) rememberConnectIntent(connectIntentStorage(), connectProvider);
  }, [connectProvider]);

  function getSafeRedirect() {
    const redirect = redirectTo;
    return redirect && redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.startsWith('/\\')
      ? redirect
      : null;
  }

  function signupHref() {
    const redirect = getSafeRedirect();
    return withConnectIntent(
      redirect ? `/signup?redirect=${encodeURIComponent(redirect)}` : '/signup',
      connectProvider,
    );
  }

  function buildOAuthUrl(provider) {
    const redirect = getSafeRedirect();
    const url = new URL(`/auth/${provider}`, window.location.origin);
    // Supabase signs a brand-new user up on their first OAuth login, so an
    // account can be created from this page and not just from /signup. Carry
    // the acquisition context the same way SignupApp does, or those signups
    // land unattributed. The callback only stamps genuinely new accounts, so
    // sending it on a returning user's login is a no-op.
    appendAcquisitionParams(url.searchParams, readAcquisitionContext());
    if (redirect && redirect.startsWith('/')) {
      url.searchParams.set('next', redirect);
    } else if (connectProvider) {
      // No `next` means the callback lands on /dashboard, so this is the same
      // destination with the connect hint on it. Without a hint nothing is
      // set, exactly as before.
      url.searchParams.set('next', withConnectIntent('/dashboard', connectProvider));
    }
    // A typed work address lets the route say "use SSO" up front when the
    // company enforces it, instead of after the provider round trip. Only
    // once SSO is released (NEXT_PUBLIC_SSO_ENABLED): until then the OAuth
    // URL stays exactly as before and carries no address.
    if (ssoUiEnabled() && !validateEmail(email)) url.searchParams.set('email', email.trim());
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
    return getSafeRedirect() ?? withConnectIntent('/dashboard', connectProvider);
  }

  function handleGoogleSignIn() {
    setSocialLoading('google');
    window.location.href = buildOAuthUrl('google');
  }

  function handleMicrosoftSignIn() {
    setSocialLoading('microsoft');
    window.location.href = buildOAuthUrl('microsoft');
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
      setServerError(
        isSsoRequiredError(error) ? t('shared.ssoRequired')
          : isBanned ? t('login.errorAccountClosed')
          : t('login.errorIncorrect'),
      );
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
      // Staging never creates an account from a magic link, so a stranger's
      // address gets no email from it. NEXT_PUBLIC_APP_ENV is inlined at build.
      options: {
        emailRedirectTo: buildCallbackUrl(),
        ...(process.env.NEXT_PUBLIC_APP_ENV === 'staging' ? { shouldCreateUser: false } : {}),
      },
    });

    if (error) {
      setServerError(isSsoRequiredError(error) ? t('shared.ssoRequired') : (error.message ?? t('login.errorGeneric')));
      setStep('error');
    } else {
      setStep('sent');
    }
  }

  // SSO: the server looks the domain up in our verified SSO domains and
  // answers with the identity provider's URL. POST, so the address never sits
  // in a URL. Unknown, unverified and disabled domains all get one message.
  async function handleSsoSubmit(e) {
    e?.preventDefault();
    const emailErr = validateEmail(email);
    if (emailErr) { setEmailError(emailErr); return; }

    setStep('redirecting');
    setServerError('');

    let result = null;
    try {
      const res = await fetch('/auth/sso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), next: getSafeRedirect() }),
      });
      result = await res.json().catch(() => null);
    } catch {
      result = null;
    }

    if (result?.url) {
      window.location.href = result.url;
      return;
    }
    if (result?.error === 'invalid_email') {
      setEmailError(t('login.errorEmailInvalid'));
      setStep('form');
      return;
    }
    setServerError(result?.error === 'sso_not_configured' ? t('login.ssoNotConfigured') : t('login.ssoUnavailable'));
    setStep('error');
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

  const isSubmitting = step === 'submitting' || step === 'sending' || step === 'redirecting';
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
      {microsoftSignInEnabled() && (
        <SocialButton
          icon={<MicrosoftIcon />}
          label={t('shared.signInWithMicrosoft')}
          loading={socialLoading === 'microsoft'}
          onClick={handleMicrosoftSignIn}
          disabled={anyBusy}
        />
      )}
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
          <img className="logo-light" src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" />
          <img className="logo-dark" src="/logo-wordmark-dark.svg" width="280" height="48" alt="MCPEmails" />
        </div>

        {/* ── Full-page loading (password submit or magic link sending) ──── */}
        {isSubmitting && (
          <div className="auth-card" style={{ textAlign: 'center', padding: '48px 32px' }}>
            <div style={{ width: 48, height: 48, borderRadius: 999, background: 'var(--cobalt-50)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Spinner />
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 6px' }}>
              {step === 'sending' ? t('login.sendingYourLink')
                : step === 'redirecting' ? t('login.ssoRedirecting')
                : t('login.signingYouIn')}
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
            {ssoOn && (
              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button onClick={() => switchMode('sso')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', textDecoration: 'underline' }}>
                  {t('login.ssoLink')}
                </button>
              </div>
            )}
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
            {ssoOn && (
              <div style={{ textAlign: 'center', marginTop: 8 }}>
                <button onClick={() => switchMode('sso')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', textDecoration: 'underline' }}>
                  {t('login.ssoLink')}
                </button>
              </div>
            )}
            <div className="auth-footer">
              {t('login.noAccountPrefix')}<a href={signupHref()}>{t('login.createWorkspace')}</a>
            </div>
          </div>
        )}

        {/* ── SSO form ───────────────────────────────────────────────────── */}
        {!isSubmitting && step !== 'sent' && mode === 'sso' && (
          <div className="auth-card">
            <h1>{t('login.ssoLink')}</h1>
            <p className="sub" style={{ margin: '0 0 12px' }}>
              {t('login.ssoIntro')}
            </p>
            {errorBanner}
            <form className="auth-fields" onSubmit={handleSsoSubmit} noValidate>
              <div className="field">
                <label htmlFor="login-email-sso">{t('login.emailLabel')}</label>
                <input
                  id="login-email-sso"
                  className={'input' + (emailError ? ' err' : '')}
                  type="email" placeholder={t('login.emailPlaceholder')} autoComplete="email"
                  value={email} onChange={handleEmailChange}
                  aria-invalid={emailError ? 'true' : undefined}
                  aria-describedby={emailError ? 'login-email-sso-error' : undefined}
                />
                {emailError && <div id="login-email-sso-error" className="err-msg" role="alert">{emailError}</div>}
              </div>
              <MBtn variant="primary" className="auth-submit" type="submit" disabled={anyBusy}>
                {t('login.ssoSubmit')}
              </MBtn>
            </form>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button onClick={() => switchMode('password')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', textDecoration: 'underline' }}>
                {t('login.switchToPassword')}
              </button>
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
