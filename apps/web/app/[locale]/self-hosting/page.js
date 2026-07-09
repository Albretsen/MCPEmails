import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { Nav, Footer } from '../../../components/marketing/Sections';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'selfHosting' });
  const title = t.has('meta.title') ? t('meta.title') : 'Self-host MCP Emails';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Run the same MCP email server that powers mcpemails.com on your own machine. Open source under AGPL-3.0.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/self-hosting'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/self-hosting'),
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

const REPO_URL = 'https://github.com/Albretsen/MCPEmails';
const GUIDE_URL = 'https://github.com/Albretsen/MCPEmails/tree/main/self-host';
const LICENSE_URL = 'https://github.com/Albretsen/MCPEmails/blob/main/LICENSE';

const INSTALL_CMD = `git clone https://github.com/Albretsen/MCPEmails
cd MCPEmails/self-host
make setup && make up`;

/* ─── Page ───────────────────────────────────────────────────── */

export default async function SelfHostingPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('selfHosting');
  const richTags = {
    b: (c) => <strong>{c}</strong>,
    c: (c) => <code>{c}</code>,
  };

  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero" style={{ paddingBottom: 40 }}>
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
      <section className="section" style={{ paddingTop: 8, paddingBottom: 80 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="sh-body">

            {/* 1 - Proof: one command */}
            <div className="sh-section">
              <h2>{t('proof.title')}</h2>
              <pre className="sh-code"><code>{INSTALL_CMD}</code></pre>
              <p>{t.rich('proof.caption', richTags)}</p>
              <div className="sh-btns">
                <a className="btn btn-primary" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
                  {t('proof.ctaGuide')}
                </a>
                <a className="btn btn-secondary" href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  {t('proof.ctaSource')}
                </a>
              </div>
            </div>

            {/* 2 - Sovereignty */}
            <div className="sh-section">
              <h2>{t('sovereignty.title')}</h2>
              <p>{t('sovereignty.body')}</p>
            </div>

            {/* 3 - Comparison table */}
            <div className="sh-section">
              <h2>{t('compare.title')}</h2>
              <p>{t('compare.intro')}</p>
              <div className="legal-table-wrap">
                <table className="legal-table sh-compare">
                  <thead>
                    <tr>
                      <th>{t('compare.thFeature')}</th>
                      <th>{t('compare.thSelf')}</th>
                      <th className="sh-col-hosted">{t('compare.thHosted')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.raw('compare.rows').map((row, i) => (
                      <tr key={i}>
                        <td><strong>{row.feature}</strong></td>
                        <td>{row.self}</td>
                        <td className="sh-col-hosted">{row.hosted}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 4 - Security preempts */}
            <div className="sh-section">
              <h2>{t('security.title')}</h2>
              <p>{t('security.intro')}</p>
              <ul>
                {t.raw('security.points').map((item, i) => (
                  <li key={i}>{t.rich(`security.points.${i}`, richTags)}</li>
                ))}
              </ul>
            </div>

            {/* 5 - Honest commitment / who it's for */}
            <div className="sh-section">
              <h2>{t('commitment.title')}</h2>
              <p>{t('commitment.body')}</p>
              <p style={{ margin: 0 }}>
                <a href="/signup">{t('commitment.cta')}</a>
                {' · '}
                <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">AGPL-3.0</a>
              </p>
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
            <a className="btn btn-primary btn-lg" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
              {t('cta.primary')}
            </a>
            <a className="btn btn-on-dark btn-lg" href="/signup">
              {t('cta.secondary')}
            </a>
          </div>
        </div>
      </section>

      <Footer />

      <style>{`
        .sh-body { font-family: var(--font-sans); color: var(--fg-1); line-height: 1.75; }
        .sh-section { margin-bottom: 48px; padding-bottom: 48px; border-bottom: 1px solid var(--border-1); }
        .sh-section:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
        .sh-section h2 { font-size: 22px; font-weight: 700; color: var(--fg-0); margin: 0 0 16px; scroll-margin-top: 80px; }
        .sh-section p { font-size: 15px; margin: 0 0 16px; color: var(--fg-2); }
        .sh-section ul { margin: 0 0 16px 0; padding-left: 20px; }
        .sh-section ul li { font-size: 15px; color: var(--fg-2); margin-bottom: 10px; line-height: 1.65; }
        .sh-section a:not(.btn) { color: var(--cobalt-600); text-decoration: underline; text-underline-offset: 2px; }
        .sh-section a:not(.btn):hover { color: var(--cobalt-700); }
        .sh-section code { font-family: var(--font-mono); font-size: 0.88em; background: var(--bg-sunken); padding: 1px 5px; border-radius: 4px; color: var(--fg-1); }
        .sh-code { font-family: var(--font-mono); font-size: 13.5px; line-height: 1.7; background: var(--bg-sunken); border: 1px solid var(--border-1); border-radius: var(--radius-lg); padding: 16px 18px; overflow-x: auto; color: var(--fg-1); margin: 0 0 16px; }
        .sh-code code { background: none; padding: 0; font-size: inherit; color: inherit; }
        .sh-btns { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
        .legal-table-wrap { overflow-x: auto; margin: 4px 0 0; border: 1px solid var(--border-1); border-radius: var(--radius-lg); }
        .legal-table { width: 100%; border-collapse: collapse; font-size: 14px; font-family: var(--font-sans); }
        .legal-table th { text-align: left; padding: 11px 16px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-3); background: var(--bg-sunken); border-bottom: 1px solid var(--border-1); }
        .legal-table td { padding: 12px 16px; color: var(--fg-2); vertical-align: top; border-bottom: 1px solid var(--border-1); line-height: 1.55; }
        .legal-table tr:last-child td { border-bottom: none; }
        .sh-compare .sh-col-hosted { background: color-mix(in srgb, var(--cobalt-600) 6%, transparent); color: var(--fg-1); font-weight: 500; }
        .sh-compare th.sh-col-hosted { color: var(--cobalt-700); }
      `}</style>
    </div>
  );
}
