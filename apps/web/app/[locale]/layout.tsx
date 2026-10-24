import { setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { requireLocale } from '@/i18n/require-locale';
import ClientMessages from '../../components/i18n/ClientMessages';

/**
 * Layout for the localized marketing routes. The <html>/<body> shell and the
 * locale-only NextIntlClientProvider live in the root layout; this layer
 * validates the locale segment, enables static rendering for it, and hands the
 * browser the two message namespaces every marketing page reads on the client:
 * `home` (the shared nav and footer live in it) and `compare`.
 *
 * A section whose client components read another namespace adds its own layout
 * that lists all it needs (pricing, docs, blog, for/founders). See
 * components/i18n/ClientMessages.jsx for the rules and the test that enforces
 * them.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  requireLocale(locale);
  setRequestLocale(locale);
  return <ClientMessages namespaces={['home', 'compare']}>{children}</ClientMessages>;
}
