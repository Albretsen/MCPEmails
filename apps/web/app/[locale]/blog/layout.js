import ClientMessages from '../../../components/i18n/ClientMessages';
import { requireLocale } from '@/i18n/require-locale';

/**
 * The blog index and post pages' client components read the `blog` namespace.
 * A nested provider replaces the one in app/[locale]/layout.tsx, so the shared
 * `home` and `compare` are listed again. See components/i18n/ClientMessages.jsx.
 */
export default async function Layout({ children, params }) {
  const { locale } = await params;
  requireLocale(locale);
  return <ClientMessages namespaces={['home', 'compare', 'blog']}>{children}</ClientMessages>;
}
