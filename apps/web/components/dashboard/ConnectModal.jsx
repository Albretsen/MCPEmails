'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn, ProviderLogo } from '../Primitives';
import { trackProductEvent } from '@/lib/analytics.mjs';
import { OAUTH_VERIFICATION_PENDING } from '@/lib/oauth/verification-status';
import {
  IMAP_PRESETS,
  GENERIC_IMAP_DEFAULTS,
  isBrandedImapService,
  ZOHO_REGIONS,
  DEFAULT_ZOHO_REGION,
  DEFAULT_ZOHO_ACCOUNT_TYPE,
} from '@/lib/email-providers/imap-presets';

/**
 * Zoho serves personal (@zohomail.com) and organization (paid custom-domain)
 * mailboxes on different hosts (imap.zoho vs imappro.zoho), so the user must
 * tell us which they have. Sent to the connect route as `zohoAccountType`.
 */
const ZOHO_ACCOUNT_TYPES = [
  { value: 'personal', label: 'Personal (@zohomail.com)' },
  { value: 'organization', label: 'Custom domain / Organization' },
];

/**
 * ConnectModal.jsx: inbox connection modal.
 *
 * Step 1: Provider selection.
 *   - Gmail / Outlook → clicking "Connect" navigates to the server-side OAuth
 *     initiation route, which redirects to the provider's consent screen.
 *   - Fastmail → OAuth (route) or app password (in-modal step 2).
 *   - iCloud / Yahoo / Zoho / Yandex → app password (in-modal step 2), using
 *     the host presets from lib/email-providers/imap-presets.
 *   - IMAP / SMTP (generic) → in-modal step 2 with host/port fields.
 *
 * Step 2: Credentials form.
 *   App-password providers submit { email, appPassword } (plus host/port for the
 *   generic connector) to the matching connect route, which validates against
 *   the IMAP server before persisting. On success, onConnect updates the parent's
 *   optimistic inbox list.
 */

/** Provider cards shown in step 1. `subKey` resolves a dashboardChrome key. */
const PROVIDERS = [
  { k: 'gmail',    label: 'Gmail',    subKey: 'connect.subGmail',       logoKind: 'gmail' },
  { k: 'fastmail', label: 'Fastmail', subKey: 'connect.subFastmail',    logoKind: 'imap' },
  // Branded IMAP presets (app password).
  ...Object.values(IMAP_PRESETS).map(p => ({
    k: p.service,
    label: p.label,
    subKey: 'connect.subAppPassword',
    logoKind: p.logoKind,
  })),
  // Generic catch-all connector.
  { k: 'generic', label: 'IMAP / SMTP', subKey: 'connect.subGeneric', logoKind: 'imap' },
  // Outlook is temporarily unavailable (Microsoft connector not live yet) —
  // shown LAST, greyed out / non-selectable with a "coming soon" flag until it ships.
  { k: 'outlook',  label: 'Outlook',  subKey: 'connect.subOutlook',     logoKind: 'outlook', disabled: true },
];

/** The server-side route that initiates the OAuth flow for each provider. */
const OAUTH_ROUTES = {
  gmail: '/auth/gmail',
  outlook: '/auth/outlook',
};

/**
 * ConnectModal: inbox connection modal.
 *
 * When `atInboxLimit` is true the modal shows an upgrade prompt instead of
 * the provider selection step, because the workspace has reached its plan's
 * inbox cap and connecting a new inbox is not possible without upgrading.
 * The free plan has no inbox cap, so this branch only applies to plans that
 * define one.
 *
 * @param {boolean} atInboxLimit  - True when the workspace is at its inbox cap.
 * @param {string}  plan          - The workspace's current plan slug (e.g. "free").
 */
export function ConnectModal({ onClose, onConnect, atInboxLimit = false, plan = 'free', reconnect = null }) {
  const tr = useTranslations('dashboardChrome');
  // Reconnect mode: re-open the form this inbox was created with, identity
  // pre-filled and locked, so only the password is re-entered. Map the stored
  // service back to a modal provider: 'generic' (or a missing service) → the
  // generic IMAP form; a branded service (fastmail/icloud/yahoo/zoho/yandex) →
  // that provider. This is what stops a generic IMAP inbox from being sent to
  // the Fastmail form, and stops the browser autofilling another saved login
  // into a blank field.
  const isReconnect = reconnect != null;
  const reconnectProvider = isReconnect
    ? (reconnect.service && reconnect.service !== 'generic' ? reconnect.service : 'generic')
    : null;
  const [provider, setProvider] = useState(reconnectProvider ?? 'gmail');
  const [step, setStep] = useState(isReconnect ? 2 : 1);
  const [form, setForm] = useState(() => ({
    email: reconnect?.address ?? '',
    username: reconnect?.username ?? '',
    password: '',
    imapHost: reconnect?.imapHost ?? '',
    imapPort: reconnect?.imapPort ?? GENERIC_IMAP_DEFAULTS.imapPort,
    smtpHost: reconnect?.smtpHost ?? '',
    smtpPort: reconnect?.smtpPort ?? GENERIC_IMAP_DEFAULTS.smtpPort,
  }));
  const [zohoRegion, setZohoRegion] = useState(DEFAULT_ZOHO_REGION);
  const [zohoAccountType, setZohoAccountType] = useState(DEFAULT_ZOHO_ACCOUNT_TYPE);
  // Optional login override for Yandex 360 custom-domain accounts whose IMAP
  // login differs from the email address. Blank → authenticate with the email.
  // On a reconnect of a Yandex inbox, seed it with the stored login.
  const [yandexLogin, setYandexLogin] = useState(
    isReconnect && reconnectProvider === 'yandex' ? (reconnect.username ?? '') : ''
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  // When the user clicks outside the modal (the scrim) after typing
  // credentials, show a discard confirmation instead of closing outright so
  // an accidental click doesn't wipe what they entered.
  const [confirmingClose, setConfirmingClose] = useState(false);

  // ── Provider categories ─────────────────────────────────────────────────────

  const isPreset = isBrandedImapService(provider);
  const isGeneric = provider === 'generic';
  const preset = isPreset ? IMAP_PRESETS[provider] : null;
  /** True when "Connect" should open the in-modal credentials step. */
  // Fastmail connects via app password (IMAP/SMTP); Fastmail OAuth is partner-
  // gated and unsupported here, so it is not offered.
  const usesAppPassword =
    isPreset || isGeneric || provider === 'fastmail';

  // ── Step 1: provider selected ──────────────────────────────────────────────

  const handleConnect = () => {
    trackProductEvent('inbox_connect_started', { provider: provider === 'generic' ? 'imap' : provider });
    if (usesAppPassword) {
      setStep(2);
      return;
    }
    // OAuth paths (Gmail, Outlook, Fastmail OAuth) navigate to the server-side
    // initiation route. The page reloads after the provider redirects back.
    window.location.href = OAUTH_ROUTES[provider];
  };

  const connectLabel = () => {
    if (provider === 'gmail') return tr('connect.connectWithGoogle');
    if (provider === 'outlook') return tr('connect.connectWithMicrosoft');
    return tr('connect.enterCredentials');
  };

  /** Human label for the selected provider, used in step-2 copy. */
  const providerLabel = () => {
    if (provider === 'fastmail') return 'Fastmail';
    if (preset) return preset.label;
    if (isGeneric) return tr('connect.genericLabel');
    return tr('connect.providerInboxFallback');
  };

  // ── Step 2: credentials submission ─────────────────────────────────────────

  const handleAppPasswordSubmit = async () => {
    setFormError(null);

    const email = form.email.trim().toLowerCase();
    const appPassword = form.password.trim();

    if (!email || !email.includes('@')) {
      setFormError(tr('connect.errorEmailRequired'));
      return;
    }
    if (!appPassword) {
      setFormError(tr('connect.errorPasswordRequired'));
      return;
    }

    // Resolve the connect endpoint + body for the selected provider.
    let endpoint;
    let body;
    if (provider === 'fastmail') {
      endpoint = '/api/inboxes/fastmail-app-password';
      body = { email, appPassword };
    } else if (isPreset) {
      endpoint = '/api/inboxes/app-password';
      body = { service: provider, email, appPassword };
      if (provider === 'zoho') {
        body.region = zohoRegion;
        body.zohoAccountType = zohoAccountType;
      }
      if (provider === 'yandex') {
        // Optional login override for Yandex 360 custom-domain accounts. Only
        // sent when non-empty; blank authenticates with the email address.
        const login = yandexLogin.trim();
        if (login) body.loginUsername = login;
      }
    } else {
      // Generic IMAP/SMTP.
      const imapHost = form.imapHost.trim().toLowerCase();
      const smtpHost = form.smtpHost.trim().toLowerCase();
      const imapPort = Number(form.imapPort);
      const smtpPort = Number(form.smtpPort);
      if (!imapHost || !smtpHost) {
        setFormError(tr('connect.errorHostRequired'));
        return;
      }
      if (!imapPort || !smtpPort) {
        setFormError(tr('connect.errorPortRequired'));
        return;
      }
      endpoint = '/api/inboxes/imap';
      // Optional: a login username distinct from the email address. Blank means
      // the server authenticates with the email address.
      const username = form.username.trim();
      body = { email, username, appPassword, imapHost, imapPort, smtpHost, smtpPort };
    }

    setSubmitting(true);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        setFormError(data.error ?? tr('connect.errorConnectionFailed'));
        return;
      }

      // Success: notify the parent so it can update its optimistic inbox list.
      // Match the shape a page refresh renders from the DB, otherwise the row
      // visibly changes on reload. The list surfaces the brand for branded IMAP
      // (icloud/yahoo/zoho/yandex) and Fastmail, and 'imap' for the generic
      // connector; the label falls back to the address local-part when there's
      // no display name.
      const optimisticProvider = provider === 'generic' ? 'imap' : provider;
      const optimisticLabel = email.split('@')[0] || email;
      onConnect({ provider: optimisticProvider, address: email, label: optimisticLabel });
    } catch {
      setFormError(tr('connect.errorNetwork'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBackToProviders = () => {
    setStep(1);
    setFormError(null);
  };

  /**
   * True when the credentials step holds user-entered data that would be lost
   * on close. Ports have defaults and provider selection is trivially
   * re-chosen, so only the typed identity/secret fields count as "dirty".
   */
  const hasUnsavedInput = () =>
    step === 2 &&
    !submitting &&
    Boolean(
      form.email.trim() ||
        form.username.trim() ||
        form.password ||
        form.imapHost.trim() ||
        form.smtpHost.trim() ||
        yandexLogin.trim()
    );

  /**
   * Close guard for the scrim (outside click). If the user has unsaved input,
   * surface a discard confirmation rather than closing immediately.
   */
  const handleScrimClose = () => {
    if (hasUnsavedInput()) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="scrim" onClick={handleScrimClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 468 }}>

        {/* Header */}
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 style={{ margin: 0 }}>
                {atInboxLimit
                  ? tr('connect.titleLimitReached')
                  : isReconnect
                    ? tr('connect.titleReconnectProvider', { provider: providerLabel() })
                    : step === 2
                      ? tr('connect.titleConnectProvider', { provider: providerLabel() })
                      : tr('connect.titleConnectInbox')}
              </h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {atInboxLimit
                  ? tr('connect.subLimitReached', { plan: plan.charAt(0).toUpperCase() + plan.slice(1) })
                  : step === 1
                    ? tr('connect.subChooseProvider')
                    : isGeneric
                      ? tr('connect.subGenericForm')
                      : preset
                        ? preset.hint
                        : tr('connect.subFastmailAppPassword')}
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label={tr('connect.close')}
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

          {/* ─── Plan limit: upgrade prompt ────────────────────────────────── */}
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
                    {tr('connect.upgradeTitle')}
                  </div>
                  <div style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13,
                    color: 'var(--fg-3)',
                    lineHeight: 1.5,
                  }}>
                    {tr('connect.upgradeBody')}
                  </div>
                </div>
              </div>

              {/* Feature highlights */}
              {[
                'connect.featureRateLimit',
                'connect.featureHistory',
                'connect.featureTeam',
                'connect.featureSupport',
              ].map(fKey => (
                <div key={fKey} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  color: 'var(--fg-2)',
                }}>
                  <Icon name="check" size={13} color="var(--mint-600)" />
                  {tr(fKey)}
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
                    className={'provider-chip' + (provider === p.k ? ' sel' : '') + (p.disabled ? ' disabled' : '')}
                    onClick={() => { if (!p.disabled) setProvider(p.k); }}
                    role="radio"
                    aria-checked={provider === p.k}
                    aria-disabled={p.disabled || undefined}
                    tabIndex={p.disabled ? -1 : 0}
                    onKeyDown={e => { if (!p.disabled && (e.key === 'Enter' || e.key === ' ')) setProvider(p.k); }}
                    title={p.disabled ? tr('connect.comingSoon') : undefined}
                    style={p.disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                  >
                    <ProviderLogo kind={p.logoKind} size={26} />
                    <div className="pn">{p.label}</div>
                    <div className="ps">{p.disabled ? tr('connect.comingSoon') : tr(p.subKey)}</div>
                  </div>
                ))}
              </div>

              {/* Gmail verification-pending warning. Gated behind
                  OAUTH_VERIFICATION_PENDING so the owner can hide it after
                  Google verification completes, without a code change. Only
                  Gmail applies — Outlook is currently disabled (coming soon),
                  and the Google/CASA review text never applied to Microsoft. */}
              {OAUTH_VERIFICATION_PENDING && provider === 'gmail' && (
                <div
                  role="note"
                  style={{
                    marginTop: 16,
                    padding: '12px 14px',
                    background: 'var(--amber-100)',
                    border: '1px solid rgba(240,165,62,0.35)',
                    borderRadius: 8,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <Icon name="alert-triangle" size={14} color="var(--amber-700)" />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber-700)' }}>
                      {tr('connect.verificationWarningTitle')}
                    </span>
                  </div>
                  <ul style={{
                    margin: 0,
                    paddingLeft: 18,
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    color: 'var(--fg-2)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}>
                    <li>{tr('connect.verificationWarningReview')}</li>
                    <li>{tr('connect.verificationWarningGoogleScreen')}</li>
                    <li>{tr('connect.verificationWarningReauth')}</li>
                  </ul>
                </div>
              )}

              {/* Fastmail: app-password guidance + help link */}
              {provider === 'fastmail' && (
                <p style={{
                  margin: '12px 0 0',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 12,
                  color: 'var(--fg-3)',
                  lineHeight: 1.5,
                }}>
                  {tr('connect.fastmailHintAppPassword')}{' '}
                  <a
                    href="https://www.fastmail.help/hc/en-us/articles/5076446901519"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--brand)' }}
                  >
                    {tr('connect.howToGenerate')}
                  </a>.
                </p>
              )}

              {/* App-password providers: short guidance + help link */}
              {(isPreset || isGeneric) && (
                <p style={{
                  margin: '12px 0 0',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 12,
                  color: 'var(--fg-3)',
                  lineHeight: 1.5,
                }}>
                  {isGeneric
                    ? tr('connect.genericHint')
                    : preset.hint}
                  {preset && (
                    <>
                      {' '}
                      <a href={preset.appPasswordHelpUrl} target="_blank" rel="noopener noreferrer"
                        style={{ color: 'var(--brand)' }}>
                        {tr('connect.howToGenerate')}
                      </a>.
                    </>
                  )}
                </p>
              )}
            </>
          )}

          {/* ─── Step 2: Credentials form ───────────────────────────────────── */}
          {!atInboxLimit && step === 2 && (
            <>
              {isReconnect && (
                <div
                  role="note"
                  style={{
                    marginBottom: 4,
                    padding: '10px 12px',
                    background: 'var(--brand-soft)',
                    border: '1px solid rgba(37,71,229,0.18)',
                    borderRadius: 8,
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12.5,
                    color: 'var(--fg-2)',
                    lineHeight: 1.5,
                  }}
                >
                  {tr('connect.reconnectHint')}
                </div>
              )}

              {provider === 'zoho' && (
                <div className="field">
                  <label htmlFor="cm-zoho-account-type">Account type</label>
                  <select
                    id="cm-zoho-account-type"
                    className="input"
                    value={zohoAccountType}
                    onChange={e => setZohoAccountType(e.target.value)}
                  >
                    {ZOHO_ACCOUNT_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    Paid accounts on a custom domain use Zoho&apos;s organization (imappro) servers.
                  </span>
                </div>
              )}

              {provider === 'zoho' && (
                <div className="field">
                  <label htmlFor="cm-zoho-region">{tr('connect.zohoRegionLabel')}</label>
                  <select
                    id="cm-zoho-region"
                    className="input"
                    value={zohoRegion}
                    onChange={e => setZohoRegion(e.target.value)}
                  >
                    {ZOHO_REGIONS.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.zohoRegionHint')}
                  </span>
                </div>
              )}

              <div className="field">
                <label htmlFor="cm-email">{tr('connect.emailLabel')}</label>
                <input
                  id="cm-email"
                  className="input"
                  type="email"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
                  autoComplete="email"
                  // Reconnect: the address is the row's identity — never change it,
                  // and lock it so the browser can't autofill another saved login.
                  readOnly={isReconnect}
                  aria-readonly={isReconnect || undefined}
                  autoFocus={!isReconnect}
                />
              </div>

              {provider === 'yandex' && (
                <div className="field">
                  <label htmlFor="cm-yandex-login">Login (if different from email)</label>
                  <input
                    id="cm-yandex-login"
                    className="input"
                    type="text"
                    placeholder="Optional"
                    value={yandexLogin}
                    onChange={e => setYandexLogin(e.target.value)}
                    autoComplete="username"
                    readOnly={isReconnect}
                    aria-readonly={isReconnect || undefined}
                  />
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    Yandex 360 custom-domain accounts may sign in with a login that differs from the email address. Leave blank to use the email.
                  </span>
                </div>
              )}

              {isGeneric && (
                <>
                  <div className="field">
                    <label htmlFor="cm-username">{tr('connect.usernameLabel')}</label>
                    <input
                      id="cm-username"
                      className="input"
                      type="text"
                      placeholder={tr('connect.usernamePlaceholder')}
                      value={form.username}
                      onChange={e => setForm(prev => ({ ...prev, username: e.target.value }))}
                      autoComplete="username"
                      // Locked on reconnect: this was the root cause of the
                      // wrong-mailbox bug — a blank username field autofilled with
                      // another account's saved login. Identity stays fixed.
                      readOnly={isReconnect}
                      aria-readonly={isReconnect || undefined}
                    />
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                      {tr('connect.usernameHint')}
                    </span>
                  </div>
                  <div className="field host-port-row">
                    <div style={{ flex: 1 }}>
                      <label htmlFor="cm-imap-host">{tr('connect.imapHostLabel')}</label>
                      <input
                        id="cm-imap-host"
                        className="input"
                        type="text"
                        placeholder="imap.example.com"
                        value={form.imapHost}
                        onChange={e => setForm(prev => ({ ...prev, imapHost: e.target.value }))}
                        readOnly={isReconnect}
                        aria-readonly={isReconnect || undefined}
                      />
                    </div>
                    <div className="port-field">
                      <label htmlFor="cm-imap-port">{tr('connect.imapPortLabel')}</label>
                      <input
                        id="cm-imap-port"
                        className="input"
                        type="number"
                        value={form.imapPort}
                        onChange={e => setForm(prev => ({ ...prev, imapPort: e.target.value }))}
                        readOnly={isReconnect}
                        aria-readonly={isReconnect || undefined}
                      />
                    </div>
                  </div>
                  <div className="field host-port-row">
                    <div style={{ flex: 1 }}>
                      <label htmlFor="cm-smtp-host">{tr('connect.smtpHostLabel')}</label>
                      <input
                        id="cm-smtp-host"
                        className="input"
                        type="text"
                        placeholder="smtp.example.com"
                        value={form.smtpHost}
                        onChange={e => setForm(prev => ({ ...prev, smtpHost: e.target.value }))}
                        readOnly={isReconnect}
                        aria-readonly={isReconnect || undefined}
                      />
                    </div>
                    <div className="port-field">
                      <label htmlFor="cm-smtp-port">{tr('connect.smtpPortLabel')}</label>
                      <input
                        id="cm-smtp-port"
                        className="input"
                        type="number"
                        value={form.smtpPort}
                        onChange={e => setForm(prev => ({ ...prev, smtpPort: e.target.value }))}
                        readOnly={isReconnect}
                        aria-readonly={isReconnect || undefined}
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="field">
                <label htmlFor="cm-password">{isGeneric ? tr('connect.passwordLabel') : tr('connect.appPasswordLabel')}</label>
                <input
                  id="cm-password"
                  className="input"
                  type="password"
                  placeholder="••••-••••-••••-••••"
                  value={form.password}
                  onChange={e => setForm(prev => ({ ...prev, password: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter' && !submitting) handleAppPasswordSubmit(); }}
                  autoComplete="current-password"
                  autoFocus={isReconnect}
                />
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                  {tr('connect.passwordHint')}
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
          {/* Plan limit reached: show upgrade CTA */}
          {atInboxLimit && (
            <>
              <Btn variant="ghost" onClick={onClose}>{tr('connect.cancel')}</Btn>
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
                {tr('connect.viewUpgradeOptions')}
              </a>
            </>
          )}

          {/* Normal flow: provider selection */}
          {!atInboxLimit && step === 1 && (
            <>
              <Btn variant="ghost" onClick={onClose}>{tr('connect.cancel')}</Btn>
              <Btn variant="primary" icon="shield" onClick={handleConnect}>
                {connectLabel()}
              </Btn>
            </>
          )}

          {/* Normal flow: credentials */}
          {!atInboxLimit && step === 2 && (
            <>
              {/* Reconnect mode has no provider-selection step to return to, so the
                  secondary action cancels instead of going "back". */}
              <Btn variant="ghost" onClick={isReconnect ? onClose : handleBackToProviders}>
                {isReconnect ? tr('connect.cancel') : tr('connect.back')}
              </Btn>
              <Btn
                variant="primary"
                icon={submitting ? undefined : 'shield'}
                disabled={submitting}
                onClick={handleAppPasswordSubmit}
              >
                {submitting ? tr('connect.verifying') : tr('connect.connectInbox')}
              </Btn>
            </>
          )}
        </div>

      </div>

      {/* Discard confirmation — shown when an outside click would otherwise
          wipe entered credentials. Its own scrim stops propagation so the
          backdrop click doesn't re-trigger the parent close guard. */}
      {confirmingClose && (
        <div
          className="scrim"
          onClick={e => { e.stopPropagation(); setConfirmingClose(false); }}
        >
          <div
            className="modal"
            onClick={e => e.stopPropagation()}
            style={{ width: 380 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cm-discard-title"
          >
            <div className="modal-h">
              <h2 id="cm-discard-title" style={{ margin: 0 }}>{tr('connect.discardTitle')}</h2>
              <div className="sub" style={{ marginTop: 4 }}>{tr('connect.discardBody')}</div>
            </div>
            <div className="modal-foot">
              <Btn variant="secondary" onClick={() => setConfirmingClose(false)}>
                {tr('connect.keepEditing')}
              </Btn>
              <Btn variant="danger" onClick={() => { setConfirmingClose(false); onClose(); }}>
                {tr('connect.discardConfirm')}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
