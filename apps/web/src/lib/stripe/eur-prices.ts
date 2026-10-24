/**
 * EUR prices for visitors in the EU, VAT included.
 *
 * WHAT IS DECIDED (Documents/plans/eur-prices-20261024.md, section 6). A
 * visitor in any of the 27 EU member states sees and pays EUR, with the SAME
 * digits as the USD price and VAT included: Personal EUR 9 / EUR 86.40, Pro
 * EUR 15 / EUR 144 (or whatever Pro sells at, see PRO_PRICE_CHANGE), Business
 * EUR 39 / EUR 374.40, extra mailbox EUR 3 / EUR 28.80. The non-euro members
 * (SE, PL, CZ, DK, HU, RO, BG) get EUR too, so nobody in the EU is shown a USD
 * price with VAT added on top. Everyone else keeps USD, unchanged.
 *
 * THE SWITCH. STRIPE_EUR_PRICES, default OFF. Only 'true', 'on', '1' or 'yes'
 * (any case) turn it on; unset, empty or anything else is off. It is read when
 * `eurPricesEnabled` is called, never at module load, so tests and the
 * request-time /api/geo route see the current value. With the switch off every
 * surface renders exactly what it rendered before this file existed.
 *
 * WHY THE DIGITS ARE NOT WRITTEN HERE. The EUR amount of a price is the
 * Stripe price's own `currency_options.eur.unit_amount` (getPrices.ts reads
 * it), and when that is missing it is the USD unit amount, the same digits. So
 * a USD reprice moves the EUR number with it, and copy tests can keep treating
 * "9" as the one sold amount whichever sign sits next to it.
 *
 * Pure (its one import, currency.ts, is pure too), safe in client bundles. The client never reads the env:
 * the server page serialises `eurPricesEnabled()` into props, and /api/geo
 * says whether this visitor is in the EU.
 */

import { EU_COUNTRIES as EU_SET, eurPricesEnabled as checkoutEurSwitch } from './currency.ts';

type Env = Record<string, string | undefined>;

/**
 * True only when STRIPE_EUR_PRICES explicitly turns EUR prices on. The same
 * switch and the same parsing checkout uses (currency.ts, tax-switch.ts), so
 * the page can never show EUR while checkout would sell USD, or the reverse.
 */
export function eurPricesEnabled(env?: Env): boolean {
  const source: Env =
    env ?? (typeof process !== 'undefined' ? (process.env as Env) : {});
  return checkoutEurSwitch(source);
}

/**
 * The 27 EU member states as ISO 3166-1 alpha-2 codes, the form Vercel's
 * `x-vercel-ip-country` header uses (Greece is GR, not EL). One list, kept in
 * currency.ts, shared with checkout.
 */
export const EU_COUNTRIES: readonly string[] = Object.freeze([...EU_SET].sort());

/** Whether a two-letter country code is an EU member state. */
export function isEuCountry(code: string | null | undefined): boolean {
  return typeof code === 'string' && EU_SET.has(code.trim().toUpperCase());
}

export type DisplayCurrency = 'usd' | 'eur';

/** EUR when the switch is on AND the visitor is in the EU; USD otherwise. */
export function displayCurrencyFor({
  eurEnabled,
  country,
}: {
  eurEnabled: boolean | null | undefined;
  country: string | null | undefined;
}): DisplayCurrency {
  return eurEnabled === true && isEuCountry(country) ? 'eur' : 'usd';
}

/**
 * The EUR amount for a price: Stripe's EUR currency option when it is a real
 * positive amount, else the USD cents (same digits, by decision).
 */
export function eurCentsFor(
  eurUnitAmount: number | null | undefined,
  usdCents: number | null | undefined,
): number | null {
  if (typeof eurUnitAmount === 'number' && Number.isFinite(eurUnitAmount) && eurUnitAmount > 0) {
    return eurUnitAmount;
  }
  return typeof usdCents === 'number' && Number.isFinite(usdCents) ? usdCents : null;
}

/**
 * Format cents as money in the reader's locale: "€9" in en, "9 €" in de, fr,
 * es and nb, "€86.40" / "86,40 €". Whole amounts drop the cents, fractional
 * ones keep both digits.
 */
export function formatMoneyCents(cents: number, currency: string = 'usd', locale: string = 'en-US'): string {
  const whole = cents % 100 === 0;
  const code = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(cents / 100);
  } catch {
    const amount = whole ? String(cents / 100) : (cents / 100).toFixed(2);
    if (code === 'USD') return `$${amount}`;
    if (code === 'EUR') return `€${amount}`;
    return `${amount} ${code}`;
  }
}

/**
 * Every USD amount a message writes, in every locale's spelling: "$9", "$ 9",
 * "$86.40", "9 $", "86,40 $", "9 美元", "9 dollars", "9 USD". The same amounts
 * personal-price-copy.test.ts sweeps the bundles for, which is what makes the
 * rewrite below safe: every amount it can match is one the catalogue sells.
 *
 * No lookbehind: this ships to browsers, and Safari before 16.4 rejects a
 * lookbehind at parse time, which would take the whole pricing page down with
 * it. The character before a trailing-sign amount is captured instead and put
 * back unchanged.
 */
const USD_AMOUNT =
  /\$\s?(\d+(?:[.,]\d{1,2})?)(?!\d)|(^|[^\w.,])(\d+(?:[.,]\d{1,2})?)\s?(?:\$|美元|dollars?\b|USD\b)/g;

/**
 * Rewrite the USD amounts in a sentence as the same digits in EUR, formatted
 * for `locale`. Used only for an EU visitor with the switch on, on the copy of
 * the pricing surfaces: "Three inboxes, $9." becomes "Three inboxes, €9." (en)
 * or "Drei Postfächer, 9 €." (de). Prices are equal digits by decision, so
 * this changes the sign and the format, never a number.
 */
export function euroizeAmounts(text: string, locale: string): string {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(
    USD_AMOUNT,
    (match, leading: string | undefined, before: string | undefined, trailing: string | undefined) => {
      const raw = (leading ?? trailing ?? '').replace(',', '.');
      const cents = Math.round(Number(raw) * 100);
      if (!raw || !Number.isFinite(cents)) return match;
      return `${before ?? ''}${formatMoneyCents(cents, 'eur', locale)}`;
    },
  );
}
