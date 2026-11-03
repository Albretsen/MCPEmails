import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { localePath, APP_URL, OG_IMAGE } from '@/i18n/seo';
import { requireLocale } from '@/i18n/require-locale';
import { Nav, Footer } from '../../../../components/marketing/Sections';
import { PATH, DATE_MODIFIED, copy } from './content.mjs';

/**
 * The Arabic setup guide: one right-to-left page that tests whether Arabic
 * pages find people who can use the product. See content.mjs.
 *
 * Served under the English route only, because `ar` is not a locale: the other
 * locale prefixes 404, the shared nav and footer stay in English, and <html>
 * keeps lang="en", so the Arabic is marked on <main> instead. Signups need no
 * tagging of their own: acquisition-context.mjs already keeps this path as the
 * landing page, and the signup trigger and CHECK constraint already accept it.
 */
const LOCALES = ['en'];

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  if (!LOCALES.includes(locale)) return {};
  const url = localePath(locale, PATH);
  const { title, description } = copy.meta;
  return {
    title,
    description,
    alternates: { canonical: url, languages: { ar: url } },
    openGraph: {
      type: 'article',
      url,
      title: `${title} · MCPEmails`,
      description,
      locale: 'ar_AR',
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · MCPEmails`,
      description,
      images: [OG_IMAGE.url],
    },
  };
}

/**
 * `code`, **bold** and [text](url) in a copy string. Every English label and
 * address is isolated as left-to-right, or the bidi algorithm reorders the
 * punctuation around it.
 */
function Inline({ text }) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/).map((part, i) => {
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      return link[2] === '/signup'
        ? <a key={i} href="/signup">{link[1]}</a>
        : <Link key={i} href={link[2]}>{link[1]}</Link>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <bdi key={i} dir="ltr"><code className="t-code-inline">{part.slice(1, -1)}</code></bdi>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <bdi key={i} dir="ltr"><strong>{part.slice(2, -2)}</strong></bdi>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function List({ section }) {
  const Tag = section.ordered ? 'ol' : 'ul';
  return (
    <Tag className="read-only-list">
      {section.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}
    </Tag>
  );
}

export default async function ClaudeEmailArabicPage({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  if (!LOCALES.includes(locale)) notFound();
  setRequestLocale(locale);
  const url = localePath(locale, PATH);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    '@id': url,
    url,
    headline: copy.meta.title,
    description: copy.meta.description,
    inLanguage: 'ar',
    dateModified: DATE_MODIFIED,
    isPartOf: { '@id': `${APP_URL}/#website` },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div>
        <Nav />

        <main lang="ar" dir="rtl" className="ar-guide">
          <section className="pricing-page-hero">
            <div className="container">
              <div className="eye-label">{copy.eyebrow}</div>
              <h1 className="pricing-page-h1">{copy.title}</h1>
              <p className="pricing-page-lead">{copy.lead}</p>
              <p className="ar-guide-answer"><Inline text={copy.answer} /></p>
            </div>
          </section>

          {copy.sections.map((section) => (
            <section className="section" id={section.id} key={section.id} style={{ paddingTop: 40, paddingBottom: 0 }}>
              <div className="container" style={{ maxWidth: 760 }}>
                <h2 className="providers-h2">{section.h}</h2>
                {section.lead ? <p><Inline text={section.lead} /></p> : null}
                {section.items ? <List section={section} /> : null}
                {section.prompts ? (
                  <ul className="read-only-list">
                    {section.prompts.map((prompt) => <li key={prompt}>{prompt}</li>)}
                  </ul>
                ) : null}
                {section.note ? <p><Inline text={section.note} /></p> : null}
              </div>
            </section>
          ))}

          <section className="section cta-band" style={{ marginTop: 40 }}>
            <div className="container">
              <h2>{copy.cta.title}</h2>
              <p className="sub">{copy.cta.sub}</p>
              <div className="hero-cta">
                <a className="btn btn-primary btn-lg" href="/signup">{copy.cta.button}</a>
              </div>
            </div>
          </section>
        </main>

        <Footer />
      </div>
    </>
  );
}
