import ClientMessages from '../../../components/i18n/ClientMessages';
import { requireLocale } from '@/i18n/require-locale';

/**
 * The pricing page's client components read the `pricing` namespace.
 * A nested provider replaces the one in app/[locale]/layout.tsx, so the shared
 * `home` and `compare` are listed again. See components/i18n/ClientMessages.jsx.
 */
export default async function Layout({ children, params }) {
  const { locale } = await params;
  requireLocale(locale);
  return <ClientMessages namespaces={['home', 'compare', 'pricing']}>{children}</ClientMessages>;
}
