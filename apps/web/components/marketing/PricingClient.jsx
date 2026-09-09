'use client';

import { useCallback, useEffect, useState, Fragment, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import { createClient } from '@/lib/supabase/client';
import { parseUpgradeIntent, pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { usePricingView } from '@/lib/analytics/use-pricing-view.mjs';

/* ─── Plan data ─────────────────────────────────────────────── */
// The value metric is CONNECTED INBOXES. Free is one inbox, Personal is three
// for one person, Pro is every inbox you own, Team adds people. The action
// ceiling is a silent abuse guard and is deliberately absent from this page
// (see src/lib/stripe/plans.ts).
//
// NOTE: the "Pro" tier keeps the internal key `solo` and "Team" keeps `pro`, so
// live Stripe prices (keyed by plan id) resolve correctly. Only the display
// names changed. `personal` is the one id that matches its own display name.
// User-facing copy (name, desc, cta, features) is read from the `pricing`
// message bundle via `plans.<key>.*`.

const PLANS = [
  {
    key: 'free',
    monthly: 0,
    annual: 0,
    perKey: 'card.perForever',
    featured: false,
    ctaHref: '/signup',
    ctaPrimary: false,
  },
  {
    key: 'personal',
    monthly: 5,
    annual: 4,         // effective monthly when billed yearly ($48/yr)
    perKey: 'card.perMonth',
    featured: false,
    ctaHref: '/signup',
    ctaPrimary: false,
  },
  {
    key: 'solo',
    monthly: 29,
    annual: 23,        // effective monthly when billed yearly ($276/yr)
    perKey: 'card.perMonth',
    featured: true,
    ctaHref: '/signup',
    ctaPrimary: true,
  },
  {
    key: 'pro',
    monthly: 79,
    annual: 63,        // effective monthly when billed yearly ($756/yr)
    perKey: 'card.perMonth',
    featured: false,
    ctaHref: '/signup',
    ctaPrimary: false,
  },
];

/* ─── Comparison table data ─────────────────────────────────── */
// Plan-availability matrix only. Labels (section + feature names) and string
// values are resolved from the message bundle by key.

// Column order is the ladder order: free, personal, solo ("Pro"), pro ("Team").
// EVERY row must carry all four keys. A missing key renders an empty cell
// instead of failing the build, so new rows have to be checked by eye.

const TABLE_SECTIONS = [
  {
    key: 'usage',
    rows: [
      { key: 'inboxes',  free: 'values.oneInbox',  personal: 'values.threeInboxes', solo: 'values.unlimited', pro: 'values.unlimited' },
      { key: 'keys',     free: 'values.unlimited', personal: 'values.unlimited',    solo: 'values.unlimited', pro: 'values.unlimited' },
      // Personal and Pro are deliberately single-seat: sharing inboxes with
      // other people is what Team is for.
      { key: 'members',  free: 'values.ownerOnly', personal: 'values.ownerOnly',     solo: 'values.ownerOnly', pro: 'values.unlimited' },
      { key: 'burst',    free: 'values.burstFree', personal: 'values.burstPersonal', solo: 'values.burstSolo', pro: 'values.burstPro' },
    ],
  },
  {
    key: 'providers',
    rows: [
      { key: 'gmail',       free: true, personal: true, solo: true, pro: true },
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
      { key: 'roles',     free: false,             personal: false,                solo: false,              pro: true },
      { key: 'sso',       free: false,             personal: false,                solo: false,              pro: true },
      { key: 'audit',     free: false,             personal: false,                solo: false,              pro: true },
    ],
  },
  {
    key: 'privacy',
    rows: [
      { key: 'neverStored', free: true,  personal: true,  solo: true,  pro: true },
      { key: 'encrypted',   free: true,  personal: true,  solo: true,  pro: true },
      { key: 'soc2',        free: false, personal: false, solo: false, pro: true },
    ],
  },
  {
    key: 'support',
    rows: [
      { key: 'community', free: true,  personal: true,  solo: true,  pro: true },
      { key: 'email',     free: false, personal: true,  solo: true,  pro: true },
      { key: 'priority',  free: false, personal: false, solo: false, pro: true },
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
 * @param {{ annual: boolean, stripePrices?: import('@/lib/stripe/getPrices').StripePricesMap }} props
 */
function PlanCards({ annual, stripePrices, user, highlightPlan }) {
  const t = useTranslations('pricing');
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
        // Derive live prices from Stripe, falling back to static plan values.
        const liveMonthlyCents = stripePrices?.[plan.key]?.monthlyCents;
        const liveYearlyCents = stripePrices?.[plan.key]?.yearlyCents;

        const liveMonthly =
          liveMonthlyCents != null && liveMonthlyCents > 0
            ? liveMonthlyCents / 100
            : plan.monthly;

        const liveAnnualMonthly =
          liveYearlyCents != null && liveYearlyCents > 0
            ? Math.round(liveYearlyCents / 12 / 100)
            : plan.annual;

        const liveAnnualTotal =
          liveYearlyCents != null && liveYearlyCents > 0
            ? liveYearlyCents / 100
            : plan.annual != null ? plan.annual * 12 : null;

        const priceDisplay =
          liveMonthly === 0
            ? '$0'
            : annual
            ? `$${liveAnnualMonthly}`
            : `$${liveMonthly}`;

        const perDisplay = liveMonthly === 0 ? t(plan.perKey) : t('card.perMonth');
        const features = t.raw(`plans.${plan.key}.features`);

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
              {annual && liveMonthly > 0 && (
                <p className="price-annual-note">{t('card.billedYearly', { total: liveAnnualTotal })}</p>
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
                href={user ? '/dashboard' : plan.ctaHref}
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
                href={pricingUpgradeHref(plan.key, annual, Boolean(user))}
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

function ComparisonTable() {
  const t = useTranslations('pricing');
  // String cell values are stored as message keys (e.g. "values.unlimited");
  // booleans render as check/dash. Translate keys, pass booleans through.
  const cell = (v) => (typeof v === 'string' ? t(`comparison.${v}`) : v);

  return (
    <div className="comparison-wrap">
      <table className="comparison-tbl">
        <thead>
          <tr>
            <th className="feat-col">{t('comparison.featureCol')}</th>
            <th>{t('comparison.free')}</th>
            <th>{t('comparison.personal')}</th>
            <th className="featured-col">{t('comparison.solo')}</th>
            <th>{t('comparison.team')}</th>
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
 * @param {{ stripePrices?: import('@/lib/stripe/getPrices').StripePricesMap }} props
 */
export default function PricingClient({ stripePrices }) {
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
  const faqItems = t.raw('faq.items');

  // Billing funnel. The endpoint ignores anonymous callers, so this records
  // only signed-in users revisiting /pricing, which is the population whose
  // non-conversion is actually diagnostic.
  usePricingView('pricing_page');

  // Marketing pages are CDN-cached and therefore cannot render session state
  // on the server. Resolve it client-side so signed-in visitors still see a
  // clear account affordance without making the public page private.
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
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
            {annual ? t('hero.titleLine2Yearly') : t('hero.titleLine2')}
          </h1>
          <p className="pricing-page-lead">
            {t('hero.lead')}
          </p>
          <BillingToggle annual={annual} onChange={setAnnual} />
        </div>
      </section>

      {/* Plan cards */}
      <section className="pricing-page-cards">
        <div className="container">
          <PlanCards annual={annual} stripePrices={stripePrices} user={user} highlightPlan={highlightPlan} />
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 24 }}>
            {t('cardsFootnote.all')}
          </p>
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 8 }}>
            {t.rich('cardsFootnote.custom', {
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
          <ComparisonTable />
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
            {t('ctaBand.sub')}
          </p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">{t('ctaBand.ctaPrimary')}</a>
            <Link className="btn btn-on-dark btn-lg" href="/docs">{t('ctaBand.ctaSecondary')}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
