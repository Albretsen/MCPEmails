'use client';

import { useDisplayCurrency } from '../../marketing/useDisplayCurrency';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';

/**
 * Money on the v06 page. The server renders USD, so it reads with JavaScript
 * off; an EU visitor flips to EUR once /api/geo answers, the same rule as
 * Sections.jsx Pricing and Faq.
 */
export function Price({ usdCents, eurCents, eurEnabled = false, locale = 'en' }) {
  const currency = useDisplayCurrency(eurEnabled);
  if (currency === 'eur') {
    return <>{formatMoneyCents(eurCentsFor(eurCents, usdCents) ?? usdCents, 'eur', locale)}</>;
  }
  return <>{formatUsdCopy(usdCents, locale)}</>;
}

/** Text that may quote a dollar amount (a plan feature, an FAQ answer). */
export function Money({ text, eurEnabled = false, locale = 'en' }) {
  const currency = useDisplayCurrency(eurEnabled);
  return <>{currency === 'eur' ? euroizeAmounts(text, locale) : text}</>;
}

/** "incl. VAT" under a paid price, only while EUR is shown. */
export function VatNote({ eurEnabled = false, label, className }) {
  const currency = useDisplayCurrency(eurEnabled);
  if (currency !== 'eur') return null;
  return <p className={className}>{label}</p>;
}
