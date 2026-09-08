/**
 * Work out where a domain's mail actually lives, from the domain alone.
 *
 * ── Why the static table is not enough ──────────────────────────────────────
 *
 * `host-presets.ts` recognises a mailbox from the address domain or from a
 * mail hostname the user typed. That covers a consumer address (@gmx.net) and
 * a user who already knows their server (imap.ionos.com). It cannot cover the
 * case the generic IMAP form exists for: a custom domain whose mail is
 * delegated to a provider we know perfectly well. The owner's own address is
 * the example. hello@mcpemails.com is served by Migadu, the table has a Migadu
 * entry, and the table still returns nothing, because "mcpemails.com" appears
 * nowhere in it and never could.
 *
 * The domain itself is carrying the answer. Checked live on 2026-09-08:
 *
 *   dig SRV _imaps._tcp.mcpemails.com       -> 0 1 993 imap.migadu.com.
 *   dig SRV _submissions._tcp.mcpemails.com -> 0 1 465 smtp.migadu.com.
 *   dig MX  mcpemails.com                   -> 10 aspmx1.migadu.com.
 *                                              20 aspmx2.migadu.com.
 *   GET autoconfig.thunderbird.net/v1.1/mcpemails.com -> 404
 *
 * So three of the four sources below answer for that one domain, and the
 * fourth (Mozilla's ISPDB) does not, because the ISPDB only lists domains a
 * provider owns. That is the general shape: DNS knows about custom domains,
 * the ISPDB knows about provider domains, and the two barely overlap.
 *
 * ── Order of authority ──────────────────────────────────────────────────────
 *
 *  1. table  The static table. Instant, no network, and by construction the
 *            most specific thing we know about the providers that produced
 *            real connection failures.
 *  2. srv    RFC 6186 service records. The only source where the domain owner
 *            states the answer directly, host AND port, with no inference.
 *  3. mx     The MX host, matched back against the table. Says who receives
 *            the mail, from which the IMAP/SMTP settings follow whenever the
 *            receiver is a provider we have an entry for.
 *  4. ispdb  Mozilla's autoconfiguration database, one fixed host. Last
 *            because it is a third party and a network hop, and because it
 *            answers for the domains the table already covers.
 *
 * Each half of the answer (incoming, outgoing) is taken from the highest
 * source that produced one, so a domain that publishes only `_imaps._tcp` can
 * still be completed from its MX. Nothing is returned unless both halves
 * resolved: half a form filled in is worse than none, because the user cannot
 * tell which half we guessed at.
 *
 * ── This module runs server side and takes untrusted input ──────────────────
 *
 * The domain arrives from a browser, and every step here turns it into a
 * network request. Everything that decides WHERE a request goes is therefore
 * checked before it is made:
 *
 *  - the domain must be a syntactically valid PUBLIC DNS name (see
 *    `isPublicMailDomain`): no IP literal in any encoding, no single-label or
 *    reserved-suffix name, nothing that could name something inside our own
 *    network.
 *  - every host that comes BACK (an SRV target, an MX exchange, an ISPDB
 *    hostname) is put through the same check before it is offered to the user,
 *    because a domain owner controls those records and can point them at
 *    anything they like.
 *  - every port that comes back must be one of the standard mail ports, using
 *    the same allowlist the connect routes enforce.
 *  - the ISPDB is a FIXED origin. The domain is used only as a path segment,
 *    percent-encoded. No URL is ever built out of user input.
 *
 * The resolver and the fetcher are both injected, so the tests never touch the
 * network and the timeouts are visible at the call site rather than buried.
 */

import type { SmtpSecurity as MailSecurity } from './imap-presets.ts';
import {
  findMailHostPreset,
  findMailHostPresetByMx,
  prefillFromDomain,
  prefillFromPreset,
  type MailHostPrefill,
} from './host-presets.ts';
import { isAllowedMailPort, parseIpv6, parseLooseIpv4 } from '../email/host-guard.ts';

/** Which of the four sources produced the incoming-server half of an answer. */
export type AutodiscoverSource = 'table' | 'srv' | 'mx' | 'ispdb';

export interface AutodiscoveredSettings extends MailHostPrefill {
  /** Where the settings came from, so the form can say so. */
  source: AutodiscoverSource;
}

/** One half of an answer: a server for one protocol. */
export interface ServerCandidate {
  host: string;
  port: number;
  security: MailSecurity;
  source: AutodiscoverSource;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Name validation
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Suffixes that never name a mailbox on the public internet.
 *
 * `.local` and `.home.arpa` are the mDNS/home-network names, `.internal` is
 * what every cloud provider hands out inside a VPC, and `.test`/`.invalid`/
 * `.example` are RFC 2606 reserved. A resolver inside our function could
 * answer any of them with something we have no business connecting to, and a
 * user cannot have a real mailbox on one, so there is nothing to trade off.
 */
const RESERVED_SUFFIXES: readonly string[] = [
  '.local',
  '.localhost',
  '.localdomain',
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.home.arpa',
  '.lan',
  '.arpa',
  '.test',
  '.example',
  '.invalid',
  '.onion',
];

/** Lower-cased, trimmed, bracket-free, with the FQDN root dot removed. */
export function normalizeDomain(raw: unknown): string {
  let value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  while (value.endsWith('.') && value.length > 1) value = value.slice(0, -1);
  return value;
}

/**
 * True when `value` is a name we are willing to resolve, or to hand back to
 * the user as a mail host.
 *
 * Deliberately stricter than "does DNS accept it". An IP literal is rejected
 * in every encoding `getaddrinfo` would read (the loose parsers are imported
 * from host-guard rather than rewritten, because that is where the list of
 * bypasses was worked out and a second copy would drift), a single-label name
 * is rejected because it can only resolve through a local search domain, and
 * an all-numeric TLD is rejected because it means the string was meant as an
 * address and did not parse as one.
 *
 * This is not the SSRF control: `guardMailHost` is, and it still runs on the
 * connect route, resolving the name and checking every address it returns.
 * This is the cheaper check that stops us making the DNS query at all.
 */
export function isPublicMailDomain(value: string): boolean {
  const host = normalizeDomain(value);
  if (host.length === 0 || host.length > 253) return false;
  if (host.includes(':')) return false;
  if (parseIpv6(host) !== null) return false;
  if (parseLooseIpv4(host) !== null) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return !RESERVED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

/* ──────────────────────────────────────────────────────────────────────────
 * RFC 6186 service records
 * ────────────────────────────────────────────────────────────────────────── */

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

/**
 * The four service labels RFC 6186 defines, and what each one means about the
 * transport. `_imaps` and `_submissions` are implicit TLS; `_imap` and
 * `_submission` are the cleartext ports that must be upgraded with STARTTLS.
 *
 * The secure variant of each pair is listed first and wins, which is both what
 * the RFC tells clients to prefer and what this product will accept: the
 * connect routes only ever dial TLS or STARTTLS, never plaintext.
 */
export const SRV_SERVICES: readonly { label: string; protocol: 'imap' | 'smtp'; security: MailSecurity }[] = [
  { label: '_imaps._tcp', protocol: 'imap', security: 'tls' },
  { label: '_imap._tcp', protocol: 'imap', security: 'starttls' },
  { label: '_submissions._tcp', protocol: 'smtp', security: 'tls' },
  { label: '_submission._tcp', protocol: 'smtp', security: 'starttls' },
];

/**
 * Turn one service's RRSet into a server, or null.
 *
 * Two rules from RFC 6186 §3 that a naive reader of the records would miss:
 *
 *  - a single record whose target is "." means the service is explicitly NOT
 *    offered. It is not an empty answer to be ignored; it is a statement, and
 *    treating it as an absent record would make us fall back to the cleartext
 *    variant of a service the domain has just said it does not run.
 *  - records are ordered by priority ascending (lowest number wins), and
 *    weight is a tiebreak within one priority. There is only ever one server
 *    to prefill, so the load balancing the weight is for does not apply; the
 *    highest weight is taken as the most preferred host.
 *
 * The port must be one of the standard mail ports, and the target must be a
 * public name. A domain owner writes these records, so both are attacker
 * controlled in the case that matters.
 */
export function serverFromSrv(
  records: readonly SrvRecord[] | null | undefined,
  service: { protocol: 'imap' | 'smtp'; security: MailSecurity }
): ServerCandidate | null {
  if (!Array.isArray(records) || records.length === 0) return null;
  // "." as the only record: the service is not offered. Checked before the
  // sort so that a "." alongside real records (which is malformed, and which
  // no resolver should produce) is simply ignored rather than obeyed.
  if (records.length === 1 && normalizeDomain(records[0]?.name) === '') return null;
  const usable = records
    .filter((record) => {
      const host = normalizeDomain(record?.name);
      return host.length > 0 && isPublicMailDomain(host) && isAllowedMailPort(service.protocol, Number(record.port));
    })
    .sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
  const best = usable[0];
  if (!best) return null;
  return {
    host: normalizeDomain(best.name),
    port: Number(best.port),
    security: service.security,
    source: 'srv',
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * MX
 * ────────────────────────────────────────────────────────────────────────── */

export interface MxRecord {
  exchange: string;
  priority: number;
}

/**
 * The provider a domain's MX records point at, or null.
 *
 * Lowest priority number first, which is the primary receiver and the one that
 * names the provider; the backups are usually the same company anyway. Every
 * exchange is tried in order rather than only the first, because a domain can
 * list a spam-filtering relay at priority 10 and the real provider at 20, and
 * the relay will not be in our table while the provider is.
 */
export function presetFromMxRecords(records: readonly MxRecord[] | null | undefined): MailHostPrefill | null {
  if (!Array.isArray(records) || records.length === 0) return null;
  const ordered = records
    .map((record) => ({ exchange: normalizeDomain(record?.exchange), priority: Number(record?.priority ?? 0) }))
    .filter((record) => record.exchange.length > 0 && isPublicMailDomain(record.exchange))
    .sort((a, b) => a.priority - b.priority);
  for (const record of ordered) {
    const preset = findMailHostPresetByMx(record.exchange);
    if (preset) return prefillFromPreset(preset);
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Mozilla ISPDB
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The one external host this module will talk to. A constant, not a value
 * derived from anything the user typed: the domain only ever becomes a
 * percent-encoded path segment on the end of it.
 */
export const ISPDB_ORIGIN = 'https://autoconfig.thunderbird.net/v1.1/';

/** Cap on the ISPDB response we will read. Real entries are a few kilobytes. */
const ISPDB_MAX_BYTES = 64 * 1024;

function ispdbSocketType(raw: string | null): MailSecurity | null {
  const value = (raw ?? '').trim().toUpperCase();
  if (value === 'SSL') return 'tls';
  if (value === 'STARTTLS') return 'starttls';
  // "plain" and anything unrecognised: this product does not connect in
  // cleartext, so an entry that only offers it is no answer at all.
  return null;
}

function firstTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

/**
 * Pull the IMAP and SMTP servers out of a Thunderbird autoconfig document.
 *
 * Parsed with regular expressions rather than an XML parser on purpose: this
 * runs in a Vercel function, the document shape is fixed and tiny, and adding
 * an XML dependency to read four values from one third-party file is a worse
 * trade than the parser being unable to handle exotic XML. Anything it cannot
 * read produces null, which is the same outcome as the ISPDB not knowing the
 * domain.
 */
export function parseIspdb(xml: string): { imap: ServerCandidate | null; smtp: ServerCandidate | null; label: string | null } {
  const empty = { imap: null, smtp: null, label: null };
  if (typeof xml !== 'string' || xml.length === 0) return empty;

  const readServer = (
    blockPattern: RegExp,
    protocol: 'imap' | 'smtp'
  ): ServerCandidate | null => {
    const block = xml.match(blockPattern)?.[0];
    if (!block) return null;
    const host = normalizeDomain(firstTag(block, 'hostname'));
    const port = Number(firstTag(block, 'port'));
    const security = ispdbSocketType(firstTag(block, 'socketType'));
    if (!host || !isPublicMailDomain(host) || !security) return null;
    if (!isAllowedMailPort(protocol, port)) return null;
    return { host, port, security, source: 'ispdb' };
  };

  return {
    imap: readServer(/<incomingServer[^>]*type="imap"[^>]*>[\s\S]*?<\/incomingServer>/i, 'imap'),
    smtp: readServer(/<outgoingServer[^>]*type="smtp"[^>]*>[\s\S]*?<\/outgoingServer>/i, 'smtp'),
    label: firstTag(xml, 'displayName'),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * The orchestrator
 * ────────────────────────────────────────────────────────────────────────── */

export interface AutodiscoverDeps {
  /** `_imaps._tcp.example.com` style lookups. Resolves to [] when absent. */
  resolveSrv: (name: string) => Promise<SrvRecord[]>;
  resolveMx: (name: string) => Promise<MxRecord[]>;
  /** Fetches ONE fixed URL. Returns the body, or null for any non-answer. */
  fetchIspdb?: (url: string) => Promise<string | null>;
}

/** A resolver that fails is the same as a resolver that found nothing. */
async function quiet<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work;
  } catch {
    return fallback;
  }
}

/**
 * Resolve a domain to connect-form settings, or null.
 *
 * The label is whichever provider we can name for the resolved IMAP host: a
 * domain whose `_imaps._tcp` points at imap.migadu.com is Migadu, and saying
 * so is most of the value of the feature, because it is what tells the user
 * the settings on screen are not a guess. The app-password policy rides along
 * with it, which is how a Google Workspace domain discovered through its MX
 * gets told that its account password will never authenticate.
 */
export async function autodiscoverMailSettings(
  rawDomain: string,
  deps: AutodiscoverDeps
): Promise<AutodiscoveredSettings | null> {
  const domain = normalizeDomain(rawDomain);
  if (!isPublicMailDomain(domain)) return null;

  // 1. The table. No network, and it wins outright: an entry here was written
  //    against a recorded production failure, which is better evidence than a
  //    generic record.
  const fromTable = prefillFromDomain(domain);
  if (fromTable) return { ...fromTable, source: 'table' };

  // 2. SRV. All four labels at once: they are four independent queries either
  //    way, and running them in series would put four round trips in front of
  //    a form the user is waiting on.
  const srvAnswers = await Promise.all(
    SRV_SERVICES.map((service) => quiet(deps.resolveSrv(`${service.label}.${domain}`), [] as SrvRecord[]))
  );
  let imap: ServerCandidate | null = null;
  let smtp: ServerCandidate | null = null;
  for (let i = 0; i < SRV_SERVICES.length; i += 1) {
    const service = SRV_SERVICES[i];
    const found = serverFromSrv(srvAnswers[i], service);
    if (!found) continue;
    // First match per protocol wins, and SRV_SERVICES lists the implicit-TLS
    // variant of each pair first.
    if (service.protocol === 'imap' && !imap) imap = found;
    if (service.protocol === 'smtp' && !smtp) smtp = found;
  }

  // 3. MX, whenever SRV left either half unanswered. The preset it finds also
  //    carries the provider name and the app-password policy, both of which
  //    survive even when SRV supplied the hosts.
  let preset: MailHostPrefill | null = null;
  if (!imap || !smtp) {
    preset = presetFromMxRecords(await quiet(deps.resolveMx(domain), [] as MxRecord[]));
    if (preset) {
      if (!imap) imap = { host: preset.imapHost, port: preset.imapPort, security: preset.imapSecurity, source: 'mx' };
      if (!smtp) smtp = { host: preset.smtpHost, port: preset.smtpPort, security: preset.smtpSecurity, source: 'mx' };
    }
  }

  // 4. The ISPDB, only when DNS said nothing usable. It is a third party and a
  //    network hop, and it does not list custom domains, so it almost never
  //    answers a question the first three could not.
  let ispdbLabel: string | null = null;
  if ((!imap || !smtp) && deps.fetchIspdb) {
    const body = await quiet(deps.fetchIspdb(`${ISPDB_ORIGIN}${encodeURIComponent(domain)}`), null);
    if (body) {
      const parsed = parseIspdb(body.slice(0, ISPDB_MAX_BYTES));
      if (!imap && parsed.imap) imap = parsed.imap;
      if (!smtp && parsed.smtp) smtp = parsed.smtp;
      ispdbLabel = parsed.label;
    }
  }

  // Both halves or nothing. A form with an IMAP host and an empty SMTP host
  // looks like we know something we do not.
  if (!imap || !smtp) return null;

  // Name the provider from the host we resolved, which is exactly the lookup
  // the static table was already good at and the reason .migadu.com needs no
  // new entry to make hello@mcpemails.com work.
  const hostPreset = findMailHostPreset({ host: imap.host }) ?? null;
  const label = hostPreset?.label ?? preset?.label ?? ispdbLabel ?? null;

  return {
    provider: hostPreset?.id ?? 'autodiscovered',
    label: label ?? '',
    imapHost: imap.host,
    imapPort: imap.port,
    imapSecurity: imap.security,
    smtpHost: smtp.host,
    smtpPort: smtp.port,
    smtpSecurity: smtp.security,
    requiresAppPassword: hostPreset?.requiresAppPassword === true || preset?.requiresAppPassword === true,
    appPasswordHelpUrl: hostPreset?.appPasswordHelpUrl ?? preset?.appPasswordHelpUrl ?? null,
    source: imap.source,
  };
}
