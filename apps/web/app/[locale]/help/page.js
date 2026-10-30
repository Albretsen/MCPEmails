import { setRequestLocale } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { getSupportViewer } from '@/lib/support/viewer';
import { issueSupportFormToken } from '@/lib/support/form-token';
import { getTicketContextPreview } from '@/lib/support/context';
import { getHelpContent, SUPPORT_CATEGORIES } from '@/lib/support/help-content.mjs';
import { getHelpCenterData, seedContactForm } from '@/lib/support/help-center-data.mjs';
import { Nav, Footer } from '../../../components/marketing/Sections';
import HelpCenter from '../../../components/support/HelpCenter';
import { requireLocale } from '@/i18n/require-locale';
import '../../../styles/help.css';

/**
 * /help: the help center (components/support/HelpCenter.jsx) with marketing
 * chrome. The dashboard renders the same component in its own shell at
 * /dashboard/help, fed by GET /api/support/help-data.
 *
 * Articles are collapsed sections on this page (anchors `#article-<id>`), not
 * sub-routes, so the search opens an article in place and there is one URL to
 * index per locale.
 *
 * Dynamic by nature (it reads the session to prefill the contact form), so no
 * generateStaticParams. Listed in the sitemap.
 */

export async function generateMetadata({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  const content = await getHelpContent(locale);
  const { title, description } = content.meta;
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/help'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/help'),
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

export default async function HelpPage({ params, searchParams }) {
  const { locale } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  const viewer = await getSupportViewer();

  const sp = await searchParams;
  const [data, baseContext] = await Promise.all([
    getHelpCenterData(locale),
    viewer.user ? getTicketContextPreview(viewer.user.id) : Promise.resolve(null),
  ]);
  const seed = seedContactForm(sp, data.copy);
  const context = baseContext ? { ...baseContext, ...seed.meta } : null;

  return (
    <div>
      <Nav />
      <section className="pricing-page-hero" style={{ paddingBottom: 48 }}>
        <div className="help-wrap">
          <HelpCenter
            variant="page"
            locale={data.locale}
            copy={data.copy}
            categories={data.categories}
            index={data.index}
            supportCategories={SUPPORT_CATEGORIES}
            form={{
              signedInEmail: viewer.user?.email ?? null,
              context,
              formToken: issueSupportFormToken(),
              initialCategory: seed.initialCategory,
              initialSubject: seed.initialSubject,
              providerName: seed.providerName,
              meta: seed.meta,
              open: seed.open,
            }}
          />
        </div>
      </section>
      <Footer />
    </div>
  );
}
