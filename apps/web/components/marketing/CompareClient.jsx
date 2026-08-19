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

/* Accordion FAQ item, mirroring the /pricing + home faq-* markup. */
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

/* Comparison-table rows. Every cell is descriptive text resolved against the
   `compare` bundle: `table.rows.<key>.label`, `.native` and `.mcp`. */
const TABLE_ROWS = ['who', 'mailboxes', 'clients', 'count', 'creds', 'selfhost'];

export default function CompareClient() {
  const t = useTranslations('compare');
  const axisKeys = ['coverage', 'inboxes', 'portable', 'control'];

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
            <Link className="btn btn-secondary btn-lg" href="/docs">{t('hero.ctaSecondary')}</Link>
          </div>
        </div>
      </section>

      {/* Four structural axes */}
      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{t('axes.eyebrow')}</div>
            <h2>{t('axes.title')}</h2>
            <p className="sub">{t('axes.sub')}</p>
          </div>
          <ol className="principle-list">
            {axisKeys.map((k, i) => (
              <li className="principle" key={k}>
                <div className="p-num">
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{t(`axes.items.${k}.tag`)}</span>
                </div>
                <div className="p-body">
                  <h3>{t(`axes.items.${k}.h`)}</h3>
                  <p>{t.rich(`axes.items.${k}.p`, RICH)}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Comparison table */}
      <section className="section" id="compare" style={{ paddingTop: 64, paddingBottom: 80, background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <div className="eye-label">{t('table.eyebrow')}</div>
            <h2 style={{ fontSize: 36 }}>{t('table.title')}</h2>
          </div>
          <div className="comparison-wrap">
            <table className="comparison-tbl comparison-tbl-prose">
              <thead>
                <tr>
                  <th className="feat-col">{t('table.featureCol')}</th>
                  <th>{t('table.nativeCol')}</th>
                  <th className="featured-col">{t('table.mcpCol')}</th>
                </tr>
              </thead>
              <tbody>
                {TABLE_ROWS.map((key) => (
                  <tr key={key}>
                    <td className="feat-name">{t(`table.rows.${key}.label`)}</td>
                    <td className="tbl-val">{t(`table.rows.${key}.native`)}</td>
                    <td className="tbl-val">{t(`table.rows.${key}.mcp`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pricing-footnote" style={{ textAlign: 'center', marginTop: 20 }}>
            {t('table.footnote')}
          </p>
        </div>
      </section>

      {/* FAQ */}
      {Array.isArray(t.raw('faq.items')) && t.raw('faq.items').length > 0 && (
        <section className="section" id="faq" style={{ background: 'var(--bg-page)' }}>
          <div className="container">
            <div className="section-head" style={{ marginBottom: 32 }}>
              <div className="eye-label">{t('faq.eyebrow')}</div>
              <h2 style={{ fontSize: 36 }}>{t('faq.title')}</h2>
              <p className="sub">{t('faq.sub')}</p>
            </div>
            <div className="faq-list">
              {t.raw('faq.items').map((item) => (
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
