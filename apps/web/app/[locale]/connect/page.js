import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { metaAlternates, localePath, APP_URL, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { PROVIDER_CATEGORIES } from '@/lib/connect/providers.mjs';
import { releasedProviders } from '@/lib/connect/release.mjs';
import { routing } from '@/i18n/routing';
import { Nav, Footer } from '../../../components/marketing/Sections';
import { MIcon } from '../../../components/MarketingPrimitives';

/**
 * The hub for the provider landing pages.
 *
 * Without this page the provider pages are orphans: reachable from the sitemap
 * and from nothing else, which on a site with this backlink profile means they
 * get crawled rarely and ranked never. The hub, plus the sibling links each
 * provider page carries, is what turns 106 separate pages into one crawlable
 * silo.
 *
 * A locale only lists the providers it actually has copy for. Linking
 * /nb/connect/naver when only /connect/naver exists would manufacture 404s in
 * the one place guaranteed to be crawled.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'connect.hub' });
  // The count is whatever is actually public today, not the size of the
  // registry: during the staged rollout those differ, and a description
  // promising more providers than the page lists is a snippet that lies.
  const count = releasedProviders().filter((p) => p.locales.includes(locale)).length;
  const title = t('meta.title', { count });
  const description = t('meta.description', { count });
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/connect'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/connect'),
      title: `${title} · mcpemails`,
      description,
      locale: OG_LOCALE[locale],
      images: [OG_IMAGE],
    },
    twitter: { card: 'summary_large_image', title: `${title} · mcpemails`, description, images: [OG_IMAGE.url] },
  };
}

export default async function ConnectHubPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'connect.hub' });

  // Released pages only. The hub is the most-crawled page in the silo, so a
  // link from here into an unopened wave would be the fastest way to teach a
  // crawler that these URLs 404.
  const available = releasedProviders().filter((p) => p.locales.includes(locale));
  const groups = PROVIDER_CATEGORIES.map((c) => ({
    ...c,
    providers: available.filter((p) => p.category === c.id),
  })).filter((g) => g.providers.length > 0);
  const verifiedOn = available.find((p) => p.evidence?.verifiedOn)?.evidence.verifiedOn;
  const url = localePath(locale, '/connect');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': url,
        url,
        name: t('meta.title'),
        description: t('meta.description'),
        inLanguage: locale,
        isPartOf: { '@id': `${APP_URL}/#website` },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: available.length,
          itemListElement: available.map((p, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: p.name,
            url: localePath(locale, `/connect/${p.slug}`),
          })),
        },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'mcpemails', item: localePath(locale, '') },
          { '@type': 'ListItem', position: 2, name: t('title') },
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
            <div className="eye-label">{t('eyebrow')}</div>
            <h1 className="pricing-page-h1">{t('title')}</h1>
            <p className="pricing-page-lead">{t('lead', { count: available.length })}</p>
            <p className="pricing-page-answer">{t('answer', { count: available.length })}</p>
            {verifiedOn && (
              <p className="connect-verified" style={{ justifyContent: 'center' }}>
                <MIcon name="check" size={13} color="var(--mint-600)" />{' '}
                {t('verifiedIntro', { date: verifiedOn })}
              </p>
            )}
          </div>
        </section>

        {/* Jump list: 106 links in one column is a wall; the silos are the index. */}
        <section className="section" style={{ paddingTop: 40, paddingBottom: 0 }}>
          <div className="container">
            <ul className="connect-silo-nav">
              {groups.map((g) => (
                <li key={g.id}>
                  <a href={`#${g.anchor}`}>
                    {g.label} <span className="connect-silo-count">{g.providers.length}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {groups.map((g) => (
          <section className="section" id={g.anchor} key={g.id} style={{ paddingTop: 40, paddingBottom: 0 }}>
            <div className="container">
              <h2 className="providers-h2">{g.label}</h2>
              <ul className="connect-index">
                {g.providers.map((p) => (
                  <li key={p.slug}>
                    <Link href={`/connect/${p.slug}`}>
                      <span className="connect-index-name">{p.name}</span>
                      {p.imap && <code className="connect-index-host">{p.imap.host}</code>}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}

        <section className="section cta-band">
          <div className="container">
            <h2>{t('genericTitle')}</h2>
            <p className="sub">{t('genericSub')}</p>
            <div className="hero-cta" style={{ justifyContent: 'center' }}>
              <Link className="btn btn-primary btn-lg" href="/connect/imap">{t('genericCta')}</Link>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </>
  );
}
