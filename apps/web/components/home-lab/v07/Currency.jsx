'use client';

import { useDisplayCurrency } from '../../marketing/useDisplayCurrency';

/**
 * Client island: shows the USD rendering, or the EUR one for an EU visitor
 * while EUR prices are on (same rule as the live Pricing section). Both
 * renderings are built on the server; this only picks one after hydration,
 * so the HTML without JavaScript always reads in USD.
 */
export default function Currency({ eurEnabled, usd, eur }) {
  const currency = useDisplayCurrency(eurEnabled);
  return currency === 'eur' && eur != null ? eur : usd;
}
