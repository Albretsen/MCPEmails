/**
 * The server name a mail server's certificate is actually issued to.
 *
 * Shared hosting puts many domains on one machine with one certificate:
 * `mail.example.pl` is a DNS alias for `s28.kylos.pl`, and the certificate
 * names only the latter. Typing the alias (which is what most people do) fails
 * the certificate check on every port, and no port or security setting fixes
 * it. The fix is the server's real name, which we can find ourselves.
 *
 * A candidate is used only when BOTH hold:
 *   - the certificate the server just presented is valid for it, by Node's
 *     own `checkServerIdentity` (the chain was already verified, since the
 *     name check runs after it), and
 *   - it resolves to the address we dialled, so it is the same machine.
 * The retry then runs with full certificate validation against the new name,
 * so nothing about TLS is weakened: we only pick a name the server proves.
 *
 * Candidates, best first: the CNAME chain of the typed host (the provider's
 * own name for it), reverse DNS of the address, then the plain (non-wildcard)
 * names on the certificate.
 */
import { promises as dnsPromises } from 'node:dns';
import tls from 'node:tls';

/** The parts of a peer certificate the name check reads. */
export interface CertNameSource {
  subject?: { CN?: string | string[] } | null;
  subjectaltname?: string;
}

/** Every DNS name on a certificate, lower-cased, SANs first, without duplicates. */
export function certificateNames(cert: CertNameSource | null | undefined): string[] {
  if (!cert) return [];
  const names: string[] = [];
  for (const part of String(cert.subjectaltname ?? '').split(',')) {
    const match = /^\s*DNS:(.+)$/i.exec(part);
    if (match) names.push(match[1].trim().toLowerCase());
  }
  const cn = cert.subject?.CN;
  for (const value of Array.isArray(cn) ? cn : cn ? [cn] : []) names.push(String(value).trim().toLowerCase());
  return [...new Set(names.filter((name) => /^[a-z0-9*.-]+$/.test(name) && name.length <= 253))];
}

/**
 * The name to show a user when no alias could be proven: the first plain name,
 * else the first wildcard (`*.fsi.pl`), else null.
 */
export function displayCertHost(names: readonly string[]): string | null {
  return names.find((name) => !name.startsWith('*.')) ?? names[0] ?? null;
}

export interface CertAliasDeps {
  resolveCname: (host: string) => Promise<string[]>;
  reverse: (address: string) => Promise<string[]>;
  lookup: (host: string) => Promise<string[]>;
}

const defaultDeps: CertAliasDeps = {
  resolveCname: (host) => dnsPromises.resolveCname(host),
  reverse: (address) => dnsPromises.reverse(address),
  lookup: async (host) => (await dnsPromises.lookup(host, { all: true })).map((entry) => entry.address),
};

const settle = async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await promise;
  } catch {
    return fallback;
  }
};

const normalize = (name: string) => name.trim().toLowerCase().replace(/\.$/, '');

/**
 * The name to retry with, or null when none is proven.
 *
 * `address` is the IP that was dialled (the host guard's pinned address).
 * Without it there is no "same machine" to compare against, so nothing is
 * returned.
 */
export async function findCertHostAlias(
  input: { host: string; address: string | null | undefined; cert: CertNameSource | null | undefined },
  deps: CertAliasDeps = defaultDeps,
): Promise<string | null> {
  const host = normalize(input.host);
  const address = input.address ?? '';
  const cert = input.cert;
  if (!address || !cert) return null;

  // Follow the CNAME chain a few hops: a.example -> b.host -> s28.host.
  const cnames: string[] = [];
  let current = host;
  for (let hop = 0; hop < 4; hop += 1) {
    const next = (await settle(deps.resolveCname(current), [] as string[]))[0];
    if (!next) break;
    current = normalize(next);
    if (cnames.includes(current)) break;
    cnames.push(current);
  }
  const ptr = (await settle(deps.reverse(address), [] as string[])).map(normalize);
  const plainCertNames = certificateNames(cert).filter((name) => !name.startsWith('*.'));

  const seen = new Set<string>([host]);
  const candidates: string[] = [];
  for (const name of [...cnames, ...ptr, ...plainCertNames]) {
    if (!name || seen.has(name) || !/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(name)) continue;
    seen.add(name);
    candidates.push(name);
  }

  for (const name of candidates.slice(0, 8)) {
    // The certificate must be valid for the name exactly as a TLS client sees it.
    if (tls.checkServerIdentity(name, cert as tls.PeerCertificate) !== undefined) continue;
    const addresses = await settle(deps.lookup(name), [] as string[]);
    if (addresses.includes(address)) return name;
  }
  return null;
}

/** True for Node's certificate-name error, which carries the peer certificate. */
export function certFromNameMismatch(error: unknown): CertNameSource | null {
  const e = error as { code?: string; cert?: CertNameSource } | null;
  return e?.code === 'ERR_TLS_CERT_ALTNAME_INVALID' && e.cert ? e.cert : null;
}

/** The route's message for a certificate that names another host. */
export function certNameMessage(host: string, cert: CertNameSource): string {
  const certHost = displayCertHost(certificateNames(cert));
  return certHost
    ? `The server's security certificate is for ${certHost}, not ${host}. Enter the server name your provider gives for mail.`
    : `The server's security certificate is not for ${host}. Enter the server name your provider gives for mail.`;
}
