'use client';

import { useState, Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';

/* ─── Plan data ─────────────────────────────────────────────── */
// NOTE: the "Team" tier keeps the internal key `pro` so live Stripe prices
// (keyed by plan id) resolve correctly. Only its display name is "Team".
// User-facing copy (name, desc, cta, features, badge) is read from the
// `pricing` message bundle via `plans.<key>.*`.

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
    key: 'solo',
    monthly: 12,
    annual: 10,        // effective monthly when billed yearly ($120/yr)
    perKey: 'card.perMonth',
    featured: false,
    ctaHref: '/signup',
    ctaPrimary: false,
  },
  {
    key: 'pro',
    monthly: 49,
    annual: 41,        // effective monthly when billed yearly ($490/yr)
    perKey: 'card.perMonth',
    featured: true,
    ctaHref: '/signup',
    ctaPrimary: true,
  },
];

/* ─── Comparison table data ─────────────────────────────────── */
// Plan-availability matrix only. Labels (section + feature names) and string
// values are resolved from the message bundle by key.

const TABLE_SECTIONS = [
  {
    key: 'usage',
    rows: [
      { key: 'inboxes',  free: 'values.unlimited', solo: 'values.unlimited', pro: 'values.unlimited' },
      { key: 'calls',    free: 'values.unlimited', solo: 'values.unlimited', pro: 'values.unlimited' },
      { key: 'keys',     free: 'values.unlimited', solo: 'values.unlimited', pro: 'values.unlimited' },
      { key: 'members',  free: 'values.ownerOnly', solo: 'values.unlimited', pro: 'values.unlimited' },
      { key: 'burst',    free: 'values.burstFree', solo: 'values.burstSolo', pro: 'values.burstPro' },
    ],
  },
  {
    key: 'providers',
    rows: [
      { key: 'gmail',       free: true, solo: true, pro: true },
      { key: 'fastmail',    free: true, solo: true, pro: true },
      { key: 'appPassword', free: true, solo: true, pro: true },
      { key: 'imap',        free: true, solo: true, pro: true },
    ],
  },
  {
    key: 'mcpTools',
    // MCP tool names are not translated; render the raw names verbatim.
    rows: [
      { name: 'inbox_list',     free: true, solo: true, pro: true },
      { name: 'email_read',     free: true, solo: true, pro: true },
      { name: 'email_organize', free: true, solo: true, pro: true },
      { name: 'email_compose',  free: true, solo: true, pro: true },
      { name: 'folder',         free: true, solo: true, pro: true },
      { name: 'draft',          free: true, solo: true, pro: true },
      { name: 'schedule',       free: true, solo: true, pro: true },
      { name: 'contact_search', free: true, solo: true, pro: true },
    ],
  },
  {
    key: 'analytics',
    rows: [
      { key: 'dashboard', free: true,                 solo: true,                pro: true },
      { key: 'history',   free: 'values.history7',    solo: 'values.history90',  pro: 'values.history1y' },
      { key: 'roles',     free: false,                solo: false,               pro: true },
      { key: 'sso',       free: false,                solo: false,               pro: true },
      { key: 'audit',     free: false,                solo: false,               pro: true },
    ],
  },
  {
    key: 'privacy',
    rows: [
      { key: 'neverStored', free: true,  solo: true,  pro: true },
      { key: 'encrypted',   free: true,  solo: true,  pro: true },
      { key: 'soc2',        free: false, solo: false, pro: true },
    ],
  },
  {
    key: 'support',
    rows: [
      { key: 'community', free: true,  solo: true,  pro: true },
      { key: 'email',     free: false, solo: true,  pro: true },
      { key: 'priority',  free: false, solo: false, pro: true },
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
 * @param {{ annual: boolean, stripePrices?: import('@/lib/stripe/getPrices').StripePricesMap }} props
 */
function PlanCards({ annual, stripePrices }) {
  const t = useTranslations('pricing');
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

        return (
          <div className={'price' + (plan.featured ? ' featured' : '')} key={plan.key}>
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
            <a
              className={'btn btn-lg ' + (plan.ctaPrimary ? 'btn-primary' : 'btn-secondary')}
              href={plan.ctaHref}
              style={{ textAlign: 'center', justifyContent: 'center' }}
            >
              {t(`plans.${plan.key}.cta`)}
            </a>
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
            <th>{t('comparison.solo')}</th>
            <th className="featured-col">{t('comparison.team')}</th>
          </tr>
        </thead>
        <tbody>
          {TABLE_SECTIONS.map(section => (
            <Fragment key={section.key}>
              <tr className="tbl-section-head">
                <td colSpan={4}>{t(`comparison.sections.${section.key}.label`)}</td>
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
  const [annual, setAnnual] = useState(false);
  const t = useTranslations('pricing');
  const faqItems = t.raw('faq.items');

  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{t('hero.eyebrow')}</div>
          <h1 className="pricing-page-h1">
            {t('hero.titleLine1')}<br />{t('hero.titleLine2')}
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
          <PlanCards annual={annual} stripePrices={stripePrices} />
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
