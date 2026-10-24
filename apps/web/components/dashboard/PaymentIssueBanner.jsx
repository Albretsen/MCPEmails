'use client';

import { useTranslations } from 'next-intl';

/** Mirrors PAYMENT_ISSUE_STATUSES in src/lib/billing/payment-issue.ts. */
const PAYMENT_ISSUE_STATUSES = new Set(['past_due', 'unpaid']);

/**
 * One amber line while the owner's renewal payment is failing.
 *
 * Shown to the workspace OWNER only, while Stripe reports the subscription as
 * past_due or unpaid, and not dismissible while that holds. Service is not
 * limited in the meantime, which is what the copy says. The SCA variant
 * (decline code `authentication_required`) asks the owner to confirm the
 * payment with their bank instead of updating the card.
 *
 * The button is a plain link to GET /api/stripe/payment-fix, which looks up
 * the open invoice on click and redirects to Stripe, so no Stripe URL is ever
 * held in the page.
 *
 * Pure decision, exported for the test: null (no banner), 'declined' or
 * 'confirm'.
 *
 * @param {{ isOwner?: boolean, subscriptionStatus?: string | null, lastDeclineCode?: string | null }} props
 */
export function paymentIssueVariant({ isOwner, subscriptionStatus, lastDeclineCode }) {
  if (isOwner !== true) return null;
  if (!PAYMENT_ISSUE_STATUSES.has(subscriptionStatus ?? '')) return null;
  return lastDeclineCode === 'authentication_required' ? 'confirm' : 'declined';
}

/** @param {{ isOwner?: boolean, subscriptionStatus?: string | null, lastDeclineCode?: string | null }} props */
export function PaymentIssueBanner(props) {
  const tr = useTranslations('dashboardChrome');
  const variant = paymentIssueVariant(props);
  if (!variant) return null;

  const text = variant === 'confirm' ? tr('app.paymentIssueConfirm') : tr('app.paymentIssueDeclined');
  const cta = variant === 'confirm' ? tr('app.paymentIssueConfirmCta') : tr('app.paymentIssueDeclinedCta');

  return (
    <div style={{ padding: '16px 32px 0' }}>
      <div
        role="status"
        data-payment-issue={variant}
        style={{
          background: 'var(--amber-50)',
          border: '1px solid var(--amber-200)',
          borderRadius: 10,
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 200, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--amber-800)' }}>
          {text}
        </div>
        <a className="btn btn-secondary btn-sm" href="/api/stripe/payment-fix">
          {cta}
        </a>
      </div>
    </div>
  );
}
