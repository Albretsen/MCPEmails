import { Resolver } from 'node:dns/promises';
import { hasSsoVerificationRecord } from '@/lib/sso/domains';

/**
 * The "check now" behind domain verification: look up the domain's TXT
 * records and say whether `mcpemails-verification=<token>` is among them.
 *
 * The resolver is a parameter so tests pass a stub and never touch DNS. In
 * production it is a fresh node:dns Resolver with a short timeout, so a slow
 * or dead name server answers "lookup_failed" in seconds rather than holding
 * the request open.
 *
 * Only the exact apex the admin added is checked. A record on a subdomain or
 * a parent does not prove this domain.
 */

export type TxtResolver = (domain: string) => Promise<string[][]>;

export type DnsVerificationResult =
  | { verified: true }
  | { verified: false; reason: 'record_missing' | 'no_txt_records' | 'lookup_failed' };

/** DNS error codes that mean "the name or its TXT records do not exist". */
const NOT_FOUND_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

export function defaultTxtResolver(): TxtResolver {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  return (domain) => resolver.resolveTxt(domain);
}

export async function checkDomainVerificationRecord(
  domain: string,
  token: string,
  resolveTxt: TxtResolver = defaultTxtResolver(),
): Promise<DnsVerificationResult> {
  let records: string[][];
  try {
    records = await resolveTxt(domain);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && NOT_FOUND_CODES.has(code)) {
      return { verified: false, reason: 'no_txt_records' };
    }
    return { verified: false, reason: 'lookup_failed' };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { verified: false, reason: 'no_txt_records' };
  }
  return hasSsoVerificationRecord(records, token)
    ? { verified: true }
    : { verified: false, reason: 'record_missing' };
}
