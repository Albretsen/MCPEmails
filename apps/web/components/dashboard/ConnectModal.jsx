'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn, ProviderLogo } from '../Primitives';
import { trackProductEvent } from '@/lib/analytics.mjs';
import { OAUTH_VERIFICATION_PENDING } from '@/lib/oauth/verification-status';
import { upgradeDestination } from '@/lib/billing/upgrade-intent.mjs';
import {
  IMAP_PRESETS,
  GENERIC_IMAP_DEFAULTS,
  isBrandedImapService,
  ZOHO_REGIONS,
  DEFAULT_ZOHO_REGION,
  DEFAULT_ZOHO_ACCOUNT_TYPE,
  portForSecurity,
  securityForPort,
  normalizeAppPassword,
} from '@/lib/email-providers/imap-presets';

/**
 * Zoho serves personal (@zohomail.com) and organization (paid custom-domain)
 * mailboxes on different hosts (imap.zoho vs imappro.zoho), so the user must
 * tell us which they have. Sent to the connect route as `zohoAccountType`.
 * Labels resolve through dashboardChrome so they translate.
 */
const ZOHO_ACCOUNT_TYPES = [
  { value: 'personal', labelKey: 'connect.zohoPersonal' },
  { value: 'organization', labelKey: 'connect.zohoOrganization' },
];

/** Per-provider guidance key in dashboardChrome. */
const HINT_KEYS = {
  generic: 'connect.hintGeneric',
  icloud: 'connect.hintIcloud',
  yahoo: 'connect.hintYahoo',
  zoho: 'connect.hintZoho',
  yandex: 'connect.hintYandex',
  fastmail: 'connect.hintFastmail',
};

/**
 * Where each app-password provider actually generates the credential. These are
 * deep links to the generator, not to a help article: the top recorded failure
 * across every app-password provider is a plain `NO [AUTHENTICATIONFAILED]`,
 * i.e. the user submitted their normal account password, so the shortest route
 * to the right page is the thing most likely to change the outcome.
 */
const APP_PASSWORD_URLS = {
  icloud: 'https://account.apple.com/account/manage',
  yahoo: 'https://login.yahoo.com/myaccount/security/app-password',
  zoho: 'https://accounts.zoho.com/home#security/device_pass',
  yandex: 'https://id.yandex.com/security/app-passwords',
  fastmail: 'https://app.fastmail.com/settings/security/apppw',
};

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
  // IMAP leads. It is the path that works with every mailbox, it is the only
  // one no first-party connector covers, and it is the one that does not send
  // the user out to a third-party consent screen to complete.
  { k: 'generic', label: 'IMAP / SMTP', subKey: 'connect.subGeneric', logoKind: 'imap' },
  // Branded IMAP presets (app password) — IMAP underneath, host/port prefilled.
  ...Object.values(IMAP_PRESETS).map(p => ({
    k: p.service,
    label: p.label,
    subKey: 'connect.subAppPassword',
    logoKind: p.logoKind,
  })),
  { k: 'fastmail', label: 'Fastmail', subKey: 'connect.subFastmail',    logoKind: 'imap' },
  { k: 'gmail',    label: 'Gmail',    subKey: 'connect.subGmail',       logoKind: 'gmail' },
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
 * When `atInboxLimit` is true the modal shows the upgrade offer instead of the
 * provider picker. This is the product's single moment of value: the person is
 * standing in front of the modal trying to add a second mailbox, which is
 * exactly what Pro sells. So the panel names what they were doing, states the
 * price, and goes straight to Stripe Checkout rather than dumping them on a
 * pricing page to start over.
 *
 * The panel never appears for a workspace whose cap is unlimited, which covers
 * paid plans, comped accounts, and the grandfathered pre-repricing cohort:
 * App.jsx computes `atInboxLimit` as false whenever maxInboxes is null.
 *
 * The same panel is shown when a connect route answers 402
 * `inbox_limit_reached`, which covers the cases the prop cannot see: the cap
 * reached in another tab or on another device since this page loaded. In that
 * case the counts and the upgrade URL come from the response body.
 *
 * @param {boolean} atInboxLimit - True when the workspace is at its inbox cap.
 * @param {string}  planName     - Customer-facing plan name ("Free"/"Pro"/"Team").
 *                                 Never the internal slug.
 * @param {number}  inboxCount   - Inboxes connected right now.
 * @param {number|null} maxInboxes - The plan's cap, or null for unlimited.
 */
export function ConnectModal({
  onClose,
  onConnect,
  atInboxLimit = false,
  planName = 'Free',
  inboxCount = null,
  maxInboxes = null,
  reconnect = null,
}) {
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
  const [provider, setProvider] = useState(reconnectProvider ?? 'generic');
  const [step, setStep] = useState(isReconnect ? 2 : 1);
  const [form, setForm] = useState(() => ({
    email: reconnect?.address ?? '',
    username: reconnect?.username ?? '',
    password: '',
    imapHost: reconnect?.imapHost ?? '',
    imapPort: reconnect?.imapPort ?? GENERIC_IMAP_DEFAULTS.imapPort,
    smtpHost: reconnect?.smtpHost ?? '',
    smtpPort: reconnect?.smtpPort ?? GENERIC_IMAP_DEFAULTS.smtpPort,
    imapSecurity: reconnect?.imapSecurity ?? (reconnect?.imapPort === 143 ? 'starttls' : 'tls'),
    smtpSecurity: reconnect?.smtpSecurity ?? (reconnect?.smtpPort === 587 ? 'starttls' : 'tls'),
  }));
  const [zohoRegion, setZohoRegion] = useState(DEFAULT_ZOHO_REGION);
  const [zohoAccountType, setZohoAccountType] = useState(DEFAULT_ZOHO_ACCOUNT_TYPE);
  // Optional login override for Yandex 360 custom-domain accounts whose IMAP
  // login differs from the email address. Blank → authenticate with the email.
  // On a reconnect of a Yandex inbox, seed it with the stored login.
  const [yandexLogin, setYandexLogin] = useState(
    isReconnect && reconnectProvider === 'yandex' ? (reconnect.username ?? '') : ''
  );
  const [yandexAccountType, setYandexAccountType] = useState('personal');
  const [lastFailure, setLastFailure] = useState({ code: null, count: 0 });
  // Set when a connect route answers 402 inbox_limit_reached. The client-side
  // `atInboxLimit` prop is computed from the inbox list this page loaded with,
  // so it goes stale whenever the cap is reached in another tab, on another
  // device, or by a plan change mid-session. The server is the authority; when
  // it says the cap is hit, the modal switches to the same upgrade panel the
  // prop would have shown, rather than printing the route's unlocalised
  // fallback sentence as a form error.
  const [serverLimit, setServerLimit] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  // When the user clicks outside the modal (the scrim) after typing
  // credentials, show a discard confirmation instead of closing outright so
  // an accidental click doesn't wipe what they entered.
  const [confirmingClose, setConfirmingClose] = useState(false);

  // The upgrade panel replaces the provider picker and the credentials form,
  // whether the cap was known up front (prop) or learned from a 402 (state).
  // The server's numbers win when present: they were counted at the moment of
  // the refusal, the prop's were counted at page load.
  const showLimitPanel = atInboxLimit || serverLimit !== null;
  const limitPlanName = serverLimit?.planName ?? planName;
  const limitInboxCount = serverLimit?.inboxCount ?? inboxCount;
  const limitMaxInboxes = serverLimit?.maxInboxes ?? maxInboxes;
  const limitUpgradeUrl = serverLimit?.upgradeUrl ?? '/pricing';

  // ── Provider categories ─────────────────────────────────────────────────────

  const isPreset = isBrandedImapService(provider);
  const isGeneric = provider === 'generic';
  const preset = isPreset ? IMAP_PRESETS[provider] : null;
  /** True when "Connect" should open the in-modal credentials step. */
  // Fastmail connects via app password (IMAP/SMTP); Fastmail OAuth is partner-
  // gated and unsupported here, so it is not offered.
  const usesAppPassword =
    isPreset || isGeneric || provider === 'fastmail';

  /**
   * Keep the transport security and the port consistent in the generic form.
   *
   * These two fields describe one decision, and letting them disagree is what
   * produced the two largest classes of generic IMAP failure in production:
   * STARTTLS left on port 993 stalls waiting for a greeting that a TLS-only
   * listener will never send (recorded as a timeout in the `greeting` phase),
   * and implicit TLS pointed at 143 fails the handshake. Changing the security
   * mode therefore moves the port to the matching standard, and typing a
   * standard port moves the security mode to match it. A non-standard port
   * implies nothing, so the user's explicit choice is left untouched.
   */
  const setSecurity = (protocol, security) => {
    setForm(prev => ({
      ...prev,
      [protocol === 'imap' ? 'imapSecurity' : 'smtpSecurity']: security,
      [protocol === 'imap' ? 'imapPort' : 'smtpPort']: portForSecurity(protocol, security),
    }));
  };

  const setPort = (protocol, value) => {
    const implied = securityForPort(protocol, Number(value));
    setForm(prev => ({
      ...prev,
      [protocol === 'imap' ? 'imapPort' : 'smtpPort']: value,
      ...(implied ? { [protocol === 'imap' ? 'imapSecurity' : 'smtpSecurity']: implied } : {}),
    }));
  };

  // ── Step 1: provider selected ──────────────────────────────────────────────

  const handleConnect = async () => {
    trackProductEvent('inbox_connect_started', { provider: provider === 'generic' ? 'imap' : provider });
    try {
      await fetch('/api/onboarding', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'provider_selected', provider: provider === 'generic' ? 'generic_imap' : provider }),
        keepalive: true,
      });
    } catch { /* the connection remains available if analytics is unavailable */ }
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
    // Branded app-password providers issue tokens that never contain
    // whitespace, but they display them in groups and copy-paste readily drags
    // in a stray space, newline or non-breaking space. Those characters travel
    // inside the SASL token and come back as an ordinary credential rejection,
    // so the user is told to fix a password that was already right. The generic
    // connector is excluded: there the value is a real account password and a
    // space in it may well be deliberate.
    const appPassword = isGeneric
      ? form.password.trim()
      : normalizeAppPassword(form.password);

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
        body.yandexAccountType = yandexAccountType;
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
      body = { email, username, appPassword, imapHost, imapPort, smtpHost, smtpPort, imapSecurity: form.imapSecurity, smtpSecurity: form.smtpSecurity };
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
        // A plan cap is not a credential problem. Rendering `data.error` here
        // would show the route's unlocalised English fallback, and the repeat
        // hint below would then tell the user to recheck their app password —
        // advice that cannot fix a refusal that never reached their mail
        // server. Switch to the upgrade panel instead, which is localised and
        // carries the offer. Only the numbers come from the response; the
        // sentences come from the message catalogue.
        if (data.error_code === 'inbox_limit_reached') {
          setLastFailure({ code: null, count: 0 });
          setFormError(null);
          setServerLimit({
            planName: typeof data.plan_name === 'string' ? data.plan_name : planName,
            inboxCount: typeof data.current_count === 'number' ? data.current_count : null,
            maxInboxes: typeof data.max_inboxes === 'number' ? data.max_inboxes : null,
            upgradeUrl: typeof data.upgrade_url === 'string' ? data.upgrade_url : '/pricing',
          });
          return;
        }
        const code = data.error_code ?? 'connection_failed';
        const count = lastFailure.code === code ? lastFailure.count + 1 : 1;
        setLastFailure({ code, count });
        const recovery = count >= 2 ? ' Repeating the same attempt is unlikely to help. Recheck the username, app-password requirements, and security mode before trying again.' : '';
        setFormError((data.error ?? tr('connect.errorConnectionFailed')) + recovery);
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
    // The credentials form is no longer on screen once the upgrade panel
    // takes over, so there is nothing for a discard prompt to protect.
    !showLimitPanel &&
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
                {showLimitPanel
                  ? tr('connect.titleLimitReached')
                  : isReconnect
                    ? tr('connect.titleReconnectProvider', { provider: providerLabel() })
                    : step === 2
                      ? tr('connect.titleConnectProvider', { provider: providerLabel() })
                      : tr('connect.titleConnectInbox')}
              </h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {showLimitPanel
                  ? (typeof limitInboxCount === 'number' && typeof limitMaxInboxes === 'number'
                      ? tr('connect.subLimitReached', { plan: limitPlanName, count: limitInboxCount, max: limitMaxInboxes })
                      : tr('connect.subLimitReachedNoCount', { plan: limitPlanName }))
                  : step === 1
                    ? tr('connect.subChooseProvider')
                    : isGeneric
                      ? tr('connect.subGenericForm')
                      : tr(HINT_KEYS[provider] ?? 'connect.hintGeneric')}
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
          {showLimitPanel && (
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

              {/* Feature highlights. Unlimited inboxes leads: it is the thing
                  they were just blocked on, and the rest is supporting detail. */}
              {[
                'connect.featureInboxes',
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
          {!showLimitPanel && step === 1 && (
            <>
              <div className="provider-grid" role="radiogroup" aria-label={tr('connect.subChooseProvider')}>
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

              {/* Gmail: a plain account of what Google's screens look like.
                  This used to be an amber alert box with a warning triangle,
                  which is the wrong instrument: the screen it describes is a
                  permanent condition of shipping an unverified Google app, not
                  an incident, and dressing it as a hazard talked users out of a
                  flow they had already chosen. 39.5% of Gmail connects were
                  abandoned with no failure ever recorded on our side, i.e. on
                  Google's screen. So: show the screen, name the exact buttons,
                  and say why the wording is what it is. */}
              {OAUTH_VERIFICATION_PENDING && provider === 'gmail' && (
                <div
                  role="note"
                  style={{
                    marginTop: 16,
                    padding: 14,
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-1)',
                    borderRadius: 8,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 4 }}>
                    {tr('connect.googleStepsTitle')}
                  </div>
                  <p style={{ margin: '0 0 12px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-2)' }}>
                    {tr('connect.googleStepsIntro')}
                  </p>

                  {/* This asset is the icon registered on our Google OAuth
                      consent screen, so it is the mark the user is about to see
                      on Google's own page. Shown at badge size next to a line
                      saying exactly that: it helps the user confirm they are in
                      the right flow. It is deliberately NOT presented as a
                      screenshot of Google's screen, which is not what it is. */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    marginBottom: 12,
                    padding: '8px 10px',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-1)',
                    borderRadius: 6,
                  }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/google-consent-logo.png"
                      alt=""
                      width={28}
                      height={28}
                      style={{ flexShrink: 0, borderRadius: 4 }}
                    />
                    <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--fg-2)' }}>
                      {tr('connect.googleConsentAlt')}
                    </span>
                  </div>

                  <ol style={{
                    margin: 0,
                    paddingLeft: 18,
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    color: 'var(--fg-2)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}>
                    <li>{tr('connect.googleStep1')}</li>
                    <li>{tr('connect.googleStep2')}</li>
                    <li>{tr('connect.googleStep3')}</li>
                  </ol>

                  <p style={{
                    margin: '12px 0 0',
                    paddingTop: 12,
                    borderTop: '1px solid var(--border-1)',
                    fontSize: 12,
                    lineHeight: 1.55,
                    color: 'var(--fg-3)',
                  }}>
                    {tr('connect.googleStepsWhy')}
                  </p>
                  {/* The old copy claimed access expired "roughly every 7 days".
                      It does not. Access tokens last an hour and are renewed by
                      a background job the user never sees; the refresh token
                      behind them is only invalidated if the user revokes it.
                      Production bears this out: the oldest Gmail inbox has been
                      connected and healthy for 82 days, and of 41 Gmail inboxes
                      the only 3 in an error state were explicit revocations.
                      The 7-day figure applies to Google projects left in
                      "Testing" publishing status, which is a different thing
                      from being unverified. */}
                  <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.55, color: 'var(--fg-3)' }}>
                    {tr('connect.googleStepsDuration')}
                  </p>
                </div>
              )}

              {/* Generic IMAP is the lead option, so it gets a short case
                  for itself rather than a bare one-liner. */}
              {isGeneric && (
                <div style={{
                  marginTop: 16,
                  padding: 14,
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border-1)',
                  borderRadius: 8,
                  fontFamily: 'var(--font-sans)',
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 4 }}>
                    {tr('connect.imapLeadTitle')}
                  </div>
                  <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-2)' }}>
                    {tr('connect.imapLeadBody')}
                  </p>
                </div>
              )}

              {/* App-password providers: guidance + a link straight to the page
                  that generates the credential. */}
              {(isPreset || provider === 'fastmail') && (
                <p style={{
                  margin: '12px 0 0',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 12,
                  color: 'var(--fg-3)',
                  lineHeight: 1.5,
                }}>
                  {tr(HINT_KEYS[provider])}{' '}
                  <a
                    href={APP_PASSWORD_URLS[provider]}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--brand)' }}
                  >
                    {tr('connect.howToGenerate')}
                  </a>.
                </p>
              )}
            </>
          )}

          {/* ─── Step 2: Credentials form ───────────────────────────────────── */}
          {!showLimitPanel && step === 2 && (
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
                  <label htmlFor="cm-zoho-account-type">{tr('connect.zohoAccountTypeLabel')}</label>
                  <select
                    id="cm-zoho-account-type"
                    className="input"
                    value={zohoAccountType}
                    onChange={e => setZohoAccountType(e.target.value)}
                  >
                    {ZOHO_ACCOUNT_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{tr(t.labelKey)}</option>
                    ))}
                  </select>
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.zohoAccountTypeHint')}
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
                <>
                <div className="field">
                  <label htmlFor="cm-yandex-account-type">{tr('connect.yandexAccountTypeLabel')}</label>
                  <select id="cm-yandex-account-type" className="input" value={yandexAccountType} onChange={e => setYandexAccountType(e.target.value)} disabled={isReconnect}>
                    <option value="personal">{tr('connect.yandexPersonal')}</option>
                    <option value="business">{tr('connect.yandexBusiness')}</option>
                  </select>
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.yandexAccountTypeHint')}
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="cm-yandex-login">{tr('connect.yandexLoginLabel')}</label>
                  <input
                    id="cm-yandex-login"
                    className="input"
                    type="text"
                    placeholder={tr('connect.yandexLoginPlaceholder')}
                    value={yandexLogin}
                    onChange={e => setYandexLogin(e.target.value)}
                    autoComplete="username"
                    readOnly={isReconnect}
                    aria-readonly={isReconnect || undefined}
                  />
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                    {tr('connect.yandexLoginHint')}
                  </span>
                </div>
                </>
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
                  <div className="field">
                    <label htmlFor="cm-imap-security">{tr('connect.imapSecurityLabel')}</label>
                    <select id="cm-imap-security" className="input" value={form.imapSecurity} onChange={e => setSecurity('imap', e.target.value)} disabled={isReconnect}>
                      <option value="tls">{tr('connect.securityTls')}</option>
                      <option value="starttls">{tr('connect.securityStarttls')}</option>
                    </select>
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                      {tr('connect.securityPortNote')}
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
                        onChange={e => setPort('imap', e.target.value)}
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
                        onChange={e => setPort('smtp', e.target.value)}
                        readOnly={isReconnect}
                        aria-readonly={isReconnect || undefined}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="cm-smtp-security">{tr('connect.smtpSecurityLabel')}</label>
                    <select id="cm-smtp-security" className="input" value={form.smtpSecurity} onChange={e => setSecurity('smtp', e.target.value)} disabled={isReconnect}>
                      <option value="tls">{tr('connect.securityTls')}</option>
                      <option value="starttls">{tr('connect.securityStarttls')}</option>
                    </select>
                  </div>
                </>
              )}

              <div className="field">
                <label htmlFor="cm-password">{isGeneric ? tr('connect.passwordLabel') : tr('connect.appPasswordLabel')}</label>
                <input
                  id="cm-password"
                  className="input"
                  type="password"
                  // The old placeholder was "••••-••••-••••-••••", which asserts a
                  // dashed four-group shape. Only Apple's app-specific password
                  // looks like that; Yahoo's and Yandex's are unbroken strings and
                  // the generic connector takes an ordinary password. Showing a
                  // format that is wrong for most of the form invites users to
                  // retype the credential into that shape.
                  placeholder=""
                  value={form.password}
                  onChange={e => setForm(prev => ({ ...prev, password: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter' && !submitting) handleAppPasswordSubmit(); }}
                  autoComplete="current-password"
                  autoFocus={isReconnect}
                />
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                  {isGeneric ? tr('connect.passwordHint') : tr('connect.appPasswordHint', { provider: providerLabel() })}
                </span>
                {/* The link to generate the credential only ever existed on the
                    provider-selection step, so by the time the user was actually
                    looking at the password box it was gone. Every app-password
                    provider's dominant failure is a bare
                    `NO [AUTHENTICATIONFAILED]` — the account password submitted
                    in place of an app password — so the link belongs here, next
                    to the field it is about. */}
                {!isGeneric && APP_PASSWORD_URLS[provider] && (
                  <a
                    href={APP_PASSWORD_URLS[provider]}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      marginTop: 2,
                      fontFamily: 'var(--font-sans)',
                      fontSize: 12,
                      color: 'var(--brand)',
                      width: 'fit-content',
                    }}
                  >
                    <Icon name="key" size={12} />
                    {tr('connect.openAppPasswordPage', { provider: providerLabel() })}
                  </a>
                )}
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
          {/* Plan limit reached: go straight to Stripe Checkout for Pro monthly.
              /dashboard/settings?upgrade=solo&interval=month is consumed by
              BillingSection, which starts checkout on mount, so this is one
              click from blocked to card form. The pricing page stays available
              as the secondary link for anyone who wants to compare first. */}
          {showLimitPanel && (
            <>
              <Btn variant="ghost" onClick={onClose}>{tr('connect.cancel')}</Btn>
              <a
                href={limitUpgradeUrl}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 34,
                  padding: '0 10px',
                  color: 'var(--fg-2)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {tr('connect.comparePlans')}
              </a>
              <a
                href={upgradeDestination('solo', false)}
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
          {!showLimitPanel && step === 1 && (
            <>
              <Btn variant="ghost" onClick={onClose}>{tr('connect.cancel')}</Btn>
              <Btn variant="primary" icon="shield" onClick={handleConnect}>
                {connectLabel()}
              </Btn>
            </>
          )}

          {/* Normal flow: credentials */}
          {!showLimitPanel && step === 2 && (
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
