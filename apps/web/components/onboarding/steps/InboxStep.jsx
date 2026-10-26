'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { hasReusableInbox } from '@/lib/onboarding/flow';
import {
  connectRequestFor,
  detectFromAddress,
  detectionForChoice,
  funnelProviderForKind,
  isCompleteAddress,
  isMicrosoftKind,
  kindFromProviderSlug,
} from '@/lib/onboarding/inbox-detect';
import { appPasswordFormatWarning, passwordForSubmit, takesAppPassword } from '@/lib/onboarding/app-password-format';
import { describeConnectFailure } from '@/lib/onboarding/connect-failure';
import { emailDomain } from '@/lib/email-providers/host-presets';
import { postOnboardingAction } from '../onboarding-actions';
import { ProviderPanel } from './inbox/ProviderPanel';
import { ConnectProgress, ProofCard, FailurePanel } from './inbox/ConnectOutcome';
import { SECOND_INBOX_DASHBOARD_HREF } from '@/lib/onboarding/second-inbox.mjs';

/**
 * A3-A5: which inbox, the provider's steps, connecting, then proof.
 * Props: the panel contract in ./index.js.
 *
 *  A3  One address field. The signup address is a one-tap chip, never a
 *      prefill. The provider comes from the address: the browser's table first
 *      (instant), then GET /api/onboarding/detect (MX, SRV, ISPDB). A compact
 *      provider list appears only when detection finds nothing. ?provider=
 *      preselects a panel until an address says otherwise.
 *  A4  ProviderPanel: the steps, never collapsed, with tracked links. A trust
 *      panel at the password field and a format warning that never blocks.
 *  A5  The dashboard's own connect routes. Checks tick as they pass, then a
 *      proof card (message count, newest three subjects). On failure the
 *      classifier's fix, reading-only and different-inbox fallbacks, and after
 *      the second failure "Send this error to support".
 *
 * After Settings > Reset onboarding with an inbox still connected, the step
 * first offers "Use <address>" or "Connect another inbox" (kept from WP-C).
 *
 * The fields are not a sign-in form for this site: autoComplete="off" and
 * names that do not read as a login, so a password manager does not offer the
 * MCPEmails password, but can still fill the mail app password (see
 * NOT_A_LOGIN_FIELD in components/dashboard/ConnectModal.jsx for the numbers).
 */
const CHOOSER_KINDS = ['gmail', 'icloud', 'yahoo', 'outlook', 'microsoft365', 'gmx', 'imap'];
const DEFAULT_MANUAL = { imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, username: '' };

export function InboxStep({ step, status, refreshStatus, provider, userEmail, goNext, goTo, variant, secondInbox = false, finish, returnTo = null }) {
  const t = useTranslations('onboarding');
  // Flow B, B1: opened from It works for a second inbox, so straight to the
  // form, and back to It works once it is connected.
  const [connectAnother, setConnectAnother] = useState(secondInbox);
  const reusable = !connectAnother && hasReusableInbox(status) ? status.inboxes.items[0] : null;

  if (reusable) {
    return (
      <section className="onb-panel" data-step={step} data-testid="onb-reuse-inbox">
        <h1 className="onb-title">{t('steps.inbox.reuseTitle')}</h1>
        <div className="onb-actions">
          <button type="button" className="btn btn-primary" onClick={goNext}>
            {t('steps.inbox.reuse', { address: reusable.address })}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setConnectAnother(true)}>
            {t('steps.inbox.connectAnother')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <ConnectInbox
      step={step}
      refreshStatus={refreshStatus}
      provider={provider}
      userEmail={userEmail}
      goNext={secondInbox && goTo ? () => goTo('it_works') : goNext}
      returnTo={returnTo}
      onSeePlans={variant?.convert === 'on' && finish ? () => finish(SECOND_INBOX_DASHBOARD_HREF) : null}
    />
  );
}

/** Detection answers per domain for this page load. */
const detectCache = new Map();

async function detectRemote(domain) {
  if (detectCache.has(domain)) return detectCache.get(domain);
  const res = await fetch(`/api/onboarding/detect?domain=${encodeURIComponent(domain)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  if (!data?.detection?.kind) throw new Error('shape');
  detectCache.set(domain, data.detection);
  return data.detection;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOutlookError() {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('outlook_error');
    if (!code) return null;
    url.searchParams.delete('outlook_error');
    window.history.replaceState(window.history.state, '', url.toString());
    return /^[a-z0-9_]{1,40}$/.test(code) ? code : 'generic';
  } catch {
    return null;
  }
}

function ConnectInbox({ step, refreshStatus, provider, userEmail, goNext, onSeePlans = null, returnTo = null }) {
  const t = useTranslations('onboarding.steps.inbox');
  const urlKind = useMemo(() => kindFromProviderSlug(provider), [provider]);
  const [outlookError, setOutlookError] = useState(null);

  const [email, setEmail] = useState('');
  const [detected, setDetected] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [choice, setChoice] = useState(null);
  const [showChooser, setShowChooser] = useState(false);

  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [manual, setManual] = useState(DEFAULT_MANUAL);
  const [advanced, setAdvanced] = useState(false);

  const [phase, setPhase] = useState('form'); // form | connecting | proof
  const [checks, setChecks] = useState({ server: false, signedIn: false, read: false });
  const [failure, setFailure] = useState(null);
  const [failures, setFailures] = useState(0);
  const [proof, setProof] = useState(null);
  const [connected, setConnected] = useState({ address: '', readOnly: false });
  const selectedRef = useRef(new Set());
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  // The Microsoft sign-in came back with a refusal or a cancel.
  useEffect(() => {
    const code = readOutlookError();
    if (!code) return;
    const timer = setTimeout(() => {
      setOutlookError(code);
      setChoice(code === 'admin_consent_required' ? 'microsoft365' : 'outlook');
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // A3: detect the provider from the address, table first, then the server.
  useEffect(() => {
    const value = email.trim();
    let cancelled = false;
    const local = isCompleteAddress(value) ? detectFromAddress(value) : null;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      if (!isCompleteAddress(value)) {
        setDetected(null);
        setDetecting(false);
        return;
      }
      if (local) {
        setDetected(local);
        setDetecting(false);
        return;
      }
      setDetecting(true);
      try {
        const remote = await detectRemote(emailDomain(value));
        if (!cancelled) setDetected(remote);
      } catch {
        if (!cancelled) setDetected({ kind: 'imap', label: null, source: 'none', settings: null, customDomain: true });
      } finally {
        if (!cancelled) setDetecting(false);
      }
    }, local ? 0 : 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [email]);

  const detectionFailed = Boolean(detected && detected.source === 'none' && !detected.settings);
  const kind = choice ?? (detected && !detectionFailed ? detected.kind : null) ?? urlKind ?? (detectionFailed ? 'imap' : null);
  const detection = useMemo(() => {
    if (!kind) return null;
    if (choice || !detected || detected.kind !== kind) return detectionForChoice(kind, email, detected);
    return detected;
  }, [kind, choice, detected, email]);
  const funnelProvider = funnelProviderForKind(kind);
  const label = detection?.label || (kind ? t(`kinds.${kind}`) : '');
  const chooserVisible = showChooser || (detectionFailed && !choice && !urlKind);
  const needsManual = kind === 'imap' && !detection?.settings;

  // provider_selected once per panel shown, as the dashboard modal records it.
  useEffect(() => {
    if (!kind || selectedRef.current.has(kind)) return;
    selectedRef.current.add(kind);
    const legacy = ['gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex'].includes(funnelProvider) ? funnelProvider : 'generic_imap';
    postOnboardingAction('provider_selected', { provider: legacy, entry_point: 'first_run' });
  }, [kind, funnelProvider]);

  const formatWarning = appPasswordFormatWarning(kind, password);

  const differentInbox = useCallback(() => {
    setEmail('');
    setPassword('');
    setDetected(null);
    setChoice(null);
    setShowChooser(false);
    setFailure(null);
    setFailures(0);
    setOutlookError(null);
    setManual(DEFAULT_MANUAL);
    setPhase('form');
    setTimeout(() => emailRef.current?.focus(), 0);
  }, []);

  const pick = (next) => {
    setChoice(next);
    setShowChooser(false);
    setFailure(null);
  };

  const submit = async (readOnly = false) => {
    if (!detection || !isCompleteAddress(email)) {
      emailRef.current?.focus();
      return;
    }
    const secret = passwordForSubmit(kind, password);
    if (!secret) {
      passwordRef.current?.focus();
      return;
    }
    const request = connectRequestFor({ detection, email, password: secret, readOnly, manual: { ...manual } });
    if (!request) return;

    setFailure(null);
    setPhase('connecting');
    setChecks({ server: Boolean(detection.settings) || !detection.customDomain, signedIn: false, read: false });

    let result;
    try {
      const res = await fetch(request.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      const data = await res.json().catch(() => null);
      result = { ok: res.ok, status: res.status, data };
    } catch {
      result = { network: true };
    }

    if (!result.ok) {
      const described = describeConnectFailure({
        result,
        kind,
        customDomain: detection.customDomain,
        providerLabel: label,
        email,
        imapHost: request.body.imapHost ?? detection.settings?.imapHost ?? null,
        smtpHost: request.body.smtpHost ?? detection.settings?.smtpHost ?? null,
        readOnly,
      });
      setFailure(described);
      setFailures((n) => n + 1);
      if (described.passwordProblem) setPassword('');
      setPhase('form');
      setTimeout(() => (described.passwordProblem ? passwordRef.current : emailRef.current)?.focus(), 0);
      return;
    }

    // Signed in. The route verified both halves before saving.
    setChecks({ server: true, signedIn: false, read: false });
    await wait(400);
    setChecks({ server: true, signedIn: true, read: false });
    const address = String(request.body.email);
    setConnected({ address, readOnly });

    let proofData = null;
    try {
      const status = await refreshStatus?.();
      const item = status?.inboxes?.items?.find((i) => String(i.address).toLowerCase() === address);
      if (item?.id) {
        const res = await fetch('/api/onboarding/inbox-proof', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inboxId: item.id }),
        });
        proofData = res.ok ? await res.json() : null;
      }
    } catch {
      proofData = null;
    }
    setChecks({ server: true, signedIn: true, read: Boolean(proofData?.available) });
    await wait(400);
    setProof(proofData?.available ? proofData : { available: false });
    setPhase('proof');
  };

  if (phase === 'proof') {
    return (
      <section className="onb-panel" data-step={step} data-testid="onb-inbox-proof">
        <ProofCard address={connected.address} proof={proof} readOnly={connected.readOnly} onContinue={goNext} />
      </section>
    );
  }

  if (phase === 'connecting') {
    return (
      <section className="onb-panel" data-step={step}>
        <ConnectProgress address={email.trim().toLowerCase()} checks={checks} />
      </section>
    );
  }

  const microsoft = isMicrosoftKind(kind);
  const canSubmit = Boolean(kind) && !microsoft && kind !== 'proton' && isCompleteAddress(email) && password.trim().length > 0
    && (!needsManual || (manual.imapHost.trim() && manual.smtpHost.trim()));

  return (
    <section className="onb-panel" data-step={step} data-testid="onb-inbox-connect">
      <h1 className="onb-title">{t('title')}</h1>
      <p className="onb-muted">{t('lead')}</p>

      <form
        className="onb-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit(false);
        }}
      >
        <label className="onb-label" htmlFor="onb-mailbox-address">{t('emailLabel')}</label>
        <input
          id="onb-mailbox-address"
          ref={emailRef}
          className="input"
          type="email"
          name="onb-mailbox-address"
          autoComplete="off"
          inputMode="email"
          spellCheck={false}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setChoice(null);
            setFailure(null);
            setOutlookError(null);
          }}
          data-testid="onb-email"
        />
        {userEmail && email.trim().toLowerCase() !== userEmail.toLowerCase() && (
          <div className="onb-chips">
            <button type="button" className="onb-chip-btn" onClick={() => setEmail(userEmail)} data-testid="onb-use-signup">
              {t('useSignup', { address: userEmail })}
            </button>
          </div>
        )}

        <p className="onb-detect" aria-live="polite" data-testid="onb-detected">
          {detecting
            ? t('detecting')
            : kind && !chooserVisible
              ? <>{t('detected', { provider: label })}{' '}<button type="button" className="onb-link-btn" onClick={() => setShowChooser(true)}>{t('notRight')}</button></>
              : null}
        </p>

        {chooserVisible && (
          <div className="onb-chooser" data-testid="onb-chooser">
            <p className="onb-muted">{t('chooseLead')}</p>
            <div className="onb-chips">
              {CHOOSER_KINDS.map((k) => (
                <button key={k} type="button" className={`onb-chip-btn${k === kind ? ' is-selected' : ''}`} onClick={() => pick(k)} data-kind={k}>
                  {t(`kinds.${k}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {kind && (
          <ProviderPanel
            kind={kind}
            label={label}
            email={email}
            settings={detection?.settings ?? null}
            funnelProvider={funnelProvider}
            onDifferentInbox={differentInbox}
            outlookError={outlookError}
            returnTo={returnTo}
          />
        )}

        {kind && !microsoft && kind !== 'proton' && (
          <>
            {needsManual && (
              <div className="onb-servers" data-testid="onb-manual-servers">
                <p className="onb-muted">{t('imap.manualLead')}</p>
                <ServerRow id="imap" label={t('imap.imapHost')} portLabel={t('imap.port')} host={manual.imapHost} port={manual.imapPort} ports={[993, 143]}
                  onHost={(v) => setManual((m) => ({ ...m, imapHost: v }))} onPort={(v) => setManual((m) => ({ ...m, imapPort: v }))} />
                <ServerRow id="smtp" label={t('imap.smtpHost')} portLabel={t('imap.port')} host={manual.smtpHost} port={manual.smtpPort} ports={[465, 587]}
                  onHost={(v) => setManual((m) => ({ ...m, smtpHost: v }))} onPort={(v) => setManual((m) => ({ ...m, smtpPort: v }))} />
              </div>
            )}

            <label className="onb-label" htmlFor="onb-mailbox-secret">
              {takesAppPassword(kind) ? t('password.labelApp') : t('password.labelMailbox')}
            </label>
            <div className="onb-secret">
              <input
                id="onb-mailbox-secret"
                ref={passwordRef}
                className="input"
                type={reveal ? 'text' : 'password'}
                name="onb-mailbox-secret"
                autoComplete="off"
                spellCheck={false}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby="onb-secret-hint"
                data-testid="onb-password"
              />
              <button type="button" className="onb-link-btn" onClick={() => setReveal((r) => !r)}>
                {reveal ? t('password.hide') : t('password.show')}
              </button>
            </div>
            <p id="onb-secret-hint" className="onb-hint">{t('password.spaces')}</p>
            {formatWarning && (
              <p className="onb-warn" data-testid="onb-format-warning">
                {formatWarning === 'account_password' ? t('password.warnAccount', { provider: label }) : t('password.warnLength')}{' '}
                {t('password.warnNote')}
              </p>
            )}

            <ul className="onb-trust" data-testid="onb-trust">
              <li>{t('trust.access')}</li>
              <li>{takesAppPassword(kind) ? t('trust.appPassword') : t('trust.mailboxPassword')}</li>
              <li>{t('trust.storage')}</li>
            </ul>

            {kind === 'imap' && (
              <div className="onb-advanced">
                <button type="button" className="onb-link-btn" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>{t('imap.advanced')}</button>
                {advanced && (
                  <>
                    <label className="onb-label" htmlFor="onb-mailbox-login">{t('imap.username')}</label>
                    <input id="onb-mailbox-login" className="input" name="onb-mailbox-login" autoComplete="off" spellCheck={false}
                      value={manual.username} onChange={(e) => setManual((m) => ({ ...m, username: e.target.value }))} />
                  </>
                )}
              </div>
            )}

            {failure && (
              <FailurePanel
                failure={failure}
                failures={failures}
                kind={kind}
                funnelProvider={funnelProvider}
                onReadOnly={() => submit(true)}
                onDifferentInbox={differentInbox}
                onSeePlans={onSeePlans}
              />
            )}

            <div className="onb-actions">
              <button type="submit" className="btn btn-primary" disabled={!canSubmit} data-testid="onb-connect">
                {t('connect')}
              </button>
            </div>
          </>
        )}
      </form>
    </section>
  );
}

function ServerRow({ id, label, portLabel, host, port, ports, onHost, onPort }) {
  return (
    <div className="onb-server-row">
      <div className="onb-server-host">
        <label className="onb-label" htmlFor={`onb-${id}-host`}>{label}</label>
        <input id={`onb-${id}-host`} className="input" name={`onb-${id}-server`} autoComplete="off" spellCheck={false}
          value={host} onChange={(e) => onHost(e.target.value)} />
      </div>
      <div className="onb-server-port">
        <label className="onb-label" htmlFor={`onb-${id}-port`}>{portLabel}</label>
        <select id={`onb-${id}-port`} className="input" value={String(port)} onChange={(e) => onPort(Number(e.target.value))}>
          {ports.map((p) => <option key={p} value={String(p)}>{p}</option>)}
        </select>
      </div>
    </div>
  );
}
