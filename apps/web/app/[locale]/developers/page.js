import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, developersJsonLd } from '@/i18n/seo';
import { withReadingLang } from '@/i18n/reading-lang.mjs';
import { Nav, Footer } from '../../../components/marketing/Sections';
import { Inline, CodeBlock } from '../../../components/marketing/DevCopy';
import { CODE } from '../docs/api/content.mjs';
import { developersCopy } from './content.mjs';

/**
 * The developer landing page: what MCPEmails is to someone wiring scripts,
 * workflow tools or their own agents to email. The contract itself lives in
 * the guide at /docs/api; this page says why and links there.
 *
 * Server-rendered from content.mjs rather than messages/, so none of this copy
 * is serialised into other pages.
 */
const PATH = '/developers';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const { meta } = developersCopy(locale);
  return {
    title: meta.title,
    description: meta.description,
    alternates: metaAlternates(locale, PATH),
    openGraph: {
      type: 'website',
      url: localePath(locale, PATH),
      title: `${meta.title} · MCPEmails`,
      description: meta.description,
      locale: OG_LOCALE[locale],
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${meta.title} · MCPEmails`,
      description: meta.description,
      images: [OG_IMAGE.url],
    },
  };
}

export default async function DevelopersPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const copy = developersCopy(locale);
  const jsonLd = developersJsonLd(locale, {
    title: copy.breadcrumb,
    description: copy.meta.description,
    featureList: copy.featureList,
  });

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div>
        <Nav />

        <section className="pricing-page-hero">
          <div className="container">
            <div className="eye-label">{copy.hero.eyebrow}</div>
            <h1 className="pricing-page-h1">{copy.hero.title}</h1>
            <p className="pricing-page-lead">{copy.hero.lead}</p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Link className="btn btn-primary btn-lg" href="/docs/api">{copy.hero.primary}</Link>
              <Link className="btn btn-secondary btn-lg" href="/pricing">{copy.hero.secondary}</Link>
            </div>
          </div>
        </section>

        <section className="section" id="why" style={{ paddingTop: 40, paddingBottom: 0 }}>
          <div className="container">
            <h2 className="providers-h2">{copy.why.h}</h2>
            <div className="dev-grid">
              {copy.why.cards.map((card) => (
                <div className="dev-card" key={card.h}>
                  <h3>{card.h}</h3>
                  <p><Inline text={card.p} /></p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="how" style={{ paddingTop: 56, paddingBottom: 0 }}>
          <div className="container" style={{ maxWidth: 820 }}>
            <h2 className="providers-h2">{copy.how.h}</h2>
            <ol className="read-only-list">
              {copy.how.steps.map((step, i) => <li key={i}><Inline text={step} /></li>)}
            </ol>
            <CodeBlock label={copy.how.codeLabel} code={CODE.toolsCall} />
          </div>
        </section>

        <section className="section" id="uses" style={{ paddingTop: 56, paddingBottom: 0 }}>
          <div className="container" style={{ maxWidth: 820 }}>
            <h2 className="providers-h2">{copy.uses.h}</h2>
            <ul className="read-only-list">
              {copy.uses.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}
            </ul>
          </div>
        </section>

        <section className="section cta-band" style={{ marginTop: 64 }}>
          <div className="container">
            <h2>{copy.cta.title}</h2>
            <p className="sub">{copy.cta.sub}</p>
            <div className="hero-cta" style={{ justifyContent: 'center' }}>
              <a className="btn btn-primary btn-lg" href={withReadingLang('/signup', locale)}>{copy.cta.button}</a>
              <Link className="btn btn-secondary btn-lg" href="/docs/api">{copy.cta.guide}</Link>
              <Link className="btn btn-secondary btn-lg" href="/pricing">{copy.cta.pricing}</Link>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </>
  );
}
