import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { Nav, Footer } from '../../../components/marketing/Sections';
import { LAST_UPDATED, EFFECTIVE_DATE } from '@/lib/legal-config';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'terms' });
  const title = t.has('meta.title') ? t('meta.title') : 'Terms of Service';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'The terms governing your use of MCPEmails: acceptable use, liability, account termination, and governing law.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/terms'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/terms'),
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

/* ─── Constants ──────────────────────────────────────────────── */

const CONTACT_EMAIL = 'legal@mcpemails.com';

/* Service-provider identification required by the Norwegian ehandelsloven § 8:
   legal name, geographic address, the register we are enrolled in, and our
   organisation number. These values must match our entry in Enhetsregisteret,
   so do not edit them without checking brreg.no first. "MCPEmails" is only the
   trading name of the service; the contracting legal person is Albretsen
   Consulting. */
const COMPANY_NAME = 'Albretsen Consulting';
const COMPANY_OWNER = 'Asgeir Albretsen';
const COMPANY_ORG_NUMBER = '926 646 753';
const COMPANY_REGISTER = 'Enhetsregisteret';
const COMPANY_ADDRESS = 'Håsteins gate 9, 5160 Laksevåg, Norway';

/* ─── Page ───────────────────────────────────────────────────── */

export default async function TermsPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('terms');
  const richTags = {
    b: (c) => <strong>{c}</strong>,
    privacy: (c) => <a href="/privacy">{c}</a>,
    pricing: (c) => <a href="/pricing">{c}</a>,
    email: () => <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>,
    odr: (c) => (
      <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener noreferrer">
        {c}
      </a>
    ),
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
            {t('hero.dates', { lastUpdated: LAST_UPDATED, effective: EFFECTIVE_DATE })}
          </p>
        </div>
      </section>

      {/* Body */}
      <section className="section" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="legal-body">

            {/* 1 - Agreement */}
            <LegalSection id="agreement" title={t('agreement.title')}>
              <p>
                {t.rich('agreement.p1', {
                  ...richTags,
                  company: COMPANY_NAME,
                  owner: COMPANY_OWNER,
                  orgNumber: COMPANY_ORG_NUMBER,
                })}
              </p>
              <p>
                {t.rich('agreement.p1b', {
                  ...richTags,
                  company: COMPANY_NAME,
                  orgNumber: COMPANY_ORG_NUMBER,
                  register: COMPANY_REGISTER,
                  companyAddress: COMPANY_ADDRESS,
                })}
              </p>
              <p>{t.rich('agreement.p2', richTags)}</p>
              <p>{t('agreement.p3')}</p>
              <p>{t('agreement.p4')}</p>
            </LegalSection>

            {/* 2 - Description of service */}
            <LegalSection id="service-description" title={t('serviceDescription.title')}>
              <p>{t('serviceDescription.p1')}</p>
              <ul>
                {t.raw('serviceDescription.list').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <p>{t.rich('serviceDescription.p2', richTags)}</p>
              <p>{t('serviceDescription.p2b')}</p>
              <p>{t('serviceDescription.p3')}</p>
            </LegalSection>

            {/* 3 - Account registration */}
            <LegalSection id="account-registration" title={t('accountRegistration.title')}>

              <h4>{t('accountRegistration.h31')}</h4>
              <p>{t('accountRegistration.p31')}</p>

              <h4>{t('accountRegistration.h32')}</h4>
              <p>{t('accountRegistration.p32')}</p>

              <h4>{t('accountRegistration.h33')}</h4>
              <p>{t.rich('accountRegistration.p33', richTags)}</p>

              <h4>{t('accountRegistration.h34')}</h4>
              <p>{t('accountRegistration.p34')}</p>
            </LegalSection>

            {/* 4 - Acceptable use */}
            <LegalSection id="acceptable-use" title={t('acceptableUse.title')}>

              <h4>{t('acceptableUse.h41')}</h4>
              <p>{t('acceptableUse.p41')}</p>

              <h4>{t('acceptableUse.h42')}</h4>
              <p>{t('acceptableUse.p42')}</p>
              <ul>
                {t.raw('acceptableUse.list').map((item, i) => (
                  <li key={i}>{t.rich(`acceptableUse.list.${i}`, richTags)}</li>
                ))}
              </ul>

              <h4>{t('acceptableUse.h43')}</h4>
              <p>{t('acceptableUse.p43')}</p>

              <h4>{t('acceptableUse.h44')}</h4>
              <p>{t('acceptableUse.p44')}</p>

              <h4>{t('acceptableUse.h45')}</h4>
              <p>{t('acceptableUse.p45')}</p>
            </LegalSection>

            {/* 5 - Plans and payment */}
            <LegalSection id="plans-and-payment" title={t('plansAndPayment.title')}>

              <h4>{t('plansAndPayment.h51')}</h4>
              <p>{t.rich('plansAndPayment.p51', richTags)}</p>

              <h4>{t('plansAndPayment.h52')}</h4>
              <p>{t('plansAndPayment.p52')}</p>

              <h4>{t('plansAndPayment.h53')}</h4>
              <p>{t('plansAndPayment.p53')}</p>

              {/* 5.4 is deliberately two paragraphs: the cancellation rule and
                  the 14-day first-charge refund are separate promises, and the
                  14 days are chosen so the commercial guarantee and the EU/UK
                  statutory right of withdrawal are one policy. */}
              <h4>{t('plansAndPayment.h54')}</h4>
              <p>{t.rich('plansAndPayment.p54a', richTags)}</p>
              <p>{t.rich('plansAndPayment.p54b', richTags)}</p>

              <h4>{t('plansAndPayment.h55')}</h4>
              <p>{t('plansAndPayment.p55')}</p>

              <h4>{t('plansAndPayment.h56')}</h4>
              <p>{t('plansAndPayment.p56')}</p>

              <h4>{t('plansAndPayment.h57')}</h4>
              <p>{t.rich('plansAndPayment.p57a', richTags)}</p>
              <p>{t('plansAndPayment.p57b')}</p>
            </LegalSection>

            {/* 6 - Intellectual property */}
            <LegalSection id="intellectual-property" title={t('intellectualProperty.title')}>

              <h4>{t('intellectualProperty.h61')}</h4>
              <p>{t('intellectualProperty.p61')}</p>

              <h4>{t('intellectualProperty.h62')}</h4>
              <p>{t('intellectualProperty.p62')}</p>

              <h4>{t('intellectualProperty.h63')}</h4>
              <p>{t('intellectualProperty.p63')}</p>
            </LegalSection>

            {/* 7 - Disclaimer and limitation of liability */}
            <LegalSection id="liability" title={t('liability.title')}>

              <h4>{t('liability.h71')}</h4>
              <p>{t('liability.p71')}</p>

              <h4>{t('liability.h72')}</h4>
              <p>{t('liability.p72')}</p>

              <h4>{t('liability.h73')}</h4>
              <p>{t('liability.p73')}</p>

              <h4>{t('liability.h74')}</h4>
              <p>{t('liability.p74a')}</p>
              <p>{t('liability.p74b')}</p>
              <p>{t('liability.p74c')}</p>

              <h4>{t('liability.h75')}</h4>
              <p>{t('liability.p75')}</p>
            </LegalSection>

            {/* 8 - Account termination */}
            <LegalSection id="account-termination" title={t('accountTermination.title')}>

              <h4>{t('accountTermination.h81')}</h4>
              <p>{t.rich('accountTermination.p81a', richTags)}</p>
              <p>{t('accountTermination.p81b')}</p>

              <h4>{t('accountTermination.h82')}</h4>
              <p>{t('accountTermination.p82')}</p>
              <ul>
                {t.raw('accountTermination.list82').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <p>{t('accountTermination.p82after')}</p>

              <h4>{t('accountTermination.h83')}</h4>
              <p>{t('accountTermination.p83')}</p>

              <h4>{t('accountTermination.h84')}</h4>
              <p>{t('accountTermination.p84')}</p>

              <h4>{t('accountTermination.h85')}</h4>
              <p>{t('accountTermination.p85')}</p>
              <ul>
                {t.raw('accountTermination.list85').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <p>{t('accountTermination.p85after')}</p>
            </LegalSection>

            {/* 9 - Governing law */}
            <LegalSection id="governing-law" title={t('governingLaw.title')}>

              <h4>{t('governingLaw.h91')}</h4>
              <p>{t.rich('governingLaw.p91', richTags)}</p>

              <h4>{t('governingLaw.h92')}</h4>
              <p>{t.rich('governingLaw.p92', richTags)}</p>

              <h4>{t('governingLaw.h93')}</h4>
              <p>{t.rich('governingLaw.p93', richTags)}</p>

              <h4>{t('governingLaw.h94')}</h4>
              <p>{t.rich('governingLaw.p94', richTags)}</p>

              <h4>{t('governingLaw.h95')}</h4>
              <p>{t('governingLaw.p95')}</p>
            </LegalSection>

            {/* 10 - General */}
            <LegalSection id="general" title={t('general.title')}>

              <h4>{t('general.h101')}</h4>
              <p>{t('general.p101')}</p>

              <h4>{t('general.h102')}</h4>
              <p>{t('general.p102')}</p>

              <h4>{t('general.h103')}</h4>
              <p>{t('general.p103')}</p>

              <h4>{t('general.h104')}</h4>
              <p>{t('general.p104')}</p>

              <h4>{t('general.h105')}</h4>
              <p>{t('general.p105')}</p>

              <h4>{t('general.h106')}</h4>
              <p>{t('general.p106')}</p>

              <h4>{t('general.h107')}</h4>
              <p>{t.rich('general.p107', richTags)}</p>

              <h4>{t('general.h108')}</h4>
              <p>{t('general.p108')}</p>
            </LegalSection>

            {/* 11 - Contact */}
            <LegalSection id="contact" title={t('contact.title')}>
              <p>{t('contact.intro')}</p>
              <div className="legal-contact-card">
                <div className="legal-contact-row">
                  <strong>{t('contact.legalLabel')}</strong>
                  <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                </div>
                <div className="legal-contact-row">
                  <strong>{t('contact.privacyLabel')}</strong>
                  <a href="mailto:privacy@mcpemails.com">privacy@mcpemails.com</a>
                </div>
                <div className="legal-contact-row">
                  <strong>{t('contact.securityLabel')}</strong>
                  <a href="mailto:security@mcpemails.com">security@mcpemails.com</a>
                </div>
                <div className="legal-contact-row">
                  <strong>{t('contact.postalLabel')}</strong>
                  <span>
                    {t('contact.postalValue', {
                      companyName: COMPANY_NAME,
                      orgNumber: COMPANY_ORG_NUMBER,
                      companyAddress: COMPANY_ADDRESS,
                    })}
                  </span>
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
            <a className="btn btn-on-dark btn-lg" href="/privacy">
              {t('cta.privacyBtn')}
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
          min-width: 160px;
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
