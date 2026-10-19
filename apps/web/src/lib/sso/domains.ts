import { emailDomain, isConsumerEmailDomain } from '@/lib/segment/consumer-domains.mjs';

/**
 * Which email domains may belong to an SSO connection, and how one is proven.
 *
 * The database is the enforcer (CHECKs on public.sso_domains). This module
 * draws the same line in the app so a form can say why a domain was refused
 * before it reaches the database, and builds and checks the DNS TXT record
 * that proves ownership.
 *
 * Consumer mail services are refused because one company cannot own the
 * people on gmail.com. The list is the one the paywall already uses
 * (lib/segment/consumer-domains.mjs); migration-parity.test.ts keeps the SQL
 * copy in the migration identical to it.
 */

export type SsoDomainCheck =
  | { ok: true; domain: string }
  | { ok: false; reason: 'invalid' | 'consumer' };

/**
 * Normalise a domain (or an address on it) the way the database trigger does,
 * and say whether it may be added to an SSO connection.
 */
export function checkSsoDomain(input: unknown): SsoDomainCheck {
  const domain = emailDomain(input);
  if (domain === null) return { ok: false, reason: 'invalid' };
  if (isConsumerEmailDomain(domain)) return { ok: false, reason: 'consumer' };
  return { ok: true, domain };
}

/** Prefix of the TXT record value that proves a domain. */
export const SSO_VERIFICATION_TXT_PREFIX = 'mcpemails-verification=';

/** The exact TXT record value the customer publishes on the domain. */
export function ssoVerificationRecord(token: string): string {
  return `${SSO_VERIFICATION_TXT_PREFIX}${token}`;
}

/**
 * Whether the TXT records found on a domain include the one for this token.
 *
 * Takes what `dns.promises.resolveTxt` returns: one array of chunks per
 * record, where a long record is split into 255-byte strings that must be
 * joined. A plain array of strings is accepted too. The match is exact after
 * trimming: a record that merely contains the token does not count.
 */
export function hasSsoVerificationRecord(
  records: ReadonlyArray<string | ReadonlyArray<string>>,
  token: string,
): boolean {
  if (!/^[a-z0-9]{32}$/.test(token)) return false;
  const expected = ssoVerificationRecord(token);
  return records.some((record) => {
    const value = typeof record === 'string' ? record : record.join('');
    return value.trim() === expected;
  });
}
