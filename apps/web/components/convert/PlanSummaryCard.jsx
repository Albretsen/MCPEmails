'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAppLocale } from '../i18n/LocaleCore';
import { CheckoutReassurance } from '../CheckoutReassurance';
import { checkoutStartHref } from '@/lib/billing/upgrade-intent.mjs';
import { formatUsd, recommendPlan } from '@/lib/onboarding/flow-b.mjs';
import { flowBEvent, shownOnce } from './flow-b-actions';

/** Allowance dates are UTC days (see formatUtcDate in dashboard/Pages.jsx). */
export function formatFlowBDate(iso, locale) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString(locale === 'nb' ? 'nb-NO' : locale || 'en', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * B2, the plan summary (onboarding Flow B, src/lib/onboarding/flow-b.mjs).
 *
 * A quiet card, never a modal: what Free includes (one inbox, and "Unlimited
 * until {date}" during the grace), what Personal and Pro add, one plan
 * recommended by context, and "Continue on Free" as a button the same size
 * as the buy buttons. Monthly is preselected; annual sits beside it and is
 * only offered when a yearly price exists. The reassurance line sits under
 * the buttons. Dismissing it (X or Continue on Free) stamps
 * workspaces.plan_summary_dismissed_at, so it never comes back.
 *
 * @param {{
 *   flowB: import('@/lib/onboarding/flow-b-server').FlowBProp,
 *   surface: 'onboarding' | 'overview',
 *   businessShaped?: boolean,
 *   onHidden?: () => void,
 * }} props
 */
export function PlanSummaryCard({ flowB, surface, businessShaped = false, onHidden }) {
  const t = useTranslations('convert.planSummary');
  const { locale } = useAppLocale();
  const [hidden, setHidden] = useState(false);
  const [interval, setBilling] = useState('month');

  useEffect(() => {
    shownOnce(`plan_summary_${surface}`, 'plan_summary_shown', { surface });
  }, [surface]);

  if (hidden || !flowB) return null;

  const recommended = recommendPlan({ businessShaped, triedSecondInbox: flowB.triedSecondInbox });
  const prices = flowB.prices ?? {};
  const annualAvailable = Boolean(prices.personal?.yearlyCents && prices.solo?.yearlyCents);
  const annual = annualAvailable && interval === 'year';

  const hide = (event, data) => {
    setHidden(true);
    flowBEvent(event, data);
    onHidden?.();
  };

  const freeLines = [
    t('inboxes', { count: flowB.inboxCaps?.free ?? 1 }),
    flowB.inGrace && flowB.graceEndsAt
      ? t('freeGrace', { date: formatFlowBDate(flowB.graceEndsAt, locale) })
      : flowB.freeCap ? t('freeCap', { cap: flowB.freeCap }) : null,
  ].filter(Boolean);

  const paid = [
    {
      plan: 'personal',
      name: 'Personal',
      price: prices.personal,
      lines: [t('inboxes', { count: flowB.inboxCaps?.personal ?? 3 }), t('noCap'), t('emailSupport')],
    },
    {
      plan: 'solo',
      name: 'Pro',
      price: prices.solo,
      lines: [t('inboxes', { count: flowB.inboxCaps?.solo ?? 10 }), t('everythingPersonal')],
    },
  ].filter((p) => p.price);

  const priceLabel = (price) => (annual && price.yearlyCents
    ? t('perYear', { price: formatUsd(price.yearlyCents) })
    : t('perMonth', { price: formatUsd(price.monthlyCents) }));

  return (
    <section
      data-plan-summary={surface}
      data-plan-summary-recommended={recommended ?? 'none'}
      aria-labelledby={`plan-summary-${surface}`}
      style={{
        margin: surface === 'overview' ? '0 0 12px' : '20px 0 0',
        padding: 16,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id={`plan-summary-${surface}`} style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--fg-1)' }}>{t('title')}</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--fg-3)', lineHeight: 1.5 }}>{t('lead')}</p>
        </div>
        <button
          type="button"
          aria-label={t('dismiss')}
          title={t('dismiss')}
          onClick={() => hide('plan_summary_dismissed', { surface })}
          data-testid="plan-summary-dismiss"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 6, margin: -6, fontSize: 18, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      {annualAvailable && (
        <div role="group" aria-label={t('intervalLabel')} style={{ display: 'inline-flex', marginTop: 12, border: '1px solid var(--border-1)', borderRadius: 8, overflow: 'hidden' }}>
          {['month', 'year'].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={interval === value}
              onClick={() => setBilling(value)}
              data-testid={`plan-summary-interval-${value}`}
              style={{
                padding: '5px 12px',
                border: 'none',
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: 500,
                background: interval === value ? 'var(--brand)' : 'transparent',
                color: interval === value ? '#fff' : 'var(--fg-2)',
              }}
            >
              {value === 'month' ? t('monthly') : t('annual')}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12, alignItems: 'stretch' }}>
        <PlanColumn name={t('freeName')} price={null} lines={freeLines}>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => hide('plan_summary_clicked', { plan: 'free', surface })}
            data-testid="plan-summary-free"
          >
            {t('continueFree')}
          </button>
        </PlanColumn>
        {paid.map((p) => (
          <PlanColumn
            key={p.plan}
            name={p.name}
            price={priceLabel(p.price)}
            lines={p.lines}
            badge={recommended === p.plan ? t('recommended') : null}
            highlighted={recommended === p.plan}
          >
            {/* A plain anchor, never next/link: the href opens a Stripe
                Checkout session, and a prefetch would open sessions for
                people who never clicked. */}
            <a
              href={checkoutStartHref(p.plan, annual, locale)}
              className={`btn ${recommended === p.plan ? 'btn-primary' : 'btn-secondary'}`}
              style={{ width: '100%', justifyContent: 'center', textDecoration: 'none' }}
              onClick={() => flowBEvent('plan_summary_clicked', { plan: p.plan, surface })}
              data-plan-summary-plan={p.plan}
              data-plan-summary-interval={annual ? 'year' : 'month'}
            >
              {t('choose', { plan: p.name })}
            </a>
          </PlanColumn>
        ))}
      </div>

      <CheckoutReassurance locale={locale} align="left" style={{ marginTop: 10 }} />
    </section>
  );
}

function PlanColumn({ name, price, lines, badge = null, highlighted = false, children }) {
  return (
    <div
      style={{
        flex: '1 1 170px',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 12,
        borderRadius: 8,
        border: highlighted ? '2px solid var(--brand)' : '1px solid var(--border-1)',
        background: 'var(--bg-surface)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 14, fontWeight: 600, color: 'var(--fg-1)' }}>
        {name}
        {badge && (
          <span style={{ padding: '1px 7px', borderRadius: 999, background: 'var(--brand-soft)', color: 'var(--brand)', fontSize: 11, fontWeight: 600, lineHeight: 1.6 }}>
            {badge}
          </span>
        )}
      </div>
      {price && <div style={{ fontSize: 13, color: 'var(--fg-2)' }}>{price}</div>}
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {lines.map((line) => (
          <li key={line} style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.4 }}>
            <span aria-hidden="true" style={{ color: 'var(--mint-600)', marginRight: 6 }}>✓</span>
            {line}
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 'auto', paddingTop: 6 }}>{children}</div>
    </div>
  );
}
