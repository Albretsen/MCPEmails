'use client';

import { useDisplayCurrency } from '../../marketing/useDisplayCurrency';

/**
 * A price or a line with prices in it. The server renders USD; an EU visitor
 * sees the EUR text once /api/geo answers, exactly as Sections.jsx Pricing
 * does with `eurEnabled`.
 */
export default function Money({ usd, eur, eurEnabled }) {
  const currency = useDisplayCurrency(eurEnabled);
  return <>{currency === 'eur' && eur ? eur : usd}</>;
}
