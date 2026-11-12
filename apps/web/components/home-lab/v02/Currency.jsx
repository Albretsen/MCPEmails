'use client';

import { useDisplayCurrency } from '../../marketing/useDisplayCurrency';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';

/**
 * The two places v02 shows money, as tiny client islands. The server renders
 * USD (what every visitor saw before EUR existed); an EU visitor flips to EUR
 * after /api/geo answers, exactly like Sections.jsx Pricing and Faq. With
 * `eurEnabled` false and before the launch date the hook never fetches.
 */
export function Price({ usdCents, eurCents, eurEnabled, locale = 'en' }) {
  const currency = useDisplayCurrency(eurEnabled);
  if (currency === 'eur') {
    return <>{formatMoneyCents(eurCentsFor(eurCents, usdCents) ?? usdCents, 'eur', locale)}</>;
  }
  return <>{formatUsdCopy(usdCents, locale)}</>;
}

/** Plain text that may quote a dollar amount (a feature line, an FAQ answer). */
export function Money({ text, eurEnabled, locale = 'en' }) {
  const currency = useDisplayCurrency(eurEnabled);
  return <>{currency === 'eur' ? euroizeAmounts(text, locale) : text}</>;
}

/** "incl. VAT" under a paid price, only while EUR is shown. */
export function VatNote({ eurEnabled, label, className }) {
  const currency = useDisplayCurrency(eurEnabled);
  if (currency !== 'eur') return null;
  return <span className={className}>{label}</span>;
}
