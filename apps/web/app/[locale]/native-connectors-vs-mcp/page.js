import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd, APP_URL } from '@/i18n/seo';
import * as N from '@/lib/compare/native-connectors.mjs';
import CompareClient from '../../../components/marketing/CompareClient';
import { requireLocale } from '@/i18n/require-locale';

/**
 * /native-connectors-vs-mcp: Claude's and ChatGPT's built-in connectors and the
 * mail providers' own MCP servers, against an MCP server that spans providers.
 * Facts, sources and dates live in src/lib/compare/native-connectors.mjs; read
 * its rules before changing a claim. Sibling of /best-email-mcp-servers, which
 * ranks the MCP servers themselves.
 */

/** "19 October 2026" in the page's language. UTC, so build machine time zones cannot shift the day. */
function formatDate(locale, iso) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  const c = await N.getNativeContent(locale);
  if (!c) return {};
  const { title, description } = c.meta;
  return {
    title,
    description,
    alternates: metaAlternates(locale, N.PATH),
    openGraph: {
      type: 'article',
      url: localePath(locale, N.PATH),
      title: `${title} · MCPEmails`,
      description,
      locale: OG_LOCALE[locale],
      images: [OG_IMAGE],
      modifiedTime: N.DATE_MODIFIED,
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · MCPEmails`,
      description,
      images: [OG_IMAGE.url],
    },
  };
}

export default async function ComparePage({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  const c = await N.getNativeContent(locale);
  if (!c) notFound();
  setRequestLocale(locale);

  const url = localePath(locale, N.PATH);
  const base = pageJsonLd(locale, { path: N.PATH, title: c.meta.title, description: c.meta.description });
  const [webPage, ...rest] = base['@graph'];
  const jsonLd = {
    ...base,
    '@graph': [
      // Dates on the WebPage itself: an undated comparison is one an answer
      // engine cannot tell from a stale one.
      { ...webPage, datePublished: N.DATE_PUBLISHED, dateModified: N.DATE_MODIFIED },
      ...rest,
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        mainEntity: c.faq.items.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'WebPage',
        '@id': `${url}#sources`,
        url: `${url}#sources`,
        name: c.sources.title,
        isPartOf: { '@id': `${APP_URL}/#website` },
        citation: N.SOURCES.map((s) => ({
          '@type': 'CreativeWork',
          name: c.sources.items[s.id],
          url: s.url,
        })),
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <CompareClient c={c} checkedOn={formatDate(locale, N.CHECKED_ON)} isEnglish={locale === 'en'} locale={locale} />
    </>
  );
}
