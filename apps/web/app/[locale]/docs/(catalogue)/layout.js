import ClientMessages from '../../../../components/i18n/ClientMessages';
import { requireLocale } from '@/i18n/require-locale';

/**
 * The docs index (/docs) and the provider matrix (/docs/providers) are the only
 * docs pages whose client code reads the `docs` namespace (DocsClient and
 * ProvidersClient). This route group hands just those two the docs catalogue,
 * about 70 KB raw in English. The other docs pages (/docs/clients,
 * /docs/<client>, /docs/read-only-access) sit outside the group and get only
 * the shared `home` and `compare` from app/[locale]/layout.tsx.
 *
 * A nested provider replaces the one above it, so `home` and `compare` are
 * listed again. See components/i18n/ClientMessages.jsx.
 */
export default async function Layout({ children, params }) {
  const { locale } = await params;
  requireLocale(locale);
  return <ClientMessages namespaces={['home', 'compare', 'docs']}>{children}</ClientMessages>;
}
