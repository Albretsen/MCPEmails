import { cache } from 'react';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { getSupportViewer } from '@/lib/support/viewer';
import { issueSupportFormToken } from '@/lib/support/form-token';
import { getTicketContextPreview } from '@/lib/support/context';
import { getHelpContent, SUPPORT_CATEGORIES } from '@/lib/support/help-content.mjs';
import { getHelpCenterData, seedContactForm } from '@/lib/support/help-center-data.mjs';
import { Nav, Footer } from '../../../components/marketing/Sections';
import HelpCenter from '../../../components/support/HelpCenter';
import '../../../styles/help.css';

/**
 * /help: the help center (components/support/HelpCenter.jsx) with marketing
 * chrome. The dashboard renders the same component in its own shell at
 * /dashboard/help, fed by GET /api/support/help-data.
 *
 * Articles are collapsed sections on this page (anchors `#article-<id>`), not
 * sub-routes: there is one gate and one noindex to remove at release, and the
 * search opens an article in place.
 *
 * Dynamic by nature (it reads the session and the preview cookie), so no
 * generateStaticParams. Not in the sitemap.
 */

// One session read per request, shared by generateMetadata and the page.
const viewerForRequest = cache(getSupportViewer);

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const viewer = await viewerForRequest();
  // SUPPORT_RELEASE_GATE: noindex while internal-only. Remove at release.
  const robots = { index: false, follow: false };
  if (!viewer.visible) return { robots }; // SUPPORT_RELEASE_GATE
  const content = await getHelpContent(locale);
  return {
    title: content.meta.title,
    description: content.meta.description,
    robots, // SUPPORT_RELEASE_GATE
  };
}

export default async function HelpPage({ params, searchParams }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const viewer = await viewerForRequest();
  if (!viewer.visible) notFound(); // SUPPORT_RELEASE_GATE

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
            formFooter={
              /* SUPPORT_RELEASE_GATE: staff-only preview of the signed-out form. Remove at release. */
              viewer.user ? (
                <p className="help-gate">
                  <a href="/api/support/preview">{data.copy.preview.link}</a> {data.copy.preview.note}
                </p>
              ) : (
                <p className="help-gate">
                  <a href="/api/support/preview?clear=1">{data.copy.preview.clear}</a>
                </p>
              )
            }
          />
        </div>
      </section>
      <Footer />
    </div>
  );
}
