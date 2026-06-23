'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';

const RICH = {
  code: (chunks) => <code className="t-code-inline">{chunks}</code>,
  b: (chunks) => <strong>{chunks}</strong>,
};

/* Accordion FAQ item, mirroring the /pricing + compare faq-* markup. */
function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={'faq-item' + (open ? ' open' : '')}>
      <button className="faq-q" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{q}</span>
        <span className="faq-chevron">
          <MIcon name="arrow" size={14} color="var(--fg-3)" />
        </span>
      </button>
      {open && <div className="faq-a">{a}</div>}
    </div>
  );
}

const PAIN_KEYS = ['speed', 'voice', 'context'];
const DOES_KEYS = ['read', 'send', 'schedule', 'organize'];
const DOES_ICONS = { read: 'inbox', send: 'mail', schedule: 'refresh', organize: 'check' };

export default function FoundersClient() {
  const t = useTranslations('forFounders');
  const prompts = Array.isArray(t.raw('day.prompts')) ? t.raw('day.prompts') : [];
  const faqItems = Array.isArray(t.raw('faq.items')) ? t.raw('faq.items') : [];

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
          <p className="pricing-page-lead">{t('hero.lead')}</p>
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>
            <a className="btn btn-primary btn-lg" href="/signup">{t('hero.ctaPrimary')}</a>
            <a className="btn btn-secondary btn-lg" href="#day">{t('hero.ctaSecondary')}</a>
          </div>
        </div>
      </section>

      {/* Why founders pick it */}
      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{t('pains.eyebrow')}</div>
            <h2>{t('pains.title')}</h2>
            <p className="sub">{t('pains.sub')}</p>
          </div>
          <ol className="principle-list">
            {PAIN_KEYS.map((k, i) => (
              <li className="principle" key={k}>
                <div className="p-num">
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{t(`pains.items.${k}.tag`)}</span>
                </div>
                <div className="p-body">
                  <h3>{t(`pains.items.${k}.h`)}</h3>
                  <p>{t.rich(`pains.items.${k}.p`, RICH)}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* A day in your inbox: real prompts */}
      <section className="section" id="day" style={{ paddingTop: 64, paddingBottom: 80, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{t('day.eyebrow')}</div>
            <h2 style={{ fontSize: 36 }}>{t('day.title')}</h2>
            <p className="sub">{t('day.sub')}</p>
          </div>
          <ul className="founder-prompts">
            {prompts.map((p, i) => (
              <li key={i} className="founder-prompt">
                <span className="founder-prompt-mark" aria-hidden="true">&gt;_</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* What it actually does */}
      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{t('does.eyebrow')}</div>
            <h2>{t('does.title')}</h2>
            <p className="sub">{t('does.sub')}</p>
          </div>
          <div className="founder-does-grid">
            {DOES_KEYS.map((k) => (
              <div className="founder-does-card" key={k}>
                <div className="founder-does-icon">
                  <MIcon name={DOES_ICONS[k]} size={20} color="var(--mint-600)" />
                </div>
                <h3>{t(`does.items.${k}.h`)}</h3>
                <p>{t(`does.items.${k}.p`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Proof line */}
      <section className="section" style={{ background: 'var(--bg-page)', paddingTop: 56, paddingBottom: 56 }}>
        <div className="container">
          <figure className="founder-quote">
            <blockquote>{t('proof.quote')}</blockquote>
            <figcaption>{t('proof.label')}</figcaption>
          </figure>
        </div>
      </section>

      {/* Connect any inbox */}
      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{t('providers.eyebrow')}</div>
            <h2>{t('providers.title')}</h2>
            <p className="sub">{t('providers.sub')}</p>
          </div>
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <Link className="btn btn-secondary" href="/connect/gmail">{t('providers.ctaGmail')}</Link>
            <Link className="btn btn-secondary" href="/connect/fastmail">{t('providers.ctaFastmail')}</Link>
            <Link className="btn btn-secondary" href="/connect/icloud">{t('providers.ctaIcloud')}</Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      {faqItems.length > 0 && (
        <section className="section" id="faq" style={{ background: 'var(--bg-page)' }}>
          <div className="container">
            <div className="section-head" style={{ marginBottom: 32 }}>
              <div className="eye-label">{t('faq.eyebrow')}</div>
              <h2 style={{ fontSize: 36 }}>{t('faq.title')}</h2>
              <p className="sub">{t('faq.sub')}</p>
            </div>
            <div className="faq-list">
              {faqItems.map((item) => (
                <FaqItem key={item.q} q={item.q} a={item.a} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{t('ctaBand.title')}</h2>
          <p className="pricing-cta-sub">{t('ctaBand.sub')}</p>
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
