/**
 * Customer copy for Business billed per person, shown only while
 * `pricing_switches.business_seat_pricing` is on.
 *
 * WHY A MODULE AND NOT messages/. `pricing` and `home` are marketing
 * namespaces, serialised into every marketing page; this copy is read on the
 * server by the three pages that need it (/pricing, the homepage, and
 * /for/business), and only when the switch is on. With the switch off nothing
 * here is loaded or rendered, so production keeps today's copy byte for byte.
 *
 * NUMBERS. The JSON never writes a Business number. Every amount and count is
 * a placeholder filled here from the price map (the seat amounts that
 * `withBusinessSeatPrices` put on `stripePrices.pro`) and from the constants
 * in plans.ts, so a reprice cannot leave a sentence quoting the old figure.
 * business-seat-copy.test.ts pins that. Amounts are bare ("19", "182,40"):
 * each message writes its own currency sign the way its locale does, and the
 * pages swap it for the euro for an EU visitor, like every other price.
 *
 * LOCALES. en, nb, es, fr, de, pt and ja. zh is frozen (locale-policy.mjs) and
 * renders English.
 */

import en from './business-seat-copy/en.json' with { type: 'json' };
import nb from './business-seat-copy/nb.json' with { type: 'json' };
import es from './business-seat-copy/es.json' with { type: 'json' };
import fr from './business-seat-copy/fr.json' with { type: 'json' };
import de from './business-seat-copy/de.json' with { type: 'json' };
import pt from './business-seat-copy/pt.json' with { type: 'json' };
import ja from './business-seat-copy/ja.json' with { type: 'json' };
import {
  BUSINESS_EXTRA_INBOX_MONTHLY_CENTS,
  BUSINESS_EXTRA_INBOX_YEARLY_CENTS,
  BUSINESS_INCLUDED_INBOXES,
  BUSINESS_MIN_SEATS,
  BUSINESS_PRIVATE_INBOXES_PER_PERSON,
  BUSINESS_SEAT_MONTHLY_CENTS,
  BUSINESS_SEAT_YEARLY_CENTS,
  FREE_ACTION_ALLOWANCE,
} from '@/lib/stripe/plans';
import { formatAmountCents } from '@/lib/stripe/annual-offer';
import type { StripePricesMap } from '@/lib/stripe/getPrices';

export type BusinessSeatCopy = typeof en;

export const BUSINESS_SEAT_COPY_LOCALES = ['en', 'nb', 'es', 'fr', 'de', 'pt', 'ja'] as const;

const RAW: Record<string, BusinessSeatCopy> = { en, nb, es, fr, de, pt, ja };

/** The raw (unfilled) copy for a locale; English for zh and anything unknown. */
export function rawBusinessSeatCopy(locale: string): BusinessSeatCopy {
  return RAW[locale] ?? en;
}

export interface BusinessSeatNumbers {
  /** Per person, per month, in cents. */
  monthlyCents: number;
  /** Per person, per year, in cents. */
  yearlyCents: number;
  /** The fewest people a subscription is billed for. */
  minPeople: number;
}

/**
 * The numbers the copy quotes, from the price map when the seat amounts are
 * on it, else the catalogue. Null when the map is not priced per person,
 * which is how a page knows the switch is off.
 */
export function businessSeatNumbers(prices: StripePricesMap | null | undefined): BusinessSeatNumbers | null {
  const pro = prices?.pro;
  if (!pro?.perPerson) return null;
  return {
    monthlyCents: pro.monthlyCents && pro.monthlyCents > 0 ? pro.monthlyCents : BUSINESS_SEAT_MONTHLY_CENTS,
    yearlyCents: pro.yearlyCents && pro.yearlyCents > 0 ? pro.yearlyCents : BUSINESS_SEAT_YEARLY_CENTS,
    minPeople: pro.perPerson.minPeople ?? BUSINESS_MIN_SEATS,
  };
}

/** Every placeholder value, formatted for the locale. */
export function businessSeatValues(locale: string, numbers: BusinessSeatNumbers): Record<string, string> {
  const amount = (cents: number) => formatAmountCents(cents, locale);
  return {
    price: amount(numbers.monthlyCents),
    yearly: amount(numbers.yearlyCents),
    yearlyMonth: amount(Math.round(numbers.yearlyCents / 12)),
    min: String(numbers.minPeople),
    private: String(BUSINESS_PRIVATE_INBOXES_PER_PERSON),
    included: String(BUSINESS_INCLUDED_INBOXES),
    addon: amount(BUSINESS_EXTRA_INBOX_MONTHLY_CENTS),
    addonYearly: amount(BUSINESS_EXTRA_INBOX_YEARLY_CENTS),
    freeActions: String(FREE_ACTION_ALLOWANCE),
  };
}

/** Replace `{name}` with its value. An unknown name is left as written. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  );
}

function fillDeep<T>(node: T, values: Record<string, string>): T {
  if (typeof node === 'string') return fillPlaceholders(node, values) as T;
  if (Array.isArray(node)) return node.map((child) => fillDeep(child, values)) as T;
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, fillDeep(v, values)]),
    ) as T;
  }
  return node;
}

/**
 * The copy for one locale with every number filled in, or null when the
 * price map is not priced per person (the switch is off, or its read failed).
 */
export function businessSeatCopyFor(
  locale: string,
  prices: StripePricesMap | null | undefined,
): BusinessSeatCopy | null {
  const numbers = businessSeatNumbers(prices);
  if (!numbers) return null;
  return fillDeep(rawBusinessSeatCopy(locale), businessSeatValues(locale, numbers));
}

/** What the pricing page and the homepage hand their client components. */
export interface BusinessSeatPageCopy {
  card: BusinessSeatCopy['card'];
  pricing: BusinessSeatCopy['pricing'];
  home: BusinessSeatCopy['home'];
}

export function businessSeatPageCopy(
  locale: string,
  prices: StripePricesMap | null | undefined,
): BusinessSeatPageCopy | null {
  const copy = businessSeatCopyFor(locale, prices);
  if (!copy) return null;
  return { card: copy.card, pricing: copy.pricing, home: copy.home };
}

/* ─── /for/business ────────────────────────────────────────────────── */

interface FaqItem {
  q: string;
  a: string;
}

/**
 * The /for/business copy with the team story laid over it. The page keeps its
 * meta (title and description are under a snippet test), its operator
 * sections and its provider list; this swaps the hero, adds the `team`
 * section and the Business plan card, and rewrites the answers that quoted
 * the flat price or "members at no extra cost".
 */
export function withBusinessSeatStory<T extends Record<string, unknown>>(
  base: T,
  locale: string,
  numbers: BusinessSeatNumbers,
): T {
  const seat = fillDeep(rawBusinessSeatCopy(locale).forBusiness, businessSeatValues(locale, numbers));
  const b = base as unknown as {
    hero: Record<string, string>;
    pricing: { items: Record<string, { h: string; p: string }> } & Record<string, unknown>;
    faq: { items: FaqItem[] } & Record<string, unknown>;
    ctaBand: Record<string, string>;
  };
  const answers = seat.faq as unknown as Record<string, string | FaqItem[]>;
  const items = b.faq.items.map((item, i) => {
    const a = answers[String(i)];
    return typeof a === 'string' ? { ...item, a } : item;
  });
  return {
    ...base,
    hero: { ...b.hero, ...seat.hero },
    team: seat.team,
    pricing: {
      ...b.pricing,
      sub: seat.pricing.sub,
      note: seat.pricing.note,
      items: { ...b.pricing.items, business: seat.pricing.business },
    },
    faq: { ...b.faq, items: [...items, ...seat.faq.extra] },
    ctaBand: { ...b.ctaBand, sub: seat.ctaBand.sub },
  };
}
