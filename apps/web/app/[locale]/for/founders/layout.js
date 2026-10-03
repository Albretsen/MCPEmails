import ClientMessages from '../../../../components/i18n/ClientMessages';

/**
 * The founders page's client component reads the `forFounders` namespace.
 * A nested provider replaces the one in app/[locale]/layout.tsx, so the shared
 * `home` and `compare` are listed again. See components/i18n/ClientMessages.jsx.
 */
export default function Layout({ children }) {
  return <ClientMessages namespaces={['home', 'compare', 'forFounders']}>{children}</ClientMessages>;
}
