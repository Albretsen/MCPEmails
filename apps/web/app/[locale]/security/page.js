import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd } from '@/i18n/seo';
import { Nav, Footer } from '../../../components/marketing/Sections';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'security' });
  const title = t.has('meta.title') ? t('meta.title') : 'Security & Trust';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'How MCPEmails protects your email: fetched live and never stored, credentials encrypted, and code you can read or self-host.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/security'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/security'),
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

const SECURITY_EMAIL = 'security@mcpemails.com';
const REPO_URL = 'https://github.com/Albretsen/MCPEmails';
const SELFHOST_URL = 'https://github.com/Albretsen/MCPEmails/tree/main/self-host';
const LICENSE_URL = 'https://github.com/Albretsen/MCPEmails/blob/main/LICENSE';
const MAINTAINER_URL = 'https://github.com/Albretsen';
const GOOGLE_POLICY_URL = 'https://developers.google.com/terms/api-services-user-data-policy';

/* ─── Page ───────────────────────────────────────────────────── */

export default async function SecurityPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('security');
  const title = t.has('meta.title') ? t('meta.title') : 'AI Email Agent Security';
  const description = t.has('meta.description') ? t('meta.description') : '';
  const jsonLd = pageJsonLd(locale, { path: '/security', title, description });
  const richTags = {
    b: (c) => <strong>{c}</strong>,
    c: (c) => <code>{c}</code>,
    // Some strings use the long <code> form used everywhere else in the app.
    // Without this handler next-intl throws FORMATTING_ERROR and the page dies.
    code: (c) => <code>{c}</code>,
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
          <div className="legal-body">

            {/* 1 - TL;DR */}
            <LegalSection id="short-version" title={t('tldr.title')}>
              <p>{t('tldr.intro')}</p>
              <ul>
                {t.raw('tldr.points').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </LegalSection>

            {/* 2 - Access vs store */}
            <LegalSection id="access-vs-store" title={t('access.title')}>
              <p>{t('access.intro')}</p>
              <div className="legal-table-wrap">
                <table className="legal-table">
                  <thead>
                    <tr>
                      <th>{t('access.thData')}</th>
                      <th>{t('access.thAccessed')}</th>
                      <th>{t('access.thStored')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.raw('access.rows').map((row, i) => (
                      <tr key={i}>
                        <td><strong>{row.data}</strong></td>
                        <td>{row.accessed}</td>
                        <td>{row.stored}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>{t('access.outro')}</p>
            </LegalSection>

            {/* 3 - Verify, don't trust */}
            <LegalSection id="verify" title={t('verify.title')}>
              <p>{t('verify.p1')}</p>
              <ul>
                {t.raw('verify.points').map((item, i) => (
                  <li key={i}>
                    {t.rich(`verify.points.${i}`, {
                      ...richTags,
                      repo: (c) => (
                        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">{c}</a>
                      ),
                      selfhost: (c) => (
                        <a href={SELFHOST_URL} target="_blank" rel="noopener noreferrer">{c}</a>
                      ),
                    })}
                  </li>
                ))}
              </ul>
              <p style={{ margin: '0 0 16px' }}>
                <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  <code>github.com/Albretsen/MCPEmails</code>
                </a>
              </p>
              <p>
                {t.rich('verify.outro', {
                  ...richTags,
                  repo: (c) => (
                    <a href={REPO_URL} target="_blank" rel="noopener noreferrer">{c}</a>
                  ),
                })}
              </p>
            </LegalSection>

            {/* 3b - Run it yourself */}
            <LegalSection id="run-it-yourself" title={t('selfhost.title')}>
              <p>{t('selfhost.p1')}</p>
              <p>{t('selfhost.p2')}</p>
              <p style={{ margin: 0 }}>
                <a href="/self-hosting">{t('selfhost.cta')}</a>
                {' · '}
                <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">AGPL-3.0</a>
              </p>
            </LegalSection>

            {/* 4 - Prompt injection */}
            <LegalSection id="prompt-injection" title={t('injection.title')}>
              <p>{t('injection.p1')}</p>
              <ul>
                {t.raw('injection.points').map((item, i) => (
                  <li key={i}>{t.rich(`injection.points.${i}`, richTags)}</li>
                ))}
              </ul>
              <p>{t('injection.outro')}</p>
            </LegalSection>

            {/* 5 - Credentials */}
            <LegalSection id="credentials" title={t('credentials.title')}>
              <p>{t('credentials.intro')}</p>
              <ul>
                {t.raw('credentials.measures').map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </LegalSection>

            {/* 6 - Google verification */}
            <LegalSection id="google-verification" title={t('google.title')}>
              <p>{t('google.p1')}</p>
              <p>
                {t.rich('google.p2', {
                  link: (c) => (
                    <a href={GOOGLE_POLICY_URL} target="_blank" rel="noopener noreferrer">{c}</a>
                  ),
                })}
              </p>
              <p>{t('google.p3')}</p>
            </LegalSection>

            {/* 7 - Subprocessors */}
            <LegalSection id="subprocessors" title={t('subprocessors.title')}>
              <p>{t('subprocessors.intro')}</p>
              <div className="legal-table-wrap">
                <table className="legal-table">
                  <thead>
                    <tr>
                      <th>{t('subprocessors.thProvider')}</th>
                      <th>{t('subprocessors.thPurpose')}</th>
                      <th>{t('subprocessors.thLocation')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.raw('subprocessors.rows').map((row, i) => (
                      <tr key={i}>
                        <td><strong>{row.provider}</strong></td>
                        <td>{row.purpose}</td>
                        <td>{row.location}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </LegalSection>

            {/* 8 - Vulnerability disclosure */}
            <LegalSection id="report-a-vulnerability" title={t('report.title')}>
              <p>{t('report.p1')}</p>
              <ul>
                {t.raw('report.points').map((item, i) => (
                  <li key={i}>
                    {t.rich(`report.points.${i}`, {
                      securityEmail: () => <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>,
                      securitytxt: (c) => <a href="/.well-known/security.txt">{c}</a>,
                    })}
                  </li>
                ))}
              </ul>
              <p>{t.rich('report.safeHarbor', richTags)}</p>
            </LegalSection>

            {/* Who runs this */}
            <LegalSection id="who-runs-this" title={t('operator.title')}>
              <p>
                {t.rich('operator.p1', {
                  ...richTags,
                  gh: (c) => (
                    <a href={MAINTAINER_URL} target="_blank" rel="noopener noreferrer">
                      <code>{c}</code>
                    </a>
                  ),
                  about: (c) => <a href="/about">{c}</a>,
                  terms: (c) => <a href="/terms">{c}</a>,
                })}
              </p>
              <p>
                {t.rich('operator.p2', {
                  ...richTags,
                  selfhostpage: (c) => <a href="/self-hosting">{c}</a>,
                })}
              </p>
              <p style={{ margin: 0 }}>{t('operator.p3')}</p>
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
            <a className="btn btn-primary btn-lg" href={`mailto:${SECURITY_EMAIL}`}>
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
        .legal-body { font-family: var(--font-sans); color: var(--fg-1); line-height: 1.75; }
        .legal-section { margin-bottom: 56px; padding-bottom: 56px; border-bottom: 1px solid var(--border-1); }
        .legal-section:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
        .legal-section h2 { font-size: 22px; font-weight: 700; color: var(--fg-0); margin: 0 0 20px; scroll-margin-top: 80px; }
        .legal-section p { font-size: 15px; margin: 0 0 16px; color: var(--fg-2); }
        .legal-section ul { margin: 0 0 16px 0; padding-left: 20px; }
        .legal-section ul li { font-size: 15px; color: var(--fg-2); margin-bottom: 10px; line-height: 1.65; }
        .legal-section a { color: var(--cobalt-600); text-decoration: underline; text-underline-offset: 2px; }
        .legal-section a:hover { color: var(--cobalt-700); }
        .legal-section code { font-family: var(--font-mono); font-size: 0.88em; background: var(--bg-sunken); padding: 1px 5px; border-radius: 4px; color: var(--fg-1); }
        .legal-table-wrap { overflow-x: auto; margin: 20px 0; border: 1px solid var(--border-1); border-radius: var(--radius-lg); }
        .legal-table { width: 100%; border-collapse: collapse; font-size: 14px; font-family: var(--font-sans); }
        .legal-table th { text-align: left; padding: 11px 16px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-3); background: var(--bg-sunken); border-bottom: 1px solid var(--border-1); }
        .legal-table td { padding: 12px 16px; color: var(--fg-2); vertical-align: top; border-bottom: 1px solid var(--border-1); line-height: 1.55; }
        .legal-table tr:last-child td { border-bottom: none; }
        .legal-table tbody tr:hover { background: var(--bg-hover); }
      `}</style>
    </div>
  );
}

/* ─── Helper ─────────────────────────────────────────────────── */

function LegalSection({ id, title, children }) {
  return (
    <div className="legal-section" id={id}>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
