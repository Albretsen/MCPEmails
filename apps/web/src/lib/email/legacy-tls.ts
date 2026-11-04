import { constants } from 'crypto';

/**
 * Mail servers that cannot complete a TLS handshake with OpenSSL 3's defaults.
 *
 * docomo mail (imap.spmode.ne.jp, imap2.spmode.ne.jp for iOS, smtp.spmode.ne.jp)
 * does not support secure renegotiation (RFC 5746). OpenSSL 3, which Node uses,
 * refuses such a server with ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED before
 * a single IMAP or SMTP byte is exchanged, so a docomo user with correct
 * settings could never connect from the web app. Deno (mcp-server) connects to
 * the same hosts without complaint. Checked live with Node, Python and Deno on
 * 2026-11-04.
 *
 * SSL_OP_LEGACY_SERVER_CONNECT only allows the initial handshake with a server
 * that lacks the renegotiation extension. It does not touch certificate
 * verification: `rejectUnauthorized` stays true and the certificate must still
 * match the hostname. It is still a weaker setting than the default, so it is
 * applied to this exact list of hostnames and to nothing else: no suffix
 * matching, and never to an address or a host typed with a different spelling.
 */
export const LEGACY_RENEGOTIATION_HOSTS: ReadonlySet<string> = new Set([
  'imap.spmode.ne.jp',
  'imap2.spmode.ne.jp',
  'smtp.spmode.ne.jp',
]);

/**
 * Extra `tls.connect` options for `servername`: the certificate name of the
 * server, never a pinned IP. Empty for every host not in the list above.
 */
export function legacyTlsOptions(servername: string | null | undefined): { secureOptions?: number } {
  const host = String(servername ?? '').trim().toLowerCase().replace(/\.$/, '');
  return LEGACY_RENEGOTIATION_HOSTS.has(host) ? { secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT } : {};
}
