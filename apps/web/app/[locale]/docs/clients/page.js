import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { metaAlternatesFor, localePath, APP_URL, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { CLIENT_CATEGORIES, MCP_URL, clientsForLocale } from '@/lib/clients/clients.mjs';
import { clientHubLocales } from '@/lib/clients/content.mjs';
import { clientUi, fill } from '@/lib/clients/ui.mjs';
import { Nav, Footer } from '../../../../components/marketing/Sections';
import { MIcon } from '../../../../components/MarketingPrimitives';

/**
 * The hub for the per-client setup pages.
 *
 * Without it the client pages are orphans, reachable from the sitemap and from
 * nothing else, which on a site with this backlink profile means crawled rarely
 * and ranked never. The hub, plus the sibling links each client page carries,
 * is what turns thirteen separate pages into one crawlable silo. This is the
 * same argument the /connect hub is built on, and it held there.
 *
 * A locale only lists the clients it actually has copy for, and 404s when it
 * has none: linking /nb/docs/clients when no Norwegian client page exists would
 * manufacture 404s in the one place guaranteed to be crawled.
 */
export function generateStaticParams() {
  return clientHubLocales().map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const locales = clientHubLocales();
  if (!locales.includes(locale)) return {};
  const ui = clientUi(locale).hub;
  const count = clientsForLocale(locale).length;
  const title = fill(ui.meta.title, { count });
  const description = ui.meta.description;
  return {
    title,
    description,
    alternates: metaAlternatesFor(locale, '/docs/clients', locales),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/docs/clients'),
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

export default async function ClientHubPage({ params }) {
  const { locale } = await params;
  const available = clientsForLocale(locale);
  if (available.length === 0) notFound();
  setRequestLocale(locale);

  const ui = clientUi(locale).hub;
  const count = available.length;
  const oauth = available.filter((c) => c.auth === 'oauth').length;
  const groups = CLIENT_CATEGORIES.map((c) => ({
    ...c,
    clients: available.filter((x) => x.category === c.id),
  })).filter((g) => g.clients.length > 0);
  const url = localePath(locale, '/docs/clients');
  const title = fill(ui.meta.title, { count });

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': url,
        url,
        name: title,
        description: ui.meta.description,
        inLanguage: locale,
        isPartOf: { '@id': `${APP_URL}/#website` },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: count,
          itemListElement: available.map((c, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: c.name,
            url: localePath(locale, `/docs/${c.slug}`),
          })),
        },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'mcpemails', item: localePath(locale, '') },
          { '@type': 'ListItem', position: 2, name: 'Docs', item: localePath(locale, '/docs') },
          { '@type': 'ListItem', position: 3, name: ui.breadcrumb },
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
            <div className="eye-label">{ui.eyebrow}</div>
            <h1 className="pricing-page-h1">{ui.title}</h1>
            <p className="pricing-page-lead">{fill(ui.lead, { count })}</p>
            <p className="pricing-page-answer">{fill(ui.answer, { count, oauth })}</p>
            <p className="connect-verified" style={{ justifyContent: 'center' }}>
              <MIcon name="check" size={13} color="var(--mint-600)" />{' '}
              <code className="connect-host">{MCP_URL}</code>
            </p>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 40, paddingBottom: 0 }}>
          <div className="container">
            <ul className="connect-silo-nav">
              {groups.map((g) => (
                <li key={g.id}>
                  <a href={`#${g.anchor}`}>
                    {g.label} <span className="connect-silo-count">{g.clients.length}</span>
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
                {g.clients.map((c) => (
                  <li key={c.slug}>
                    <Link href={`/docs/${c.slug}`}>
                      <span className="connect-index-name">{c.name}</span>
                      <code className="connect-index-host">
                        {c.auth === 'oauth' ? ui.authOauth : ui.authKey}
                      </code>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}

        <section className="section cta-band">
          <div className="container">
            <h2>{ui.genericTitle}</h2>
            <p className="sub">{ui.genericSub}</p>
            <div className="hero-cta" style={{ justifyContent: 'center' }}>
              <Link className="btn btn-primary btn-lg" href="/docs">{ui.genericCta}</Link>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </>
  );
}
