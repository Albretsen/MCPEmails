import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import RichText from './RichText';

/**
 * /for/business, rendered on the server.
 *
 * Same sections, markup and class names as FoundersClient, so the two persona
 * pages look like siblings. The difference is that this one has no state and no
 * handlers, so it does not need 'use client', and that is what lets its copy
 * stay out of the global next-intl bundle (see src/lib/personas/business.mjs).
 * Nav and Footer are the only parts that hydrate.
 *
 * The FAQ is <details>, as on the /connect pages, not the useState accordion
 * the founders page uses: the answers are then in the HTML a crawler receives
 * rather than rendered only after a click.
 *
 * Key order here is render order. Every key below must exist in all five
 * forBusiness.json files; src/lib/personas/business-copy.test.ts pins that.
 */
const PAIN_KEYS = ['coverage', 'sender', 'routine'];
const DOES_KEYS = ['read', 'send', 'schedule', 'organize'];
const DOES_ICONS = { read: 'inbox', send: 'mail', schedule: 'refresh', organize: 'check' };
const SAFETY_KEYS = ['approval', 'stored', 'keys', 'server'];
const SAFETY_ICONS = { approval: 'shield', stored: 'ghost', keys: 'lock', server: 'server' };
const PLAN_KEYS = ['free', 'personal', 'pro'];

export default function BusinessView({ copy }) {
  const { hero, pains, day, does, safety, providers, pricing, faq, ctaBand } = copy;

  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{hero.eyebrow}</div>
          <h1 className="pricing-page-h1">
            {hero.titleLine1}<br />{hero.titleLine2}
          </h1>
          <p className="pricing-page-lead">{hero.lead}</p>
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>
            <a className="btn btn-primary btn-lg" href="/signup">{hero.ctaPrimary}</a>
            <a className="btn btn-secondary btn-lg" href="#day">{hero.ctaSecondary}</a>
          </div>
        </div>
      </section>

      {/* The job: several role addresses, one person */}
      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{pains.eyebrow}</div>
            <h2>{pains.title}</h2>
            <p className="sub">{pains.sub}</p>
          </div>
          <ol className="principle-list">
            {PAIN_KEYS.map((k, i) => (
              <li className="principle" key={k}>
                <div className="p-num">
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{pains.items[k].tag}</span>
                </div>
                <div className="p-body">
                  <h3>{pains.items[k].h}</h3>
                  <p><RichText>{pains.items[k].p}</RichText></p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Real prompts, departmental */}
      <section className="section" id="day" style={{ paddingTop: 64, paddingBottom: 80, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{day.eyebrow}</div>
            <h2 style={{ fontSize: 36 }}>{day.title}</h2>
            <p className="sub">{day.sub}</p>
          </div>
          <ul className="founder-prompts">
            {day.prompts.map((p, i) => (
              <li key={i} className="founder-prompt">
                <span className="founder-prompt-mark" aria-hidden="true">&gt;_</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* What the agent can do across the mailboxes */}
      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{does.eyebrow}</div>
            <h2>{does.title}</h2>
            <p className="sub">{does.sub}</p>
          </div>
          <div className="founder-does-grid">
            {DOES_KEYS.map((k) => (
              <div className="founder-does-card" key={k}>
                <div className="founder-does-icon">
                  <MIcon name={DOES_ICONS[k]} size={20} color="var(--mint-600)" />
                </div>
                <h3>{does.items[k].h}</h3>
                <p>{does.items[k].p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Approval hold and the other server-side limits */}
      <section className="section" id="control" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{safety.eyebrow}</div>
            <h2 style={{ fontSize: 36 }}>{safety.title}</h2>
            <p className="sub">{safety.sub}</p>
          </div>
          <div className="founder-does-grid">
            {SAFETY_KEYS.map((k) => (
              <div className="founder-does-card" key={k}>
                <div className="founder-does-icon">
                  <MIcon name={SAFETY_ICONS[k]} size={20} color="var(--mint-600)" />
                </div>
                <h3>{safety.items[k].h}</h3>
                <p>{safety.items[k].p}</p>
              </div>
            ))}
          </div>
          <p className="how-guide-link">
            <Link href="/security">{safety.link}</Link>
          </p>
        </div>
      </section>

      {/* Connect every mailbox, whoever hosts it */}
      <section className="section principles" id="providers">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{providers.eyebrow}</div>
            <h2>{providers.title}</h2>
            <p className="sub">{providers.sub}</p>
          </div>
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <Link className="btn btn-secondary" href="/connect/imap">{providers.ctaImap}</Link>
            <Link className="btn btn-secondary" href="/connect/gmail">{providers.ctaGmail}</Link>
            <Link className="btn btn-secondary" href="/connect/office365">{providers.ctaMicrosoft}</Link>
            <Link className="btn btn-secondary" href="/connect/ionos">{providers.ctaIonos}</Link>
          </div>
          <p className="how-guide-link">
            <Link href="/docs/providers">{providers.ctaMatrix}</Link>
          </p>
        </div>
      </section>

      {/* Which plan: count the mailboxes */}
      <section className="section" id="plans" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{pricing.eyebrow}</div>
            <h2 style={{ fontSize: 36 }}>{pricing.title}</h2>
            <p className="sub">{pricing.sub}</p>
          </div>
          <div className="founder-does-grid business-plan-grid">
            {PLAN_KEYS.map((k) => (
              <div className="founder-does-card" key={k}>
                <h3>{pricing.items[k].h}</h3>
                <p>{pricing.items[k].p}</p>
              </div>
            ))}
          </div>
          <p className="how-guide-link">
            {pricing.note}{' '}
            <Link href="/pricing">{pricing.cta}</Link>
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="section" id="faq">
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{faq.eyebrow}</div>
            <h2 style={{ fontSize: 36 }}>{faq.title}</h2>
            <p className="sub">{faq.sub}</p>
          </div>
          <div className="connect-faq">
            {faq.items.map((item, i) => (
              <details className="connect-faq-item" key={i} open={i === 0}>
                <summary><h3>{item.q}</h3></summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{ctaBand.title}</h2>
          <p className="pricing-cta-sub">{ctaBand.sub}</p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">{ctaBand.ctaPrimary}</a>
            <Link className="btn btn-on-dark btn-lg" href="/docs">{ctaBand.ctaSecondary}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
