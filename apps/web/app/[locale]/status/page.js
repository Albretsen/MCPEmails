import { setRequestLocale } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd } from '@/i18n/seo';
import { routing } from '@/i18n/routing';
import { getStatusContent } from '@/lib/status/content.mjs';
import { getStatusSnapshot } from '@/lib/status/monitor';
import { Nav, Footer } from '../../../components/marketing/Sections';
import StatusView, { StatusBanner } from '../../../components/marketing/StatusView';
import '../../../styles/status.css';

/**
 * The public status page.
 *
 * mailmcp.io publishes one and puts an uptime figure on their home page. For a
 * product that asks a stranger to hand over mailbox credentials, a status page
 * is the cheapest trust signal there is, but only while every number on it is
 * one we actually recorded. See lib/status/monitor.ts for the source and for
 * the several places that refuse to print a figure rather than estimate one.
 *
 * WHAT ACTUALLY DOES THE CACHING. `revalidate` here is a statement of intent
 * that today buys nothing: nothing under app/[locale] is prerendered, because
 * the shared root layout awaits getLocale() above this segment and forces a
 * dynamic render (see the long note in proxy.ts). The load-bearing cache is the
 * `unstable_cache` around the snapshot itself, which holds one reading for the
 * monitor's own five minute cadence and is shared by all five locales, so a
 * page hit costs a cache lookup rather than three dozen queries. If the
 * marketing routes are ever made genuinely static, this line starts working too
 * and the two windows already agree.
 */
export const revalidate = 300;

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const content = await getStatusContent(locale);
  const { title, description } = content.meta;
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/status'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/status'),
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

export default async function StatusPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [content, snapshot] = await Promise.all([
    getStatusContent(locale),
    getStatusSnapshot(),
  ]);
  const jsonLd = pageJsonLd(locale, {
    path: '/status',
    title: content.meta.title,
    description: content.meta.description,
  });

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Nav />

      <section className="pricing-page-hero" style={{ paddingBottom: 40 }}>
        <div className="container" style={{ maxWidth: 860 }}>
          <div className="eye-label">{content.hero.eyebrow}</div>
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>
            {content.hero.title}
          </h1>
          <p className="pricing-page-lead" style={{ maxWidth: 660 }}>
            {content.hero.lead}
          </p>
          <StatusBanner c={content} locale={locale} snapshot={snapshot} />
        </div>
      </section>

      <StatusView locale={locale} content={content} snapshot={snapshot} />

      <Footer />
    </div>
  );
}
