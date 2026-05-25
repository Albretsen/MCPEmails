'use client';

import { useState } from 'react';
import { Icon, Btn, ProviderLogo } from '../Primitives';

/**
 * ConnectModal.jsx — inbox connection modal.
 *
 * Step 1: Provider selection (Gmail, Outlook, Fastmail cards).
 *   - Gmail / Outlook → clicking "Connect" navigates to the server-side OAuth
 *     initiation route (`/auth/gmail` or `/auth/outlook`), which redirects the
 *     browser to the provider's consent screen. The flow completes entirely
 *     outside this modal; the page reloads on return.
 *   - Fastmail OAuth → same pattern via `/auth/fastmail`.
 *   - Fastmail App Password → stays in-modal; advances to step 2.
 *
 * Step 2: Fastmail App Password form.
 *   Submits to `POST /api/inboxes/fastmail-app-password`, which validates the
 *   credential against Fastmail's IMAP server before persisting. On success,
 *   calls `onConnect` so the parent can update its optimistic inbox list.
 */

/** Provider cards shown in step 1. */
const PROVIDERS = [
  {
    k: 'gmail',
    label: 'Gmail',
    sub: 'OAuth 2.0 · recommended',
    logoKind: 'gmail',
  },
  {
    k: 'outlook',
    label: 'Outlook',
    sub: 'OAuth 2.0 · Microsoft 365',
    logoKind: 'outlook',
  },
  {
    k: 'fastmail',
    label: 'Fastmail',
    sub: 'OAuth 2.0 or app password',
    logoKind: 'imap',
  },
];

/** The server-side route that initiates the OAuth flow for each provider. */
const OAUTH_ROUTES = {
  gmail: '/auth/gmail',
  outlook: '/auth/outlook',
  fastmail: '/auth/fastmail',
};

/**
 * ConnectModal — inbox connection modal.
 *
 * When `atInboxLimit` is true the modal shows an upgrade prompt instead of
 * the provider selection step, because the workspace has reached its plan's
 * inbox cap and connecting a new inbox is not possible without upgrading.
 *
 * @param {boolean} atInboxLimit  - True when the workspace is at its inbox cap.
 * @param {string}  plan          - The workspace's current plan slug (e.g. "free").
 */
export function ConnectModal({ onClose, onConnect, atInboxLimit = false, plan = 'free' }) {
  const [provider, setProvider] = useState('gmail');
  /** 'oauth' | 'apppassword' — only relevant when provider === 'fastmail' */
  const [fastmailMode, setFastmailMode] = useState('oauth');
  const [step, setStep] = useState(1);
  const [appPasswordForm, setAppPasswordForm] = useState({ email: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  // ── Step 1: provider selected ──────────────────────────────────────────────

  const handleConnect = () => {
    if (provider === 'fastmail' && fastmailMode === 'apppassword') {
      // Stay in-modal: advance to the app-password credentials form.
      setStep(2);
      return;
    }
    // For all OAuth paths (Gmail, Outlook, Fastmail OAuth) navigate to the
    // server-side initiation route. The page will reload after the provider
    // redirects back to the callback URL.
    window.location.href = OAUTH_ROUTES[provider];
  };

  const connectLabel = () => {
    if (provider === 'gmail')    return 'Connect with Google';
    if (provider === 'outlook')  return 'Connect with Microsoft';
    if (fastmailMode === 'apppassword') return 'Enter credentials';
    return 'Connect with Fastmail';
  };

  // ── Step 2: Fastmail app-password submission ────────────────────────────────

  const handleAppPasswordSubmit = async () => {
    setFormError(null);

    const email = appPasswordForm.email.trim().toLowerCase();
    const appPassword = appPasswordForm.password.trim();

    if (!email || !email.includes('@')) {
      setFormError('A valid Fastmail email address is required.');
      return;
    }
    if (!appPassword) {
      setFormError('An app password is required.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/inboxes/fastmail-app-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, appPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        setFormError(data.error ?? 'Connection failed. Please try again.');
        return;
      }

      // Success — notify the parent so it can update its optimistic inbox list.
      // Pass `label` as the email address so App.jsx's optimistic update works.
      onConnect({ provider: 'fastmail', address: email, label: email });
    } catch {
      setFormError('Network error. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBackToProviders = () => {
    setStep(1);
    setFormError(null);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 468 }}>

        {/* Header */}
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 style={{ margin: 0 }}>
                {atInboxLimit
                  ? 'Inbox limit reached'
                  : step === 2
                    ? 'Fastmail app password'
                    : 'Connect an inbox'}
              </h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {atInboxLimit
                  ? `Your ${plan.charAt(0).toUpperCase() + plan.slice(1)} plan only supports a limited number of inboxes.`
                  : step === 1
                    ? 'Choose a provider. Credentials are encrypted before storage and never shared.'
                    : 'Generate an app password from Fastmail Settings → Security → App Passwords.'}
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--fg-3)',
                padding: 4,
                flexShrink: 0,
                lineHeight: 1,
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="modal-body">

          {/* ─── Plan limit — upgrade prompt ────────────────────────────────── */}
          {atInboxLimit && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Icon + copy */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                padding: '8px 0 4px',
                textAlign: 'center',
              }}>
                <div style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: 'var(--brand-soft)',
                  border: '1px solid rgba(37,71,229,0.18)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <Icon name="zap" size={22} color="var(--brand)" />
                </div>
                <div>
                  <div style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 15,
                    fontWeight: 600,
                    color: 'var(--fg-1)',
                    marginBottom: 4,
                  }}>
                    Upgrade to connect more inboxes
                  </div>
                  <div style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13,
                    color: 'var(--fg-3)',
                    lineHeight: 1.5,
                  }}>
                    The Pro plan supports up to 5 inboxes and 20,000 MCP tool calls
                    per month. Enterprise is unlimited.
                  </div>
                </div>
              </div>

              {/* Feature highlights */}
              {[
                '5 connected inboxes',
                '20,000 MCP tool calls / month',
                '10 API keys',
                'Usage analytics dashboard',
              ].map(f => (
                <div key={f} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  color: 'var(--fg-2)',
                }}>
                  <Icon name="check" size={13} color="var(--mint-600)" />
                  {f}
                </div>
              ))}
            </div>
          )}

          {/* ─── Step 1: Provider selection ─────────────────────────────────── */}
          {!atInboxLimit && step === 1 && (
            <>
              <div className="provider-grid">
                {PROVIDERS.map(p => (
                  <div
                    key={p.k}
                    className={'provider-chip' + (provider === p.k ? ' sel' : '')}
                    onClick={() => setProvider(p.k)}
                    role="radio"
                    aria-checked={provider === p.k}
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setProvider(p.k); }}
                  >
                    <ProviderLogo kind={p.logoKind} size={26} />
                    <div className="pn">{p.label}</div>
                    <div className="ps">{p.sub}</div>
                  </div>
                ))}
              </div>

              {/* Fastmail mode toggle — only shown when Fastmail is selected */}
              {provider === 'fastmail' && (
                <div style={{ marginTop: 12 }}>
                  <div
                    style={{
                      display: 'flex',
                      background: 'var(--bg-sunken)',
                      borderRadius: 8,
                      padding: 3,
                      gap: 2,
                    }}
                  >
                    <FastmailModeTab
                      active={fastmailMode === 'oauth'}
                      onClick={() => setFastmailMode('oauth')}
                      icon="shield"
                      label="OAuth 2.0"
                    />
                    <FastmailModeTab
                      active={fastmailMode === 'apppassword'}
                      onClick={() => setFastmailMode('apppassword')}
                      icon="key"
                      label="App Password"
                    />
                  </div>
                  <p style={{
                    margin: '8px 0 0',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12,
                    color: 'var(--fg-3)',
                    lineHeight: 1.5,
                  }}>
                    {fastmailMode === 'oauth'
                      ? 'Recommended. Your browser will redirect to Fastmail to authorize access.'
                      : 'Generate a Fastmail app password in account settings. Your main password is never used.'}
                  </p>
                </div>
              )}
            </>
          )}

          {/* ─── Step 2: Fastmail app-password form ─────────────────────────── */}
          {!atInboxLimit && step === 2 && (
            <>
              <div className="field">
                <label htmlFor="fm-email">Fastmail email address</label>
                <input
                  id="fm-email"
                  className="input"
                  type="email"
                  placeholder="you@fastmail.com"
                  value={appPasswordForm.email}
                  onChange={e =>
                    setAppPasswordForm(prev => ({ ...prev, email: e.target.value }))
                  }
                  autoComplete="email"
                  autoFocus
                />
              </div>

              <div className="field">
                <label htmlFor="fm-password">App password</label>
                <input
                  id="fm-password"
                  className="input"
                  type="password"
                  placeholder="••••-••••-••••-••••"
                  value={appPasswordForm.password}
                  onChange={e =>
                    setAppPasswordForm(prev => ({ ...prev, password: e.target.value }))
                  }
                  onKeyDown={e => { if (e.key === 'Enter' && !submitting) handleAppPasswordSubmit(); }}
                  autoComplete="current-password"
                />
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                  Never your main Fastmail password. The credential is encrypted before storage.
                </span>
              </div>

              {formError && (
                <div
                  role="alert"
                  style={{
                    padding: '10px 12px',
                    background: 'var(--red-100)',
                    border: '1px solid rgba(229,72,77,0.25)',
                    borderRadius: 8,
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13,
                    color: 'var(--red-700)',
                    lineHeight: 1.5,
                  }}
                >
                  {formError}
                </div>
              )}
            </>
          )}

        </div>

        {/* Footer */}
        <div className="modal-foot">
          {/* Plan limit reached — show upgrade CTA */}
          {atInboxLimit && (
            <>
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <a
                href="/pricing"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '0 16px',
                  height: 34,
                  background: 'var(--brand)',
                  color: '#fff',
                  borderRadius: 8,
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <Icon name="zap" size={13} color="#fff" />
                View upgrade options
              </a>
            </>
          )}

          {/* Normal flow: provider selection */}
          {!atInboxLimit && step === 1 && (
            <>
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <Btn variant="primary" icon="shield" onClick={handleConnect}>
                {connectLabel()}
              </Btn>
            </>
          )}

          {/* Normal flow: Fastmail app-password */}
          {!atInboxLimit && step === 2 && (
            <>
              <Btn variant="ghost" onClick={handleBackToProviders}>Back</Btn>
              <Btn
                variant="primary"
                icon={submitting ? undefined : 'shield'}
                disabled={submitting}
                onClick={handleAppPasswordSubmit}
              >
                {submitting ? 'Verifying…' : 'Connect inbox'}
              </Btn>
            </>
          )}
        </div>

      </div>
    </div>
  );
}

// ── Internal: Fastmail mode toggle tab ─────────────────────────────────────────

function FastmailModeTab({ active, onClick, icon, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 30,
        padding: '0 12px',
        background: active ? 'var(--bg-surface)' : 'transparent',
        border: active ? '1px solid var(--border-1)' : '1px solid transparent',
        borderRadius: 6,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        fontWeight: active ? 500 : 400,
        color: active ? 'var(--fg-1)' : 'var(--fg-3)',
        boxShadow: active ? 'var(--shadow-1)' : 'none',
        transition: 'all var(--dur-1) var(--ease-out)',
      }}
    >
      <Icon name={icon} size={13} color={active ? 'var(--brand)' : 'var(--fg-4)'} />
      {label}
    </button>
  );
}
