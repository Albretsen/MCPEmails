import { checkoutReassurance } from '@/lib/billing/checkout-reassurance.mjs';

/**
 * "Charged today. Cancel any time. 14-day refund." as one small line under a
 * button that starts a payment. The wording, its translations and the reasons
 * each fact is true live in lib/billing/checkout-reassurance.mjs; this only
 * renders it.
 *
 * Show it only where the click starts a NEW purchase: never on an existing
 * subscriber's in-place plan change, which the 14-day refund does not cover.
 *
 * `locale` is passed in because the dashboard (useAppLocale) and the
 * marketing pages (next-intl useLocale) resolve it differently.
 *
 * @param {{
 *   locale?: string,
 *   kind?: 'subscription' | 'pass' | 'deferred',
 *   align?: 'left' | 'center' | 'right',
 *   className?: string,
 *   style?: import('react').CSSProperties,
 * }} props
 */
export function CheckoutReassurance({ locale, kind = 'subscription', align = 'left', className, style }) {
  return (
    <p
      data-checkout-reassurance={kind}
      className={className}
      style={{
        margin: 0,
        fontFamily: 'var(--font-sans)',
        fontSize: 11.5,
        lineHeight: 1.4,
        color: 'var(--fg-3)',
        textAlign: align,
        ...style,
      }}
    >
      {checkoutReassurance(locale, kind)}
    </p>
  );
}

export default CheckoutReassurance;
