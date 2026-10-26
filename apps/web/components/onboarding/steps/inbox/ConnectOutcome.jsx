'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { recordActivationEvent } from '@/lib/analytics/record-activation-event';

/** A5: the checks, each ticked as it passes. */
export function ConnectProgress({ address, checks }) {
  const t = useTranslations('onboarding.steps.inbox.progress');
  const rows = [
    ['server', t('server')],
    ['signedIn', t('signedIn')],
    ['read', t('read')],
  ];
  const current = rows.findIndex(([key]) => !checks[key]);
  return (
    <div data-testid="onb-progress">
      <h1 className="onb-title">{t('title', { address })}</h1>
      <ul className="onb-checks" aria-live="polite">
        {rows.map(([key, text], i) => (
          <li key={key} className={checks[key] ? 'is-done' : i === current ? 'is-active' : 'is-waiting'} data-check={key}>
            <span className="onb-check-mark" aria-hidden="true">{checks[key] ? '✓' : i === current ? '…' : '·'}</span>
            {text}
          </li>
        ))}
      </ul>
      <p className="onb-hint">{t('slow')}</p>
    </div>
  );
}

/** A5: the proof. Subjects are the user's own mail, shown only to them. */
export function ProofCard({ address, proof, readOnly, onContinue }) {
  const t = useTranslations('onboarding.steps.inbox');
  const available = Boolean(proof?.available);
  const subjects = available && Array.isArray(proof.subjects) ? proof.subjects : [];
  return (
    <div className="onb-proof">
      <h1 className="onb-title">{t('proof.title')}</h1>
      <ul className="onb-checks">
        <li className="is-done"><span className="onb-check-mark" aria-hidden="true">✓</span>{t('progress.server')}</li>
        <li className="is-done"><span className="onb-check-mark" aria-hidden="true">✓</span>{t('progress.signedIn')}</li>
        {available && <li className="is-done"><span className="onb-check-mark" aria-hidden="true">✓</span>{t('progress.read')}</li>}
      </ul>
      <div className="onb-proof-card" data-testid="onb-proof-card">
        <p className="onb-strong">{address}</p>
        {available ? (
          <>
            <p className="onb-muted" data-testid="onb-proof-count">{t('proof.count', { count: Number(proof.count) || 0 })}</p>
            {subjects.length > 0 && (
              <>
                <p className="onb-proof-label">{t('proof.newest')}</p>
                <ol className="onb-proof-subjects">
                  {subjects.map((subject, i) => (
                    <li key={i}>{subject || t('proof.noSubject')}</li>
                  ))}
                </ol>
                <p className="onb-hint">{t('proof.private')}</p>
              </>
            )}
          </>
        ) : (
          <p className="onb-muted">{t('proof.ready')}</p>
        )}
        {readOnly && <p className="onb-hint">{t('fail.readOnlyNote')}</p>}
      </div>
      <div className="onb-actions">
        <button type="button" className="btn btn-primary" onClick={onContinue} data-testid="onb-proof-continue">
          {t('proof.continue')}
        </button>
      </div>
    </div>
  );
}

function helpHref(provider, code) {
  const params = new URLSearchParams({ topic: 'connect' });
  if (provider) params.set('provider', provider);
  if (code) params.set('code', code);
  return `/help?${params.toString()}#contact`;
}

/**
 * A5 on failure: the classifier's one-line fix, its links, and the named
 * fallbacks. The address stays in the field, so a retry is one paste.
 */
export function FailurePanel({ failure, failures, kind, funnelProvider, onReadOnly, onDifferentInbox }) {
  const t = useTranslations('onboarding.steps.inbox');
  const [support, setSupport] = useState('idle'); // idle | sending | sent | failed
  const provider = failure.provider || t(`kinds.${kind}`);

  const sendToSupport = async () => {
    setSupport('sending');
    try {
      const res = await fetch('/api/onboarding/connect-help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: kind,
          code: failure.code,
          reason: failure.reason ?? undefined,
          phase: failure.phase ?? undefined,
          attempts: failures,
        }),
      });
      setSupport(res.ok ? 'sent' : 'failed');
    } catch {
      setSupport('failed');
    }
  };

  return (
    <div className="onb-failure" role="alert" data-testid="onb-failure" data-message={failure.message}>
      <p className="onb-fail">{t(`fail.${failure.message}`, { provider })}</p>
      {failure.links.length > 0 && (
        <ul className="onb-fix-links">
          {failure.links.map((link) => (
            <li key={link.id}>
              <a
                className="onb-ext-link"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => recordActivationEvent('connect_fix_link_clicked', { provider: ['aol', 'gmx', 'web_de'].includes(funnelProvider) ? 'generic_imap' : funnelProvider })}
              >
                {t(`fail.link.${link.kind}`, { provider: link.provider || provider })} <span aria-hidden="true">↗</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {failure.message === 'sessionExpired' && (
        <p><a className="onb-ext-link" href={`/login?redirect=${encodeURIComponent('/onboarding')}`}>{t('fail.signIn')}</a></p>
      )}
      {failure.passwordProblem && <p className="onb-hint">{t('fail.kept')}</p>}
      <div className="onb-actions">
        {failure.offerReadOnly && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onReadOnly} data-testid="onb-read-only">
            {t('fail.readOnly')}
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDifferentInbox} data-testid="onb-different">
          {t('fail.different')}
        </button>
      </div>
      {failures >= 2 && (
        <div className="onb-support" data-testid="onb-support">
          {support === 'sent' ? (
            <p className="onb-hint">{t('fail.supportSent')}</p>
          ) : support === 'failed' ? (
            <p className="onb-hint">
              {t('fail.supportFailed')}{' '}
              <a className="onb-ext-link" href={helpHref(kind, failure.code)}>{t('fail.supportPage')}</a>
            </p>
          ) : (
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={sendToSupport} disabled={support === 'sending'} data-testid="onb-support-send">
                {t('fail.support')}
              </button>
              <p className="onb-hint">{t('fail.supportNote')}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
