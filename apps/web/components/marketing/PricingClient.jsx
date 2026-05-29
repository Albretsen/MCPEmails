'use client';

import { useState, Fragment } from 'react';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';

/* ─── Plan data ─────────────────────────────────────────────── */
// NOTE: the "Team" tier keeps the internal key `pro` so live Stripe prices
// (keyed by plan id) resolve correctly. Only its display name is "Team".

const PLANS = [
  {
    key: 'free',
    name: 'Free',
    monthly: 0,
    annual: 0,
    per: '/forever',
    featured: false,
    badge: null,
    desc: 'Everything, unlimited. For everyone building with MCP agents.',
    cta: 'Start free',
    ctaHref: '/signup',
    ctaPrimary: false,
  },
  {
    key: 'solo',
    name: 'Solo',
    monthly: 12,
    annual: 10,        // effective monthly when billed yearly ($120/yr)
    per: '/month',
    featured: false,
    badge: null,
    desc: 'For power users running agents around the clock.',
    cta: 'Get Solo',
    ctaHref: '/signup',
    ctaPrimary: false,
  },
  {
    key: 'pro',
    name: 'Team',
    monthly: 49,
    annual: 41,        // effective monthly when billed yearly ($490/yr)
    per: '/month',
    featured: true,
    badge: 'Most popular',
    desc: 'For businesses and teams. Practically limitless.',
    cta: 'Get Team',
    ctaHref: '/signup',
    ctaPrimary: true,
  },
];

/* ─── Comparison table data ─────────────────────────────────── */

const TABLE_SECTIONS = [
  {
    label: 'Usage',
    rows: [
      { feature: 'Connected inboxes',    free: 'Unlimited', solo: 'Unlimited', pro: 'Unlimited' },
      { feature: 'MCP tool calls',       free: 'Unlimited', solo: 'Unlimited', pro: 'Unlimited' },
      { feature: 'API keys',             free: 'Unlimited', solo: 'Unlimited', pro: 'Unlimited' },
      { feature: 'Team members',         free: 'Unlimited', solo: 'Unlimited', pro: 'Unlimited' },
      { feature: 'Burst rate limit',     free: '60 / min',  solo: '300 / min', pro: '1,000 / min' },
    ],
  },
  {
    label: 'Email providers',
    rows: [
      { feature: 'Gmail (OAuth)',                       free: true, solo: true, pro: true },
      { feature: 'Outlook / Microsoft 365 (OAuth)',     free: true, solo: true, pro: true },
      { feature: 'Fastmail (OAuth + app password)',     free: true, solo: true, pro: true },
      { feature: 'iCloud, Yahoo, Zoho, Yandex (app password)', free: true, solo: true, pro: true },
      { feature: 'Any IMAP / SMTP mailbox',             free: true, solo: true, pro: true },
    ],
  },
  {
    label: 'MCP tools',
    rows: [
      { feature: 'list_inboxes',    free: true, solo: true, pro: true },
      { feature: 'list_inbox',      free: true, solo: true, pro: true },
      { feature: 'read_email',      free: true, solo: true, pro: true },
      { feature: 'search_emails',   free: true, solo: true, pro: true },
      { feature: 'send_email',      free: true, solo: true, pro: true },
      { feature: 'reply_to_email',  free: true, solo: true, pro: true },
    ],
  },
  {
    label: 'Analytics & security',
    rows: [
      { feature: 'Usage analytics dashboard',  free: true,      solo: true,       pro: true },
      { feature: 'Analytics history',          free: '7 days',  solo: '90 days',  pro: '1 year' },
      { feature: 'Team roles & workspaces',    free: false,     solo: false,      pro: true },
      { feature: 'SSO (SAML / OIDC)',          free: false,     solo: false,      pro: true },
      { feature: 'Audit log',                  free: false,     solo: false,      pro: true },
    ],
  },
  {
    label: 'Privacy & security',
    rows: [
      { feature: 'Email never stored',              free: true,  solo: true,  pro: true },
      { feature: 'Credentials encrypted at rest',   free: true,  solo: true,  pro: true },
      { feature: 'SOC 2 Type II report on request', free: false, solo: false, pro: true },
    ],
  },
  {
    label: 'Support',
    rows: [
      { feature: 'Community forum',  free: true,  solo: true,  pro: true },
      { feature: 'Email support',    free: false, solo: true,  pro: true },
      { feature: 'Priority support', free: false, solo: false, pro: true },
    ],
  },
];

const FAQ_ITEMS = [
  {
    q: 'Is there really no usage limit?',
    a: 'Correct — connected inboxes, MCP tool calls, API keys, and team members are unlimited on every plan, including Free. The only usage limit is a per-minute fair-use ceiling (60/min on Free, 300/min on Solo, 1,000/min on Team) that protects the platform from abuse. Paid plans exist for higher burst throughput, team features, and support — never to unlock more usage.',
  },
  {
    q: 'What counts as an MCP call?',
    a: 'Each JSON-RPC tool invocation against your /mcp endpoint counts as one call — whether it\'s list_inboxes, list_inbox, read_email, search_emails, send_email, or reply_to_email. Calls are unlimited; they only count toward your plan\'s per-minute fair-use ceiling.',
  },
  {
    q: 'Is my email content stored anywhere?',
    a: 'No. Email bodies, subjects, attachments, and thread content are fetched live from your provider and returned directly to the agent. Nothing is persisted between calls. The only data we store is an encrypted OAuth token or app password so we can authenticate future requests.',
  },
  {
    q: 'What\'s the difference between Solo and Team?',
    a: 'Free already gives everyone unlimited usage. Solo ($12/mo) is for power users who run agents hard — it raises the burst rate limit to 300 requests/minute, extends analytics history to 90 days, and adds email support. Team ($49/mo) is for businesses: a 1,000/minute ceiling, team roles and multiple workspaces, SSO (SAML/OIDC), an audit log, 1-year analytics history, and priority support.',
  },
  {
    q: 'Can I change or cancel my plan?',
    a: 'Yes — upgrade, downgrade, or cancel any time from the billing section of your dashboard. If you cancel a paid plan, you keep access until the end of your billing period, then drop to the Free tier automatically. Since Free is unlimited, you lose only the higher burst limit, team features, and support.',
  },
  {
    q: 'How does the annual discount work?',
    a: 'Paying annually saves you about 17% compared to monthly billing — Solo is $120/year and Team is $490/year. You\'re charged once for 12 months upfront. If you cancel mid-year, we refund the unused whole months.',
  },
  {
    q: 'What email providers are supported?',
    a: 'Gmail and Microsoft 365 / Outlook use OAuth 2.0. Fastmail supports both OAuth and app passwords. iCloud, Yahoo, Zoho, and Yandex connect with an app-specific password, and any other mailbox works through the generic IMAP / SMTP connector.',
  },
  {
    q: 'Is there a refund policy?',
    a: 'If you\'re unsatisfied within 30 days of your first paid invoice, contact us and we\'ll issue a full refund — no questions asked.',
  },
];

/* ─── Sub-components ─────────────────────────────────────────── */

function BillingToggle({ annual, onChange }) {
  return (
    <div className="billing-toggle">
      <button
        className={'billing-opt' + (!annual ? ' active' : '')}
        onClick={() => onChange(false)}
      >
        Monthly
      </button>
      <button
        className={'billing-opt' + (annual ? ' active' : '')}
        onClick={() => onChange(true)}
      >
        Annual
        <span className="billing-save">Save ~17%</span>
      </button>
    </div>
  );
}

/**
 * @param {{ annual: boolean, stripePrices?: import('@/lib/stripe/getPrices').StripePricesMap }} props
 */
function PlanCards({ annual, stripePrices }) {
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

        const perDisplay = liveMonthly === 0 ? plan.per : '/month';

        return (
          <div className={'price' + (plan.featured ? ' featured' : '')} key={plan.key}>
            <div>
              <h4>{plan.name}</h4>
              <div className="num">
                {priceDisplay}
                {perDisplay && <small> {perDisplay}</small>}
              </div>
              {annual && liveMonthly > 0 && (
                <p className="price-annual-note">Billed ${liveAnnualTotal}/year</p>
              )}
              <p className="price-desc">{plan.desc}</p>
            </div>
            <ul>
              {plan.key === 'free' && (
                <>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Unlimited connected inboxes</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Unlimited MCP tool calls</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Unlimited API keys &amp; team members</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Gmail, Outlook, iCloud, Fastmail &amp; any IMAP</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />60 requests / minute</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Community support</li>
                </>
              )}
              {plan.key === 'solo' && (
                <>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Everything in Free, unlimited</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />300 requests / minute (5× burst)</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Full usage analytics (90-day history)</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Gmail, Outlook, iCloud, Fastmail &amp; any IMAP</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Email support</li>
                </>
              )}
              {plan.key === 'pro' && (
                <>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Everything in Solo, unlimited</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />1,000 requests / minute</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Team roles &amp; multiple workspaces</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />SSO (SAML / OIDC) + audit log</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Full usage analytics (1-year history)</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Priority support</li>
                </>
              )}
            </ul>
            <a
              className={'btn btn-lg ' + (plan.ctaPrimary ? 'btn-primary' : 'btn-secondary')}
              href={plan.ctaHref}
              style={{ textAlign: 'center', justifyContent: 'center' }}
            >
              {plan.cta}
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
    return <td className="tbl-dash"><span>—</span></td>;
  }
  return <td className="tbl-val">{value}</td>;
}

function ComparisonTable() {
  return (
    <div className="comparison-wrap">
      <table className="comparison-tbl">
        <thead>
          <tr>
            <th className="feat-col">Feature</th>
            <th>Free</th>
            <th>Solo</th>
            <th className="featured-col">Team</th>
          </tr>
        </thead>
        <tbody>
          {TABLE_SECTIONS.map(section => (
            <Fragment key={section.label}>
              <tr className="tbl-section-head">
                <td colSpan={4}>{section.label}</td>
              </tr>
              {section.rows.map(row => (
                <tr key={row.feature}>
                  <td className="feat-name">{row.feature}</td>
                  <TableCell value={row.free} />
                  <TableCell value={row.solo} />
                  <TableCell value={row.pro} />
                </tr>
              ))}
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

  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">Pricing</div>
          <h1 className="pricing-page-h1">
            Unlimited, free.<br />Upgrade for more power.
          </h1>
          <p className="pricing-page-lead">
            Every plan — including Free — has unlimited inboxes, calls, API keys, and
            team members. Paid plans add higher burst limits, team features, and support.
            Email is never stored, on any plan.
          </p>
          <BillingToggle annual={annual} onChange={setAnnual} />
        </div>
      </section>

      {/* Plan cards */}
      <section className="pricing-page-cards">
        <div className="container">
          <PlanCards annual={annual} stripePrices={stripePrices} />
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 24 }}>
            All plans include: email never stored · credentials encrypted at rest · EU &amp; US hosting
          </p>
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 8 }}>
            Need something custom? <a href="mailto:sales@mcpemails.com">Contact us</a>.
          </p>
        </div>
      </section>

      {/* Comparison table */}
      <section className="section" id="compare" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">Full comparison</div>
            <h2 style={{ fontSize: 36 }}>Everything side by side.</h2>
          </div>
          <ComparisonTable />
        </div>
      </section>

      {/* FAQ */}
      <section className="section" id="faq" style={{ paddingTop: 64, paddingBottom: 80, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">FAQ</div>
            <h2 style={{ fontSize: 36 }}>Common questions.</h2>
          </div>
          <div className="faq-list">
            {FAQ_ITEMS.map(item => (
              <FaqItem key={item.q} q={item.q} a={item.a} />
            ))}
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">Ready to give your agent an inbox?</h2>
          <p className="pricing-cta-sub">
            Start on the Free plan — no credit card required, unlimited from day one.
            Upgrade when you need higher burst limits or team features.
          </p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">Get started free</a>
            <a className="btn btn-on-dark btn-lg" href="/docs">Read the docs</a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
