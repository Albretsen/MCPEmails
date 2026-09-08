import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { metaAlternatesFor, localePath, OG_LOCALE, OG_IMAGE, connectJsonLd } from '@/i18n/seo';
import { getClient, clientLocales } from '@/lib/clients/clients.mjs';
import { getClientContent, clientParams } from '@/lib/clients/content.mjs';
import { clientUi, fill } from '@/lib/clients/ui.mjs';
import { stripTags } from '../../../../components/marketing/RichText';
import ClientSetupView from '../../../../components/marketing/ClientSetupView';

/**
 * One setup page per MCP client, at /docs/<slug>.
 *
 * "Connect email to Claude Code" and its siblings are the highest-intent
 * queries in this category and we ranked on none of them, because the only
 * per-client instructions we had lived inside the signed-in dashboard where no
 * crawler can reach them. This route is that same registry, published.
 *
 * The static siblings under /docs (currently /docs/providers, and /docs/clients
 * added alongside this) take precedence over this dynamic segment, so a slug
 * that collides with one of them is unreachable here. Nothing in the client
 * registry collides today; check before adding one that might.
 *
 * Every slug matches /docs/[a-z0-9-]+, which safeLandingPath in
 * src/lib/acquisition-context.mjs already accepts under its /docs rule, so
 * these pages are attributed rather than bucketed into /other.
 */
export function generateStaticParams() {
  return clientParams();
}

export async function generateMetadata({ params }) {
  const { locale, client: slug } = await params;
  const client = getClient(slug);
  const content = await getClientContent(locale, slug);
  if (!client || !content) return {};
  const path = `/docs/${slug}`;
  const { title, description } = content.meta;
  return {
    title,
    description,
    alternates: metaAlternatesFor(locale, path, clientLocales(slug)),
    openGraph: {
      type: 'website',
      url: localePath(locale, path),
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

export default async function ClientSetupPage({ params }) {
  const { locale, client: slug } = await params;
  const client = getClient(slug);
  if (!client) notFound();
  setRequestLocale(locale);

  // A locale with no copy for this client gets a 404 rather than an English
  // page under a Norwegian URL. The hreflang alternates are built from the same
  // list, so the two cannot disagree.
  const content = await getClientContent(locale, slug);
  if (!content) notFound();

  const ui = clientUi(locale).page;
  const jsonLd = connectJsonLd(locale, {
    path: `/docs/${slug}`,
    title: content.meta.title,
    description: content.meta.description,
    howToName: fill(ui.how.title, { client: client.name }),
    steps: content.setup.map((s) => ({ h: s.h, p: stripTags(s.p) })),
    faq: (content.faq ?? []).map((f) => ({ q: f.q, a: stripTags(f.a) })),
    connectLabel: ui.breadcrumb,
    hubPath: '/docs/clients',
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ClientSetupView locale={locale} client={client} content={content} />
    </>
  );
}
