'use client';

/**
 * A line of copy that quotes dollar amounts, shown in euros for an EU visitor
 * once /api/geo says so (same rule as the price plates). Renders the USD text
 * on the server, so it reads with JavaScript off.
 */

import { useDisplayCurrency } from '../../marketing/useDisplayCurrency';
import { euroizeAmounts } from '@/lib/stripe/eur-prices';

/** @param {{ text: string, eurEnabled?: boolean, locale?: string }} props */
export default function Money({ text, eurEnabled = false, locale = 'en' }) {
  const currency = useDisplayCurrency(eurEnabled);
  return currency === 'eur' ? euroizeAmounts(text, locale) : text;
}
