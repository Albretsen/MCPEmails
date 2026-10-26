'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { panelLinks } from '@/lib/onboarding/inbox-detect';
import { recordActivationEvent } from '@/lib/analytics/record-activation-event';

/**
 * A4: the provider's steps, shown up front and never collapsed. Every external
 * link records `app_password_link_clicked {provider, link}` so "never went to
 * Google" can be told apart from "went and got stuck" (report 33).
 *
 * Props: kind, label (provider name), email, settings (detected servers),
 * funnelProvider, onDifferentInbox, outlookError (code from the Microsoft
 * return, or null).
 */
export function ProviderPanel({ kind, label, email, settings, funnelProvider, onDifferentInbox, outlookError = null }) {
  const t = useTranslations('onboarding.steps.inbox');
  const links = panelLinks(kind, email, settings);
  const provider = label || t(`kinds.${kind}`);

  const track = (link) => recordActivationEvent('app_password_link_clicked', { provider: funnelProvider, link });
  const ext = (link, url, text) => (url ? (
    <a className="onb-ext-link" href={url} target="_blank" rel="noopener noreferrer" onClick={() => track(link)} data-link={link}>
      {text} <span aria-hidden="true">↗</span>
    </a>
  ) : null);

  if (kind === 'gmail' || kind === 'google_workspace') {
    return (
      <div className="onb-provider" data-kind={kind}>
        <ol className="onb-checklist">
          <li><strong>{t('gmail.step1Title')}</strong> {t('gmail.step1Body')} {ext('two_step', links.two_step, t('gmail.step1Link'))}</li>
          <li><strong>{t('gmail.step2Title')}</strong> {t('gmail.step2Body')} {ext('app_passwords', links.app_passwords, t('gmail.step2Link'))}</li>
          <li><strong>{t('gmail.step3Title')}</strong></li>
        </ol>
        {kind === 'google_workspace' && <p className="onb-note">{t('gmail.workspace')}</p>}
        <div className="onb-note" data-testid="onb-gmail-missing">
          <strong>{t('gmail.missingTitle')}</strong> {t('gmail.missingBody')}{' '}
          <button type="button" className="onb-link-btn" onClick={onDifferentInbox}>{t('fail.different')}</button>
        </div>
      </div>
    );
  }

  if (kind === 'icloud') {
    return (
      <div className="onb-provider" data-kind={kind}>
        <ol className="onb-checklist">
          <li><strong>{t('icloud.step1Title')}</strong> {ext('app_passwords', links.app_passwords, t('icloud.step1Link'))}</li>
          <li><strong>{t('icloud.step2Title')}</strong> {t('icloud.step2Body')}</li>
          <li><strong>{t('icloud.step3Title')}</strong> {t('icloud.step3Body')}</li>
        </ol>
        <p className="onb-note"><strong>{t('icloud.missingTitle')}</strong> {t('icloud.missingBody')}</p>
      </div>
    );
  }

  if (kind === 'yahoo' || kind === 'aol') {
    return (
      <div className="onb-provider" data-kind={kind}>
        <ol className="onb-checklist">
          <li><strong>{t('yahoo.step1Title', { provider })}</strong> {ext('app_passwords', links.app_passwords, t('yahoo.step1Link'))}</li>
          <li><strong>{t('yahoo.step2Title')}</strong> {t('yahoo.step2Body')}</li>
          <li><strong>{t('yahoo.step3Title')}</strong></li>
        </ol>
        <p className="onb-note"><strong>{t('yahoo.missingTitle')}</strong> {t('yahoo.missingBody')}</p>
      </div>
    );
  }

  if (kind === 'gmx' || kind === 'web_de') {
    return (
      <div className="onb-provider" data-kind={kind}>
        <ol className="onb-checklist">
          <li><strong>{t('gmx.step1Title', { provider })}</strong> {t('gmx.step1Body')} {ext('imap_setting', links.imap_setting, t('gmx.step1Link'))}</li>
          <li><strong>{t('gmx.step2Title')}</strong> {t('gmx.step2Body', { provider })}</li>
          <li><strong>{t('gmx.step3Title')}</strong></li>
        </ol>
        <p className="onb-note"><strong>{t('gmx.missingTitle')}</strong> {t('gmx.missingBody', { provider })}</p>
      </div>
    );
  }

  if (kind === 'outlook' || kind === 'microsoft365') {
    return <MicrosoftPanel kind={kind} funnelProvider={funnelProvider} outlookError={outlookError} />;
  }

  if (kind === 'proton') {
    return (
      <div className="onb-provider" data-kind={kind}>
        <p className="onb-strong">{t('proton.title')}</p>
        <p className="onb-muted">{t('proton.body')}</p>
        <button type="button" className="btn btn-secondary" onClick={onDifferentInbox}>{t('fail.different')}</button>
      </div>
    );
  }

  // Fastmail, Zoho, Yandex and any other IMAP mailbox.
  return (
    <div className="onb-provider" data-kind={kind}>
      <ol className="onb-checklist">
        <li>{t('imap.step1')}</li>
        <li>
          {t('imap.step2')}{' '}
          {ext('app_passwords', links.app_passwords, t('imap.appPasswordLink', { provider }))}
        </li>
      </ol>
      {settings?.imapHost && <p className="onb-note">{t('imap.servers', { host: settings.imapHost })}</p>}
    </div>
  );
}

function MicrosoftPanel({ kind, funnelProvider, outlookError }) {
  const t = useTranslations('onboarding.steps.inbox');
  const [admin, setAdmin] = useState({ state: 'idle', url: '' });
  const [copied, setCopied] = useState(false);
  const showAdmin = kind === 'microsoft365' || outlookError === 'admin_consent_required';

  const getAdminLink = async () => {
    recordActivationEvent('app_password_link_clicked', { provider: funnelProvider, link: 'admin_consent' });
    setAdmin({ state: 'loading', url: '' });
    try {
      const res = await fetch('/auth/outlook/admin-consent/link', { headers: { Accept: 'application/json' } });
      const data = res.ok ? await res.json() : null;
      if (typeof data?.url === 'string') setAdmin({ state: 'ready', url: data.url });
      else setAdmin({ state: 'error', url: '' });
    } catch {
      setAdmin({ state: 'error', url: '' });
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(admin.url);
      setCopied(true);
    } catch {
      // Selecting the field is the fallback; the link is on screen either way.
    }
  };

  const connect = () => {
    // A whole-document navigation: /auth/outlook answers with a redirect to
    // Microsoft. `from=onboarding` brings the user back to this flow.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = '/auth/outlook?from=onboarding';
  };

  return (
    <div className="onb-provider" data-kind={kind}>
      {outlookError && (
        <p className="onb-fail" role="alert" data-testid="onb-outlook-error">
          {t(`outlookError.${outlookError === 'admin_consent_required' || outlookError === 'outlook_cancelled' ? outlookError : 'generic'}`)}
        </p>
      )}
      <ol className="onb-checklist">
        <li><strong>{t('microsoft.step1Title')}</strong></li>
        <li><strong>{t('microsoft.step2Title')}</strong></li>
      </ol>
      <p className="onb-note">{t('microsoft.note')}</p>
      {showAdmin && (
        <div className="onb-note" data-testid="onb-admin-note">
          <strong>{t('microsoft.adminTitle')}</strong> {t('microsoft.adminBody')}
          <div className="onb-actions">
            {admin.state !== 'ready' && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={getAdminLink} disabled={admin.state === 'loading'}>
                {t('microsoft.adminLink')}
              </button>
            )}
            {admin.state === 'ready' && (
              <>
                <input className="input onb-admin-url" readOnly value={admin.url} onFocus={(e) => e.target.select()} aria-label={t('microsoft.adminLink')} />
                <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
                  {copied ? t('microsoft.adminCopied') : t('microsoft.adminCopy')}
                </button>
              </>
            )}
          </div>
          {admin.state === 'error' && <p className="onb-fail">{t('microsoft.adminError')}</p>}
        </div>
      )}
      <div className="onb-actions">
        <button type="button" className="btn btn-primary" onClick={connect} data-testid="onb-microsoft-connect">
          {t('microsoft.connect')}
        </button>
      </div>
    </div>
  );
}
