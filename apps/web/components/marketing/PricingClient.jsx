'use client';

import { useState } from 'react';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';

/* ─── Plan data ─────────────────────────────────────────────── */

const PLANS = [
  {
    key: 'free',
    name: 'Free',
    monthly: 0,
    annual: 0,
    per: '/forever',
    featured: false,
    badge: null,
    desc: 'For personal projects and experimenting with MCP agents.',
    cta: 'Start free',
    ctaHref: '/signup',
    ctaPrimary: false,
  },
  {
    key: 'solo',
    name: 'Solo',
    monthly: 9,
    annual: 7,
    per: '/month',
    featured: false,
    badge: null,
    desc: 'For solo developers who want their agent working the inbox daily.',
    cta: 'Start free trial',
    ctaHref: '/signup',
    ctaPrimary: false,
  },
  {
    key: 'pro',
    name: 'Pro',
    monthly: 29,
    annual: 23,
    per: '/month',
    featured: true,
    badge: 'Most popular',
    desc: 'For teams shipping agents that work the inbox every day.',
    cta: 'Start free trial',
    ctaHref: '/signup',
    ctaPrimary: true,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    monthly: null,
    annual: null,
    per: '',
    featured: false,
    badge: null,
    desc: 'For organisations needing unlimited scale and compliance guarantees.',
    cta: 'Talk to sales',
    ctaHref: 'mailto:sales@mcpemails.com',
    ctaPrimary: false,
  },
];

/* ─── Comparison table data ─────────────────────────────────── */

const TABLE_SECTIONS = [
  {
    label: 'Usage',
    rows: [
      { feature: 'Connected inboxes',    free: '1',     solo: '3',      pro: '10',      enterprise: 'Unlimited' },
      { feature: 'MCP calls / month',    free: '500',   solo: '3,000',  pro: '20,000',  enterprise: 'Custom'    },
      { feature: 'Daily burst cap',      free: '100',   solo: '500',    pro: '2,000',   enterprise: 'Custom'    },
      { feature: 'API keys',             free: '1',     solo: '3',      pro: '10',      enterprise: 'Unlimited' },
    ],
  },
  {
    label: 'Email providers',
    rows: [
      { feature: 'Gmail (OAuth)',                       free: true, solo: true, pro: true, enterprise: true },
      { feature: 'Outlook / Microsoft 365 (OAuth)',     free: true, solo: true, pro: true, enterprise: true },
      { feature: 'Fastmail (OAuth + app password)',     free: true, solo: true, pro: true, enterprise: true },
      { feature: 'Generic IMAP / SMTP',                 free: true, solo: true, pro: true, enterprise: true },
    ],
  },
  {
    label: 'MCP tools',
    rows: [
      { feature: 'list_inboxes',    free: true, solo: true, pro: true, enterprise: true },
      { feature: 'list_inbox',      free: true, solo: true, pro: true, enterprise: true },
      { feature: 'read_email',      free: true, solo: true, pro: true, enterprise: true },
      { feature: 'search_emails',   free: true, solo: true, pro: true, enterprise: true },
      { feature: 'send_email',      free: true, solo: true, pro: true, enterprise: true },
      { feature: 'reply_to_email',  free: true, solo: true, pro: true, enterprise: true },
    ],
  },
  {
    label: 'Analytics & security',
    rows: [
      { feature: 'Usage analytics dashboard',           free: false, solo: false, pro: true,  enterprise: true },
      { feature: 'Audit log',                           free: false, solo: false, pro: false, enterprise: true },
      { feature: 'SSO (SAML / OIDC)',                   free: false, solo: false, pro: false, enterprise: true },
      { feature: 'Custom data residency (EU / US)',     free: false, solo: false, pro: false, enterprise: true },
    ],
  },
  {
    label: 'Privacy & security',
    rows: [
      { feature: 'Email never stored',              free: true,  solo: true,  pro: true,  enterprise: true  },
      { feature: 'Credentials encrypted at rest',   free: true,  solo: true,  pro: true,  enterprise: true  },
      { feature: 'SOC 2 Type II report on request', free: false, solo: false, pro: false, enterprise: true  },
    ],
  },
  {
    label: 'Support',
    rows: [
      { feature: 'Community forum',           free: true,  solo: true,  pro: true,  enterprise: true  },
      { feature: 'Email support',             free: false, solo: true,  pro: true,  enterprise: true  },
      { feature: 'Priority Slack channel',    free: false, solo: false, pro: false, enterprise: true  },
      { feature: 'Dedicated account manager', free: false, solo: false, pro: false, enterprise: true  },
      { feature: 'Custom SLA',                free: false, solo: false, pro: false, enterprise: true  },
    ],
  },
];

const FAQ_ITEMS = [
  {
    q: 'What counts as an MCP call?',
    a: 'Each JSON-RPC tool invocation against your /mcp endpoint counts as one call — whether it\'s list_inboxes, list_inbox, read_email, search_emails, send_email, or reply_to_email. Calls that return an error still count toward your quota.',
  },
  {
    q: 'Is my email content stored anywhere?',
    a: 'No. Email bodies, subjects, attachments, and thread content are fetched live from your provider and returned directly to the agent. Nothing is persisted between calls. The only data we store is an encrypted OAuth token or app password so we can authenticate future requests.',
  },
  {
    q: 'Can I change or cancel my plan?',
    a: 'Yes — upgrade, downgrade, or cancel any time from the billing section of your dashboard. If you cancel a paid plan, you keep access until the end of your billing period, then drop to the Free tier automatically.',
  },
  {
    q: 'How does the annual discount work?',
    a: 'Paying annually saves you 20% compared to monthly billing. You\'re charged once for 12 months upfront. If you cancel mid-year, we refund the unused whole months.',
  },
  {
    q: 'What email providers are supported?',
    a: 'Gmail and Microsoft 365 / Outlook use OAuth 2.0. Fastmail supports both OAuth and app passwords. Any IMAP/SMTP provider (iCloud, Proton Bridge, self-hosted, etc.) can be connected with an app password.',
  },
  {
    q: 'What\'s the difference between Solo and Pro?',
    a: 'Solo is built for individual developers: 3 inboxes, 3,000 calls / month, 500 calls / day burst, and email support — all at $9 / month. Pro adds 10 inboxes, 20,000 calls / month, a 2,000 / day burst cap, and a usage analytics dashboard for teams that depend on email automation daily.',
  },
  {
    q: 'Do you offer a free trial?',
    a: 'Yes — both the Solo and Pro plans come with a 14-day free trial. No credit card required to start. If you decide it\'s not for you, simply let the trial expire and you\'ll move to the Free tier automatically.',
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
        <span className="billing-save">Save 20%</span>
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
        // Derive live prices from Stripe, falling back to static plan values
        const liveMonthlyCents = stripePrices?.[plan.key]?.monthlyCents;
        const liveYearlyCents = stripePrices?.[plan.key]?.yearlyCents;

        const liveMonthly =
          liveMonthlyCents != null && liveMonthlyCents > 0
            ? liveMonthlyCents / 100
            : plan.monthly;

        const liveAnnualMonthly =
          liveYearlyCents != null
            ? Math.round(liveYearlyCents / 12)
            : plan.annual;

        const liveAnnualTotal =
          liveYearlyCents != null
            ? liveYearlyCents / 100
            : plan.annual != null ? plan.annual * 12 : null;

        const priceDisplay =
          liveMonthly === null
            ? 'Custom'
            : liveMonthly === 0
            ? '$0'
            : annual
            ? `$${liveAnnualMonthly}`
            : `$${liveMonthly}`;

        const perDisplay =
          liveMonthly === null || liveMonthly === 0 ? plan.per : '/month';

        return (
          <div className={'price' + (plan.featured ? ' featured' : '')} key={plan.key}>
            <div>
              <h4>{plan.name}</h4>
              <div className="num">
                {priceDisplay}
                {perDisplay && <small> {perDisplay}</small>}
              </div>
              {annual && liveMonthly !== null && liveMonthly > 0 && (
                <p className="price-annual-note">Billed ${liveAnnualTotal}/year</p>
              )}
              <p className="price-desc">{plan.desc}</p>
            </div>
            <ul>
              {plan.key === 'free' && (
                <>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />1 connected inbox</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />500 MCP calls / month</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />100 calls / day burst cap</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Gmail, Outlook, Fastmail, IMAP</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />1 API key</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Community support</li>
                </>
              )}
              {plan.key === 'solo' && (
                <>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />3 connected inboxes</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />3,000 MCP calls / month</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />500 calls / day burst cap</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Gmail, Outlook, Fastmail, IMAP</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />3 API keys</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />14-day free trial</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Email support</li>
                </>
              )}
              {plan.key === 'pro' && (
                <>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />10 connected inboxes</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />20,000 MCP calls / month</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />2,000 calls / day burst cap</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Gmail, Outlook, Fastmail, IMAP</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />10 API keys</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Usage analytics</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />14-day free trial</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Email support</li>
                </>
              )}
              {plan.key === 'enterprise' && (
                <>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Unlimited inboxes</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Custom MCP call volume</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Gmail, Outlook, Fastmail, IMAP</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Unlimited API keys</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Audit log + SSO</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Dedicated Slack support</li>
                  <li><MIcon name="check" size={14} color="var(--mint-600)" />Custom SLA</li>
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
            <th className="featured-col">Pro</th>
            <th>Enterprise</th>
          </tr>
        </thead>
        <tbody>
          {TABLE_SECTIONS.map(section => (
            <>
              <tr className="tbl-section-head" key={'section-' + section.label}>
                <td colSpan={5}>{section.label}</td>
              </tr>
              {section.rows.map(row => (
                <tr key={row.feature}>
                  <td className="feat-name">{row.feature}</td>
                  <TableCell value={row.free} />
                  <TableCell value={row.solo} />
                  <TableCell value={row.pro} />
                  <TableCell value={row.enterprise} />
                </tr>
              ))}
            </>
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
            Simple pricing.<br />No surprises.
          </h1>
          <p className="pricing-page-lead">
            Pay for the MCP calls your agent makes. Switch plans any time.
            Email is never stored — on any plan.
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
            Start on the Free plan — no credit card required. Upgrade when your agent needs more calls.
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
