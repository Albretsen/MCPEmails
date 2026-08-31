import { notFound } from 'next/navigation';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, connectJsonLd } from '@/i18n/seo';
import { routing } from '@/i18n/routing';
import ConnectProviderClient from '../../../../components/marketing/ConnectProviderClient';

// Providers with a dedicated landing page. Each maps to a sub-object in the
// `connect` message namespace (connect.<provider>.*). Gmail connects via Google
// OAuth; the rest over IMAP, with either an app password or the mailbox
// password, per connect.<provider>.method.
//
// Every slug must match /connect/[a-z0-9-]+ or acquisition attribution silently
// drops the landing path (safeLandingPath in src/lib/acquisition-context.mjs,
// and the CHECK constraint on workspaces.acquisition_landing_path that mirrors
// it). Hyphens are fine, anything else is not.
//
// No Outlook / Microsoft 365 entry on purpose: the backend exists but the
// provider card is disabled, because Microsoft's default tenant policy blocks
// end-user Mail.ReadWrite consent. A landing page would advertise a connection
// that cannot be made. Proton is absent for the same reason: its IMAP lives
// behind Proton Bridge on the user's own machine, which a hosted server can
// never reach.
const PROVIDERS = [
  // OAuth.
  'gmail',
  // The generic connector, and the largest cohort of connected inboxes.
  'imap',
  // Branded consumer services with a preset in imap-presets.ts.
  'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex',
  // Consumer services reached through the generic form.
  'gmx', 'aol', 'mail-ru', 'web-de',
  // Business and hosting mail, mostly custom domains.
  'cpanel', 'migadu', 'namecheap', 'ionos', 'ovh', 'rackspace', 'hostinger',
];

export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    PROVIDERS.map((provider) => ({ locale, provider })),
  );
}

export async function generateMetadata({ params }) {
  const { locale, provider } = await params;
  if (!PROVIDERS.includes(provider)) return {};
  const path = `/connect/${provider}`;
  const t = await getTranslations({ locale, namespace: `connect.${provider}` });
  const title = t.has('meta.title') ? t('meta.title') : 'Connect your inbox';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Connect your inbox to Claude and any MCP client. Read, send, schedule and organize email with AI.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, path),
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

export default async function ConnectProviderPage({ params }) {
  const { locale, provider } = await params;
  if (!PROVIDERS.includes(provider)) notFound();
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: `connect.${provider}` });
  const steps = t.raw('steps');
  const jsonLd = connectJsonLd(locale, {
    path: `/connect/${provider}`,
    title: t.has('meta.title') ? t('meta.title') : 'Connect your inbox',
    description: t.has('meta.description') ? t('meta.description') : '',
    howToName: t.has('how.title') ? t('how.title') : 'Connect your inbox',
    steps: Array.isArray(steps) ? steps : [],
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ConnectProviderClient provider={provider} />
    </>
  );
}
