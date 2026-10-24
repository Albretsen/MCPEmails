'use client';

import { useEffect, useState } from 'react';

/**
 * The currency a marketing page shows its prices in: 'usd' or 'eur'.
 *
 * The page is static and CDN-cached, so the server renders USD for everyone
 * and the browser asks /api/geo once per page load (see that route for why it
 * is a route and not a cookie). EUR needs BOTH halves: `eurEnabled`, which the
 * server page serialises from STRIPE_EUR_PRICES, and the route's own answer,
 * which re-reads the switch per request and adds the visitor's country.
 *
 * With the switch off this hook never fetches anything and always returns
 * 'usd', so the page renders exactly as it did before EUR prices existed. A
 * failed or slow request also leaves USD in place: the fallback is the price
 * every visitor saw until now, never a blank.
 */
let geoRequest = null;

function requestGeo() {
  if (!geoRequest) {
    geoRequest = fetch('/api/geo', { cache: 'no-store', credentials: 'omit' })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  }
  return geoRequest;
}

export function useDisplayCurrency(eurEnabled) {
  const [currency, setCurrency] = useState('usd');
  useEffect(() => {
    if (eurEnabled !== true) return undefined;
    let cancelled = false;
    requestGeo().then((geo) => {
      if (!cancelled && geo && geo.eur === true) setCurrency('eur');
    });
    return () => {
      cancelled = true;
    };
  }, [eurEnabled]);
  return currency;
}
