'use client';

import { useTranslations } from 'next-intl';
import {
  annualOfferFromPrices,
  formatPriceCents,
} from '@/lib/stripe/annual-offer';
import { checkoutStartHref } from '@/lib/billing/upgrade-intent.mjs';
import { buysAnnual, sharedIntervalChoice } from '@/lib/billing/inbox-cap-offer.mjs';

/**
 * The monthly / annual choice on the in-product upsell surfaces.
 *
 * WHY IT EXISTS. The two paywall CTAs (the connect modal's cap panel and the
 * cap notice on the Inboxes page) both hardcoded `checkoutStartHref(plan,
 * false)`, so the product could only ever sell monthly at the moment of highest
 * intent. Annual is 43% of committed revenue and every annual sale to date came
 * from some OTHER surface: the largest sale in the product's history ($144 Pro
 * annual) was bought on /pricing after two monthly checkouts were abandoned.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not change the default. Monthly
 * stays selected, so someone who ignores this control buys exactly what the
 * same click bought yesterday. Defaulting to annual here would turn a $5 charge
 * into a $48 one for an unchanged gesture: that is a stealth price rise wearing
 * a growth tactic's clothes, and the paywall is the worst possible place for it
 * because the person reading it has just been refused something.
 *
 * The saving is computed (see lib/stripe/annual-offer), and the whole control
 * disappears when the plan has no configured yearly Stripe price, so it can
 * never render a button whose only outcome is `price_not_configured`.
 */

/**
 * The segmented control itself, with no opinion about billing.
 *
 * Extracted from BillingSection, which drew this exact control inline, and now
 * used by all three surfaces so the dashboard has ONE segmented interval
 * switch rather than one per paywall.
 *
 * @param {{
 *   value: string,
 *   onChange: (value: string) => void,
 *   options: Array<{ value: string, label: string, note?: string, badge?: string }>,
 *   ariaLabel?: string,
 *   size?: 'sm' | 'md',
 * }} props
 */
export function IntervalToggle({ value, onChange, options, ariaLabel, size = 'md' }) {
  const compact = size === 'sm';
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        gap: 0,
        alignSelf: 'flex-start',
        borderRadius: 8,
        border: '1px solid var(--border-1)',
        overflow: 'hidden',
      }}
    >
      {options.map(opt => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 1,
              padding: compact ? '5px 10px' : '6px 14px',
              fontFamily: 'var(--font-sans)',
              fontSize: compact ? 12 : 12.5,
              fontWeight: 500,
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              background: active ? 'var(--brand)' : 'transparent',
              color: active ? '#fff' : 'var(--fg-2)',
              transition: 'background 120ms, color 120ms',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {opt.label}
              {opt.badge && (
                <span
                  style={{
                    padding: '1px 5px',
                    borderRadius: 999,
                    fontSize: compact ? 10 : 10.5,
                    fontWeight: 600,
                    lineHeight: 1.5,
                    background: active ? 'rgba(255,255,255,0.22)' : 'var(--mint-50)',
                    color: active ? '#fff' : 'var(--mint-600)',
                  }}
                >
                  {opt.badge}
                </span>
              )}
            </span>
            {opt.note && (
              <span
                style={{
                  fontSize: compact ? 10.5 : 11,
                  fontWeight: 400,
                  color: active ? 'rgba(255,255,255,0.85)' : 'var(--fg-3)',
                }}
              >
                {opt.note}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Resolve the annual option for one plan from the live price map.
 *
 * Returns null whenever annual must not be offered, which is what every caller
 * treats as "render nothing and keep the monthly-only behaviour".
 *
 * @param {import('@/lib/stripe/getPrices').StripePricesMap | null | undefined} stripePrices
 * @param {string} planId Internal plan id ('personal' | 'solo' | 'pro').
 */
export function annualOfferForPlan(stripePrices, planId) {
  return annualOfferFromPrices(stripePrices?.[planId]);
}

/**
 * The billing-interval choice for a paywall, prices and saving included.
 *
 * Renders nothing when `offer` is null, which is both the "no yearly price
 * configured" case and the "no live prices reached this surface" case. Callers
 * therefore do not need their own guard, and cannot forget one.
 *
 * @param {{
 *   offer: import('@/lib/stripe/annual-offer').AnnualOffer | null,
 *   value: 'month' | 'year',
 *   onChange: (interval: 'month' | 'year') => void,
 *   size?: 'sm' | 'md',
 * }} props
 */
export default function UpgradeIntervalChoice({ offer, value, onChange, size = 'md' }) {
  const tr = useTranslations('dashboardChrome');
  if (!offer) return null;

  const options = [
    {
      value: 'month',
      label: tr('connect.intervalMonthly'),
      note: tr('connect.intervalPerMonth', {
        price: formatPriceCents(offer.monthlyPriceCents),
      }),
    },
    {
      value: 'year',
      label: tr('connect.intervalAnnual'),
      note: tr('connect.intervalPerMonth', {
        price: formatPriceCents(offer.yearlyPerMonthCents),
      }),
      // No saving, no saving claim. A yearly price that is not cheaper is still
      // real and still buyable, it just does not get a badge for it.
      badge:
        offer.savingPercent != null
          ? tr('connect.intervalSave', { percent: offer.savingPercent })
          : undefined,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <IntervalToggle
        value={value}
        onChange={onChange}
        options={options}
        ariaLabel={tr('connect.intervalLabel')}
        size={size}
      />
      {/* The one number the buyer is actually charged on this option, stated
          before they click rather than discovered on Stripe's page. */}
      {value === 'year' && (
        <div
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 11.5,
            color: 'var(--fg-3)',
          }}
        >
          {tr('connect.intervalAnnualNote', {
            price: formatPriceCents(offer.yearlyPriceCents),
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The buy button's label, which has to follow the interval or it lies.
 *
 * The monthly CTA copy is untouched (it still reads "Upgrade to Personal,
 * $5/mo" from the same key it always has). Only the annual label is new, and it
 * quotes the annual total from the live price rather than from a sentence,
 * because a CTA that says "$5/mo" while sending someone to a $48 charge is the
 * dark pattern this whole change exists to avoid.
 *
 * Not a hook, so it can be called from inside a conditional block.
 *
 * @param {(key: string, values?: Record<string, unknown>) => string} tr A
 *   `dashboardChrome` translator.
 */
export function upgradeCtaLabel(tr, { offer, interval, planName, monthlyLabel }) {
  if (!offer || interval !== 'year') return monthlyLabel;
  return tr('connect.upgradeCtaAnnual', {
    plan: planName,
    price: formatPriceCents(offer.yearlyPriceCents),
  });
}

/**
 * ONE interval choice governing SEVERAL buy buttons.
 *
 * Used when the inbox cap offers two plans side by side (a business-shaped
 * Free workspace is shown Personal and Pro, see lib/billing/inbox-cap-offer).
 * The single-plan control above prints each interval's price inside the toggle,
 * which two plans at two prices cannot share, so this one is price-free and
 * every buy button states its own number instead.
 *
 * Same default as everything else here: the caller's state starts at 'month'
 * and this never changes it. It renders nothing unless EVERY plan on screen can
 * be bought yearly, so "Annual" can never sit above a button that would still
 * sell monthly; both rules live in `sharedIntervalChoice`, where they are
 * tested.
 *
 * @param {{
 *   annualOffers: Array<import('@/lib/stripe/annual-offer').AnnualOffer | null>,
 *   value: 'month' | 'year',
 *   onChange: (interval: 'month' | 'year') => void,
 *   size?: 'sm' | 'md',
 * }} props
 */
export function SharedIntervalChoice({ annualOffers, value, onChange, size = 'md' }) {
  const tr = useTranslations('dashboardChrome');
  const { annualAvailable, savingPercent } = sharedIntervalChoice(annualOffers);
  if (!annualAvailable) return null;

  return (
    <IntervalToggle
      value={value}
      onChange={onChange}
      ariaLabel={tr('connect.intervalLabel')}
      size={size}
      options={[
        { value: 'month', label: tr('connect.intervalMonthly') },
        {
          value: 'year',
          label: tr('connect.intervalAnnual'),
          badge:
            savingPercent != null
              ? tr('connect.intervalSave', { percent: savingPercent })
              : undefined,
        },
      ]}
    />
  );
}

/**
 * One plan's buy button on a cap surface, as a plain anchor.
 *
 * MUST STAY A PLAIN <a>, never a next/link: the href is an API route that
 * creates a Stripe Checkout session, so a prefetch would open sessions for
 * people who never clicked.
 *
 * The href and the label are derived from the SAME `buysAnnual` answer, so the
 * button can never read "$5/mo" while sending `interval=year`, nor the reverse.
 * That pairing was previously kept true by two adjacent expressions at each
 * call site; with two buttons per surface it is kept true here, once.
 *
 * `block` is the in-card form: full width, and allowed to wrap, because a card
 * is about 185px wide inside the modal and "Oppgrader til Personal, $48/yr"
 * is not. A clipped price on a buy button is worse than a two-line one.
 *
 * @param {{
 *   plan: string,
 *   planName: string,
 *   monthlyLabel: string,
 *   annualOffer: import('@/lib/stripe/annual-offer').AnnualOffer | null,
 *   interval: 'month' | 'year',
 *   size?: 'sm' | 'md',
 *   block?: boolean,
 *   children?: import('react').ReactNode,
 * }} props `children` renders before the label (an icon).
 */
export function PlanCheckoutLink({
  plan,
  planName,
  monthlyLabel,
  annualOffer,
  interval,
  size = 'md',
  block = false,
  children,
}) {
  const tr = useTranslations('dashboardChrome');
  const annual = buysAnnual(interval, annualOffer);
  const compact = size === 'sm';
  const height = compact ? 32 : 34;
  return (
    <a
      href={checkoutStartHref(plan, annual)}
      data-cap-offer-plan={plan}
      style={{
        display: block ? 'flex' : 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: block ? '7px 10px' : compact ? '0 14px' : '0 16px',
        ...(block ? { minHeight: height, boxSizing: 'border-box' } : { height }),
        background: 'var(--brand)',
        color: '#fff',
        borderRadius: 8,
        fontFamily: 'var(--font-sans)',
        fontSize: compact ? 12.5 : 13,
        fontWeight: 500,
        lineHeight: 1.3,
        textAlign: 'center',
        textDecoration: 'none',
        whiteSpace: block ? 'normal' : 'nowrap',
      }}
    >
      {children}
      {upgradeCtaLabel(tr, {
        offer: annualOffer,
        interval: annual ? 'year' : 'month',
        planName,
        monthlyLabel,
      })}
    </a>
  );
}
