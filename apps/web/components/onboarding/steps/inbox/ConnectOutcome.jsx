'use client';

import { useTranslations } from 'next-intl';
import { recordActivationEvent } from '@/lib/analytics/record-activation-event';
import { SUPPORT_EMAIL, connectHelpMailto } from '@/lib/onboarding/connect-help';

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
            <span className="onb-check-mark" aria-hidden="true" />
            {text}
          </li>
        ))}
      </ul>
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
      <h1 className="onb-title onb-title-check"><SuccessMark />{t('proof.title')}</h1>
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
      <div className="onb-actions onb-actions-wide">
        <button type="button" className="btn btn-primary" onClick={onContinue} data-testid="onb-proof-continue">
          {t('proof.continue')}
        </button>
      </div>
    </div>
  );
}

/** A check in a circle that draws itself once (onboarding.css, .onb-success-mark). */
export function SuccessMark({ size = 22 }) {
  return (
    <svg className="onb-success-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="var(--mint-500)" />
      <path d="M7 12.5l3.2 3.2L17 9" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A5 on failure: the classifier's one-line fix, its links, and the named
 * fallbacks. The address stays in the field, so a retry is one paste.
 */
export function FailurePanel({ failure, failures, kind, funnelProvider, onReadOnly, onDifferentInbox, onSeePlans = null }) {
  const t = useTranslations('onboarding.steps.inbox');
  const provider = failure.provider || t(`kinds.${kind}`);

  // An email the user sends from their own mail app: error facts only,
  // never the password.
  const supportHref = connectHelpMailto({
    provider: kind,
    code: failure.code,
    reason: failure.reason ?? undefined,
    phase: failure.phase ?? undefined,
    attempts: failures,
  }) ?? `mailto:${SUPPORT_EMAIL}`;

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
        {/* Flow B: the inbox cap opens the dashboard's upgrade panel (with
            Continue on Free) instead of leaving a dead end. */}
        {failure.message === 'limit' && onSeePlans && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onSeePlans} data-testid="onb-see-plans">
            {t('fail.seePlans')}
          </button>
        )}
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
          <a className="btn btn-secondary btn-sm" href={supportHref} data-testid="onb-support-send">
            {t('fail.support')}
          </a>
          <p className="onb-hint">
            {t('fail.supportNote')}{' '}
            <a className="onb-ext-link" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
          </p>
        </div>
      )}
    </div>
  );
}
