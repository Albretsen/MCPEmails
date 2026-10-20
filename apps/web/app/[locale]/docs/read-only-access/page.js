import { Fragment } from 'react';
import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { metaAlternates, localePath, APP_URL, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { Nav, Footer } from '../../../../components/marketing/Sections';
import { EVIDENCE_LINKS, readOnlyAccessCopy } from './content.mjs';
import { withReadingLang } from '@/i18n/reading-lang.mjs';

/**
 * What a read-only connection can and cannot do, and how each limit is
 * enforced. Written for the people who ask before connecting a mailbox
 * ("does reading mark my mail as read?", "can I keep SMTP out of it?"), so the
 * answer is one link instead of a code dive. Every claim is traced to code in
 * content.mjs.
 *
 * Server-rendered from content.mjs rather than messages/, so none of this copy
 * is serialised into other pages.
 */
const PATH = '/docs/read-only-access';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const { meta } = readOnlyAccessCopy(locale);
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

/** `code` and **bold** in a copy string, and nothing else. */
function Inline({ text }) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="t-code-inline">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export default async function ReadOnlyAccessPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const copy = readOnlyAccessCopy(locale);
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
          </div>
        </section>

        {copy.sections.map((section) => (
          <section className="section" id={section.id} key={section.id} style={{ paddingTop: 40, paddingBottom: 0 }}>
            <div className="container" style={{ maxWidth: 760 }}>
              <h2 className="providers-h2">{section.h}</h2>
              <ul className="read-only-list">
                {section.items.map((item, i) => (
                  <li key={i}><Inline text={item} /></li>
                ))}
              </ul>
            </div>
          </section>
        ))}

        <section className="section" id="evidence" style={{ paddingTop: 40 }}>
          <div className="container" style={{ maxWidth: 760 }}>
            <h2 className="providers-h2">{copy.evidence.h}</h2>
            <p>{copy.evidence.intro}</p>
            <ul className="read-only-list">
              {EVIDENCE_LINKS.map((link) => (
                <li key={link.key}>
                  <a href={link.href} rel="noopener" target="_blank">
                    <code className="t-code-inline">{link.file}</code>
                  </a>
                  {' '}{copy.evidence.labels[link.key]}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="section cta-band">
          <div className="container">
            <h2>{copy.cta.title}</h2>
            <p className="sub">{copy.cta.sub}</p>
            <div className="hero-cta" style={{ justifyContent: 'center' }}>
              <a className="btn btn-primary btn-lg" href={withReadingLang('/signup', locale)}>{copy.cta.button}</a>
              <Link className="btn btn-secondary btn-lg" href="/docs/providers">{copy.cta.providers}</Link>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </>
  );
}
