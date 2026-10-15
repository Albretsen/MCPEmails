import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { routing } from '@/i18n/routing';
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
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  return <ClientMessages namespaces={['home', 'compare']}>{children}</ClientMessages>;
}
