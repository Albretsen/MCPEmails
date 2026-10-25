'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, Btn } from '../Primitives';
import { useAppLocale } from '../i18n/AppLocaleProvider';
import { FREE_ACTION_ALLOWANCE, PERSONAL_PASS_3M, PLANS as CATALOGUE } from '@/lib/stripe/plans';
import { formatPriceCents } from '@/lib/stripe/annual-offer';
import { checkoutStartHref } from '@/lib/billing/upgrade-intent.mjs';

/**
 * The 3-month Personal pass on the dashboard (plan sections 2 and 3; the
 * server rules are src/lib/billing/pass-offer.ts).
 *
 * Every offer here sits BELOW the subscription options, is never preselected,
 * and is never shown unless the server said so for this surface: the client
 * asks POST /api/billing/pass-offer once per mount and renders nothing until
 * the answer is `show: true`. No countdowns, no urgency, never "trial".
 *
 * Every buy link is a plain <a> to the GET checkout start route, never a
 * next/link (the router would prefetch it and create Stripe sessions).
 */

/** "3 February 2027", in the reader's language, in UTC like the pass itself. */
export function passDate(iso, locale) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(locale || 'en', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** The pass checkout link. Mirrors passCheckoutHref in pass-offer.ts. */
export function passStartHref({ locale, arm, surface }) {
  const params = new URLSearchParams({ product: PERSONAL_PASS_3M.id });
  if (locale && locale !== 'en') params.set('lang', locale);
  if (arm) params.set('arm', arm);
  params.set('from', surface);
  return `/api/stripe/checkout/start?${params.toString()}`;
}

function personalPrices(stripePrices) {
  const live = stripePrices?.personal ?? {};
  const monthlyCents = live.monthlyCents > 0 ? live.monthlyCents : CATALOGUE.personal.monthlyPriceCents;
  const yearlyCents = live.yearlyCents > 0 ? live.yearlyCents : CATALOGUE.personal.yearlyPriceCents;
  return {
    monthly: formatPriceCents(monthlyCents),
    yearly: yearlyCents ? formatPriceCents(yearlyCents) : null,
  };
}

const PASS_PRICE = formatPriceCents(PERSONAL_PASS_3M.priceCents);

/**
 * Ask the server once whether this surface shows the pass. `enabled: false`
 * asks nothing (the surface is not on screen), so no assignment is made for a
 * render that never happened.
 */
export function usePassOffer(surface, workspaceId, enabled = true) {
  const [answer, setAnswer] = useState(null);
  useEffect(() => {
    if (!enabled || !workspaceId) return undefined;
    let live = true;
    fetch('/api/billing/pass-offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surface, workspaceId }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (live && data && data.show === true) setAnswer(data);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [surface, workspaceId, enabled]);
  return answer;
}

const lineStyle = {
  fontFamily: 'var(--font-sans)',
  fontSize: 12.5,
  color: 'var(--fg-2)',
  lineHeight: 1.5,
};

const linkStyle = {
  color: 'var(--brand)',
  fontWeight: 600,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};

/** The one quiet line: what the pass is, its end date, and the link. */
function PassLine({ answer, surface }) {
  const t = useTranslations('dashboard');
  const { locale } = useAppLocale();
  return (
    <p data-pass-offer={surface} style={{ ...lineStyle, margin: 0 }}>
      {t('billing.pass.offerLine', { price: PASS_PRICE })}{' '}
      {t('billing.pass.offerUntil', { date: passDate(answer.endsAt, locale) })}{' '}
      <a href={passStartHref({ locale, arm: answer.arm, surface })} style={linkStyle}>
        {t('billing.pass.offerCta', { price: PASS_PRICE })}
      </a>
    </p>
  );
}

/**
 * The pass line for a surface that already shows the subscription options
 * above it (the Usage cap banner). Renders nothing unless the server says so.
 */
export function PassOfferLine({ surface, workspaceId, enabled = true }) {
  const answer = usePassOffer(surface, workspaceId, enabled);
  if (!answer) return null;
  return (
    <div style={{ flexBasis: '100%', paddingTop: 10, borderTop: '1px solid var(--border-1)' }}>
      <PassLine answer={answer} surface={surface} />
    </div>
  );
}

/**
 * The dashboard after an abandoned Personal checkout, for the treatment arm
 * only: the two subscription options first (monthly is the primary button),
 * then the pass line underneath. The holdout arm sees nothing new here.
 */
export function CheckoutReturnPassCard({ workspaceId, stripePrices, onDismiss }) {
  const t = useTranslations('dashboard');
  const { locale } = useAppLocale();
  const answer = usePassOffer('checkout_return', workspaceId, true);
  if (!answer) return null;
  const prices = personalPrices(stripePrices);
  return (
    <section
      aria-label={t('billing.pass.returnTitle')}
      style={{
        margin: '14px 24px 0',
        padding: '14px 16px',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: 'var(--fg-1)' }}>
          {t('billing.pass.returnTitle')}
        </div>
        <button type="button" className="toast-close" onClick={onDismiss} aria-label={t('billing.pass.close')}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a className="btn btn-primary" href={checkoutStartHref('personal', false, locale)}>
          {t('billing.pass.subscribeMonthly', { price: prices.monthly })}
        </a>
        {prices.yearly && (
          <a className="btn btn-secondary" href={checkoutStartHref('personal', true, locale)}>
            {t('billing.pass.subscribeYearly', { price: prices.yearly })}
          </a>
        )}
      </div>
      <PassLine answer={answer} surface="checkout_return" />
    </section>
  );
}

/**
 * Billing for someone who holds a pass: "Personal until {date}", the queued
 * pass, what happens after, and the ways to keep Personal. The subscribe
 * buttons state the first charge date, which is the pass end (Stripe anchors
 * the billing cycle there) or today when the pass ends within the hour.
 * Monthly can only be anchored in the pass's last month, so before that it
 * is a plain line with the day it opens (passState.monthlyOpensAt) instead of
 * a button.
 */
export function PassBillingPanel({ passState, stripePrices, onSubscribe, busy = null }) {
  const t = useTranslations('dashboard');
  const { locale } = useAppLocale();
  const prices = personalPrices(stripePrices);
  const chargeLabel = (interval, price) => {
    // Null when the subscription would charge today (decided server-side).
    const at = passState.firstCharge?.[interval];
    const key = interval === 'year' ? 'subscribeYearly' : 'subscribeMonthly';
    return at
      ? t(`billing.pass.${key}From`, { price, date: passDate(at, locale) })
      : t(`billing.pass.${key}`, { price });
  };
  return (
    <div
      data-pass-state="holder"
      style={{
        padding: '16px',
        background: passState.inLastWeek ? 'var(--brand-soft)' : 'var(--bg-sunken)',
        borderRadius: 10,
        border: passState.inLastWeek ? '1px solid rgba(37,71,229,0.18)' : '1px solid var(--border-1)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 4 }}>
          {passState.inLastWeek
            ? t('billing.pass.endingTitle', { date: passDate(passState.coveredUntil, locale) })
            : t('billing.pass.until', { date: passDate(passState.currentEndsAt, locale) })}
        </div>
        {passState.queuedEndsAt && (
          <div style={{ ...lineStyle, marginBottom: 4 }}>
            {t('billing.pass.queued', { date: passDate(passState.queuedEndsAt, locale) })}
          </div>
        )}
        <div style={{ ...lineStyle, color: 'var(--fg-3)' }}>
          {t('billing.pass.after', {
            date: passDate(passState.coveredUntil, locale),
            cap: FREE_ACTION_ALLOWANCE,
          })}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!passState.monthlyOpensAt && (
          <Btn variant="primary" onClick={() => onSubscribe('personal', 'month')} disabled={busy !== null}>
            {busy === 'personal' ? t('billing.redirecting') : chargeLabel('month', prices.monthly)}
          </Btn>
        )}
        {prices.yearly && (
          <Btn
            variant={passState.monthlyOpensAt ? 'primary' : 'secondary'}
            onClick={() => onSubscribe('personal', 'year')}
            disabled={busy !== null}
          >
            {chargeLabel('year', prices.yearly)}
          </Btn>
        )}
      </div>
      {passState.monthlyOpensAt && (
        <p data-pass-monthly="later" style={{ ...lineStyle, margin: 0 }}>
          {t('billing.pass.monthlyFrom', { date: passDate(passState.monthlyOpensAt, locale) })}
        </p>
      )}
      {passState.canAddPass && (
        <p style={{ ...lineStyle, margin: 0 }}>
          <a href={passStartHref({ locale, arm: 'holder', surface: 'pass_reminder' })} style={linkStyle}>
            {t('billing.pass.another', { price: PASS_PRICE })}
          </a>{' '}
          {t('billing.pass.anotherUntil', { date: passDate(passState.nextPassEndsAt, locale) })}
        </p>
      )}
    </div>
  );
}

/**
 * The last-7-days banner on every dashboard page but Settings (where the
 * Billing panel already says the same). It points at Billing, where the
 * options are, and records `pass_offer_shown / pass_reminder` once a day.
 * Shown only when the server's pass_reminder answer says so.
 */
export function PassEndingBanner({ passState, workspaceId, onOpenBilling }) {
  const t = useTranslations('dashboard');
  const { locale } = useAppLocale();
  const [dismissed, setDismissed] = useState(false);
  const due = !!passState?.inLastWeek && !dismissed;
  // The server decides (pass_reminder: no subscription, no pause, no comped
  // grant), the same rule that builds passState; the banner never shows on
  // the client's guess alone.
  const answer = usePassOffer('pass_reminder', workspaceId, due);
  const show = due && answer?.show === true;
  if (!show) return null;
  return (
    <div
      role="status"
      style={{
        margin: '14px 24px 0',
        padding: '12px 14px',
        background: 'var(--brand-soft)',
        border: '1px solid rgba(37,71,229,0.18)',
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ flex: '1 1 260px', ...lineStyle }}>
        <strong style={{ color: 'var(--fg-1)' }}>
          {t('billing.pass.endingTitle', { date: passDate(passState.coveredUntil, locale) })}
        </strong>{' '}
        {t('billing.pass.after', { date: passDate(passState.coveredUntil, locale), cap: FREE_ACTION_ALLOWANCE })}
      </div>
      <Btn variant="secondary" onClick={onOpenBilling}>
        {t('billing.pass.seeOptions')}
      </Btn>
      <button type="button" className="toast-close" onClick={() => setDismissed(true)} aria-label={t('billing.pass.close')}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
