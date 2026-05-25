'use client';

import { useState } from 'react';
import { Icon, Btn } from '../Primitives';

/**
 * FastmailAppPasswordForm
 *
 * Client component that renders the Fastmail app-password connection form.
 * Submits to POST /api/inboxes/fastmail-app-password, which validates via IMAP
 * and stores the encrypted password in the inboxes table.
 *
 * On success, redirects to the Inboxes dashboard page.
 * Errors are displayed inline without navigating away.
 *
 * References:
 *   Documents/Architecture/email-provider-oauth-flows.md §4 (app-password section)
 */

export function FastmailAppPasswordForm() {
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'success' | 'error'
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus('loading');
    setErrorMessage('');

    try {
      const res = await fetch('/api/inboxes/fastmail-app-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, appPassword }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setErrorMessage(data.error ?? 'Connection failed. Please try again.');
        setStatus('error');
        return;
      }

      setStatus('success');
      // Small delay so the success state is briefly visible before redirect.
      setTimeout(() => {
        window.location.href = '/dashboard/inboxes?connected=fastmail';
      }, 800);
    } catch {
      setErrorMessage('A network error occurred. Please check your connection and try again.');
      setStatus('error');
    }
  }

  if (status === 'success') {
    return (
      <div className="app-password-success">
        <div className="success-icon-wrap">
          <Icon name="check" size={28} color="var(--mint-600)" />
        </div>
        <h2 className="success-heading">Fastmail connected</h2>
        <p className="success-body">Redirecting you to your inboxes…</p>
      </div>
    );
  }

  return (
    <form className="app-password-form" onSubmit={handleSubmit} noValidate>
      {/* Header */}
      <div className="app-password-header">
        <div className="fastmail-logo-wrap" aria-hidden="true">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="8" fill="#26292F"/>
            <path d="M7 13l11 8 11-8M7 13h22v12H7z"
              stroke="#F8742F" strokeWidth="1.8" strokeLinejoin="round"/>
          </svg>
        </div>
        <div>
          <h1 className="app-password-title">Connect Fastmail</h1>
          <p className="app-password-subtitle">App password connection</p>
        </div>
      </div>

      {/* Info callout */}
      <div className="app-password-callout">
        <Icon name="shield" size={14} color="var(--cobalt-500)" />
        <p>
          Use a Fastmail{' '}
          <a
            href="https://www.fastmail.com/settings/security/devicekeys"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-link"
          >
            app password
          </a>
          , not your main Fastmail password. App passwords can be revoked
          individually without changing your account password.
        </p>
      </div>

      {/* Error banner */}
      {status === 'error' && (
        <div className="app-password-error" role="alert">
          <Icon name="x" size={14} color="var(--red-700)" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Email field */}
      <div className="form-field">
        <label className="form-label" htmlFor="fm-email">
          Fastmail email address
        </label>
        <input
          id="fm-email"
          type="email"
          className="form-input"
          placeholder="you@fastmail.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          autoFocus
          disabled={status === 'loading'}
        />
      </div>

      {/* App password field */}
      <div className="form-field">
        <label className="form-label" htmlFor="fm-app-password">
          App password
        </label>
        <div className="input-with-toggle">
          <input
            id="fm-app-password"
            type={showPassword ? 'text' : 'password'}
            className="form-input"
            placeholder="xxxx-xxxx-xxxx-xxxx"
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            required
            autoComplete="current-password"
            disabled={status === 'loading'}
          />
          <button
            type="button"
            className="toggle-visibility"
            aria-label={showPassword ? 'Hide app password' : 'Show app password'}
            onClick={() => setShowPassword((prev) => !prev)}
            disabled={status === 'loading'}
          >
            <Icon name={showPassword ? 'eyeoff' : 'eye'} size={15} />
          </button>
        </div>
        <p className="form-hint">
          In Fastmail: Settings → Privacy &amp; Security → App Passwords → New app password.
          Select <em>Mail (IMAP/SMTP)</em> access.
        </p>
      </div>

      {/* Submit */}
      <Btn
        type="submit"
        variant="primary"
        disabled={status === 'loading' || !email || !appPassword}
        className="app-password-submit"
      >
        {status === 'loading' ? 'Verifying…' : 'Connect inbox'}
      </Btn>

      {/* Back link */}
      <div className="app-password-footer">
        <a href="/auth/fastmail" className="back-link">
          <Icon name="chevron" size={14} className="back-icon" />
          Connect with Fastmail OAuth instead
        </a>
      </div>
    </form>
  );
}
