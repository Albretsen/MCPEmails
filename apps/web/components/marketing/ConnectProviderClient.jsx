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
 * The IMAP/SMTP endpoints printed on each page, for the providers reached over
 * IMAP with settings the visitor has to type. Values, not copy, so they live
 * here rather than in five message bundles: a port is the same number in every
 * language, and one table is one place to correct.
 *
 * Where an entry exists in `src/lib/email-providers/host-presets.ts` these are
 * the same values, deliberately: the page must promise what the connect form
 * actually prefills. The rest (AOL, Mail.ru, WEB.DE, Rackspace) are the
 * vendor-documented settings, and the page is the only place the user can get
 * them, because the form does not recognise those hosts yet.
 *
 * Absent on purpose: gmail (Gmail API, no IMAP) and the four branded presets
 * that already ship a logo card in the connect modal, where the user never
 * types a host.
 */
const MAIL_SETTINGS = {
  // Both standard pairs, in the order transport-autodetect tries them.
  imap: {
    imap: { host: 'imap.yourdomain.com', port: '993 / 143', security: 'TLS / STARTTLS' },
    smtp: { host: 'smtp.yourdomain.com', port: '465 / 587', security: 'TLS / STARTTLS' },
  },
  gmx: {
    imap: { host: 'imap.gmx.com', port: '993', security: 'TLS' },
    smtp: { host: 'mail.gmx.com', port: '587', security: 'STARTTLS' },
  },
  aol: {
    imap: { host: 'imap.aol.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.aol.com', port: '465', security: 'TLS' },
  },
  'mail-ru': {
    imap: { host: 'imap.mail.ru', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.mail.ru', port: '465', security: 'TLS' },
  },
  'web-de': {
    imap: { host: 'imap.web.de', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.web.de', port: '587', security: 'STARTTLS' },
  },
  // cPanel builds the host from the customer's own domain, so the shape is the
  // value. The exact strings are in cPanel under Mail Client Manual Settings.
  cpanel: {
    imap: { host: 'mail.yourdomain.com', port: '993', security: 'TLS' },
    smtp: { host: 'mail.yourdomain.com', port: '465', security: 'TLS' },
  },
  migadu: {
    imap: { host: 'imap.migadu.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.migadu.com', port: '465', security: 'TLS' },
  },
  namecheap: {
    imap: { host: 'mail.privateemail.com', port: '993', security: 'TLS' },
    smtp: { host: 'mail.privateemail.com', port: '465', security: 'TLS' },
  },
  ionos: {
    imap: { host: 'imap.ionos.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.ionos.com', port: '465', security: 'TLS' },
  },
  // MX Plan. Hosted Exchange is ex<N>.mail.ovh.net on 587/STARTTLS; the page
  // copy says so, because the two are not interchangeable.
  ovh: {
    imap: { host: 'ssl0.ovh.net', port: '993', security: 'TLS' },
    smtp: { host: 'ssl0.ovh.net', port: '465', security: 'TLS' },
  },
  rackspace: {
    imap: { host: 'secure.emailsrvr.com', port: '993', security: 'TLS' },
    smtp: { host: 'secure.emailsrvr.com', port: '465', security: 'TLS' },
  },
  hostinger: {
    imap: { host: 'imap.hostinger.com', port: '993', security: 'TLS' },
    smtp: { host: 'smtp.hostinger.com', port: '465', security: 'TLS' },
  },
};

/**
 * Provider-specific, conversion-focused landing page. `provider` selects the
 * sub-object inside the `connect` message namespace (e.g. `connect.gmail.*`).
 * Gmail connects via Google OAuth (with a verification-in-progress note while
 * Google review is pending); every other provider connects over IMAP, with
 * either an app password or the mailbox password. Providers whose settings the
 * visitor has to type also get the endpoint table from MAIL_SETTINGS.
 *
 * @param {{ provider: string }} props
 */
export default function ConnectProviderClient({ provider }) {
  const t = useTranslations(`connect.${provider}`);
  // Shared across every provider page: the back-link to the compatibility
  // matrix and the IMAP/SMTP table headings are the same sentences on each, so
  // they live once at `connect.matrix` and `connect.settings` rather than once
  // per provider under `connect.<provider>`.
  const tShared = useTranslations('connect');

  const capabilities = t.raw('capabilities');
  const steps = t.raw('steps');
  const settings = MAIL_SETTINGS[provider] ?? null;
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

      {/*
        The exact endpoints, for the providers where the visitor has to type
        them. Generic IMAP succeeds only about a quarter of the time and the
        recorded failures are people guessing at a port (see the note on
        MAIL_HOST_PRESETS), so printing the four values the form asks for is
        the most direct thing this page can do about that.
      */}
      {settings && (
        <section className="section" style={{ paddingTop: 40, paddingBottom: 0 }}>
          <div className="container">
            <h2 className="providers-h2">{tShared('settings.title')}</h2>
            <p className="providers-sub">{tShared('settings.sub')}</p>
            <div className="comparison-wrap">
              <table className="comparison-tbl providers-conn-tbl">
                <thead>
                  <tr>
                    <th className="feat-col" style={{ minWidth: 150 }}>{tShared('settings.colProtocol')}</th>
                    <th style={{ minWidth: 200 }}>{tShared('settings.colHost')}</th>
                    <th style={{ minWidth: 110 }}>{tShared('settings.colPort')}</th>
                    <th style={{ minWidth: 140 }}>{tShared('settings.colSecurity')}</th>
                  </tr>
                </thead>
                <tbody>
                  {['imap', 'smtp'].map((protocol) => (
                    <tr key={protocol}>
                      <td className="feat-name">{tShared(`settings.${protocol}`)}</td>
                      <td className="tbl-val">
                        <code style={{
                          fontFamily: 'var(--font-mono)', fontSize: 12,
                          color: 'var(--fg-1)', whiteSpace: 'nowrap',
                        }}>
                          {settings[protocol].host}
                        </code>
                      </td>
                      <td className="tbl-val" style={{ fontSize: 13 }}>{settings[protocol].port}</td>
                      <td className="tbl-val" style={{ fontSize: 13 }}>{settings[protocol].security}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

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
          {/*
            Back-link to the compatibility matrix. Every provider row over there
            links down to one of these pages; this is the other half of that
            pair, and it is what makes the matrix a hub rather than a leaf.
          */}
          <p className="how-guide-link">
            {tShared('matrix.intro')}{' '}
            <Link href={tShared('matrix.href')}>{tShared('matrix.label')}</Link>
          </p>
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
