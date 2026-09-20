import { setRequestLocale } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd } from '@/i18n/seo';
import { BUSINESS_PATH, getBusinessCopy } from '@/lib/personas/business.mjs';
import BusinessView from '../../../../components/marketing/BusinessView';

/**
 * Persona page for the operator who runs a company's mailboxes: one person,
 * several role addresses (info@, sales@, invoices@), one agent. Modelled on
 * /for/founders, with one difference: it renders on the server and loads its
 * copy itself, so the copy is not shipped to every other marketing page. See
 * src/lib/personas/business.mjs.
 *
 * A new marketing path also has to be listed in MARKETING_PATHS (proxy.ts) and
 * MARKETING_PAGES (app/sitemap.ts), or it 404s and is never crawled.
 */
export async function generateMetadata({ params }) {
  const { locale } = await params;
  const copy = await getBusinessCopy(locale);
  const { title, description } = copy.meta;
  return {
    title,
    description,
    alternates: metaAlternates(locale, BUSINESS_PATH),
    openGraph: {
      type: 'website',
      url: localePath(locale, BUSINESS_PATH),
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

export default async function BusinessPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const copy = await getBusinessCopy(locale);
  const jsonLd = pageJsonLd(locale, {
    path: BUSINESS_PATH,
    title: copy.meta.title,
    description: copy.meta.description,
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <BusinessView copy={copy} />
    </>
  );
}
