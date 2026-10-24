'use client';

import { useCallback, useEffect, useState, Fragment, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import { parseUpgradeIntent, pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { withReadingLang } from '@/i18n/reading-lang.mjs';
import { usePricingView } from '@/lib/analytics/use-pricing-view.mjs';
import { PLANS as CATALOGUE } from '@/lib/stripe/plans';
import { formatAmountCents, formatPriceCents } from '@/lib/stripe/annual-offer';
import { BLACK_WEEK_2026 } from '@/lib/stripe/seasonal-offer';
import {
  seasonalOfferForPlan,
  seasonalOfferValues,
  shouldFetchSeasonalOffers,
} from '@/lib/billing/seasonal-offer-view.mjs';
import ProPriceNotice, { useProPriceNoticeVisible } from '../ProPriceNotice';
import { proPriceNoticeCopy } from '@/lib/stripe/pro-price-notice-copy.mjs';
import { euroizeAmounts, eurCentsFor, formatMoneyCents } from '@/lib/stripe/eur-prices';
import { useDisplayCurrency } from './useDisplayCurrency';

/* ─── Plan data ─────────────────────────────────────────────── */
// The value metric is CONNECTED INBOXES. Free is one inbox, Personal is three
// for one person, Pro is up to 10 for one person running a business, and
// Business includes 10, sells each extra mailbox and adds people. Since
// 2026-09-12 Free also carries a public allowance of 150 email actions a
// calendar month (first 3 days uncounted), stated in the table and the FAQ;
// paid tiers have no monthly cap and their fair-use ceilings stay silent
// (see src/lib/stripe/plans.ts, FREE_ACTION_ALLOWANCE / FREE_ACTION_GRACE_DAYS).
//
// NOTE: the "Pro" tier keeps the internal key `solo` and "Business" keeps `pro`, so
// live Stripe prices (keyed by plan id) resolve correctly. Only the display
// names changed. `personal` is the one id that matches its own display name.
// User-facing copy (name, desc, cta, features) is read from the `pricing`
// message bundle via `plans.<key>.*`.

// Prices are NOT written here. They come from Stripe (`stripePrices`), and
// when that is unavailable from the catalogue in src/lib/stripe/plans.ts, the
// one place a price is defined. This table used to carry its own copy, which
// was still quoting Pro at $29 three weeks after Pro became $15.
const PLANS = [
  {
    key: 'free',
    perKey: 'card.perForever',
    featured: false,
    ctaHref: '/signup',
    ctaPrimary: false,
  },
  {
    key: 'personal',
    perKey: 'card.perMonth',
    featured: false,
    ctaHref: '/signup',
    ctaPrimary: false,
  },
  {
    key: 'solo',
    perKey: 'card.perMonth',
    featured: true,
    ctaHref: '/signup',
    ctaPrimary: true,
  },
  {
    key: 'pro',
    perKey: 'card.perMonth',
    featured: false,
    ctaHref: '/signup',
    ctaPrimary: false,
  },
];

/* ─── Comparison table data ─────────────────────────────────── */
// Plan-availability matrix only. Labels (section + feature names) and string
// values are resolved from the message bundle by key.

// Column order is the ladder order: free, personal, solo ("Pro"), pro ("Business").
// EVERY row must carry all four keys. A missing key renders an empty cell
// instead of failing the build, so new rows have to be checked by eye.

const TABLE_SECTIONS = [
  {
    key: 'usage',
    rows: [
      // Pro is capped at PRO_INBOX_CAP and Business includes
      // BUSINESS_INCLUDED_INBOXES plus a per-mailbox price (src/lib/stripe/plans.ts).
      // Pro workspaces from before the 2026-10 cap keep unlimited; the dashboard
      // says so, this public table quotes what a new customer buys.
      { key: 'inboxes',  free: 'values.oneInbox',  personal: 'values.threeInboxes', solo: 'values.tenMailboxes', pro: 'values.businessMailboxes' },
      // Free's allowance is public and must match FREE_ACTION_ALLOWANCE /
      // FREE_ACTION_GRACE_DAYS in src/lib/stripe/plans.ts. Paid tiers never
      // print a number: they have no monthly cap, subject to fair use.
      { key: 'actions',  free: 'values.actionsFree', personal: 'values.actionsPaid', solo: 'values.actionsPaid', pro: 'values.actionsPaid' },
      { key: 'keys',     free: 'values.unlimited', personal: 'values.unlimited',    solo: 'values.unlimited', pro: 'values.unlimited' },
      // Personal and Pro are deliberately single-seat: other people signing in
      // is what Business is for, at no per-person price. The value is a count,
      // not "Just you": the old wording was true about logins and read as "not
      // for a company", which is wrong about the buyer.
      // src/lib/personas/business-copy.test.ts keeps "Just you" from returning.
      { key: 'members',  free: 'values.oneSeat', personal: 'values.oneSeat',     solo: 'values.oneSeat', pro: 'values.unlimitedPeople' },
      { key: 'burst',    free: 'values.burstFree', personal: 'values.burstPersonal', solo: 'values.burstSolo', pro: 'values.burstPro' },
      // On every tier, and broken out as its own row on purpose. It is an
      // inbox setting (`inboxes.send_review_mode`) with no plan gate anywhere,
      // and a customer asked in 2026-09 whether it was a paid feature because
      // the Personal card used to list it as one.
      { key: 'approvals', free: true, personal: true, solo: true, pro: true },
    ],
  },
  {
    key: 'providers',
    rows: [
      { key: 'gmail',       free: true, personal: true, solo: true, pro: true },
      // Microsoft Graph OAuth. No plan gate: the inbox cap is the only limit,
      // enforced in /auth/outlook/callback like every other connector.
      { key: 'outlook',     free: true, personal: true, solo: true, pro: true },
      { key: 'fastmail',    free: true, personal: true, solo: true, pro: true },
      { key: 'appPassword', free: true, personal: true, solo: true, pro: true },
      { key: 'imap',        free: true, personal: true, solo: true, pro: true },
    ],
  },
  {
    key: 'mcpTools',
    // MCP tool names are not translated; render the raw names verbatim.
    rows: [
      { name: 'inbox_list',     free: true, personal: true, solo: true, pro: true },
      { name: 'email_read',     free: true, personal: true, solo: true, pro: true },
      { name: 'email_organize', free: true, personal: true, solo: true, pro: true },
      { name: 'email_compose',  free: true, personal: true, solo: true, pro: true },
      { name: 'folder',         free: true, personal: true, solo: true, pro: true },
      { name: 'draft',          free: true, personal: true, solo: true, pro: true },
      { name: 'schedule',       free: true, personal: true, solo: true, pro: true },
      { name: 'contact_search', free: true, personal: true, solo: true, pro: true },
    ],
  },
  {
    key: 'analytics',
    rows: [
      { key: 'dashboard', free: true,              personal: true,                 solo: true,               pro: true },
      // Only what Business really does today. No SSO, audit-log or priority
      // support rows: none of those exist on any plan.
      { key: 'roles',          free: false, personal: false, solo: false, pro: true },
      { key: 'adminApprovals', free: false, personal: false, solo: false, pro: true },
      { key: 'workspaces',     free: false, personal: false, solo: false, pro: true },
      // The ONLY analytics difference between the tiers. The dashboard itself
      // is on every plan, so listing "usage analytics" as a paid feature was
      // the claim this row replaces. Values mirror `analyticsRetentionDays` in
      // src/lib/stripe/plans.ts, enforced via src/lib/analytics/retention.ts.
      { key: 'history',   free: 'values.history30', personal: 'values.history90',   solo: 'values.history2y', pro: 'values.history2y' },
    ],
  },
  {
    key: 'privacy',
    rows: [
      { key: 'neverStored', free: true,  personal: true,  solo: true,  pro: true },
      { key: 'encrypted',   free: true,  personal: true,  solo: true,  pro: true },
    ],
  },
  {
    key: 'support',
    rows: [
      { key: 'community', free: true,  personal: true,  solo: true,  pro: true },
      { key: 'email',     free: false, personal: true,  solo: true,  pro: true },
    ],
  },
];

/* ─── Sub-components ─────────────────────────────────────────── */

function BillingToggle({ annual, onChange }) {
  const t = useTranslations('pricing');
  return (
    <div className="billing-toggle">
      <button
        className={'billing-opt' + (!annual ? ' active' : '')}
        onClick={() => onChange(false)}
      >
        {t('billing.monthly')}
      </button>
      <button
        className={'billing-opt' + (annual ? ' active' : '')}
        onClick={() => onChange(true)}
      >
        {t('billing.annual')}
        <span className="billing-save">{t('billing.save')}</span>
      </button>
    </div>
  );
}

/**
 * Reads `?plan=` and `?interval=` off the URL and hands the pair to the page.
 * Renders nothing.
 *
 * WHY A SEPARATE, NULL-RENDERING COMPONENT. useSearchParams opts its subtree
 * out of static rendering, and the caller wraps this in a Suspense boundary so
 * the opt-out stops here. Reading the params from the page component instead
 * would have cost the whole marketing page its prerendered HTML, which is the
 * asset this page's entire SEO position is made of. As a leaf that renders
 * null, the boundary's fallback is nothing and the surrounding HTML is
 * unchanged.
 *
 * WHY AN EFFECT AND NOT AN INITIAL STATE. The prerendered HTML necessarily
 * shows the default (annual, nothing highlighted). Seeding state from the URL
 * during the first client render would therefore disagree with that HTML and
 * fail hydration. Applying it just after is the same shape the page already
 * uses for the signed-in Nav, and lands within a frame of hydration.
 *
 * parseUpgradeIntent is the allowlist the checkout route and the paywall links
 * both use, so an unknown plan, a misspelt interval, a stale link or a
 * hand-typed query string produces no intent at all and the page keeps exactly
 * today's behaviour. A bad query string must never be able to break /pricing.
 */
function UpgradeIntentReader({ onIntent }) {
  const params = useSearchParams();
  const plan = params.get('plan');
  const interval = params.get('interval');
  useEffect(() => {
    const intent = parseUpgradeIntent(plan, interval);
    if (intent) onIntent(intent);
  }, [plan, interval, onIntent]);
  return null;
}

/**
 * The live seasonal first-year offers (Black Week 2026), or null.
 *
 * WHY AFTER MOUNT. This page is prerendered and CDN cached, and its HTML must
 * not change for the offer: the titles, meta description and JSON-LD stay
 * exactly what crawlers already read. So the offer is fetched from
 * /api/seasonal-offer once the page is in the browser, and it switches on and
 * off at the window boundaries with no deploy and no revalidation of the page.
 * Outside a margin around the window no request is made at all. The server
 * render and the first client render both show no offer, so hydration agrees.
 *
 * A tab left open past the end drops the line at `endsAt` rather than at the
 * next reload.
 */
function useSeasonalOffers() {
  const [offers, setOffers] = useState(null);
  useEffect(() => {
    if (!shouldFetchSeasonalOffers(BLACK_WEEK_2026, Date.now(), process.env.NODE_ENV)) return undefined;
    let cancelled = false;
    let timer = null;
    fetch('/api/seasonal-offer')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.offers || typeof data.offers !== 'object') return;
        setOffers(data.offers);
        const ends = Object.values(data.offers)
          .map((o) => Date.parse(o?.endsAt))
          .filter(Number.isFinite);
        const wait = ends.length ? Math.min(...ends) + 1000 - Date.now() : -1;
        if (wait > 0 && wait < 2 ** 31 - 1) {
          timer = setTimeout(() => { if (!cancelled) setOffers({}); }, wait);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return offers;
}

/**
 * The Black Week line under an annual price: the first-year price, the renewal
 * price in the same sentence, the computed saving, and the fixed end date.
 * Every number comes from the offer object. Renders nothing without one.
 */
function SeasonalOfferLine({ offer, planKey }) {
  const t = useTranslations('pricing');
  const locale = useLocale();
  const values = seasonalOfferValues(offer, locale);
  if (!values) return null;
  return (
    <div className="price-seasonal" data-seasonal-offer={planKey}>
      <p>{t('seasonal.line', values)}</p>
      <p className="price-seasonal-ends">{t('seasonal.ends', { date: values.date, time: values.time })}</p>
    </div>
  );
}

/**
 * @param {{ annual: boolean, stripePrices?: import('@/lib/stripe/getPrices').StripePricesMap }} props
 */
function PlanCards({ annual, stripePrices, user, highlightPlan, currency = 'usd', seasonalOffers = null }) {
  const t = useTranslations('pricing');
  const locale = useLocale();
  // EUR (an EU visitor, STRIPE_EUR_PRICES on): same digits, euro sign in the
  // reader's format, VAT included. USD keeps today's rendering exactly.
  const eur = currency === 'eur';
  const money = (text) => (eur ? euroizeAmounts(text, locale) : text);
  // No entitlement is read here any more. The Personal CTA used to become a
  // non-interactive status line for a visitor holding `unlimited_inboxes`,
  // matching a 409 in checkout-core. Both are gone: the grant lifts only
  // maxInboxes, it survives onto a paid plan, and Personal raises the action
  // ceiling, the burst rate, the billing portal and the support tier, so it is
  // an upgrade for that cohort. See the offeredPlans note in
  // dashboard/Pages.jsx before reinstating either half.
  return (
    <div className="price-grid">
      {PLANS.map(plan => {
        // Derive live prices from Stripe, falling back to the catalogue.
        const liveMonthlyCents = stripePrices?.[plan.key]?.monthlyCents;
        const liveYearlyCents = stripePrices?.[plan.key]?.yearlyCents;

        const monthlyCents =
          liveMonthlyCents != null && liveMonthlyCents > 0
            ? liveMonthlyCents
            : CATALOGUE[plan.key].monthlyPriceCents;

        const yearlyCents =
          liveYearlyCents != null && liveYearlyCents > 0
            ? liveYearlyCents
            : CATALOGUE[plan.key].yearlyPriceCents;

        const liveMonthly = monthlyCents / 100;

        // Formatted, never rounded to whole dollars: Personal's $86.40 a year
        // is $7.20 a month, and Math.round would print a $7 nobody is charged.
        let priceDisplay;
        if (eur) {
          // Stripe's EUR currency option, else the same digits as USD.
          const eurMonthly = eurCentsFor(stripePrices?.[plan.key]?.eurMonthlyCents, monthlyCents);
          const eurYearly = eurCentsFor(stripePrices?.[plan.key]?.eurYearlyCents, yearlyCents);
          priceDisplay =
            monthlyCents === 0
              ? formatMoneyCents(0, 'eur', locale)
              : annual && eurYearly
              ? formatMoneyCents(Math.round(eurYearly / 12), 'eur', locale)
              : formatMoneyCents(eurMonthly, 'eur', locale);
        } else {
          priceDisplay =
            monthlyCents === 0
              ? '$0'
              : annual && yearlyCents
              ? formatPriceCents(Math.round(yearlyCents / 12))
              : formatPriceCents(monthlyCents);
        }

        // The message writes its own currency sign, so it gets the bare amount
        // (and `money` swaps that sign for the euro when EUR is shown).
        const eurYearlyTotal = eur ? eurCentsFor(stripePrices?.[plan.key]?.eurYearlyCents, yearlyCents) : null;
        const annualTotalCents = eur ? eurYearlyTotal : yearlyCents;
        const liveAnnualTotal = annualTotalCents ? formatAmountCents(annualTotalCents, locale) : null;

        const perDisplay = liveMonthly === 0 ? t(plan.perKey) : t('card.perMonth');
        // Set only on Business, only while the founder offer is open.
        const founder = plan.key === 'pro' ? stripePrices?.pro?.founder ?? null : null;
        const features = t.raw(`plans.${plan.key}.features`).map(money);

        // The card the visitor was quoted at an in-product paywall, if they
        // arrived from one. It gets the ring .featured already uses and NOT the
        // "Most popular" badge, because those are two different claims: one is
        // about what other people buy, this one is "here is the plan you were
        // just offered".
        const chosen = plan.key === highlightPlan;
        // One primary button at a time. Absent an intent this is the featured
        // plan, as it has always been; with an intent the chosen card owns the
        // primary action and everything else steps down, so the page answers
        // the question the visitor actually arrived with rather than re-opening
        // the one the marketing page likes to ask.
        const ctaPrimary = highlightPlan ? chosen : plan.ctaPrimary;

        return (
          <div
            className={'price' + (plan.featured ? ' featured' : '') + (chosen ? ' price-chosen' : '')}
            key={plan.key}
          >
            <div>
              <h4>{t(`plans.${plan.key}.name`)}</h4>
              <div className="num">
                {priceDisplay}
                {perDisplay && <small> {perDisplay}</small>}
              </div>
              {eur && liveMonthly > 0 && (
                <p className="price-annual-note">{t('card.inclVat')}</p>
              )}
              {annual && liveMonthly > 0 && (
                <p className="price-annual-note">{money(t('card.billedYearly', { total: liveAnnualTotal }))}</p>
              )}
              {/* Annual Personal and Pro only, inside the window only.
                  Business and monthly never get one: the offer map has no
                  entry for them, and the monthly view does not ask. */}
              {annual && seasonalOffers && (
                <SeasonalOfferLine offer={seasonalOfferForPlan(seasonalOffers, plan.key)} planKey={plan.key} />
              )}
              {/* The Business founder price, only while it is open. The page
                  then prices the card from the founder pair, so the amount
                  here is the amount checkout charges. Plain text: no badge,
                  no strike-through, no colour change as places go. */}
              {founder && (
                <>
                  <p className="price-annual-note" data-founder-line="">
                    {money(
                      t('founder.line', {
                        price: formatAmountCents(founder.monthlyCents, locale),
                        addon: formatAmountCents(founder.addonMonthlyCents, locale),
                        total: founder.placesTotal,
                      }),
                    )}
                  </p>
                  <p className="price-annual-note" data-founder-places="">
                    {t('founder.places', { left: founder.placesLeft, total: founder.placesTotal })}
                  </p>
                </>
              )}
              <p className="price-desc">{t(`plans.${plan.key}.desc`)}</p>
            </div>
            <ul>
              {features.map((f) => (
                <li key={f}><MIcon name="check" size={14} color="var(--mint-600)" />{f}</li>
              ))}
            </ul>
            {plan.key === 'free' ? (
              <a
                className={'btn btn-lg ' + (ctaPrimary ? 'btn-primary' : 'btn-secondary')}
                href={user ? '/dashboard' : withReadingLang(plan.ctaHref, locale)}
                style={{ textAlign: 'center', justifyContent: 'center' }}
              >
                {t(`plans.${plan.key}.cta`)}
              </a>
            ) : (
              /* A paid CTA points straight at GET /api/stripe/checkout/start,
                 which authenticates and 303s to Stripe in one request. It used
                 to point at /dashboard/settings?upgrade=, which server-rendered
                 and hydrated the entire dashboard before a client effect could
                 begin checkout. Keep this a plain <a>: a next/link <Link> would
                 prefetch the checkout route. */
              <a
                className={'btn btn-lg ' + (ctaPrimary ? 'btn-primary' : 'btn-secondary')}
                href={withReadingLang(pricingUpgradeHref(plan.key, annual, Boolean(user), locale), locale)}
                style={{ textAlign: 'center', justifyContent: 'center' }}
              >
                {t(`plans.${plan.key}.cta`)}
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TableCell({ value }) {
  if (value === true) {
    return (
      <td className="tbl-check">
        <MIcon name="check" size={16} color="var(--mint-600)" />
      </td>
    );
  }
  if (value === false) {
    return <td className="tbl-dash"><span>–</span></td>;
  }
  return <td className="tbl-val">{value}</td>;
}

function ComparisonTable({ currency = 'usd' }) {
  const t = useTranslations('pricing');
  const locale = useLocale();
  // String cell values are stored as message keys (e.g. "values.unlimited");
  // booleans render as check/dash. Translate keys, pass booleans through.
  // "then $3 a month each" follows the visitor's currency like the cards do.
  const cell = (v) => {
    if (typeof v !== 'string') return v;
    const text = t(`comparison.${v}`);
    return currency === 'eur' ? euroizeAmounts(text, locale) : text;
  };

  return (
    <div className="comparison-wrap">
      <table className="comparison-tbl">
        <thead>
          <tr>
            <th className="feat-col">{t('comparison.featureCol')}</th>
            <th>{t('comparison.free')}</th>
            <th>{t('comparison.personal')}</th>
            <th className="featured-col">{t('comparison.solo')}</th>
            <th>{t('comparison.business')}</th>
          </tr>
        </thead>
        <tbody>
          {TABLE_SECTIONS.map(section => (
            <Fragment key={section.key}>
              <tr className="tbl-section-head">
                <td colSpan={5}>{t(`comparison.sections.${section.key}.label`)}</td>
              </tr>
              {section.rows.map(row => {
                // MCP tool rows carry a raw `name`; all others reference a
                // translated feature label by `key`.
                const featureLabel = row.name
                  ? row.name
                  : t(`comparison.sections.${section.key}.rows.${row.key}`);
                return (
                  <tr key={row.name || row.key}>
                    <td className="feat-name">{featureLabel}</td>
                    <TableCell value={cell(row.free)} />
                    <TableCell value={cell(row.personal)} />
                    <TableCell value={cell(row.solo)} />
                    <TableCell value={cell(row.pro)} />
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={'faq-item' + (open ? ' open' : '')}>
      <button className="faq-q" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>{q}</span>
        <span className="faq-chevron">
          <MIcon name="arrow" size={14} color="var(--fg-3)" />
        </span>
      </button>
      {open && <div className="faq-a">{a}</div>}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────── */

/**
 * @param {{
 *   stripePrices?: import('@/lib/stripe/getPrices').StripePricesMap,
 *   eurEnabled?: boolean,
 * }} props
 *
 * `eurEnabled` is STRIPE_EUR_PRICES as the server read it. Off (the default),
 * the page never asks for the visitor's country and renders USD exactly as
 * before. On, an EU visitor sees the same digits in EUR with "incl. VAT".
 */
export default function PricingClient({ stripePrices, eurEnabled = false }) {
  // Annual is the default selection, not just an available option. Which
  // interval is preselected swings the annual mix far more than the size of
  // the discount does, and annual prepay is the cheapest working capital a
  // bootstrapped product has. Monthly stays one click away.
  //
  // That default holds for everyone who arrives without an explicit interval,
  // which is every visitor from search, the nav and every marketing link. Only
  // an in-product paywall handoff (?interval=month) moves it, and only because
  // that visitor has ALREADY been quoted a monthly number: the paywall
  // deliberately preselects monthly so a $5 gesture never quietly becomes a $48
  // one, and this page undoing that decision one click later showed the same
  // person two prices for the same plan minutes apart.
  const [annual, setAnnual] = useState(true);
  const [user, setUser] = useState(null);
  // The plan an inbound paywall link named, or null for ordinary traffic.
  const [highlightPlan, setHighlightPlan] = useState(null);
  // Stable identity so the reader's effect runs on a URL change and nothing
  // else. Both halves of the intent are applied together because they arrive
  // together: the offer is a plan AT an interval, and honouring half of it
  // would be its own quiet contradiction.
  const applyIntent = useCallback(({ planId, interval }) => {
    setAnnual(interval === 'year');
    setHighlightPlan(planId);
  }, []);
  const t = useTranslations('pricing');
  const locale = useLocale();
  const currency = useDisplayCurrency(eurEnabled);
  // Prices inside sentences follow the cards: the same digits, in EUR, for an
  // EU visitor while the switch is on. Identity for everyone else.
  const money = (text) => (currency === 'eur' ? euroizeAmounts(text, locale) : text);
  // The dated Pro price question joins the FAQ only while the notice above
  // the cards is up, so the two can never disagree about whether it applies.
  const proPriceNotice = useProPriceNoticeVisible();
  const rawFaqItems = proPriceNotice
    ? [proPriceNoticeCopy(locale).faq, ...t.raw('faq.items')]
    : t.raw('faq.items');
  const faqItems =
    currency === 'eur'
      ? rawFaqItems.map((item) => ({ ...item, a: money(item.a) }))
      : rawFaqItems;

  // Billing funnel. The endpoint ignores anonymous callers, so this records
  // only signed-in users revisiting /pricing, which is the population whose
  // non-conversion is actually diagnostic.
  usePricingView('pricing_page');

  // Black Week 2026, fetched after mount (see useSeasonalOffers).
  const seasonalOffers = useSeasonalOffers();

  // Marketing pages are CDN-cached and therefore cannot render session state
  // on the server. Resolve it client-side so signed-in visitors still see a
  // clear account affordance without making the public page private.
  //
  // The Supabase browser client is loaded on demand, not imported at the top:
  // it is only needed for this one check, and a static import put supabase-js
  // (about 67 KB gzipped) on the page's first load for every visitor.
  useEffect(() => {
    let cancelled = false;
    let subscription = null;
    import('@/lib/supabase/client').then(({ createClient }) => {
      if (cancelled) return;
      const supabase = createClient();
      supabase.auth.getUser().then(({ data }) => {
        if (!cancelled) setUser(data.user ?? null);
      });
      ({ data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        setUser(session?.user ?? null);
      }));
    });
    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, []);

  return (
    <div>
      {/* Suspense is required, not decorative: useSearchParams suspends during
          prerender, and this boundary is what keeps that confined to a leaf
          that renders nothing, leaving the rest of the page statically
          generated and CDN cacheable. The fallback is null because the reader
          has no output of its own. */}
      <Suspense fallback={null}>
        <UpgradeIntentReader onIntent={applyIntent} />
      </Suspense>
      <Nav user={user} />

      {/* Hero */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{t('hero.eyebrow')}</div>
          {/* The second line has to name the price the Personal card is
              actually showing. The toggle defaults to annual, so an
              unconditional "$5" headline sat directly above a $4 card. Both
              strings keep the same short declarative shape, and the yearly one
              quotes the annual total (matching the card's "Billed $48/year")
              rather than a per-month figure stripped of its commitment. */}
          <h1 className="pricing-page-h1">
            {t('hero.titleLine1')}<br />
            {money(annual ? t('hero.titleLine2Yearly') : t('hero.titleLine2'))}
          </h1>
          <p className="pricing-page-lead">
            {money(t('hero.lead'))}
          </p>
          <BillingToggle annual={annual} onChange={setAnnual} />
        </div>
      </section>

      {/* Plan cards */}
      <section className="pricing-page-cards">
        <div className="container">
          <ProPriceNotice
            locale={locale}
            where="pricing"
            className="pricing-footnote"
            style={{ textAlign: 'center', margin: '0 auto 24px', maxWidth: 720, color: 'var(--fg-2)' }}
          />
          <PlanCards annual={annual} stripePrices={stripePrices} user={user} highlightPlan={highlightPlan} currency={currency} seasonalOffers={seasonalOffers} />
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 24 }}>
            {t('cardsFootnote.all')}
          </p>
          {/* A company reading these cards has to find out that Pro is the
              plan for one person running several company mailboxes. The FAQ
              says so too; this is the line people see. */}
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 8 }}>
            {t.rich('cardsFootnote.business', {
              business: (chunks) => <Link href="/for/business">{chunks}</Link>,
            })}
          </p>
          {/* Enterprise is a conversation, not a fifth card: a DPA, invoice
              billing and Microsoft 365 admin help, all by email. */}
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 16 }}>
            <strong>{t('enterprise.title')}</strong>{' '}
            {t.rich('enterprise.body', {
              contact: (chunks) => <a href="mailto:hello@mcpemails.com">{chunks}</a>,
            })}
          </p>
        </div>
      </section>

      {/* Comparison table */}
      <section className="section" id="compare" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{t('comparison.eyebrow')}</div>
            <h2 style={{ fontSize: 36 }}>{t('comparison.title')}</h2>
          </div>
          <ComparisonTable currency={currency} />
        </div>
      </section>

      {/* FAQ */}
      <section className="section" id="faq" style={{ paddingTop: 64, paddingBottom: 80, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{t('faq.eyebrow')}</div>
            <h2 style={{ fontSize: 36 }}>{t('faq.title')}</h2>
          </div>
          <div className="faq-list">
            {faqItems.map(item => (
              <FaqItem key={item.q} q={item.q} a={item.a} />
            ))}
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{t('ctaBand.title')}</h2>
          <p className="pricing-cta-sub">
            {money(stripePrices?.pro?.founder ? t('ctaBand.subFounder') : t('ctaBand.sub'))}
          </p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href={withReadingLang('/signup', locale)}>{t('ctaBand.ctaPrimary')}</a>
            <Link className="btn btn-on-dark btn-lg" href="/docs">{t('ctaBand.ctaSecondary')}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
