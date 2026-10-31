'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Btn, Icon } from '../Primitives';
import { hasSenderWarning } from '@/lib/approvals/no-approval';
import { OriginalMessage, formatBytes } from './OriginalMessage';
import { deliveryInFlight, deliveryReasonText, formatTimeLeft, useNow } from './approvalDisplay';

/**
 * The authenticated one-click review of a prepared send.
 *
 * Opened from the review card in an AI conversation via `ui/open-link`. The
 * user is very likely to have arrived here from another tab, so every terminal
 * state has to explain itself without assuming the surrounding context, and
 * the successful path ends with an explicit "you can go back now".
 *
 * The decision is a POST carrying a single-use CSRF token and the `revision`
 * of the request this page rendered. There is no GET side effect anywhere on
 * this page.
 *
 * A request can still be edited over MCP while this page is open. When that
 * happens the server refuses the approve as `changed`; the page says so,
 * reloads the current content (a server refresh, which also mints a fresh
 * CSRF token) and keeps the buttons disabled until that newer version is on
 * screen. The reviewer then decides on what will actually be sent.
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

/** How often to look again while an approved send is on its way, and for how long. */
const DELIVERY_POLL_MS = 3000;
const DELIVERY_POLL_MAX = 40;

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
  const router = useRouter();
  const [submitting, setSubmitting] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [failure, setFailure] = useState(null);
  const [showHtml, setShowHtml] = useState(false);
  // Set when the server said the request changed: the token and revision the
  // refused decision carried. Until a refresh hands this page a newer one, the
  // buttons stay disabled, so nothing can be decided on stale content.
  const [staleFrom, setStaleFrom] = useState(null);
  const awaitingFresh =
    staleFrom !== null && staleFrom.token === csrfToken && staleFrom.revision === review.revision;
  const [delivery, setDelivery] = useState(review.delivery ?? null);
  const now = useNow();

  const decide = async (decision) => {
    if (submitting || outcome || !csrfToken || awaitingFresh) return;
    setSubmitting(decision);
    setFailure(null);
    try {
      const response = await fetch(`/api/approvals/${review.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, csrf_token: csrfToken, revision: review.revision }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = payload.code || 'generic';
        setFailure(code);
        if (code === 'changed') {
          setStaleFrom({ token: csrfToken, revision: review.revision });
          router.refresh();
        }
        return;
      }
      setOutcome(decision);
    } catch {
      setFailure('generic');
    } finally {
      setSubmitting(null);
    }
  };

  // After approval, ask until the send has an outcome. A request sent long ago
  // that has one already asks nothing.
  const watching = outcome === 'approve' || (review.state === 'approved' && deliveryInFlight(review.delivery));
  useEffect(() => {
    if (!watching) return undefined;
    let tries = 0;
    let timer;
    let stopped = false;
    const look = async () => {
      tries += 1;
      const payload = await fetch(`/api/approvals/${review.id}`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      if (stopped) return;
      if (payload?.delivery) setDelivery(payload.delivery);
      const settled = payload?.delivery && !deliveryInFlight(payload.delivery);
      if (!settled && tries < DELIVERY_POLL_MAX) timer = window.setTimeout(look, DELIVERY_POLL_MS);
    };
    timer = window.setTimeout(look, 1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [watching, review.id]);

  const isRule = review.kind === 'rule_forward';
  const isForward = review.operation === 'email_forward';
  const operationKey = `approvals.review.operations.${review.operation}`;
  const operationLabel = t.has(operationKey) ? t(operationKey) : review.operation;
  const routeLabel = t(`approvals.review.routes.${review.provider.labelKey}`);
  const viaLabel = (via) => {
    const key = `approvals.review.via.${via}`;
    return t.has(key) ? t(key) : null;
  };

  // A pending row whose decision raced with another surface. Once the fetch
  // reports it, the page must stop offering a button that cannot work. An expired
  // one is not "decided elsewhere": nobody decided it. The same goes for a deadline
  // that passes while the page is open.
  const pastDeadline = review.state === 'pending' && Boolean(review.expires_at) && Date.parse(review.expires_at) <= now;
  const lapsed = failure === 'expired' || pastDeadline;
  const raced = failure === 'not_pending' || failure === 'not_found';
  const decided = outcome !== null;
  const state = lapsed ? 'expired' : review.state;
  const live = state === 'pending' && !decided && !raced;
  const timeLeft = live ? formatTimeLeft(t, review.expires_at, now) : null;
  const expiredBodyKey = isRule ? 'approvals.review.states.expiredBodyRule' : 'approvals.review.states.expiredBody';
  const reason = deliveryReasonText(t, delivery);

  const deliveryBanner = delivery && delivery.state !== 'scheduled' ? (
    <StatusBanner
      tone={delivery.state === 'sent' ? 'good' : delivery.state === 'failed' ? 'warn' : 'neutral'}
      icon={delivery.state === 'sent' ? 'check' : delivery.state === 'failed' ? 'alert-triangle' : 'refresh'}
      title={t(`approvals.review.delivery.${delivery.state}Title`)}
    >
      {reason ?? t(`approvals.review.delivery.${delivery.state}Body`)}
    </StatusBanner>
  ) : null;

  const banner = (decided && outcome === 'approve' && deliveryBanner) || (state === 'approved' && deliveryBanner) || (decided ? (
    <StatusBanner
      tone={outcome === 'approve' ? 'good' : 'neutral'}
      icon={outcome === 'approve' ? 'check' : 'x'}
      title={t(outcome === 'approve' ? 'approvals.review.done.approvedTitle' : 'approvals.review.done.rejectedTitle')}
    >
      {t(outcome === 'approve' ? 'approvals.review.done.approvedBody' : 'approvals.review.done.rejectedBody')}
    </StatusBanner>
  ) : raced ? (
    <StatusBanner tone="warn" icon="alert-triangle" title={t('approvals.review.states.decidedElsewhereTitle')}>
      {t('approvals.review.states.decidedElsewhereBody')}
    </StatusBanner>
  ) : failure === 'changed' ? (
    <StatusBanner tone="warn" icon="alert-triangle" title={t('approvals.review.states.changedTitle')}>
      {awaitingFresh ? t('approvals.review.states.changedLoading') : t('approvals.review.states.changedBody')}
    </StatusBanner>
  ) : state !== 'pending' ? (
    <StatusBanner
      tone={state === 'approved' ? 'good' : state === 'expired' ? 'warn' : 'neutral'}
      icon={state === 'approved' ? 'check' : state === 'expired' ? 'alert-triangle' : 'x'}
      title={t(`approvals.review.states.${state}Title`)}
    >
      {state === 'expired' ? t(expiredBodyKey) : t(`approvals.review.states.${state}Body`)}
    </StatusBanner>
  ) : null);

  // A forward's files are the original's, listed from the mailbox below.
  const hasAttachments = review.attachment_count > 0 || (review.forward_carries_original && !isForward);
  // The original is read live only while someone can still act on it.
  const showOriginal = isForward && !decided && review.role !== 'viewer' && (state === 'pending' || state === 'expired');

  return (
    <div className="review-shell">
      <div className="review-wrap">
        <Link className="review-brand" href="/dashboard">
          <img className="logo-light" src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" /><img className="logo-dark" src="/logo-wordmark-dark.svg" width="280" height="48" alt="MCPEmails" />
        </Link>

        {live ? (
          <div className="review-head">
            <span className="review-kicker">{t('approvals.review.kicker')}</span>
            <h1>{t(isRule ? 'approvals.review.titleRule' : 'approvals.review.title')}</h1>
            <p className="sub">
              {isRule
                ? t('approvals.review.subtitleRule', { rule: review.rule_name ?? t('approvals.panel.unnamedRule') })
                : t('approvals.review.subtitle')}
            </p>
          </div>
        ) : null}

        {banner}

        {live && hasSenderWarning(review.wait_reason) ? (
          <StatusBanner tone="warn" icon="alert-triangle" title={t('approvals.senderWarning.title')}>
            {t(`approvals.senderWarning.${review.wait_reason}`)}
          </StatusBanner>
        ) : null}

        {!decided && state !== 'pending' && state !== 'expired' && review.decided_at ? (
          <p className="review-provenance">
            <LocalTime iso={review.decided_at} fallback="" />
            {review.decided_by_label ? ` · ${review.decided_by_label}` : ''}
            {viaLabel(review.decided_via) ? ` · ${viaLabel(review.decided_via)}` : ''}
          </p>
        ) : null}

        <article className="card review-mail" aria-label={t('approvals.review.bodyTitle')}>
          <dl className="review-envelope">
            <Row label={t('approvals.review.from')}>
              <span className="review-strong">{review.identity.display_name || review.identity.email_address || t('approvals.review.unknownInbox')}</span>
              {review.identity.display_name && review.identity.email_address ? (
                <span className="review-muted"> {review.identity.email_address}</span>
              ) : null}
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
                {review.recipients.bcc?.length ? (
                  <>
                    <span className="review-strong review-wrapany">{review.recipients.bcc.join(', ')}</span>
                    <div className="review-muted review-hint">{t('approvals.review.bccHint')}</div>
                  </>
                ) : (
                  t('approvals.review.bccCount', { count: review.recipients.bcc_count })
                )}
              </Row>
            ) : null}

            {review.reply_to?.length ? (
              <Row label={t('approvals.review.replyTo')}>
                <span className="review-strong review-wrapany">{review.reply_to.join(', ')}</span>
              </Row>
            ) : null}

            {review.send_at ? (
              <Row label={t('approvals.review.sendAt')}>
                <span className="review-strong"><LocalTime iso={review.send_at} fallback="" /></span>
              </Row>
            ) : null}

            {review.expires_at && state !== 'approved' && state !== 'rejected' && state !== 'cancelled' ? (
              <Row label={t('approvals.review.expires')}>
                <span className="review-strong"><LocalTime iso={review.expires_at} fallback="" /></span>
                {timeLeft ? <span className="review-muted"> · {timeLeft}</span> : null}
              </Row>
            ) : null}
          </dl>

          <h2 className={`review-subject review-wrapany${review.subject ? '' : ' review-muted'}`}>
            {review.subject || t('approvals.review.noSubject')}
          </h2>

          {review.body.unavailable === 'absent' && isForward ? null : review.body.unavailable ? (
            <p className="review-body-note">
              {t(`approvals.review.body${review.body.unavailable === 'withheld_role' ? 'WithheldRole'
                : review.body.unavailable === 'stored_with_provider' ? 'StoredWithProvider'
                : review.body.unavailable === 'decrypt_failed' ? 'DecryptFailed'
                : 'Absent'}`)}
            </p>
          ) : (
            <>
              {review.body.text && isForward ? (
                <div className="review-muted review-hint">{t('approvals.review.forwardNote')}</div>
              ) : null}
              {review.body.text ? <div className="review-body">{review.body.text}</div> : null}
              {review.body.truncated ? (
                <p className="review-body-note">{t('approvals.review.bodyTruncated')}</p>
              ) : null}
            </>
          )}

          {showOriginal ? <OriginalMessage approvalId={review.id} /> : null}

          {hasAttachments ? (
            <div className="review-attachments">
              {review.attachments.length ? (
                review.attachments.map((file, index) => (
                  <span className="review-file" key={`${file.filename}-${index}`}>
                    <Icon name="download" size={13} />
                    <span className="review-wrapany">{file.filename}</span>
                    {formatBytes(file.size_bytes) ? <span className="review-muted">{formatBytes(file.size_bytes)}</span> : null}
                  </span>
                ))
              ) : (
                <span className="review-muted">
                  {review.attachment_count > 0
                    ? t('approvals.review.attachmentCount', { count: review.attachment_count })
                    : t('approvals.review.attachmentsFromOriginal')}
                </span>
              )}
            </div>
          ) : null}
        </article>

        <details className="review-details">
          <summary>{t('approvals.review.details')}</summary>
          <dl className="review-rows">
            <Row label={t('approvals.review.operation')}>{operationLabel}</Row>
            <Row label={t('approvals.review.route')}>
              {routeLabel}
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
          </dl>
          {review.body.html && !review.body.unavailable ? (
            <div className="review-html">
              <Btn size="sm" variant="secondary" onClick={() => setShowHtml((v) => !v)}>
                {showHtml ? t('approvals.review.bodyHtmlHide') : t('approvals.review.bodyHtmlShow')}
              </Btn>
              <p className="review-body-note">{t('approvals.review.bodyHtmlNote')}</p>
              {showHtml ? <pre className="review-source">{review.body.html}</pre> : null}
            </div>
          ) : null}
        </details>

        {failure && !raced && failure !== 'changed' ? (
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
              variant="secondary"
              disabled={submitting !== null || awaitingFresh}
              onClick={() => decide('reject')}
            >
              {submitting === 'reject' ? t('approvals.review.working') : t('approvals.review.reject')}
            </Btn>
            {/* A legacy draft send can never be sent (the message section says
                why), so only Reject is offered for it. */}
            <Btn
              variant="primary"
              icon="check"
              disabled={submitting !== null || awaitingFresh || review.approvable === false}
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
          {live
            ? t(isRule ? 'approvals.review.footnoteRule' : 'approvals.review.footnote')
            : t(isRule ? 'approvals.review.backToApprovals' : 'approvals.review.backToConversation')}
        </p>
      </div>
    </div>
  );
}
