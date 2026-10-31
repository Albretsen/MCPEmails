'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const REASONS = new Set(['not_found', 'ambiguous', 'mailbox', 'unreadable']);

/**
 * The message a held forward would send, read live from the mailbox each time this
 * mounts, and kept nowhere (`GET /api/approvals/[id]/original`).
 *
 * All of it is written by the message's sender. It is rendered as plain text, the
 * names have had invisible and bidi characters taken out on the server, and the
 * preview has its direction isolated so it can not reorder what is around it.
 *
 * Failing to read it never stands in the way of rejecting: the buttons are outside.
 */
export function OriginalMessage({ approvalId, onLoaded }) {
  const t = useTranslations('dashboard');
  const [view, setView] = useState(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/approvals/${approvalId}/original`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((payload) => {
        if (!live) return;
        const next = payload ?? { status: 'unavailable', reason: 'mailbox' };
        setView(next);
        onLoaded?.(next);
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per approval
  }, [approvalId]);

  return (
    <section className="original-message" aria-label={t('approvals.original.title')}>
      <div className="original-message-title">{t('approvals.original.title')}</div>
      {!view ? (
        <div className="sub" role="status">{t('approvals.original.loading')}</div>
      ) : view.status !== 'ok' ? (
        <div className="alert" role="status">
          {t(`approvals.original.unavailable.${REASONS.has(view.reason) ? view.reason : 'mailbox'}`)}
        </div>
      ) : (
        <>
          <dl>
            <div>
              <dt>{t('approvals.original.from')}</dt>
              <dd>
                {view.from_name ? `${view.from_name} ` : ''}
                {view.from_email ? <span className="sub">{view.from_email}</span> : null}
              </dd>
            </div>
            {view.date ? (
              <div>
                <dt>{t('approvals.original.date')}</dt>
                <dd>{new Date(view.date).toLocaleString()}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t('approvals.original.attachments')}</dt>
              <dd>
                {view.attachments.length ? (
                  <ul className="original-message-files">
                    {view.attachments.map((file, index) => (
                      <li key={`${file.filename}-${index}`}>
                        <span>{file.filename}</span>
                        {formatBytes(file.size_bytes) ? <span>{formatBytes(file.size_bytes)}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : t('approvals.original.noAttachments')}
              </dd>
            </div>
            {view.preview ? (
              <div>
                <dt>{t('approvals.original.preview')}</dt>
                <dd className="original-message-preview" dir="auto">{view.preview}</dd>
              </div>
            ) : null}
          </dl>
          {view.moved ? <p className="original-message-note">{t('approvals.original.moved')}</p> : null}
          <p className="original-message-note">{t('approvals.original.untrusted')}</p>
        </>
      )}
    </section>
  );
}
