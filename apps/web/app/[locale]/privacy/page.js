import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { Nav, Footer } from '../../../components/marketing/Sections';
import { LAST_UPDATED, EFFECTIVE_DATE } from '@/lib/legal-config';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'privacy' });
  const title = t.has('meta.title') ? t('meta.title') : 'Privacy Policy';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'How MCPEmails collects, uses, and protects your data. Our privacy policy for users, workspace owners, and AI agents.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/privacy'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/privacy'),
      title: `${title} · mcpemails`,
      description,
      locale: OG_LOCALE[locale],
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · mcpemails`,
      description,
      images: [OG_IMAGE.url],
    },
  };
}

/* ─── Section data ───────────────────────────────────────────── */

const CONTACT_EMAIL = 'privacy@mcpemails.com';
const COMPANY_NAME = 'MCPEmails';
const COMPANY_ADDRESS = 'Oslo, Norway';

/* ─── Page ───────────────────────────────────────────────────── */

export default async function PrivacyPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('privacy');
  const richTags = {
    b: (c) => <strong>{c}</strong>,
    c: (c) => <code>{c}</code>,
  };
  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero" style={{ paddingBottom: 48 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="eye-label">{t('hero.eyebrow')}</div>
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>
            {t('hero.title')}
          </h1>
          <p className="pricing-page-lead" style={{ maxWidth: 600 }}>
            {t('hero.lead')}
          </p>
          <p style={{ fontSize: 13, color: 'var(--fg-4)', marginTop: 8 }}>
            {t('hero.dates', { lastUpdated: LAST_UPDATED, effectiveDate: EFFECTIVE_DATE })}
          </p>
        </div>
      </section>

      {/* Body */}
      <section className="section" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="legal-body">

            {/* 1 - Who we are */}
            <LegalSection id="who-we-are" title={t('whoWeAre.title')}>
              <p>
                {t.rich('whoWeAre.p1', {
                  companyName: COMPANY_NAME,
                  b: (c) => <strong>{c}</strong>,
                })}
              </p>
              <p>{t('whoWeAre.p2')}</p>
              <p>
                {t.rich('whoWeAre.p3', {
                  companyAddress: COMPANY_ADDRESS,
                  email: () => <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>,
                })}
              </p>
            </LegalSection>

            {/* 2 - Data we collect */}
            <LegalSection id="data-we-collect" title={t('dataWeCollect.title')}>

              <h4>{t('dataWeCollect.accountTitle')}</h4>
              <p>{t('dataWeCollect.accountP')}</p>

              <h4>{t('dataWeCollect.workspaceTitle')}</h4>
              <p>{t.rich('dataWeCollect.workspaceP', richTags)}</p>

              <h4>{t('dataWeCollect.apiKeysTitle')}</h4>
              <p>{t('dataWeCollect.apiKeysP')}</p>

              <h4>{t('dataWeCollect.logsTitle')}</h4>
              <p>{t.rich('dataWeCollect.logsP', richTags)}</p>

              <h4>{t('dataWeCollect.emailContentTitle')}</h4>
              <p>{t.rich('dataWeCollect.emailContentP', richTags)}</p>
              <p>{t.rich('dataWeCollect.emailContentAgentP', richTags)}</p>

              <h4>{t('dataWeCollect.technicalTitle')}</h4>
              <p>{t('dataWeCollect.technicalP')}</p>

              <h4>{t('dataWeCollect.cookiesTitle')}</h4>
              <p>{t.rich('dataWeCollect.cookiesP', richTags)}</p>
            </LegalSection>

            {/* 3 - How we use data */}
            <LegalSection id="how-we-use-data" title={t('howWeUseData.title')}>
              <p>{t('howWeUseData.intro')}</p>

              <h4>{t('howWeUseData.providingTitle')}</h4>
              <p>{t.rich('howWeUseData.providingP', richTags)}</p>

              <h4>{t('howWeUseData.securityTitle')}</h4>
              <p>{t.rich('howWeUseData.securityP', richTags)}</p>

              <h4>{t('howWeUseData.analyticsTitle')}</h4>
              <p>{t.rich('howWeUseData.analyticsP', richTags)}</p>

              <h4>{t('howWeUseData.billingTitle')}</h4>
              <p>{t.rich('howWeUseData.billingP', richTags)}</p>

              <h4>{t('howWeUseData.legalTitle')}</h4>
              <p>{t.rich('howWeUseData.legalP', richTags)}</p>

              <h4>{t('howWeUseData.neverTitle')}</h4>
              <ul>
                {t.raw('howWeUseData.neverList').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>

              <h4>{t('howWeUseData.googleTitle')}</h4>
              <p>
                {t.rich('howWeUseData.googleP1', {
                  ...richTags,
                  link: (c) => (
                    <a
                      href="https://developers.google.com/terms/api-services-user-data-policy"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {c}
                    </a>
                  ),
                })}
              </p>
              <p>{t('howWeUseData.googleP2')}</p>
              <ul>
                <li>{t.rich('howWeUseData.googleScopeReadonly', richTags)}</li>
                <li>{t.rich('howWeUseData.googleScopeSend', richTags)}</li>
                <li>{t.rich('howWeUseData.googleScopeModify', richTags)}</li>
              </ul>
              <p>{t('howWeUseData.googleLimitedIntro')}</p>
              <ul>
                {t.raw('howWeUseData.googleLimitedList').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <p>{t('howWeUseData.googleP3')}</p>
            </LegalSection>

            {/* 4 - Data retention */}
            <LegalSection id="data-retention" title={t('dataRetention.title')}>
              <p>{t('dataRetention.intro')}</p>

              <div className="legal-table-wrap">
                <table className="legal-table">
                  <thead>
                    <tr>
                      <th>{t('dataRetention.thCategory')}</th>
                      <th>{t('dataRetention.thPeriod')}</th>
                      <th>{t('dataRetention.thReason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.raw('dataRetention.rows').map((row, i) => (
                      <tr key={i}>
                        <td>{row.category}</td>
                        <td>{row.period}</td>
                        <td>{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p>{t('dataRetention.outro')}</p>
            </LegalSection>

            {/* 5 - Third parties */}
            <LegalSection id="third-parties" title={t('thirdParties.title')}>

              <h4>{t('thirdParties.infraTitle')}</h4>
              <p>{t('thirdParties.infraP')}</p>

              <div className="legal-table-wrap">
                <table className="legal-table">
                  <thead>
                    <tr>
                      <th>{t('thirdParties.thProvider')}</th>
                      <th>{t('thirdParties.thPurpose')}</th>
                      <th>{t('thirdParties.thData')}</th>
                      <th>{t('thirdParties.thLocation')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>Supabase</strong></td>
                      <td>{t('thirdParties.supabasePurpose')}</td>
                      <td>{t('thirdParties.supabaseData')}</td>
                      <td>{t('thirdParties.supabaseLocation')}</td>
                    </tr>
                    <tr>
                      <td><strong>Vercel</strong></td>
                      <td>{t('thirdParties.vercelPurpose')}</td>
                      <td>{t('thirdParties.vercelData')}</td>
                      <td>{t('thirdParties.vercelLocation')}</td>
                    </tr>
                    <tr>
                      <td><strong>Stripe</strong> {t('thirdParties.stripeProvider')}</td>
                      <td>{t('thirdParties.stripePurpose')}</td>
                      <td>{t('thirdParties.stripeData')}</td>
                      <td>{t('thirdParties.stripeLocation')}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h4>{t('thirdParties.emailProvidersTitle')}</h4>
              <p>{t('thirdParties.emailProvidersP')}</p>

              <h4>{t('thirdParties.noBrokersTitle')}</h4>
              <p>{t('thirdParties.noBrokersP')}</p>

              <h4>{t('thirdParties.legalDisclosuresTitle')}</h4>
              <p>{t('thirdParties.legalDisclosuresP')}</p>

              <h4>{t('thirdParties.businessTransfersTitle')}</h4>
              <p>{t('thirdParties.businessTransfersP')}</p>
            </LegalSection>

            {/* 6 - International transfers */}
            <LegalSection id="international-transfers" title={t('internationalTransfers.title')}>
              <p>{t('internationalTransfers.p1')}</p>
              <p>{t('internationalTransfers.p2')}</p>
              <p>{t('internationalTransfers.p3')}</p>
            </LegalSection>

            {/* 7 - Your rights */}
            <LegalSection id="your-rights" title={t('yourRights.title')}>
              <p>{t('yourRights.intro')}</p>
              <ul>
                {t.raw('yourRights.rights').map((right, i) => (
                  <li key={i}>
                    <strong>{right.term}</strong>{right.desc}
                  </li>
                ))}
              </ul>
              <p>
                {t.rich('yourRights.exercise', {
                  email: () => <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>,
                })}
              </p>
              <p>{t.rich('yourRights.complaint', richTags)}</p>
            </LegalSection>

            {/* 8 - Security */}
            <LegalSection id="security" title={t('security.title')}>
              <p>{t('security.intro')}</p>
              <ul>
                {t.raw('security.measures').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <p>
                {t.rich('security.reportP', {
                  securityEmail: () => (
                    <a href="mailto:security@mcpemails.com">security@mcpemails.com</a>
                  ),
                })}
              </p>
              <p>{t('security.breachP')}</p>
            </LegalSection>

            {/* 9 - Children */}
            <LegalSection id="children" title={t('children.title')}>
              <p>
                {t.rich('children.p', {
                  email: () => <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>,
                })}
              </p>
            </LegalSection>

            {/* 10 - Changes */}
            <LegalSection id="changes" title={t('changes.title')}>
              <p>{t('changes.intro')}</p>
              <ul>
                {t.raw('changes.list').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <p>{t('changes.outro')}</p>
            </LegalSection>

            {/* 11 - Contact */}
            <LegalSection id="contact" title={t('contact.title')}>
              <p>{t('contact.intro')}</p>
              <div className="legal-contact-card">
                <div className="legal-contact-row">
                  <strong>{t('contact.emailLabel')}</strong>
                  <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                </div>
                <div className="legal-contact-row">
                  <strong>{t('contact.securityLabel')}</strong>
                  <a href="mailto:security@mcpemails.com">security@mcpemails.com</a>
                </div>
                <div className="legal-contact-row">
                  <strong>{t('contact.postalLabel')}</strong>
                  <span>{COMPANY_NAME}, {COMPANY_ADDRESS}</span>
                </div>
                <div className="legal-contact-row">
                  <strong>{t('contact.responseLabel')}</strong>
                  <span>{t('contact.responseValue')}</span>
                </div>
              </div>
            </LegalSection>

          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{t('cta.title')}</h2>
          <p className="pricing-cta-sub">{t('cta.sub')}</p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href={`mailto:${CONTACT_EMAIL}`}>
              {t('cta.contactBtn')}
            </a>
            <a className="btn btn-on-dark btn-lg" href="/terms">
              {t('cta.termsBtn')}
            </a>
          </div>
        </div>
      </section>

      <Footer />

      <style>{`
        /* ─── Legal page styles ─────────────────────────────────── */
        .legal-body {
          font-family: var(--font-sans);
          color: var(--fg-1);
          line-height: 1.75;
        }

        .legal-section {
          margin-bottom: 56px;
          padding-bottom: 56px;
          border-bottom: 1px solid var(--border-1);
        }

        .legal-section:last-child {
          border-bottom: none;
          margin-bottom: 0;
          padding-bottom: 0;
        }

        .legal-section h2 {
          font-size: 22px;
          font-weight: 700;
          color: var(--fg-0);
          margin: 0 0 20px;
          scroll-margin-top: 80px;
        }

        .legal-section h4 {
          font-size: 15px;
          font-weight: 650;
          color: var(--fg-0);
          margin: 28px 0 10px;
        }

        .legal-section p {
          font-size: 15px;
          margin: 0 0 16px;
          color: var(--fg-2);
        }

        .legal-section ul {
          margin: 0 0 16px 0;
          padding-left: 20px;
        }

        .legal-section ul li {
          font-size: 15px;
          color: var(--fg-2);
          margin-bottom: 10px;
          line-height: 1.65;
        }

        .legal-section a {
          color: var(--cobalt-600);
          text-decoration: underline;
          text-underline-offset: 2px;
        }

        .legal-section a:hover {
          color: var(--cobalt-700);
        }

        .legal-section code {
          font-family: var(--font-mono);
          font-size: 0.88em;
          background: var(--bg-sunken);
          padding: 1px 5px;
          border-radius: 4px;
          color: var(--fg-1);
        }

        /* ─── Tables ──────────────────────────────────────────── */
        .legal-table-wrap {
          overflow-x: auto;
          margin: 20px 0;
          border: 1px solid var(--border-1);
          border-radius: var(--radius-lg);
        }

        .legal-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
          font-family: var(--font-sans);
        }

        .legal-table th {
          text-align: left;
          padding: 11px 16px;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--fg-3);
          background: var(--bg-sunken);
          border-bottom: 1px solid var(--border-1);
        }

        .legal-table td {
          padding: 12px 16px;
          color: var(--fg-2);
          vertical-align: top;
          border-bottom: 1px solid var(--border-1);
          line-height: 1.55;
        }

        .legal-table tr:last-child td {
          border-bottom: none;
        }

        .legal-table tbody tr:hover {
          background: var(--bg-hover);
        }

        /* ─── Contact card ─────────────────────────────────────── */
        .legal-contact-card {
          border: 1px solid var(--border-1);
          border-radius: var(--radius-lg);
          overflow: hidden;
          margin-top: 20px;
        }

        .legal-contact-row {
          display: flex;
          gap: 24px;
          padding: 14px 20px;
          border-bottom: 1px solid var(--border-1);
          font-size: 14px;
          line-height: 1.5;
        }

        .legal-contact-row:last-child {
          border-bottom: none;
        }

        .legal-contact-row strong {
          min-width: 140px;
          color: var(--fg-1);
          font-weight: 600;
          flex-shrink: 0;
        }

        .legal-contact-row span,
        .legal-contact-row a {
          color: var(--fg-2);
        }

        .legal-contact-row a {
          color: var(--cobalt-600);
          text-decoration: underline;
          text-underline-offset: 2px;
        }

        @media (max-width: 640px) {
          .legal-contact-row {
            flex-direction: column;
            gap: 4px;
          }
          .legal-contact-row strong {
            min-width: unset;
          }
        }
      `}</style>
    </div>
  );
}

/* ─── Helper component ───────────────────────────────────────── */

function LegalSection({ id, title, children }) {
  return (
    <div className="legal-section" id={id}>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
