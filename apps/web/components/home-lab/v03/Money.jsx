'use client';

import { useDisplayCurrency } from '../../marketing/useDisplayCurrency';

/**
 * Shows `usd` (server-rendered for everyone) and swaps to `eur` for an EU
 * visitor while EUR prices are on, exactly like the live Pricing component.
 * Both strings are prepared on the server; this island only chooses.
 */
export default function Money({ usd, eur, eurEnabled = false }) {
  const currency = useDisplayCurrency(eurEnabled);
  return currency === 'eur' && eur ? eur : usd;
}
