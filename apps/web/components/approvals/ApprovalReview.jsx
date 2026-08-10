'use client';

import { useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Btn, Icon } from '../Primitives';

/**
 * The authenticated one-click review of a prepared send.
 *
 * Opened from the review card in an AI conversation via `ui/open-link`. The
 * user is very likely to have arrived here from another tab, so every terminal
 * state has to explain itself without assuming the surrounding context, and
 * the successful path ends with an explicit "you can go back now".
 *
 * The decision is a POST carrying a single-use CSRF token. There is no GET
 * side effect anywhere on this page.
 */

const noopSubscribe = () => () => {};

/**
 * True after hydration. Used instead of a setState-in-effect so the server and
 * the first client render agree, then the client upgrades to a local time.
 */
function useIsClient() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * A timestamp the reviewer can trust. Server-rendered as an explicit UTC
 * stamp (identical on both sides, so no hydration mismatch), then upgraded to
 * the viewer's own locale and timezone once hydrated.
 */
function LocalTime({ iso, fallback }) {
  const isClient = useIsClient();
  if (!iso) return <>{fallback}</>;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return <>{fallback}</>;
  return (
    <time dateTime={iso}>
      {isClient ? parsed.toLocaleString() : `${iso.slice(0, 16).replace('T', ' ')} UTC`}
    </time>
  );
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Row({ label, children }) {
  return (
    <div className="review-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function StatusBanner({ tone, icon, title, children }) {
  return (
    <div className={`review-banner review-banner-${tone}`} role="status">
      <span className="review-banner-icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <div>
        <strong>{title}</strong>
        {children ? <p>{children}</p> : null}
      </div>
    </div>
  );
}

export function ApprovalReview({ review, csrfToken }) {
  const t = useTranslations('dashboard');
  const [submitting, setSubmitting] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [failure, setFailure] = useState(null);
  const [showHtml, setShowHtml] = useState(false);

  const decide = async (decision) => {
    if (submitting || outcome || !csrfToken) return;
    setSubmitting(decision);
    setFailure(null);
    try {
      const response = await fetch(`/api/approvals/${review.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, csrf_token: csrfToken }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFailure(payload.code || 'generic');
        return;
      }
      setOutcome(decision);
    } catch {
      setFailure('generic');
    } finally {
      setSubmitting(null);
    }
  };

  const operationKey = `approvals.review.operations.${review.operation}`;
  const operationLabel = t.has(operationKey) ? t(operationKey) : review.operation;
  const routeLabel = t(`approvals.review.routes.${review.provider.labelKey}`);
  const viaLabel = (via) => {
    const key = `approvals.review.via.${via}`;
    return t.has(key) ? t(key) : null;
  };

  // A pending row whose decision raced with another surface. Once the fetch
  // reports it, the page must stop offering a button that cannot work.
  const raced = failure === 'not_pending' || failure === 'expired' || failure === 'not_found';
  const decided = outcome !== null;
  const live = review.state === 'pending' && !decided && !raced;

  return (
    <div className="review-shell">
      <div className="review-wrap">
        <Link className="review-brand" href="/dashboard">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </Link>

        <div className="card review-card">
          {decided ? (
            <StatusBanner
              tone={outcome === 'approve' ? 'good' : 'neutral'}
              icon={outcome === 'approve' ? 'check' : 'x'}
              title={t(outcome === 'approve' ? 'approvals.review.done.approvedTitle' : 'approvals.review.done.rejectedTitle')}
            >
              {t(outcome === 'approve' ? 'approvals.review.done.approvedBody' : 'approvals.review.done.rejectedBody')}
            </StatusBanner>
          ) : null}

          {!decided && raced ? (
            <StatusBanner
              tone="warn"
              icon="alert-triangle"
              title={t('approvals.review.states.decidedElsewhereTitle')}
            >
              {t('approvals.review.states.decidedElsewhereBody')}
            </StatusBanner>
          ) : null}

          {!decided && !raced && review.state !== 'pending' ? (
            <StatusBanner
              tone={review.state === 'approved' ? 'good' : review.state === 'expired' ? 'warn' : 'neutral'}
              icon={review.state === 'approved' ? 'check' : review.state === 'expired' ? 'alert-triangle' : 'x'}
              title={t(`approvals.review.states.${review.state}Title`)}
            >
              {t(`approvals.review.states.${review.state}Body`)}
            </StatusBanner>
          ) : null}

          <div className="review-head">
            <span className="review-kicker">
              {live ? t('approvals.review.kicker') : t('approvals.review.kickerSettled')}
            </span>
            <h1>{live ? t('approvals.review.title') : t('approvals.review.titleSettled')}</h1>
            {live ? <p className="sub">{t('approvals.review.subtitle')}</p> : null}
          </div>

          {!decided && review.state !== 'pending' && review.decided_at ? (
            <p className="review-provenance">
              <LocalTime iso={review.decided_at} fallback="" />
              {review.decided_by_label ? ` · ${review.decided_by_label}` : ''}
              {viaLabel(review.decided_via) ? ` · ${viaLabel(review.decided_via)}` : ''}
            </p>
          ) : null}

          <dl className="review-rows">
            <Row label={t('approvals.review.from')}>
              <span className="review-strong">{review.identity.email_address || t('approvals.review.unknownInbox')}</span>
              {review.identity.display_name ? <span className="review-muted"> · {review.identity.display_name}</span> : null}
            </Row>

            <Row label={t('approvals.review.to')}>
              {review.recipients.to.length ? (
                <span className="review-strong review-wrapany">{review.recipients.to.join(', ')}</span>
              ) : review.recipientsResolvedAtSend ? (
                <span className="review-muted">{t('approvals.review.recipientsAtSend')}</span>
              ) : (
                <span className="review-muted">{t('approvals.review.noRecipients')}</span>
              )}
            </Row>

            {review.recipients.cc.length ? (
              <Row label={t('approvals.review.cc')}>
                <span className="review-wrapany">{review.recipients.cc.join(', ')}</span>
              </Row>
            ) : null}

            {review.recipients.bcc_count > 0 ? (
              <Row label={t('approvals.review.bcc')}>
                {t('approvals.review.bccCount', { count: review.recipients.bcc_count })}
              </Row>
            ) : null}

            <Row label={t('approvals.review.subject')}>
              {review.subject ? (
                <span className="review-strong review-wrapany">{review.subject}</span>
              ) : (
                <span className="review-muted">{t('approvals.review.noSubject')}</span>
              )}
            </Row>

            <Row label={t('approvals.review.attachments')}>
              {review.attachment_count > 0 ? (
                <>
                  {t('approvals.review.attachmentCount', { count: review.attachment_count })}
                  {review.attachments.length ? (
                    <ul className="review-attachments">
                      {review.attachments.map((file, index) => (
                        <li key={`${file.filename}-${index}`}>
                          <Icon name="download" size={13} />
                          <span className="review-wrapany">{file.filename}</span>
                          {formatBytes(file.size_bytes) ? (
                            <span className="review-muted"> · {formatBytes(file.size_bytes)}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <span className="review-muted">{t('approvals.review.noAttachments')}</span>
              )}
            </Row>

            <Row label={t('approvals.review.operation')}>{operationLabel}</Row>

            <Row label={t('approvals.review.route')}>
              <span className="review-strong">{routeLabel}</span>
              <div className="review-muted review-route">{review.provider.route}</div>
              {review.provider.caveatKeys.length ? (
                <ul className="review-caveats">
                  {review.provider.caveatKeys.map((key) => (
                    <li key={key}>{t(`approvals.review.caveats.${key}`)}</li>
                  ))}
                </ul>
              ) : null}
            </Row>

            <Row label={t('approvals.review.requested')}>
              <LocalTime iso={review.created_at} fallback={t('approvals.review.unknownTime')} />
            </Row>

            {review.send_at ? (
              <Row label={t('approvals.review.sendAt')}>
                <LocalTime iso={review.send_at} fallback="" />
              </Row>
            ) : null}

            {review.expires_at ? (
              <Row label={t('approvals.review.expires')}>
                <LocalTime iso={review.expires_at} fallback="" />
              </Row>
            ) : null}
          </dl>

          <section className="review-message" aria-labelledby="review-message-title">
            <h2 id="review-message-title">{t('approvals.review.bodyTitle')}</h2>

            {review.body.unavailable ? (
              <p className="review-body-note">
                {t(`approvals.review.body${review.body.unavailable === 'withheld_role' ? 'WithheldRole'
                  : review.body.unavailable === 'stored_with_provider' ? 'StoredWithProvider'
                  : review.body.unavailable === 'decrypt_failed' ? 'DecryptFailed'
                  : 'Absent'}`)}
              </p>
            ) : (
              <>
                {review.body.text ? <pre className="review-body">{review.body.text}</pre> : null}
                {review.body.truncated ? (
                  <p className="review-body-note">{t('approvals.review.bodyTruncated')}</p>
                ) : null}
                {review.body.html ? (
                  <div className="review-html">
                    <Btn
                      size="sm"
                      variant="secondary"
                      onClick={() => setShowHtml((v) => !v)}
                    >
                      {showHtml ? t('approvals.review.bodyHtmlHide') : t('approvals.review.bodyHtmlShow')}
                    </Btn>
                    <p className="review-body-note">{t('approvals.review.bodyHtmlNote')}</p>
                    {showHtml ? <pre className="review-body review-body-source">{review.body.html}</pre> : null}
                  </div>
                ) : null}
              </>
            )}
          </section>

          {failure && !raced ? (
            <div className="alert alert-error" role="alert">
              {t(`approvals.review.errors.${failure === 'role' || failure === 'csrf' ? failure : 'generic'}`)}
            </div>
          ) : null}

          {live && !review.canDecide ? (
            <div className="alert" role="status">{t('approvals.review.readOnly')}</div>
          ) : null}

          {live && review.canDecide ? (
            <div className="review-actions">
              <Btn
                variant="danger"
                disabled={submitting !== null}
                onClick={() => decide('reject')}
              >
                {submitting === 'reject' ? t('approvals.review.working') : t('approvals.review.reject')}
              </Btn>
              <Btn
                variant="primary"
                icon="check"
                disabled={submitting !== null}
                onClick={() => decide('approve')}
              >
                {submitting === 'approve' ? t('approvals.review.working') : t('approvals.review.approve')}
              </Btn>
            </div>
          ) : (
            <div className="review-actions">
              <Link className="btn btn-secondary" href="/dashboard/approvals">
                {t('approvals.review.toDashboard')}
              </Link>
            </div>
          )}

          <p className="review-note">
            {live ? t('approvals.review.footnote') : t('approvals.review.backToConversation')}
          </p>
        </div>
      </div>
    </div>
  );
}
