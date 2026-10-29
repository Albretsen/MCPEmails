import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { metaAlternates, localePath, APP_URL, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { withReadingLang } from '@/i18n/reading-lang.mjs';
import { PLANS } from '@/lib/stripe/plans';
import { Nav, Footer } from '../../../../components/marketing/Sections';
import { Inline, CodeBlock } from '../../../../components/marketing/DevCopy';
import { CODE, developerDocsCopy } from './content.mjs';
import { requireLocale } from '@/i18n/require-locale';

/**
 * The developer guide: how to call MCPEmails from a script, a workflow tool or
 * your own agent over plain HTTPS. The tool catalogue itself stays on /docs
 * (and in tools/list); this page is the contract around it: auth, errors,
 * retries, limits and webhooks.
 *
 * Server-rendered from content.mjs rather than messages/, so none of this copy
 * is serialised into other pages.
 */
const PATH = '/docs/api';

/** Plans in the order the pricing page shows them. */
const PLAN_ORDER = ['free', 'personal', 'solo', 'pro'];

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  const { meta } = developerDocsCopy(locale);
  return {
    title: meta.title,
    description: meta.description,
    alternates: metaAlternates(locale, PATH),
    openGraph: {
      type: 'article',
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

/**
 * Whether a plan includes webhooks. Read from the plan catalogue once the
 * webhooks PR adds `webhooksEnabled`; until then Pro (`solo`) and Business
 * (`pro`), the plans that PR gates them to.
 */
function planHasWebhooks(plan) {
  if (typeof plan.limits.webhooksEnabled === 'boolean') return plan.limits.webhooksEnabled;
  return plan.id === 'solo' || plan.id === 'pro';
}

function PlanTable({ copy, locale }) {
  const nf = new Intl.NumberFormat(locale);
  return (
    <div className="dev-table-wrap">
      <table className="dev-table">
        <thead>
          <tr>{copy.planTable.head.map((h) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {PLAN_ORDER.map((id) => {
            const plan = PLANS[id];
            return (
              <tr key={id}>
                <td>{plan.name}</td>
                <td>{nf.format(plan.limits.maxRequestsPerMinute)}</td>
                <td>{planHasWebhooks(plan) ? copy.planTable.yes : copy.planTable.no}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Block({ block, copy, locale }) {
  if (block.h3) return <h3 className="dev-h3">{block.h3}</h3>;
  if (block.p) return <p className="dev-p"><Inline text={block.p} /></p>;
  if (block.items) {
    return (
      <ul className="read-only-list">
        {block.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}
      </ul>
    );
  }
  if (block.code) {
    return <CodeBlock label={copy.codeLabels[block.lang] ?? block.lang} code={CODE[block.code]} />;
  }
  if (block.table) {
    return (
      <div className="dev-table-wrap">
        <table className="dev-table">
          <thead>
            <tr>{block.table.head.map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {block.table.rows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j}><Inline text={cell} /></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.planTable) return <PlanTable copy={copy} locale={locale} />;
  return null;
}

export default async function DeveloperDocsPage({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  setRequestLocale(locale);
  const copy = developerDocsCopy(locale);
  const url = localePath(locale, PATH);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': url,
        url,
        headline: copy.meta.title,
        description: copy.meta.description,
        inLanguage: locale,
        isPartOf: { '@id': `${APP_URL}/#website` },
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'MCPEmails', item: localePath(locale, '') },
          { '@type': 'ListItem', position: 2, name: 'Docs', item: localePath(locale, '/docs') },
          { '@type': 'ListItem', position: 3, name: copy.breadcrumb },
        ],
      },
    ],
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div>
        <Nav />

        <section className="pricing-page-hero">
          <div className="container">
            <div className="eye-label">{copy.eyebrow}</div>
            <h1 className="pricing-page-h1">{copy.title}</h1>
            <p className="pricing-page-lead">{copy.lead}</p>
            <nav className="dev-toc" aria-label={copy.toc}>
              {copy.sections.map((section) => (
                <a key={section.id} href={`#${section.id}`}>{section.h}</a>
              ))}
            </nav>
          </div>
        </section>

        {copy.sections.map((section) => (
          <section className="section" id={section.id} key={section.id} style={{ paddingTop: 40, paddingBottom: 0 }}>
            <div className="container" style={{ maxWidth: 820 }}>
              <h2 className="providers-h2">{section.h}</h2>
              {section.blocks.map((block, i) => (
                <Block key={i} block={block} copy={copy} locale={locale} />
              ))}
            </div>
          </section>
        ))}

        <section className="section cta-band" style={{ marginTop: 64 }}>
          <div className="container">
            <h2>{copy.cta.title}</h2>
            <p className="sub">{copy.cta.sub}</p>
            <div className="hero-cta">
              <a className="btn btn-primary btn-lg" href={withReadingLang('/signup', locale)}>{copy.cta.button}</a>
              <Link className="btn btn-secondary btn-lg" href="/pricing">{copy.cta.pricing}</Link>
              <Link className="btn btn-secondary btn-lg" href="/developers">{copy.cta.developers}</Link>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </>
  );
}
