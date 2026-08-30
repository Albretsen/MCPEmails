'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import { OAUTH_VERIFICATION_PENDING } from '@/lib/oauth/verification-status';

const RICH = {
  code: (chunks) => <code className="t-code-inline">{chunks}</code>,
  b: (chunks) => <strong>{chunks}</strong>,
};

/**
 * Provider-specific, conversion-focused landing page. `provider` selects the
 * sub-object inside the `connect` message namespace (e.g. `connect.gmail.*`).
 * Gmail connects via Google OAuth (with a verification-in-progress note while
 * Google review is pending); Fastmail and iCloud connect via an app password.
 *
 * @param {{ provider: string }} props
 */
export default function ConnectProviderClient({ provider }) {
  const t = useTranslations(`connect.${provider}`);

  const capabilities = t.raw('capabilities');
  const steps = t.raw('steps');
  // Gmail OAuth shows Google's "unverified app" screen + ~7-day reauth until
  // Google verification completes. Disclose it honestly, gated by the same env
  // flag as the in-app ConnectModal so it auto-hides once verification lands.
  const showGmailVerification = provider === 'gmail' && OAUTH_VERIFICATION_PENDING;

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
          {/*
            Direct answer to the question the search query actually asks
            ("can Claude use iCloud Mail?"). These pages rank between 4.7 and
            9.2 for provider queries and were returning zero clicks: the
            snippet had nothing quotable to pull. Optional per provider, so
            pages without an `answer` string render exactly as before.
          */}
          {t.has('hero.answer') && (
            <p className="pricing-page-answer">{t('hero.answer')}</p>
          )}
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>
            <a className="btn btn-primary btn-lg" href="/signup">{t('hero.ctaPrimary')}</a>
            <Link className="btn btn-secondary btn-lg" href="/docs">{t('hero.ctaSecondary')}</Link>
          </div>
          <div className="hero-meta" style={{ justifyContent: 'center' }}>
            <span className="item"><MIcon name="check" size={14} color="var(--mint-600)" /> {t('hero.meta0')}</span>
            <span className="item"><MIcon name="check" size={14} color="var(--mint-600)" /> {t('hero.meta1')}</span>
            <span className="item"><MIcon name="check" size={14} color="var(--mint-600)" /> {t('hero.meta2')}</span>
          </div>
        </div>
      </section>

      {/* Connection method callout */}
      <section className="section" style={{ paddingTop: 56, paddingBottom: 0 }}>
        <div className="container">
          <div style={{
            border: '1px solid var(--border-1)',
            borderRadius: 12,
            background: 'var(--bg-surface, #fff)',
            padding: '20px 22px',
            display: 'flex',
            gap: 14,
            alignItems: 'flex-start',
            maxWidth: 720,
            margin: '0 auto',
          }}>
            <MIcon name="lock" size={20} color="var(--cobalt-600)" />
            <div>
              <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>{t('method.title')}</h3>
              <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.6 }}>
                {t.rich('method.body', RICH)}
              </p>
            </div>
          </div>

          {showGmailVerification && (
            <div
              role="note"
              style={{
                marginTop: 16,
                maxWidth: 720,
                margin: '16px auto 0',
                padding: '14px 16px',
                background: 'var(--amber-100)',
                border: '1px solid rgba(240,165,62,0.35)',
                borderRadius: 10,
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
              }}
            >
              <MIcon name="alert-triangle" size={18} color="var(--amber-700)" />
              <div>
                <h4 style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--amber-700)' }}>
                  {t('verificationNote.title')}
                </h4>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 13.5, lineHeight: 1.6 }}>
                  {t.rich('verificationNote.body', RICH)}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* What the AI can do */}
      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{t('caps.eyebrow')}</div>
            <h2>{t('caps.title')}</h2>
            <p className="sub">{t('caps.sub')}</p>
          </div>
          <ol className="principle-list">
            {capabilities.map((c, i) => (
              <li className="principle" key={i}>
                <div className="p-num">
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{c.tag}</span>
                </div>
                <div className="p-body">
                  <h3>{c.h}</h3>
                  <p>{c.p}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Step-by-step */}
      <section className="section how" id="how" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">{t('how.eyebrow')}</div>
            <h2>{t('how.title')}</h2>
            <p className="sub">{t('how.sub')}</p>
          </div>
          <div className="how-steps">
            {steps.map((s, i) => (
              <div className="step" key={i}>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <h4>{s.h}</h4>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
          {/*
            Exact-match link to the long-form guide for this provider. The
            product page and the guide used to compete for the same query and
            neither ranked; the guide now owns the instructional phrase and
            this link is what tells Google they are a pair rather than
            duplicates. Optional per provider.
          */}
          {t.has('guide.href') && (
            <p className="how-guide-link">
              {t('guide.intro')}{' '}
              <Link href={t('guide.href')}>{t('guide.label')}</Link>
            </p>
          )}
        </div>
      </section>

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
