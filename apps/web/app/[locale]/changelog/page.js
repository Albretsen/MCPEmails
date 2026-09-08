import { setRequestLocale } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd, APP_URL } from '@/i18n/seo';
import { getEntriesByMonth, getEntries, getLatestDate } from '@/lib/changelog/entries.mjs';
import { getChangelogCopy } from '@/lib/changelog/copy.mjs';
import ChangelogView from '../../../components/marketing/ChangelogView';

/**
 * /changelog: the public record of what has shipped.
 *
 * The page is a static render of src/lib/changelog/entries.mjs. Its chrome is
 * localized from src/lib/changelog/copy.mjs rather than from `messages/`,
 * because every namespace under `messages/` is serialised into the HTML of
 * every marketing page (see the note at the top of copy.mjs).
 *
 * The chrome exists in all five locales, so all five are legitimate hreflang
 * alternates here, exactly as on the blog index whose post titles are likewise
 * English until a post is translated.
 */

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const copy = getChangelogCopy(locale);
  const { title, description } = copy.meta;
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/changelog'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/changelog'),
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

export default async function ChangelogPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const copy = getChangelogCopy(locale);
  const months = getEntriesByMonth();
  const url = localePath(locale, '/changelog');
  const latest = getLatestDate();

  // WebPage + BreadcrumbList (the shape every other static marketing page
  // emits), plus an ItemList of the releases themselves so an assistant asked
  // "what is new in mcpemails" has something machine readable to read. Every
  // item mirrors visible page content; nothing is claimed here that the list
  // above does not already say.
  const base = pageJsonLd(locale, {
    path: '/changelog',
    title: copy.meta.title,
    description: copy.meta.description,
  });
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      ...base['@graph'].map((node) =>
        node['@type'] === 'WebPage' && latest ? { ...node, dateModified: latest } : node,
      ),
      {
        '@type': 'ItemList',
        '@id': `${url}#releases`,
        name: copy.meta.title,
        itemListOrder: 'https://schema.org/ItemListOrderDescending',
        numberOfItems: getEntries().length,
        itemListElement: getEntries().map((entry, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'CreativeWork',
            name: entry.title,
            abstract: entry.body,
            datePublished: entry.date,
            inLanguage: 'en',
            isPartOf: { '@id': `${APP_URL}/#website` },
          },
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
      <ChangelogView locale={locale} copy={copy} months={months} />
    </>
  );
}
