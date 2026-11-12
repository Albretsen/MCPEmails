'use client';

import { createContext, useContext } from 'react';
import { useDisplayCurrency } from '../../marketing/useDisplayCurrency';

/**
 * Currency for v05's prices. The server renders USD; an EU visitor sees EUR
 * once /api/geo answers, exactly like Sections.jsx Pricing (eurEnabled plus
 * the route's own answer). Every amount is precomputed on the server in both
 * currencies, so this island only chooses.
 */
const CurrencyContext = createContext('usd');

export function CurrencyRoot({ eurEnabled, children }) {
  const currency = useDisplayCurrency(eurEnabled);
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>;
}

/** Renders `usd`, or `eur` for an EU visitor (null `eur` keeps USD). */
export function Money({ usd, eur = null }) {
  const currency = useContext(CurrencyContext);
  return <>{currency === 'eur' && eur != null ? eur : usd}</>;
}

/** Content shown only while prices are in EUR (the "incl. VAT" line). */
export function EurOnly({ children }) {
  const currency = useContext(CurrencyContext);
  return currency === 'eur' ? <>{children}</> : null;
}
