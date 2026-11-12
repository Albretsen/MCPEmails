'use client';

import { useDisplayCurrency } from '../../marketing/useDisplayCurrency';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';

/**
 * Prices and price-bearing sentences for v01. The server renders USD for
 * everyone (the page is cached); an EU visitor with EUR on gets the same
 * digits in EUR after /api/geo answers, exactly like Sections.jsx Pricing.
 */
export function Price({ usdCents, eurCents = null, eurEnabled = false, locale = 'en', inclVat = 'incl. VAT', className, vatClassName }) {
  const currency = useDisplayCurrency(eurEnabled);
  if (currency === 'eur') {
    const cents = eurCentsFor(eurCents, usdCents) ?? usdCents;
    return (
      <>
        <span className={className}>{formatMoneyCents(cents, 'eur', locale)}</span>
        {usdCents > 0 && <span className={vatClassName}> {inclVat}</span>}
      </>
    );
  }
  return <span className={className}>{formatUsdCopy(usdCents, locale)}</span>;
}

/** A sentence that may quote USD amounts ("$9 a month"), shown in EUR for an EU visitor. */
export function MoneyText({ text, eurEnabled = false, locale = 'en' }) {
  const currency = useDisplayCurrency(eurEnabled);
  return currency === 'eur' ? euroizeAmounts(text, locale) : text;
}
