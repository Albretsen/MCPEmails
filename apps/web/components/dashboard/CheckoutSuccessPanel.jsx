'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn } from '../Primitives';
import { useAppLocale } from '../i18n/AppLocaleProvider';
import { planDisplayName } from './Pages';

/**
 * CheckoutSuccessPanel: the confirmation a customer sees on return from Stripe.
 *
 * WHY THIS EXISTS. The only acknowledgement used to be a four second toast in
 * the bottom right corner, fired from a mount effect that cannot run until the
 * dashboard's dynamic server render and hydration have both finished. It is
 * real and it does fire, but by the time it appears the buyer is reading the
 * page, it sits diagonally opposite everything they are looking at, and the
 * same effect strips `?checkout=success` from the URL, so once those four
 * seconds pass the confirmation cannot be recovered at all. The owner paid for
 * a plan in production and reported, correctly, that nothing told him so.
 *
 * A purchase confirmation has to survive being looked away from. This is a
 * modal: it states the plan, the price, the billing interval, the next billing
 * date, what the plan now allows, and what to do next, and it stays until the
 * buyer dismisses it.
 *
 * THE WEBHOOK RACE. Stripe redirects the browser and delivers
 * `checkout.session.completed` independently, so the dashboard can render
 * before `workspaces.plan` has been updated. The purchased plan therefore
 * comes from the checkout return URL, never from the workspace row, and the
 * entitlement lines are suppressed (not guessed, and never rendered as the old
 * free allowance) until the live plan agrees. While they disagree the panel
 * asks its parent to refetch on a short backoff and says plainly that the
 * subscription is still activating.
 *
 * Props:
 *   planId        purchased plan id from the return URL: the authority on what
 *                 was bought.
 *   interval      'month' | 'year' | null. Null when the return URL does not
 *                 carry it; the price and renewal rows are then omitted rather
 *                 than guessed.
 *   livePlan      workspaces.plan as last rendered by the server. Lags the
 *                 purchase until the webhook lands.
 *   maxInboxes    inbox allowance of the LIVE plan. null means unlimited.
 *   inboxCount    inboxes connected right now.
 *   stripePrices  { [planId]: { monthlyCents, yearlyCents } } from Stripe.
 *   onConnectInbox / onViewBilling / onDismiss  parent actions.
 *   onRefreshPlan stable callback that refetches server data.
 */

/**
 * Backoff for refetching the workspace while the webhook is still in flight.
 * Bounded on purpose: after the last attempt the panel stops polling and tells
 * the customer the payment succeeded regardless, rather than spinning forever.
 */
const REFRESH_DELAYS_MS = [1500, 3000, 6000, 10000];

/** Format integer cents as currency, hiding ".00" on whole amounts. */
function formatMoney(cents, locale) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
  try {
    return new Intl.NumberFormat(locale || 'en', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  }
}

/** Format a Date in the app locale, falling back to ISO on an odd locale. */
function formatDate(date, locale) {
  if (!date) return null;
  try {
    return new Intl.DateTimeFormat(locale || 'en', { dateStyle: 'long' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** One label/value line in the summary block. */
function SummaryRow({ label, children }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 16,
        padding: '10px 0',
        borderBottom: '1px solid var(--border-1)',
      }}
    >
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)' }}>
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 13.5,
          fontWeight: 600,
          color: 'var(--fg-1)',
          textAlign: 'right',
        }}
      >
        {children}
      </span>
    </div>
  );
}

export function CheckoutSuccessPanel({
  planId,
  interval = null,
  livePlan = null,
  maxInboxes = null,
  inboxCount = 0,
  stripePrices = null,
  onConnectInbox,
  onViewBilling,
  onRefreshPlan,
  onDismiss,
}) {
  const tr = useTranslations('dashboardChrome');
  const { locale } = useAppLocale();

  // The webhook has landed only when the server agrees with what was bought.
  const activating = livePlan !== planId;
  const [tick, setTick] = useState(0);
  const exhausted = tick >= REFRESH_DELAYS_MS.length;

  // Refetch server data on a short backoff until the plan lands. Each attempt
  // is scheduled from `tick` rather than from `livePlan`, so a refetch that
  // returns the same (still stale) plan does not stall the sequence.
  useEffect(() => {
    if (!activating || exhausted) return undefined;
    const id = setTimeout(() => {
      if (onRefreshPlan) onRefreshPlan();
      setTick((n) => n + 1);
    }, REFRESH_DELAYS_MS[tick]);
    return () => clearTimeout(id);
  }, [activating, exhausted, tick, onRefreshPlan]);

  // Escape dismisses, like every other dialog in the dashboard.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && onDismiss) onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  const planName = planDisplayName(planId);

  const priced = interval === 'month' || interval === 'year';
  const cents = priced
    ? (interval === 'year'
        ? stripePrices?.[planId]?.yearlyCents
        : stripePrices?.[planId]?.monthlyCents)
    : null;
  const price = formatMoney(cents, locale);

  // The first renewal of a subscription created seconds ago is exactly one
  // interval from today. Computed in the browser only; this panel never
  // server-renders, so there is no hydration mismatch to worry about.
  const renewsOn = useMemo(() => {
    if (!priced) return null;
    const d = new Date();
    if (interval === 'year') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
    return formatDate(d, locale);
  }, [priced, interval, locale]);

  const allowance = activating
    ? null
    : maxInboxes == null
      ? tr('app.checkoutPanel.inboxesUnlimited')
      : tr('app.checkoutPanel.inboxesLimit', { count: maxInboxes });

  return (
    <div
      className="scrim"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && onDismiss) onDismiss();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-success-title"
      >
        <div className="modal-h" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div
            aria-hidden="true"
            style={{
              width: 40,
              height: 40,
              flexShrink: 0,
              borderRadius: 12,
              background: 'var(--mint-600)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 2,
            }}
          >
            <Icon name="check" size={20} color="#fff" strokeWidth={2.4} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="checkout-success-title">
              {tr('app.checkoutPanel.title', { plan: planName })}
            </h2>
            <div className="sub">{tr('app.checkoutPanel.subtitle')}</div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={tr('app.checkoutPanel.close')}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--fg-3)',
              padding: 4,
              marginTop: 2,
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div>
            <SummaryRow label={tr('app.checkoutPanel.planLabel')}>{planName}</SummaryRow>

            {priced && price && (
              <SummaryRow label={tr('app.checkoutPanel.priceLabel')}>
                {interval === 'year'
                  ? tr('app.checkoutPanel.pricePerYear', { price })
                  : tr('app.checkoutPanel.pricePerMonth', { price })}
              </SummaryRow>
            )}

            {renewsOn && (
              <SummaryRow label={tr('app.checkoutPanel.renewsLabel')}>{renewsOn}</SummaryRow>
            )}

            {allowance && (
              <SummaryRow label={tr('app.checkoutPanel.includesLabel')}>{allowance}</SummaryRow>
            )}

            {!activating && (
              <SummaryRow label={tr('app.checkoutPanel.connectedLabel')}>
                {maxInboxes == null
                  ? tr('app.checkoutPanel.connectedCount', { count: inboxCount })
                  : tr('app.checkoutPanel.connectedOfMax', {
                      count: inboxCount,
                      max: maxInboxes,
                    })}
              </SummaryRow>
            )}
          </div>

          {/* The payment is never in doubt here: Stripe only redirects to this
              URL after it has taken the money. Only the entitlement is still
              settling, so say that and nothing more alarming. */}
          {activating && (
            <div
              role="status"
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                color: 'var(--fg-2)',
                background: 'var(--ink-25)',
                border: '1px solid var(--border-1)',
                borderRadius: 10,
                padding: '10px 12px',
              }}
            >
              {exhausted
                ? tr('app.checkoutPanel.activatingSlow')
                : tr('app.checkoutPanel.activating')}
            </div>
          )}

          {!priced && (
            <div
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 12.5,
                color: 'var(--fg-3)',
              }}
            >
              {tr('app.checkoutPanel.billingDetailsNote')}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <Btn variant="ghost" onClick={onViewBilling}>
            {tr('app.checkoutPanel.billingCta')}
          </Btn>
          <Btn variant="primary" icon="plus" onClick={onConnectInbox}>
            {tr('app.checkoutPanel.connectCta')}
          </Btn>
        </div>
      </div>
    </div>
  );
}

export default CheckoutSuccessPanel;
