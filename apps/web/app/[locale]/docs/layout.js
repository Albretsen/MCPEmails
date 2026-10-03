import ClientMessages from '../../../components/i18n/ClientMessages';

/**
 * The docs index and the provider matrix read the `docs` namespace on the client.
 * A nested provider replaces the one in app/[locale]/layout.tsx, so the shared
 * `home` and `compare` are listed again. See components/i18n/ClientMessages.jsx.
 *
 * This layout also covers /docs/clients and /docs/<client>, which do not read
 * `docs`, so those pages still carry the docs catalogue (about 70 KB raw), as
 * they always did. A narrower layout under those two would NOT help: this
 * provider stays their ancestor and its messages are serialised regardless.
 * Sparing them means moving the index and providers/ into a route group with
 * its own layout.
 */
export default function Layout({ children }) {
  return <ClientMessages namespaces={['home', 'compare', 'docs']}>{children}</ClientMessages>;
}
