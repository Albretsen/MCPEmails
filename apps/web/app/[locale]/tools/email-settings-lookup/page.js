import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { metaAlternatesFor, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd } from '@/i18n/seo';
import * as L from '@/lib/tools/email-settings-lookup.mjs';
import { PROVIDERS } from '@/lib/connect/providers.mjs';
import { isViewable } from '@/lib/connect/release.mjs';
import { localizeHref } from '@/lib/blog/links.mjs';
import { getPost, getPostLocales } from '@/lib/blog/posts';
import EmailSettingsLookupView from '../../../../components/marketing/EmailSettingsLookupView';
import '../../../../styles/tools.css';

/**
 * /tools/email-settings-lookup: a free IMAP/SMTP settings lookup. The lookup
 * runs in the browser (src/lib/tools/settings-lookup.ts); this page renders the
 * copy, the explainer and the FAQ, and hands the client the provider registry.
 * Copy, links and sources live in src/lib/tools/email-settings-lookup.mjs and
 * its <locale>.json files; read the rules there before changing a claim.
 */

/** "21 October 2026" in the page's language. UTC, so the build machine's zone cannot shift the day. */
function formatDate(locale, iso) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

/**
 * The slice of providers.mjs the lookup needs, released pages only, so a
 * result never links a /connect page that 404s. Small enough to ship as props.
 */
function lookupRegistry() {
  return PROVIDERS.filter((p) => isViewable(p)).map((p) => ({
    slug: p.slug,
    name: p.name,
    domain: p.domain,
    status: p.status,
    imap: p.imap,
    smtp: p.smtp,
    locales: p.locales,
  }));
}

const postLocales = (slug) => {
  const post = getPost(slug);
  return post ? getPostLocales(post) : [];
};

export function generateStaticParams() {
  return L.LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const c = await L.getLookupContent(locale);
  if (!c) return {};
  const { title, description } = c.meta;
  return {
    title,
    description,
    alternates: metaAlternatesFor(locale, L.PATH, L.LOCALES),
    openGraph: {
      type: 'website',
      url: localePath(locale, L.PATH),
      title: `${title} · MCPEmails`,
      description,
      locale: OG_LOCALE[locale],
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

export default async function EmailSettingsLookupPage({ params }) {
  const { locale } = await params;
  const c = await L.getLookupContent(locale);
  if (!c) notFound();
  setRequestLocale(locale);

  const url = localePath(locale, L.PATH);
  const base = pageJsonLd(locale, { path: L.PATH, title: c.meta.title, description: c.meta.description });
  const [webPage, ...rest] = base['@graph'];
  const jsonLd = {
    ...base,
    '@graph': [
      { ...webPage, datePublished: L.DATE_PUBLISHED, dateModified: L.DATE_MODIFIED },
      ...rest,
      {
        '@type': 'WebApplication',
        '@id': `${url}#tool`,
        name: c.hero.title,
        url,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript',
        isAccessibleForFree: true,
        inLanguage: locale,
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        mainEntity: c.faq.items.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: L.plainText(f.a) },
        })),
      },
    ],
  };

  const href = (key) => localizeHref(L.LINKS[key], locale, { postLocales });

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <EmailSettingsLookupView
        c={c}
        locale={locale}
        registry={lookupRegistry()}
        href={href}
        checkedOn={formatDate(locale, L.CHECKED_ON)}
      />
    </>
  );
}
