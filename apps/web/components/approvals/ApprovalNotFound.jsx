'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Icon } from '../Primitives';

/**
 * Deliberately vague. See app/approvals/[id]/not-found.js — this same screen
 * answers "no such approval" and "not your workspace", so the copy must not
 * imply which one happened.
 */
export function ApprovalNotFound() {
  const t = useTranslations('dashboard');
  return (
    <div className="review-shell">
      <div className="review-wrap">
        <Link className="review-brand" href="/dashboard">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </Link>
        <div className="card review-card review-card-narrow">
          <div className="review-banner review-banner-neutral" role="status">
            <span className="review-banner-icon" aria-hidden="true">
              <Icon name="shield" size={18} />
            </span>
            <div>
              <strong>{t('approvals.review.notFoundTitle')}</strong>
              <p>{t('approvals.review.notFoundBody')}</p>
            </div>
          </div>
          <div className="review-actions">
            <Link className="btn btn-secondary" href="/dashboard/approvals">
              {t('approvals.review.toDashboard')}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
