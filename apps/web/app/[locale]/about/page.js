import { setRequestLocale, getTranslations } from 'next-intl/server';
import {
  metaAlternates,
  localePath,
  OG_LOCALE,
  OG_IMAGE,
  pageJsonLd,
  APP_URL,
} from '@/i18n/seo';
import { Nav, Footer } from '../../../components/marketing/Sections';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'about' });
  const title = t.has('meta.title') ? t('meta.title') : 'About MCP Emails';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'MCP Emails is built and run by Asgeir Albretsen, a software developer in Bergen, Norway.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/about'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/about'),
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

const GITHUB_URL = 'https://github.com/Albretsen';
const SITE_URL = 'https://albretsen.no';
const LINKEDIN_URL = 'https://www.linkedin.com/in/asgeir-albretsen/';
const REPO_URL = 'https://github.com/Albretsen/MCPEmails';
const SELFHOST_GUIDE_URL = 'https://github.com/Albretsen/MCPEmails/tree/main/self-host';
const CONTACT_EMAIL = 'hello@mcpemails.com';
const SECURITY_EMAIL = 'security@mcpemails.com';

/**
 * The three outbound identity links, in the order a sceptic checks them:
 * code first, then the person's own site, then the employment history.
 */
const IDENTITY_LINKS = [
  { key: 'Github', label: 'github.com/Albretsen', href: GITHUB_URL },
  { key: 'Site', label: 'albretsen.no', href: SITE_URL },
  { key: 'Linkedin', label: 'linkedin.com/in/asgeir-albretsen', href: LINKEDIN_URL },
];

/**
 * Structured data for the operator. The whole point of this page is that the
 * person behind a service holding mailbox credentials is identifiable, so the
 * machine-readable version has to carry the same three verifiable links
 * (`sameAs`) and tie the Person to the same Organization node the rest of the
 * site already publishes at `${APP_URL}/#organization`.
 */
function aboutJsonLd(locale, { title, description }) {
  const url = localePath(locale, '/about');
  const personId = `${APP_URL}/#asgeir-albretsen`;
  const orgId = `${APP_URL}/#organization`;
  const base = pageJsonLd(locale, { path: '/about', title, description });
  return {
    ...base,
    '@graph': [
      ...base['@graph'],
      {
        '@type': 'Person',
        '@id': personId,
        name: 'Asgeir Albretsen',
        jobTitle: 'Software developer',
        url: SITE_URL,
        mainEntityOfPage: { '@id': url },
        // PORTRAIT SLOT (structured data half): when a portrait exists, add
        //   image: `${APP_URL}/asgeir-albretsen.jpg`,
        // here as well as uncommenting the <img> in the hero below.
        sameAs: [GITHUB_URL, SITE_URL, LINKEDIN_URL],
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Bergen',
          addressCountry: 'NO',
        },
        alumniOf: { '@type': 'CollegeOrUniversity', name: 'University of Bergen' },
        worksFor: { '@id': orgId },
      },
      {
        '@type': 'Organization',
        '@id': orgId,
        name: 'mcpemails',
        legalName: 'Albretsen Consulting',
        url: APP_URL,
        logo: `${APP_URL}/favicon.svg`,
        founder: { '@id': personId },
        email: CONTACT_EMAIL,
        // Norwegian organisation number, as registered in Enhetsregisteret.
        identifier: '926646753',
        vatID: 'NO926646753',
        address: {
          '@type': 'PostalAddress',
          streetAddress: 'Håsteins gate 9',
          postalCode: '5160',
          addressLocality: 'Laksevåg',
          addressCountry: 'NO',
        },
      },
    ],
  };
}

/* ─── Page ───────────────────────────────────────────────────── */

export default async function AboutPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('about');
  const title = t.has('meta.title') ? t('meta.title') : 'About MCP Emails';
  const description = t.has('meta.description') ? t('meta.description') : '';
  const jsonLd = aboutJsonLd(locale, { title, description });

  // Named so react/display-name is satisfied; these are next-intl rich-text
  // tag callbacks, invoked directly with the chunks, not rendered as elements.
  const extLink = (href) => function ExternalLink(chunks) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">{chunks}</a>
    );
  };
  const richTags = {
    b: (c) => <strong>{c}</strong>,
    c: (c) => <code>{c}</code>,
    terms: (c) => <a href="/terms">{c}</a>,
    privacy: (c) => <a href="/privacy">{c}</a>,
    security: (c) => <a href="/security">{c}</a>,
    hello: (c) => <a href={`mailto:${CONTACT_EMAIL}`}>{c}</a>,
    securityEmail: (c) => <a href={`mailto:${SECURITY_EMAIL}`}>{c}</a>,
    github: extLink(GITHUB_URL),
    repo: extLink(REPO_URL),
  };

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero" style={{ paddingBottom: 48 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          {/*
            PORTRAIT SLOT. No photo exists yet and the page is designed to read
            correctly without one, so nothing is reserved for it. To add a
            portrait later: drop a square image (>= 320px) at
            /public/asgeir-albretsen.jpg, uncomment the <img> below, and add the
            matching `image` field to the Person node in aboutJsonLd() above.
            The .ab-portrait rule at the bottom of this file is already written.

            <img
              className="ab-portrait"
              src="/asgeir-albretsen.jpg"
              alt={t('portraitAlt')}
              width={96}
              height={96}
            />
          */}
          <div className="eye-label">{t('hero.eyebrow')}</div>
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>
            {t('hero.title')}
          </h1>
          <p className="pricing-page-lead" style={{ maxWidth: 640 }}>
            {t('hero.lead')}
          </p>
        </div>
      </section>

      {/* Body */}
      <section className="section" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="ab-body">

            {/* 1 - Who I am, with checkable links */}
            <div className="ab-section">
              <h2>{t('who.title')}</h2>
              <p>{t('who.p1')}</p>
              <p>{t('who.p2')}</p>
              <div className="legal-table-wrap">
                <table className="legal-table">
                  <thead>
                    <tr>
                      <th>{t('who.thPeriod')}</th>
                      <th>{t('who.thRole')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.raw('who.rows').map((row, i) => (
                      <tr key={i}>
                        <td className="ab-period">{row.period}</td>
                        <td>{row.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ marginTop: 16 }}>{t('who.p3')}</p>
              <p>{t('who.linksIntro')}</p>
              <ul className="ab-links">
                {IDENTITY_LINKS.map(({ key, label, href }) => (
                  <li key={key}>
                    <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
                    <span className="ab-link-note">{t(`who.link${key}Note`)}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* 2 - Why it exists */}
            <div className="ab-section">
              <h2>{t('why.title')}</h2>
              <p>{t('why.p1')}</p>
              <p>{t('why.p2')}</p>
            </div>

            {/* 3 - What you are trusting, plus the short entity block.
                The full ehandelsloven identification lives in /terms and
                /privacy; this is deliberately only a pointer to it. */}
            <div className="ab-section">
              <h2>{t('trusting.title')}</h2>
              <p>{t('trusting.intro')}</p>
              <ul>
                {t.raw('trusting.points').map((_, i) => (
                  <li key={i}>{t.rich(`trusting.points.${i}`, richTags)}</li>
                ))}
              </ul>
              <div className="ab-entity">
                <p className="ab-entity-title">{t('trusting.entityTitle')}</p>
                <p className="ab-entity-line ab-entity-name">{t('trusting.entityName')}</p>
                <p className="ab-entity-line">{t('trusting.entityOrgNo')}</p>
                <p className="ab-entity-line">{t('trusting.entityAddress')}</p>
                <p className="ab-entity-line">{t('trusting.entityRegistry')}</p>
                <p className="ab-entity-note">{t.rich('trusting.entityNote', richTags)}</p>
              </div>
            </div>

            {/* 4 - The bus-factor answer. The most important block on the page:
                the AGPL licence plus the self-host path is the reason a
                single-operator service is not a lock-in. */}
            <div className="ab-section">
              <h2>{t('busFactor.title')}</h2>
              <p>{t('busFactor.p1')}</p>
              <p>{t('busFactor.p2')}</p>
              <p>{t('busFactor.p3')}</p>
              <div className="ab-btns">
                <a className="btn btn-primary" href="/self-hosting">
                  {t('busFactor.ctaSelfHost')}
                </a>
                <a className="btn btn-secondary" href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  {t('busFactor.ctaSource')}
                </a>
              </div>
            </div>

            {/* 5 - Contact and the response commitment */}
            <div className="ab-section">
              <h2>{t('contact.title')}</h2>
              <p>{t('contact.p1')}</p>
              <ul>
                {t.raw('contact.points').map((_, i) => (
                  <li key={i}>{t.rich(`contact.points.${i}`, richTags)}</li>
                ))}
              </ul>
            </div>

          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{t('cta.title')}</h2>
          <p className="pricing-cta-sub">{t('cta.sub')}</p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/security">
              {t('cta.primary')}
            </a>
            <a className="btn btn-on-dark btn-lg" href={SELFHOST_GUIDE_URL} target="_blank" rel="noopener noreferrer">
              {t('cta.secondary')}
            </a>
          </div>
        </div>
      </section>

      <Footer />

      <style>{`
        .ab-body { font-family: var(--font-sans); color: var(--fg-1); line-height: 1.75; }
        .ab-section { margin-bottom: 48px; padding-bottom: 48px; border-bottom: 1px solid var(--border-1); }
        .ab-section:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
        .ab-section h2 { font-size: 22px; font-weight: 700; color: var(--fg-0); margin: 0 0 16px; scroll-margin-top: 80px; }
        .ab-section p { font-size: 15px; margin: 0 0 16px; color: var(--fg-2); }
        .ab-section ul { margin: 0 0 16px 0; padding-left: 20px; }
        .ab-section ul li { font-size: 15px; color: var(--fg-2); margin-bottom: 10px; line-height: 1.65; }
        .ab-section a:not(.btn) { color: var(--cobalt-600); text-decoration: underline; text-underline-offset: 2px; }
        .ab-section a:not(.btn):hover { color: var(--cobalt-700); }
        .ab-section code { font-family: var(--font-mono); font-size: 0.88em; background: var(--bg-sunken); padding: 1px 5px; border-radius: 4px; color: var(--fg-1); }
        .ab-btns { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
        .legal-table-wrap { overflow-x: auto; margin: 4px 0 0; border: 1px solid var(--border-1); border-radius: var(--radius-lg); }
        .legal-table { width: 100%; border-collapse: collapse; font-size: 14px; font-family: var(--font-sans); }
        .legal-table th { text-align: left; padding: 11px 16px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-3); background: var(--bg-sunken); border-bottom: 1px solid var(--border-1); }
        .legal-table td { padding: 12px 16px; color: var(--fg-2); vertical-align: top; border-bottom: 1px solid var(--border-1); line-height: 1.55; }
        .legal-table tr:last-child td { border-bottom: none; }
        .ab-period { white-space: nowrap; color: var(--fg-3); font-variant-numeric: tabular-nums; }
        .ab-links { list-style: none; padding-left: 0; margin-top: 4px; }
        .ab-links li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 8px; }
        .ab-link-note { font-size: 13.5px; color: var(--fg-3); }
        .ab-entity { margin-top: 4px; padding: 16px 18px; background: var(--bg-sunken); border: 1px solid var(--border-1); border-radius: var(--radius-lg); }
        .ab-entity-title { font-size: 12px !important; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-3) !important; margin: 0 0 10px !important; }
        .ab-entity-line { font-size: 14px !important; margin: 0 0 3px !important; color: var(--fg-2) !important; line-height: 1.6; }
        .ab-entity-name { color: var(--fg-1) !important; font-weight: 600; }
        .ab-entity-note { font-size: 13.5px !important; color: var(--fg-3) !important; margin: 10px 0 0 !important; }
        /* PORTRAIT SLOT (style half). Unused until the <img> in the hero is
           uncommented; kept here so adding a photo is a one-line change. */
        .ab-portrait { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; display: block; margin: 0 0 20px; border: 1px solid var(--border-1); }
      `}</style>
    </div>
  );
}
